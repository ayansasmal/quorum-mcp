/**
 * Tests for src/graph/queries.js
 *
 * queries.js has two interaction modes:
 *   1. GatewayClient duck-type: when pg.METHOD is a function, delegate to it
 *   2. Raw SQL: when pg.METHOD is not a function, run pg.query()
 *
 * We test both modes to maximise coverage.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

// KnowledgeStatus is needed for some functions but queries.js only imports it
// transitively — import directly for assertions.
vi.mock('../../src/graph/schema.js', () => ({
  KnowledgeStatus: {
    ACTIVE: 'ACTIVE',
    DRAFT: 'DRAFT',
    SUPERSEDED: 'SUPERSEDED',
    DEPRECATED: 'DEPRECATED',
    REJECTED: 'REJECTED',
  },
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal mock pg pool that delegates all known methods
 * so the duck-type guard `typeof pg.METHOD === 'function'` can be tested.
 */
function makeGatewayClientMock(overrides = {}) {
  return {
    createProject: vi.fn(),
    getProjectByGroupId: vi.fn(),
    getOrCreateKey: vi.fn(),
    getCurrentVersion: vi.fn(),
    getVersionAtDate: vi.fn(),
    getVersionHistory: vi.fn(),
    getSpecificVersion: vi.fn(),
    getNextVersionNumber: vi.fn(),
    insertVersion: vi.fn(),
    getVersionsByTag: vi.fn(),
    transitionVersionStatus: vi.fn(),
    insertVersionAuditLink: vi.fn(),
    getLatestDraftVersion: vi.fn(),
    getVersionsByStatus: vi.fn(),
    getVersionStatusCounts: vi.fn(),
    getDraftVersions: vi.fn(),
    getPendingDecisions: vi.fn(),
    countPendingForKey: vi.fn(),
    getPendingDecisionById: vi.fn(),
    insertPendingDecision: vi.fn(),
    updatePendingDecision: vi.fn(),
    updateConfidence: vi.fn(),
    updateLastAccessed: vi.fn(),
    getDecayEligibleVersions: vi.fn(),
    getVersionForBump: vi.fn(),
    recordBump: vi.fn(),
    getBumpLog: vi.fn(),
    incrementDomainStat: vi.fn(),
    getDomainStats: vi.fn(),
    ...overrides,
  }
}

/**
 * Build a minimal raw pg pool (no gateway methods — uses SQL path).
 */
function makeRawPool(queryMock) {
  return { query: queryMock }
}

// ── createProject ─────────────────────────────────────────────────────────────

describe('createProject', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.createProject when available', async () => {
    const gw = makeGatewayClientMock()
    gw.createProject.mockResolvedValue('q_p1')
    const { createProject } = await import('../../src/graph/queries.js')
    const result = await createProject(gw, 'my-project', 'alice', [], {}, {})
    expect(gw.createProject).toHaveBeenCalledWith('my-project', 'alice', [], {}, {})
    expect(result).toBe('q_p1')
  })

  it('uses raw SQL when pg.createProject is not a function', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ n: 5 }] })           // nextval seq
      .mockResolvedValueOnce({ rows: [{ q_project_id: 'q_p5' }] }) // INSERT RETURNING
    const pg = makeRawPool(query)
    const { createProject } = await import('../../src/graph/queries.js')
    const result = await createProject(pg, 'my-project', 'alice', [], {}, { displayName: 'My Project' })
    expect(query).toHaveBeenCalledTimes(2)
    expect(result).toBe('q_p5')
  })
})

// ── getProjectByGroupId ───────────────────────────────────────────────────────

describe('getProjectByGroupId', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.getProjectByGroupId when available', async () => {
    const gw = makeGatewayClientMock()
    gw.getProjectByGroupId.mockResolvedValue('q_p3')
    const { getProjectByGroupId } = await import('../../src/graph/queries.js')
    const result = await getProjectByGroupId(gw, 'my-group')
    expect(gw.getProjectByGroupId).toHaveBeenCalledWith('my-group')
    expect(result).toBe('q_p3')
  })

  it('returns q_project_id from raw SQL', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ q_project_id: 'q_p2' }] })
    const pg = makeRawPool(query)
    const { getProjectByGroupId } = await import('../../src/graph/queries.js')
    const result = await getProjectByGroupId(pg, 'my-group')
    expect(result).toBe('q_p2')
  })

  it('returns null when not found (raw SQL)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const pg = makeRawPool(query)
    const { getProjectByGroupId } = await import('../../src/graph/queries.js')
    const result = await getProjectByGroupId(pg, 'nonexistent')
    expect(result).toBeNull()
  })
})

