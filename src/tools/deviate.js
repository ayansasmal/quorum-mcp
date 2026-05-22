/**
 * deviate() — Record a project deviation from a linked global catalog entry.
 *
 * Called by agents during code review / security review / scheduled scans when
 * a project-local implementation diverges from a global catalog standard.
 *
 * Idempotent: re-calling with the same (catalog_id, topic, key) updates
 * last_seen_at and refreshes evidence — it does NOT create a duplicate row.
 *
 * Severity is derived server-side:
 *   severity = global_entry.confidence × authority_score(global_entry.author_role)
 *   PA_AUTHORED_FLOOR = 0.70 — PA-authored global entries have minimum severity 0.70
 *   regardless of confidence, to handle cold-start period where confidence is low.
 *
 * Returns:
 *   { deviation_id, catalog_id, topic, key, severity, status, is_new }
 *   status: 'not_linked' | 'not_found' | 'recorded'
 */

import { z } from 'zod'
import { withAuditPipeline } from '../audit/pipeline.js'
import { buildAuditVersionImpact } from '../governance/provenance.js'
import { DEFAULT_ROLE_SCORES } from '../governance/authority.js'
import { getConfig } from '../config/loader.js'
import {
  getProjectByGroupId,
  getCurrentVersion,
  getKeyId,
  upsertDeviation,
} from '../graph/queries.js'

/** Minimum severity for PA-authored global entries (cold-start floor). */
const PA_AUTHORED_FLOOR = 0.70

export const schema = z.object({
  catalog_id:  z.string().min(1).describe('group_id of the global catalog this deviates from'),
  topic:       z.string().regex(/^[a-z0-9-]+$/).max(60).describe('Knowledge domain (kebab-case)'),
  key:         z.string().regex(/^[a-z0-9-]+$/).max(80).describe('Entry key within the topic (kebab-case)'),
  description: z.string().max(500).describe('Description of how this project deviates from the standard'),
  evidence:    z.object({
    files:   z.array(z.string()).optional(),
    lines:   z.array(z.string()).optional(),
    excerpt: z.string().max(300).optional(),
  }).optional().describe('File locations and code excerpts that demonstrate the deviation'),
  source:      z.enum(['agent', 'code-review', 'security-review']).optional().default('agent'),
  session_id:  z.string().optional(),
  author:      z.string().optional().default('unknown'),
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
  if (!projectId) throw new Error('deviate: ctx.projectId is required — ensure a .quorum file exists in this workspace')

  const pipelineResult = await withAuditPipeline(
    pg,
    {
      tool:      'deviate',
      author:    input.author ?? identity?.author ?? 'unknown',
      sessionId: input.session_id,
      topic:     input.topic,
      key:       input.key,
      governanceData: { catalog_id: input.catalog_id, source: input.source },
    },
    async () => {
      // ── 1. Verify the catalog is in this project's linked globals list ──────
      let globals = []
      try { globals = getConfig()?.globals ?? [] } catch { /* config not loaded */ }

      if (!globals.includes(input.catalog_id)) {
        return {
          result: {
            status:     'not_linked',
            catalog_id: input.catalog_id,
            message:    `Catalog '${input.catalog_id}' is not in this project's globals list. ` +
                        `Add it to your .quorum file before recording deviations against it.`,
          },
          versionImpact: buildAuditVersionImpact([], []),
        }
      }

      // ── 2. Resolve internal IDs for the global catalog entry ────────────────
      const catalogQProjectId = await getProjectByGroupId(pg, input.catalog_id)
      if (!catalogQProjectId) {
        return {
          result: {
            status:     'not_found',
            catalog_id: input.catalog_id,
            topic:      input.topic,
            key:        input.key,
            message:    `Global catalog '${input.catalog_id}' is not registered in this Quorum instance.`,
          },
          versionImpact: buildAuditVersionImpact([], []),
        }
      }

      const catalogQKeyId = await getKeyId(pg, catalogQProjectId, input.topic, input.key)
      if (!catalogQKeyId) {
        return {
          result: {
            status:     'not_found',
            catalog_id: input.catalog_id,
            topic:      input.topic,
            key:        input.key,
            message:    `Entry '${input.topic}:${input.key}' does not exist in catalog '${input.catalog_id}'.`,
          },
          versionImpact: buildAuditVersionImpact([], []),
        }
      }

      const globalEntry = await getCurrentVersion(pg, catalogQKeyId)
      if (!globalEntry) {
        return {
          result: {
            status:     'not_found',
            catalog_id: input.catalog_id,
            topic:      input.topic,
            key:        input.key,
            message:    `Entry '${input.topic}:${input.key}' has no ACTIVE version in catalog '${input.catalog_id}'.`,
          },
          versionImpact: buildAuditVersionImpact([], []),
        }
      }

      // ── 3. Derive severity server-side ──────────────────────────────────────
      // severity = confidence × authority_score(author_role)
      // PA_AUTHORED_FLOOR = 0.70 prevents meaningless severity when global
      // entries are freshly created with low starting confidence.
      const confidence    = globalEntry.confidence ?? 0.5
      const authorRole    = globalEntry.author_role ?? globalEntry.author?.role ?? 'engineer'
      const authorityScore = DEFAULT_ROLE_SCORES[authorRole] ?? DEFAULT_ROLE_SCORES.engineer
      let severity = parseFloat((confidence * authorityScore).toFixed(3))

      if (authorRole === 'principal_architect' && severity < PA_AUTHORED_FLOOR) {
        severity = PA_AUTHORED_FLOOR
      }

      // ── 4. Resolve the project's q_project_id ──────────────────────────────
      const projectQProjectId = await getProjectByGroupId(pg, projectId)
      if (!projectQProjectId) {
        throw new Error(`deviate: project '${projectId}' not registered in this Quorum instance`)
      }

      // ── 5. Upsert the deviation record ──────────────────────────────────────
      const { deviation_id, is_new } = await upsertDeviation(pg, {
        qProjectId: projectQProjectId,
        catalogId:  input.catalog_id,
        topic:      input.topic,
        key:        input.key,
        description: input.description,
        evidence:   input.evidence ?? null,
        severity,
        source:     input.source ?? 'agent',
        entityType: globalEntry.entity_type ?? null,
        createdBy:  input.author ?? identity?.author ?? 'unknown',
      })

      return {
        result: {
          status:      'recorded',
          deviation_id,
          catalog_id:  input.catalog_id,
          topic:       input.topic,
          key:         input.key,
          severity,
          is_new,
          message:     is_new
            ? `Deviation recorded (severity ${severity.toFixed(3)}).`
            : `Deviation updated — last_seen_at refreshed (severity ${severity.toFixed(3)}).`,
        },
        versionImpact: buildAuditVersionImpact([], []),
      }
    },
  )

  return pipelineResult.result
}
