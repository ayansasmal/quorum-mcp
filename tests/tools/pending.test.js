/**
 * Tool: pending()
 *
 * Tests staleness detection in the pending handler.
 * Verifies:
 *   1. Stale warning is generated when active version has advanced since conflict creation
 *   2. No warning when active version matches version at creation time
 *   3. Empty queue returns a clean summary with zero counts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/graph/queries.js', () => ({
  getCurrentVersion:        vi.fn(),
  getPendingDecisions:      vi.fn(),
  getDraftVersions:         vi.fn(),
  markPendingDecisionStale: vi.fn(),
  // Other exports used elsewhere — satisfy the mock module contract
  getVersionHistory:        vi.fn(),
  getVersionAtDate:         vi.fn(),
  getSpecificVersion:       vi.fn(),
  insertVersion:            vi.fn(),
  transitionVersionStatus:  vi.fn(),
  insertVersionAuditLink:   vi.fn(),
  getNextVersionNumber:     vi.fn(),
}))

vi.mock('../../src/audit/pipeline.js', () => ({
  withAuditPipeline: vi.fn(async (_pg, _ctx, operation) => {
    const result = await operation()
    return result
  }),
}))

vi.mock('../../src/config/loader.js', () => ({
  getConfig: vi.fn(() => ({ domains: {} })),
}))

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import {
  getCurrentVersion,
  getPendingDecisions,
  getDraftVersions,
  markPendingDecisionStale,
} from '../../src/graph/queries.js'

import { handler } from '../../src/tools/pending.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** @type {import('pg').Pool} */
const pg = {}

/** Minimal identity object */
const identity = { name: 'reviewer', role: 'engineer' }

const testCtx = { projectId: 'test-project', gatewayUrl: 'http://localhost:3001' }

/**
 * Build a pending conflict row as returned by getPendingDecisions().
 * @param {object} [overrides]
 */
function makePendingRow(overrides = {}) {
  return {
    conflict_id:               'conflict_abc',
    conflict_topic:            'auth',
    conflict_key:              'token-strategy',
    active_version_at_creation: 1,
    stale_warning:             null,
    existing_content:          'Use session tokens',
    incoming_content:          'Use JWT',
    conflict_reason:           'Different auth approaches',
    more_pending_same_key:     0,
    enrichment:                null,
    created_at:                new Date().toISOString(),
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('pending() — staleness detection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getDraftVersions.mockResolvedValue([])
  })

  it('shows stale warning when active version has advanced since conflict creation', async () => {
    // Conflict was created when v1 was active; v3 is now active
    getPendingDecisions.mockResolvedValue([makePendingRow({ active_version_at_creation: 1 })])
    getCurrentVersion.mockResolvedValue({ version: 3 })
    markPendingDecisionStale.mockResolvedValue(undefined)

    const result = await handler(pg, {}, identity, testCtx)

    expect(result.conflict_briefs).toHaveLength(1)
    const brief = result.conflict_briefs[0]

    // Stale warning must be present and mention both versions
    expect(brief.stale_warning).toBeTruthy()
    expect(brief.stale_warning).toMatch(/v1/)
    expect(brief.stale_warning).toMatch(/v3/)

    // Current version is reflected in the brief
    expect(brief.current_active_version).toBe(3)
    expect(brief.active_version_at_creation).toBe(1)

    // Side-effect: stale state must be persisted to the DB
    expect(markPendingDecisionStale).toHaveBeenCalledWith(
      pg,
      'conflict_abc',
      expect.stringContaining('v3'),
      3,
      'test-project',
    )
  })

  it('shows no stale warning when active version matches version at creation time', async () => {
    // Conflict was created at v3 and v3 is still active — no staleness
    getPendingDecisions.mockResolvedValue([makePendingRow({ active_version_at_creation: 3 })])
    getCurrentVersion.mockResolvedValue({ version: 3 })

    const result = await handler(pg, {}, identity, testCtx)

    expect(result.conflict_briefs).toHaveLength(1)
    expect(result.conflict_briefs[0].stale_warning).toBeNull()

    // No side-effect: DB should not be updated
    expect(markPendingDecisionStale).not.toHaveBeenCalled()
  })

  it('returns a clean empty response when the queue has no pending decisions', async () => {
    getPendingDecisions.mockResolvedValue([])

    const result = await handler(pg, {}, identity, testCtx)

    expect(result.conflict_briefs).toHaveLength(0)
    expect(result.draft_reviews).toHaveLength(0)
    expect(result.summary).toMatchObject({
      total_pending: 0,
      conflicts:     0,
      drafts:        0,
    })
  })
})

