/**
 * TDD Gate — v0.3 GatewayClient X-Quorum-Project header (Phase 2).
 *
 * These tests will FAIL against the current v0.2 _request() implementation
 * (which only sends Authorization header) and PASS once Phase 2 is complete:
 *
 *   _request(method, path, body, options = {}) sends
 *   X-Quorum-Project: <options.projectId> when options.projectId is set.
 *
 * This header is the v0.3 mechanism for project context — the JWT no longer
 * carries the project claim. Without this header, all tool calls scope to
 * null project on the gateway's verify-jwt middleware.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'

// ── Generate a test JWT (self-signed — not verified by GatewayClient) ─────────

let testToken

beforeEach(async () => {
  const { privateKey } = await generateKeyPair('ES256')
  testToken = await new SignJWT({ sub: 'alice', is_admin: false })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer('quorum-gateway')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)
})

// ── Imports ────────────────────────────────────────────────────────────────────

import {
  GatewayClient,
  setGatewayToken,
  _resetGatewayClient,
} from '../../src/gateway/client.js'

afterEach(() => {
  _resetGatewayClient()
  vi.unstubAllGlobals()
})

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Stub global fetch, capture the request options, and return a 200 response.
 * @returns {{ capturedInit: { headers: Record<string,string>, method: string } | null }}
 */
function stubFetchCapture() {
  const captured = { init: null }
  vi.stubGlobal('fetch', vi.fn((_url, init) => {
    captured.init = init
    return Promise.resolve({
      ok:     true,
      status: 200,
      json:   async () => ({ ok: true }),
    })
  }))
  return captured
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GatewayClient._request — v0.3 X-Quorum-Project header (Phase 2)', () => {
  it('sends X-Quorum-Project header when options.projectId is set', async () => {
    setGatewayToken(testToken)
    const captured = stubFetchCapture()

    const client = new GatewayClient('http://localhost:3001')
    await client._request('GET', '/pg/versions/infra/test', null, { projectId: 'my-project' })

    expect(captured.init.headers['X-Quorum-Project']).toBe('my-project')
  })

  it('does NOT send X-Quorum-Project when options.projectId is null', async () => {
    setGatewayToken(testToken)
    const captured = stubFetchCapture()

    const client = new GatewayClient('http://localhost:3001')
    await client._request('GET', '/pg/versions/infra/test', null, { projectId: null })

    expect(captured.init.headers['X-Quorum-Project']).toBeUndefined()
  })

  it('does NOT send X-Quorum-Project when options is omitted', async () => {
    setGatewayToken(testToken)
    const captured = stubFetchCapture()

    const client = new GatewayClient('http://localhost:3001')
    await client._request('GET', '/some-path', null)

    expect(captured.init.headers['X-Quorum-Project']).toBeUndefined()
  })

  it('always sends Authorization header regardless of projectId', async () => {
    setGatewayToken(testToken)
    const captured = stubFetchCapture()

    const client = new GatewayClient('http://localhost:3001')
    await client._request('POST', '/pg/versions', { topic: 'infra', key: 'test' }, { projectId: 'p1' })

    expect(captured.init.headers['Authorization']).toMatch(/^Bearer /)
    expect(captured.init.headers['X-Quorum-Project']).toBe('p1')
  })
})

describe('GatewayClient._get and _post — project header threading (Phase 2)', () => {
  it('_get passes projectId option to _request', async () => {
    setGatewayToken(testToken)
    const captured = stubFetchCapture()

    const client = new GatewayClient('http://localhost:3001')
    await client._get('/pg/versions/infra/test', {}, { projectId: 'proj-abc' })

    expect(captured.init.headers['X-Quorum-Project']).toBe('proj-abc')
  })

  it('_post passes projectId option to _request', async () => {
    setGatewayToken(testToken)
    const captured = stubFetchCapture()

    const client = new GatewayClient('http://localhost:3001')
    await client._post('/pg/audit', { op: 'test' }, { projectId: 'proj-xyz' })

    expect(captured.init.headers['X-Quorum-Project']).toBe('proj-xyz')
  })
})