// ── getOrCreateKey ────────────────────────────────────────────────────────────

describe('getOrCreateKey', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.getOrCreateKey when available', async () => {
    const gw = makeGatewayClientMock()
    gw.getOrCreateKey.mockResolvedValue('q_k10')
    const { getOrCreateKey } = await import('../../src/graph/queries.js')
    const result = await getOrCreateKey(gw, 'q_p1', 'auth', 'token-strategy')
    expect(gw.getOrCreateKey).toHaveBeenCalledWith('q_p1', 'auth', 'token-strategy')
    expect(result).toBe('q_k10')
  })

  it('uses raw SQL upsert when pg.getOrCreateKey is not a function', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ n: 10 }] })
      .mockResolvedValueOnce({ rows: [{ q_key_id: 'q_k10' }] })
    const pg = makeRawPool(query)
    const { getOrCreateKey } = await import('../../src/graph/queries.js')
    const result = await getOrCreateKey(pg, 'q_p1', 'auth', 'token-strategy')
    expect(result).toBe('q_k10')
  })
})

// ── getCurrentVersion (gateway delegation only) ───────────────────────────────

describe('getCurrentVersion', () => {
  afterEach(() => vi.clearAllMocks())

  it('always delegates to pg.getCurrentVersion', async () => {
    const gw = makeGatewayClientMock()
    gw.getCurrentVersion.mockResolvedValue({ version: 1, status: 'ACTIVE' })
    const { getCurrentVersion } = await import('../../src/graph/queries.js')
    const result = await getCurrentVersion(gw, 'auth', 'token-strategy')
    expect(gw.getCurrentVersion).toHaveBeenCalledWith('auth', 'token-strategy')
    expect(result).toEqual({ version: 1, status: 'ACTIVE' })
  })

  it('returns null when not found', async () => {
    const gw = makeGatewayClientMock()
    gw.getCurrentVersion.mockResolvedValue(null)
    const { getCurrentVersion } = await import('../../src/graph/queries.js')
    const result = await getCurrentVersion(gw, 'auth', 'missing-key')
    expect(result).toBeNull()
  })
})

// ── getVersionAtDate ──────────────────────────────────────────────────────────

describe('getVersionAtDate', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.getVersionAtDate', async () => {
    const gw = makeGatewayClientMock()
    gw.getVersionAtDate.mockResolvedValue({ version: 1 })
    const { getVersionAtDate } = await import('../../src/graph/queries.js')
    const result = await getVersionAtDate(gw, 'auth', 'token', '2024-01-01')
    expect(gw.getVersionAtDate).toHaveBeenCalledWith('auth', 'token', '2024-01-01')
    expect(result).toEqual({ version: 1 })
  })
})

// ── getVersionHistory ─────────────────────────────────────────────────────────

describe('getVersionHistory', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.getVersionHistory', async () => {
    const gw = makeGatewayClientMock()
    gw.getVersionHistory.mockResolvedValue([{ version: 1 }, { version: 2 }])
    const { getVersionHistory } = await import('../../src/graph/queries.js')
    const result = await getVersionHistory(gw, 'auth', 'token')
    expect(result).toHaveLength(2)
  })
})

// ── getSpecificVersion ────────────────────────────────────────────────────────

describe('getSpecificVersion', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.getSpecificVersion', async () => {
    const gw = makeGatewayClientMock()
    gw.getSpecificVersion.mockResolvedValue({ version: 3 })
    const { getSpecificVersion } = await import('../../src/graph/queries.js')
    const result = await getSpecificVersion(gw, 'auth', 'token', 3)
    expect(gw.getSpecificVersion).toHaveBeenCalledWith('auth', 'token', 3)
    expect(result).toEqual({ version: 3 })
  })
})

// ── getNextVersionNumber ──────────────────────────────────────────────────────

describe('getNextVersionNumber', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.getNextVersionNumber', async () => {
    const gw = makeGatewayClientMock()
    gw.getNextVersionNumber.mockResolvedValue(4)
    const { getNextVersionNumber } = await import('../../src/graph/queries.js')
    const result = await getNextVersionNumber(gw, 'auth', 'token')
    expect(result).toBe(4)
  })
})

// ── insertVersion ─────────────────────────────────────────────────────────────

