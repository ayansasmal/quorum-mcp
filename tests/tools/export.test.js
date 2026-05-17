/**
 * Tests for src/tools/export.js
 *
 * export() queries active + superseded versions, fetches Graphiti content,
 * builds markdown or confluence output.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/audit/pipeline.js', () => ({
  withAuditPipeline: vi.fn(async (_pg, _ctx, operation) => {
    const result = await operation()
    return result
  }),
}))

vi.mock('../../src/graph/client.js', () => ({
  searchNodes: vi.fn(),
}))

vi.mock('../../src/governance/provenance.js', () => ({
  buildAuditVersionImpact: vi.fn(() => ({ versions_created: [], versions_superseded: [] })),
}))

vi.mock('../../src/graph/schema.js', () => ({
  KnowledgeStatus: { ACTIVE: 'ACTIVE', DRAFT: 'DRAFT', SUPERSEDED: 'SUPERSEDED', DEPRECATED: 'DEPRECATED' },
}))

vi.mock('../../src/graph/queries.js', () => ({
  getVersionsByStatus: vi.fn(),
  getVersionStatusCounts: vi.fn(),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

const testCtx = { projectId: 'test-project', gatewayUrl: 'http://localhost:3001' }

function makeActiveVersion(overrides = {}) {
  return {
    version: 1,
    topic: 'auth',
    key: 'token-strategy',
    status: 'ACTIVE',
    author: 'alice',
    triggered_by: 'engineer_decision',
    created_at: new Date('2024-01-15').toISOString(),
    content: 'Use JWT for Lambda services',
    graphiti_episode_id: null,
    ...overrides,
  }
}

function makeSupersededVersion(overrides = {}) {
  return {
    version: 1,
    topic: 'auth',
    key: 'token-strategy',
    status: 'SUPERSEDED',
    author: 'alice',
    key: 'old-strategy',
    superseded_by_version: 2,
    superseded_by_author: 'bob',
    supersedes_reason: 'Lambda services adopted',
    superseded_at: new Date('2024-06-01').toISOString(),
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('export — missing projectId', () => {
  afterEach(() => vi.clearAllMocks())

  it('throws when ctx.projectId is not set', async () => {
    const { handler } = await import('../../src/tools/export.js')
    await expect(handler({}, { format: 'markdown', author: 'alice' }, undefined, null))
      .rejects.toThrow('ctx.projectId is required')
  })
})

describe('export — markdown format', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns markdown content with active and superseded sections', async () => {
    const { getVersionsByStatus, getVersionStatusCounts } = await import('../../src/graph/queries.js')
    vi.mocked(getVersionsByStatus)
      .mockResolvedValueOnce([makeActiveVersion()])     // active
      .mockResolvedValueOnce([makeSupersededVersion()]) // superseded
    vi.mocked(getVersionStatusCounts).mockResolvedValue({ ACTIVE: 1, DRAFT: 0, SUPERSEDED: 1, DEPRECATED: 0 })

    const { handler } = await import('../../src/tools/export.js')
    const result = await handler({}, { format: 'markdown', author: 'alice' }, undefined, testCtx)

    expect(result.format).toBe('markdown')
    expect(result.content).toContain('# ')
    expect(result.content).toContain('Active Knowledge')
    expect(result.content).toContain('Superseded')
    expect(result.content).toContain('Knowledge Stats')
  })

  it('shows no active knowledge message when empty', async () => {
    const { getVersionsByStatus, getVersionStatusCounts } = await import('../../src/graph/queries.js')
    vi.mocked(getVersionsByStatus)
      .mockResolvedValueOnce([])  // active — empty
      .mockResolvedValueOnce([])  // superseded — empty
    vi.mocked(getVersionStatusCounts).mockResolvedValue({})

    const { handler } = await import('../../src/tools/export.js')
    const result = await handler({}, { format: 'markdown', author: 'alice' }, undefined, testCtx)

    expect(result.content).toContain('No active knowledge found')
  })

  it('shows no superseded entries message when empty', async () => {
    const { getVersionsByStatus, getVersionStatusCounts } = await import('../../src/graph/queries.js')
    vi.mocked(getVersionsByStatus)
      .mockResolvedValueOnce([makeActiveVersion()])
      .mockResolvedValueOnce([])  // no superseded
    vi.mocked(getVersionStatusCounts).mockResolvedValue({ ACTIVE: 1 })

    const { handler } = await import('../../src/tools/export.js')
    const result = await handler({}, { format: 'markdown', author: 'alice' }, undefined, testCtx)

    expect(result.content).toContain('No superseded entries')
  })

  it('filters by topic when provided', async () => {
    const { getVersionsByStatus, getVersionStatusCounts } = await import('../../src/graph/queries.js')
    vi.mocked(getVersionsByStatus).mockResolvedValue([])
    vi.mocked(getVersionStatusCounts).mockResolvedValue({})

    const { handler } = await import('../../src/tools/export.js')
    const result = await handler({}, { topic: 'auth', format: 'markdown', author: 'alice' }, undefined, testCtx)

    expect(result.content).toContain('auth Domain')
  })

  it('includes stats in result', async () => {
    const { getVersionsByStatus, getVersionStatusCounts } = await import('../../src/graph/queries.js')
    vi.mocked(getVersionsByStatus).mockResolvedValue([])
    vi.mocked(getVersionStatusCounts).mockResolvedValue({ ACTIVE: 5, DRAFT: 2, SUPERSEDED: 3, DEPRECATED: 1 })

    const { handler } = await import('../../src/tools/export.js')
    const result = await handler({}, { format: 'markdown', author: 'alice' }, undefined, testCtx)

    expect(result.stats).toEqual({ ACTIVE: 5, DRAFT: 2, SUPERSEDED: 3, DEPRECATED: 1 })
  })
})

describe('export — confluence format', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns confluence wiki markup', async () => {
    const { getVersionsByStatus, getVersionStatusCounts } = await import('../../src/graph/queries.js')
    vi.mocked(getVersionsByStatus)
      .mockResolvedValueOnce([makeActiveVersion()])
      .mockResolvedValueOnce([makeSupersededVersion()])
    vi.mocked(getVersionStatusCounts).mockResolvedValue({ ACTIVE: 1 })

    const { handler } = await import('../../src/tools/export.js')
    const result = await handler({}, { format: 'confluence', author: 'alice' }, undefined, testCtx)

    expect(result.format).toBe('confluence')
    expect(result.content).toContain('h1.')
    expect(result.content).toContain('h2. Active Knowledge')
  })

  it('includes superseded table in confluence', async () => {
    const { getVersionsByStatus, getVersionStatusCounts } = await import('../../src/graph/queries.js')
    vi.mocked(getVersionsByStatus)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeSupersededVersion()])
    vi.mocked(getVersionStatusCounts).mockResolvedValue({})

    const { handler } = await import('../../src/tools/export.js')
    const result = await handler({}, { format: 'confluence', author: 'alice' }, undefined, testCtx)

    expect(result.content).toContain('|| Key ||')
  })
})

describe('export — Graphiti content enrichment', () => {
  afterEach(() => vi.clearAllMocks())

  it('fetches content from Graphiti when graphiti_episode_id is set', async () => {
    const { getVersionsByStatus, getVersionStatusCounts } = await import('../../src/graph/queries.js')
    const { searchNodes } = await import('../../src/graph/client.js')

    vi.mocked(getVersionsByStatus)
      .mockResolvedValueOnce([makeActiveVersion({ graphiti_episode_id: 'ep_001' })])
      .mockResolvedValueOnce([])
    vi.mocked(getVersionStatusCounts).mockResolvedValue({ ACTIVE: 1 })
    vi.mocked(searchNodes).mockResolvedValue({
      nodes: [{ summary: 'JWT content from Graphiti' }],
    })

    const { handler } = await import('../../src/tools/export.js')
    const result = await handler({}, { format: 'markdown', author: 'alice' }, undefined, testCtx)

    expect(searchNodes).toHaveBeenCalledOnce()
    expect(result.content).toContain('JWT content from Graphiti')
  })

  it('uses placeholder when Graphiti search fails', async () => {
    const { getVersionsByStatus, getVersionStatusCounts } = await import('../../src/graph/queries.js')
    const { searchNodes } = await import('../../src/graph/client.js')

    vi.mocked(getVersionsByStatus)
      .mockResolvedValueOnce([makeActiveVersion({ graphiti_episode_id: 'ep_001', content: undefined })])
      .mockResolvedValueOnce([])
    vi.mocked(getVersionStatusCounts).mockResolvedValue({ ACTIVE: 1 })
    vi.mocked(searchNodes).mockRejectedValue(new Error('Graphiti down'))

    const { handler } = await import('../../src/tools/export.js')
    const result = await handler({}, { format: 'markdown', author: 'alice' }, undefined, testCtx)

    expect(result.content).toContain('[Content stored in graph')
  })
})
