/**
 * Extended tests for src/gateway/client.js
 *
 * Covers: GatewayClient HTTP methods, module-level functions
 * (getGatewayClient, isAuthenticated, setGatewayToken, setGatewayProfile,
 * getGatewayProfile, _resetGatewayClient), and typed endpoint wrappers.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

vi.mock('../../src/logger.js', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), trace: vi.fn() },
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal ES256-style JWT with given payload.
 * Header and signature are placeholder base64url strings.
 */
function makeJwt(payload) {
  const header  = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url')
  const body    = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

function freshToken(overrides = {}) {
  return makeJwt({
    sub: 'alice',
    is_admin: false,
    exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    ...overrides,
  })
}

function expiredToken() {
  return makeJwt({
    sub: 'alice',
    is_admin: false,
    exp: Math.floor(Date.now() / 1000) - 120, // already expired
  })
}

// ── module-level functions ─────────────────────────────────────────────────────

describe('setGatewayToken + isAuthenticated', () => {
  beforeEach(async () => {
    const { _resetGatewayClient } = await import('../../src/gateway/client.js')
    _resetGatewayClient()
  })
  afterEach(async () => {
    vi.clearAllMocks()
    const { _resetGatewayClient } = await import('../../src/gateway/client.js')
    _resetGatewayClient()
  })

  it('returns false when no token set', async () => {
    const { isAuthenticated } = await import('../../src/gateway/client.js')
    expect(isAuthenticated()).toBe(false)
  })

  it('returns true after setting a fresh token', async () => {
    const { setGatewayToken, isAuthenticated } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    expect(isAuthenticated()).toBe(true)
  })

  it('returns false and clears token when token is expired', async () => {
    const { setGatewayToken, isAuthenticated } = await import('../../src/gateway/client.js')
    setGatewayToken(expiredToken())
    expect(isAuthenticated()).toBe(false)
    // Token should be cleared — calling again is false
    expect(isAuthenticated()).toBe(false)
  })

  it('returns false after setting token to null', async () => {
    const { setGatewayToken, isAuthenticated } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    setGatewayToken(null)
    expect(isAuthenticated()).toBe(false)
  })
})

describe('setGatewayProfile + getGatewayProfile', () => {
  beforeEach(async () => {
    const { _resetGatewayClient } = await import('../../src/gateway/client.js')
    _resetGatewayClient()
  })
  afterEach(async () => {
    const { _resetGatewayClient } = await import('../../src/gateway/client.js')
    _resetGatewayClient()
  })

  it('returns null when no profile set', async () => {
    const { getGatewayProfile } = await import('../../src/gateway/client.js')
    expect(getGatewayProfile()).toBeNull()
  })

  it('returns profile after setting it', async () => {
    const { setGatewayProfile, getGatewayProfile } = await import('../../src/gateway/client.js')
    setGatewayProfile({ role: 'engineer', team: 'platform', base_confidence: 0.7, project: null })
    const profile = getGatewayProfile()
    expect(profile.role).toBe('engineer')
    expect(profile.team).toBe('platform')
  })

  it('returns null after clearing profile', async () => {
    const { setGatewayProfile, getGatewayProfile } = await import('../../src/gateway/client.js')
    setGatewayProfile({ role: 'engineer' })
    setGatewayProfile(null)
    expect(getGatewayProfile()).toBeNull()
  })
})

describe('getGatewayClient', () => {
  beforeEach(async () => {
    const { _resetGatewayClient } = await import('../../src/gateway/client.js')
    _resetGatewayClient()
  })
  afterEach(async () => {
    const { _resetGatewayClient } = await import('../../src/gateway/client.js')
    _resetGatewayClient()
    delete process.env.QUORUM_GATEWAY_URL
  })

  it('returns null when no URL provided and env not set', async () => {
    delete process.env.QUORUM_GATEWAY_URL
    const { getGatewayClient } = await import('../../src/gateway/client.js')
    expect(getGatewayClient()).toBeNull()
  })

  it('creates client from QUORUM_GATEWAY_URL env', async () => {
    process.env.QUORUM_GATEWAY_URL = 'http://localhost:3001'
    const { getGatewayClient } = await import('../../src/gateway/client.js')
    const client = getGatewayClient()
    expect(client).not.toBeNull()
    expect(client._gatewayUrl).toBe('http://localhost:3001')
  })

  it('creates client from explicit URL', async () => {
    const { getGatewayClient } = await import('../../src/gateway/client.js')
    const client = getGatewayClient('http://remote:3001')
    expect(client._gatewayUrl).toBe('http://remote:3001')
  })

  it('returns singleton when called twice with same URL', async () => {
    const { getGatewayClient } = await import('../../src/gateway/client.js')
    const a = getGatewayClient('http://localhost:3001')
    const b = getGatewayClient('http://localhost:3001')
    expect(a).toBe(b)
  })

  it('recreates client when URL changes', async () => {
    const { getGatewayClient } = await import('../../src/gateway/client.js')
    const a = getGatewayClient('http://localhost:3001')
    const b = getGatewayClient('http://other:3001')
    expect(a).not.toBe(b)
    expect(b._gatewayUrl).toBe('http://other:3001')
  })

  it('strips trailing slash from URL', async () => {
    const { getGatewayClient } = await import('../../src/gateway/client.js')
    const client = getGatewayClient('http://localhost:3001/')
    expect(client._gatewayUrl).toBe('http://localhost:3001')
  })
})

// ── GatewayClient instance methods ────────────────────────────────────────────

describe('GatewayClient — _getToken', () => {
  afterEach(async () => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    const { _resetGatewayClient } = await import('../../src/gateway/client.js')
    _resetGatewayClient()
  })

  it('throws when not authenticated', async () => {
    const { GatewayClient } = await import('../../src/gateway/client.js')
    const client = new GatewayClient('http://localhost:3001')
    expect(() => client._getToken()).toThrow('Not authenticated')
  })

  it('throws when token is expired', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(expiredToken())
    const client = new GatewayClient('http://localhost:3001')
    expect(() => client._getToken()).toThrow('expired')
  })

  it('returns token when valid', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    const token = freshToken()
    setGatewayToken(token)
    const client = new GatewayClient('http://localhost:3001')
    const result = client._getToken()
    expect(result.token).toBe(token)
  })
})