describe('insertVersion', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.insertVersion when available', async () => {
    const gw = makeGatewayClientMock()
    const record = { version_id: 'q_k1_v1', q_key_id: 'q_k1', q_project_id: 'q_p1', version: 1, topic: 'auth', key: 'token', author: 'alice', triggered_by: 'engineer_decision', status: 'ACTIVE' }
    gw.insertVersion.mockResolvedValue(record)
    const { insertVersion } = await import('../../src/graph/queries.js')
    const result = await insertVersion(gw, record)
    expect(gw.insertVersion).toHaveBeenCalledWith(record)
    expect(result).toEqual(record)
  })

  it('throws when version_id missing (raw SQL path)', async () => {
    const query = vi.fn()
    const pg = makeRawPool(query)
    const { insertVersion } = await import('../../src/graph/queries.js')
    await expect(insertVersion(pg, { q_key_id: 'q_k1', q_project_id: 'q_p1' }))
      .rejects.toThrow('version_id is required')
  })

  it('throws when q_key_id missing (raw SQL path)', async () => {
    const query = vi.fn()
    const pg = makeRawPool(query)
    const { insertVersion } = await import('../../src/graph/queries.js')
    await expect(insertVersion(pg, { version_id: 'q_k1_v1', q_project_id: 'q_p1' }))
      .rejects.toThrow('q_key_id is required')
  })

  it('throws when q_project_id missing (raw SQL path)', async () => {
    const query = vi.fn()
    const pg = makeRawPool(query)
    const { insertVersion } = await import('../../src/graph/queries.js')
    await expect(insertVersion(pg, { version_id: 'q_k1_v1', q_key_id: 'q_k1' }))
      .rejects.toThrow('q_project_id is required')
  })

  it('inserts via raw SQL and returns row', async () => {
    const row = { version_id: 'q_k1_v1', q_key_id: 'q_k1', q_project_id: 'q_p1' }
    const query = vi.fn().mockResolvedValue({ rows: [row] })
    const pg = makeRawPool(query)
    const { insertVersion } = await import('../../src/graph/queries.js')
    const result = await insertVersion(pg, {
      version_id: 'q_k1_v1',
      q_key_id: 'q_k1',
      q_project_id: 'q_p1',
      version: 1,
      topic: 'auth',
      key: 'token',
      author: 'alice',
      triggered_by: 'engineer_decision',
      status: 'ACTIVE',
    })
    expect(query).toHaveBeenCalledOnce()
    expect(result).toEqual(row)
  })

  it('handles forward_link as object by JSON.stringify', async () => {
    const row = { version_id: 'q_k1_v1' }
    const query = vi.fn().mockResolvedValue({ rows: [row] })
    const pg = makeRawPool(query)
    const { insertVersion } = await import('../../src/graph/queries.js')
    await insertVersion(pg, {
      version_id: 'q_k1_v1',
      q_key_id: 'q_k1',
      q_project_id: 'q_p1',
      version: 1,
      topic: 'auth',
      key: 'token',
      author: 'alice',
      triggered_by: 'engineer_decision',
      status: 'ACTIVE',
      forward_link: { version: 2, author: 'bob' },
    })
    const callArgs = query.mock.calls[0][1]
    // forward_link is param index 19 (0-based)
    expect(typeof callArgs[19]).toBe('string')
  })
})

// ── getVersionsByTag ──────────────────────────────────────────────────────────

describe('getVersionsByTag', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.getVersionsByTag when available', async () => {
    const gw = makeGatewayClientMock()
    gw.getVersionsByTag.mockResolvedValue([{ version: 1 }])
    const { getVersionsByTag } = await import('../../src/graph/queries.js')
    const result = await getVersionsByTag(gw, 'auth', 'q_p1')
    expect(gw.getVersionsByTag).toHaveBeenCalledWith('auth', 'q_p1')
    expect(result).toHaveLength(1)
  })

  it('normalises tag to lowercase and queries SQL', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ version: 1 }] })
    const pg = makeRawPool(query)
    const { getVersionsByTag } = await import('../../src/graph/queries.js')
    const result = await getVersionsByTag(pg, 'AUTH', 'q_p1')
    expect(query).toHaveBeenCalledOnce()
    const params = query.mock.calls[0][1]
    expect(params[1]).toBe('auth') // normalised
    expect(result).toHaveLength(1)
  })
})

// ── transitionVersionStatus ───────────────────────────────────────────────────

