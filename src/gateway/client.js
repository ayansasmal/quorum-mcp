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
import { clearIdentityCache } from '../identity/resolver.js'

const REFRESH_BUFFER_S = 60  // Treat token as expired 60s before actual expiry

// ── Module-level state ─────────────────────────────────────────────────────────

/** @type {GatewayClient | null} */
let _client = null

/** @type {string | null} Gateway-MCP Token (ES256 JWT) — set by authenticate() tool */
let _runtimeToken = null

/**
 * @typedef {Object} GatewayProfile
 * @property {string | null} [role]            - User role from profile cache (e.g. 'principal_architect')
 * @property {string | null} [team]            - User team from profile cache (e.g. 'platform')
 * @property {number | null} [base_confidence] - User base confidence weight from profile cache
 * @property {string | null} [project]         - Default project ID returned at authentication time
 */

/** @type {GatewayProfile | null} Server-side profile snapshot — set by authenticate() tool */
let _runtimeProfile = null

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
    // v0.3: JWT is slim — role/team/base_confidence come from profile cache server-side.
    // The authenticate() tool stores the profile snapshot it receives in the token-exchange
    // response body via setGatewayProfile(); merge it here so enforceReviewerTeam() etc. work.
    const profile = _runtimeProfile ?? {}
    return {
      name:            p.sub ?? 'unknown',
      is_admin:        p.is_admin ?? false,
      team:            profile.team ?? null,
      role:            profile.role ?? null,
      base_confidence: profile.base_confidence ?? 0.7,
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
      signal: AbortSignal.timeout(30_000),
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    })

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}))
      log.error('gateway request failed', { method, path, status: response.status, body: errBody })
      const err = new Error(`Gateway ${method} ${path} failed (${response.status}): ${errBody.message ?? response.statusText}`)
      err.status = response.status
      err.body   = errBody
      throw err
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
    if (opts.topic) query.topic = opts.topic
    if (opts.include_stale || (Array.isArray(opts.statuses) && opts.statuses.includes('stale'))) {
      query.include_stale = 'true'
    }
    return this._get('/pg/pending', Object.keys(query).length ? query : undefined)
  }

  async insertPendingDecision(decision) {
    const row = await this._post('/pg/pending', decision)
    return row?.conflict_id ?? row
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

  // ── Deviations ─────────────────────────────────────────────────────────────

  /**
   * Record a deviation from a linked global catalog entry.
   * Delegates all business logic (catalog validation, severity computation,
   * idempotent upsert) to the gateway.
   *
   * @param {{
   *   catalog_id:  string,
   *   topic:       string,
   *   key:         string,
   *   description: string,
   *   evidence:    object | null,
   *   source:      string,
   *   author:      string,
   * }} record
   * @returns {Promise<{ status: string, deviation_id?: string, severity?: number, is_new?: boolean, message: string }>}
   */
  async recordDeviation(record) {
    return this._post('/api/deviations', record)
  }

  /**
   * List deviations for the current project with optional filters.
   * @param {{ status?: string, catalog_id?: string, topic?: string, severity_min?: number,
   *            source?: string, limit?: number, offset?: number }} [filters]
   * @returns {Promise<{ deviations: Array<object>, total: number }>}
   */
  async getDeviations(filters = {}) {
    const params = new URLSearchParams()
    if (filters.status)       params.set('status',       filters.status)
    if (filters.catalog_id)   params.set('catalog_id',   filters.catalog_id)
    if (filters.topic)        params.set('topic',         filters.topic)
    if (filters.severity_min !== undefined) params.set('severity_min', String(filters.severity_min))
    if (filters.source)       params.set('source',        filters.source)
    if (filters.limit)        params.set('limit',          String(filters.limit))
    if (filters.offset)       params.set('offset',         String(filters.offset))
    return this._get(`/api/deviations?${params}`)
  }

  // ── Conformance + portfolio ────────────────────────────────────────────────

  /**
   * Project conformance scorecard.
   * @returns {Promise<{
   *   score: number|null, status: 'CERTIFIED'|'UNCERTIFIED',
   *   applicable_entries: number, scan_count: number, last_scan_at: string|null,
   *   breakdown: object, catalogs: Array<{catalog_id: string, entry_count: number}>
   * }>}
   */
  async getConformance() {
    return this._get('/api/conformance')
  }

  /**
   * Portfolio view — conformance scores for all accessible projects.
   * @param {{ node_id?: string }} [opts]
   * @returns {Promise<{ projects: Array<object>, rollup: object|null }>}
   */
  async getPortfolio(opts = {}) {
    const params = new URLSearchParams()
    if (opts.node_id) params.set('node_id', opts.node_id)
    const qs = params.toString()
    return this._get(`/api/portfolio${qs ? `?${qs}` : ''}`)
  }

  // ── Governance LLM calls ──────────────────────────────────────────────────

  /**
   * Ask the gateway LLM whether two knowledge entries contradict each other.
   * @param {{ content: string, author: string, confidence: number }} existing
   * @param {{ content: string, author: string, confidence: number }} incoming
   * @returns {Promise<{ contradicts: boolean, reason: string, possible_split: boolean, split_suggestion?: string }>}
   */
  async detectConflict(existing, incoming) {
    return this._post('/governance/detect-conflict', { existing, incoming })
  }

  /**
   * Generate reviewer enrichment (analysis, risks, questions) for a pending conflict.
   * @param {string} existing
   * @param {string} incoming
   * @param {string} conflictReason
   * @param {boolean} possibleSplit
   * @param {string | null} splitSuggestion
   * @returns {Promise<Record<string, unknown>>}
   */
  async enrichConflict(existing, incoming, conflictReason, possibleSplit, splitSuggestion) {
    return this._post('/governance/enrich', {
      existing,
      incoming,
      conflict_reason: conflictReason,
      possible_split: possibleSplit,
      split_suggestion: splitSuggestion ?? null,
    })
  }

  /**
   * Extract learnable knowledge from a task summary via the gateway LLM.
   * @param {string} taskSummary
   * @param {string[]} decisionsMade
   * @param {string[]} patternsUsed
   * @param {string[]} [constraints]
   * @returns {Promise<{ items: Array<object> }>}
   */
  async extractKnowledge(taskSummary, decisionsMade, patternsUsed, constraints) {
    const body = {
      task_summary:   taskSummary,
      decisions_made: decisionsMade,
      patterns_used:  patternsUsed,
    }
    if (constraints && constraints.length > 0) {
      body.constraints = constraints
    }
    return this._post('/governance/extract', body)
  }

  /**
   * Upload a project config to the gateway for onboarding.
   * @param {Record<string, unknown>} configData - Parsed quorum.config.json content
   * @returns {Promise<{ project_id: string, q_project_id?: string, message: string }>}
   */
  async uploadConfig(configData) {
    return this._post('/config/upload', configData)
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
 * Clears the identity cache so stale profiles are not used after re-authentication.
 * @param {string | null} token - Gateway-MCP Token (ES256 JWT) or null to clear
 */
export function setGatewayToken(token) {
  _runtimeToken = token
  _runtimeProfile = null
  clearIdentityCache()
}

/** Backward-compatible alias for setGatewayToken. */
export const setRuntimeToken = setGatewayToken

/**
 * Store the user profile snapshot returned by the gateway's token-exchange response.
 *
 * v0.3 JWTs are slim ({ sub, is_admin }) — role/team/base_confidence are no longer
 * embedded as claims. The gateway returns them in the OAuth token response body so
 * the MCP can attach them to identity for tool-side governance checks (e.g.
 * enforceReviewerTeam). Profile is in-memory only and cleared when the process
 * restarts or on explicit reset.
 *
 * @param {GatewayProfile | null} profile - Profile snapshot or null to clear
 */
export function setGatewayProfile(profile) {
  _runtimeProfile = profile
}

/**
 * Return the cached profile snapshot stored by the most recent authenticate() call.
 *
 * Returns null when no profile has been stored yet (e.g. before authenticate()
 * completes, or after a process restart). Callers must not rely on this for
 * authorization decisions — the gateway re-resolves the profile on every request.
 *
 * @returns {GatewayProfile | null}
 */
export function getGatewayProfile() {
  return _runtimeProfile
}

/**
 * Return the current Gateway-MCP token held in memory, or null if not set.
 * Used by test helpers to snapshot and restore token state across nested client creations.
 * @returns {string | null}
 */
export function getGatewayToken() {
  return _runtimeToken
}

/** Reset singleton — for testing only. */
export function _resetGatewayClient() {
  _client         = null
  _runtimeToken   = null
  _runtimeProfile = null
}

/** URL-encode a path segment. */
function enc(s) { return encodeURIComponent(s) }
