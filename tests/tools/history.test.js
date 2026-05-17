/**
 * Tool: history()
 *
 * Returns the full version timeline merged from PostgreSQL + Graphiti.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../../src/graph/client.js', () => ({
  getEvolutionChain: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../src/graph/queries.js', () => ({
  getVersionHistory: vi.fn(),
}))

vi.mock('../../src/audit/pipeline.js', () => ({
  withAuditPipeline: vi.fn(async (_pg, _ctx, operation) => operation()),
}))

const mockPg = {}
const testCtx = { projectId: 'test-project', gatewayUrl: 'http://localhost:3001' }
const humanIdentity = { name: 'senior-architect' }

function makeVersion(over = {}) {
  return {
    version: 1,
    status: 'ACTIVE',
    author: 'ayan',
    created_at: new Date('2025-01-01').toISOString(),
    triggered_by: 'engineer_decision',
    supersedes_version: null,
    supersedes_reason: null,
    superseded_by_version: null,
    superseded_by_author: null,
    superseded_at: null,
    created_by_audit: 'audit_x',
    graphiti_episode_id: 'ep_1',
    ...over,
  }
}

describe('history — basic', () => {
  afterEach(() => vi.clearAllMocks())

  it('throws when ctx.projectId is missing', async () => {
    const { handler } = await import('../../src/tools/history.js')
    await expect(handler(mockPg, { topic: 'a', key: 'b' }, humanIdentity, null)).rejects.toThrow(/projectId is required/)
  })

  it('returns null when no versions found', async () => {
    const { getVersionHistory } = await import('../../src/graph/queries.js')
    vi.mocked(getVersionHistory).mockResolvedValue([])

    const { handler } = await import('../../src/tools/history.js')
    const result = await handler(mockPg, { topic: 'auth', key: 'nope' }, humanIdentity, testCtx)
    expect(result).toBeNull()
  })

  it('returns formatted versions with timeline', async () => {
    const { getVersionHistory } = await import('../../src/graph/queries.js')
    vi.mocked(getVersionHistory).mockResolvedValue([
      makeVersion({ version: 3, status: 'ACTIVE' }),
      makeVersion({ version: 2, status: 'SUPERSEDED', superseded_by_version: 3, superseded_at: new Date().toISOString(), supersedes_reason: 'replaced' }),
      makeVersion({ version: 1, status: 'SUPERSEDED', graphiti_episode_id: null }),
    ])

    const { handler } = await import('../../src/tools/history.js')
    const result = await handler(mockPg, { topic: 'auth', key: 'token' }, humanIdentity, testCtx)

    expect(result).not.toBeNull()
    expect(result.topic).toBe('auth')
    expect(result.versions).toHaveLength(3)
    expect(result.formatted).toContain('Version History')
    expect(result.formatted).toContain('v3')
    expect(result.formatted).toContain('ACTIVE')
    expect(result.formatted).toContain('Superseded by v3')
  })

  it('enriches with evolution chain when latest has episode_id', async () => {
    const { getVersionHistory } = await import('../../src/graph/queries.js')
    const { getEvolutionChain } = await import('../../src/graph/client.js')
    vi.mocked(getVersionHistory).mockResolvedValue([makeVersion({ version: 1, graphiti_episode_id: 'ep_1' })])
    vi.mocked(getEvolutionChain).mockResolvedValue([{ episode_id: 'ep_1', summary: 'x' }])

    const { handler } = await import('../../src/tools/history.js')
    const result = await handler(mockPg, { topic: 'auth', key: 'token' }, humanIdentity, testCtx)

    expect(getEvolutionChain).toHaveBeenCalledWith('ep_1', 'test-project')
    expect(result.versions[0].graph_linked).toBe(true)
  })

  it('handles getEvolutionChain failure gracefully', async () => {
    const { getVersionHistory } = await import('../../src/graph/queries.js')
    const { getEvolutionChain } = await import('../../src/graph/client.js')
    vi.mocked(getVersionHistory).mockResolvedValue([makeVersion({ version: 1, graphiti_episode_id: 'ep_1' })])
    vi.mocked(getEvolutionChain).mockRejectedValue(new Error('graphiti down'))

    const { handler } = await import('../../src/tools/history.js')
    const result = await handler(mockPg, { topic: 'auth', key: 'token' }, humanIdentity, testCtx)

    expect(result.versions[0].graph_linked).toBe(false)
  })

  it('uses default author when not provided', async () => {
    const { getVersionHistory } = await import('../../src/graph/queries.js')
    vi.mocked(getVersionHistory).mockResolvedValue([])

    const { handler } = await import('../../src/tools/history.js')
    const result = await handler(mockPg, { topic: 'auth', key: 'x', author: 'unknown' }, undefined, testCtx)
    expect(result).toBeNull()
  })
})