describe('transitionVersionStatus', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.transitionVersionStatus', async () => {
    const gw = makeGatewayClientMock()
    gw.transitionVersionStatus.mockResolvedValue({ version: 1, status: 'SUPERSEDED' })
    const { transitionVersionStatus } = await import('../../src/graph/queries.js')
    const result = await transitionVersionStatus(gw, 'auth', 'token', 1, 'SUPERSEDED', null)
    expect(gw.transitionVersionStatus).toHaveBeenCalledWith('auth', 'token', 1, 'SUPERSEDED', null)
    expect(result).toEqual({ version: 1, status: 'SUPERSEDED' })
  })
})

// ── insertVersionAuditLink ────────────────────────────────────────────────────

describe('insertVersionAuditLink', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.insertVersionAuditLink when available', async () => {
    const gw = makeGatewayClientMock()
    gw.insertVersionAuditLink.mockResolvedValue(undefined)
    const { insertVersionAuditLink } = await import('../../src/graph/queries.js')
    await insertVersionAuditLink(gw, { auditEntryId: 'a1', versionId: 'q_k1_v1', qKeyId: 'q_k1', linkType: 'created' })
    expect(gw.insertVersionAuditLink).toHaveBeenCalledOnce()
  })

  it('runs INSERT via raw SQL when no delegation method', async () => {
    const query = vi.fn().mockResolvedValue({})
    const pg = makeRawPool(query)
    const { insertVersionAuditLink } = await import('../../src/graph/queries.js')
    await insertVersionAuditLink(pg, { auditEntryId: 'a1', versionId: 'q_k1_v1', qKeyId: 'q_k1', linkType: 'created' })
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0][0]).toContain('version_audit_links')
  })
})

// ── getLatestDraftVersion ─────────────────────────────────────────────────────

describe('getLatestDraftVersion', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.getLatestDraftVersion', async () => {
    const gw = makeGatewayClientMock()
    gw.getLatestDraftVersion.mockResolvedValue({ version: 1, status: 'DRAFT' })
    const { getLatestDraftVersion } = await import('../../src/graph/queries.js')
    const result = await getLatestDraftVersion(gw, 'auth', 'token')
    expect(gw.getLatestDraftVersion).toHaveBeenCalledWith('auth', 'token')
    expect(result).toEqual({ version: 1, status: 'DRAFT' })
  })
})

// ── getVersionsByStatus ───────────────────────────────────────────────────────

describe('getVersionsByStatus', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.getVersionsByStatus when available', async () => {
    const gw = makeGatewayClientMock()
    gw.getVersionsByStatus.mockResolvedValue([{ version: 1 }])
    const { getVersionsByStatus } = await import('../../src/graph/queries.js')
    const result = await getVersionsByStatus(gw, 'ACTIVE', 'q_p1')
    expect(gw.getVersionsByStatus).toHaveBeenCalledWith('ACTIVE', 'q_p1', undefined)
    expect(result).toHaveLength(1)
  })

  it('runs topic-filtered SQL when topic provided (raw pool)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ version: 1 }] })
    const pg = makeRawPool(query)
    const { getVersionsByStatus } = await import('../../src/graph/queries.js')
    const result = await getVersionsByStatus(pg, 'ACTIVE', 'q_p1', 'auth')
    expect(query).toHaveBeenCalledOnce()
    const sql = query.mock.calls[0][0]
    expect(sql).toContain('topic')
    expect(result).toHaveLength(1)
  })

  it('runs unfiltered SQL when no topic (raw pool)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const pg = makeRawPool(query)
    const { getVersionsByStatus } = await import('../../src/graph/queries.js')
    const result = await getVersionsByStatus(pg, 'DRAFT', 'q_p1')
    expect(query).toHaveBeenCalledOnce()
    expect(result).toEqual([])
  })
})

// ── getVersionStatusCounts ────────────────────────────────────────────────────

