/**
 * Quorum Gateway Client — used by the local Quorum MCP server.
 *
 * Auth model (OAuth 2.1, MCP spec 2025-03-26):
 *   - The MCP never holds a GitHub token. Auth is initiated by the authenticate()
 *     tool which runs the full OAuth 2.1 + PKCE flow against the gateway.
 *   - The gateway handles GitHub OAuth internally and issues a Gateway-MCP Token
 *     (ES256 JWT) that carries user identity, project, role, and permissions.
 *   - That token is stored in-memory (_runtimeToken) for the process lifetime.
 *   - All gateway requests use: Authorization: Bearer <gateway-mcp-token>
 *   - isAuthenticated() gates tool calls before any request is made.
 *
 * No environment variables are required for authentication.
 * QUORUM_GATEWAY_URL is the only env var this module reads.
 */

const REFRESH_BUFFER_S = 60  // Treat token as expired 60s before actual expiry

// ── Module-level state ─────────────────────────────────────────────────────────

/** @type {GatewayClient | null} */
let _client = null

/** @type {string | null} Gateway-MCP Token (ES256 JWT) — set by authenticate() tool */
let _runtimeToken = null

// ── JWT helpers ────────────────────────────────────────────────────────────────

/**
 * Decode JWT payload without verification (gateway validates on every request).
 * @param {string} jwt
 * @returns {Record<string, unknown>}
 */
function decodeJwtPayload(jwt) {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
  } catch {
    return {}
  }
}

// ── GatewayClient ──────────────────────────────────────────────────────────────

/**
 * Lightweight HTTP client for the Quorum Gateway REST API.
 * Constructor takes only the gateway URL — the token is managed separately
 * via setGatewayToken() and read from the module-level _runtimeToken.
 */
export class GatewayClient {
  /**
   * @param {string} gatewayUrl - Base URL of the Quorum Gateway
   */
  constructor(gatewayUrl) {
    this._gatewayUrl = gatewayUrl.replace(/\/$/, '')
  }

  // ── Token management ───────────────────────────────────────────────────────

  /**
   * Return the current Gateway-MCP token, throwing if not authenticated or expired.
   * @returns {{ token: string }}
   */
  _getToken() {
    if (!_runtimeToken) {
      throw new Error('Not authenticated — call authenticate() to log in via GitHub OAuth')
    }

    const payload = decodeJwtPayload(_runtimeToken)
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp - REFRESH_BUFFER_S) {
      _runtimeToken = null
      throw new Error('Gateway token expired — call authenticate() to log in again')
    }

