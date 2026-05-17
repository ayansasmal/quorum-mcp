/**
 * Tests for src/tools/review.js
 *
 * review() handles approve, reject, request_changes on DRAFT knowledge.
 * Constitutional rules: no self-approval, reason required, team enforcement.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/audit/pipeline.js', () => ({
  withAuditPipeline: vi.fn(async (_pg, _ctx, operation) => {
    const result = await operation()
    return result
  }),
}))

vi.mock('../../src/governance/constitutional.js', () => ({
  enforceReasonRequired: vi.fn(),
  enforceNoSelfApproval: vi.fn(),
}))

vi.mock('../../src/governance/provenance.js', () => ({
  buildAuditVersionImpact: vi.fn(() => ({ versions_created: [], versions_superseded: [] })),
}))

vi.mock('../../src/graph/schema.js', () => ({
  KnowledgeStatus: { ACTIVE: 'ACTIVE', DRAFT: 'DRAFT', REJECTED: 'REJECTED' },
}))

vi.mock('../../src/graph/queries.js', () => ({
  getCurrentVersion: vi.fn(),
  getSpecificVersion: vi.fn(),
  transitionVersionStatus: vi.fn(),
  getLatestDraftVersion: vi.fn(),
  incrementDomainStat: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/config/loader.js', () => ({
  getConfig: vi.fn(),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

const testCtx = { projectId: 'test-project', gatewayUrl: 'http://localhost:3001' }

function makeDraftVersion(overrides = {}) {
  return {
    version: 1,
    version_id: 'q_k1_v1',
    q_key_id: 'q_k1',
    topic: 'auth',
    key: 'token-strategy',
    status: 'DRAFT',
    author: 'alice',
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

function makeIdentity(overrides = {}) {
  return {
    name: 'bob',
    team: 'platform',
    role: 'engineer',
    base_confidence: 0.7,
    method: 'github_token',
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('review — missing projectId', () => {
  afterEach(() => vi.clearAllMocks())

  it('throws when ctx.projectId is not set', async () => {
    const { handler } = await import('../../src/tools/review.js')
    await expect(
      handler({}, { action: 'approve', topic: 'auth', key: 'token', note: 'looks good' }, makeIdentity(), null)
    ).rejects.toThrow('ctx.projectId is required')
  })
})

describe('review — DRAFT not found', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns not_found when no DRAFT version exists', async () => {
    const { getCurrentVersion, getLatestDraftVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue(null)
    vi.mocked(getLatestDraftVersion).mockResolvedValue(null)
    const { getConfig } = await import('../../src/config/loader.js')
    vi.mocked(getConfig).mockReturnValue({ domains: {} })

    const { handler } = await import('../../src/tools/review.js')
    const result = await handler({}, {
      action: 'approve',
      topic: 'auth',
      key: 'missing-key',
      note: 'approving this',
    }, makeIdentity(), testCtx)

    expect(result.status).toBe('not_found')
  })
})

describe('review — non-DRAFT version', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns invalid_state when specific version requested is not DRAFT', async () => {
    // Use `version` param so getSpecificVersion is called and returns a non-DRAFT version
    const { getSpecificVersion, getCurrentVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getSpecificVersion).mockResolvedValue({ ...makeDraftVersion(), status: 'ACTIVE' })
    vi.mocked(getCurrentVersion).mockResolvedValue(null)
    const { getConfig } = await import('../../src/config/loader.js')
    vi.mocked(getConfig).mockReturnValue({ domains: {} })

    const { handler } = await import('../../src/tools/review.js')
    const result = await handler({}, {
      action: 'approve',
      topic: 'auth',
      key: 'token-strategy',
      note: 'approving',
      version: 1,
    }, makeIdentity(), testCtx)

    expect(result.status).toBe('invalid_state')
    expect(result.message).toContain('ACTIVE')
  })
})

describe('review — team enforcement', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns unauthorized when reviewer team is not in required_reviewer_teams', async () => {
    const { getCurrentVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue(makeDraftVersion({ author: 'charlie' }))
    const { getConfig } = await import('../../src/config/loader.js')
    vi.mocked(getConfig).mockReturnValue({
      domains: { auth: { required_reviewer_teams: ['security-team'] } },
    })

    const { handler } = await import('../../src/tools/review.js')
    const result = await handler({}, {
      action: 'approve',
      topic: 'auth',
      key: 'token-strategy',
      note: 'approving',
    }, makeIdentity({ team: 'platform' }), testCtx)

    expect(result.status).toBe('unauthorized')
    expect(result.message).toContain('security-team')
  })

  it('returns unauthorized when reviewer has no team and domain requires one', async () => {
    const { getCurrentVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue(makeDraftVersion({ author: 'charlie' }))
    const { getConfig } = await import('../../src/config/loader.js')
    vi.mocked(getConfig).mockReturnValue({
      domains: { auth: { required_reviewer_teams: ['security-team'] } },
    })

    const { handler } = await import('../../src/tools/review.js')
    const result = await handler({}, {
      action: 'approve',
      topic: 'auth',
      key: 'token-strategy',
      note: 'approving',
    }, makeIdentity({ team: null }), testCtx)

    expect(result.status).toBe('unauthorized')
    expect(result.message).toContain('anonymous identity')
  })
})

describe('review — approve', () => {
  afterEach(() => vi.clearAllMocks())

  it('transitions version to ACTIVE on approve', async () => {
    const draft = makeDraftVersion({ author: 'alice' })
    const { getCurrentVersion, transitionVersionStatus } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion)
      .mockResolvedValueOnce(draft)      // first call for targetVersion
      .mockResolvedValueOnce(null)       // second call for staleness check
    vi.mocked(transitionVersionStatus).mockResolvedValue(undefined)
    const { getConfig } = await import('../../src/config/loader.js')
    vi.mocked(getConfig).mockReturnValue({ domains: {} })

    const { handler } = await import('../../src/tools/review.js')
    const result = await handler({}, {
      action: 'approve',
      topic: 'auth',
      key: 'token-strategy',
      note: 'looks correct',
    }, makeIdentity({ name: 'bob' }), testCtx)

    expect(result.status).toBe('approved')
    expect(result.new_status).toBe('ACTIVE')
    expect(transitionVersionStatus).toHaveBeenCalledWith(
      expect.anything(), 'auth', 'token-strategy', 1, 'ACTIVE', null, 'test-project'
    )
  })

  it('includes reviewer and note in result', async () => {
    const draft = makeDraftVersion({ author: 'alice' })
    const { getCurrentVersion, transitionVersionStatus } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion)
      .mockResolvedValueOnce(draft)
      .mockResolvedValueOnce(null)
    vi.mocked(transitionVersionStatus).mockResolvedValue(undefined)
    const { getConfig } = await import('../../src/config/loader.js')
    vi.mocked(getConfig).mockReturnValue({ domains: {} })

    const { handler } = await import('../../src/tools/review.js')
    const result = await handler({}, {
      action: 'approve',
      topic: 'auth',
      key: 'token-strategy',
      note: 'LGTM',
    }, makeIdentity({ name: 'bob' }), testCtx)

    expect(result.reviewer).toBe('bob')
    expect(result.note).toBe('LGTM')
  })
})

describe('review — reject', () => {
  afterEach(() => vi.clearAllMocks())

  it('transitions version to REJECTED on reject', async () => {
    const draft = makeDraftVersion({ author: 'alice' })
    const { getCurrentVersion, transitionVersionStatus } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion)
      .mockResolvedValueOnce(draft)
      .mockResolvedValueOnce(null)
    vi.mocked(transitionVersionStatus).mockResolvedValue(undefined)
    const { getConfig } = await import('../../src/config/loader.js')
    vi.mocked(getConfig).mockReturnValue({ domains: {} })

    const { handler } = await import('../../src/tools/review.js')
    const result = await handler({}, {
      action: 'reject',
      topic: 'auth',
      key: 'token-strategy',
      note: 'does not follow our auth pattern',
    }, makeIdentity({ name: 'bob' }), testCtx)

    expect(result.status).toBe('rejected')
    expect(result.new_status).toBe('REJECTED')
  })
})

describe('review — request_changes', () => {
  afterEach(() => vi.clearAllMocks())

  it('keeps version as DRAFT and returns changes_requested', async () => {
    const draft = makeDraftVersion({ author: 'alice' })
    const { getCurrentVersion, transitionVersionStatus } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion)
      .mockResolvedValueOnce(draft)
      .mockResolvedValueOnce(null)
    vi.mocked(transitionVersionStatus).mockResolvedValue(undefined)
    const { getConfig } = await import('../../src/config/loader.js')
    vi.mocked(getConfig).mockReturnValue({ domains: {} })

    const { handler } = await import('../../src/tools/review.js')
    const result = await handler({}, {
      action: 'request_changes',
      topic: 'auth',
      key: 'token-strategy',
      note: 'please add rationale',
    }, makeIdentity({ name: 'bob' }), testCtx)

    expect(result.status).toBe('changes_requested')
    expect(transitionVersionStatus).not.toHaveBeenCalled()
  })
})

describe('review — staleness detection', () => {
  afterEach(() => vi.clearAllMocks())

  it('includes stale_warning when active version is newer than draft', async () => {
    const draft = makeDraftVersion({ version: 1, author: 'alice' })
    const activeV2 = { ...draft, version: 2, status: 'ACTIVE', created_at: new Date().toISOString() }

    const { getCurrentVersion, transitionVersionStatus } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion)
      .mockResolvedValueOnce(draft)      // targetVersion resolution
      .mockResolvedValueOnce(activeV2)   // staleness check
    vi.mocked(transitionVersionStatus).mockResolvedValue(undefined)
    const { getConfig } = await import('../../src/config/loader.js')
    vi.mocked(getConfig).mockReturnValue({ domains: {} })

    const { handler } = await import('../../src/tools/review.js')
    const result = await handler({}, {
      action: 'approve',
      topic: 'auth',
      key: 'token-strategy',
      note: 'approving',
    }, makeIdentity({ name: 'bob' }), testCtx)

    expect(result.stale_warning).toContain('v2')
  })
})

describe('review — specific version lookup', () => {
  afterEach(() => vi.clearAllMocks())

  it('looks up specific version when version param is provided', async () => {
    const draft = makeDraftVersion({ version: 2, author: 'alice' })
    const { getSpecificVersion, getCurrentVersion, transitionVersionStatus } = await import('../../src/graph/queries.js')
    vi.mocked(getSpecificVersion).mockResolvedValue(draft)
    vi.mocked(getCurrentVersion).mockResolvedValue(null) // staleness check
    vi.mocked(transitionVersionStatus).mockResolvedValue(undefined)
    const { getConfig } = await import('../../src/config/loader.js')
    vi.mocked(getConfig).mockReturnValue({ domains: {} })

    const { handler } = await import('../../src/tools/review.js')
    const result = await handler({}, {
      action: 'approve',
      topic: 'auth',
      key: 'token-strategy',
      note: 'approving v2',
      version: 2,
    }, makeIdentity({ name: 'bob' }), testCtx)

    expect(getSpecificVersion).toHaveBeenCalledWith(
      expect.anything(), 'auth', 'token-strategy', 2, 'test-project'
    )
    expect(result.status).toBe('approved')
  })
})

describe('review — config load failure (permissive fallback)', () => {
  afterEach(() => vi.clearAllMocks())

  it('permits review when config cannot be loaded (no team enforcement)', async () => {
    const draft = makeDraftVersion({ author: 'alice' })
    const { getCurrentVersion, transitionVersionStatus } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion)
      .mockResolvedValueOnce(draft)
      .mockResolvedValueOnce(null)
    vi.mocked(transitionVersionStatus).mockResolvedValue(undefined)
    const { getConfig } = await import('../../src/config/loader.js')
    vi.mocked(getConfig).mockImplementation(() => { throw new Error('config not loaded') })

    const { handler } = await import('../../src/tools/review.js')
    const result = await handler({}, {
      action: 'approve',
      topic: 'auth',
      key: 'token-strategy',
      note: 'approving',
    }, makeIdentity({ name: 'bob' }), testCtx)

    // Should not return unauthorized — config failure is permissive
    expect(result.status).toBe('approved')
  })
})
