/**
 * PostgreSQL queries for the q_* schema (greenfield).
 *
 * All writes are INSERT-only except `transitionVersionStatus()` (status field),
 * `recordBump()` (insert into bump_log), `incrementDomainStat()` (UPSERT counters),
 * `resolvePendingDecision()` / `markPendingDecisionStale()` (narrow updates on
 * pending_decisions), and `updateConfidence()` / `updateLastAccessed()` on
 * knowledge_versions — all gated by GRANT UPDATE on the specific columns.
 *
 * The duck-typing guards (`typeof pg.<fn> === 'function'`) are preserved so the
 * GatewayClient short-circuit in the MCP continues to work in gateway mode.
 *
 * Identifier conventions:
 *   q_p{n}        Quorum project   e.g. q_p1
 *   q_k{n}        Knowledge entry  e.g. q_k198
 *   q_k{n}_v{m}   Version ID       e.g. q_k198_v3 (PRIMARY KEY of knowledge_versions)
 *   q_c{n}        Conflict ID      e.g. q_c7
 *
 * `q_key_id` replaces the legacy (project_id, topic, key) triple. `topic` and
 * `key` are denormalised onto knowledge_versions for display only.
 *
 * NOTE for MCP integration:
 *   GLOBAL_PROJECT_ID (used by remember.js for cross-project policy writes)
 *   should map to 'q_p0' — the seeded global namespace project.
 */

import { KnowledgeStatus } from './schema.js'

// ── Project + key registry ────────────────────────────────────────────────────

/**
 * Create a new project row. Allocates a fresh q_p{n} id from the sequence.
 * @param {import('pg').Pool} pg
 * @param {string} groupId      Display-only identifier (e.g. 'amethyst_munchkin')
 * @param {string} owner        GitHub username of the project owner
 * @param {Array<Record<string,unknown>>} [members=[]]
 * @param {Record<string,unknown>} [governance={}]
 * @param {{ displayName?: string, domains?: Array<Record<string,unknown>>, createdBy?: string }} [opts]
 * @returns {Promise<string>} q_project_id (e.g. 'q_p1')
 */
export async function createProject(pg, groupId, owner, members = [], governance = {}, opts = {}) {
  if (typeof pg.createProject === 'function') {
    return pg.createProject(groupId, owner, members, governance, opts)
  }
  const seq = await pg.query(`SELECT nextval('q_project_seq') AS n`)
  const qProjectId = `q_p${seq.rows[0].n}`
  const { rows } = await pg.query(
    `INSERT INTO q_projects (q_project_id, group_id, display_name, owner, members, domains, governance, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING q_project_id`,
    [
      qProjectId,
      groupId,
      opts.displayName ?? null,
      owner,
      JSON.stringify(members),
      JSON.stringify(opts.domains ?? []),
      JSON.stringify(governance),
      opts.createdBy ?? owner,
    ],
  )
  return rows[0].q_project_id
}

/**
 * Look up a project's q_project_id by its display-only group_id.
 * @param {import('pg').Pool} pg
 * @param {string} groupId
 * @returns {Promise<string | null>}
 */
export async function getProjectByGroupId(pg, groupId) {
  if (typeof pg.getProjectByGroupId === 'function') return pg.getProjectByGroupId(groupId)
  const { rows } = await pg.query(
    `SELECT q_project_id FROM q_projects WHERE group_id = $1 LIMIT 1`,
    [groupId],
  )
  return rows[0]?.q_project_id ?? null
}

/**
 * Get-or-create the q_key_id for a (project, topic, key) triple.
 * This is called by routes/tools before any version / pending / bump operation.
 * @param {import('pg').Pool} pg
 * @param {string} qProjectId   e.g. 'q_p1'
 * @param {string} topic
 * @param {string} key
 * @returns {Promise<string>}   e.g. 'q_k198'
 */
export async function getOrCreateKey(pg, qProjectId, topic, key) {
  if (typeof pg.getOrCreateKey === 'function') return pg.getOrCreateKey(qProjectId, topic, key)
  const qKeyId = `q_k${(await pg.query(`SELECT nextval('q_key_seq') AS n`)).rows[0].n}`
  const { rows } = await pg.query(
    `INSERT INTO q_keys (q_key_id, q_project_id, topic, key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (q_project_id, topic, key) DO UPDATE SET key = EXCLUDED.key
     RETURNING q_key_id`,
    [qKeyId, qProjectId, topic, key],
  )
  return rows[0].q_key_id
}

