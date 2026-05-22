/**
 * review() — Approve, reject, or request changes on DRAFT knowledge.
 *
 * v0.2 changes:
 *   - `reviewer` removed from input schema — injected from resolved identity
 *   - required_reviewer_teams enforced: reviewer must be from an approved team
 *     for domains that have team restrictions in the S3 config
 *   - staleness detection: if the ACTIVE version has advanced since the DRAFT
 *     was created, a stale_warning is returned so the reviewer knows context
 *
 * Constitutional invariants enforced:
 *   - Rule 3: note/reason required (enforceReasonRequired)
 *   - Rule 4: reviewer cannot be the author (enforceNoSelfApproval)
 *
 * State transitions:
 *   approve          → DRAFT → ACTIVE
 *   reject           → DRAFT → REJECTED
 *   request_changes  → stays DRAFT, note stored in audit
 */

import { z } from 'zod'
import { withAuditPipeline } from '../audit/pipeline.js'
import { enforceNoSelfApproval, enforceReasonRequired } from '../governance/constitutional.js'
import { buildAuditVersionImpact, buildVersionRecord } from '../governance/provenance.js'
import { KnowledgeStatus, TriggeredBy } from '../graph/schema.js'
import {
  getCurrentVersion, getSpecificVersion, transitionVersionStatus,
  getLatestDraftVersion, incrementDomainStat,
  getPendingDecisionById, resolvePendingDecision, getNextVersionNumber, insertVersion,
} from '../graph/queries.js'
import { deleteEpisodeSoft } from '../graph/client.js'
import { getConfig } from '../config/loader.js'