describe('GatewayClient — verifyAuth', () => {
  afterEach(async () => {
    const { _resetGatewayClient } = await import('../../src/gateway/client.js')
    _resetGatewayClient()
  })

  it('returns sub, is_admin, expiresIn from JWT', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    const exp = Math.floor(Date.now() / 1000) + 3600
    setGatewayToken(makeJwt({ sub: 'bob', is_admin: true, exp }))

    const client = new GatewayClient('http://localhost:3001')
    const auth = await client.verifyAuth()

    expect(auth.sub).toBe('bob')
    expect(auth.is_admin).toBe(true)
    expect(auth.expiresIn).toBeGreaterThan(0)
  })

  it('returns expiresIn null when no exp claim', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(makeJwt({ sub: 'bob', is_admin: false })) // no exp
    const client = new GatewayClient('http://localhost:3001')
    const auth = await client.verifyAuth()
    expect(auth.expiresIn).toBeNull()
  })
})

describe('GatewayClient — getIdentity', () => {
  afterEach(async () => {
    const { _resetGatewayClient } = await import('../../src/gateway/client.js')
    _resetGatewayClient()
  })

  it('returns identity with profile data merged', async () => {
    const { setGatewayToken, setGatewayProfile, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken({ sub: 'alice', is_admin: false }))
    setGatewayProfile({ role: 'principal_architect', team: 'platform', base_confidence: 0.9, project: null })

    const client = new GatewayClient('http://localhost:3001')
    const identity = await client.getIdentity()

    expect(identity.name).toBe('alice')
    expect(identity.role).toBe('principal_architect')
    expect(identity.team).toBe('platform')
    expect(identity.base_confidence).toBe(0.9)
    expect(identity.method).toBe('oauth2_gateway')
  })

  it('falls back to defaults when no profile set', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken({ sub: 'unknown', is_admin: false }))

    const client = new GatewayClient('http://localhost:3001')
    const identity = await client.getIdentity()

    expect(identity.role).toBeNull()
    expect(identity.team).toBeNull()
    expect(identity.base_confidence).toBe(0.7)
  })
})

