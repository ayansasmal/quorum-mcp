/**
 * Unit tests for src/tools/conformance.js
 *
 * conformance() is a thin proxy — all scoring logic lives in the gateway's
 * GET /api/conformance route. These tests verify that:
 *  - missing projectId throws before the pipeline runs
 *  - UNCERTIFIED responses generate the correct contextual messages
 *    (no scans, no catalogs, sparse coverage)
 *  - CERTIFIED responses are passed through with score + breakdown + catalogs
 *  - include_details: true fetches top_deviations, sorted by severity desc
 *  - include_details: false omits top_deviations key entirely
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

const UNCERTIFIED_BASE = {
  score: null, status: 'UNCERTIFIED', applicable_entries: 0,
  scan_count: 0, last_scan_at: null,
  breakdown: { open: 0, accepted: 0, denied: 0, deferred: 0, overdue: 0, resolved: 0 },
  catalogs: [],
}

const CERTIFIED_BASE = {
  score: 82, status: 'CERTIFIED', applicable_entries: 15,
  scan_count: 3, last_scan_at: '2026-05-01T10:00:00Z',
  breakdown: { open: 1, accepted: 2, denied: 0, deferred: 1, overdue: 0, resolved: 3 },
  catalogs: [
    { catalog_id: 'security-standards', entry_count: 10 },
    { catalog_id: 'payments-compliance', entry_count: 5 },
  ],
}

/**
 * Build a pg proxy whose getConformance resolves to the given response.
 * Optionally configure getDeviations for include_details tests.
 * @param {Record<string, unknown>} conformanceResponse
 * @param {Record<string, unknown>} [deviationsResponse]
 */
function makePg(conformanceResponse, deviationsResponse = { deviations: [] }) {
  return {
    query:          vi.fn(() => { throw new Error('direct pg.query() should not be called') }),
    getConformance: vi.fn().mockResolvedValue(conformanceResponse),
    getDeviations:  vi.fn().mockResolvedValue(deviationsResponse),
  }
}

beforeEach(() => vi.resetAllMocks())

// ── Input validation ───────────────────────────────────────────────────────────

describe('conformance — input validation', () => {
  it('throws when ctx.projectId is missing', async () => {
    const { handler } = await import('../../src/tools/conformance.js')
    await expect(handler(makePg(UNCERTIFIED_BASE), { include_details: false }, undefined, {}))
      .rejects.toThrow('ctx.projectId is required')
  })

  it('throws when ctx is null', async () => {
    const { handler } = await import('../../src/tools/conformance.js')
    await expect(handler(makePg(UNCERTIFIED_BASE), { include_details: false }, undefined, null))
      .rejects.toThrow('ctx.projectId is required')
  })
})

// ── UNCERTIFIED message variants ───────────────────────────────────────────────

describe('conformance — UNCERTIFIED messages', () => {
  it('returns no-scan message when scan_count is 0', async () => {
    const pg = makePg({ ...UNCERTIFIED_BASE, scan_count: 0, catalogs: [] })
    const { handler } = await import('../../src/tools/conformance.js')
    const result = await handler(pg, { include_details: false }, undefined, testCtx)

    expect(result.status).toBe('UNCERTIFIED')
    expect(result.score).toBeNull()
    expect(result.message).toMatch(/No scans have been run yet/)
    expect(result.message).toMatch(/quorum:scan/)
  })

  it('returns no-catalogs message when scan_count > 0 but catalogs is empty', async () => {
    const pg = makePg({ ...UNCERTIFIED_BASE, scan_count: 2, catalogs: [] })
    const { handler } = await import('../../src/tools/conformance.js')
    const result = await handler(pg, { include_details: false }, undefined, testCtx)

    expect(result.status).toBe('UNCERTIFIED')
    expect(result.message).toMatch(/no linked global catalogs/i)
    expect(result.message).toMatch(/quorum:onboard/)
  })

  it('returns sparse-coverage message when applicable_entries < 10 with catalogs present', async () => {
    const pg = makePg({
      ...UNCERTIFIED_BASE,
      scan_count:         1,
      applicable_entries: 7,
      catalogs:           [{ catalog_id: 'security-standards', entry_count: 7 }],
    })
    const { handler } = await import('../../src/tools/conformance.js')
    const result = await handler(pg, { include_details: false }, undefined, testCtx)

    expect(result.status).toBe('UNCERTIFIED')
    expect(result.message).toMatch(/7 ACTIVE entries/)
    expect(result.message).toMatch(/minimum 10 required/)
  })

  it('does NOT call getDeviations when UNCERTIFIED even if include_details is true', async () => {
    const pg = makePg({ ...UNCERTIFIED_BASE, scan_count: 0, catalogs: [] })
    const { handler } = await import('../../src/tools/conformance.js')
    await handler(pg, { include_details: true }, undefined, testCtx)

    expect(pg.getDeviations).not.toHaveBeenCalled()
  })
})

