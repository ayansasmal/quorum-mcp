/**
 * Extended branch coverage for src/tools/search.js
 *
 * Covers branches not hit by search.test.js:
 *  - Domain filter (input.domain → filtered.filter)
 *  - includeGlobal = false when projectId === 'global'
 *  - Status exclusion (DRAFT/DEPRECATED/REJECTED filtered out)
 *  - Deduplication by uuid across project + global
 *  - Sort tiebreaker (project vs global, equal score)
 *  - fallback.results empty → no fallback return
 *  - Facts relation filtering
 *  - Missing ctx.projectId throws
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/graph/client.js', () => ({
  searchNodes: vi.fn(),
  searchFacts: vi.fn(),
  normalizeGroupId: vi.fn((id) => (typeof id === 'string' ? id.replace(/-/g, '_') : id)),
}))

vi.mock('../../src/config/loader.js', () => {
  const getConfig = vi.fn(() => ({ globals: [] }))
  const resolveGlobals = vi.fn(async (pg) => {
    if (typeof pg?.getConfig === 'function') {
      try {
        const config = await pg.getConfig()
        if (config) return config.globals ?? []
      } catch { /* fall through to local config */ }
    }
    try { return getConfig()?.globals ?? [] } catch { return [] }
  })
  return { getConfig, resolveGlobals }
})

