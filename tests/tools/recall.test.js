/**
 * Tool: recall()
 *
 * Tests the recall handler with mocked pg queries and audit pipeline.
 * Verifies:
 *   1. Default mode returns ACTIVE version as XML
 *   2. Not found returns null
 *   3. SUPERSEDED version shows warning in XML
 *   4. { history: true } mode returns full version chain
 *   5. { at: date } mode returns point-in-time version
 *   6. { version: N } mode returns specific version
 *   7. Freshness flag appears for recently updated knowledge
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/graph/queries.js', () => ({
  getCurrentVersion: vi.fn(),
  getVersionHistory: vi.fn(),
  getVersionAtDate: vi.fn(),
  getSpecificVersion: vi.fn(),
  insertVersion: vi.fn(),
  transitionVersionStatus: vi.fn(),
  insertVersionAuditLink: vi.fn(),
  getNextVersionNumber: vi.fn(),
  // GAP-21: fire-and-forget domain stat increment — must be present in mock
  incrementDomainStat: vi.fn().mockResolvedValue(),
}))

vi.mock('../../src/audit/pipeline.js', () => ({
  withAuditPipeline: vi.fn(async (_pg, _ctx, operation) => {
    const result = await operation()
    return result
  }),
}))

const testCtx = { projectId: 'test-project', gatewayUrl: 'http://localhost:3001' }

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeVersion(overrides = {}) {
  return {
    id: 1,
    topic: 'auth',
    key: 'token-strategy',
    version: 3,
    status: 'ACTIVE',
    content: 'Use JWT for Lambda, sessions for ECS',
    author: 'ayan',
    triggered_by: 'conflict_resolution',
    confidence: 0.9,
    created_at: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(), // 2 days ago
    created_by_audit: 'entry_001',
    supersedes_version: 2,
    supersedes_reason: 'ADR-042 nuanced after Lambda constraint discovered',
    superseded_by_version: null,
    superseded_by_author: null,
    superseded_at: null,
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('recall — default mode (ACTIVE)', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns null when no version found', async () => {
    const { getCurrentVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue(null)

    const { handler } = await import('../../src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'unknown-key' }, undefined, testCtx)
    expect(result).toBeNull()
  })

  it('returns XML string for found ACTIVE version', async () => {
    const { getCurrentVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue(makeVersion())

    const { handler } = await import('../../src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy' }, undefined, testCtx)

    expect(typeof result).toBe('string')
    expect(result).toContain('<quorum_memory')
    expect(result).toContain('</quorum_memory>')
    expect(result).toContain('topic="auth"')
    expect(result).toContain('key="token-strategy"')
  })

  it('XML includes version, status, author, triggered_by attributes', async () => {
    const { getCurrentVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue(makeVersion())

    const { handler } = await import('../../src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy' }, undefined, testCtx)

    expect(result).toContain('version="3"')
    expect(result).toContain('status="ACTIVE"')
    expect(result).toContain('author="ayan"')
    expect(result).toContain('triggered_by="conflict_resolution"')
  })

  it('includes knowledge content in XML body', async () => {
    const { getCurrentVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue(makeVersion())

    const { handler } = await import('../../src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy' }, undefined, testCtx)

    expect(result).toContain('Use JWT for Lambda, sessions for ECS')
  })

  it('adds freshness comment for version updated within 7 days', async () => {
    const { getCurrentVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue(
      makeVersion({ created_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString() }) // 1 day ago
    )

    const { handler } = await import('../../src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy' }, undefined, testCtx)

    expect(result).toContain('Updated')
    expect(result).toContain('day(s) ago')
  })

  it('does not add freshness comment for old knowledge', async () => {
    const { getCurrentVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue(
      makeVersion({ created_at: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString() }) // 30 days ago
    )

    const { handler } = await import('../../src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy' }, undefined, testCtx)

    expect(result).not.toContain('day(s) ago')
  })
})

describe('recall — SUPERSEDED version', () => {
  afterEach(() => vi.clearAllMocks())

  it('includes SUPERSEDED warning in XML for a superseded version', async () => {
    const { getSpecificVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getSpecificVersion).mockResolvedValue(
      makeVersion({
        version: 1,
        status: 'SUPERSEDED',
        content: 'Use session tokens for all services',
        author: 'junior-dev',
        superseded_by_version: 2,
        superseded_by_author: 'senior-architect',
        superseded_at: new Date().toISOString(),
      })
    )

    const { handler } = await import('../../src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy', version: 1 }, undefined, testCtx)

    expect(result).toContain('SUPERSEDED')
    expect(result).toContain('v2')
  })
})

describe('recall — history mode', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns null when no versions found', async () => {
    const { getVersionHistory } = await import('../../src/graph/queries.js')
    vi.mocked(getVersionHistory).mockResolvedValue([])

    const { handler } = await import('../../src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy', history: true }, undefined, testCtx)
    expect(result).toBeNull()
  })

  it('returns formatted history string with version list', async () => {
    const { getVersionHistory } = await import('../../src/graph/queries.js')
    vi.mocked(getVersionHistory).mockResolvedValue([
      makeVersion({ version: 3, status: 'ACTIVE' }),
      makeVersion({ version: 2, status: 'SUPERSEDED', author: 'senior-architect' }),
      makeVersion({ version: 1, status: 'SUPERSEDED', author: 'junior-dev' }),
    ])

    const { handler } = await import('../../src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy', history: true }, undefined, testCtx)

    expect(typeof result).toBe('string')
    expect(result).toContain('auth:token-strategy')
    expect(result).toContain('v3')
    expect(result).toContain('v2')
    expect(result).toContain('v1')
    expect(result).toContain('ACTIVE')
    expect(result).toContain('SUPERSEDED')
  })
})

describe('recall — point-in-time mode', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns null when no version was active at the given date', async () => {
    const { getVersionAtDate } = await import('../../src/graph/queries.js')
    vi.mocked(getVersionAtDate).mockResolvedValue(null)

    const { handler } = await import('../../src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy', at: '2023-01-01' }, undefined, testCtx)
    expect(result).toBeNull()
  })

  it('includes point-in-time comment in XML', async () => {
    const { getVersionAtDate } = await import('../../src/graph/queries.js')
    vi.mocked(getVersionAtDate).mockResolvedValue(
      makeVersion({ version: 1, status: 'ACTIVE', author: 'junior-dev' })
    )

    const { handler } = await import('../../src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy', at: '2024-01-15' }, undefined, testCtx)

    expect(result).toContain('2024-01-15')
    expect(result).toContain('Point-in-time')
  })
})

describe('recall — specific version mode', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns null when specific version does not exist', async () => {
    const { getSpecificVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getSpecificVersion).mockResolvedValue(null)

    const { handler } = await import('../../src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy', version: 99 }, undefined, testCtx)
    expect(result).toBeNull()
  })

  it('returns the specific version when it exists', async () => {
    const { getSpecificVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getSpecificVersion).mockResolvedValue(makeVersion({ version: 2 }))

    const { handler } = await import('../../src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy', version: 2 }, undefined, testCtx)

    expect(result).toContain('version="2"')
  })
})

// ── Regression: Bug D — summary column, not content ───────────────────────────
// The PostgreSQL knowledge_versions table stores knowledge in the `summary`
// column. The gateway returns raw PG rows, so version.content is always
// undefined in production. formatVersion must read summary (with content as a
// fallback for any future aliasing).

describe('recall — regression: version.summary used for XML body (Bug D)', () => {
  afterEach(() => vi.clearAllMocks())

  it('renders content from summary column (no content field)', async () => {
    const { getCurrentVersion } = await import('../../src/graph/queries.js')
    // Simulate the exact shape returned by the gateway: summary present, content absent
    vi.mocked(getCurrentVersion).mockResolvedValue({
      id: 1,
      topic: 'db',
      key: 'pool-size',
      version: 1,
      status: 'ACTIVE',
      summary: 'PostgreSQL pool size capped at 10 per instance',
      // content is intentionally absent — this is the production PG row shape
      author: 'ayan',
      triggered_by: 'human_decision',
      confidence: 0.9,
      created_at: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(),
      created_by_audit: 'entry_001',
      supersedes_version: null,
      superseded_by_version: null,
      superseded_by_author: null,
      superseded_at: null,
    })

    const { handler } = await import('../../src/tools/recall.js')
    const result = await handler({}, { topic: 'db', key: 'pool-size' }, undefined, testCtx)

    expect(result).toContain('PostgreSQL pool size capped at 10 per instance')
  })

  it('prefers summary over content when both are present', async () => {
    const { getCurrentVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue({
      ...makeVersion(),
      summary: 'Use JWT — from summary column',
      content: 'Use JWT — from content column (stale alias)',
    })

    const { handler } = await import('../../src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy' }, undefined, testCtx)

    expect(result).toContain('Use JWT — from summary column')
    expect(result).not.toContain('Use JWT — from content column (stale alias)')
  })

  it('falls back to content when summary is absent', async () => {
    const { getCurrentVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue({
      ...makeVersion(),
      summary: undefined,
      content: 'Fallback content value',
    })

    const { handler } = await import('../../src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy' }, undefined, testCtx)

    expect(result).toContain('Fallback content value')
  })

  it('renders empty body without error when both summary and content are absent', async () => {
    const { getCurrentVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue({
      ...makeVersion(),
      summary: undefined,
      content: undefined,
    })

    const { handler } = await import('../../src/tools/recall.js')
    const result = await handler({}, { topic: 'auth', key: 'token-strategy' }, undefined, testCtx)

    expect(result).toContain('<quorum_memory')
    expect(result).toContain('</quorum_memory>')
  })
})
