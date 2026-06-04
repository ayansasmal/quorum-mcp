/**
 * remember() — Store engineering knowledge with full governance pipeline.
 *
 * v0.2 changes:
 *   - `author` removed from input schema — injected server-side from resolved identity
 *   - `domain` added — used for per-domain conflict thresholds and reviewer team enforcement
 *   - tags are normalized (lowercase + trim) before storage
 *   - confidence floor applied from role config before storing
 *   - when conflict requires human decision: enrichment is generated immediately and
 *     stored in pending_decisions so reviewers get analysis with zero extra latency
 *   - resolution of pending conflicts: called again with conflict_id + resolution
 *     (coexist_split forks into two keys; coexist_merge writes a combined entry)
 *
 * Flow:
 *   1. Validate inputs (author injected from identity)
 *   2. Apply confidence floor from role config
 *   3. Normalize tags
 *   4. If conflict_id present → resolve pending conflict, return
 *   5. Check for existing ACTIVE version at topic:key
 *   6. If exists → conflict detection (domain-scoped threshold)
 *   7. If conflict and human_required → generate enrichment + store in pending_decisions
 *   8. If conflict and auto_supersede → supersede directly
 *   9. If no conflict → supersede (reason required)
 *  10. If first version → store directly (DRAFT for claude/reflect)
 *  11. All writes wrapped in withAuditPipeline
 */

import { v4 as uuidv4 } from 'uuid'
import { z } from 'zod'
import { withAuditPipeline } from '../audit/pipeline.js'
import { detectConflict, resolveConflict, generateEnrichment, normalizeTags } from '../governance/conflict.js'
import { enforceReasonRequired, enforceConflictPartyCannotSelfResolve, enforceGlobalWriteAuthority } from '../governance/constitutional.js'
import { buildVersionRecord, buildForwardLink, buildAuditVersionImpact, hashContent } from '../governance/provenance.js'
import { initialConfidence } from '../governance/confidence.js'
import { resolveAuthorConfidence } from '../governance/authority.js'
import { TriggeredBy, KnowledgeStatus } from '../graph/schema.js'
import { addEpisode, addSupersedingEpisode } from '../graph/client.js'
import { getConfig } from '../config/loader.js'
import {
  getCurrentVersion, getNextVersionNumber, insertVersion, transitionVersionStatus,
  countPendingForKey, insertPendingDecision, getPendingDecisionById, resolvePendingDecision,
} from '../graph/queries.js'

// GLOBAL_PROJECT_ID constant removed in v0.4 Wave A.
// Global catalog detection now uses getConfig()?.is_global === true so that ANY
// project can be elevated to a global catalog, not just the hardcoded 'global' id.
// Write authority is enforced by enforceGlobalWriteAuthority() (constitutional layer).

export const schema = z.object({
  topic: z.string()
    .regex(/^[a-z0-9-]+$/, 'topic must be kebab-case (e.g. "auth", "db-layer")')
    .max(60)
    .describe('Knowledge domain — kebab-case slug, max 60 chars (e.g. auth, db-layer)'),

  key: z.string()
    .regex(/^[a-z0-9-]+$/, 'key must be kebab-case (e.g. "token-strategy")')
    .max(80)
    .describe('Unique identifier within the topic — kebab-case slug, max 80 chars'),

  content: z.string()
    .max(500, 'Knowledge content must be under 500 characters')
    .refine(v => !/[<>]/.test(v), 'Plain text only — no HTML characters (< >)')
    .describe('The knowledge content to store — plain text, max 500 chars, no HTML'),

  domain: z.string().optional().describe('Domain name for per-domain conflict thresholds (defaults to topic)'),

  confidence: z.number().min(0.5).max(1.0).optional()
    .describe('Confidence score 0.5–1.0 (role floor applied automatically)'),

  tags: z.array(
    z.string()
      .regex(/^[a-z0-9-]+$/, 'Each tag must be kebab-case')
      .max(40)
  ).max(10).optional()
    .describe('Searchable tags — max 10, each kebab-case, max 40 chars'),

  reason: z.string()
    .min(10, 'Reason must be at least 10 characters')
    .max(500)
    .refine(v => !/[<>]/.test(v), 'Plain text only — no HTML characters')
    .optional()
    .describe('Required when superseding existing knowledge — min 10 chars, plain text'),

  entity_type: z.enum(['Decision', 'Pattern', 'Constraint', 'Runbook', 'Requirement'])
    .optional()
    .describe('Knowledge entity type'),

  triggered_by: z.string().optional().describe('What triggered this write (default: engineer_decision)'),

  // Conflict resolution fields — used when responding to a pending conflict brief
  conflict_id: z.string().optional().describe('Conflict ID from pending() — resolves a pending decision'),
  resolution: z.enum(['supersede', 'coexist_split', 'coexist_merge', 'reject', 'escalate']).optional(),
  split_existing_key: z.string().optional().describe('New scoped key for existing entry (coexist_split)'),
  split_incoming_key: z.string().optional().describe('New scoped key for incoming entry (coexist_split)'),
  split_existing_content: z.string().optional().describe('Optional refined content for split A (coexist_split)'),
  split_incoming_content: z.string().optional().describe('Optional refined content for split B (coexist_split)'),
  merged_content: z.string().optional().describe('Combined knowledge entry content (coexist_merge)'),
  session_id: z.string().optional(),
})