describe('getVersionStatusCounts', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.getVersionStatusCounts when available', async () => {
    const gw = makeGatewayClientMock()
    gw.getVersionStatusCounts.mockResolvedValue({ ACTIVE: 5, DRAFT: 2 })
    const { getVersionStatusCounts } = await import('../../src/graph/queries.js')
    const result = await getVersionStatusCounts(gw, 'q_p1')
    expect(result).toEqual({ ACTIVE: 5, DRAFT: 2 })
  })

  it('runs topic-filtered SQL (raw pool)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ status: 'ACTIVE', count: 3 }] })
    const pg = makeRawPool(query)
    const { getVersionStatusCounts } = await import('../../src/graph/queries.js')
    const result = await getVersionStatusCounts(pg, 'q_p1', 'auth')
    expect(result).toEqual({ ACTIVE: 3 })
  })

  it('runs unfiltered SQL (raw pool)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ status: 'ACTIVE', count: 10 }, { status: 'DRAFT', count: 2 }] })
    const pg = makeRawPool(query)
    const { getVersionStatusCounts } = await import('../../src/graph/queries.js')
    const result = await getVersionStatusCounts(pg, 'q_p1')
    expect(result).toEqual({ ACTIVE: 10, DRAFT: 2 })
  })
})

// ── getDraftVersions ──────────────────────────────────────────────────────────

describe('getDraftVersions', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.getDraftVersions when available', async () => {
    const gw = makeGatewayClientMock()
    gw.getDraftVersions.mockResolvedValue([{ status: 'DRAFT' }])
    const { getDraftVersions } = await import('../../src/graph/queries.js')
    const result = await getDraftVersions(gw, { qProjectId: 'q_p1' })
    expect(gw.getDraftVersions).toHaveBeenCalledWith({ qProjectId: 'q_p1', topic: undefined })
    expect(result).toHaveLength(1)
  })

  it('runs topic-filtered SQL (raw pool)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ status: 'DRAFT' }] })
    const pg = makeRawPool(query)
    const { getDraftVersions } = await import('../../src/graph/queries.js')
    const result = await getDraftVersions(pg, { qProjectId: 'q_p1', topic: 'auth' })
    expect(query.mock.calls[0][0]).toContain('topic')
    expect(result).toHaveLength(1)
  })

  it('runs unfiltered SQL (raw pool)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const pg = makeRawPool(query)
    const { getDraftVersions } = await import('../../src/graph/queries.js')
    const result = await getDraftVersions(pg, { qProjectId: 'q_p1' })
    expect(result).toEqual([])
  })
})

// ── getPendingDecisions ───────────────────────────────────────────────────────

describe('getPendingDecisions', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.getPendingDecisions when available', async () => {
    const gw = makeGatewayClientMock()
    gw.getPendingDecisions.mockResolvedValue([{ conflict_id: 'q_c1' }])
    const { getPendingDecisions } = await import('../../src/graph/queries.js')
    const result = await getPendingDecisions(gw, { qProjectId: 'q_p1' })
    expect(result).toHaveLength(1)
  })

  it('runs qKeyId-filtered SQL (raw pool)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ conflict_id: 'q_c1' }] })
    const pg = makeRawPool(query)
    const { getPendingDecisions } = await import('../../src/graph/queries.js')
    const result = await getPendingDecisions(pg, { qProjectId: 'q_p1', qKeyId: 'q_k1', statuses: ['pending'], decisionType: 'conflict' })
    expect(query.mock.calls[0][0]).toContain('q_key_id')
    expect(result).toHaveLength(1)
  })

  it('runs unfiltered SQL (raw pool)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const pg = makeRawPool(query)
    const { getPendingDecisions } = await import('../../src/graph/queries.js')
    const result = await getPendingDecisions(pg, { qProjectId: 'q_p1' })
    expect(result).toEqual([])
  })
})

// ── countPendingForKey ────────────────────────────────────────────────────────

describe('countPendingForKey', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.countPendingForKey', async () => {
    const gw = makeGatewayClientMock()
    gw.countPendingForKey.mockResolvedValue(3)
    const { countPendingForKey } = await import('../../src/graph/queries.js')
    const result = await countPendingForKey(gw, 'auth', 'token')
    expect(result).toBe(3)
  })
})

// ── getPendingDecisionById ────────────────────────────────────────────────────

describe('getPendingDecisionById', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.getPendingDecisionById when available', async () => {
    const gw = makeGatewayClientMock()
    gw.getPendingDecisionById.mockResolvedValue({ conflict_id: 'q_c5' })
    const { getPendingDecisionById } = await import('../../src/graph/queries.js')
    const result = await getPendingDecisionById(gw, 'q_c5')
    expect(result).toEqual({ conflict_id: 'q_c5' })
  })

  it('returns null when not found (raw pool)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const pg = makeRawPool(query)
    const { getPendingDecisionById } = await import('../../src/graph/queries.js')
    const result = await getPendingDecisionById(pg, 'q_c99')
    expect(result).toBeNull()
  })

  it('returns the row when found (raw pool)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ conflict_id: 'q_c5' }] })
    const pg = makeRawPool(query)
    const { getPendingDecisionById } = await import('../../src/graph/queries.js')
    const result = await getPendingDecisionById(pg, 'q_c5')
    expect(result).toEqual({ conflict_id: 'q_c5' })
  })
})

