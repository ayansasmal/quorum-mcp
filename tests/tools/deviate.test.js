/**
 * Unit tests for src/tools/deviate.js
 *
 * Covers:
 *  - not_linked when catalog_id not in project globals
 *  - not_found when catalog project not registered
 *  - not_found when topic:key doesn't exist in catalog
 *  - not_found when no ACTIVE version exists for topic:key
 *  - severity derived from confidence × authority_score
 *  - PA_AUTHORED_FLOOR applied when PA-authored entry has low confidence
 *  - recorded + is_new = true on first upsert
 *  - recorded + is_new = false on repeat upsert (last_seen_at update)
 *  - missing projectId throws
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/audit/pipeline.js', () => ({
  withAuditPipeline: vi.fn(async (_pg, _ctx, fn) => fn()),
}))

vi.mock('../../src/governance/provenance.js', () => ({
  buildAuditVersionImpact: vi.fn(() => ({ versions_created: [], versions_superseded: [] })),
}))

vi.mock('../../src/config/loader.js', () => ({
  getConfig: vi.fn(() => ({ globals: ['security-standards'] })),
}))

vi.mock('../../src/graph/queries.js', () => ({
  getProjectByGroupId: vi.fn(),
  getCurrentVersion:   vi.fn(),
  getKeyId:            vi.fn(),
  upsertDeviation:     vi.fn(),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

const testCtx = { projectId: 'payments-service', gatewayUrl: 'http://localhost:3001' }

function makePg() {
  return { query: vi.fn(() => { throw new Error('direct pg.query() should not be called') }) }
}

function makeInput(overrides = {}) {
  return {
    catalog_id:  'security-standards',
    topic:       'auth',
    key:         'tls-required',
    description: 'This service uses plain HTTP for internal calls',
    source:      'code-review',
    author:      'alice',
    ...overrides,
  }
}

beforeEach(async () => {
  vi.resetAllMocks()
  // Restore the default getConfig mock so catalog-link checks pass
  // unless a specific test overrides it.
  const { getConfig } = await import('../../src/config/loader.js')
  vi.mocked(getConfig).mockReturnValue({ globals: ['security-standards'] })
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('deviate — input validation', () => {
  it('throws when ctx.projectId is missing', async () => {
    const { handler } = await import('../../src/tools/deviate.js')
    await expect(handler(makePg(), makeInput(), undefined, {}))
      .rejects.toThrow('ctx.projectId is required')
  })
})

describe('deviate — catalog link validation', () => {
  it('returns not_linked when catalog_id is not in project globals', async () => {
    const { getConfig } = await import('../../src/config/loader.js')
    vi.mocked(getConfig).mockReturnValue({ globals: ['other-catalog'] })

    const { handler } = await import('../../src/tools/deviate.js')
    const result = await handler(makePg(), makeInput(), undefined, testCtx)

    expect(result.status).toBe('not_linked')
    expect(result.catalog_id).toBe('security-standards')
    expect(result.message).toMatch(/globals list/)
  })

  it('returns not_found when catalog project is not registered in Quorum', async () => {
    const { getProjectByGroupId } = await import('../../src/graph/queries.js')
    vi.mocked(getProjectByGroupId).mockResolvedValue(null)

    const { handler } = await import('../../src/tools/deviate.js')
    const result = await handler(makePg(), makeInput(), undefined, testCtx)

    expect(result.status).toBe('not_found')
    expect(result.message).toMatch(/not registered/)
  })

  it('returns not_found when topic:key does not exist in catalog', async () => {
    const { getProjectByGroupId, getKeyId } = await import('../../src/graph/queries.js')
    vi.mocked(getProjectByGroupId).mockResolvedValue('q_p_catalog')
    vi.mocked(getKeyId).mockResolvedValue(null)

    const { handler } = await import('../../src/tools/deviate.js')
    const result = await handler(makePg(), makeInput(), undefined, testCtx)

    expect(result.status).toBe('not_found')
    expect(result.message).toMatch(/does not exist/)
  })

  it('returns not_found when catalog entry has no ACTIVE version', async () => {
    const { getProjectByGroupId, getKeyId, getCurrentVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getProjectByGroupId).mockResolvedValue('q_p_catalog')
    vi.mocked(getKeyId).mockResolvedValue('q_k1')
    vi.mocked(getCurrentVersion).mockResolvedValue(null)

    const { handler } = await import('../../src/tools/deviate.js')
    const result = await handler(makePg(), makeInput(), undefined, testCtx)

    expect(result.status).toBe('not_found')
    expect(result.message).toMatch(/no ACTIVE version/)
  })
})

describe('deviate — severity derivation', () => {
  async function setupForSeverity(globalEntry) {
    const { getProjectByGroupId, getKeyId, getCurrentVersion, upsertDeviation } = await import('../../src/graph/queries.js')
    vi.mocked(getProjectByGroupId).mockImplementation((pg, id) =>
      id === 'security-standards' ? Promise.resolve('q_p_catalog') : Promise.resolve('q_p_project')
    )
    vi.mocked(getKeyId).mockResolvedValue('q_k1')
    vi.mocked(getCurrentVersion).mockResolvedValue(globalEntry)
    vi.mocked(upsertDeviation).mockResolvedValue({ deviation_id: 'dev-123', is_new: true })
  }

  it('computes severity = confidence × authority_score for architect role', async () => {
    await setupForSeverity({ confidence: 0.8, author_role: 'architect', entity_type: 'Pattern' })

    const { handler } = await import('../../src/tools/deviate.js')
    const result = await handler(makePg(), makeInput(), undefined, testCtx)

    // architect score = 0.80; severity = 0.8 × 0.80 = 0.640
    expect(result.status).toBe('recorded')
    expect(result.severity).toBeCloseTo(0.64, 2)
  })

  it('applies PA_AUTHORED_FLOOR (0.70) when PA entry has low confidence', async () => {
    await setupForSeverity({ confidence: 0.4, author_role: 'principal_architect', entity_type: 'Constraint' })

    const { handler } = await import('../../src/tools/deviate.js')
    const result = await handler(makePg(), makeInput(), undefined, testCtx)

    // 0.4 × 1.0 = 0.40 < floor 0.70 → should be 0.70
    expect(result.severity).toBe(0.70)
  })

  it('does NOT apply floor when PA entry has high confidence', async () => {
    await setupForSeverity({ confidence: 0.9, author_role: 'principal_architect', entity_type: 'Constraint' })

    const { handler } = await import('../../src/tools/deviate.js')
    const result = await handler(makePg(), makeInput(), undefined, testCtx)

    // 0.9 × 1.0 = 0.90 >= floor → no floor applied
    expect(result.severity).toBeCloseTo(0.9, 2)
  })

  it('defaults to engineer authority score when author_role is unknown', async () => {
    await setupForSeverity({ confidence: 0.6, author_role: 'unknown_role', entity_type: null })

    const { handler } = await import('../../src/tools/deviate.js')
    const result = await handler(makePg(), makeInput(), undefined, testCtx)

    // engineer score = 0.50; severity = 0.6 × 0.50 = 0.30
    expect(result.severity).toBeCloseTo(0.30, 2)
  })
})

describe('deviate — upsert behaviour', () => {
  beforeEach(async () => {
    const { getProjectByGroupId, getKeyId, getCurrentVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getProjectByGroupId).mockImplementation((pg, id) =>
      id === 'security-standards' ? Promise.resolve('q_p_catalog') : Promise.resolve('q_p_project')
    )
    vi.mocked(getKeyId).mockResolvedValue('q_k1')
    vi.mocked(getCurrentVersion).mockResolvedValue({
      confidence: 0.8, author_role: 'architect', entity_type: 'Pattern',
    })
  })

  it('returns recorded + is_new: true on first deviation', async () => {
    const { upsertDeviation } = await import('../../src/graph/queries.js')
    vi.mocked(upsertDeviation).mockResolvedValue({ deviation_id: 'dev-abc', is_new: true })

    const { handler } = await import('../../src/tools/deviate.js')
    const result = await handler(makePg(), makeInput(), undefined, testCtx)

    expect(result.status).toBe('recorded')
    expect(result.is_new).toBe(true)
    expect(result.deviation_id).toBe('dev-abc')
    expect(result.message).toMatch(/Deviation recorded/)
  })

  it('returns recorded + is_new: false on repeat scan (last_seen_at update)', async () => {
    const { upsertDeviation } = await import('../../src/graph/queries.js')
    vi.mocked(upsertDeviation).mockResolvedValue({ deviation_id: 'dev-abc', is_new: false })

    const { handler } = await import('../../src/tools/deviate.js')
    const result = await handler(makePg(), makeInput(), undefined, testCtx)

    expect(result.is_new).toBe(false)
    expect(result.message).toMatch(/last_seen_at refreshed/)
  })

  it('passes evidence through to upsertDeviation', async () => {
    const { upsertDeviation } = await import('../../src/graph/queries.js')
    vi.mocked(upsertDeviation).mockResolvedValue({ deviation_id: 'dev-abc', is_new: true })

    const { handler } = await import('../../src/tools/deviate.js')
    await handler(makePg(), makeInput({
      evidence: { files: ['src/api/client.js'], excerpt: 'http://' },
    }), undefined, testCtx)

    const callArg = vi.mocked(upsertDeviation).mock.calls[0][1]
    expect(callArg.evidence).toMatchObject({ files: ['src/api/client.js'] })
  })
})
