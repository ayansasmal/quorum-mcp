/**
 * Graphiti HTTP client.
 *
 * Graphiti is Python-only — it runs as a Docker sidecar and exposes an MCP
 * HTTP endpoint. Quorum never imports graphiti; it calls it like any HTTP service.
 *
 * All Graphiti delete methods are blocked here. Constitutional Rule 1 (no hard
 * deletes) is enforced at this layer: BLOCKED_METHODS is exported so the
 * constitutional test suite can verify the block is in place.
 *
 * Gateway mode: when QUORUM_GATEWAY_URL is set, Graphiti calls are proxied
 * through the gateway (/graphiti/*) instead of calling Graphiti directly.
 * The gateway injects the project claim as group_id automatically.
 *
 * Vendored-copy note: the gateway's gateway/src/shared/graph/client.js is a
 * copy of this file that runs INSIDE the gateway and reaches Graphiti directly.
 * It intentionally omits the `log` import and the gateway-client JWT attach
 * below — the gateway has no such modules. Keep that divergence when syncing;
 * the request hardening (required groupId, 30s timeout, session-init checks)
 * must stay identical in both copies.
 *
 * MCP session protocol (streamable-http transport):
 *   1. POST /mcp with method="initialize" → server returns Mcp-Session-Id header
 *   2. All subsequent tool calls include that header
 *   3. 400 responses indicate expired/invalid session → re-initialize and retry
 */

import { randomUUID } from 'crypto'
import { log } from '../logger.js'
import { getGatewayClient } from '../gateway/client.js'

const GRAPHITI_URL = process.env.GRAPHITI_URL || 'http://graphiti:8000'

// NOTE: In gateway mode (QUORUM_GATEWAY_URL set), MCP calls are forwarded
// through gateway/routes/graphiti.js, which sanitizes hyphens → underscores
// on group_id before reaching Graphiti. In direct mode (no gateway), this
// client talks to Graphiti directly, so we apply the same normalization
// locally via normalizeGroupId() as defense-in-depth. RediSearch — used by
// FalkorDB under Graphiti — treats `-` as a NOT operator inside query
// strings, so an un-normalized hyphenated group_id silently returns zero
// results from search_nodes / search_memory_facts.

/**
 * Normalize a group_id for RediSearch compatibility.
 *
 * Graphiti's schema accepts `^[a-zA-Z0-9_-]+$` but its internal RediSearch
 * tag/field filters reinterpret `-` as a NOT operator, silently filtering
 * out matching records. Replacing `-` with `_` keeps the ID stable, valid
 * under Graphiti's schema, and safe inside RediSearch.
 *
 * @param {string} id
 * @returns {string}
 */
export function normalizeGroupId(id) {
  return typeof id === 'string' ? id.replace(/-/g, '_') : id
}

/**
 * Dedicated Graphiti group ID for audit episodes.
 * Kept separate from GROUP_ID so audit records never appear in
 * normal knowledge searches (searchNodes / searchFacts).
 *
 * @type {string}
 */
export const AUDIT_GROUP_ID = 'quorum-audit'

/**
 * Returns the base URL for Graphiti calls.
 *
 * Routing precedence (first match wins):
 *   1. GRAPHITI_URL set → direct server-side access (gateway, job scripts).
 *      QUORUM_GATEWAY_URL is intentionally ignored: both vars can coexist in the
 *      same container environment (quorum.env is shared), but a process that has a
 *      direct Graphiti endpoint must never route through the external gateway proxy.
 *   2. QUORUM_GATEWAY_URL set → MCP client path: no direct Graphiti access, proxy
 *      all calls through <gatewayUrl>/graphiti (requires Bearer token).
 *   3. Neither set → fall back to GRAPHITI_URL default (http://graphiti:8000).
 *
 * @returns {{ baseUrl: string, useGateway: boolean }}
 */