describe('GatewayClient — query stub', () => {
  afterEach(async () => {
    const { _resetGatewayClient } = await import('../../src/gateway/client.js')
    _resetGatewayClient()
  })

  it('throws when query() is called (no raw SQL)', async () => {
    const { GatewayClient } = await import('../../src/gateway/client.js')
    const client = new GatewayClient('http://localhost:3001')
    await expect(client.query('SELECT 1')).rejects.toThrow('typed gateway endpoints')
  })

  it('connect() returns a stub client', async () => {
    const { GatewayClient } = await import('../../src/gateway/client.js')
    const client = new GatewayClient('http://localhost:3001')
    const stub = await client.connect()
    expect(typeof stub.release).toBe('function')
    expect(() => stub.query('SELECT 1')).toThrow('typed endpoints')
  })

  it('end() resolves without error', async () => {
    const { GatewayClient } = await import('../../src/gateway/client.js')
    const client = new GatewayClient('http://localhost:3001')
    await expect(client.end()).resolves.toBeUndefined()
  })
})

describe('GatewayClient — _request (HTTP calls)', () => {
  afterEach(async () => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    const { _resetGatewayClient } = await import('../../src/gateway/client.js')
    _resetGatewayClient()
  })

  it('makes authenticated GET request and returns JSON', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'healthy' }),
    }))

    const client = new GatewayClient('http://localhost:3001')
    const result = await client._request('GET', '/health', null)
    expect(result).toEqual({ status: 'healthy' })
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3001/health',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('returns null for 204 responses', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: vi.fn(),
    }))

    const client = new GatewayClient('http://localhost:3001')
    const result = await client._request('GET', '/some-endpoint', null)
    expect(result).toBeNull()
  })

  it('throws with status and body when response is not ok', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ message: 'Resource not found' }),
    }))

    const client = new GatewayClient('http://localhost:3001')
    const err = await client._request('GET', '/missing', null).catch((e) => e)
    expect(err.status).toBe(404)
    expect(err.message).toContain('404')
    expect(err.message).toContain('Resource not found')
  })

  it('includes X-Quorum-Project header when projectId set', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    }))

    const client = new GatewayClient('http://localhost:3001')
    client.setProjectId('q_p1')
    await client._request('GET', '/health', null)

    const headers = fetch.mock.calls[0][1].headers
    expect(headers['X-Quorum-Project']).toBe('q_p1')
  })

  it('includes body for POST requests', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ stored: true }),
    }))

    const client = new GatewayClient('http://localhost:3001')
    await client._post('/pg/versions', { topic: 'auth', key: 'token' })

    const call = fetch.mock.calls[0]
    expect(call[1].method).toBe('POST')
    expect(JSON.parse(call[1].body)).toEqual({ topic: 'auth', key: 'token' })
  })

  it('emits trace logs for outbound gateway request payloads and inbound responses', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    const { log } = await import('../../src/logger.js')
    setGatewayToken(freshToken())

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ stored: true, id: 'a1' }),
    }))

    const client = new GatewayClient('http://localhost:3001')
    await client._post('/pg/audit', { tool: 'remember', topic: 'auth' }, { projectId: 'q_p1' })

    expect(log.trace).toHaveBeenCalledWith(
      'gateway request outbound',
      expect.objectContaining({
        gateway_url: 'http://localhost:3001',
        method: 'POST',
        path: '/pg/audit',
        project_id: 'q_p1',
        body: { tool: 'remember', topic: 'auth' },
      }),
    )
    expect(log.trace).toHaveBeenCalledWith(
      'gateway response inbound',
      expect.objectContaining({
        method: 'POST',
        path: '/pg/audit',
        status: 200,
        body: { stored: true, id: 'a1' },
      }),
    )
  })
})