// ── insertPendingDecision ─────────────────────────────────────────────────────

describe('insertPendingDecision', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.insertPendingDecision when available', async () => {
    const gw = makeGatewayClientMock()
    gw.insertPendingDecision.mockResolvedValue('q_c7')
    const { insertPendingDecision } = await import('../../src/graph/queries.js')
    const result = await insertPendingDecision(gw, { q_key_id: 'q_k1', q_project_id: 'q_p1' })
    expect(result).toBe('q_c7')
  })

  it('throws when q_key_id missing', async () => {
    const query = vi.fn()
    const pg = makeRawPool(query)
    const { insertPendingDecision } = await import('../../src/graph/queries.js')
    await expect(insertPendingDecision(pg, { q_project_id: 'q_p1' }))
      .rejects.toThrow('q_key_id is required')
  })

  it('throws when q_project_id missing', async () => {
    const query = vi.fn()
    const pg = makeRawPool(query)
    const { insertPendingDecision } = await import('../../src/graph/queries.js')
    await expect(insertPendingDecision(pg, { q_key_id: 'q_k1' }))
      .rejects.toThrow('q_project_id is required')
  })

  it('generates a conflict_id from sequence and inserts (raw pool)', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ n: 7 }] })
      .mockResolvedValueOnce({})
    const pg = makeRawPool(query)
    const { insertPendingDecision } = await import('../../src/graph/queries.js')
    const result = await insertPendingDecision(pg, { q_key_id: 'q_k1', q_project_id: 'q_p1' })
    expect(result).toBe('q_c7')
  })

  it('uses provided conflict_id when given (raw pool)', async () => {
    const query = vi.fn().mockResolvedValue({})
    const pg = makeRawPool(query)
    const { insertPendingDecision } = await import('../../src/graph/queries.js')
    const result = await insertPendingDecision(pg, { q_key_id: 'q_k1', q_project_id: 'q_p1', conflict_id: 'q_c99' })
    expect(result).toBe('q_c99')
    // Should not call nextval sequence
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('stringifies enrichment object (raw pool)', async () => {
    const query = vi.fn().mockResolvedValue({})
    const pg = makeRawPool(query)
    const { insertPendingDecision } = await import('../../src/graph/queries.js')
    await insertPendingDecision(pg, {
      q_key_id: 'q_k1',
      q_project_id: 'q_p1',
      conflict_id: 'q_c1',
      enrichment: { analysis: 'conflict analysis here' },
    })
    const params = query.mock.calls[0][1]
    expect(typeof params[9]).toBe('string') // enrichment stringified
  })
})

// ── resolvePendingDecision ────────────────────────────────────────────────────

describe('resolvePendingDecision', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.updatePendingDecision when available', async () => {
    const gw = makeGatewayClientMock()
    gw.updatePendingDecision.mockResolvedValue(undefined)
    const { resolvePendingDecision } = await import('../../src/graph/queries.js')
    await resolvePendingDecision(gw, 'q_c1', { status: 'resolved', resolution: 'supersede', note: 'ok', resolvedBy: 'alice' })
    expect(gw.updatePendingDecision).toHaveBeenCalledWith('q_c1', { status: 'resolved', resolution: 'supersede', note: 'ok', resolvedBy: 'alice' })
  })

  it('runs UPDATE SQL (raw pool)', async () => {
    const query = vi.fn().mockResolvedValue({})
    const pg = makeRawPool(query)
    const { resolvePendingDecision } = await import('../../src/graph/queries.js')
    await resolvePendingDecision(pg, 'q_c1', { status: 'resolved', resolution: 'supersede', note: 'ok', resolvedBy: 'alice' })
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0][0]).toContain('UPDATE pending_decisions')
  })
})

// ── markPendingDecisionStale ──────────────────────────────────────────────────