/**
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @param {import('../identity/resolver.js').ResolvedIdentity} identity
 * @param {{ projectId: string, gatewayUrl: string } | null} [ctx]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function handler(pg, input, identity, ctx) {
  const author = identity?.name ?? 'anonymous'
  const domain = input.domain ?? input.topic
  const rawConfidence = initialConfidence(input.confidence)
  const confidence = identity ? resolveAuthorConfidence(rawConfidence, identity) : rawConfidence
  const triggeredBy = input.triggered_by ?? TriggeredBy.ENGINEER_DECISION
  const tags = normalizeTags(input.tags)
  const projectId = ctx?.projectId
  if (!projectId) throw new Error('remember: ctx.projectId is required — ensure a .quorum file exists in this workspace')

  // ── GAP-27 (lifted): Global catalog write authority ─────────────────────────
  // Moved from application-level soft-return to constitutional enforcement.
  // Any project with is_global: true is a global catalog; architect+ can write.
  // Throws ConstitutionalViolation('GLOBAL_WRITE_AUTHORITY') on violation.
  const isGlobalProject = getConfig()?.is_global === true
  enforceGlobalWriteAuthority(identity, projectId, isGlobalProject)

  // ── Resolve a pending conflict ──────────────────────────────────────────────
  if (input.conflict_id && input.resolution) {
    return resolveConflictDecision(pg, input, identity, author, confidence, tags, triggeredBy, projectId, ctx)
  }

  const pipelineResult = await withAuditPipeline(
    pg,
    {
      tool: 'remember',
      author,
      sessionId: input.session_id,
      topic: input.topic,
      key: input.key,
      contentHash: hashContent(input.content),
    },
    async () => {
      const existing = await getCurrentVersion(pg, input.topic, input.key, projectId)

      // ── Superseding existing knowledge ──────────────────────────────────────
      if (existing) {
        enforceReasonRequired(input.reason, 'remember (supersede)')

        const globals = getConfig()?.globals ?? []
        const conflictResult = await detectConflict(input.content, input.topic, input.key, domain, pg, projectId, globals)

        // GAP-03: Graphiti was unavailable — store as PENDING_CONFLICT_CHECK for deferred re-check
        if (conflictResult.graphiti_unavailable) {
          return storePendingConflictCheck(pg, input, author, confidence, tags, triggeredBy, identity?.role, projectId, ctx)
        }

        if (conflictResult.conflict) {
          const resolution = resolveConflict(
            { content: input.content, author, confidence, created_at: new Date().toISOString() },
            existing,
            conflictResult.reason,
            { possible_split: conflictResult.possible_split, split_suggestion: conflictResult.split_suggestion },
          )

          if (resolution.action === 'human_required') {
            const conflictId = `conflict_${uuidv4()}`

            // Generate enrichment at conflict creation time — not at review time
            const enrichment = await generateEnrichment(
              existing.content ?? existing.summary ?? '',
              input.content,
              conflictResult.reason,
              conflictResult.possible_split ?? false,
              conflictResult.split_suggestion,
              pg,
            )

            // Embed conflict party provenance so resolveConflictDecision can
            // enforce the no-self-approval rule even if the knowledge has been
            // superseded by the time someone calls review().
            const enrichmentWithMeta = {
              ...enrichment,
              _conflict_parties: {
                existing_author: existing.author ?? existing.metadata?.author ?? null,
                incoming_author: author,
              },
            }

            // Count other pending decisions for same topic:key (ordering context)
            const morePendingSameKey = await countPendingForKey(pg, input.topic, input.key, projectId)

            await insertPendingDecision(pg, {
              conflict_id: conflictId,
              conflict_topic: input.topic,
              conflict_key: input.key,
              active_version_at_creation: existing.version,
              existing_content: existing.content ?? null,
              incoming_content: input.content,
              conflict_reason: conflictResult.reason,
              enrichment: enrichmentWithMeta,
              more_pending_same_key: morePendingSameKey,
              project_id: projectId,
            })

            // GAP-17: Fire webhook notification asynchronously — must never block write
            fireWebhookAsync({ conflictId, input, conflictResult, author })

            return {
              result: {
                status: 'conflict_detected',
                conflict_id: conflictId,
                possible_split: conflictResult.possible_split ?? false,
                split_suggestion: conflictResult.split_suggestion ?? null,
                brief: resolution.brief,
                message: 'Human decision required. Call remember() again with conflict_id + resolution (supersede | coexist_split | coexist_merge | reject | escalate) + mandatory reason.',
              },
              versionImpact: buildAuditVersionImpact([], []),
            }
          }
          // auto_supersede falls through to the supersession logic below
        }

        return supersede(pg, input, existing, author, confidence, tags, triggeredBy, identity?.role, projectId, ctx)
      }

      // ── First version ───────────────────────────────────────────────────────
      return storeFirst(pg, input, author, confidence, tags, triggeredBy, identity?.role, projectId, ctx)
    },
  )

  return pipelineResult.result
}

// ── Supersession helper ───────────────────────────────────────────────────────

/**
 * Insert new version and atomically transition old one to SUPERSEDED.
 * For global project: new version enters DRAFT, old version stays ACTIVE
 * (supersession completes only after a reviewer approves via review()).
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @param {Record<string, unknown>} existing
 * @param {string} author
 * @param {number} confidence
 * @param {string[]} tags
 * @param {string} triggeredBy
 * @param {string} [authorRole]
 * @param {string} [projectId='default']
 * @param {{ agentId?: string, sessionId?: string, authorType?: string } | null} [ctx]
 */