function graphitiTarget() {
  if (process.env.GRAPHITI_URL) {
    return { baseUrl: process.env.GRAPHITI_URL, useGateway: false }
  }
  const gatewayUrl = process.env.QUORUM_GATEWAY_URL
  if (gatewayUrl) {
    return { baseUrl: `${gatewayUrl.replace(/\/$/, '')}/graphiti`, useGateway: true }
  }
  return { baseUrl: GRAPHITI_URL, useGateway: false }
}

/** Methods Graphiti exposes that Quorum must never call. */
export const BLOCKED_METHODS = new Set([
  'delete_episode',
  'delete_entity',
  'delete_edge',
  'purge',
  'purge_group',
  'remove',
  'drop',
  'truncate',
])

/**
 * Returns true if the given Graphiti method name is blocked by constitutional rule.
 * @param {string} method
 * @returns {boolean}
 */
export function isMethodBlocked(method) {
  return BLOCKED_METHODS.has(method.toLowerCase())
}

// ── Typed errors ──────────────────────────────────────────────────────────────

export class GraphitiConnectionError extends Error {
  /** @param {string} message @param {unknown} [cause] */
  constructor(message, cause) {
    super(message)
    this.name = 'GraphitiConnectionError'
    this.cause = cause
  }
}

export class GraphitiResponseError extends Error {
  /** @param {string} message @param {number} status @param {unknown} [body] */
  constructor(message, status, body) {
    super(message)
    this.name = 'GraphitiResponseError'
    this.status = status
    this.body = body
  }
}

// ── MCP session management ─────────────────────────────────────────────────────

/** Active MCP session ID (per process — one session shared across all tool calls). */
let _sessionId = null

/**
 * Initialize an MCP session with Graphiti via the streamable-http handshake.
 * Stores the returned Mcp-Session-Id for reuse on subsequent calls.
 *
 * @param {string} endpoint  — full URL to /mcp
 * @param {Record<string, string>} [authHeaders] — optional Authorization header
 * @returns {Promise<string>} the session ID
 */
async function initSession(endpoint, authHeaders = {}) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept':        'application/json, text/event-stream',
      ...authHeaders,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id:      1,
      method:  'initialize',
      params:  {
        protocolVersion: '2024-11-05',
        capabilities:    {},
        clientInfo:      { name: 'quorum', version: '1.0' },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new GraphitiConnectionError(
      `Graphiti session init failed (${res.status}): ${body}`)
  }
  const sessionId = res.headers.get('mcp-session-id')
  if (!sessionId) throw new GraphitiConnectionError('Graphiti MCP did not return a session ID')
  _sessionId = sessionId
  return sessionId
}

/**
 * Parse the MCP streamable-http response (SSE envelope or plain JSON).
 * Extracts the JSON-RPC result and returns the tool's structured output.
 *
 * @param {Response} response
 * @returns {Promise<unknown>}
 */
async function parseMcpResponse(response) {
  const text = await response.text()
  // SSE format: "event: message\ndata: {...}\n\n"
  const m = text.match(/^data: (.+)$/m)
  const envelope = m ? JSON.parse(m[1]) : JSON.parse(text)
  if (envelope.error) {
    throw new GraphitiResponseError(envelope.error.message, 400, envelope.error)
  }
  const result = envelope.result
  // Prefer structuredContent (machine-readable), fall back to parsed text content
  if (result?.structuredContent?.result !== undefined) return result.structuredContent.result
  if (result?.content?.[0]?.text) {
    try { return JSON.parse(result.content[0].text) } catch { return { message: result.content[0].text } }
  }
  return result
}

// ── Internal HTTP helpers ──────────────────────────────────────────────────────

/**
 * POST to Graphiti's MCP endpoint using JSON-RPC 2.0 over streamable-http.
 * Manages the MCP session automatically (initialize on first call, re-initialize on 400).
 * Retries connection errors with exponential backoff.
 *
 * @param {string} tool
 * @param {Record<string, unknown>} params
 * @param {number} [maxRetries=3]
 * @returns {Promise<unknown>}
 */
