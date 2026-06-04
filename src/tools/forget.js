/**
 * forget() — Deprecate knowledge. Never hard delete.
 *
 * For PE/admin callers: creates a new DEPRECATED version immediately.
 * For non-PE callers: queues a deprecation_request in pending_decisions for PE approval.
 * Anonymous callers (no identity) always get forbidden.
 *
 * Requires a reason (Constitutional Rule 3).
 * Calls enforceNoHardDelete() to verify the constitutional check runs (Rule 1).
 */

import { z } from 'zod'
import { withAuditPipeline } from '../audit/pipeline.js'
import { enforceNoHardDelete, enforceReasonRequired } from '../governance/constitutional.js'
import { buildVersionRecord, buildAuditVersionImpact } from '../governance/provenance.js'
import { TriggeredBy, KnowledgeStatus } from '../graph/schema.js'
import { deleteEpisodeSoft } from '../graph/client.js'
import {
  getCurrentVersion,
  getNextVersionNumber,
  insertVersion,
  transitionVersionStatus,
  getPendingDecisions,
  insertPendingDecision,
} from '../graph/queries.js'

export const schema = z.object({
  topic: z.string().min(1),
  key: z.string().min(1),
  reason: z.string().min(10, 'Reason must be at least 10 characters — placeholders like "ok" or "tbd" are not accepted').describe('Required: why this knowledge is being deprecated (≥ 10 characters)'),
  session_id: z.string().optional(),
})

/**
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @param {import('../identity/resolver.js').ResolvedIdentity} [identity]
 * @param {{ projectId: string, gatewayUrl: string } | null} [ctx]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function handler(pg, input, identity, ctx) {
  const projectId = ctx?.projectId
  if (!projectId) throw new Error('forget: ctx.projectId is required — ensure a .quorum file exists in this workspace')
  const author = identity?.name ?? 'anonymous'

  // Constitutional rules apply to ALL callers before any branching
  enforceNoHardDelete('forget')
  enforceReasonRequired(input.reason, 'forget')

  // ── Non-PE path: queue a deprecation request for PE approval ─────────────────
  if (identity?.role !== 'principal_architect' && !identity?.is_admin) {
    if (!identity) {
      return {
        status: 'forbidden',
        message: 'forget() requires principal_architect role. Your role: unknown. Propose the deprecation to a PE — they can action it from the dashboard or MCP.',
        topic: input.topic,
        key: input.key,
      }
    }

    const pipelineResult = await withAuditPipeline(
      pg,
      {
        tool: 'forget',
        author,
        sessionId: input.session_id,
        topic: input.topic,
        key: input.key,
        governanceData: { reason: input.reason, mode: 'deprecation_request' },
      },
      async () => {
        const existing = await getCurrentVersion(pg, input.topic, input.key, projectId)
        if (!existing) {
          return {
            result: { status: 'not_found', topic: input.topic, key: input.key },
            versionImpact: buildAuditVersionImpact([], []),
          }
        }

        const allRequests = await getPendingDecisions(pg, {
          topic: input.topic,
          statuses: ['pending'],
          projectId,
        })
        const duplicate = allRequests.find((r) => {
          if ((r.decision_type ?? 'conflict') !== 'deprecation_request') return false
          if (r.conflict_key !== input.key) return false
          const enrich = typeof r.enrichment === 'string'
            ? JSON.parse(r.enrichment)
            : (r.enrichment ?? {})
          return enrich.requestor === author
        })
        if (duplicate) {
          return {
            result: {
              status: 'already_requested',
              request_id: duplicate.conflict_id,
              topic: input.topic,
              key: input.key,
              message: 'You already have a pending deprecation request for this entry.',
            },
            versionImpact: buildAuditVersionImpact([], []),
          }
        }

        const requestId = await insertPendingDecision(pg, {
          decision_type: 'deprecation_request',
          topic: input.topic,
          key: input.key,
          existing_content: existing.summary ?? existing.content ?? null,
          active_version_at_creation: existing.version,
          conflict_reason: input.reason,
          enrichment: { requestor: author, topic: input.topic, key: input.key },
          project_id: projectId,
        })

        return {
          result: {
            status: 'deprecation_requested',
            request_id: requestId,
            topic: input.topic,
            key: input.key,
            message: 'Deprecation request submitted. A principal_architect will review it in pending().',
          },
          versionImpact: buildAuditVersionImpact([], []),
        }
      },
    )
    return pipelineResult.result
  }

  // ── PE / admin path: full deprecation (unchanged) ─────────────────────────────
  const pipelineResult = await withAuditPipeline(
    pg,
    {
      tool: 'forget',
      author,
      sessionId: input.session_id,
      topic: input.topic,
      key: input.key,
      governanceData: { reason: input.reason },
    },
    async () => {
      const existing = await getCurrentVersion(pg, input.topic, input.key, projectId)
      if (!existing) {
        return {
          result: { status: 'not_found', topic: input.topic, key: input.key },
          versionImpact: buildAuditVersionImpact([], []),
        }
      }

      const nextVersion = await getNextVersionNumber(pg, input.topic, input.key, projectId)

      // Soft-deprecate in Graphiti (writes deprecation episode — never deletes)
      if (existing.graphiti_episode_id) {
        await deleteEpisodeSoft(existing.graphiti_episode_id, {
          key: `${input.topic}:${input.key}`,
          reason: input.reason,
          author,
        }, projectId).catch(() => {})
      }

      // Create new DEPRECATED version record
      const deprecationContent = `[DEPRECATED] ${input.reason}`
      const versionRecord = buildVersionRecord({
        topic: input.topic,
        key: input.key,
        version: nextVersion,
        content: deprecationContent,
        author,
        triggeredBy: TriggeredBy.ENGINEER_DECISION,
        auditEntryId: 'pre_pending',
        supersedesVersion: existing.version,
        supersedesReason: input.reason,
        status: KnowledgeStatus.DEPRECATED,
        projectId,
        entityType: existing.entity_type ?? null,
        agentId:    ctx?.agentId    ?? null,
        sessionId:  ctx?.sessionId  ?? null,
        authorType: ctx?.authorType ?? 'agent',
      })

      await insertVersion(pg, versionRecord)
      await transitionVersionStatus(
        pg, input.topic, input.key, existing.version,
        KnowledgeStatus.DEPRECATED,
        { version: nextVersion, author, at: new Date().toISOString() },
        projectId,
      )

      return {
        result: {
          status: 'deprecated',
          topic: input.topic,
          key: input.key,
          deprecated_version: existing.version,
          deprecation_version: nextVersion,
          reason: input.reason,
        },
        versionImpact: buildAuditVersionImpact(
          [{ version: nextVersion, status: KnowledgeStatus.DEPRECATED, triggered_by: TriggeredBy.ENGINEER_DECISION }],
          [{ version: existing.version, status_before: existing.status }],
        ),
      }
    },
  )

  return pipelineResult.result
}
