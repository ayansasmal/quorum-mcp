/**
 * reflect() — Post-task self-evolution tool.
 *
 * Called by Claude Code skill after task completion. Extracts learnable
 * engineering knowledge from a task summary and stores it via remember().
 *
 * All reflected knowledge enters as DRAFT (Claude-authored).
 * Mode is declared: echoing (0.75), extracting (0.55), generalising (0.35).
 *
 * Claude never presents Mode 3 (generalising) as Mode 1 (echoing).
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { withAuditPipeline } from '../audit/pipeline.js'
import { buildAuditVersionImpact } from '../governance/provenance.js'
import { TriggeredBy } from '../graph/schema.js'
import { handler as rememberHandler } from './remember.js'

export const schema = z.object({
  task_summary: z.string().min(1).describe('Summary of the completed task'),
  decisions_made: z.array(z.string()).optional().describe('Explicit decisions made during the task'),
  patterns_used: z.array(z.string()).optional().describe('Patterns applied during the task'),
  author: z.string().optional().default('claude').describe('Authoring agent (default: claude)'),
  session_id: z.string().optional(),
})

/**
 * @typedef {{ topic: string, key: string, content: string, entity_type: string, confidence: number, mode: string }} ExtractedItem
 */

/**
 * Extract learnable knowledge via the gateway LLM (POST /governance/extract).
 * The MCP never calls OpenAI directly — the gateway owns the LLM key.
 * Returns empty array with a logged warning when the gateway endpoint is unavailable.
 *
 * @param {string} taskSummary
 * @param {string[]} decisionsMade
 * @param {string[]} patternsUsed
 * @param {import('../gateway/client.js').GatewayClient} gw
 * @returns {Promise<{ items: ExtractedItem[], llmUnavailable: boolean }>}
 */
async function extractKnowledge(taskSummary, decisionsMade = [], patternsUsed = [], gw) {
  try {
    const result = await gw._post('/governance/extract', {
      task_summary: taskSummary,
      decisions_made: decisionsMade,
      patterns_used: patternsUsed,
    })
    return { items: result.items ?? [], llmUnavailable: false }
  } catch (err) {
    const isNotImplemented = err.message?.includes('404') || err.message?.includes('501')
    if (isNotImplemented) {
      console.error('[Quorum:reflect] Gateway LLM not yet enabled (POST /governance/extract not found). Configure OPENAI_API_KEY on the gateway to enable knowledge extraction.')
    } else {
      console.error(`[Quorum:reflect] Knowledge extraction unavailable: ${err.message}`)
    }
    return { items: [], llmUnavailable: true }
  }
}

/**
 * Check if an identical DRAFT for this topic:key already exists.
 * Uses version history via gateway — avoids raw SQL.
 *
 * @param {import('../gateway/client.js').GatewayClient} gw
 * @param {string} topic
 * @param {string} key
 * @param {string} contentHash - SHA-256 hex of the content body
 * @returns {Promise<boolean>}
 */
async function isDuplicateReflect(gw, topic, key, contentHash) {
  try {
    const history = await gw.getVersionHistory(topic, key)
    return Array.isArray(history) && history.some(
      (v) => v.status === 'DRAFT' && v.content_hash === contentHash,
    )
  } catch {
    return false
  }
}

/**
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @returns {Promise<Record<string, unknown>>}
 */
export async function handler(pg, input) {
  const pipelineResult = await withAuditPipeline(
    pg,
    {
      tool: 'reflect',
      author: input.author ?? 'claude',
      sessionId: input.session_id,
      governanceData: { task_summary_length: input.task_summary.length },
    },
    async () => {
      const { items: extracted, llmUnavailable } = await extractKnowledge(
        input.task_summary,
        input.decisions_made ?? [],
        input.patterns_used ?? [],
        pg,
      )

      const stored = []
      const conflicts = []
      const failed = []
      let skipped = 0

      for (const item of extracted) {
        // GAP-13: skip if identical content already exists as DRAFT for this topic:key
        const contentHash = createHash('sha256').update(item.content).digest('hex')
        // eslint-disable-next-line no-await-in-loop
        if (await isDuplicateReflect(pg, item.topic, item.key, contentHash)) {
          skipped++
          continue
        }

        try {
          const result = await rememberHandler(pg, {
            topic: item.topic,
            key: item.key,
            content: item.content,
            author: input.author ?? 'claude',
            confidence: item.confidence,
            entity_type: item.entity_type,
            triggered_by: TriggeredBy.REFLECT,
            session_id: input.session_id,
          })

          if (result?.status === 'conflict_detected') {
            conflicts.push({ ...item, conflict: result })
          } else {
            stored.push({ ...item, result })
          }
        } catch (err) {
          failed.push({ ...item, error: err.message })
        }
      }

      return {
        result: {
          extracted: extracted.length,
          stored: stored.length,
          conflicts: conflicts.length,
          failed: failed.length,
          skipped,
          items: stored,
          conflict_items: conflicts,
          failed_items: failed,
          note: llmUnavailable
            ? 'Knowledge extraction unavailable — the Quorum gateway does not have LLM configured (OPENAI_API_KEY not set on the gateway). Use remember() to manually record key decisions from this task.'
            : extracted.length === 0
              ? 'No team-specific knowledge identified in this task.'
              : skipped === extracted.length
                ? `All ${extracted.length} item(s) already in DRAFT — no duplicates stored.`
                : `${stored.length} knowledge item(s) added as DRAFT — pending review.${skipped > 0 ? ` ${skipped} skipped (duplicate).` : ''}`,
        },
        versionImpact: buildAuditVersionImpact([], []),
      }
    },
  )

  return pipelineResult.result
}