async function callGraphiti(tool, params, maxRetries = 3) {
  if (isMethodBlocked(tool)) {
    throw new Error(`ConstitutionalViolation[NO_HARD_DELETE]: Graphiti method '${tool}' is blocked`)
  }

  const { baseUrl, useGateway } = graphitiTarget()
  const endpoint = `${baseUrl}/mcp`
  log.debug('graphiti call', { tool, groupId: params.group_id, endpoint })

  // In gateway mode, attach JWT + X-Quorum-Project so the /graphiti/* proxy
  // can verify the token and inject group_id before forwarding to Graphiti.
  // Static import (not dynamic) ensures the same _runtimeToken singleton used
  // by authenticate() is read here — dynamic imports can create a second
  // module instance in bundled output, splitting the singleton.
  let authHeaders = {}
  if (useGateway) {
    const gwClient = getGatewayClient()
    if (gwClient) {
      try {
        const { token } = gwClient._getToken()
        authHeaders = { Authorization: `Bearer ${token}` }
        // X-Quorum-Project tells the gateway which project's group_id(s) are authorized —
        // the proxy (gateway/src/routes/graphiti.js) validates any group_id/group_ids the
        // caller supplies against that project's authorized set (project + its linked
        // globals) and only widens to the full set when the caller didn't scope the
        // request (confused-deputy guard: never expand, only narrow-or-default), so this
        // header must carry the real project, not a value parsed back out of the request
        // payload. Previously
        // read from params.group_id, but searchNodes/searchFacts (Wave B) send the
        // plural params.group_ids instead — that field was always undefined, so
        // this header silently never went out and every search_nodes /
        // search_memory_facts call in gateway mode 400'd on the proxy's own
        // "X-Quorum-Project header required" guard.
        const projectId = gwClient.getProjectId()
        if (projectId) authHeaders['X-Quorum-Project'] = projectId
      } catch (err) {
        throw new GraphitiConnectionError(
          `Graphiti call requires authentication — call authenticate() first: ${err.message}`, err)
      }
    }
  }

  let lastError
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Ensure a live MCP session exists before making the tool call
    if (!_sessionId) {
      try {
        await initSession(endpoint, authHeaders)
      } catch (err) {
        throw new GraphitiConnectionError(
          `Could not reach Graphiti at ${baseUrl}: ${err.message}`, err)
      }
    }

    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)))
    }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'Accept':         'application/json, text/event-stream',
          'Mcp-Session-Id': _sessionId,
          ...authHeaders,
        },
        // 90s, not 30s: heavily-federated calls (many linked global catalogs) are
        // genuinely still processing (per-group_id index checks + OpenAI embedding
        // round-trips) well past 30s. Graphiti-core fans these out concurrently per
        // group_id (handle_multiple_group_ids -> semaphore_gather, default cap 20),
        // not serially, but wall time still grows with how many group_ids are in
        // play since they share one FalkorDB connection pool.
        signal: AbortSignal.timeout(90_000),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id:      Date.now(),
          method:  'tools/call',
          params:  { name: tool, arguments: params },
        }),
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        log.error('graphiti response error', { tool, status: response.status, body, attempt })
        // 400 usually means a malformed request; 404 is Graphiti's "Session not found"
        // (e.g. after the Graphiti container restarts and drops its in-memory session
        // store) — both invalidate our cached session so the next attempt re-initializes.
        if (response.status === 400 || response.status === 404) _sessionId = null
        throw new GraphitiResponseError(
          `Graphiti responded ${response.status} for tool '${tool}'`,
          response.status,
          body,
        )
      }

      return await parseMcpResponse(response)
    } catch (err) {
      if (err instanceof GraphitiResponseError) {
        // Retry on 400/404 (session re-init) but not on other 4xx errors
        if ((err.status === 400 || err.status === 404) && attempt < maxRetries) { lastError = err; continue }
        throw err
      }
      lastError = new GraphitiConnectionError(
        `Could not reach Graphiti at ${baseUrl}: ${err.message}`,
        err,
      )
      log.error('graphiti connection error', { tool, error: lastError.message, attempt })
    }
  }

  throw lastError
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Store a new knowledge episode in Graphiti.
 * @param {string} content
 * @param {{ key: string, source: string, entityType?: string, tags?: string[] }} metadata
 * @param {string} groupId - project isolation namespace (required)
 * @param {string} [database] - physical FalkorDB database override (see
 *   migrated_to_shared_graph in QuorumConfigSchema); omitted preserves the default
 *   per-group_id database, unchanged from prior behavior
 * @returns {Promise<{ episode_id: string }>}
 */