async function supersede(pg, input, existing, author, confidence, tags, triggeredBy, authorRole, projectId, ctx) {
  if (!projectId) throw new Error('supersede: projectId is required')
  // Use config flag, not a hardcoded project id, so any project can be a global catalog.
  const isGlobal = getConfig()?.is_global === true
  const nextVersion = await getNextVersionNumber(pg, input.topic, input.key, projectId)

  const graphitiResult = await addSupersedingEpisode(input.content, existing.graphiti_episode_id, {
    key: `${input.topic}:${input.key}`,
    source: `quorum:remember:${author}`,
    entityType: input.entity_type,
    tags,
    confidence,
    reason: input.reason,
  }, projectId)

  // Global writes always enter DRAFT — supersession only finalises after review approval
  const newStatus = isGlobal ? KnowledgeStatus.DRAFT : KnowledgeStatus.ACTIVE

  const versionRecord = buildVersionRecord({
    topic: input.topic,
    key: input.key,
    version: nextVersion,
    content: input.content,
    author,
    authorRole: authorRole ?? 'unknown',
    confidence,
    tags,
    triggeredBy,
    auditEntryId: 'pre_pending',
    graphitiEpisodeId: graphitiResult.episode_id,
    supersedesVersion: existing.version,
    supersedesReason: input.reason,
    status: newStatus,
    projectId,
    entityType: input.entity_type,
    agentId:    ctx?.agentId    ?? null,
    sessionId:  ctx?.sessionId  ?? null,
    authorType: ctx?.authorType ?? 'agent',
  })

  // For non-global: atomically supersede in a single transaction via the
  // gateway (Gap 3) — eliminates the race window where two ACTIVE rows could
  // coexist between separate insertVersion + transitionVersionStatus calls.
  // For global: old ACTIVE stays until a reviewer approves the DRAFT, so the
  // legacy DRAFT insert via insertVersion is kept (no transition needed).
  let insertedVersionId, insertedQKeyId
  if (!isGlobal) {
    const forwardLink = buildForwardLink({ supersededByVersion: nextVersion, supersededByAuthor: author })
    const atomicResult = await pg.atomicSupersede(
      { ...versionRecord, tags },
      existing.version,
      input.reason,
      forwardLink,
    )
    insertedVersionId = atomicResult?.new_version?.version_id
    insertedQKeyId    = atomicResult?.new_version?.q_key_id


  } else {
    const inserted = await insertVersion(pg, { ...versionRecord, tags })
    insertedVersionId = inserted?.version_id
    insertedQKeyId    = inserted?.q_key_id
  }

  return {
    result: {
      status: isGlobal ? 'pending_review' : 'stored',
      topic: input.topic,
      key: input.key,
      version: nextVersion,
      knowledge_status: newStatus,
      episode_id: graphitiResult.episode_id,
      superseded_version: isGlobal ? null : existing.version,
      ...(isGlobal && {
        message: 'Global namespace write entered DRAFT. A second principal_architect must approve before it becomes active.',
        pending_supersedes_version: existing.version,
      }),
    },
    versionImpact: buildAuditVersionImpact(
      [{ version: nextVersion, status: newStatus, triggered_by: triggeredBy, versionId: insertedVersionId, qKeyId: insertedQKeyId }],
      isGlobal ? [] : [{ version: existing.version, status_before: KnowledgeStatus.ACTIVE, versionId: existing.version_id, qKeyId: existing.q_key_id }],
    ),
  }
}