// ── CERTIFIED pass-through ─────────────────────────────────────────────────────

describe('conformance — CERTIFIED response', () => {
  it('returns score, status, breakdown, catalogs unchanged', async () => {
    const pg = makePg({ ...CERTIFIED_BASE })
    const { handler } = await import('../../src/tools/conformance.js')
    const result = await handler(pg, { include_details: false }, undefined, testCtx)

    expect(result.score).toBe(82)
    expect(result.status).toBe('CERTIFIED')
    expect(result.breakdown.open).toBe(1)
    expect(result.catalogs).toHaveLength(2)
    expect(result.catalogs[0].catalog_id).toBe('security-standards')
    expect(result.catalogs[0].entry_count).toBe(10)
  })

  it('does NOT include top_deviations when include_details is false', async () => {
    const pg = makePg({ ...CERTIFIED_BASE })
    const { handler } = await import('../../src/tools/conformance.js')
    const result = await handler(pg, { include_details: false }, undefined, testCtx)

    expect(result).not.toHaveProperty('top_deviations')
    expect(pg.getDeviations).not.toHaveBeenCalled()
  })

  it('includes sorted top_deviations when include_details is true', async () => {
    const pg = makePg({ ...CERTIFIED_BASE }, {
      deviations: [
        { deviation_id: 'dev-1', topic: 'auth', key: 'tls-required', severity: 0.40 },
        { deviation_id: 'dev-2', topic: 'auth', key: 'jwt-expiry', severity: 0.90 },
        { deviation_id: 'dev-3', topic: 'data', key: 'encryption-at-rest', severity: 0.70 },
      ],
    })
    const { handler } = await import('../../src/tools/conformance.js')
    const result = await handler(pg, { include_details: true }, undefined, testCtx)

    expect(result.top_deviations).toHaveLength(3)
    // sorted by severity descending
    expect(result.top_deviations[0].deviation_id).toBe('dev-2')
    expect(result.top_deviations[1].deviation_id).toBe('dev-3')
    expect(result.top_deviations[2].deviation_id).toBe('dev-1')
  })

  it('caps top_deviations at 10 even when more returned', async () => {
    const deviations = Array.from({ length: 15 }, (_, i) => ({
      deviation_id: `dev-${i}`, topic: 'auth', key: `key-${i}`, severity: 0.5,
    }))
    const pg = makePg({ ...CERTIFIED_BASE }, { deviations })
    const { handler } = await import('../../src/tools/conformance.js')
    const result = await handler(pg, { include_details: true }, undefined, testCtx)

    expect(result.top_deviations).toHaveLength(10)
  })

  it('calls getDeviations with status OPEN and limit 10', async () => {
    const pg = makePg({ ...CERTIFIED_BASE })
    const { handler } = await import('../../src/tools/conformance.js')
    await handler(pg, { include_details: true }, undefined, testCtx)

    expect(pg.getDeviations).toHaveBeenCalledWith({ status: 'OPEN', limit: 10 })
  })

  it('handles empty deviations list gracefully', async () => {
    const pg = makePg({ ...CERTIFIED_BASE }, { deviations: [] })
    const { handler } = await import('../../src/tools/conformance.js')
    const result = await handler(pg, { include_details: true }, undefined, testCtx)

    expect(result.top_deviations).toEqual([])
  })

  it('handles undefined deviations field in gateway response', async () => {
    const pg = makePg({ ...CERTIFIED_BASE }, {})
    const { handler } = await import('../../src/tools/conformance.js')
    const result = await handler(pg, { include_details: true }, undefined, testCtx)

    expect(result.top_deviations).toEqual([])
  })
})

// ── Audit pipeline context ─────────────────────────────────────────────────────

describe('conformance — audit pipeline', () => {
  it('uses identity.name as author when provided', async () => {
    const { withAuditPipeline } = await import('../../src/audit/pipeline.js')
    const pg = makePg({ ...CERTIFIED_BASE })
    const identity = { name: 'alice', role: 'architect' }

    const { handler } = await import('../../src/tools/conformance.js')
    await handler(pg, { include_details: false }, identity, testCtx)

    expect(withAuditPipeline).toHaveBeenCalledWith(
      pg,
      expect.objectContaining({ author: 'alice', tool: 'conformance' }),
      expect.any(Function),
    )
  })

  it('uses "anonymous" as author when identity is undefined', async () => {
    const { withAuditPipeline } = await import('../../src/audit/pipeline.js')
    const pg = makePg({ ...CERTIFIED_BASE })

    const { handler } = await import('../../src/tools/conformance.js')
    await handler(pg, { include_details: false }, undefined, testCtx)

    expect(withAuditPipeline).toHaveBeenCalledWith(
      pg,
      expect.objectContaining({ author: 'anonymous' }),
      expect.any(Function),
    )
  })
})
