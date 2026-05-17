/**
 * Tests for src/tools/authenticate.js
 *
 * The handler runs an OAuth 2.1 PKCE flow. We mock:
 *   - fetch (for discoverMetadata, registerClient, exchangeCode)
 *   - node:http (createServer / listen / callback)
 *   - node:child_process (spawnSync — browser launcher)
 *   - gateway/client.js (isAuthenticated, getGatewayClient, setGatewayToken, setGatewayProfile)
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/gateway/client.js', () => ({
  isAuthenticated: vi.fn(),
  getGatewayClient: vi.fn(),
  setGatewayToken: vi.fn(),
  setGatewayProfile: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}))

// node:http is mocked at top level so Vitest hoisting works correctly.
// The mock returns a fake server that never fires the callback listener,
// which allows registration-failure tests to complete synchronously.
vi.mock('node:http', () => ({
  createServer: vi.fn((_handler) => ({
    listen: vi.fn(function (_port, _host, cb) {
      if (cb) cb()
      return this
    }),
    address: vi.fn().mockReturnValue({ port: 12345 }),
    close: vi.fn(),
  })),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

const testCtx = { projectId: 'test-project', gatewayUrl: 'http://localhost:3001' }

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('authenticate — no gateway URL', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns not_applicable when QUORUM_GATEWAY_URL not set and ctx has no gatewayUrl', async () => {
    delete process.env.QUORUM_GATEWAY_URL
    const { handler } = await import('../../src/tools/authenticate.js')
    const result = await handler(null, {}, undefined, null)
    expect(result.status).toBe('not_applicable')
  })
})

describe('authenticate — already authenticated', () => {
  afterEach(() => {
    vi.clearAllMocks()
    delete process.env.QUORUM_GATEWAY_URL
  })

  it('returns already_authenticated when token exists and no project_id override', async () => {
    const { isAuthenticated, getGatewayClient } = await import('../../src/gateway/client.js')
    vi.mocked(isAuthenticated).mockReturnValue(true)
    vi.mocked(getGatewayClient).mockReturnValue({
      verifyAuth: vi.fn().mockResolvedValue({ sub: 'alice', is_admin: false, expiresIn: 3600 }),
    })

    const { handler } = await import('../../src/tools/authenticate.js')
    const result = await handler(null, {}, undefined, testCtx)

    expect(result.status).toBe('already_authenticated')
    expect(result.user).toBe('alice')
    expect(result.is_admin).toBe(false)
  })

  it('does NOT short-circuit when project_id is explicitly provided (re-auth)', async () => {
    const { isAuthenticated } = await import('../../src/gateway/client.js')
    vi.mocked(isAuthenticated).mockReturnValue(true)

    // Should attempt discover — will fail → oauth_not_available
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect refused')))

    const { handler } = await import('../../src/tools/authenticate.js')
    const result = await handler(null, { project_id: 'other-project' }, undefined, testCtx)

    expect(result.status).toBe('oauth_not_available')
    vi.unstubAllGlobals()
  })
})

describe('authenticate — OAuth metadata discovery', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('returns oauth_not_available when discovery fetch fails', async () => {
    const { isAuthenticated } = await import('../../src/gateway/client.js')
    vi.mocked(isAuthenticated).mockReturnValue(false)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')))

    const { handler } = await import('../../src/tools/authenticate.js')
    const result = await handler(null, {}, undefined, testCtx)

    expect(result.status).toBe('oauth_not_available')
    expect(result.message).toContain('ECONNREFUSED')
  })

  it('returns oauth_not_available when discovery returns non-ok', async () => {
    const { isAuthenticated } = await import('../../src/gateway/client.js')
    vi.mocked(isAuthenticated).mockReturnValue(false)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }))

    const { handler } = await import('../../src/tools/authenticate.js')
    const result = await handler(null, {}, undefined, testCtx)

    expect(result.status).toBe('oauth_not_available')
  })

  it('returns oauth_metadata_incomplete when endpoints are missing', async () => {
    const { isAuthenticated } = await import('../../src/gateway/client.js')
    vi.mocked(isAuthenticated).mockReturnValue(false)

    // We need to mock the callback server too so it doesn't hang
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authorization_endpoint: null, token_endpoint: null }),
      })
    )

    const { handler } = await import('../../src/tools/authenticate.js')
    const result = await handler(null, {}, undefined, testCtx)

    expect(result.status).toBe('oauth_metadata_incomplete')
  })
})

describe('authenticate — registration failure', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('returns registration_failed when client registration fails', async () => {
    const { isAuthenticated } = await import('../../src/gateway/client.js')
    vi.mocked(isAuthenticated).mockReturnValue(false)

    // Discovery OK, registration fails
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_endpoint: 'http://localhost:3001/oauth/authorize',
          token_endpoint: 'http://localhost:3001/oauth/token',
          registration_endpoint: 'http://localhost:3001/oauth/register',
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error_description: 'invalid client metadata' }),
      })
    )

    const { spawnSync } = await import('node:child_process')
    vi.mocked(spawnSync).mockReturnValue({ status: 0 })

    const { handler } = await import('../../src/tools/authenticate.js')
    const result = await handler(null, {}, undefined, testCtx)

    expect(result.status).toBe('registration_failed')
    expect(result.message).toContain('registration failed')
  })
})