// ── First-version helper ──────────────────────────────────────────────────────

/**
 * Store the first version of a topic:key (no existing knowledge).
 * Claude-authored, reflect-triggered, and global-namespace writes always enter as DRAFT.
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @param {string} author
 * @param {number} confidence
 * @param {string[]} tags
 * @param {string} triggeredBy
 * @param {string} [authorRole]
 * @param {string} [projectId='default']
 * @param {{ agentId?: string, sessionId?: string, authorType?: string } | null} [ctx]
 */
async function storeFirst(pg, input, author, confidence, tags, triggeredBy, authorRole, projectId, ctx) {
  if (!projectId) throw new Error('storeFirst: projectId is required')
  // Use config flag, not a hardcoded project id, so any project can be a global catalog.
  const isGlobal = getConfig()?.is_global === true

  const graphitiResult = await addEpisode(input.content, {
    key: `${input.topic}:${input.key}`,
    source: `quorum:remember:${author}`,
    entityType: input.entity_type,
    tags,
    confidence,
  }, projectId)

  const status =
    isGlobal ||
    author === 'claude' ||
    author === 'anonymous' ||
    triggeredBy === TriggeredBy.REFLECT
      ? KnowledgeStatus.DRAFT
      : KnowledgeStatus.ACTIVE

  const versionRecord = buildVersionRecord({
    topic: input.topic,
    key: input.key,
    version: 1,
    content: input.content,
    author,
    authorRole: authorRole ?? 'unknown',
    confidence,
    tags,
    triggeredBy,
    auditEntryId: 'pre_pending',
    graphitiEpisodeId: graphitiResult.episode_id,
    status,
    projectId,
    entityType: input.entity_type,
    agentId:    ctx?.agentId    ?? null,
    sessionId:  ctx?.sessionId  ?? null,
    authorType: ctx?.authorType ?? 'agent',
  })

  const inserted = await insertVersion(pg, { ...versionRecord, tags })

  // Use gateway-determined status from the inserted row — the gateway is the
  // authority on status (role + is_global → DRAFT/ACTIVE). Fall back to
  // locally computed status only if the gateway did not return a row.
  const actualStatus = inserted?.status ?? status

  return {
    result: {
      status: 'stored',
      topic: input.topic,
      key: input.key,
      version: 1,
      knowledge_status: actualStatus,
      episode_id: graphitiResult.episode_id,
    },
    versionImpact: buildAuditVersionImpact(
      [{ version: 1, status: actualStatus, triggered_by: triggeredBy, versionId: inserted?.version_id, qKeyId: inserted?.q_key_id }],
      [],
    ),
  }
}

