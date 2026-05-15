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

import { log } from '../logger.js'

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
   * Return identity claims from the current Gateway-MCP token (v0.3 slim JWT).
   * v0.3 JWT contains only: { sub, is_admin, jti, exp, iat }
   * Role/team/project are no longer in the JWT — they live in the profile cache.
   * No network call — the JWT is already verified by the gateway on issuance.
   * @returns {{ sub: string, is_admin: boolean, expiresIn: number|null }}
   */
  async verifyAuth() {
    const { token } = this._getToken()
    const p = decodeJwtPayload(token)
    return {
      sub:       p.sub ?? 'unknown',
      is_admin:  p.is_admin ?? false,
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
    // v0.3: JWT is slim — role/team/base_confidence come from profile cache server-side.
    // MCP-side identity uses sub + is_admin only; role defaults to null (no privilege escalation).
    return {
      name:            p.sub ?? 'unknown',
      is_admin:        p.is_admin ?? false,
      team:            null,
      role:            null,
      base_confidence: 0.7,
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
   * Set the active project ID for this client instance.
   * All subsequent _request calls will include X-Quorum-Project unless
   * overridden via options.projectId.
   * @param {string | null} projectId
   */
  setProjectId(projectId) {
    this._projectId = projectId ?? null
  }

  /**
   * Make an authenticated HTTP request to the gateway.
   * @param {string} method
   * @param {string} path
   * @param {object} [body]
   * @param {{ projectId?: string | null }} [options]
   * @returns {Promise<unknown>}
   */
  async _request(method, path, body, options = {}) {
    const { token } = this._getToken()

    log.debug('gateway request', { method, path })

    const headers = {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    }
    const projectId = options.projectId ?? this._projectId ?? null
    if (projectId) {
      headers['X-Quorum-Project'] = projectId
    }

    const response = await fetch(`${this._gatewayUrl}${path}`, {
      method,
      headers,
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    })

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}))
      log.error('gateway request failed', { method, path, status: response.status, body: errBody })
      throw new Error(`Gateway ${method} ${path} failed (${response.status}): ${errBody.message ?? response.statusText}`)
    }

    if (response.status === 204) return null
    return response.json()
  }

  /**
   * @param {string} path
   * @param {Record<string, string>} [query]
   * @param {{ projectId?: string | null }} [options]
   */
  async _get(path, query, options = {}) {
    const url = query ? `${path}?${new URLSearchParams(query)}` : path
    return this._request('GET', url, null, options)
  }

  /**
   * @param {string} path
   * @param {object} body
   * @param {{ projectId?: string | null }} [options]
   */
  async _post(path, body, options = {}) { return this._request('POST', path, body, options) }

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

  /**
   * Atomically insert a new version and transition the prior ACTIVE version to
   * SUPERSEDED in a single PostgreSQL transaction (Gap 3).
   *
   * Replaces the legacy two-call pattern (insertVersion → transitionVersionStatus)
   * which left a race window where two ACTIVE rows could coexist for the same
   * topic:key. The gateway's UPDATE is guarded by `status = 'ACTIVE'`, so a
   * concurrent supersession lands rows_updated=0 — callers can detect it.
   *
   * @param {Record<string, unknown>} newVersionRecord - Full version row to insert.
   * @param {number} supersedesVersion - Version number of the row being superseded.
   * @param {string} supersedesReason - Reason for supersession (governance audit).
   * @param {{ supersededByVersion: number, supersededByAuthor: string } | null} forwardLink
   * @returns {Promise<{ inserted: boolean, superseded_version: number, rows_updated: number }>}
   */
  async atomicSupersede(newVersionRecord, supersedesVersion, supersedesReason, forwardLink) {
    return this._post('/pg/versions/supersede', {
      new_version: newVersionRecord,
      supersedes_version: supersedesVersion,
      supersedes_reason: supersedesReason,
      forward_link: forwardLink,
    })
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

  async getPendingDecisionById(conflictId) {
    return this._get(`/pg/pending/${enc(conflictId)}`)
  }

  // ── Draft / status version queries ────────────────────────────────────────

  async getLatestDraftVersion(topic, key) {
    return this._get(`/pg/versions/latest-draft/${enc(topic)}/${enc(key)}`)
  }

  async getVersionsByStatus(status, { topic } = {}) {
    const query = {}
    if (topic) query.topic = topic
    return this._get(`/pg/versions/by-status/${enc(status)}`, Object.keys(query).length ? query : undefined)
  }

  async getVersionStatusCounts({ topic } = {}) {
    const query = {}
    if (topic) query.topic = topic
    return this._get('/pg/versions/status-counts', Object.keys(query).length ? query : undefined)
  }

  async getDraftVersions({ topic } = {}) {
    const query = {}
    if (topic) query.topic = topic
    return this._get('/pg/versions/drafts', Object.keys(query).length ? query : undefined)
  }

  // ── Keyword search (ILIKE fallback) ───────────────────────────────────────

  /**
   * Keyword search (ILIKE) fallback — used when Graphiti returns 0 results.
   * Backed by GET /pg/search on the gateway; results are scoped by the project
   * claim attached to the current JWT.
   *
   * @param {string} query - Free-text search term matched against topic/key/summary.
   * @param {{ domain?: string, limit?: number }} [options]
   * @returns {Promise<{ results: Array<object>, total: number, source: string }>}
   */
  async searchByText(query, options = {}) {
    const params = new URLSearchParams({ q: query })
    if (options.domain) params.set('domain', options.domain)
    if (options.limit)  params.set('limit',  String(options.limit))
    return this._get(`/pg/search?${params}`)
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
 * Accepts an optional gatewayUrl parameter — if the URL differs from the
 * current client's URL, the singleton is recreated for the new URL.
 * Returns null when neither gatewayUrl nor QUORUM_GATEWAY_URL is set.
 * Authentication state is separate — check isAuthenticated() before tool calls.
 * @param {string} [gatewayUrl] - Optional gateway URL override (from ctx)
 * @returns {GatewayClient | null}
 */
export function getGatewayClient(gatewayUrl) {
  const url = gatewayUrl ?? process.env.QUORUM_GATEWAY_URL
  if (!url) return null

  // Recreate client if URL has changed (project switch between calls)
  if (_client && _client._gatewayUrl !== url) _client = null
  if (!_client) _client = new GatewayClient(url)
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