vi.mock('../../src/audit/pipeline.js', () => ({
  withAuditPipeline: vi.fn(async (_pg, _ctx, operation) => operation()),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

const testCtx = { projectId: 'test-project', gatewayUrl: 'http://localhost:3001' }
const globalCtx = { projectId: 'global', gatewayUrl: 'http://localhost:3001' }

function makePg(overrides = {}) {
  return {
    query: vi.fn(() => { throw new Error('should not call query()') }),
    searchByText: vi.fn().mockResolvedValue({ results: [], total: 0, source: 'pg' }),
    ...overrides,
  }
}

function makeNode(overrides = {}) {
  return {
    uuid: 'node-1',
    name: 'auth:token-strategy',
    summary: 'Use JWT for Lambda',
    score: 0.9,
    group_id: 'test_project', // normalized form of testCtx.projectId ('test-project') — project-local by default
    metadata: { author: 'alice', confidence: 0.85, status: 'ACTIVE', domain: 'auth' },
    ...overrides,
  }
}

beforeEach(() => vi.clearAllMocks())

// ── domain filter ─────────────────────────────────────────────────────────────

describe('search — domain filter', () => {
  it('filters results by domain when input.domain is set', async () => {
    const { searchNodes, searchFacts } = await import('../../src/graph/client.js')

    // Two nodes: one in auth domain, one in db domain
    vi.mocked(searchNodes).mockResolvedValue({
      nodes: [
        makeNode({ uuid: 'n1', name: 'auth:token-strategy', metadata: { domain: 'auth', status: 'ACTIVE' } }),
        makeNode({ uuid: 'n2', name: 'db:pool-size', metadata: { domain: 'db', status: 'ACTIVE' } }),
      ],
    })
    vi.mocked(searchFacts).mockResolvedValue({ facts: [] })

    const { handler } = await import('../../src/tools/search.js')
    const result = await handler(makePg(), { query: 'auth', domain: 'auth', author: 'alice' }, undefined, testCtx)

    // Only auth domain results should be included
    expect(result.results.every((r) => r.topic_key.startsWith('auth:'))).toBe(true)
    expect(result.results.find((r) => r.topic_key === 'db:pool-size')).toBeUndefined()
  })

  it('includes nodes matched by name prefix when domain filter set', async () => {
    const { searchNodes, searchFacts } = await import('../../src/graph/client.js')

    // Node with no metadata.domain but name starts with 'auth:'
    vi.mocked(searchNodes).mockResolvedValue({
      nodes: [
        makeNode({ uuid: 'n1', name: 'auth:token', metadata: { status: 'ACTIVE' } }), // no domain in metadata
      ],
    })
    vi.mocked(searchFacts).mockResolvedValue({ facts: [] })

    const { handler } = await import('../../src/tools/search.js')
    const result = await handler(makePg(), { query: 'auth', domain: 'auth', author: 'alice' }, undefined, testCtx)

    expect(result.results).toHaveLength(1)
    expect(result.results[0].topic_key).toBe('auth:token')
  })
})

// ── status exclusion ─────────────────────────────────────────────────────────

describe('search — status exclusion', () => {
  it('excludes DRAFT nodes from results', async () => {
    const { searchNodes, searchFacts } = await import('../../src/graph/client.js')

    vi.mocked(searchNodes).mockResolvedValue({
      nodes: [
        makeNode({ uuid: 'n1', metadata: { status: 'DRAFT' } }),
        makeNode({ uuid: 'n2', name: 'auth:other', metadata: { status: 'ACTIVE' } }),
      ],
    })
    vi.mocked(searchFacts).mockResolvedValue({ facts: [] })

    const { handler } = await import('../../src/tools/search.js')
    const result = await handler(makePg(), { query: 'auth', author: 'alice' }, undefined, testCtx)

    expect(result.results).toHaveLength(1)
    expect(result.results[0].status).toBe('ACTIVE')
  })

  it('excludes DEPRECATED nodes from results', async () => {
    const { searchNodes, searchFacts } = await import('../../src/graph/client.js')

    vi.mocked(searchNodes).mockResolvedValue({
      nodes: [makeNode({ uuid: 'n1', metadata: { status: 'DEPRECATED' } })],
    })
    vi.mocked(searchFacts).mockResolvedValue({ facts: [] })

    const { handler } = await import('../../src/tools/search.js')
    const result = await handler(makePg(), { query: 'auth', author: 'alice' }, undefined, testCtx)

    expect(result.results).toHaveLength(0)
  })

  it('excludes REJECTED nodes from results', async () => {
    const { searchNodes, searchFacts } = await import('../../src/graph/client.js')

    vi.mocked(searchNodes).mockResolvedValue({
      nodes: [makeNode({ uuid: 'n1', metadata: { status: 'REJECTED' } })],
    })
    vi.mocked(searchFacts).mockResolvedValue({ facts: [] })

    const { handler } = await import('../../src/tools/search.js')
    const result = await handler(makePg(), { query: 'auth', author: 'alice' }, undefined, testCtx)

    expect(result.results).toHaveLength(0)
  })
})

// ── global search ─────────────────────────────────────────────────────────────

describe('search — global project context', () => {
  it('does not include global search when projectId is global', async () => {
    const { searchNodes, searchFacts } = await import('../../src/graph/client.js')

    // searchNodes is called only once (for the project, no separate global call)
    vi.mocked(searchNodes).mockResolvedValue({ nodes: [makeNode()] })
    vi.mocked(searchFacts).mockResolvedValue({ facts: [] })

    const { handler } = await import('../../src/tools/search.js')
    const result = await handler(makePg(), { query: 'auth', author: 'alice' }, undefined, globalCtx)

    // For global context, searchNodes is called once (the global search is skipped)
    // The Promise.resolve({ nodes: [] }) is used for the global slot
    expect(result.results).toHaveLength(1)
    expect(searchNodes).toHaveBeenCalledTimes(1)
  })
})

// ── deduplication ─────────────────────────────────────────────────────────────

describe('search — deduplication', () => {
  it('deduplicates nodes with same uuid within project results', async () => {
    const { searchNodes, searchFacts } = await import('../../src/graph/client.js')

    // Graphiti may return the same node twice (different traversal paths).
    // The dedup-by-uuid logic should keep only the first occurrence.
    vi.mocked(searchNodes).mockResolvedValue({
      nodes: [
        makeNode({ uuid: 'shared-id' }),
        makeNode({ uuid: 'shared-id', score: 0.8 }),  // duplicate — lower score, should be dropped
      ],
    })
    vi.mocked(searchFacts).mockResolvedValue({ facts: [] })

    const { handler } = await import('../../src/tools/search.js')
    const result = await handler(makePg(), { query: 'auth', author: 'alice' }, undefined, testCtx)

    // Only one result — the duplicate UUID should be filtered out
    expect(result.results).toHaveLength(1)
  })
})

// ── facts association ─────────────────────────────────────────────────────────

describe('search — facts in results', () => {
  it('includes related facts for a node in the result', async () => {
    const { searchNodes, searchFacts } = await import('../../src/graph/client.js')

    vi.mocked(searchNodes).mockResolvedValue({
      nodes: [makeNode({ uuid: 'n1' })],
    })
    vi.mocked(searchFacts).mockResolvedValue({
      facts: [
        { fact: 'JWT is stateless', source_node_uuid: 'n1', target_node_uuid: 'n2' },
        { fact: 'Sessions need Redis', source_node_uuid: 'n2', target_node_uuid: 'n1' },
        { fact: 'Unrelated fact', source_node_uuid: 'n3', target_node_uuid: 'n4' },
      ],
    })

    const { handler } = await import('../../src/tools/search.js')
    const result = await handler(makePg(), { query: 'auth', author: 'alice' }, undefined, testCtx)

    expect(result.results[0].related_facts).toHaveLength(2)
    expect(result.results[0].related_facts).toContain('JWT is stateless')
    expect(result.results[0].related_facts).toContain('Sessions need Redis')
  })
})

// ── fallback: empty results from searchByText ─────────────────────────────────

describe('search — ILIKE fallback returns empty results', () => {
  it('returns empty results when fallback also returns empty array', async () => {
    const { searchNodes, searchFacts } = await import('../../src/graph/client.js')

    vi.mocked(searchNodes).mockResolvedValue({ nodes: [] })
    vi.mocked(searchFacts).mockResolvedValue({ facts: [] })

    const pg = makePg({
      searchByText: vi.fn().mockResolvedValue({ results: [], total: 0, source: 'pg' }),
    })

    const { handler } = await import('../../src/tools/search.js')
    const result = await handler(pg, { query: 'nonexistent', author: 'alice' }, undefined, testCtx)

    // Fallback was called but returned empty — should return empty results
    expect(pg.searchByText).toHaveBeenCalled()
    expect(result.results).toEqual([])
    expect(result.total).toBe(0)
  })
})

// ── missing projectId ─────────────────────────────────────────────────────────

describe('search — missing projectId', () => {
  it('throws when ctx.projectId is not set', async () => {
    const { handler } = await import('../../src/tools/search.js')
    await expect(
      handler(makePg(), { query: 'auth', author: 'alice' }, undefined, { gatewayUrl: 'http://localhost:3001' })
    ).rejects.toThrow('ctx.projectId is required')
  })
})

// ── Promise.allSettled rejection handling ─────────────────────────────────────

describe('search — Graphiti rejection handling', () => {
  it('handles rejected searchNodes promise gracefully', async () => {
    const { searchNodes, searchFacts } = await import('../../src/graph/client.js')

    // searchNodes rejects (Graphiti down), searchFacts succeeds
    vi.mocked(searchNodes).mockRejectedValue(new Error('FalkorDB connection refused'))
    vi.mocked(searchFacts).mockResolvedValue({ facts: [] })

    const pg = makePg({
      searchByText: vi.fn().mockResolvedValue({
        results: [{ topic: 'auth', key: 'token', summary: 'Use JWT', status: 'ACTIVE', confidence: 0.8, author: 'alice' }],
        total: 1,
        source: 'pg',
      }),
    })

    const { handler } = await import('../../src/tools/search.js')
    // Should not throw — Promise.allSettled handles rejection
    const result = await handler(pg, { query: 'auth', author: 'alice' }, undefined, testCtx)

    // Falls back to postgres since Graphiti returned no nodes
    expect(result.results).toHaveLength(1)
  })
})

// ── catalog_id annotation (Wave B) ────────────────────────────────────────────

describe('search — catalog_id annotation', () => {
  it('annotates project-local results with source=project and catalog_id=null', async () => {
    const { searchNodes, searchFacts } = await import('../../src/graph/client.js')
    const { getConfig } = await import('../../src/config/loader.js')

    vi.mocked(getConfig).mockReturnValue({ globals: [] })
    vi.mocked(searchNodes).mockResolvedValue({ nodes: [makeNode({ uuid: 'n1' })] })
    vi.mocked(searchFacts).mockResolvedValue({ facts: [] })

    const { handler } = await import('../../src/tools/search.js')
    const result = await handler(makePg(), { query: 'auth', author: 'alice' }, undefined, testCtx)

    expect(result.results[0].source).toBe('project')
    expect(result.results[0].catalog_id).toBeNull()
  })

  it('annotates global catalog results with source=global and catalog_id=group_id', async () => {
    const { searchNodes, searchFacts } = await import('../../src/graph/client.js')

    // Single combined call returns a node whose group_id belongs to a linked
    // catalog, not the project — attribution is derived from that field.
    vi.mocked(searchNodes).mockResolvedValue({
      nodes: [makeNode({ uuid: 'global-n1', name: 'security:tls', group_id: 'security_standards' })],
    })
    vi.mocked(searchFacts).mockResolvedValue({ facts: [] })

    const { handler } = await import('../../src/tools/search.js')
    const result = await handler(makePg(), { query: 'tls', author: 'alice' }, undefined, testCtx)

    expect(result.results[0].source).toBe('global')
    expect(result.results[0].catalog_id).toBe('security_standards')
  })

  it('project wins deduplication over global when same uuid appears in both', async () => {
    const { searchNodes, searchFacts } = await import('../../src/graph/client.js')

    // One combined call returns both a project-local and a global node sharing
    // the same uuid (e.g. re-attributed episode) — project must win the tie.
    vi.mocked(searchNodes).mockResolvedValue({
      nodes: [
        makeNode({ uuid: 'shared-id', group_id: 'test_project' }),
        makeNode({ uuid: 'shared-id', group_id: 'security_standards', score: 0.95 }),
      ],
    })
    vi.mocked(searchFacts).mockResolvedValue({ facts: [] })

    const { handler } = await import('../../src/tools/search.js')
    const result = await handler(makePg(), { query: 'auth', author: 'alice' }, undefined, testCtx)

    // Only one result; the project version wins (project is listed first)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].source).toBe('project')
    expect(result.results[0].catalog_id).toBeNull()
  })
})