export async function addEpisode(content, metadata, groupId, database) {
  if (!groupId) throw new Error('addEpisode: groupId is required')
  // NOTE: do NOT pass uuid to add_memory. In Graphiti 0.29+, providing uuid
  // means "retrieve existing episode with this UUID" — if the node doesn't
  // exist in FalkorDB (e.g. after a volume wipe), add_episode raises
  // NodeNotFoundError and the episode is never created.
  // A local tracking UUID is returned as episode_id and stored in
  // knowledge_versions.graphiti_episode_id, but it is NOT a real Graphiti UUID.
  //
  // normalizeGroupId: hyphens cause RediSearch (used by FalkorDB under
  // Graphiti) to interpret `-` as NOT, dropping matching records. In gateway
  // mode the proxy also normalizes; this is the direct-mode safeguard.
  const uuid = randomUUID()
  await callGraphiti('add_memory', {
    name:               metadata.key,
    episode_body:       content,
    group_id:           normalizeGroupId(groupId),
    source_description: metadata.source,
    ...(database !== undefined ? { database } : {}),
  })
  return { episode_id: uuid }
}

/**
 * Store a new version of a knowledge node AND create a SUPERSEDES edge in
 * Graphiti from the new episode to the old one. This builds the organic
 * evolution chain — traversable via getEvolutionChain().
 * @param {string} newContent
 * @param {string} oldEpisodeId
 * @param {{ key: string, source: string, entityType?: string, tags?: string[], reason?: string }} metadata
 * @param {string} groupId - project isolation namespace (required)
 * @param {string} [database] - physical FalkorDB database override, see addEpisode
 * @returns {Promise<{ episode_id: string }>}
 */
export async function addSupersedingEpisode(newContent, oldEpisodeId, metadata, groupId, database) {
  if (!groupId) throw new Error('addSupersedingEpisode: groupId is required')
  // Same reason as addEpisode — do not pass uuid; normalize group_id.
  const uuid = randomUUID()
  await callGraphiti('add_memory', {
    name:               metadata.key,
    episode_body:       `${newContent}\n\n[supersedes:${oldEpisodeId}] ${metadata.reason ?? 'updated'}`,
    group_id:           normalizeGroupId(groupId),
    source_description: metadata.source,
    ...(database !== undefined ? { database } : {}),
  })

  return { episode_id: uuid }
}

/**
 * Walk the SUPERSEDES edges from an episode back to the root, returning the
 * full organic evolution chain as an ordered array (newest first).
 * @param {string} episodeId
 * @param {string} groupId - project isolation namespace (required)
 * @returns {Promise<Array<{ episode_id: string, metadata: unknown }>>}
 */
export async function getEvolutionChain(episodeId, groupId) {
  if (!groupId) throw new Error('getEvolutionChain: groupId is required')
  const result = await callGraphiti('search_memory_facts', {
    query: `supersedes evolution chain for ${episodeId}`,
    group_ids: [normalizeGroupId(groupId)],
  }).catch(() => ({ facts: [] }))

  return result.facts ?? []
}