describe('pending() — deprecation_requests section', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getPendingDecisions.mockResolvedValue([])
    getDraftVersions.mockResolvedValue([])
  })

  it('returns deprecation_requests populated from pending rows with decision_type=deprecation_request', async () => {
    getPendingDecisions.mockResolvedValue([
      {
        conflict_id:               'q_c12',
        decision_type:             'deprecation_request',
        conflict_topic:            'auth',
        conflict_key:              'token-strategy',
        conflict_reason:           'Replaced by new OAuth flow with PKCE',
        existing_content:          'Use JWT for Lambda',
        active_version_at_creation: 3,
        enrichment:                { requestor: 'junior-dev' },
        stale_warning:             null,
        created_at:                new Date().toISOString(),
      },
    ])
    getCurrentVersion.mockResolvedValue({ version: 3, status: 'ACTIVE' })

    const result = await handler(pg, {}, identity, testCtx)

    expect(result.deprecation_requests).toHaveLength(1)
    const req = result.deprecation_requests[0]
    expect(req.request_id).toBe('q_c12')
    expect(req.topic).toBe('auth')
    expect(req.key).toBe('token-strategy')
    expect(req.requestor).toBe('junior-dev')
    expect(req.reason).toBe('Replaced by new OAuth flow with PKCE')
    expect(req.current_content).toBe('Use JWT for Lambda')
    expect(req.current_version).toBe(3)
    expect(req.stale_warning).toBeNull()
  })

  it('conflict rows are not included in deprecation_requests and vice versa', async () => {
    getPendingDecisions.mockResolvedValue([
      makePendingRow({ decision_type: 'conflict' }),
      {
        conflict_id:               'q_c12',
        decision_type:             'deprecation_request',
        conflict_topic:            'auth',
        conflict_key:              'token-strategy',
        conflict_reason:           'Replaced by new OAuth flow with PKCE',
        existing_content:          'Use JWT',
        active_version_at_creation: 1,
        enrichment:                { requestor: 'junior-dev' },
        stale_warning:             null,
        created_at:                new Date().toISOString(),
      },
    ])
    getCurrentVersion.mockResolvedValue({ version: 1, status: 'ACTIVE' })

    const result = await handler(pg, {}, identity, testCtx)

    expect(result.conflict_briefs).toHaveLength(1)
    expect(result.deprecation_requests).toHaveLength(1)
    expect(result.conflict_briefs[0].conflict_id).toBe('conflict_abc')
    expect(result.deprecation_requests[0].request_id).toBe('q_c12')
  })

  it('sets stale_warning when ACTIVE version advanced since request was created', async () => {
    getPendingDecisions.mockResolvedValue([
      {
        conflict_id:               'q_c12',
        decision_type:             'deprecation_request',
        conflict_topic:            'auth',
        conflict_key:              'token-strategy',
        conflict_reason:           'Reason for deprecation with enough chars',
        existing_content:          'old content',
        active_version_at_creation: 1,
        enrichment:                { requestor: 'junior-dev' },
        stale_warning:             null,
        created_at:                new Date().toISOString(),
      },
    ])
    getCurrentVersion.mockResolvedValue({ version: 4, status: 'ACTIVE' })
    markPendingDecisionStale.mockResolvedValue(undefined)

    const result = await handler(pg, {}, identity, testCtx)

    expect(result.deprecation_requests[0].stale_warning).toBeTruthy()
    expect(result.deprecation_requests[0].stale_warning).toMatch(/v1/)
    expect(result.deprecation_requests[0].stale_warning).toMatch(/v4/)
    expect(markPendingDecisionStale).toHaveBeenCalledWith(
      pg, 'q_c12', expect.stringContaining('v4'), 4, 'test-project',
    )
  })

  it('summary includes deprecation_requests count', async () => {
    getPendingDecisions.mockResolvedValue([
      {
        conflict_id:               'q_c12',
        decision_type:             'deprecation_request',
        conflict_topic:            'auth',
        conflict_key:              'x',
        conflict_reason:           'reason',
        existing_content:          'content',
        active_version_at_creation: 1,
        enrichment:                { requestor: 'jr' },
        stale_warning:             null,
        created_at:                new Date().toISOString(),
      },
    ])
    getCurrentVersion.mockResolvedValue({ version: 1 })

    const result = await handler(pg, {}, identity, testCtx)

    expect(result.summary.deprecation_requests).toBe(1)
    expect(result.summary.total_pending).toBe(1)
  })

  it('empty queue returns deprecation_requests: [] and count 0 in summary', async () => {
    getPendingDecisions.mockResolvedValue([])
    const result = await handler(pg, {}, identity, testCtx)
    expect(result.deprecation_requests).toEqual([])
    expect(result.summary.deprecation_requests).toBe(0)
  })
})

