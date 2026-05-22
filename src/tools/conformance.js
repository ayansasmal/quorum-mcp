/**
 * conformance() — Return this project's conformance score against linked global catalogs.
 *
 * Thin proxy to GET /api/conformance (gateway).
 * All scoring logic — weighted deviation ratio, UNCERTIFIED gate, catalog
 * coverage check, scan metadata — lives in the gateway.
 *
 * Output shape (CERTIFIED):
 *   {
 *     score:              number (0–100),
 *     status:             'CERTIFIED',
 *     applicable_entries: number,
 *     scan_count:         number,
 *     last_scan_at:       string | null,
 *     breakdown:          { open, accepted, denied, deferred, overdue, resolved },
 *     catalogs:           [{ catalog_id, entry_count }],
 *     top_deviations?:    [...] (when include_details: true)
 *   }
 *
 * Output shape (UNCERTIFIED):
 *   { score: null, status: 'UNCERTIFIED', ... }
 *   Returned when the project has no linked catalogs, total ACTIVE entries
 *   across all linked catalogs < 10, or no scan has been run yet.
 */

import { z } from 'zod'
import { withAuditPipeline } from '../audit/pipeline.js'
import { buildAuditVersionImpact } from '../governance/provenance.js'

export const schema = z.object({
  include_details: z.boolean().optional().default(false)
    .describe('When true, include top 10 open deviations by severity'),
  session_id: z.string().optional(),
})

/**
 * @param {import('../gateway/client.js').GatewayClient} pg
 * @param {z.infer<typeof schema>} input
 * @param {import('../identity/resolver.js').ResolvedIdentity} identity
 * @param {{ projectId: string, gatewayUrl: string } | null} [ctx]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function handler(pg, input, identity, ctx) {
  const projectId = ctx?.projectId
  if (!projectId) throw new Error('conformance: ctx.projectId is required — ensure a .quorum file exists in this workspace')

  const pipelineResult = await withAuditPipeline(
    pg,
    {
      tool:           'conformance',
      author:         identity?.name ?? 'anonymous',
      sessionId:      input.session_id,
      governanceData: { include_details: input.include_details },
    },
    async () => {
      const data = await pg.getConformance()

      // When UNCERTIFIED, return early with a clear message for the LLM.
      if (data.status === 'UNCERTIFIED') {
        return {
          result: {
            ...data,
            message: data.scan_count === 0
              ? 'No scans have been run yet. Run quorum:scan to establish a baseline.'
              : data.catalogs?.length === 0
                ? 'This project has no linked global catalogs. Use quorum:onboard to link catalogs.'
                : `Global catalog coverage is too sparse (${data.applicable_entries} ACTIVE entries across all linked catalogs; minimum 10 required). Seed the catalogs before scoring.`,
          },
          versionImpact: buildAuditVersionImpact([], []),
        }
      }

      // Optional: include top open deviations (sorted by severity desc)
      let topDeviations = undefined
      if (input.include_details) {
        const devData = await pg.getDeviations({ status: 'OPEN', limit: 10 })
        const sorted  = (devData?.deviations ?? [])
          .sort((a, b) => (b.severity ?? 0) - (a.severity ?? 0))
          .slice(0, 10)
        topDeviations = sorted
      }

      return {
        result: {
          ...data,
          ...(topDeviations !== undefined ? { top_deviations: topDeviations } : {}),
        },
        versionImpact: buildAuditVersionImpact([], []),
      }
    },
  )

  return pipelineResult.result
}