/**
 * Search for knowledge nodes semantically.
 *
 * Accepts a single groupId or an array of groupIds (e.g. [projectId, ...globals]).
 * All IDs are normalized (hyphen → underscore) via normalizeGroupId before being
 * sent to Graphiti. RediSearch — used internally by FalkorDB — treats `-` as a
 * NOT operator, so un-normalized hyphenated group_ids silently return zero results.
 * In gateway mode the proxy also normalizes; this is the direct-mode safeguard.
 *
 * @param {string} query
 * @param {{ limit?: number, groupIds?: string[], groupId?: string }} [options]
 * @returns {Promise<{ nodes: Array<unknown> }>}
 */
export async function searchNodes(query, options = {}) {
  // Resolve to an array: options.groupIds takes precedence over single options.groupId
  const ids = options.groupIds ?? (options.groupId ? [options.groupId] : null)
  const normalizedIds = ids?.map(normalizeGroupId).filter(Boolean)
  return callGraphiti('search_nodes', {
    query,
    max_nodes: options.limit ?? 10,
    ...(normalizedIds?.length ? { group_ids: normalizedIds } : {}),
  })
}

/**
 * Search for relationships/edges across the knowledge graph.
 *
 * Accepts a single groupId or an array of groupIds — see searchNodes for the
 * rationale (RediSearch NOT-operator collision on hyphenated IDs).
 *
 * @param {string} query
 * @param {{ groupIds?: string[], groupId?: string }} [options]
 * @returns {Promise<{ facts: Array<unknown> }>}
 */
export async function searchFacts(query, options = {}) {
  const ids = options.groupIds ?? (options.groupId ? [options.groupId] : null)
  const normalizedIds = ids?.map(normalizeGroupId).filter(Boolean)
  return callGraphiti('search_memory_facts', {
    query,
    ...(normalizedIds?.length ? { group_ids: normalizedIds } : {}),
  })
}

/**
 * List episodes in a group.
 *
 * Note: group_ids is intentionally NOT passed here. Graphiti's get_episodes
 * tool returns all episodes regardless; project isolation for this listing
 * is enforced upstream at the PostgreSQL layer (q_project_id). If we ever
 * pass group_ids here, the value must be run through normalizeGroupId() to
 * avoid the RediSearch hyphen-as-NOT issue (see searchNodes).
 *
 * @param {string} groupId - project isolation namespace (required)
 * @returns {Promise<{ episodes: Array<unknown> }>}
 */
export async function getEpisodes(groupId) {
  if (!groupId) throw new Error('getEpisodes: groupId is required')
  return callGraphiti('get_episodes', {})
}

/**
 * Soft-deprecate an episode by adding a new DEPRECATED marker episode.
 * Never calls Graphiti delete methods — constitutional rule enforced.
 * @param {string} episodeId
 * @param {{ key: string, reason: string, author: string }} meta
 * @param {string} groupId - project isolation namespace (required)
 */
export async function deleteEpisodeSoft(episodeId, meta, groupId) {
  if (!groupId) throw new Error('deleteEpisodeSoft: groupId is required')
  return callGraphiti('add_memory', {
    name:               `${meta.key}:deprecated`,
    episode_body:       `Knowledge deprecated by ${meta.author}. Reason: ${meta.reason}. Deprecated episode: ${episodeId}`,
    group_id:           normalizeGroupId(groupId),
    source_description: 'quorum:deprecation',
    uuid:               randomUUID(),
  })
}

/**
 * Ping Graphiti (or gateway) to verify connectivity.
 * In gateway mode, pings the gateway /health endpoint which checks Graphiti internally.
 * @returns {Promise<boolean>}
 */
export async function ping() {
  const { baseUrl, useGateway } = graphitiTarget()
  try {
    if (useGateway) {
      // The gateway health endpoint checks both PostgreSQL and Graphiti
      const gatewayBase = process.env.QUORUM_GATEWAY_URL.replace(/\/$/, '')
      const res = await fetch(`${gatewayBase}/health`)
      const data = await res.json()
      return data.components?.graphiti === 'connected'
    }
    await fetch(`${baseUrl}/health`)
    return true
  } catch {
    return false
  }
}