// ── Version queries (keyed by q_key_id / version_id) ──────────────────────────

/**
 * Get the currently ACTIVE version for a topic:key.
 * Delegates to the GatewayClient — MCP never connects to PostgreSQL directly.
 *
 * @param {import('./schema.js').GatewayClient} pg
 * @param {string} topic
 * @param {string} key
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getCurrentVersion(pg, topic, key) {
  return pg.getCurrentVersion(topic, key)
}

/**
 * Get the version that was ACTIVE on a specific date (point-in-time recall).
 * Delegates to the GatewayClient — MCP never connects to PostgreSQL directly.
 *
 * @param {import('./schema.js').GatewayClient} pg
 * @param {string} topic
 * @param {string} key
 * @param {string} date - ISO date string
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getVersionAtDate(pg, topic, key, date) {
  return pg.getVersionAtDate(topic, key, date)
}

/**
 * Get all versions for a topic:key, ordered newest first.
 * Delegates to the GatewayClient — MCP never connects to PostgreSQL directly.
 *
 * @param {import('./schema.js').GatewayClient} pg
 * @param {string} topic
 * @param {string} key
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function getVersionHistory(pg, topic, key) {
  return pg.getVersionHistory(topic, key)
}

/**
 * Get a specific version of a topic:key.
 * Delegates to the GatewayClient — MCP never connects to PostgreSQL directly.
 *
 * @param {import('./schema.js').GatewayClient} pg
 * @param {string} topic
 * @param {string} key
 * @param {number} version
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getSpecificVersion(pg, topic, key, version) {
  return pg.getSpecificVersion(topic, key, version)
}

/**
 * Get the next version number for a topic:key. Returns 1 if no versions exist yet.
 * Delegates to the GatewayClient — MCP never connects to PostgreSQL directly.
 *
 * @param {import('./schema.js').GatewayClient} pg
 * @param {string} topic
 * @param {string} key
 * @returns {Promise<number>}
 */
export async function getNextVersionNumber(pg, topic, key) {
  return pg.getNextVersionNumber(topic, key)
}

/**
 * Insert a new version record. Append-only — never call UPDATE.
 *
 * `record.version_id` (q_k{n}_v{m}) must be set by the caller as the PRIMARY KEY.
 * `record.q_key_id` and `record.q_project_id` are required.
 * `record.topic` and `record.key` are denormalised for display.
 *
 * @param {import('pg').Pool} pg
 * @param {Record<string, unknown>} record
 * @returns {Promise<Record<string, unknown>>}
 */
export async function insertVersion(pg, record) {
  if (typeof pg.insertVersion === 'function') return pg.insertVersion(record)
  if (!record.version_id)   throw new Error('insertVersion: record.version_id is required')
  if (!record.q_key_id)     throw new Error('insertVersion: record.q_key_id is required')
  if (!record.q_project_id) throw new Error('insertVersion: record.q_project_id is required')
  const result = await pg.query(
    `INSERT INTO knowledge_versions (
      version_id, q_key_id, q_project_id, version, topic, key,
      summary, status, confidence, starting_confidence,
      entity_type, author, author_role, tags, triggered_by, content_hash,
      graphiti_episode_id, supersedes_version, supersedes_reason,
      forward_link, created_by_audit, last_accessed_at, created_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,
      $7,$8,$9,$10,
      $11,$12,$13,$14,$15,$16,
      $17,$18,$19,
      $20,$21,$22,$23
    )
    RETURNING *`,
    [
      record.version_id,
      record.q_key_id,
      record.q_project_id,
      record.version,
      record.topic,
      record.key,
      record.content ?? record.summary ?? '',
      record.status,
      record.confidence          ?? 0.7,
      record.starting_confidence ?? record.confidence ?? 0.7,
      record.entity_type         ?? 'unknown',
      record.author,
      record.author_role         ?? 'unknown',
      record.tags                ?? [],
      record.triggered_by,
      record.content_hash,
      record.graphiti_episode_id ?? null,
      record.supersedes_version  ?? null,
      record.supersedes_reason   ?? null,
      record.forward_link
        ? (typeof record.forward_link === 'string' ? record.forward_link : JSON.stringify(record.forward_link))
        : null,
      record.created_by_audit    ?? null,
      record.last_accessed_at    ?? null,
      record.created_at          ?? new Date().toISOString(),
    ],
  )
  return result.rows[0]
}

