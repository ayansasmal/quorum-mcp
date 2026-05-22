/**
 * deviate() — Record a project deviation from a linked global catalog entry.
 *
 * Called by agents during code review / security review / scheduled scans when
 * a project-local implementation diverges from a global catalog standard.
 *
 * Idempotent: re-calling with the same (catalog_id, topic, key) updates
 * last_seen_at and refreshes evidence — it does NOT create a duplicate row.
 *
 * Severity is derived server-side by the gateway:
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
 * @param {import('../gateway/client.js').GatewayClient} pg
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
      // Delegate all business logic (catalog validation, severity computation,
      // upsert) to the gateway — the MCP is a thin proxy here.
      const result = await pg.recordDeviation({
        catalog_id:  input.catalog_id,
        topic:       input.topic,
        key:         input.key,
        description: input.description,
        evidence:    input.evidence ?? null,
        source:      input.source ?? 'agent',
        author:      input.author ?? identity?.author ?? 'unknown',
      })
      return { result, versionImpact: buildAuditVersionImpact([], []) }
    },
  )

  return pipelineResult.result
}
