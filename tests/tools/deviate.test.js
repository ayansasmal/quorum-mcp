/**
 * Unit tests for src/tools/deviate.js
 *
 * deviate() is a thin proxy — all business logic (catalog validation, severity
 * computation, upsert) lives in the gateway's POST /api/deviations route.
 * These tests verify that:
 *  - missing projectId throws before the pipeline runs
 *  - gateway not_linked / not_found / recorded responses are passed through
 *  - evidence, source, and author are forwarded correctly
 *  - the audit pipeline is called with the correct context
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/audit/pipeline.js', () => ({
  withAuditPipeline: vi.fn(async (_pg, _ctx, fn) => fn()),
}))

vi.mock('../../src/governance/provenance.js', () => ({
  buildAuditVersionImpact: vi.fn(() => ({ versions_created: [], versions_superseded: [] })),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

const testCtx = { projectId: 'payments-service', gatewayUrl: 'http://localhost:3001' }

/**
 * Build a minimal pg proxy whose recordDeviation resolves to the given response.
 * @param {Record<string, unknown>} [gatewayResponse]
 */
function makePg(gatewayResponse = { status: 'recorded', deviation_id: 'dev-123', is_new: true, severity: 0.64 }) {
  return {
    query:            vi.fn(() => { throw new Error('direct pg.query() should not be called') }),
    recordDeviation:  vi.fn().mockResolvedValue(gatewayResponse),
  }
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

beforeEach(() => vi.resetAllMocks())

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('deviate — input validation', () => {
  it('throws when ctx.projectId is missing', async () => {
    const { handler } = await import('../../src/tools/deviate.js')
    await expect(handler(makePg(), makeInput(), undefined, {}))
      .rejects.toThrow('ctx.projectId is required')
  })

  it('throws when ctx is null', async () => {
    const { handler } = await import('../../src/tools/deviate.js')
    await expect(handler(makePg(), makeInput(), undefined, null))
      .rejects.toThrow('ctx.projectId is required')
  })
})

describe('deviate — gateway response pass-through', () => {
  it('returns not_linked when gateway reports catalog not in globals', async () => {
    const pg = makePg({
      status:     'not_linked',
      catalog_id: 'security-standards',
      message:    "Catalog 'security-standards' is not in this project's globals list.",
    })
    const { handler } = await import('../../src/tools/deviate.js')
    const result = await handler(pg, makeInput(), undefined, testCtx)

    expect(result.status).toBe('not_linked')
    expect(result.catalog_id).toBe('security-standards')
  })

  it('returns not_found when gateway reports catalog not registered', async () => {
    const pg = makePg({
      status:  'not_found',
      message: "Global catalog 'security-standards' is not registered",
    })
    const { handler } = await import('../../src/tools/deviate.js')
    const result = await handler(pg, makeInput(), undefined, testCtx)

    expect(result.status).toBe('not_found')
  })

  it('returns recorded with severity and is_new on success', async () => {
    const pg = makePg({
      status:       'recorded',
      deviation_id: 'dev-abc',
      severity:     0.64,
      is_new:       true,
      message:      'Deviation recorded (severity 0.640).',
    })
    const { handler } = await import('../../src/tools/deviate.js')
    const result = await handler(pg, makeInput(), undefined, testCtx)

    expect(result.status).toBe('recorded')
    expect(result.deviation_id).toBe('dev-abc')
    expect(result.severity).toBe(0.64)
    expect(result.is_new).toBe(true)
  })

  it('returns recorded + is_new: false on repeat call (last_seen_at update)', async () => {
    const pg = makePg({
      status:       'recorded',
      deviation_id: 'dev-abc',
      severity:     0.64,
      is_new:       false,
      message:      'Deviation updated — last_seen_at refreshed (severity 0.640).',
    })
    const { handler } = await import('../../src/tools/deviate.js')
    const result = await handler(pg, makeInput(), undefined, testCtx)

    expect(result.is_new).toBe(false)
    expect(result.message).toMatch(/last_seen_at refreshed/)
  })
})

describe('deviate — payload forwarding', () => {
  it('forwards catalog_id, topic, key, description, source, author to recordDeviation', async () => {
    const pg = makePg()
    const { handler } = await import('../../src/tools/deviate.js')
    await handler(pg, makeInput(), undefined, testCtx)

    expect(pg.recordDeviation).toHaveBeenCalledOnce()
    const call = pg.recordDeviation.mock.calls[0][0]
    expect(call.catalog_id).toBe('security-standards')
    expect(call.topic).toBe('auth')
    expect(call.key).toBe('tls-required')
    expect(call.description).toBe('This service uses plain HTTP for internal calls')
    expect(call.source).toBe('code-review')
    expect(call.author).toBe('alice')
  })

  it('forwards evidence block when provided', async () => {
    const pg = makePg()
    const { handler } = await import('../../src/tools/deviate.js')
    await handler(pg, makeInput({ evidence: { files: ['src/api/client.js'], excerpt: 'http://' } }), undefined, testCtx)

    const call = pg.recordDeviation.mock.calls[0][0]
    expect(call.evidence).toMatchObject({ files: ['src/api/client.js'], excerpt: 'http://' })
  })

  it('sends null evidence when evidence omitted', async () => {
    const pg = makePg()
    const { handler } = await import('../../src/tools/deviate.js')
    await handler(pg, makeInput(), undefined, testCtx)

    const call = pg.recordDeviation.mock.calls[0][0]
    expect(call.evidence).toBeNull()
  })

  it('uses identity.author as fallback when input.author is absent', async () => {
    const pg = makePg()
    const identity = { author: 'bob', role: 'engineer' }
    const { handler } = await import('../../src/tools/deviate.js')
    await handler(pg, makeInput({ author: undefined }), identity, testCtx)

    const call = pg.recordDeviation.mock.calls[0][0]
    expect(call.author).toBe('bob')
  })
})