describe('markPendingDecisionStale', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.updatePendingDecision when available', async () => {
    const gw = makeGatewayClientMock()
    gw.updatePendingDecision.mockResolvedValue(undefined)
    const { markPendingDecisionStale } = await import('../../src/graph/queries.js')
    await markPendingDecisionStale(gw, 'q_c1', 'stale warning', 3)
    expect(gw.updatePendingDecision).toHaveBeenCalledWith('q_c1', {
      status: 'stale',
      stale_warning: 'stale warning',
      current_active_version: 3,
    })
  })

  it('runs UPDATE SQL (raw pool)', async () => {
    const query = vi.fn().mockResolvedValue({})
    const pg = makeRawPool(query)
    const { markPendingDecisionStale } = await import('../../src/graph/queries.js')
    await markPendingDecisionStale(pg, 'q_c1', 'stale warning', 3)
    expect(query.mock.calls[0][0]).toContain('stale_warning')
  })
})

// ── updateConfidence ──────────────────────────────────────────────────────────

describe('updateConfidence', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.updateConfidence when available', async () => {
    const gw = makeGatewayClientMock()
    gw.updateConfidence.mockResolvedValue(undefined)
    const { updateConfidence } = await import('../../src/graph/queries.js')
    await updateConfidence(gw, 'q_k1_v1', 0.85)
    expect(gw.updateConfidence).toHaveBeenCalledWith('q_k1_v1', 0.85)
  })

  it('runs UPDATE SQL (raw pool)', async () => {
    const query = vi.fn().mockResolvedValue({})
    const pg = makeRawPool(query)
    const { updateConfidence } = await import('../../src/graph/queries.js')
    await updateConfidence(pg, 'q_k1_v1', 0.85)
    expect(query.mock.calls[0][0]).toContain('confidence')
  })
})

// ── updateLastAccessed ────────────────────────────────────────────────────────

describe('updateLastAccessed', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.updateLastAccessed when available', async () => {
    const gw = makeGatewayClientMock()
    gw.updateLastAccessed.mockResolvedValue(undefined)
    const { updateLastAccessed } = await import('../../src/graph/queries.js')
    await updateLastAccessed(gw, 'q_k1')
    expect(gw.updateLastAccessed).toHaveBeenCalledWith('q_k1')
  })

  it('runs UPDATE SQL (raw pool)', async () => {
    const query = vi.fn().mockResolvedValue({})
    const pg = makeRawPool(query)
    const { updateLastAccessed } = await import('../../src/graph/queries.js')
    await updateLastAccessed(pg, 'q_k1')
    expect(query.mock.calls[0][0]).toContain('last_accessed_at')
  })
})

// ── getDecayEligibleVersions ──────────────────────────────────────────────────

describe('getDecayEligibleVersions', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.getDecayEligibleVersions when available', async () => {
    const gw = makeGatewayClientMock()
    gw.getDecayEligibleVersions.mockResolvedValue([{ version_id: 'q_k1_v1' }])
    const { getDecayEligibleVersions } = await import('../../src/graph/queries.js')
    const result = await getDecayEligibleVersions(gw, 'q_p1', 100)
    expect(gw.getDecayEligibleVersions).toHaveBeenCalledWith('q_p1', 100)
    expect(result).toHaveLength(1)
  })

  it('uses batchSize default of 200 (raw pool)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const pg = makeRawPool(query)
    const { getDecayEligibleVersions } = await import('../../src/graph/queries.js')
    await getDecayEligibleVersions(pg, 'q_p1')
    const params = query.mock.calls[0][1]
    expect(params[1]).toBe(200)
  })
})

// ── getVersionForBump ─────────────────────────────────────────────────────────

describe('getVersionForBump', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.getVersionForBump when available', async () => {
    const gw = makeGatewayClientMock()
    gw.getVersionForBump.mockResolvedValue({ version: 1, status: 'ACTIVE' })
    const { getVersionForBump } = await import('../../src/graph/queries.js')
    const result = await getVersionForBump(gw, 'q_k1')
    expect(result).toEqual({ version: 1, status: 'ACTIVE' })
  })

  it('returns null when not found (raw pool)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const pg = makeRawPool(query)
    const { getVersionForBump } = await import('../../src/graph/queries.js')
    const result = await getVersionForBump(pg, 'q_k1')
    expect(result).toBeNull()
  })

  it('returns row when found (raw pool)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ version: 1 }] })
    const pg = makeRawPool(query)
    const { getVersionForBump } = await import('../../src/graph/queries.js')
    const result = await getVersionForBump(pg, 'q_k1')
    expect(result).toEqual({ version: 1 })
  })
})

// ── recordBump ────────────────────────────────────────────────────────────────