// ── Graphiti downtime fallback (GAP-03) ──────────────────────────────────────

/**
 * Store a version with PENDING_CONFLICT_CHECK status when Graphiti is unavailable.
 * The recheck-conflicts CronJob will promote it to ACTIVE or trigger the
 * conflict workflow once Graphiti recovers.
 *
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @param {string} author
 * @param {number} confidence
 * @param {string[]} tags
 * @param {string} triggeredBy
 * @param {string} [authorRole]
 * @param {string} [projectId='default']
 * @param {{ agentId?: string, sessionId?: string, authorType?: string } | null} [ctx]
 */
async function storePendingConflictCheck(pg, input, author, confidence, tags, triggeredBy, authorRole, projectId, ctx) {
  if (!projectId) throw new Error('storePendingConflictCheck: projectId is required')
  const existing = await getCurrentVersion(pg, input.topic, input.key, projectId)
  const version = existing ? (existing.version + 1) : 1

  const versionRecord = buildVersionRecord({
    topic: input.topic,
    key: input.key,
    version,
    content: input.content,
    author,
    authorRole: authorRole ?? 'unknown',
    confidence,
    tags,
    triggeredBy,
    auditEntryId: 'pre_pending',
    graphitiEpisodeId: null,      // episode not stored — Graphiti was unavailable
    status: KnowledgeStatus.PENDING_CONFLICT_CHECK,
    supersedes_version: existing?.version ?? null,
    supersedes_reason: input.reason ?? null,
    projectId,
    entityType: input.entity_type,
    agentId:    ctx?.agentId    ?? null,
    sessionId:  ctx?.sessionId  ?? null,
    authorType: ctx?.authorType ?? 'agent',
  })

  // pending_conflict_check: true is a flag for the gateway — it tells the gateway
  // to set status = 'PENDING_CONFLICT_CHECK' server-side instead of DRAFT/ACTIVE.
  // The gateway is the authority on status; sending a raw status value is not accepted.
  const inserted = await insertVersion(pg, { ...versionRecord, tags, project_id: projectId, pending_conflict_check: true })

  console.error(`[Quorum:remember] Graphiti unavailable — stored ${input.topic}:${input.key} v${version} as PENDING_CONFLICT_CHECK for deferred re-check`)

  return {
    result: {
      status: 'stored',
      topic: input.topic,
      key: input.key,
      version,
      knowledge_status: KnowledgeStatus.PENDING_CONFLICT_CHECK,
      episode_id: null,
      warning: 'Conflict check deferred — Graphiti unavailable. Entry stored as PENDING_CONFLICT_CHECK and will be re-checked automatically when Graphiti recovers.',
    },
    versionImpact: buildAuditVersionImpact(
      [{ version, status: KnowledgeStatus.PENDING_CONFLICT_CHECK, triggered_by: triggeredBy, versionId: inserted?.version_id, qKeyId: inserted?.q_key_id }],
      [],
    ),
  }
}

// ── Conflict resolution handler ───────────────────────────────────────────────

/**
 * Resolve a pending conflict decision.
 * Called when remember() receives conflict_id + resolution.
 *
 * supersede      → incoming replaces existing, normal supersession flow
 * coexist_split  → fork: two new entries under scoped keys, original superseded
 * coexist_merge  → merge: one new entry with merged_content, original superseded
 * reject         → close the conflict, existing stays ACTIVE, incoming discarded
 * escalate       → mark as escalated, leave for wider team
 *
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @param {import('../identity/resolver.js').ResolvedIdentity} identity
 * @param {string} author
 * @param {number} confidence
 * @param {string[]} tags
 * @param {string} triggeredBy
 */
