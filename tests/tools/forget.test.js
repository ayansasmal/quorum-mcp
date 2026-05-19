/**
 * Tool: forget()
 *
 * Tests the forget handler: creates a DEPRECATED version (never hard-delete).
 *   - Requires reason (≥10 meaningful chars)
 *   - Returns not_found when no ACTIVE exists
 *   - Inserts a new DEPRECATED version and transitions old to DEPRECATED
 *   - Calls deleteEpisodeSoft on the Graphiti episode (best-effort)
 *   - Author is injected from identity (3rd param)
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { ConstitutionalViolation } from '../../src/governance/constitutional.js'

vi.mock('../../src/graph/client.js', () => ({
  addEpisode: vi.fn(),
  addSupersedingEpisode: vi.fn(),
  searchNodes: vi.fn(),
  getEvolutionChain: vi.fn(),
  deleteEpisodeSoft: vi.fn().mockResolvedValue({}),
  ping: vi.fn(),
  BLOCKED_METHODS: new Set(['delete_episode']),
  isMethodBlocked: vi.fn(() => false),
}))

vi.mock('../../src/graph/queries.js', () => ({
  getCurrentVersion: vi.fn(),
  getNextVersionNumber: vi.fn(),
  insertVersion: vi.fn().mockResolvedValue({ version_id: 'q_k1_v2', q_key_id: 'q_k1' }),
  transitionVersionStatus: vi.fn().mockResolvedValue(),
  insertVersionAuditLink: vi.fn().mockResolvedValue(),
  incrementDomainStat: vi.fn().mockResolvedValue(),
}))

vi.mock('../../src/audit/pipeline.js', () => ({
  withAuditPipeline: vi.fn(async (_pg, _ctx, operation) => {
    return await operation()
  }),
}))

const mockPg = {}
const humanIdentity = { name: 'senior-architect', team: 'platform', role: 'principal_architect', base_confidence: 0.9, method: 'github_token' }
const juniorIdentity = { name: 'junior-dev', team: 'platform', role: 'senior_engineer', base_confidence: 0.7, method: 'github_token' }
const testCtx = { projectId: 'test-project', gatewayUrl: 'http://localhost:3001' }

describe('forget — role guard', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns forbidden when caller is not principal_architect', async () => {
    const { handler } = await import('../../src/tools/forget.js')
    const result = await handler(mockPg, {
      topic: 'auth', key: 'token-strategy', reason: 'Replaced by new OAuth approach with PKCE',
    }, juniorIdentity, testCtx)

    expect(result.status).toBe('forbidden')
    expect(result.message).toContain('principal_architect')
    expect(result.message).toContain('senior_engineer')
    expect(result.topic).toBe('auth')
    expect(result.key).toBe('token-strategy')
  })

  it('returns forbidden when identity is missing (anonymous caller)', async () => {
    const { handler } = await import('../../src/tools/forget.js')
    const result = await handler(mockPg, {
      topic: 'auth', key: 'token-strategy', reason: 'Replaced by new OAuth approach with PKCE',
    }, undefined, testCtx)

    expect(result.status).toBe('forbidden')
    expect(result.message).toContain('unknown')
  })

  it('allows is_admin to bypass PE role check', async () => {
    const { getCurrentVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue(null)

    const { handler } = await import('../../src/tools/forget.js')
    const result = await handler(mockPg, {
      topic: 'auth', key: 'absent', reason: 'Replaced by new OAuth approach with PKCE',
    }, { name: 'admin-user', role: 'senior_engineer', is_admin: true }, testCtx)

    expect(result.status).not.toBe('forbidden')
  })
})

describe('forget — input validation', () => {
  afterEach(() => vi.clearAllMocks())

  it('throws when ctx.projectId is missing', async () => {
    const { handler } = await import('../../src/tools/forget.js')
    await expect(
      handler(mockPg, { topic: 'auth', key: 'x', reason: 'Outdated approach replaced by new strategy' }, humanIdentity, null),
    ).rejects.toThrow(/projectId is required/)
  })

  it('throws ConstitutionalViolation when reason is too short', async () => {
    const { handler } = await import('../../src/tools/forget.js')
    await expect(
      handler(mockPg, { topic: 'auth', key: 'x', reason: 'short' }, humanIdentity, testCtx),
    ).rejects.toThrow(ConstitutionalViolation)
  })

  it('throws ConstitutionalViolation when reason is a placeholder', async () => {
    const { handler } = await import('../../src/tools/forget.js')
    await expect(
      handler(mockPg, { topic: 'auth', key: 'x', reason: 'TODO' }, humanIdentity, testCtx),
    ).rejects.toThrow(ConstitutionalViolation)
  })
})

describe('forget — happy path', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns not_found when no existing version', async () => {
    const { getCurrentVersion } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue(null)

    const { handler } = await import('../../src/tools/forget.js')
    const result = await handler(mockPg, {
      topic: 'auth', key: 'absent', reason: 'No longer relevant after deprecating module',
    }, humanIdentity, testCtx)

    expect(result.status).toBe('not_found')
    expect(result.topic).toBe('auth')
    expect(result.key).toBe('absent')
  })

  it('creates DEPRECATED version and transitions old version', async () => {
    const { getCurrentVersion, getNextVersionNumber, insertVersion, transitionVersionStatus } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue({
      version: 3,
      status: 'ACTIVE',
      author: 'someone',
      graphiti_episode_id: 'ep_abc',
    })
    vi.mocked(getNextVersionNumber).mockResolvedValue(4)

    const { handler } = await import('../../src/tools/forget.js')
    const result = await handler(mockPg, {
      topic: 'auth', key: 'token-strategy', reason: 'Replaced by new OAuth approach with PKCE',
    }, humanIdentity, testCtx)

    expect(result.status).toBe('deprecated')
    expect(result.deprecated_version).toBe(3)
    expect(result.deprecation_version).toBe(4)
    expect(insertVersion).toHaveBeenCalled()
    expect(transitionVersionStatus).toHaveBeenCalledWith(
      mockPg, 'auth', 'token-strategy', 3, 'DEPRECATED',
      expect.objectContaining({ version: 4, author: 'senior-architect' }),
      'test-project',
    )
  })

  it('calls deleteEpisodeSoft when graphiti_episode_id present', async () => {
    const { getCurrentVersion, getNextVersionNumber } = await import('../../src/graph/queries.js')
    const { deleteEpisodeSoft } = await import('../../src/graph/client.js')

    vi.mocked(getCurrentVersion).mockResolvedValue({
      version: 1, status: 'ACTIVE', author: 'a', graphiti_episode_id: 'ep_zzz',
    })
    vi.mocked(getNextVersionNumber).mockResolvedValue(2)

    const { handler } = await import('../../src/tools/forget.js')
    await handler(mockPg, {
      topic: 'auth', key: 'x', reason: 'Deprecating outdated strategy after audit',
    }, humanIdentity, testCtx)

    expect(deleteEpisodeSoft).toHaveBeenCalledWith(
      'ep_zzz',
      expect.objectContaining({ author: 'senior-architect' }),
      'test-project',
    )
  })

  it('skips deleteEpisodeSoft when no graphiti_episode_id', async () => {
    const { getCurrentVersion, getNextVersionNumber } = await import('../../src/graph/queries.js')
    const { deleteEpisodeSoft } = await import('../../src/graph/client.js')

    vi.mocked(getCurrentVersion).mockResolvedValue({
      version: 1, status: 'ACTIVE', author: 'a', graphiti_episode_id: null,
    })
    vi.mocked(getNextVersionNumber).mockResolvedValue(2)

    const { handler } = await import('../../src/tools/forget.js')
    await handler(mockPg, {
      topic: 'auth', key: 'x', reason: 'Deprecating outdated strategy after audit',
    }, humanIdentity, testCtx)

    expect(deleteEpisodeSoft).not.toHaveBeenCalled()
  })

  it('uses anonymous author when PE identity has no name', async () => {
    const { getCurrentVersion, getNextVersionNumber, transitionVersionStatus } = await import('../../src/graph/queries.js')
    vi.mocked(getCurrentVersion).mockResolvedValue({
      version: 1, status: 'ACTIVE', author: 'a', graphiti_episode_id: null,
    })
    vi.mocked(getNextVersionNumber).mockResolvedValue(2)

    const { handler } = await import('../../src/tools/forget.js')
    // PE role present but no name — author should fall back to 'anonymous'
    await handler(mockPg, {
      topic: 'auth', key: 'x', reason: 'Deprecating outdated strategy after audit',
    }, { role: 'principal_architect' }, testCtx)

    expect(transitionVersionStatus).toHaveBeenCalledWith(
      mockPg, 'auth', 'x', 1, 'DEPRECATED',
      expect.objectContaining({ author: 'anonymous' }),
      'test-project',
    )
  })

  it('tolerates deleteEpisodeSoft rejection (best-effort)', async () => {
    const { getCurrentVersion, getNextVersionNumber } = await import('../../src/graph/queries.js')
    const { deleteEpisodeSoft } = await import('../../src/graph/client.js')

    vi.mocked(deleteEpisodeSoft).mockRejectedValueOnce(new Error('Graphiti down'))
    vi.mocked(getCurrentVersion).mockResolvedValue({
      version: 1, status: 'ACTIVE', author: 'a', graphiti_episode_id: 'ep_x',
    })
    vi.mocked(getNextVersionNumber).mockResolvedValue(2)

    const { handler } = await import('../../src/tools/forget.js')
    const result = await handler(mockPg, {
      topic: 'auth', key: 'x', reason: 'Deprecating outdated strategy after audit',
    }, humanIdentity, testCtx)

    expect(result.status).toBe('deprecated')
  })
})
