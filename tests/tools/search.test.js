/**
 * Tool: search()
 *
 * Verifies the Graphiti-empty → PostgreSQL ILIKE fallback path. The fallback
 * goes through the typed gateway client `searchByText()` (not raw pg.query —
 * GatewayClient.query() always throws).
 *
 * Cases:
 *   1. Graphiti returns empty → searchByText() is invoked with query/domain/limit
 *   2. Fallback rows are mapped to the expected result shape (source: 'postgres-fallback')
 *   3. searchByText() throwing degrades gracefully → empty results, no crash
 *   4. Graphiti returns results → fallback is NOT invoked
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/graph/client.js', () => ({
  searchNodes: vi.fn(),
  searchFacts: vi.fn(),
  normalizeGroupId: vi.fn((id) => (typeof id === 'string' ? id.replace(/-/g, '_') : id)),
}))

vi.mock('../../src/audit/pipeline.js', () => ({
  withAuditPipeline: vi.fn(async (_pg, _ctx, operation) => operation()),
}))

const testCtx = { projectId: 'test-project', gatewayUrl: 'http://localhost:3001' }

// pg argument: a fake GatewayClient with searchByText() spy.
function makePg(overrides = {}) {
  return {
    query: vi.fn(() => { throw new Error('GatewayClient.query — should not be called') }),
    searchByText: vi.fn().mockResolvedValue({ results: [], total: 0, source: 'postgres-ilike' }),
    ...overrides,
  }
}

beforeEach(() => vi.clearAllMocks())

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('search — ILIKE fallback via gateway searchByText()', () => {
  it('calls searchByText() with query/domain/limit when Graphiti returns 0 results', async () => {
    const { searchNodes, searchFacts } = await import('../../src/graph/client.js')
    vi.mocked(searchNodes).mockResolvedValue({ nodes: [] })
    vi.mocked(searchFacts).mockResolvedValue({ facts: [] })

    const pg = makePg({
      searchByText: vi.fn().mockResolvedValue({
        results: [
          { topic: 'auth', key: 'token-strategy', summary: 'use JWT', status: 'ACTIVE', confidence: 0.9, author: 'alice' },
        ],
        total: 1,
        source: 'postgres-ilike',
      }),
    })

    const { handler } = await import('../../src/tools/search.js')
    const result = await handler(pg, { query: 'auth', domain: 'api', limit: 7, author: 'alice' }, undefined, testCtx)

    expect(pg.searchByText).toHaveBeenCalledWith('auth', { domain: 'api', limit: 7 })
    expect(result.fallback).toBe('postgres')
    expect(result.results).toHaveLength(1)
    expect(result.results[0].source).toBe('postgres-fallback')
    expect(result.results[0].topic_key).toBe('auth:token-strategy')
    expect(result.results[0].confidence).toBe(0.9)
    expect(result.results[0].related_facts).toEqual([])
    expect(pg.query).not.toHaveBeenCalled()
  })

  it('returns empty results when searchByText() throws (graceful degradation)', async () => {
    const { searchNodes, searchFacts } = await import('../../src/graph/client.js')
    vi.mocked(searchNodes).mockResolvedValue({ nodes: [] })
    vi.mocked(searchFacts).mockResolvedValue({ facts: [] })

    const pg = makePg({
      searchByText: vi.fn().mockRejectedValue(new Error('gateway unreachable')),
    })

    const { handler } = await import('../../src/tools/search.js')
    const result = await handler(pg, { query: 'auth', author: 'alice' }, undefined, testCtx)

    expect(pg.searchByText).toHaveBeenCalled()
    expect(result.results).toEqual([])
    expect(result.total).toBe(0)
  })

  it('does NOT call searchByText() when Graphiti returns results', async () => {
    const { searchNodes, searchFacts } = await import('../../src/graph/client.js')
    vi.mocked(searchNodes).mockResolvedValue({
      nodes: [
        { uuid: 'u1', name: 'auth:token-strategy', summary: 'use JWT', score: 0.9, metadata: { author: 'alice', confidence: 0.9, status: 'ACTIVE' } },
      ],
    })
    vi.mocked(searchFacts).mockResolvedValue({ facts: [] })

    const pg = makePg()

    const { handler } = await import('../../src/tools/search.js')
    const result = await handler(pg, { query: 'auth', author: 'alice' }, undefined, testCtx)

    expect(pg.searchByText).not.toHaveBeenCalled()
    expect(result.results.length).toBeGreaterThan(0)
  })
})
