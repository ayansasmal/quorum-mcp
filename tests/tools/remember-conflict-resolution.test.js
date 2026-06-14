/**
 * Tests for remember.js — conflict resolution paths (lines 444-599).
 *
 * When handler() receives conflict_id + resolution, it calls resolveConflictDecision()
 * which handles: supersede, coexist_split, coexist_merge, reject, escalate.
 *
 * These paths require getPendingDecisionById to return a pending decision
 * and getCurrentVersion for the existing version.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks (top-level — hoisted by Vitest) ─────────────────────────────────────

vi.mock('../../src/config/loader.js', () => {
  // getConfig and getConfigSafe share one fn so per-test overrides flow through both.
  const cfg = vi.fn(() => ({ project: 'test', members: [], roles: {}, domains: {}, group_id: 'test-project', is_global: false }))
  return {
    loadConfig:       async () => ({ project: 'test', members: [], group_id: 'test-project' }),
    stopConfigPoller: () => {},
    getConfig: cfg,
    getConfigSafe: cfg,
    isConfigLoaded: () => true,
  }
})

vi.mock('../../src/graph/client.js', () => ({
  addEpisode: vi.fn(),
  addSupersedingEpisode: vi.fn(),
  searchNodes: vi.fn(),
  getEvolutionChain: vi.fn(),
  deleteEpisodeSoft: vi.fn(),
  ping: vi.fn(),
  BLOCKED_METHODS: new Set(['delete_episode', 'delete_entity', 'purge']),
  isMethodBlocked: vi.fn(),
}))

vi.mock('../../src/graph/queries.js', () => ({
  getCurrentVersion: vi.fn(),
  getNextVersionNumber: vi.fn(),
  getVersionHistory: vi.fn(),
  getVersionAtDate: vi.fn(),
  getSpecificVersion: vi.fn(),
  insertVersion: vi.fn(),
  transitionVersionStatus: vi.fn(),
  insertVersionAuditLink: vi.fn(),
  countPendingForKey: vi.fn().mockResolvedValue(0),
  insertPendingDecision: vi.fn().mockResolvedValue('q_c1'),
  getPendingDecisionById: vi.fn(),
  resolvePendingDecision: vi.fn().mockResolvedValue(),
  getOrCreateKey: vi.fn().mockResolvedValue('q_k1'),
  incrementDomainStat: vi.fn().mockResolvedValue(),
}))

vi.mock('../../src/audit/pipeline.js', () => ({
  withAuditPipeline: vi.fn(async (_pg, _ctx, operation) => {
    const result = await operation()
    return result
  }),
}))

vi.mock('../../src/governance/conflict.js', () => ({
  detectConflict: vi.fn().mockResolvedValue({ conflict: false }),
  resolveConflict: vi.fn(),
  generateEnrichment: vi.fn().mockResolvedValue({
    analysis: 'mock analysis',
    risks_if_approved: [],
    questions_for_reviewer: [],
    existing_rationale: null,
    possible_split: false,
  }),
  normalizeTags: vi.fn((tags) => {
    if (!tags || !Array.isArray(tags)) return []
    return [...new Set(tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean))].sort()
  }),
}))

vi.mock('../../src/governance/authority.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    resolveAuthorConfidence: vi.fn((provided, _identity) => provided ?? 0.7),
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────────

const humanIdentity = {
  name: 'bob',
  team: 'platform',
  role: 'engineer',
  base_confidence: 0.7,
  method: 'github_token',
}

const mockPg = {
  // atomicSupersede is called by remember.js supersede() for non-global projects
  atomicSupersede: vi.fn().mockResolvedValue({
    new_version: { version_id: 'q_k1_v2', q_key_id: 'q_k1', version: 2 },
  }),
  incrementDomainStat: vi.fn().mockResolvedValue(),
}

const testCtx = { projectId: 'test-project', gatewayUrl: 'http://localhost:3001' }

function makePendingDecision(overrides = {}) {
  return {
    conflict_id: 'q_c1',
    conflict_topic: 'auth',
    conflict_key: 'token-strategy',
    existing_content: 'Use JWT for Lambda',
    incoming_content: 'Use sessions for all',
    status: 'pending',
    decision_type: 'conflict',
    ...overrides,
  }
}

function makeExistingVersion(overrides = {}) {
  return {
    version: 1,
    version_id: 'q_k1_v1',
    q_key_id: 'q_k1',
    topic: 'auth',
    key: 'token-strategy',
    status: 'ACTIVE',
    author: 'alice',
    content: 'Use JWT for Lambda',
    summary: 'Use JWT for Lambda',
    confidence: 0.8,
    ...overrides,
  }
}

// ── reject resolution ─────────────────────────────────────────────────────────

describe('remember — conflict resolution: reject', () => {
  afterEach(() => vi.clearAllMocks())

  it('closes conflict as rejected and returns resolved status', async () => {
    const { getPendingDecisionById, resolvePendingDecision, getCurrentVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getPendingDecisionById).mockResolvedValue(makePendingDecision())
    vi.mocked(getCurrentVersion).mockResolvedValue(makeExistingVersion())
    vi.mocked(resolvePendingDecision).mockResolvedValue()

    const { handler } = await import('../../src/tools/remember.js')
    const result = await handler(mockPg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'New content',
      conflict_id: 'q_c1',
      resolution: 'reject',
      reason: 'Incoming knowledge is incorrect for our use case',
    }, humanIdentity, testCtx)

    expect(result.status).toBe('resolved')
    expect(result.resolution).toBe('reject')
    expect(result.message).toContain('rejected')
    expect(resolvePendingDecision).toHaveBeenCalledOnce()
  })
})

describe('remember — conflict resolution: escalate', () => {
  afterEach(() => vi.clearAllMocks())

  it('closes conflict as escalated and returns resolved status', async () => {
    const { getPendingDecisionById, resolvePendingDecision, getCurrentVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getPendingDecisionById).mockResolvedValue(makePendingDecision())
    vi.mocked(getCurrentVersion).mockResolvedValue(makeExistingVersion())
    vi.mocked(resolvePendingDecision).mockResolvedValue()

    const { handler } = await import('../../src/tools/remember.js')
    const result = await handler(mockPg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'New content',
      conflict_id: 'q_c1',
      resolution: 'escalate',
      reason: 'Need architecture team to decide this one',
    }, humanIdentity, testCtx)

    expect(result.status).toBe('resolved')
    expect(result.resolution).toBe('escalate')
    expect(result.message).toContain('escalated')
  })
})

describe('remember — conflict resolution: not_found', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns not_found when conflict_id does not exist', async () => {
    const { getPendingDecisionById } = await import('../../src/graph/queries.js')
    vi.mocked(getPendingDecisionById).mockResolvedValue(null)

    const { handler } = await import('../../src/tools/remember.js')
    const result = await handler(mockPg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'New content',
      conflict_id: 'q_c_nonexistent',
      resolution: 'reject',
      reason: 'Rejecting this knowledge entry',
    }, humanIdentity, testCtx)

    expect(result.status).toBe('not_found')
    expect(result.message).toContain('q_c_nonexistent')
  })
})

describe('remember — conflict resolution: supersede', () => {
  afterEach(() => vi.clearAllMocks())

  it('supersedes existing and closes conflict', async () => {
    const {
      getPendingDecisionById, resolvePendingDecision, getCurrentVersion,
      getNextVersionNumber, insertVersion, transitionVersionStatus,
    } = await import('../../src/graph/queries.js')
    const { addEpisode, addSupersedingEpisode } = await import('../../src/graph/client.js')

    vi.mocked(getPendingDecisionById).mockResolvedValue(makePendingDecision())
    vi.mocked(getCurrentVersion).mockResolvedValue(makeExistingVersion())
    vi.mocked(getNextVersionNumber).mockResolvedValue(2)
    vi.mocked(insertVersion).mockResolvedValue({ version_id: 'q_k1_v2', q_key_id: 'q_k1', version: 2 })
    vi.mocked(transitionVersionStatus).mockResolvedValue()
    vi.mocked(resolvePendingDecision).mockResolvedValue()
    vi.mocked(addEpisode).mockResolvedValue({ episode_id: 'ep_new' })
    vi.mocked(addSupersedingEpisode).mockResolvedValue({ episode_id: 'ep_new' })

    const { handler } = await import('../../src/tools/remember.js')
    const result = await handler(mockPg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'Use JWT with refresh tokens',
      conflict_id: 'q_c1',
      resolution: 'supersede',
      reason: 'JWT with refresh tokens is the correct approach here',
    }, humanIdentity, testCtx)

    expect(['stored', 'resolved', 'superseded'].some(s => result.status === s)).toBe(true)
    expect(resolvePendingDecision).toHaveBeenCalled()
  })
})

describe('remember — conflict resolution: coexist_merge', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns error when merged_content is missing', async () => {
    const { getPendingDecisionById, getCurrentVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getPendingDecisionById).mockResolvedValue(makePendingDecision())
    vi.mocked(getCurrentVersion).mockResolvedValue(makeExistingVersion())

    const { handler } = await import('../../src/tools/remember.js')
    const result = await handler(mockPg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'New content',
      conflict_id: 'q_c1',
      resolution: 'coexist_merge',
      reason: 'Merging both perspectives into one',
      // merged_content intentionally omitted
    }, humanIdentity, testCtx)

    expect(result.status).toBe('error')
    expect(result.message).toContain('merged_content')
  })

  it('returns error when no ACTIVE version exists for merge', async () => {
    const { getPendingDecisionById, getCurrentVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getPendingDecisionById).mockResolvedValue(makePendingDecision())
    vi.mocked(getCurrentVersion).mockResolvedValue(null) // no existing version

    const { handler } = await import('../../src/tools/remember.js')
    const result = await handler(mockPg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'New content',
      conflict_id: 'q_c1',
      resolution: 'coexist_merge',
      reason: 'Merging both perspectives',
      merged_content: 'JWT for Lambda, sessions for ECS — both valid in context',
    }, humanIdentity, testCtx)

    expect(result.status).toBe('error')
    expect(result.message).toContain('No ACTIVE version')
  })
})

describe('remember — conflict resolution: coexist_split', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns error when split keys are missing', async () => {
    const { getPendingDecisionById, getCurrentVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getPendingDecisionById).mockResolvedValue(makePendingDecision())
    vi.mocked(getCurrentVersion).mockResolvedValue(makeExistingVersion())

    const { handler } = await import('../../src/tools/remember.js')
    const result = await handler(mockPg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'New content',
      conflict_id: 'q_c1',
      resolution: 'coexist_split',
      reason: 'Splitting into scoped entries',
      // split_existing_key and split_incoming_key intentionally omitted
    }, humanIdentity, testCtx)

    expect(result.status).toBe('error')
    expect(result.message).toContain('coexist_split requires')
  })

  it('creates split entries and closes conflict', async () => {
    const {
      getPendingDecisionById, resolvePendingDecision, getCurrentVersion,
      getNextVersionNumber, insertVersion, transitionVersionStatus,
    } = await import('../../src/graph/queries.js')
    const { addEpisode } = await import('../../src/graph/client.js')

    vi.mocked(getPendingDecisionById).mockResolvedValue(makePendingDecision())
    vi.mocked(getCurrentVersion).mockResolvedValue(makeExistingVersion())
    vi.mocked(getNextVersionNumber).mockResolvedValue(1)
    vi.mocked(insertVersion).mockResolvedValue({ version_id: 'q_k1_v1', q_key_id: 'q_k1', version: 1 })
    vi.mocked(transitionVersionStatus).mockResolvedValue()
    vi.mocked(resolvePendingDecision).mockResolvedValue()
    vi.mocked(addEpisode).mockResolvedValue({ episode_id: 'ep_split' })

    const { handler } = await import('../../src/tools/remember.js')
    const result = await handler(mockPg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'Context-scoped knowledge',
      conflict_id: 'q_c1',
      resolution: 'coexist_split',
      reason: 'JWT for Lambda, sessions for ECS — different contexts',
      split_existing_key: 'token-strategy-lambda',
      split_incoming_key: 'token-strategy-ecs',
    }, humanIdentity, testCtx)

    expect(result.status).toBe('resolved')
    expect(result.resolution).toBe('coexist_split')
    expect(result.split_a).toBeDefined()
    expect(result.split_b).toBeDefined()
  })
})

describe('remember — Graphiti unavailable (PENDING_CONFLICT_CHECK)', () => {
  afterEach(() => vi.clearAllMocks())

  it('stores as PENDING_CONFLICT_CHECK when Graphiti is unavailable', async () => {
    const { getCurrentVersion, getNextVersionNumber, insertVersion, getOrCreateKey } = await import('../../src/graph/queries.js')
    const { detectConflict } = await import('../../src/governance/conflict.js')

    // storePendingConflictCheck is only reachable via the supersede path (when existing != null).
    // We must return an existing version so remember.js enters the "if (existing)" block
    // and calls detectConflict() — which then returns graphiti_unavailable.
    vi.mocked(getCurrentVersion).mockResolvedValue(makeExistingVersion())
    vi.mocked(getNextVersionNumber).mockResolvedValue(2)
    vi.mocked(getOrCreateKey).mockResolvedValue('q_k1')
    vi.mocked(insertVersion).mockResolvedValue({ version_id: 'q_k1_v2', q_key_id: 'q_k1', version: 2 })
    // detectConflict signals Graphiti is down — remember.js calls storePendingConflictCheck()
    vi.mocked(detectConflict).mockResolvedValue({ conflict: false, graphiti_unavailable: true })

    const { handler } = await import('../../src/tools/remember.js')
    const result = await handler(mockPg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'Use JWT for Lambda services',
      reason: 'Updating auth strategy for Lambda services',
    }, humanIdentity, testCtx)

    // When Graphiti unavailable, should store as PENDING_CONFLICT_CHECK
    expect(result.status).toBe('stored')
    expect(result.knowledge_status).toBe('PENDING_CONFLICT_CHECK')
    expect(result.warning).toContain('Conflict check deferred')
  })
})