/**
 * Get all ACTIVE versions matching a tag, scoped to a project.
 * @param {import('pg').Pool} pg
 * @param {string} tag - Normalised (lowercase, trimmed) tag
 * @param {string} qProjectId
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function getVersionsByTag(pg, tag, qProjectId) {
  if (typeof pg.getVersionsByTag === 'function') return pg.getVersionsByTag(tag, qProjectId)
  const result = await pg.query(
    `SELECT * FROM knowledge_versions
     WHERE q_project_id = $1 AND $2 = ANY(tags) AND status = 'ACTIVE'
     ORDER BY created_at DESC`,
    [qProjectId, tag.toLowerCase().trim()],
  )
  return result.rows
}

/**
 * Transition a version's status and optionally set the forward link.
 * Delegates to the GatewayClient — MCP never connects to PostgreSQL directly.
 *
 * @param {import('./schema.js').GatewayClient} pg
 * @param {string} topic
 * @param {string} key
 * @param {number} version
 * @param {string} newStatus
 * @param {{ version?: number, author?: string, at?: string } | null} [forwardLink]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function transitionVersionStatus(pg, topic, key, version, newStatus, forwardLink = null) {
  return pg.transitionVersionStatus(topic, key, version, newStatus, forwardLink)
}

/**
 * Insert a version ↔ audit cross-reference link.
 * @param {import('pg').Pool} pg
 * @param {{ auditEntryId: string, versionId: string, qKeyId: string, linkType: 'created'|'superseded' }} record
 */
