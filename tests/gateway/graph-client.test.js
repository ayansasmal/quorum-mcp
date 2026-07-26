/**
 * Graphiti client — group_ids project scoping for searchNodes and searchFacts.
 *
 * Previously, both functions intentionally omitted group_ids because hyphens
 * in project IDs broke FalkorDB/RediSearch. That root cause is now fixed:
 * project IDs are normalised to underscores at both the MCP resolveCtx() and
 * the gateway Graphiti proxy. group_ids may therefore be passed through safely
 * to restore project isolation for semantic search.
 *
 * These tests stub fetch and inspect the payload posted to Graphiti's MCP
 * endpoint to confirm group_ids is forwarded when (and only when) a groupId
 * option is supplied by the caller.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { log } from '../../src/logger.js'
import { searchNodes, searchFacts, addEpisode, addSupersedingEpisode } from '../../src/graph/client.js'
import { getGatewayClient, setGatewayToken } from '../../src/gateway/client.js'

/** Build an unsigned-looking JWT with the given payload (no signature verification client-side). */
function fakeJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ alg: 'ES256' })}.${b64(payload)}.fake-signature`
}

/**
 * Stub fetch for a single, stateless `tools/call` POST and capture the
 * arguments forwarded to a Graphiti tool call.
 *
 * Graphiti's MCP server runs with `stateless_http=True`: every call is one
 * self-contained POST with method="tools/call" — no initialize handshake,
 * no Mcp-Session-Id header.
 *
 * @returns {{ getToolArgs: () => object | null, getToolCallHeaders: () => object | null, getAllCalls: () => Array<{ headers: object, body: object }> }}
 */
function stubGraphitiFetch() {
  let toolArgs = null
  let toolCallHeaders = null
  const calls = []

  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, opts) => {
    const body = JSON.parse(opts.body)
    calls.push({ headers: opts.headers ?? {}, body })
    if (body.method === 'tools/call') {
      toolArgs = body.params?.arguments ?? null
      toolCallHeaders = opts.headers ?? null
    }
    return {
      ok:      true,
      status:  200,
      headers: {
        get: () => null,
      },
      text: async () => JSON.stringify({
        jsonrpc: '2.0',
        id:      body.id,
        result:  { structuredContent: { result: { nodes: [], facts: [] } } },
      }),
    }
  }))

  return { getToolArgs: () => toolArgs, getToolCallHeaders: () => toolCallHeaders, getAllCalls: () => calls }
}

beforeEach(() => {
  delete process.env.QUORUM_GATEWAY_URL
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('searchNodes — group_ids scoping', () => {
  it('sends group_ids when groupId option is provided', async () => {
    const { getToolArgs } = stubGraphitiFetch()

    await searchNodes('auth patterns', { groupId: 'amethyst_munchkin' })

    const args = getToolArgs()
    expect(args).not.toBeNull()
    expect(args.group_ids).toEqual(['amethyst_munchkin'])
    expect(args.query).toBe('auth patterns')
  })

  it('omits group_ids when no groupId option is given', async () => {
    const { getToolArgs } = stubGraphitiFetch()

    await searchNodes('auth patterns', {})

    const args = getToolArgs()
    expect(args).not.toBeNull()
    expect(args.group_ids).toBeUndefined()
  })

  it('normalises groupId from groupIds array', async () => {
    const { getToolArgs } = stubGraphitiFetch()

    await searchNodes('query', { groupIds: ['amethyst_munchkin'] })

    const args = getToolArgs()
    expect(args.group_ids).toEqual(['amethyst_munchkin'])
  })
})

describe('searchFacts — group_ids scoping', () => {
  it('sends group_ids when groupId option is provided', async () => {
    const { getToolArgs } = stubGraphitiFetch()

    await searchFacts('auth patterns', { groupId: 'amethyst_munchkin' })

    const args = getToolArgs()
    expect(args).not.toBeNull()
    expect(args.group_ids).toEqual(['amethyst_munchkin'])
    expect(args.query).toBe('auth patterns')
  })

  it('omits group_ids when no groupId option is given', async () => {
    const { getToolArgs } = stubGraphitiFetch()

    await searchFacts('auth patterns', {})

    const args = getToolArgs()
    expect(args).not.toBeNull()
    expect(args.group_ids).toBeUndefined()
  })

  it('normalises groupId from groupIds array', async () => {
    const { getToolArgs } = stubGraphitiFetch()

    await searchFacts('query', { groupIds: ['amethyst_munchkin'] })

    const args = getToolArgs()
    expect(args.group_ids).toEqual(['amethyst_munchkin'])
  })
})

describe('addEpisode — database override', () => {
  it('sends database in the add_memory payload when provided', async () => {
    const { getToolArgs } = stubGraphitiFetch()

    await addEpisode('use jwt', { key: 'auth:jwt', source: 'test' }, 'amethyst-munchkin', 'quorum_shared_globals')

    const args = getToolArgs()
    expect(args).not.toBeNull()
    expect(args.database).toBe('quorum_shared_globals')
    expect(args.group_id).toBe('amethyst_munchkin')
  })

  it('omits database when not provided', async () => {
    const { getToolArgs } = stubGraphitiFetch()

    await addEpisode('use jwt', { key: 'auth:jwt', source: 'test' }, 'amethyst-munchkin')

    const args = getToolArgs()
    expect(args).not.toBeNull()
    expect(args.database).toBeUndefined()
  })
})

describe('addSupersedingEpisode — database override', () => {
  it('sends database in the add_memory payload when provided', async () => {
    const { getToolArgs } = stubGraphitiFetch()

    await addSupersedingEpisode(
      'use jwt v2',
      'old-episode-id',
      { key: 'auth:jwt', source: 'test', reason: 'updated' },
      'amethyst-munchkin',
      'quorum_shared_globals',
    )

    const args = getToolArgs()
    expect(args).not.toBeNull()
    expect(args.database).toBe('quorum_shared_globals')
  })

  it('omits database when not provided', async () => {
    const { getToolArgs } = stubGraphitiFetch()

    await addSupersedingEpisode(
      'use jwt v2',
      'old-episode-id',
      { key: 'auth:jwt', source: 'test', reason: 'updated' },
      'amethyst-munchkin',
    )

    const args = getToolArgs()
    expect(args).not.toBeNull()
    expect(args.database).toBeUndefined()
  })
})

describe('callGraphiti — X-Quorum-Project header (gateway mode)', () => {
  const gatewayUrl = 'http://fake-gateway'

  beforeEach(() => {
    process.env.QUORUM_GATEWAY_URL = gatewayUrl
    setGatewayToken(fakeJwt({ sub: 'test-user', is_admin: false, exp: Math.floor(Date.now() / 1000) + 3600 }))
    getGatewayClient(gatewayUrl).setProjectId('busy-hopper')
  })

  afterEach(() => {
    delete process.env.QUORUM_GATEWAY_URL
    setGatewayToken(null)
  })

  it('forwards X-Quorum-Trace-Id on the tool call request when present', async () => {
    const { getToolCallHeaders } = stubGraphitiFetch()
    const start = log.startCall('search')

    await searchNodes('query', { groupId: 'security-knowledge' })

    const headers = getToolCallHeaders()
    expect(headers['X-Quorum-Trace-Id']).toBe(start.traceId)
    const fetchCalls = vi.mocked(fetch).mock.calls
    expect(fetchCalls[0][1].headers['X-Quorum-Trace-Id']).toBe(start.traceId)

    start.end()
  })

  it('derives X-Quorum-Project from the gateway client project id, not the search call group_id(s)', async () => {
    const { getToolCallHeaders } = stubGraphitiFetch()

    // groupId here is a catalog id, deliberately different from the project id —
    // proves the header comes from GatewayClient.getProjectId(), not the payload.
    await searchNodes('query', { groupId: 'security-knowledge' })

    const headers = getToolCallHeaders()
    expect(headers).not.toBeNull()
    expect(headers['X-Quorum-Project']).toBe('busy-hopper')
  })

  it('still sends the caller-supplied group_ids in the payload alongside the header', async () => {
    const { getToolArgs, getToolCallHeaders } = stubGraphitiFetch()

    await searchFacts('query', { groupId: 'security-knowledge' })

    expect(getToolArgs().group_ids).toEqual(['security_knowledge'])
    expect(getToolCallHeaders()['X-Quorum-Project']).toBe('busy-hopper')
  })

  it('does not send X-Quorum-Trace-Id when no active tool-call trace exists', async () => {
    const { getToolCallHeaders } = stubGraphitiFetch()

    await searchFacts('query', { groupId: 'security-knowledge' })

    const headers = getToolCallHeaders()
    expect(headers['X-Quorum-Trace-Id']).toBeUndefined()
    const fetchCalls = vi.mocked(fetch).mock.calls
    expect(fetchCalls[0][1].headers['X-Quorum-Trace-Id']).toBeUndefined()
  })
})

describe('callGraphiti — stateless concurrency', () => {
  // Regression test for quorum/docs/RCA-search-concurrency-session-stall-2026-07-27.md:
  // concurrent calls used to share one cached Mcp-Session-Id with no locking, so one
  // caller could get no response until its own timeout fired. Each call is now a fully
  // independent request — no session to race on.
  it('fires one independent request per concurrent call, none carrying a session header', async () => {
    const { getAllCalls } = stubGraphitiFetch()

    const CONCURRENCY = 5
    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        searchNodes(`query-${i}`, { groupId: 'amethyst_munchkin' })),
    )

    const calls = getAllCalls()
    expect(calls).toHaveLength(CONCURRENCY)

    const queries = calls.map((c) => c.body.params?.arguments?.query).sort()
    expect(queries).toEqual(Array.from({ length: CONCURRENCY }, (_, i) => `query-${i}`).sort())

    for (const call of calls) {
      const headerNames = Object.keys(call.headers).map((h) => h.toLowerCase())
      expect(headerNames).not.toContain('mcp-session-id')
    }
  })
})