describe('recordBump', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.recordBump when available', async () => {
    const gw = makeGatewayClientMock()
    gw.recordBump.mockResolvedValue(undefined)
    const { recordBump } = await import('../../src/graph/queries.js')
    await recordBump(gw, { qKeyId: 'q_k1', author: 'alice', role: 'engineer', delta: 0.05 })
    expect(gw.recordBump).toHaveBeenCalledWith({ qKeyId: 'q_k1', author: 'alice', role: 'engineer', delta: 0.05 })
  })

  it('runs INSERT SQL (raw pool)', async () => {
    const query = vi.fn().mockResolvedValue({})
    const pg = makeRawPool(query)
    const { recordBump } = await import('../../src/graph/queries.js')
    await recordBump(pg, { qKeyId: 'q_k1', author: 'alice', role: 'engineer', delta: 0.05 })
    expect(query.mock.calls[0][0]).toContain('bump_log')
  })
})

// ── getBumpLog ────────────────────────────────────────────────────────────────

describe('getBumpLog', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.getBumpLog when available', async () => {
    const gw = makeGatewayClientMock()
    gw.getBumpLog.mockResolvedValue([{ delta_applied: 0.05 }])
    const { getBumpLog } = await import('../../src/graph/queries.js')
    const result = await getBumpLog(gw, { qKeyId: 'q_k1', author: 'alice' })
    expect(result).toHaveLength(1)
  })

  it('uses limit default of 1 (raw pool)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const pg = makeRawPool(query)
    const { getBumpLog } = await import('../../src/graph/queries.js')
    await getBumpLog(pg, { qKeyId: 'q_k1', author: 'alice' })
    const params = query.mock.calls[0][1]
    expect(params[2]).toBe(1)
  })

  it('returns rows (raw pool)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ delta_applied: 0.05 }] })
    const pg = makeRawPool(query)
    const { getBumpLog } = await import('../../src/graph/queries.js')
    const result = await getBumpLog(pg, { qKeyId: 'q_k1', author: 'alice', limit: 5 })
    expect(result).toHaveLength(1)
  })
})

// ── incrementDomainStat ───────────────────────────────────────────────────────

describe('incrementDomainStat', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.incrementDomainStat when available', async () => {
    const gw = makeGatewayClientMock()
    gw.incrementDomainStat.mockResolvedValue(undefined)
    const { incrementDomainStat } = await import('../../src/graph/queries.js')
    await incrementDomainStat(gw, { author: 'alice', domain: 'auth', projectId: 'q_p1', field: 'approved_count' })
    expect(gw.incrementDomainStat).toHaveBeenCalledOnce()
  })

  it('is a no-op when pg.incrementDomainStat is not a function (gateway mode)', async () => {
    const query = vi.fn()
    const pg = makeRawPool(query)
    const { incrementDomainStat } = await import('../../src/graph/queries.js')
    // Should not throw or call query
    await expect(
      incrementDomainStat(pg, { author: 'alice', domain: 'auth', projectId: 'q_p1', field: 'approved_count' })
    ).resolves.toBeUndefined()
    expect(query).not.toHaveBeenCalled()
  })
})

// ── getDomainStats ────────────────────────────────────────────────────────────

describe('getDomainStats', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.getDomainStats when available', async () => {
    const gw = makeGatewayClientMock()
    gw.getDomainStats.mockResolvedValue({ approved_count: 5, recalled_count: 2, superseded_count: 1 })
    const { getDomainStats } = await import('../../src/graph/queries.js')
    const result = await getDomainStats(gw, { qProjectId: 'q_p1', author: 'alice', domain: 'auth' })
    expect(result).toEqual({ approved_count: 5, recalled_count: 2, superseded_count: 1 })
  })

  it('returns null when not found (raw pool)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const pg = makeRawPool(query)
    const { getDomainStats } = await import('../../src/graph/queries.js')
    const result = await getDomainStats(pg, { qProjectId: 'q_p1', author: 'alice', domain: 'auth' })
    expect(result).toBeNull()
  })

  it('returns stats row when found (raw pool)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ approved_count: 3, recalled_count: 1, superseded_count: 0 }] })
    const pg = makeRawPool(query)
    const { getDomainStats } = await import('../../src/graph/queries.js')
    const result = await getDomainStats(pg, { qProjectId: 'q_p1', author: 'alice', domain: 'auth' })
    expect(result).toEqual({ approved_count: 3, recalled_count: 1, superseded_count: 0 })
  })
})