    return { token: _runtimeToken }
  }

  /**
   * Return verified identity claims decoded from the current Gateway-MCP token.
   * No network call — the JWT is already verified by the gateway on issuance.
   * @returns {{ sub: string, project: string, role: string|null, team: string|null, expiresIn: number|null }}
   */
  async verifyAuth() {
    const { token } = this._getToken()
    const p = decodeJwtPayload(token)
    return {
      sub:       p.sub ?? 'unknown',
      project:   p.project ?? 'default',
      role:      p.role ?? null,
      team:      p.team ?? null,
      expiresIn: p.exp ? Math.max(0, p.exp - Math.floor(Date.now() / 1000)) : null,
    }
  }

  /**
   * Return resolved identity for injection into tool handler calls.
   * @returns {Promise<import('../identity/resolver.js').ResolvedIdentity>}
   */
  async getIdentity() {
    const { token } = this._getToken()
    const p = decodeJwtPayload(token)
    return {
      name:            p.sub ?? 'unknown',
      team:            p.team ?? null,
      role:            p.role ?? null,
      base_confidence: p.base_confidence ?? 0.7,
      method:          'oauth2_gateway',
    }
  }

  // ── pg.Pool-compatible stubs ───────────────────────────────────────────────

  /**
   * Raw SQL is not supported — all operations use typed gateway endpoints.
   * This stub satisfies legacy function signatures that accept a pool parameter.
   */
  async query(_sql, _params) {
    throw new Error(
      'GatewayClient.query() called with raw SQL — use the typed gateway endpoints instead.',
    )
  }

  /** Connect stub — satisfies pg.Pool interface for backward compatibility. */
  async connect() {
    return {
      query:   () => { throw new Error('GatewayClient: use typed endpoints') },
      release: () => {},
    }
  }

  /** No-op — GatewayClient has no persistent connection to close. */
  async end() {}

  // ── HTTP helpers ───────────────────────────────────────────────────────────

  /**
   * Make an authenticated HTTP request to the gateway.
   * @param {string} method
   * @param {string} path
   * @param {object} [body]
   * @returns {Promise<unknown>}
   */
  async _request(method, path, body) {
    const { token } = this._getToken()

    const response = await fetch(`${this._gatewayUrl}${path}`, {
      method,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    })

    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      throw new Error(`Gateway ${method} ${path} failed (${response.status}): ${err.message ?? response.statusText}`)
    }

    if (response.status === 204) return null
    return response.json()
  }

  /** @param {string} path @param {Record<string, string>} [query] */
  async _get(path, query) {
    const url = query ? `${path}?${new URLSearchParams(query)}` : path
    return this._request('GET', url)
  }

  /** @param {string} path @param {object} body */
  async _post(path, body) { return this._request('POST', path, body) }

  /** @param {string} path @param {object} body */
  async _patch(path, body) { return this._request('PATCH', path, body) }

  // ── Knowledge version operations ───────────────────────────────────────────

  async getCurrentVersion(topic, key) {
    return this._get(`/pg/versions/${enc(topic)}/${enc(key)}`)
  }

  async getVersionHistory(topic, key) {
    return this._get(`/pg/versions/${enc(topic)}/${enc(key)}/history`)
  }

  async getVersionAtDate(topic, key, date) {
    return this._get(`/pg/versions/${enc(topic)}/${enc(key)}/at`, { date })
  }

  async getNextVersionNumber(topic, key) {
    const data = await this._get(`/pg/versions/${enc(topic)}/${enc(key)}/next-number`)
    return data.next_version
  }

  async getSpecificVersion(topic, key, version) {
    return this._get(`/pg/versions/${enc(topic)}/${enc(key)}/${version}`)
  }

  async insertVersion(record) {
    return this._post('/pg/versions', record)
  }

  async transitionVersionStatus(topic, key, version, newStatus, forwardLink = null) {
    return this._patch(`/pg/versions/${enc(topic)}/${enc(key)}/${version}`, { newStatus, forwardLink })
  }

  async getVersionsByTag(tag) {
    return this._get(`/pg/versions/by-tag/${enc(tag)}`)
  }

  // ── Audit operations ───────────────────────────────────────────────────────

  async insertVersionAuditLink(record) {
    return this._post('/pg/audit-links', record)
  }

  async writeAuditEntry(entry) {
    return this._post('/pg/audit', entry)
  }

  async getAuditEntry(id) {
    return this._get(`/pg/audit/${enc(id)}`)
  }

  async getAllEntries(opts = {}) {
    const query = {}
    if (opts.from) query.from = opts.from
    if (opts.to)   query.to   = opts.to
    if (opts.tool) query.tool = opts.tool
    return this._get('/pg/audit', Object.keys(query).length ? query : undefined)
  }

  async countEntries() {
    const data = await this._get('/pg/audit/count')
    return data.count
  }

  // ── Pending decisions ──────────────────────────────────────────────────────

  async getPendingDecisions(opts = {}) {
    const query = {}
    if (opts.topic)         query.topic         = opts.topic
    if (opts.include_stale) query.include_stale = 'true'
    return this._get('/pg/pending', Object.keys(query).length ? query : undefined)
  }

  async insertPendingDecision(decision) {
    return this._post('/pg/pending', decision)
  }

  async updatePendingDecision(conflictId, updates) {
    return this._patch(`/pg/pending/${enc(conflictId)}`, updates)
  }

  async countPendingForKey(topic, key) {
    const data = await this._get(`/pg/pending/count/${enc(topic)}/${enc(key)}`)
    return data.count
  }

  // ── Config ─────────────────────────────────────────────────────────────────

  async getConfig(projectId) {
    return this._get(`/config/${enc(projectId)}`)
  }

  // ── Health ─────────────────────────────────────────────────────────────────

  async ping() {
    try {
      const data = await this._get('/health')
      return data.status === 'healthy'
    } catch {
      return false
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Return the gateway client singleton, creating it if needed.
 * Returns null when QUORUM_GATEWAY_URL is not set (no gateway configured).
 * Authentication state is separate — check isAuthenticated() before tool calls.
 * @returns {GatewayClient | null}
 */
export function getGatewayClient() {
  if (_client) return _client

  const url = process.env.QUORUM_GATEWAY_URL
  if (!url) return null

  _client = new GatewayClient(url)
  return _client
}

/**
 * Whether the MCP is currently authenticated with the gateway.
 * True when a valid Gateway-MCP token is held in memory.
 * @returns {boolean}
 */
export function isAuthenticated() {
  if (!_runtimeToken) return false
  // Check expiry without throwing
  const payload = decodeJwtPayload(_runtimeToken)
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp - REFRESH_BUFFER_S) {
    _runtimeToken = null
    return false
  }
  return true
}

/**
 * Store the Gateway-MCP token issued after a successful OAuth 2.1 flow.
 * Token is in-memory only — cleared when the MCP process restarts.
 * @param {string | null} token - Gateway-MCP Token (ES256 JWT) or null to clear
 */
export function setGatewayToken(token) {
  _runtimeToken = token
}

/** Backward-compatible alias for setGatewayToken. */
export const setRuntimeToken = setGatewayToken

/** Reset singleton — for testing only. */
export function _resetGatewayClient() {
  _client       = null
  _runtimeToken = null
}

/** URL-encode a path segment. */
function enc(s) { return encodeURIComponent(s) }