async function resolveConflictDecision(pg, input, identity, author, confidence, tags, triggeredBy, projectId, ctx) {
  if (!projectId) throw new Error('resolveConflictDecision: projectId is required')
  enforceReasonRequired(input.reason, `conflict resolution (${input.resolution})`)

  const decision = await getPendingDecisionById(pg, input.conflict_id)
  if (!decision) {
    return { status: 'not_found', message: `No pending conflict found with ID ${input.conflict_id}` }
  }

  // conflict_topic/conflict_key come from a q_keys JOIN on GET /pg/pending/:id;
  // fall back to input fields when the gateway omits the JOIN (older versions).
  const topic = decision.conflict_topic ?? input.topic
  const key = decision.conflict_key ?? input.key
  const existing = await getCurrentVersion(pg, topic, key, projectId)

  // Rule 4: No self-approval — conflict parties cannot resolve their own conflict.
  // existing?.author covers the current ACTIVE version; _conflict_parties covers the
  // original parties at conflict creation time (stored in enrichment on write).
  const stored = decision.enrichment?._conflict_parties ?? {}
  const conflictParties = [
    existing?.author,
    stored.existing_author ?? null,
    stored.incoming_author ?? null,
  ].filter(Boolean)
  if (conflictParties.length > 0) {
    enforceConflictPartyCannotSelfResolve(conflictParties, author)
  }

  if (input.resolution === 'reject' || input.resolution === 'escalate') {
    await resolvePendingDecision(pg, input.conflict_id, {
      status: 'resolved',
      resolution: input.resolution,
      note: input.reason,
      resolvedBy: author,
    }, projectId)
    return {
      status: 'resolved',
      resolution: input.resolution,
      conflict_id: input.conflict_id,
      message: input.resolution === 'reject'
        ? 'Incoming knowledge rejected. Existing entry stands.'
        : 'Conflict escalated. Existing entry unchanged pending architecture discussion.',
    }
  }

  if (input.resolution === 'supersede') {
    if (!existing) return { status: 'error', message: `No ACTIVE version found for ${topic}:${key}` }
    const result = await supersede(pg, { ...input, topic, key, reason: input.reason }, existing, author, confidence, tags, TriggeredBy.CONFLICT_RESOLUTION, identity?.role, projectId, ctx)
    await closeConflict(pg, input.conflict_id, 'supersede', input.reason, author, null, null, null, projectId)
    return { ...result.result, conflict_id: input.conflict_id }
  }

  if (input.resolution === 'coexist_split') {
    if (!input.split_existing_key || !input.split_incoming_key) {
      return { status: 'error', message: 'coexist_split requires split_existing_key and split_incoming_key' }
    }

    // Create entry A: existing knowledge under new scoped key
    const contentA = input.split_existing_content ?? decision.existing_content
    const episodeA = await addEpisode(contentA, {
      key: `${topic}:${input.split_existing_key}`,
      source: `quorum:split:${author}`,
      tags: normalizeTags([...tags, key]),
    }, projectId)
    const recordA = buildVersionRecord({
      topic, key: input.split_existing_key, version: 1,
      content: contentA, author, confidence, tags: normalizeTags([...tags, key]),
      triggeredBy: TriggeredBy.CONFLICT_RESOLUTION, auditEntryId: 'pre_pending',
      graphitiEpisodeId: episodeA.episode_id,
      projectId,
      entityType: input.entity_type,
      agentId:    ctx?.agentId    ?? null,
      sessionId:  ctx?.sessionId  ?? null,
      authorType: ctx?.authorType ?? 'agent',
    })
    await insertVersion(pg, { ...recordA, tags: normalizeTags([...tags, key]) })

    // Create entry B: incoming knowledge under new scoped key
    const contentB = input.split_incoming_content ?? decision.incoming_content
    const episodeB = await addEpisode(contentB, {
      key: `${topic}:${input.split_incoming_key}`,
      source: `quorum:split:${author}`,
      tags: normalizeTags([...tags, key]),
    }, projectId)
    const recordB = buildVersionRecord({
      topic, key: input.split_incoming_key, version: 1,
      content: contentB, author, confidence, tags: normalizeTags([...tags, key]),
      triggeredBy: TriggeredBy.CONFLICT_RESOLUTION, auditEntryId: 'pre_pending',
      graphitiEpisodeId: episodeB.episode_id,
      projectId,
      entityType: input.entity_type,
      agentId:    ctx?.agentId    ?? null,
      sessionId:  ctx?.sessionId  ?? null,
      authorType: ctx?.authorType ?? 'agent',
    })
    await insertVersion(pg, { ...recordB, tags: normalizeTags([...tags, key]) })

    // Supersede original with reason pointing to both new keys
    if (existing) {
      const splitReason = `Split into ${topic}:${input.split_existing_key} and ${topic}:${input.split_incoming_key} — ${input.reason}`
      const forwardLink = buildForwardLink({ supersededByVersion: existing.version + 1, supersededByAuthor: author, reason: splitReason })
      await transitionVersionStatus(pg, topic, key, existing.version, KnowledgeStatus.SUPERSEDED, forwardLink, projectId, splitReason)
    }

    await closeConflict(pg, input.conflict_id, 'coexist_split', input.reason, author,
      input.split_existing_key, input.split_incoming_key, null, projectId)

    return {
      status: 'resolved',
      resolution: 'coexist_split',
      conflict_id: input.conflict_id,
      split_a: { topic, key: input.split_existing_key, version: 1 },
      split_b: { topic, key: input.split_incoming_key, version: 1 },
      original_superseded: Boolean(existing),
    }
  }

  if (input.resolution === 'coexist_merge') {
    if (!input.merged_content) {
      return { status: 'error', message: 'coexist_merge requires merged_content' }
    }
    if (!existing) return { status: 'error', message: `No ACTIVE version found for ${topic}:${key}` }

    const mergeResult = await supersede(
      pg,
      { ...input, topic, key, content: input.merged_content, reason: input.reason },
      existing, author, confidence, tags, TriggeredBy.CONFLICT_RESOLUTION, identity?.role, projectId, ctx,
    )

    await closeConflict(pg, input.conflict_id, 'coexist_merge', input.reason, author, null, null,
      input.merged_content, projectId)

    return { ...mergeResult.result, conflict_id: input.conflict_id, resolution: 'coexist_merge' }
  }

  return { status: 'error', message: `Unknown resolution: ${input.resolution}` }
}