export async function insertVersionAuditLink(pg, record) {
  if (typeof pg.insertVersionAuditLink === 'function') return pg.insertVersionAuditLink(record)
  await pg.query(
    `INSERT INTO version_audit_links (audit_entry_id, version_id, q_key_id, link_type, created_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [record.auditEntryId, record.versionId, record.qKeyId, record.linkType],
  )
}

/**
 * Get the latest DRAFT version for a topic:key (for review flow).
 * Delegates to the GatewayClient — MCP never connects to PostgreSQL directly.
 *
 * @param {import('./schema.js').GatewayClient} pg
 * @param {string} topic
 * @param {string} key
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getLatestDraftVersion(pg, topic, key) {
  return pg.getLatestDraftVersion(topic, key)
}

/**
 * Get all versions for a status, optionally filtered by topic, within a project.
 * @param {import('pg').Pool} pg
 * @param {string} status
 * @param {string} qProjectId
 * @param {string} [topic]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function getVersionsByStatus(pg, status, qProjectId, topic) {
  if (typeof pg.getVersionsByStatus === 'function') return pg.getVersionsByStatus(status, qProjectId, topic)
  if (topic) {
    const result = await pg.query(
      `SELECT * FROM knowledge_versions
       WHERE q_project_id = $1 AND topic = $2 AND status = $3
       ORDER BY topic, key`,
      [qProjectId, topic, status],
    )
    return result.rows
  }
  const result = await pg.query(
    `SELECT * FROM knowledge_versions
     WHERE q_project_id = $1 AND status = $2
     ORDER BY topic, key`,
    [qProjectId, status],
  )
  return result.rows
}

/**
 * Version count grouped by status (for export stats).
 * @param {import('pg').Pool} pg
 * @param {string} qProjectId
 * @param {string} [topic]
 * @returns {Promise<Record<string, number>>}
 */
export async function getVersionStatusCounts(pg, qProjectId, topic) {
  if (typeof pg.getVersionStatusCounts === 'function') return pg.getVersionStatusCounts(qProjectId, topic)
  const result = topic
    ? await pg.query(
        `SELECT status, COUNT(*)::int AS count FROM knowledge_versions
         WHERE q_project_id = $1 AND topic = $2 GROUP BY status`,
        [qProjectId, topic],
      )
    : await pg.query(
        `SELECT status, COUNT(*)::int AS count FROM knowledge_versions
         WHERE q_project_id = $1 GROUP BY status`,
        [qProjectId],
      )
  return Object.fromEntries(result.rows.map((r) => [r.status, r.count]))
}

/**
 * Get DRAFT knowledge versions awaiting review, optionally topic-filtered.
 * @param {import('pg').Pool} pg
 * @param {{ qProjectId: string, topic?: string }} options
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function getDraftVersions(pg, { qProjectId, topic } = {}) {
  if (typeof pg.getDraftVersions === 'function') return pg.getDraftVersions({ qProjectId, topic })
  if (topic) {
    const result = await pg.query(
      `SELECT * FROM knowledge_versions
       WHERE q_project_id = $1 AND topic = $2 AND status = 'DRAFT'
       ORDER BY created_at ASC`,
      [qProjectId, topic],
    )
    return result.rows
  }
  const result = await pg.query(
    `SELECT * FROM knowledge_versions
     WHERE q_project_id = $1 AND status = 'DRAFT'
     ORDER BY created_at ASC`,
    [qProjectId],
  )
  return result.rows
}

// ── pending_decisions queries ─────────────────────────────────────────────────

/**
 * Fetch pending decisions, optionally filtered by q_key_id and status array.
 * @param {import('pg').Pool} pg
 * @param {{ qProjectId: string, qKeyId?: string, statuses?: string[], decisionType?: string }} options
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function getPendingDecisions(pg, { qProjectId, qKeyId, statuses = ['pending'], decisionType = 'conflict' } = {}) {
  if (typeof pg.getPendingDecisions === 'function') {
    return pg.getPendingDecisions({ qProjectId, qKeyId, statuses, decisionType })
  }
  if (qKeyId) {
    const result = await pg.query(
      `SELECT * FROM pending_decisions
       WHERE q_project_id = $1 AND status = ANY($2) AND decision_type = $3 AND q_key_id = $4
       ORDER BY created_at ASC`,
      [qProjectId, statuses, decisionType, qKeyId],
    )
    return result.rows
  }
  const result = await pg.query(
    `SELECT * FROM pending_decisions
     WHERE q_project_id = $1 AND status = ANY($2) AND decision_type = $3
     ORDER BY created_at ASC`,
    [qProjectId, statuses, decisionType],
  )
  return result.rows
}

/**
 * Count pending decisions for a specific topic:key (ordering context).
 * Delegates to the GatewayClient — MCP never connects to PostgreSQL directly.
 *
 * @param {import('./schema.js').GatewayClient} pg
 * @param {string} topic
 * @param {string} key
 * @returns {Promise<number>}
 */
export async function countPendingForKey(pg, topic, key) {
  return pg.countPendingForKey(topic, key)
}

/**
 * Fetch a single pending decision by conflict ID. conflict_id is globally unique
 * (q_c{n}) so no project scoping is needed.
 * @param {import('pg').Pool} pg
 * @param {string} conflictId
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getPendingDecisionById(pg, conflictId) {
  if (typeof pg.getPendingDecisionById === 'function') return pg.getPendingDecisionById(conflictId)
  const result = await pg.query(
    `SELECT * FROM pending_decisions WHERE conflict_id = $1 AND status = 'pending'`,
    [conflictId],
  )
  return result.rows[0] ?? null
}

/**
 * Insert a new pending decision record. Allocates a fresh q_c{n} id from the
 * sequence if `record.conflict_id` is not provided.
 *
 * @param {import('pg').Pool} pg
 * @param {Record<string, unknown>} record - requires q_key_id, q_project_id
 * @returns {Promise<string>} conflict_id (e.g. 'q_c7')
 */
export async function insertPendingDecision(pg, record) {
  if (typeof pg.insertPendingDecision === 'function') return pg.insertPendingDecision(record)
  if (!record.q_key_id)     throw new Error('insertPendingDecision: record.q_key_id is required')
  if (!record.q_project_id) throw new Error('insertPendingDecision: record.q_project_id is required')

  let conflictId = record.conflict_id
  if (!conflictId) {
    const seq = await pg.query(`SELECT nextval('q_conflict_seq') AS n`)
    conflictId = `q_c${seq.rows[0].n}`
  }

  await pg.query(
    `INSERT INTO pending_decisions
       (conflict_id, q_key_id, q_project_id, decision_type,
        active_version_at_creation, existing_content, incoming_content,
        conflict_reason, enrichment, more_pending_same_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      conflictId,
      record.q_key_id,
      record.q_project_id,
      record.decision_type ?? 'conflict',
      record.active_version_at_creation ?? null,
      record.existing_content ?? null,
      record.incoming_content ?? null,
      record.conflict_reason  ?? null,
      record.enrichment == null
        ? null
        : (typeof record.enrichment === 'string' ? record.enrichment : JSON.stringify(record.enrichment)),
      record.more_pending_same_key ?? 0,
    ],
  )
  return conflictId
}