describe('GatewayClient — typed endpoint wrappers', () => {
  afterEach(async () => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    const { _resetGatewayClient } = await import('../../src/gateway/client.js')
    _resetGatewayClient()
  })

  it('ping() returns true when /health returns healthy', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'healthy' }),
    }))

    const client = new GatewayClient('http://localhost:3001')
    expect(await client.ping()).toBe(true)
  })

  it('ping() returns false when request fails', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect refused')))

    const client = new GatewayClient('http://localhost:3001')
    expect(await client.ping()).toBe(false)
  })

  it('getCurrentVersion calls correct endpoint', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ version: 1 }),
    }))

    const client = new GatewayClient('http://localhost:3001')
    const result = await client.getCurrentVersion('auth', 'token-strategy')
    expect(result).toEqual({ version: 1 })
    expect(fetch.mock.calls[0][0]).toContain('/pg/versions/auth/token-strategy')
  })

  it('getVersionHistory calls correct endpoint', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ version: 1 }],
    }))

    const client = new GatewayClient('http://localhost:3001')
    const result = await client.getVersionHistory('auth', 'token')
    expect(result).toHaveLength(1)
    expect(fetch.mock.calls[0][0]).toContain('/history')
  })

  it('getNextVersionNumber extracts next_version from response', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ next_version: 4 }),
    }))

    const client = new GatewayClient('http://localhost:3001')
    const n = await client.getNextVersionNumber('auth', 'token')
    expect(n).toBe(4)
  })

  it('countEntries extracts count from response', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ count: 42 }),
    }))

    const client = new GatewayClient('http://localhost:3001')
    const count = await client.countEntries()
    expect(count).toBe(42)
  })

  it('searchByText builds correct query string', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [], total: 0, source: 'pg' }),
    }))

    const client = new GatewayClient('http://localhost:3001')
    await client.searchByText('auth token', { domain: 'auth', limit: 5 })
    const url = fetch.mock.calls[0][0]
    expect(url).toContain('q=auth+token')
    expect(url).toContain('domain=auth')
    expect(url).toContain('limit=5')
  })

  it('getPendingDecisions passes include_stale when statuses includes stale', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    }))

    const client = new GatewayClient('http://localhost:3001')
    await client.getPendingDecisions({ statuses: ['pending', 'stale'] })
    const url = fetch.mock.calls[0][0]
    expect(url).toContain('include_stale=true')
  })

  it('atomicSupersede POSTs to /pg/versions/supersede', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ inserted: true, superseded_version: 1, rows_updated: 1 }),
    }))

    const client = new GatewayClient('http://localhost:3001')
    const result = await client.atomicSupersede({ version: 2 }, 1, 'Updated', null)
    expect(result.inserted).toBe(true)
    expect(fetch.mock.calls[0][0]).toContain('/pg/versions/supersede')
  })

  it('getVersionAtDate hits the /at endpoint with date query', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ version: 1 }) }))

    const client = new GatewayClient('http://localhost:3001')
    const result = await client.getVersionAtDate('auth', 'token', '2025-01-01')
    expect(result).toEqual({ version: 1 })
    expect(fetch.mock.calls[0][0]).toContain('/at')
    expect(fetch.mock.calls[0][0]).toContain('date=2025-01-01')
  })

  it('getSpecificVersion hits versioned endpoint', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ version: 3 }) }))

    const client = new GatewayClient('http://localhost:3001')
    const result = await client.getSpecificVersion('auth', 'token', 3)
    expect(result.version).toBe(3)
    expect(fetch.mock.calls[0][0]).toMatch(/\/pg\/versions\/auth\/token\/3/)
  })

  it('insertVersion POSTs to /pg/versions', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ version_id: 'q_k1_v1' }) }))

    const client = new GatewayClient('http://localhost:3001')
    const result = await client.insertVersion({ topic: 'auth', key: 'token', version: 1 })
    expect(result.version_id).toBe('q_k1_v1')
    expect(fetch.mock.calls[0][0]).toContain('/pg/versions')
    expect(fetch.mock.calls[0][1].method).toBe('POST')
  })

  it('transitionVersionStatus PATCHes the version endpoint', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ updated: true }) }))

    const client = new GatewayClient('http://localhost:3001')
    await client.transitionVersionStatus('auth', 'token', 1, 'SUPERSEDED', null)
    expect(fetch.mock.calls[0][1].method).toBe('PATCH')
    expect(fetch.mock.calls[0][0]).toMatch(/\/pg\/versions\/auth\/token\/1/)
  })

  it('getVersionsByTag hits the by-tag endpoint', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [{ version: 1 }] }))

    const client = new GatewayClient('http://localhost:3001')
    const result = await client.getVersionsByTag('security')
    expect(result).toHaveLength(1)
    expect(fetch.mock.calls[0][0]).toContain('/pg/versions/by-tag/security')
  })

  it('insertVersionAuditLink POSTs to /pg/audit-links', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) }))

    const client = new GatewayClient('http://localhost:3001')
    await client.insertVersionAuditLink({ version_id: 'v1', audit_id: 'a1' })
    expect(fetch.mock.calls[0][0]).toContain('/pg/audit-links')
    expect(fetch.mock.calls[0][1].method).toBe('POST')
  })

  it('writeAuditEntry POSTs to /pg/audit', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'a1' }) }))

    const client = new GatewayClient('http://localhost:3001')
    await client.writeAuditEntry({ tool: 'remember', topic: 'auth' })
    expect(fetch.mock.calls[0][0]).toContain('/pg/audit')
    expect(fetch.mock.calls[0][1].method).toBe('POST')
  })

  it('getAuditEntry GETs from /pg/audit/:id', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'a1', tool: 'remember' }) }))

    const client = new GatewayClient('http://localhost:3001')
    const result = await client.getAuditEntry('a1')
    expect(result.id).toBe('a1')
    expect(fetch.mock.calls[0][0]).toContain('/pg/audit/a1')
  })

  it('getAllEntries passes from/to/tool filters', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] }))

    const client = new GatewayClient('http://localhost:3001')
    await client.getAllEntries({ from: '2025-01-01', to: '2025-12-31', tool: 'remember' })
    const url = fetch.mock.calls[0][0]
    expect(url).toContain('from=2025-01-01')
    expect(url).toContain('to=2025-12-31')
    expect(url).toContain('tool=remember')
  })

  it('getAllEntries with no filters hits /pg/audit with no query string', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] }))

    const client = new GatewayClient('http://localhost:3001')
    await client.getAllEntries()
    expect(fetch.mock.calls[0][0]).toBe('http://localhost:3001/pg/audit')
  })

  it('insertPendingDecision POSTs to /pg/pending', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ conflict_id: 'q_c1' }) }))

    const client = new GatewayClient('http://localhost:3001')
    const result = await client.insertPendingDecision({ conflict_id: 'q_c1', conflict_topic: 'auth' })
    expect(result).toBe('q_c1')
    expect(fetch.mock.calls[0][0]).toContain('/pg/pending')
    expect(fetch.mock.calls[0][1].method).toBe('POST')
  })

  it('updatePendingDecision PATCHes /pg/pending/:id', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ updated: true }) }))

    const client = new GatewayClient('http://localhost:3001')
    await client.updatePendingDecision('q_c1', { status: 'resolved' })
    expect(fetch.mock.calls[0][1].method).toBe('PATCH')
    expect(fetch.mock.calls[0][0]).toContain('/pg/pending/q_c1')
  })

  it('countPendingForKey extracts count from response', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ count: 3 }) }))

    const client = new GatewayClient('http://localhost:3001')
    const count = await client.countPendingForKey('auth', 'token-strategy')
    expect(count).toBe(3)
    expect(fetch.mock.calls[0][0]).toContain('/pg/pending/count/auth/token-strategy')
  })

  it('getPendingDecisionById GETs /pg/pending/:id', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ conflict_id: 'q_c1', status: 'pending' }) }))

    const client = new GatewayClient('http://localhost:3001')
    const result = await client.getPendingDecisionById('q_c1')
    expect(result.conflict_id).toBe('q_c1')
    expect(fetch.mock.calls[0][0]).toContain('/pg/pending/q_c1')
  })

  it('getLatestDraftVersion hits /pg/versions/latest-draft', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ version: 2, status: 'DRAFT' }) }))

    const client = new GatewayClient('http://localhost:3001')
    const result = await client.getLatestDraftVersion('auth', 'token')
    expect(result.status).toBe('DRAFT')
    expect(fetch.mock.calls[0][0]).toContain('/latest-draft/auth/token')
  })

  it('getVersionsByStatus hits /pg/versions/by-status/:status', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [{ version: 1, status: 'ACTIVE' }] }))

    const client = new GatewayClient('http://localhost:3001')
    const result = await client.getVersionsByStatus('ACTIVE', { topic: 'auth' })
    expect(result).toHaveLength(1)
    expect(fetch.mock.calls[0][0]).toContain('/by-status/ACTIVE')
    expect(fetch.mock.calls[0][0]).toContain('topic=auth')
  })

  it('getVersionsByStatus with no topic has no query string', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] }))

    const client = new GatewayClient('http://localhost:3001')
    await client.getVersionsByStatus('ACTIVE')
    expect(fetch.mock.calls[0][0]).not.toContain('topic')
  })

  it('getVersionStatusCounts hits /pg/versions/status-counts', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ACTIVE: 10, DRAFT: 3 }) }))

    const client = new GatewayClient('http://localhost:3001')
    const result = await client.getVersionStatusCounts({ topic: 'auth' })
    expect(result.ACTIVE).toBe(10)
    expect(fetch.mock.calls[0][0]).toContain('status-counts')
    expect(fetch.mock.calls[0][0]).toContain('topic=auth')
  })

  it('getVersionStatusCounts with no topic omits topic filter', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }))

    const client = new GatewayClient('http://localhost:3001')
    await client.getVersionStatusCounts()
    expect(fetch.mock.calls[0][0]).not.toContain('topic')
  })

  it('getDraftVersions hits /pg/versions/drafts', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] }))

    const client = new GatewayClient('http://localhost:3001')
    await client.getDraftVersions({ topic: 'auth' })
    expect(fetch.mock.calls[0][0]).toContain('/pg/versions/drafts')
    expect(fetch.mock.calls[0][0]).toContain('topic=auth')
  })

  it('getDraftVersions with no topic omits query string', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] }))

    const client = new GatewayClient('http://localhost:3001')
    await client.getDraftVersions()
    expect(fetch.mock.calls[0][0]).toBe('http://localhost:3001/pg/versions/drafts')
  })

  it('getConfig hits /config/:projectId', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ group_id: 'my-project' }) }))

    const client = new GatewayClient('http://localhost:3001')
    const result = await client.getConfig('my-project')
    expect(result.group_id).toBe('my-project')
    expect(fetch.mock.calls[0][0]).toContain('/config/my-project')
  })

  it('getPendingDecisions with include_stale:true passes include_stale=true', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] }))

    const client = new GatewayClient('http://localhost:3001')
    await client.getPendingDecisions({ include_stale: true })
    expect(fetch.mock.calls[0][0]).toContain('include_stale=true')
  })

  it('getPendingDecisions with topic filter passes topic', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] }))

    const client = new GatewayClient('http://localhost:3001')
    await client.getPendingDecisions({ topic: 'auth' })
    expect(fetch.mock.calls[0][0]).toContain('topic=auth')
  })

  it('_request falls back to statusText when JSON parse fails on error', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => { throw new Error('not json') },
    }))

    const client = new GatewayClient('http://localhost:3001')
    const err = await client._request('GET', '/broken', null).catch((e) => e)
    expect(err.status).toBe(500)
    expect(err.message).toContain('500')
  })

  it('_patch includes body and PATCH method', async () => {
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) }))

    const client = new GatewayClient('http://localhost:3001')
    await client._patch('/pg/pending/q_c1', { status: 'resolved' })
    expect(fetch.mock.calls[0][1].method).toBe('PATCH')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ status: 'resolved' })
  })

  it('resolvePendingDecision — not a GatewayClient method, but confirmed absent', async () => {
    // resolvePendingDecision in queries.js delegates to pg.updatePendingDecision when pg is a gateway client.
    // Test that GatewayClient has updatePendingDecision and the endpoint is correct.
    const { setGatewayToken, GatewayClient } = await import('../../src/gateway/client.js')
    setGatewayToken(freshToken())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'resolved' }) }))

    const client = new GatewayClient('http://localhost:3001')
    await client.updatePendingDecision('q_c_conflict_1', { status: 'resolved', resolution: 'reject' })
    expect(fetch.mock.calls[0][1].method).toBe('PATCH')
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.status).toBe('resolved')
  })

  it('getOrCreateKey is not a GatewayClient method — confirmed by typeof check in queries.js', async () => {
    const { GatewayClient } = await import('../../src/gateway/client.js')
    const client = new GatewayClient('http://localhost:3001')
    expect(typeof client.getOrCreateKey).toBe('undefined')
  })

  it('incrementDomainStat is not a GatewayClient method — confirmed', async () => {
    const { GatewayClient } = await import('../../src/gateway/client.js')
    const client = new GatewayClient('http://localhost:3001')
    expect(typeof client.incrementDomainStat).toBe('undefined')
  })
})