describe('pending() — deviation alerts section', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    getPendingDecisions.mockResolvedValue([])
    getDraftVersions.mockResolvedValue([])
    // Re-install getConfig default after resetAllMocks
    const { getConfig } = require('../../src/config/loader.js')
    if (getConfig && getConfig.mockReturnValue) getConfig.mockReturnValue({ domains: {} })
  })

  it('returns empty deviation alerts when pg has no getDeviations method', async () => {
    // pg without getDeviations (e.g. raw pg.Pool stub or older gateway)
    const result = await handler({}, {}, identity, testCtx)

    expect(result.deviations).toEqual({ open: [], overdue_deferrals: [] })
    expect(result.summary.open_deviations).toBe(0)
    expect(result.summary.overdue_deferrals).toBe(0)
  })

  it('returns open deviations from gateway', async () => {
    const openDev = { deviation_id: 'dev-1', topic: 'auth', key: 'tls-required', severity: 0.64 }
    const pgWithDeviations = {
      getDeviations: vi.fn().mockImplementation((filters) => {
        if (filters.status === 'OPEN')    return Promise.resolve({ deviations: [openDev] })
        if (filters.status === 'OVERDUE') return Promise.resolve({ deviations: [] })
        return Promise.resolve({ deviations: [] })
      }),
    }

    const result = await handler(pgWithDeviations, {}, identity, testCtx)

    expect(result.deviations.open).toHaveLength(1)
    expect(result.deviations.open[0].deviation_id).toBe('dev-1')
    expect(result.deviations.overdue_deferrals).toHaveLength(0)
    expect(result.summary.open_deviations).toBe(1)
  })

  it('returns overdue deferrals from gateway', async () => {
    const overdueDev = { deviation_id: 'dev-2', topic: 'db', key: 'no-raw-sql', severity: 0.80 }
    const pgWithDeviations = {
      getDeviations: vi.fn().mockImplementation((filters) => {
        if (filters.status === 'OPEN')    return Promise.resolve({ deviations: [] })
        if (filters.status === 'OVERDUE') return Promise.resolve({ deviations: [overdueDev] })
        return Promise.resolve({ deviations: [] })
      }),
    }

    const result = await handler(pgWithDeviations, {}, identity, testCtx)

    expect(result.deviations.overdue_deferrals).toHaveLength(1)
    expect(result.deviations.overdue_deferrals[0].deviation_id).toBe('dev-2')
    expect(result.summary.overdue_deferrals).toBe(1)
  })

  it('gracefully returns empty when getDeviations throws', async () => {
    const pgWithError = { getDeviations: vi.fn().mockRejectedValue(new Error('network error')) }
    const result = await handler(pgWithError, {}, identity, testCtx)

    expect(result.deviations).toEqual({ open: [], overdue_deferrals: [] })
  })

  it('includes deviation counts in summary total_pending', async () => {
    const pgWithDeviations = {
      getDeviations: vi.fn().mockImplementation((filters) => {
        if (filters.status === 'OPEN')    return Promise.resolve({ deviations: [{ id: 'a' }, { id: 'b' }] })
        if (filters.status === 'OVERDUE') return Promise.resolve({ deviations: [{ id: 'c' }] })
        return Promise.resolve({ deviations: [] })
      }),
    }

    const result = await handler(pgWithDeviations, {}, identity, testCtx)

    expect(result.summary.total_pending).toBe(3)  // 2 open + 1 overdue
    expect(result.summary.open_deviations).toBe(2)
    expect(result.summary.overdue_deferrals).toBe(1)
  })
})