/**
 * Mark a pending_decisions row as resolved and record the resolution details.
 * @param {import('pg').Pool} pg
 * @param {string} conflictId
 * @param {string} resolution
 * @param {string} note
 * @param {string} resolvedBy
 * @param {string|null} splitExistingKey
 * @param {string|null} splitIncomingKey
 * @param {string|null} [mergedContent]
 */
async function closeConflict(pg, conflictId, resolution, note, resolvedBy, splitExistingKey, splitIncomingKey, mergedContent = null, projectId = null) {
  await resolvePendingDecision(pg, conflictId, {
    status: 'resolved',
    resolution,
    note,
    resolvedBy,
    splitExistingKey,
    splitIncomingKey,
    mergedContent,
  }, projectId)
}

// ── GAP-17: Webhook notification ──────────────────────────────────────────────

/**
 * Fire a webhook notification when a conflict enters the human review queue.
 * Runs asynchronously and swallows all errors — notification failure must never
 * block the write operation. Teams wire the webhook_url to Slack, email relay,
 * or PagerDuty in quorum.config.json → notifications.webhook_url.
 *
 * @param {{ conflictId: string, input: object, conflictResult: object, author: string }} params
 */
async function fireWebhookAsync({ conflictId, input, conflictResult, author }) {
  try {
    const config = getConfig()
    const url = config?.notifications?.webhook_url
    if (!url) return

    const dashboardBase = config?.notifications?.dashboard_url
      ?? process.env.QUORUM_DASHBOARD_URL
      ?? null

    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'conflict.pending_review',
        topic: input.topic,
        key: input.key,
        conflict_id: conflictId,
        conflict_reason: conflictResult.reason,
        possible_split: conflictResult.possible_split ?? false,
        incoming_author: author,
        dashboard_url: dashboardBase
          ? `${dashboardBase}/pending/${conflictId}`
          : null,
      }),
    })
  } catch {
    // Swallow — webhook failure is non-fatal. The pending decision is already stored.
  }
}
