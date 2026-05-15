/**
 * Tool: remember() — atomic supersession (Gap 3).
 *
 * Verifies that the non-global supersede path uses the new
 * GatewayClient.atomicSupersede() helper rather than the legacy
 * insertVersion → transitionVersionStatus pair, eliminating the race
 * window where two ACTIVE rows could coexist.
 *
 * Global writes (projectId === 'global') keep the legacy path — the old
 * ACTIVE stays until a reviewer approves the DRAFT, so no atomic transition
 * is needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock('../../src/graph/client.js', () => ({
  addEpisode: vi.fn().mockResolvedValue({ episode_id: 'ep_new' }),
  addSupersedingEpisode: vi.fn().mockResolvedValue({ episode_id: 'ep_new' }),
  searchNodes: vi.fn(),
  getEvolutionChain: vi.fn(),
  deleteEpisodeSoft: vi.fn(),
  ping: vi.fn(),
  BLOCKED_METHODS: new Set(['delete_episode', 'delete_entity', 'purge']),
  isMethodBlocked: vi.fn(() => false),
}))

vi.mock('../../src/graph/queries.js', () => ({
  getCurrentVersion: vi.fn(),
  getNextVersionNumber: vi.fn(),
  getVersionHistory: vi.fn(),
  getVersionAtDate: vi.fn(),
  getSpecificVersion: vi.fn(),
  insertVersion: vi.fn().mockResolvedValue({}),
  transitionVersionStatus: vi.fn().mockResolvedValue({}),
  insertVersionAuditLink: vi.fn(),
  countPendingForKey: vi.fn().mockResolvedValue(0),
  insertPendingDecision: vi.fn().mockResolvedValue(),
  getPendingDecisionById: vi.fn(),
  resolvePendingDecision: vi.fn().mockResolvedValue(),
  incrementDomainStat: vi.fn().mockResolvedValue(),
}))

vi.mock('../../src/audit/pipeline.js', () => ({
  withAuditPipeline: vi.fn(async (_pg, _ctx, operation) => operation()),
}))

vi.mock('../../src/governance/conflict.js', () => ({
  detectConflict: vi.fn().mockResolvedValue({ conflict: false, graphiti_unavailable: false }),
  resolveConflict: vi.fn(),
  generateEnrichment: vi.fn().mockResolvedValue({ analysis: '', risks_if_approved: [], questions_for_reviewer: [], existing_rationale: null, possible_split: false }),
  normalizeTags: vi.fn((tags) => {
    if (!tags || !Array.isArray(tags)) return []
    return [...new Set(tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean))].sort()
  }),
}))

vi.mock('../../src/governance/constitutional.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    enforceReasonRequired: vi.fn(() => {}),
  }
})

vi.mock('../../src/governance/authority.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    resolveAuthorConfidence: vi.fn((provided) => provided),
  }
})

// ── Shared helpers ────────────────────────────────────────────────────────────

const humanIdentity = {
  name: 'senior-architect',
  team: 'platform',
  role: 'principal_architect',
  base_confidence: 0.9,
  method: 'github_token',
}

/** Build a GatewayClient-shaped fake pg with atomicSupersede tracking. */
function makePgClient() {
  return {
    atomicSupersede: vi.fn().mockResolvedValue({
      inserted: true,
      superseded_version: 1,
      rows_updated: 1,
    }),
    query: vi.fn(() => { throw new Error('pg.query should not be called') }),
  }
}

const existingVersion = {
  topic: 'auth',
  key: 'token-strategy',
  version: 1,
  status: 'ACTIVE',
  content: 'Use sessions',
  author: 'alice',
  graphiti_episode_id: 'ep_001',
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('remember — atomic supersede (non-global path)', () => {
  beforeEach(async () => {
    const { getCurrentVersion, getNextVersionNumber } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue(existingVersion)
    vi.mocked(getNextVersionNumber).mockResolvedValue(2)
  })

  afterEach(() => vi.clearAllMocks())

  it('calls atomicSupersede on the gateway client (not insertVersion + transitionVersionStatus)', async () => {
    const { handler } = await import('../../src/tools/remember.js')
    const { insertVersion, transitionVersionStatus } = await import('../../src/graph/queries.js')

    const pg = makePgClient()

    const result = await handler(
      pg,
      {
        topic: 'auth',
        key: 'token-strategy',
        content: 'Use JWT for all services',
        confidence: 0.85,
        reason: 'switching to JWT for stateless services',
      },
      humanIdentity,
      { projectId: 'test-project', gatewayUrl: 'http://localhost:3001' },
    )

    expect(pg.atomicSupersede).toHaveBeenCalledTimes(1)
    expect(vi.mocked(insertVersion)).not.toHaveBeenCalled()
    expect(vi.mocked(transitionVersionStatus)).not.toHaveBeenCalled()

    expect(result.status).toBe('stored')
    expect(result.version).toBe(2)
    expect(result.superseded_version).toBe(1)
  })

  it('passes correct args to atomicSupersede (new_version, supersedes_version, forward_link)', async () => {
    const { handler } = await import('../../src/tools/remember.js')

    const pg = makePgClient()

    await handler(
      pg,
      {
        topic: 'auth',
        key: 'token-strategy',
        content: 'Use JWT for all services',
        confidence: 0.85,
        reason: 'switching to JWT for stateless services',
      },
      humanIdentity,
      { projectId: 'test-project', gatewayUrl: 'http://localhost:3001' },
    )

    const [newVersion, supersedesVersion, supersedesReason, forwardLink] =
      pg.atomicSupersede.mock.calls[0]

    expect(newVersion).toMatchObject({
      topic: 'auth',
      key: 'token-strategy',
      version: 2,
      status: 'ACTIVE',
      project_id: 'test-project',
    })
    expect(supersedesVersion).toBe(1)
    expect(supersedesReason).toBe('switching to JWT for stateless services')
    expect(forwardLink).toBeTruthy()
    expect(forwardLink.supersededByVersion).toBe(2)
  })
})

describe('remember — global supersede path (unchanged)', () => {
  beforeEach(async () => {
    const { getCurrentVersion, getNextVersionNumber } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue(existingVersion)
    vi.mocked(getNextVersionNumber).mockResolvedValue(2)
  })

  afterEach(() => vi.clearAllMocks())

  it('uses insertVersion (not atomicSupersede) for global namespace writes', async () => {
    const { handler } = await import('../../src/tools/remember.js')
    const { insertVersion, transitionVersionStatus } = await import('../../src/graph/queries.js')

    const pg = makePgClient()

    const result = await handler(
      pg,
      {
        topic: 'auth',
        key: 'token-strategy',
        content: 'Global policy update',
        confidence: 0.9,
        reason: 'company-wide adoption of OAuth2.1',
      },
      humanIdentity,
      { projectId: 'global', gatewayUrl: 'http://localhost:3001' },
    )

    expect(vi.mocked(insertVersion)).toHaveBeenCalledTimes(1)
    expect(pg.atomicSupersede).not.toHaveBeenCalled()
    // Global path leaves old ACTIVE in place — no transition call
    expect(vi.mocked(transitionVersionStatus)).not.toHaveBeenCalled()
    expect(result.status).toBe('pending_review')
  })
})