/**
 * Resolve or update a pending decision. conflict_id is globally unique so no
 * project_id scoping is required.
 *
 * @param {import('pg').Pool} pg
 * @param {string} conflictId
 * @param {{ status: string, resolution: string, note: string, resolvedBy: string,
 *           splitExistingKey?: string|null, splitIncomingKey?: string|null,
 *           splitExistingContent?: string|null, splitIncomingContent?: string|null,
 *           mergedContent?: string|null }} updates
 */
export async function resolvePendingDecision(pg, conflictId, updates) {
  if (typeof pg.updatePendingDecision === 'function') return pg.updatePendingDecision(conflictId, updates)
  await pg.query(
    `UPDATE pending_decisions
     SET status = $1, resolution = $2, resolution_note = $3, resolved_by = $4,
         resolved_at = NOW(), updated_at = NOW(),
         split_existing_key = $5, split_incoming_key = $6,
         split_existing_content = $7, split_incoming_content = $8,
         merged_content = $9
     WHERE conflict_id = $10`,
    [
      updates.status,
      updates.resolution,
      updates.note,
      updates.resolvedBy,
      updates.splitExistingKey     ?? null,
      updates.splitIncomingKey     ?? null,
      updates.splitExistingContent ?? null,
      updates.splitIncomingContent ?? null,
      updates.mergedContent        ?? null,
      conflictId,
    ],
  )
}

/**
 * Mark a pending decision as stale (the underlying active version has advanced
 * since the conflict was raised). conflict_id is globally unique.
 *
 * @param {import('pg').Pool} pg
 * @param {string} conflictId
 * @param {string} staleWarning
 * @param {number} currentVersion
 */
export async function markPendingDecisionStale(pg, conflictId, staleWarning, currentVersion) {
  if (typeof pg.updatePendingDecision === 'function') {
    return pg.updatePendingDecision(conflictId, {
      status: 'stale',
      stale_warning: staleWarning,
      current_active_version: currentVersion,
    })
  }
  await pg.query(
    `UPDATE pending_decisions
     SET stale_warning = $1, current_active_version = $2, status = 'stale', updated_at = NOW()
     WHERE conflict_id = $3`,
    [staleWarning, currentVersion, conflictId],
  )
}

// ── Confidence lifecycle ──────────────────────────────────────────────────────

/**
 * Update the confidence score for a specific knowledge version row.
 * Also resets last_accessed_at to now.
 * @param {import('pg').Pool} pg
 * @param {string} versionId
 * @param {number} newConfidence
 */
export async function updateConfidence(pg, versionId, newConfidence) {
  if (typeof pg.updateConfidence === 'function') return pg.updateConfidence(versionId, newConfidence)
  await pg.query(
    `UPDATE knowledge_versions
     SET confidence = $1, last_accessed_at = NOW()
     WHERE version_id = $2`,
    [newConfidence, versionId],
  )
}

/**
 * Reset last_accessed_at to now for the ACTIVE row of a q_key_id (called on recall()).
 * @param {import('pg').Pool} pg
 * @param {string} qKeyId
 */
export async function updateLastAccessed(pg, qKeyId) {
  if (typeof pg.updateLastAccessed === 'function') return pg.updateLastAccessed(qKeyId)
  await pg.query(
    `UPDATE knowledge_versions
     SET last_accessed_at = NOW()
     WHERE q_key_id = $1 AND status = 'ACTIVE'`,
    [qKeyId],
  )
}

/**
 * Fetch ACTIVE knowledge versions eligible for confidence decay
 * (older than 7 days, confidence above floor 0.10).
 * @param {import('pg').Pool} pg
 * @param {string} qProjectId
 * @param {number} [batchSize=200]
 * @returns {Promise<Array<{ version_id: string, q_key_id: string, topic: string, key: string,
 *           confidence: number, starting_confidence: number,
 *           last_accessed_at: string | null, created_at: string }>>}
 */
