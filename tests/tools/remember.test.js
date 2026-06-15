/**
 * Tool: remember()
 *
 * Tests the remember handler with mocked graph client and pg queries.
 *
 * v0.2: author is no longer in the input schema — it is injected via the
 * identity argument (3rd param). All handler calls pass a mock identity object.
 *
 * Verifies:
 *   1. First version (v1) is created as ACTIVE for human author
 *   2. Claude identity → DRAFT
 *   3. anonymous identity → DRAFT
 *   4. reflect-triggered → DRAFT
 *   5. Superseding without reason throws REASON_REQUIRED (Rule 3)
 *   6. Conflict detected → returns conflict_detected shape with conflict_id
 *   7. addEpisode called for first version; addSupersedingEpisode for supersede
 *   8. transitionVersionStatus called with SUPERSEDED on supersede
 *   9. Tags are normalized (lowercase + trim)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ConstitutionalViolation } from '../../src/governance/constitutional.js'

// ── Mocks (hoisted — must be at top level in ESM) ─────────────────────────────

vi.mock('../../src/config/loader.js', () => {
  // Faithful to real loader.js: getConfig() THROWS when unloaded; getConfigSafe()
  // returns null instead. remember() reads config via getConfigSafe — override
  // it (not getConfig) to drive is_global per-test.
  const defaultCfg = { project: 'test', members: [], roles: {}, domains: {}, group_id: 'test-project', is_global: false }
  return {
    loadConfig:       vi.fn(async () => ({ project: 'test', members: [], group_id: 'test-project' })),
    stopConfigPoller: () => {},
    getConfig:        vi.fn(() => defaultCfg),
    getConfigSafe:    vi.fn(() => defaultCfg),
    isConfigLoaded:   vi.fn(() => true),
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
  isMethodBlocked: vi.fn((m) => ['delete_episode', 'delete_entity', 'purge'].includes(m)),
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
  insertPendingDecision: vi.fn().mockResolvedValue(),
  getPendingDecisionById: vi.fn(),
  resolvePendingDecision: vi.fn().mockResolvedValue(),
  // GAP-21: fire-and-forget domain stat increment — must be present in mock
  incrementDomainStat: vi.fn().mockResolvedValue(),
}))

vi.mock('../../src/audit/pipeline.js', () => ({
  withAuditPipeline: vi.fn(async (_pg, _ctx, operation) => {
    const result = await operation()
    return result
  }),
}))

vi.mock('../../src/governance/conflict.js', () => ({
  detectConflict: vi.fn(),
  resolveConflict: vi.fn(),
  generateEnrichment: vi.fn().mockResolvedValue({
    analysis: 'Mock enrichment analysis',
    risks_if_approved: [],
    questions_for_reviewer: [],
    existing_rationale: null,
    possible_split: false,
  }),
  // normalizeTags uses real logic — no mocking needed, but must be exported
  normalizeTags: vi.fn((tags) => {
    if (!tags || !Array.isArray(tags)) return []
    return [...new Set(tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean))].sort()
  }),
}))

vi.mock('../../src/governance/authority.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    resolveAuthorConfidence: vi.fn((provided, _identity) => provided),
  }
})

// ── Shared helpers ────────────────────────────────────────────────────────────

const humanIdentity = { name: 'senior-architect', team: 'platform', role: 'principal_architect', base_confidence: 0.9, method: 'github_token' }
const claudeIdentity = { name: 'claude', team: null, role: null, base_confidence: 0.5, method: 'anonymous' }
const anonIdentity = { name: 'anonymous', team: null, role: null, base_confidence: 0.5, method: 'anonymous' }

// Minimal pg stub — tool code must not call pg.query() directly (scanner enforces this)
const mockPg = {}

const testCtx = { projectId: 'test-project', gatewayUrl: 'http://localhost:3001' }

// ── First version ─────────────────────────────────────────────────────────────

describe('remember — first version (v1)', () => {
  beforeEach(async () => {
    const { getCurrentVersion, getNextVersionNumber, insertVersion } = await import('../../src/graph/queries.js')
    const { addEpisode } = await import('../../src/graph/client.js')

    vi.mocked(getCurrentVersion).mockResolvedValue(null)
    vi.mocked(getNextVersionNumber).mockResolvedValue(1)
    vi.mocked(insertVersion).mockResolvedValue({ id: 1, version: 1 })
    vi.mocked(addEpisode).mockResolvedValue({ episode_id: 'ep_001' })
  })

  afterEach(() => vi.clearAllMocks())

  it('creates v1 as ACTIVE for a human identity', async () => {
    const { handler } = await import('../../src/tools/remember.js')

    const result = await handler(mockPg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'Use JWT for all services',
      confidence: 0.85,
    }, humanIdentity, testCtx)

    expect(result.status).toBe('stored')
    expect(result.version).toBe(1)
    expect(result.knowledge_status).toBe('ACTIVE')
  })

  it('calls addEpisode (not addSupersedingEpisode) for first version', async () => {
    const { handler } = await import('../../src/tools/remember.js')
    const { addEpisode, addSupersedingEpisode } = await import('../../src/graph/client.js')

    await handler(mockPg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'Use JWT for all services',
    }, humanIdentity, testCtx)

    expect(addEpisode).toHaveBeenCalledOnce()
    expect(addSupersedingEpisode).not.toHaveBeenCalled()
  })

  it('populates summary in insertVersion so content survives Graphiti/FalkorDB wipes', async () => {
    const { handler } = await import('../../src/tools/remember.js')
    const { insertVersion } = await import('../../src/graph/queries.js')

    await handler(mockPg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'Use JWT for all services',
    }, humanIdentity, testCtx)

    const insertCall = vi.mocked(insertVersion).mock.calls[0][1]
    expect(insertCall.summary).toBe('Use JWT for all services')
  })

  it('creates v1 as DRAFT when identity is claude', async () => {
    const { handler } = await import('../../src/tools/remember.js')
    const { insertVersion } = await import('../../src/graph/queries.js')

    await handler(mockPg, {
      topic: 'testing',
      key: 'claude-pattern',
      content: 'Some knowledge extracted from task',
      confidence: 0.75,
    }, claudeIdentity, testCtx)

    const insertCall = vi.mocked(insertVersion).mock.calls[0][1]
    expect(insertCall.status).toBe('DRAFT')
  })

  it('creates v1 as DRAFT when identity is anonymous', async () => {
    const { handler } = await import('../../src/tools/remember.js')
    const { insertVersion } = await import('../../src/graph/queries.js')

    await handler(mockPg, {
      topic: 'auth',
      key: 'anon-write',
      content: 'Some knowledge from unknown author',
    }, anonIdentity, testCtx)

    const insertCall = vi.mocked(insertVersion).mock.calls[0][1]
    expect(insertCall.status).toBe('DRAFT')
  })

  it('creates v1 as DRAFT when triggered_by is reflect', async () => {
    const { handler } = await import('../../src/tools/remember.js')
    const { insertVersion } = await import('../../src/graph/queries.js')

    await handler(mockPg, {
      topic: 'api',
      key: 'pattern-from-reflect',
      content: 'Extracted from task completion',
      triggered_by: 'reflect',
      confidence: 0.55,
    }, claudeIdentity, testCtx)

    const insertCall = vi.mocked(insertVersion).mock.calls[0][1]
    expect(insertCall.status).toBe('DRAFT')
  })

  it('normalizes tags to lowercase before storage', async () => {
    const { handler } = await import('../../src/tools/remember.js')
    const { normalizeTags } = await import('../../src/governance/conflict.js')

    await handler(mockPg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'Use JWT',
      tags: ['Auth:Token', '  JWT  ', 'auth:token', 'API'],
    }, humanIdentity, testCtx)

    expect(normalizeTags).toHaveBeenCalledWith(['Auth:Token', '  JWT  ', 'auth:token', 'API'])
  })
})

// ── Supersession ──────────────────────────────────────────────────────────────

describe('remember — superseding existing version', () => {
  const existingVersion = {
    id: 1,
    topic: 'auth',
    key: 'token-strategy',
    version: 1,
    status: 'ACTIVE',
    content: 'Use session tokens for all services',
    author: 'junior-dev',
    graphiti_episode_id: 'ep_001',
    created_at: new Date().toISOString(),
    confidence: 0.6,
    access_count: 0,
  }

  // Gap 3: non-global supersede uses the gateway's atomic endpoint.
  // Provide a pg with atomicSupersede so the handler can be exercised.
  let supersedePg

  beforeEach(async () => {
    const { getCurrentVersion, getNextVersionNumber, insertVersion } = await import('../../src/graph/queries.js')
    const { addSupersedingEpisode } = await import('../../src/graph/client.js')
    const { detectConflict } = await import('../../src/governance/conflict.js')

    vi.mocked(getCurrentVersion).mockResolvedValue(existingVersion)
    vi.mocked(getNextVersionNumber).mockResolvedValue(2)
    vi.mocked(insertVersion).mockResolvedValue({ id: 2, version: 2 })
    vi.mocked(addSupersedingEpisode).mockResolvedValue({ episode_id: 'ep_002' })
    vi.mocked(detectConflict).mockResolvedValue({ conflict: false })

    supersedePg = {
      atomicSupersede: vi.fn().mockResolvedValue({ inserted: true, superseded_version: 1, rows_updated: 1 }),
    }
  })

  afterEach(() => vi.clearAllMocks())

  it('throws REASON_REQUIRED when superseding without reason', async () => {
    const { handler } = await import('../../src/tools/remember.js')

    await expect(
      handler(supersedePg, {
        topic: 'auth',
        key: 'token-strategy',
        content: 'Use JWT for all services',
        confidence: 0.85,
        // no reason
      }, humanIdentity, testCtx),
    ).rejects.toThrow(ConstitutionalViolation)
  })

  it('calls addSupersedingEpisode (not addEpisode) when superseding', async () => {
    const { handler } = await import('../../src/tools/remember.js')
    const { addEpisode, addSupersedingEpisode } = await import('../../src/graph/client.js')

    await handler(supersedePg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'Use JWT for all services',
      confidence: 0.85,
      reason: 'Lambda services do not support session tokens',
    }, humanIdentity, testCtx)

    expect(addSupersedingEpisode).toHaveBeenCalledOnce()
    expect(addEpisode).not.toHaveBeenCalled()
  })

  it('returns v2 on successful supersession', async () => {
    const { handler } = await import('../../src/tools/remember.js')

    const result = await handler(supersedePg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'Use JWT for all services',
      confidence: 0.85,
      reason: 'Lambda services do not support session tokens',
    }, humanIdentity, testCtx)

    expect(result.status).toBe('stored')
    expect(result.version).toBe(2)
    expect(result.superseded_version).toBe(1)
  })

  it('calls atomicSupersede to mark old version as SUPERSEDED in a single transaction (Gap 3)', async () => {
    const { handler } = await import('../../src/tools/remember.js')
    const { transitionVersionStatus, insertVersion } = await import('../../src/graph/queries.js')

    await handler(supersedePg, {
      topic: 'auth',
      key: 'token-strategy',
      content: 'Use JWT for all services',
      reason: 'Lambda does not support sessions',
    }, humanIdentity, testCtx)

    expect(supersedePg.atomicSupersede).toHaveBeenCalledOnce()
    const [newVersion, supersedesVersion] = supersedePg.atomicSupersede.mock.calls[0]
    expect(supersedesVersion).toBe(1)
    expect(newVersion.status).toBe('ACTIVE')

    // Legacy two-call pattern must no longer be invoked
    expect(vi.mocked(insertVersion)).not.toHaveBeenCalled()
    expect(vi.mocked(transitionVersionStatus)).not.toHaveBeenCalled()
  })
})

// ── Conflict detection ────────────────────────────────────────────────────────

describe('remember — conflict detection', () => {
  const existingVersion = {
    id: 1,
    topic: 'db',
    key: 'connection-pooling',
    version: 1,
    status: 'ACTIVE',
    content: 'Pool size 10 per service',
    author: 'senior-architect',
    graphiti_episode_id: 'ep_db_01',
    created_at: new Date().toISOString(),
    confidence: 0.85,
    access_count: 10,
  }

  afterEach(() => vi.clearAllMocks())

  it('returns conflict_detected shape with conflict_id when human resolution is required', async () => {
    const { getCurrentVersion } = await import('../../src/graph/queries.js')
    const { detectConflict, resolveConflict } = await import('../../src/governance/conflict.js')
    const { insertVersion, insertPendingDecision } = await import('../../src/graph/queries.js')

    vi.mocked(getCurrentVersion).mockResolvedValue(existingVersion)
    vi.mocked(detectConflict).mockResolvedValue({
      conflict: true,
      reason: 'B contradicts A on pool size',
      similarity: 0.9,
      existing: existingVersion,
      possible_split: false,
    })
    vi.mocked(resolveConflict).mockReturnValue({
      action: 'human_required',
      brief: {
        type: 'conflict_decision_required',
        options: [],
        existing: {},
        incoming: {},
        conflict_reason: 'B contradicts A on pool size',
        possible_split: false,
        split_suggestion: null,
      },
    })
    vi.mocked(insertVersion).mockResolvedValue({ version_id: 'q_k1_v2', q_key_id: 'q_k1', version: 2, status: 'DRAFT' })
    vi.mocked(insertPendingDecision).mockResolvedValue('conflict_123')

    const { handler } = await import('../../src/tools/remember.js')

    const result = await handler(mockPg, {
      topic: 'db',
      key: 'connection-pooling',
      content: 'Use pool size 50 for batch processing',
      confidence: 0.5,
      reason: 'High concurrency batch jobs need more connections',
    }, humanIdentity, testCtx)

    expect(result.status).toBe('conflict_detected')
    expect(result.conflict_id).toMatch(/^conflict_/)
    expect(result.brief).toBeDefined()
    expect(result.brief.type).toBe('conflict_decision_required')
    expect(result.knowledge_status).toBe('DRAFT')
    expect(result.version).toBe(2)
    expect(vi.mocked(insertVersion)).toHaveBeenCalledWith(
      mockPg,
      expect.objectContaining({
        status: 'DRAFT',
        supersedes_version: 1,
        supersedes_reason: 'High concurrency batch jobs need more connections',
      }),
    )
    expect(vi.mocked(insertPendingDecision)).toHaveBeenCalledWith(
      mockPg,
      expect.objectContaining({
        conflict_id: expect.stringMatching(/^conflict_/),
        incoming_version_id: 'q_k1_v2',
        incoming_content: 'Use pool size 50 for batch processing',
      }),
    )
  })

  it('conflict_detected result includes possible_split signal', async () => {
    const { getCurrentVersion } = await import('../../src/graph/queries.js')
    const { detectConflict, resolveConflict } = await import('../../src/governance/conflict.js')

    vi.mocked(getCurrentVersion).mockResolvedValue(existingVersion)
    vi.mocked(detectConflict).mockResolvedValue({
      conflict: true,
      reason: 'Appears to contradict on pool size',
      similarity: 0.91,
      possible_split: true,
      split_suggestion: 'First for OLTP services, second for batch jobs',
    })
    vi.mocked(resolveConflict).mockReturnValue({
      action: 'human_required',
      brief: {
        type: 'conflict_decision_required',
        options: [],
        existing: {},
        incoming: {},
        conflict_reason: 'Appears to contradict on pool size',
        possible_split: true,
        split_suggestion: 'First for OLTP services, second for batch jobs',
      },
    })

    const { handler } = await import('../../src/tools/remember.js')

    const result = await handler(mockPg, {
      topic: 'db',
      key: 'connection-pooling',
      content: 'Pool size 50 for batch processing nodes',
      confidence: 0.7,
      reason: 'Batch nodes have different concurrency requirements',
    }, humanIdentity, testCtx)

    expect(result.possible_split).toBe(true)
    expect(result.split_suggestion).toBe('First for OLTP services, second for batch jobs')
  })
})

// ── Regression: Bug E — storePendingConflictCheck projectId casing ─────────────
// buildVersionRecord(params) guards on params.projectId (camelCase).
// storePendingConflictCheck previously passed project_id (snake_case), causing
// "buildVersionRecord: projectId is required" on the PENDING_CONFLICT_CHECK path.
//
// This path triggers on a SUPERSEDE operation when detectConflict returns
// { graphiti_unavailable: true } — meaning Graphiti is down and the conflict
// check must be deferred.

describe('remember — regression: storePendingConflictCheck uses camelCase projectId (Bug E)', () => {
  // Existing version fixture for the supersede path
  const existingVersion = {
    id: 1,
    version: 1,
    status: 'ACTIVE',
    content: 'Old retry strategy',
    summary: 'Old retry strategy',
    author: 'alice',
    q_key_id: 'q_k1',
    version_id: 'q_k1_v1',
  }

  afterEach(() => vi.clearAllMocks())

  it('does not throw when detectConflict signals graphiti_unavailable on supersede', async () => {
    const { getCurrentVersion, getNextVersionNumber, insertVersion } = await import('../../src/graph/queries.js')
    const { detectConflict } = await import('../../src/governance/conflict.js')

    // Supersede path: existing version present
    vi.mocked(getCurrentVersion).mockResolvedValue(existingVersion)
    vi.mocked(getNextVersionNumber).mockResolvedValue(2)
    vi.mocked(insertVersion).mockResolvedValue({ id: 2, version: 2 })
    // Graphiti unavailable — conflict check deferred
    vi.mocked(detectConflict).mockResolvedValue({ graphiti_unavailable: true, conflict: false })

    const { handler } = await import('../../src/tools/remember.js')

    // Must not throw "buildVersionRecord: projectId is required"
    await expect(
      handler(mockPg, {
        topic: 'infra',
        key: 'retry-strategy',
        content: 'Exponential backoff, max 3 retries',
        confidence: 0.8,
        reason: 'Updated backoff policy after incident review',
      }, humanIdentity, testCtx),
    ).resolves.toMatchObject({
      knowledge_status: 'PENDING_CONFLICT_CHECK',
    })
  })

  it('PENDING_CONFLICT_CHECK result carries topic, key, version, and warning', async () => {
    const { getCurrentVersion, getNextVersionNumber, insertVersion } = await import('../../src/graph/queries.js')
    const { detectConflict } = await import('../../src/governance/conflict.js')

    vi.mocked(getCurrentVersion).mockResolvedValue(existingVersion)
    vi.mocked(getNextVersionNumber).mockResolvedValue(2)
    vi.mocked(insertVersion).mockResolvedValue({ id: 2, version: 2 })
    vi.mocked(detectConflict).mockResolvedValue({ graphiti_unavailable: true, conflict: false })

    const { handler } = await import('../../src/tools/remember.js')

    const result = await handler(mockPg, {
      topic: 'infra',
      key: 'retry-strategy',
      content: 'Exponential backoff, max 3 retries',
      confidence: 0.8,
      reason: 'Updated backoff policy after incident review',
    }, humanIdentity, testCtx)

    expect(result).toMatchObject({
      topic: 'infra',
      key: 'retry-strategy',
      knowledge_status: 'PENDING_CONFLICT_CHECK',
    })
    expect(result.warning).toMatch(/deferred|unavailable/i)
  })
})

// ── v0.4: Global write authority (constitutional enforcement) ─────────────────

describe('remember — global catalog write authority (v0.4)', () => {
  afterEach(() => vi.clearAllMocks())

  it('throws GLOBAL_WRITE_AUTHORITY when engineer writes to a global catalog', async () => {
    const { getConfigSafe } = await import('../../src/config/loader.js')
    vi.mocked(getConfigSafe).mockReturnValue({
      project: 'security-standards', members: [], roles: {}, domains: {},
      group_id: 'security-standards', is_global: true,
    })

    const { handler } = await import('../../src/tools/remember.js')

    const engineerIdentity = { name: 'bob', team: 'platform', role: 'engineer', base_confidence: 0.5, method: 'git_email' }

    await expect(
      handler(
        {},
        { topic: 'auth', key: 'token-strategy', content: 'Some content', confidence: 0.5 },
        engineerIdentity,
        { projectId: 'security-standards', gatewayUrl: 'http://localhost:3001' },
      ),
    ).rejects.toMatchObject({
      name: 'ConstitutionalViolation',
      rule: 'GLOBAL_WRITE_AUTHORITY',
    })
  })

  it('allows architect-tier role to write to a global catalog', async () => {
    const { getCurrentVersion, insertVersion } = await import('../../src/graph/queries.js')
    const { addEpisode } = await import('../../src/graph/client.js')
    const { getConfigSafe } = await import('../../src/config/loader.js')

    vi.mocked(getCurrentVersion).mockResolvedValue(null)
    vi.mocked(insertVersion).mockResolvedValue({ id: 1, version: 1 })
    vi.mocked(addEpisode).mockResolvedValue({ episode_id: 'ep_global' })
    vi.mocked(getConfigSafe).mockReturnValue({
      project: 'security-standards', members: [], roles: {}, domains: {},
      group_id: 'security-standards', is_global: true,
    })

    const { handler } = await import('../../src/tools/remember.js')

    const architectIdentity = { name: 'alice', team: 'platform', role: 'architect', base_confidence: 0.8, method: 'github_token' }

    const result = await handler(
      {},
      { topic: 'auth', key: 'token-strategy', content: 'Global standard', confidence: 0.8 },
      architectIdentity,
      { projectId: 'security-standards', gatewayUrl: 'http://localhost:3001' },
    )

    // Architect writes to global catalog land as DRAFT (pending PA approval)
    expect(result.knowledge_status).toBe('DRAFT')
  })
})

// ── Regression: unloaded config must not crash remember() ─────────────────────
// A server reconnect or hung startup probe can leave startup()'s loadConfig()
// incomplete, so the module cache is null and getConfig() throws "Config not
// loaded". remember() previously surfaced that as a tool failure (it read
// getConfig() unguarded) while pending()/recall()/search() degraded. These tests
// lock in: (1) remember degrades via getConfigSafe() instead of throwing, and
// (2) it lazy-loads config when startup never finished.
describe('remember — regression: resilient to unloaded config', () => {
  beforeEach(async () => {
    const { getCurrentVersion, getNextVersionNumber, insertVersion } = await import('../../src/graph/queries.js')
    const { addEpisode } = await import('../../src/graph/client.js')
    vi.mocked(getCurrentVersion).mockResolvedValue(null)
    vi.mocked(getNextVersionNumber).mockResolvedValue(1)
    vi.mocked(insertVersion).mockResolvedValue({ id: 1, version: 1, status: 'ACTIVE' })
    vi.mocked(addEpisode).mockResolvedValue({ episode_id: 'ep_001' })
  })

  afterEach(() => vi.clearAllMocks())

  it('does not throw "Config not loaded" when config is unavailable — degrades is_global to false', async () => {
    const { getConfig, getConfigSafe, isConfigLoaded } = await import('../../src/config/loader.js')
    // Reproduce the live failure mode faithfully: the real getConfig() THROWS when
    // unloaded (the bug — remember read it unguarded), while getConfigSafe() returns
    // null. isConfigLoaded true skips the lazy load so we isolate the read path.
    // If remember regresses to getConfig(), this test throws and fails.
    vi.mocked(isConfigLoaded).mockReturnValue(true)
    vi.mocked(getConfig).mockImplementation(() => { throw new Error('[Quorum:config] Config not loaded — call loadConfig() at startup') })
    vi.mocked(getConfigSafe).mockReturnValue(null)

    const { handler } = await import('../../src/tools/remember.js')

    // PA write to a project we cannot classify as global ⟹ treated as non-global ⟹ ACTIVE, no throw.
    const result = await handler(mockPg, {
      topic: 'auth', key: 'token-strategy', content: 'Use JWT for all services', confidence: 0.85,
    }, humanIdentity, testCtx)

    expect(result.status).toBe('stored')
    expect(result.knowledge_status).toBe('ACTIVE')
  })

  it('lazy-loads config when startup left it unloaded (isConfigLoaded false → loadConfig called)', async () => {
    const { isConfigLoaded, loadConfig } = await import('../../src/config/loader.js')
    vi.mocked(isConfigLoaded).mockReturnValue(false) // startup never finished loadConfig

    const { handler } = await import('../../src/tools/remember.js')

    await handler(mockPg, {
      topic: 'auth', key: 'token-strategy', content: 'Use JWT for all services', confidence: 0.85,
    }, humanIdentity, testCtx)

    expect(loadConfig).toHaveBeenCalledOnce()
    expect(loadConfig).toHaveBeenCalledWith(mockPg) // lazy load threads the pg pool for DB-snapshot fallback
  })
})
