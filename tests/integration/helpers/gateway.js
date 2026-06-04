/**
 * HTTP seed helpers for MCP integration tests.
 *
 * These helpers call the gateway REST API directly (bypassing MCP) to seed
 * database state before tests exercise the MCP tools. Uses Node 22 built-in
 * fetch — no external HTTP library needed.
 *
 * All write operations use the /pg/versions admin bypass endpoint so seeds
 * land as ACTIVE immediately without going through governance rules.
 */

const BASE = process.env.QUORUM_GATEWAY_URL ?? 'http://localhost:3001';
export const TEST_PROJECT = 'quorum-test-project';
export const PEER_PROJECT = 'quorum-test-peer-project';
export const CATALOG_PROJECT = 'quorum-test-catalog';

/**
 * Make an authenticated HTTP request to the gateway.
 *
 * @param {string} method
 * @param {string} path
 * @param {string} token - Bearer JWT
 * @param {string} project - X-Quorum-Project header value
 * @param {object} [body]
 * @returns {Promise<{ status: number, data: any }>}
 */
async function gw(method, path, token, project, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Quorum-Project': project,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

/**
 * Seed an ACTIVE knowledge entry via the admin /pg/versions bypass.
 *
 * @param {string} token - Admin or PA JWT
 * @param {string} project
 * @param {{ topic: string, key: string, content: string, entity_type?: string }} opts
 * @returns {Promise<{ status: number, data: any }>}
 */
export async function activeEntry(token, project, { topic, key, content, entity_type = 'Decision' }) {
  const res = await gw('POST', '/pg/versions', token, project, {
    topic,
    key,
    summary: content,  // gateway validates req.body.summary for content field
    entity_type,
    triggered_by: 'integration-test-seed',
    agent_id: 'integration-seed',
    session_id: 'sess_test0000',
    confidence: 0.9,
    reason: 'Integration test seed entry',
  });
  if (res.status !== 201) {
    throw new Error(`activeEntry: ${res.status} - ${JSON.stringify(res.data)}`);
  }
  return res;
}

/**
 * Seed a DRAFT knowledge entry via the /api/knowledge engineer endpoint.
 *
 * @param {string} token - Engineer JWT
 * @param {string} project
 * @param {{ topic: string, key: string, content: string }} opts
 * @returns {Promise<{ status: number, data: any }>}
 */
export async function draftEntry(token, project, { topic, key, content }) {
  return gw('POST', '/api/knowledge', token, project, {
    topic,
    key,
    content,
    entity_type: 'Decision',
    triggered_by: 'integration-test-seed',
    reason: 'Integration test draft entry',
    confidence: 0.7,
  });
}

/**
 * GET the current ACTIVE version for a key.
 *
 * @param {string} token
 * @param {string} project
 * @param {string} key
 * @returns {Promise<{ status: number, data: any }>}
 */
export async function getEntry(token, project, key) {
  return gw('GET', `/api/knowledge/${encodeURIComponent(key)}`, token, project, undefined);
}

/**
 * GET deviations for a project.
 *
 * @param {string} token
 * @param {string} project
 * @param {URLSearchParams|object} [params]
 * @returns {Promise<{ status: number, data: any }>}
 */
export async function getDeviations(token, project, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return gw('GET', `/api/deviations${qs ? `?${qs}` : ''}`, token, project, undefined);
}

/**
 * Seed a pending conflict record directly into pending_decisions via POST /pg/pending.
 * First creates an ACTIVE entry at topic:key (so q_key_id exists), then inserts
 * the conflict record with _conflict_parties in the enrichment for no-self-approval tests.
 *
 * The gateway pins `author` to the JWT sub of `token`, so callers that need a
 * PA other than test-pe to be the existing author should pass `pe2Token()`.
 *
 * @param {string} token - PA JWT (must have ACTIVE write authority)
 * @param {string} project
 * @param {{ topic: string, key: string, existingContent: string, incomingContent: string, incomingAuthor?: string, reason?: string }} opts
 * @returns {Promise<{ conflict_id: string }>}
 */
export async function conflictEntry(token, project, {
  topic,
  key,
  existingContent,
  incomingContent,
  incomingAuthor = 'test-engineer',
  reason = 'Integration test conflict for resolution path testing',
}) {
  await activeEntry(token, project, { topic, key, content: existingContent });

  const res = await gw('POST', '/pg/pending', token, project, {
    conflict_topic: topic,
    conflict_key: key,
    existing_content: existingContent,
    incoming_content: incomingContent,
    conflict_reason: reason,
    active_version_at_creation: 1,
    enrichment: {
      _conflict_parties: {
        incoming_author: incomingAuthor,
      },
    },
  });

  if (res.status !== 201) {
    throw new Error(`conflictEntry: ${res.status} - ${JSON.stringify(res.data)}`);
  }

  return { conflict_id: res.data.conflict_id };
}

/**
 * Generate a unique key with a timestamp suffix.
 * No cleanup needed — uid-prefixed keys are inert across test runs.
 *
 * @param {string} [prefix='test']
 * @returns {string}
 */
export function uid(prefix = 'test') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