export const schema = z.object({
  action:     z.enum(['approve', 'reject', 'request_changes']),
  topic:      z.string().min(1).optional().describe('Target topic (required for DRAFT reviews; omit when using request_id)'),
  key:        z.string().min(1).optional().describe('Target key (required for DRAFT reviews; omit when using request_id)'),
  note:       z.string().min(1).describe('Required: reason for this decision'),
  request_id: z.string().optional().describe('For deprecation requests: the request_id returned by pending()'),
  version:    z.number().int().positive().optional().describe('Specific version to review (defaults to latest DRAFT)'),
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
  const reviewer = identity?.name ?? 'anonymous'
  const reviewerTeam = identity?.team ?? null
  const projectId = ctx?.projectId
  if (!projectId) throw new Error('review: ctx.projectId is required — ensure a .quorum file exists in this workspace')

  // Constitutional Rule 3: note required — checked before pipeline
  enforceReasonRequired(input.note, 'review')

  // ── Deprecation request approval path ────────────────────────────────────────
  if (input.request_id) {
    return handleDeprecationRequest(pg, input, identity, ctx)
  }

  const pipelineResult = await withAuditPipeline(
    pg,
    {
      tool: 'review',
      author: reviewer,
      sessionId: input.session_id,
      topic: input.topic,
      key: input.key,
      governanceData: { action: input.action, note: input.note },
    },
    async () => {
      // ── Resolve target version ────────────────────────────────────────────
      let targetVersion
      if (input.version != null) {
        targetVersion = await getSpecificVersion(pg, input.topic, input.key, input.version, projectId)
      } else {
        const current = await getCurrentVersion(pg, input.topic, input.key, projectId)
        if (current?.status === KnowledgeStatus.DRAFT) {
          targetVersion = current
        } else {
            targetVersion = await getLatestDraftVersion(pg, input.topic, input.key, projectId)
        }
      }

      if (!targetVersion) {
        return {
          result: { status: 'not_found', message: `No DRAFT version found for ${input.topic}:${input.key}` },
          versionImpact: buildAuditVersionImpact([], []),
        }
      }

      if (targetVersion.status !== KnowledgeStatus.DRAFT) {
        return {
          result: { status: 'invalid_state', message: `Version ${targetVersion.version} is ${targetVersion.status}, not DRAFT` },
          versionImpact: buildAuditVersionImpact([], []),
        }
      }

      // Constitutional Rule 4: no self-approval — checked after we have the author
      enforceNoSelfApproval(targetVersion.author, reviewer, 'review')

      // ── Domain team enforcement ───────────────────────────────────────────
      const teamViolation = enforceReviewerTeam(input.topic, reviewerTeam)
      if (teamViolation) {
        return {
          result: { status: 'unauthorized', message: teamViolation },
          versionImpact: buildAuditVersionImpact([], []),
        }
      }

      // ── Staleness detection ───────────────────────────────────────────────
      // If the ACTIVE version has advanced since this DRAFT was created (e.g. another
      // path activated a different version), warn the reviewer so they have current context.
      const currentActive = await getCurrentVersion(pg, input.topic, input.key, projectId)
      let staleWarning = null
      if (
        currentActive &&
        currentActive.status === KnowledgeStatus.ACTIVE &&
        currentActive.version > targetVersion.version
      ) {
        staleWarning = `Active version is now v${currentActive.version} (created ${currentActive.created_at?.toISOString?.() ?? currentActive.created_at}). This DRAFT (v${targetVersion.version}) was written against an older context. Review with current active version in mind.`
      }

      // ── request_changes: stays DRAFT ──────────────────────────────────────
      if (input.action === 'request_changes') {
        return {
          result: {
            status: 'changes_requested',
            topic: input.topic,
            key: input.key,
            version: targetVersion.version,
            reviewer,
            note: input.note,
            stale_warning: staleWarning,
          },
          versionImpact: buildAuditVersionImpact([], []),
        }
      }

      // ── approve / reject: state transition ───────────────────────────────
      const newStatus = input.action === 'approve' ? KnowledgeStatus.ACTIVE : KnowledgeStatus.REJECTED
      await transitionVersionStatus(pg, input.topic, input.key, targetVersion.version, newStatus, null, projectId)

      // GAP-21: on approve, increment approved_count for the entry author in this domain
      if (input.action === 'approve') {
        incrementDomainStat(pg, {
          author: targetVersion.author,
          domain: input.topic,
          projectId,
          field: 'approved_count',
        }).catch(() => {})
      }

      return {
        result: {
          status: input.action === 'approve' ? 'approved' : 'rejected',
          topic: input.topic,
          key: input.key,
          version: targetVersion.version,
          new_status: newStatus,
          reviewer,
          note: input.note,
          stale_warning: staleWarning,
        },
        versionImpact: buildAuditVersionImpact(
          input.action === 'approve'
            ? [{ version: targetVersion.version, status: KnowledgeStatus.ACTIVE, triggered_by: 'review_approval', versionId: targetVersion.version_id, qKeyId: targetVersion.q_key_id }]
            : [],
          input.action === 'reject'
            ? [{ version: targetVersion.version, status_before: KnowledgeStatus.DRAFT, versionId: targetVersion.version_id, qKeyId: targetVersion.q_key_id }]
            : [],
        ),
      }
    },
  )

  return pipelineResult.result
}

// ── Deprecation request handler ───────────────────────────────────────────────

/**
 * Approve or reject a pending deprecation request (decision_type='deprecation_request').
 * Only principal_architect or is_admin callers may act. 'request_changes' is not valid.
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @param {import('../identity/resolver.js').ResolvedIdentity} identity
 * @param {{ projectId: string, gatewayUrl: string } | null} ctx
 */
async function handleDeprecationRequest(pg, input, identity, ctx) {
  const reviewer  = identity?.name ?? 'anonymous'
  const projectId = ctx?.projectId

  if (identity?.role !== 'principal_architect' && !identity?.is_admin) {
    return {
      status:     'forbidden',
      message:    'Only principal_architect can approve or reject deprecation requests.',
      request_id: input.request_id,
    }
  }

  if (input.action === 'request_changes') {
    return {
      status:     'invalid_action',
      message:    "request_changes is not valid for deprecation requests. Reject it and ask the requestor to re-submit forget() with a clearer reason.",
      request_id: input.request_id,
    }
  }

  const pipelineResult = await withAuditPipeline(
    pg,
    {
      tool:     'review',
      author:   reviewer,
      sessionId: input.session_id,
      governanceData: { action: input.action, note: input.note, request_id: input.request_id },
    },
    async () => {
      const row = await getPendingDecisionById(pg, input.request_id)
      if (!row || row.decision_type !== 'deprecation_request') {
        return {
          result: { status: 'not_found', request_id: input.request_id },
          versionImpact: buildAuditVersionImpact([], []),
        }
      }
      if (row.status !== 'pending') {
        return {
          result: { status: 'already_resolved', request_id: input.request_id, resolution: row.resolution },
          versionImpact: buildAuditVersionImpact([], []),
        }
      }

      const topic = row.conflict_topic
      const key   = row.conflict_key

      if (input.action === 'approve') {
        const existing = await getCurrentVersion(pg, topic, key, projectId)
        if (!existing) {
          await resolvePendingDecision(pg, input.request_id, {
            status: 'resolved', resolution: 'rejected',
            note: 'Entry no longer ACTIVE at approval time.',
            resolvedBy: reviewer,
          })
          return {
            result: {
              status:  'not_found',
              message: `${topic}:${key} is no longer ACTIVE — possibly already deprecated. Request resolved.`,
            },
            versionImpact: buildAuditVersionImpact([], []),
          }
        }

        const nextVersion = await getNextVersionNumber(pg, topic, key, projectId)

        if (existing.graphiti_episode_id) {
          await deleteEpisodeSoft(existing.graphiti_episode_id, {
            key: `${topic}:${key}`, reason: row.conflict_reason, author: reviewer,
          }, projectId).catch(() => {})
        }

        const versionRecord = buildVersionRecord({
          topic,
          key,
          version:          nextVersion,
          content:          `[DEPRECATED] ${row.conflict_reason}`,
          author:           reviewer,
          triggeredBy:      TriggeredBy.HUMAN_DECISION,
          auditEntryId:     'pre_pending',
          supersedesVersion: existing.version,
          supersedesReason: row.conflict_reason,
          status:           KnowledgeStatus.DEPRECATED,
          projectId,
          entityType:       existing.entity_type ?? null,
          agentId:          ctx?.agentId    ?? null,
          sessionId:        ctx?.sessionId  ?? null,
          authorType:       ctx?.authorType ?? 'agent',
        })
        await insertVersion(pg, versionRecord)
        await transitionVersionStatus(
          pg, topic, key, existing.version, KnowledgeStatus.DEPRECATED,
          { version: nextVersion, author: reviewer, at: new Date().toISOString() },
          projectId,
        )

        await resolvePendingDecision(pg, input.request_id, {
          status: 'resolved', resolution: 'approved',
          note: input.note, resolvedBy: reviewer,
        })

        return {
          result: {
            status:              'approved',
            request_id:          input.request_id,
            topic,
            key,
            deprecated_version:  existing.version,
            deprecation_version: nextVersion,
          },
          versionImpact: buildAuditVersionImpact(
            [{ version: nextVersion, status: KnowledgeStatus.DEPRECATED, triggered_by: TriggeredBy.HUMAN_DECISION }],
            [{ version: existing.version, status_before: existing.status }],
          ),
        }
      }

      // reject
      await resolvePendingDecision(pg, input.request_id, {
        status: 'resolved', resolution: 'rejected',
        note: input.note, resolvedBy: reviewer,
      })
      return {
        result: { status: 'rejected', request_id: input.request_id, topic, key },
        versionImpact: buildAuditVersionImpact([], []),
      }
    },
  )
  return pipelineResult.result
}

// ── Domain team enforcement ────────────────────────────────────────────────────

/**
 * Check whether the reviewer's team is permitted to review knowledge in this domain.
 * Returns an error message string if blocked, null if permitted.
 *
 * Empty required_reviewer_teams → any team may review.
 * Config not loaded → no enforcement (permissive fallback).
 *
 * @param {string} topic
 * @param {string | null} reviewerTeam
 * @returns {string | null} Error message or null if permitted
 */
function enforceReviewerTeam(topic, reviewerTeam) {
  let requiredTeams
  try {
    const config = getConfig()
    requiredTeams = config.domains[topic]?.required_reviewer_teams
  } catch {
    return null // config not loaded — permissive
  }

  if (!requiredTeams || requiredTeams.length === 0) return null
  if (!reviewerTeam) {
    return `Domain '${topic}' requires reviewer from team(s): ${requiredTeams.join(', ')}. Reviewer team is unknown (anonymous identity).`
  }

  const normalizedReviewerTeam = reviewerTeam.toLowerCase().trim()
  const allowed = requiredTeams.some((t) => t.toLowerCase().trim() === normalizedReviewerTeam)

  if (!allowed) {
    return `Domain '${topic}' requires reviewer from team(s): ${requiredTeams.join(', ')}. Reviewer is from team '${reviewerTeam}'.`
  }

  return null
}
