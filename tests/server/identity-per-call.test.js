/**
 * Gap 5 — MCP identity (role) staleness fix.
 *
 * Verifies that identity is resolved fresh on every tool invocation rather
 * than captured once at startup. Without this fix, role changes in DDB/Redis
 * (propagated via the gateway profile cache) are NOT reflected in the
 * MCP-side identity for the lifetime of the MCP process.
 *
 * Tests:
 *   1. Live identity — gateway getIdentity() is called on every tool
 *      invocation and the returned identity is passed to the handler.
 *   2. Fallback — when the gateway client's getIdentity() throws,
 *      resolveIdentity() is used instead.
 *   3. No auth-gate bypass — per-call identity resolution does not run
 *      before isAuthenticated(); gated tools still short-circuit with
 *      not_authenticated.
 *
 * vi.mock factories are hoisted above all module-level identifiers, so any
 * outer-scope state they need is stashed on globalThis.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (factories are self-contained / read from globalThis) ───────────────

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class FakeMcpServer {
    constructor() {
      this.server = { listRoots: async () => ({ roots: [] }) }
    }
    tool(name, _schema, handler) {
      ;(globalThis.__registeredHandlers ??= new Map()).set(name, handler)
    }
    async connect() {}
  },
}))

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class { },
}))

vi.mock('node:http', () => ({
  createServer: () => ({ listen: () => {} }),
}))

vi.mock('../../src/audit/chain.js', () => ({
  verifyChain: () => ({ entries: 0 }),
  ChainIntegrityViolation: class extends Error {},
}))

vi.mock('../../src/audit/secondary.js', () => ({
  getAllEntries: async () => [],
  countEntries:  async () => 0,
}))

vi.mock('../../src/governance/constitutional.js', () => ({
  validateManifestHasNoDeleteTools: () => {},
}))

vi.mock('../../src/graph/client.js', () => ({
  ping: async () => true,
}))

vi.mock('../../src/config/loader.js', () => ({
  loadConfig:        async () => ({ project: 'test', members: [] }),
  stopConfigPoller:  () => {},
  getConfig:         () => ({ domains: {}, members: [], roles: {} }),
}))

vi.mock('../../src/identity/resolver.js', () => ({
  resolveIdentity:      async (...args) => globalThis.__resolveIdentitySpy(...args),
  clearIdentityCache:   () => {},
  applyConfidenceFloor: (c) => c,
}))

vi.mock('../../src/gateway/client.js', () => ({
  getGatewayClient: () => globalThis.__fakeGatewayClient,
  isAuthenticated:  () => globalThis.__isAuthenticated(),
  setGatewayToken:  () => {},
}))

vi.mock('../../src/quorum-file.js', () => ({
  findAndLoadQuorumFile: () => ({
    project_id:  'test_project',
    gateway_url: 'http://localhost:3001',
  }),
}))

vi.mock('../../src/logger.js', () => ({
  log: {
    startCall: () => {}, endCall: () => {},
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    path: '/tmp/quorum.log',
  },
}))

// Every tool stub records the identity it was invoked with.
const recordHandler = () => ({
  schema: { shape: {} },
  handler: async (_p, _i, identity) => {
    ;(globalThis.__handlerCalls ??= []).push({ identity })
    return { identity }
  },
})
vi.mock('../../src/tools/set-agent-context.js', () => ({
  schema: { shape: {} },
  handler: async () => ({ status: 'context_set' }),
  getAgentCtx: () => ({ agent_id: 'test-agent', session_id: 'sess_00000000', author_type: 'agent' }),
}))
vi.mock('../../src/tools/authenticate.js',  () => ({ schema: { shape: {} }, handler: async (_p, _i, identity) => { (globalThis.__handlerCalls ??= []).push({ identity }); return { identity } } }))
vi.mock('../../src/tools/config-upload.js', () => ({ schema: { shape: {} }, handler: async (_p, _i, identity) => { (globalThis.__handlerCalls ??= []).push({ identity }); return { identity } } }))
vi.mock('../../src/tools/search.js',        () => ({ schema: { shape: {} }, handler: async (_p, _i, identity) => { (globalThis.__handlerCalls ??= []).push({ identity }); return { identity } } }))
vi.mock('../../src/tools/remember.js',      () => ({ schema: { shape: {} }, handler: async (_p, _i, identity) => { (globalThis.__handlerCalls ??= []).push({ identity }); return { identity } } }))
vi.mock('../../src/tools/recall.js',        () => ({ schema: { shape: {} }, handler: async (_p, _i, identity) => { (globalThis.__handlerCalls ??= []).push({ identity }); return { identity } } }))
vi.mock('../../src/tools/forget.js',        () => ({ schema: { shape: {} }, handler: async (_p, _i, identity) => { (globalThis.__handlerCalls ??= []).push({ identity }); return { identity } } }))
vi.mock('../../src/tools/history.js',       () => ({ schema: { shape: {} }, handler: async (_p, _i, identity) => { (globalThis.__handlerCalls ??= []).push({ identity }); return { identity } } }))
vi.mock('../../src/tools/review.js',        () => ({ schema: { shape: {} }, handler: async (_p, _i, identity) => { (globalThis.__handlerCalls ??= []).push({ identity }); return { identity } } }))
vi.mock('../../src/tools/reflect.js',       () => ({ schema: { shape: {} }, handler: async (_p, _i, identity) => { (globalThis.__handlerCalls ??= []).push({ identity }); return { identity } } }))
vi.mock('../../src/tools/export.js',        () => ({ schema: { shape: {} }, handler: async (_p, _i, identity) => { (globalThis.__handlerCalls ??= []).push({ identity }); return { identity } } }))
vi.mock('../../src/tools/pending.js',       () => ({ schema: { shape: {} }, handler: async (_p, _i, identity) => { (globalThis.__handlerCalls ??= []).push({ identity }); return { identity } } }))
void recordHandler // referenced for future reuse — keeps the helper declared

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import { registerTools } from '../../src/server.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

async function invokeTool(name, input = {}) {
  const handler = globalThis.__registeredHandlers.get(name)
  if (!handler) throw new Error(`tool not registered: ${name}`)
  return handler(input)
}

function parseEnvelope(envelope) {
  return JSON.parse(envelope.content[0].text)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('server: identity resolved per tool call (Gap 5)', () => {
  beforeEach(() => {
    globalThis.__registeredHandlers = new Map()
    globalThis.__handlerCalls       = []

    globalThis.__resolveIdentitySpy = vi.fn(async () => ({
      name: 'fallback-user',
      role: 'engineer',
      team: null,
      base_confidence: 0.5,
      method: 'git_email',
    }))

    const getIdentitySpy = vi.fn()
    globalThis.__getIdentitySpy = getIdentitySpy
    globalThis.__fakeGatewayClient = {
      getIdentity:   (...args) => getIdentitySpy(...args),
      countEntries:  async () => 0,
      getAllEntries: async () => [],
      setProjectId:  () => {},
      ping:          async () => true,
    }

    globalThis.__isAuthenticated = () => true
    process.env.QUORUM_GATEWAY_URL = 'http://localhost:3001'

    registerTools()
  })

  it('calls getGatewayClient().getIdentity() on every tool invocation (not cached at registration)', async () => {
    globalThis.__getIdentitySpy.mockResolvedValueOnce({
      name: 'alice', role: 'engineer', team: null,
      base_confidence: 0.7, method: 'oauth2_gateway',
    })
    const r1 = parseEnvelope(await invokeTool('remember', { topic: 'x', key: 'y', content: 'z' }))

    // Role bumped to principal_architect in DDB/Redis between calls.
    globalThis.__getIdentitySpy.mockResolvedValueOnce({
      name: 'alice', role: 'principal_architect', team: null,
      base_confidence: 0.95, method: 'oauth2_gateway',
    })
    const r2 = parseEnvelope(await invokeTool('remember', { topic: 'x', key: 'y', content: 'z' }))

    expect(globalThis.__getIdentitySpy).toHaveBeenCalledTimes(2)
    expect(r1.identity.role).toBe('engineer')
    expect(r2.identity.role).toBe('principal_architect')
  })

  it('falls back to resolveIdentity() when gateway getIdentity() throws', async () => {
    globalThis.__getIdentitySpy.mockRejectedValueOnce(new Error('gateway down'))

    const result = parseEnvelope(await invokeTool('remember', { topic: 'x', key: 'y', content: 'z' }))

    expect(globalThis.__getIdentitySpy).toHaveBeenCalledTimes(1)
    expect(globalThis.__resolveIdentitySpy).toHaveBeenCalledTimes(1)
    expect(result.identity.name).toBe('fallback-user')
    expect(result.identity.method).toBe('git_email')
  })

  it('does not bypass the isAuthenticated() gate — gated tools short-circuit with not_authenticated', async () => {
    globalThis.__isAuthenticated = () => false

    const envelope = await invokeTool('remember', { topic: 'x', key: 'y', content: 'z' })

    expect(envelope.isError).toBe(true)
    const body = parseEnvelope(envelope)
    expect(body.error).toBe('not_authenticated')
    expect(globalThis.__handlerCalls.length).toBe(0)
    expect(globalThis.__getIdentitySpy).not.toHaveBeenCalled()
  })

  it('authenticate tool is exempt from the not_authenticated gate', async () => {
    globalThis.__isAuthenticated = () => false
    globalThis.__getIdentitySpy.mockResolvedValueOnce({
      name: 'alice', role: 'engineer', team: null,
      base_confidence: 0.7, method: 'oauth2_gateway',
    })

    const envelope = await invokeTool('authenticate', {})

    expect(envelope.isError).not.toBe(true)
    expect(globalThis.__handlerCalls.length).toBe(1)
  })
})