export async function getDecayEligibleVersions(pg, qProjectId, batchSize = 200) {
  if (typeof pg.getDecayEligibleVersions === 'function') {
    return pg.getDecayEligibleVersions(qProjectId, batchSize)
  }
  const result = await pg.query(
    `SELECT version_id, q_key_id, topic, key,
            confidence, starting_confidence, last_accessed_at, created_at
     FROM knowledge_versions
     WHERE q_project_id = $1
       AND status = 'ACTIVE'
       AND created_at < NOW() - INTERVAL '7 days'
       AND confidence > 0.10
     ORDER BY last_accessed_at ASC NULLS FIRST
     LIMIT $2`,
    [qProjectId, batchSize],
  )
  return result.rows
}

// ── Bump log ──────────────────────────────────────────────────────────────────

/**
 * Get the version row that a bump would apply to (ACTIVE row for a q_key_id).
 * @param {import('pg').Pool} pg
 * @param {string} qKeyId
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getVersionForBump(pg, qKeyId) {
  if (typeof pg.getVersionForBump === 'function') return pg.getVersionForBump(qKeyId)
  const { rows } = await pg.query(
    `SELECT * FROM knowledge_versions
     WHERE q_key_id = $1 AND status = 'ACTIVE'
     LIMIT 1`,
    [qKeyId],
  )
  return rows[0] ?? null
}

/**
 * Record a confidence bump in bump_log.
 * @param {import('pg').Pool} pg
 * @param {{ qKeyId: string, author: string, role: string, delta: number }} options
 */
export async function recordBump(pg, { qKeyId, author, role, delta }) {
  if (typeof pg.recordBump === 'function') return pg.recordBump({ qKeyId, author, role, delta })
  await pg.query(
    `INSERT INTO bump_log (q_key_id, author, role, delta_applied)
     VALUES ($1, $2, $3, $4)`,
    [qKeyId, author, role, delta],
  )
}

/**
 * Fetch bump_log rows for cooldown / history lookups.
 * @param {import('pg').Pool} pg
 * @param {{ qKeyId: string, author: string, limit?: number }} options
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function getBumpLog(pg, { qKeyId, author, limit = 1 } = {}) {
  if (typeof pg.getBumpLog === 'function') return pg.getBumpLog({ qKeyId, author, limit })
  const { rows } = await pg.query(
    `SELECT * FROM bump_log
     WHERE q_key_id = $1 AND author = $2
     ORDER BY bumped_at DESC
     LIMIT $3`,
    [qKeyId, author, limit],
  )
  return rows
}

// ── Domain track record (author_domain_stats) ────────────────────────────────

/**
 * @typedef {'approved_count' | 'recalled_count' | 'superseded_count'} DomainStatField
 */

/**
 * Increment a domain track-record counter for an author.
 * Non-fatal — stat failures never block the primary operation.
 *
 * In gateway mode the GatewayClient does not expose a stats increment endpoint,
 * so this is intentionally a no-op. Callers already use `.catch(() => {})`.
 *
 * @param {import('./schema.js').GatewayClient} pg
 * @param {{ author: string, domain: string, projectId: string, field: DomainStatField }} options
 */
export async function incrementDomainStat(pg, { author, domain, projectId, field }) {
  if (typeof pg.incrementDomainStat === 'function') {
    return pg.incrementDomainStat({ author, domain, projectId, field })
  }
  // No-op in gateway mode — stats increment endpoint not yet exposed by GatewayClient
}

/**
 * Fetch domain track record stats for a given author and domain.
 * @param {import('pg').Pool} pg
 * @param {{ qProjectId: string, author: string, domain: string }} options
 * @returns {Promise<{ approved_count: number, recalled_count: number, superseded_count: number } | null>}
 */
export async function getDomainStats(pg, { qProjectId, author, domain }) {
  if (typeof pg.getDomainStats === 'function') return pg.getDomainStats({ qProjectId, author, domain })
  const { rows } = await pg.query(
    `SELECT approved_count, recalled_count, superseded_count
     FROM author_domain_stats
     WHERE author = $1 AND q_project_id = $2 AND domain = $3`,
    [author, qProjectId, domain],
  )
  return rows[0] ?? null
}
