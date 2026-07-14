/**
 * search() — Semantic search across the knowledge graph.
 *
 * Primary: Graphiti hybrid search (semantic + BM25 + graph traversal).
 * Fallback: PostgreSQL ILIKE on key, topic, and summary columns — used when
 *   Graphiti/FalkorDB is empty (e.g. after a volume wipe) so engineers can
 *   still find knowledge by name even before re-ingestion.
 * Filters out DRAFT, DEPRECATED, and REJECTED nodes from results.
 * Audited: what Claude searched for is part of the audit trail.
 */

import { z } from 'zod'
import { withAuditPipeline } from '../audit/pipeline.js'
import { searchNodes, searchFacts } from '../graph/client.js'
import { buildAuditVersionImpact } from '../governance/provenance.js'
import { KnowledgeStatus } from '../graph/schema.js'
import { resolveGlobals } from '../config/loader.js'

const EXCLUDED_STATUSES = new Set([
  KnowledgeStatus.DRAFT,
  KnowledgeStatus.DEPRECATED,
  KnowledgeStatus.REJECTED,
])

// Caps how many Graphiti calls this tool fires at once. Each call re-clones
// FalkorDriver per group_id, and every clone re-issues ~15-20 index-creation
// queries against FalkorDB (graphiti-core has no "already built" cache) — with
// many linked global catalogs, firing all searches at once can exhaust the
// FalkorDB client's connection pool and stall every call until abort.
const SEARCH_CONCURRENCY = 4

/**
 * Run async task factories with a concurrency cap, resolving to
 * Promise.allSettled-shaped results in the original order.
 * @param {Array<() => Promise<unknown>>} tasks
 * @param {number} concurrency
 * @returns {Promise<Array<{status: 'fulfilled', value: unknown} | {status: 'rejected', reason: unknown}>>}
 */
async function settleWithConcurrency(tasks, concurrency) {
  const results = new Array(tasks.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < tasks.length) {
      const i = nextIndex++
      try {
        results[i] = { status: 'fulfilled', value: await tasks[i]() }
      } catch (reason) {
        results[i] = { status: 'rejected', reason }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker))
  return results
}

export const schema = z.object({
  query: z.string().min(1).describe('Semantic search query'),
  domain: z.string().optional().describe('Optional domain filter (e.g. auth, api, db)'),
  limit: z.number().int().min(1).max(20).optional().default(5).describe('Max results (default 5)'),
  author: z.string().optional().default('unknown'),
  session_id: z.string().optional(),
})

/**
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @param {import('../identity/resolver.js').ResolvedIdentity} [identity]
 * @param {{ projectId: string, groupId?: string, gatewayUrl: string } | null} [ctx]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function handler(pg, input, identity, ctx) {
  const projectId = ctx?.projectId
  if (!projectId) throw new Error('search: ctx.projectId is required — ensure a .quorum file exists in this workspace')

  // Linked global catalogs for cross-catalog reads (Wave B federation).
  // Resolved via the gateway when available (authoritative — see resolveGlobals()
  // doc comment), falling back to project-scoped-only search otherwise. Must use
  // ctx.groupId (the human-facing slug, e.g. 'busy-hopper') here, not ctx.projectId
  // (the internal Postgres id, e.g. 'q_p13') — the gateway's GET /config/:id route
  // checks the path param against req.user.project, which is always the group_id.
  const globals = await resolveGlobals(pg, ctx?.groupId ?? projectId)

  const pipelineResult = await withAuditPipeline(
    pg,
    {
      tool: 'search',
      author: input.author ?? 'unknown',
      sessionId: input.session_id,
      governanceData: { query: input.query, domain: input.domain },
    },
    async () => {
      // Run project search + one search per linked global catalog, capped at
      // SEARCH_CONCURRENCY concurrent Graphiti calls (see constant doc above).
      // Separate per-catalog searches preserve catalog_id attribution on each result.
      // Facts are searched with all group IDs combined (facts are cross-referenced by
      // node UUID, not by catalog, so per-catalog attribution is not needed there).
      const [projectResult, factsResult, ...globalResults] = await settleWithConcurrency([
        () => searchNodes(input.query, { limit: input.limit * 2, groupId: projectId }),
        () => searchFacts(input.query, { groupIds: [projectId, ...globals] }),
        ...globals.map((catalogId) => () => searchNodes(input.query, { limit: input.limit, groupId: catalogId })),
      ], SEARCH_CONCURRENCY)

      const projectNodes = projectResult.status === 'fulfilled'
        ? (projectResult.value?.nodes ?? [])
        : []
      const facts = factsResult.status === 'fulfilled' ? (factsResult.value?.facts ?? []) : []

      // Tag source and catalog_id on each node before merging.
      // catalog_id is null for project-local entries; the catalog group_id for global entries.
      const taggedProject = projectNodes.map((n) => ({ ...n, _source: 'project', _catalog_id: null }))
      const taggedGlobal  = globalResults.flatMap((result, i) => {
        if (result.status !== 'fulfilled') return []
        const catalogId = globals[i]
        return (result.value?.nodes ?? []).map((n) => ({ ...n, _source: 'global', _catalog_id: catalogId }))
      })

      // Merge + deduplicate by episode UUID (project wins over global on tie)
      const seen = new Set()
      const merged = [...taggedProject, ...taggedGlobal].filter((node) => {
        const id = node.uuid ?? node.episode_id ?? node.name
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })

      // Filter out nodes with excluded statuses
      const filtered = merged.filter((node) => {
        const status = node.metadata?.status ?? node.status
        return !status || !EXCLUDED_STATUSES.has(status)
      })

      // Apply domain filter if provided
      const domainFiltered = input.domain
        ? filtered.filter((node) => {
            const nodeDomain = node.metadata?.domain ?? node.domain ?? ''
            const nodeName = node.name ?? ''
            return nodeDomain.includes(input.domain) || nodeName.startsWith(input.domain)
          })
        : filtered

      // Sort: project-local first on equal score, then by score descending
      const sorted = domainFiltered.sort(
        (a, b) => (b.score ?? b.similarity ?? 0) - (a.score ?? a.similarity ?? 0)
          || (a._source === 'project' ? -1 : 1),
      )

      const results = sorted.slice(0, input.limit).map((node) => ({
        topic_key: node.name ?? node.uuid,
        summary: node.summary ?? node.content,
        author: node.metadata?.author,
        confidence: node.metadata?.confidence,
        status: node.metadata?.status ?? 'ACTIVE',
        score: node.score ?? node.similarity,
        source: node._source,       // 'project' | 'global'
        catalog_id: node._catalog_id ?? null,  // group_id of the source global catalog; null for project-local
        episode_id: node.uuid ?? node.episode_id,
        related_facts: facts
          .filter((f) => f.source_node_uuid === node.uuid || f.target_node_uuid === node.uuid)
          .slice(0, 3)
          .map((f) => f.fact),
      }))

      // If Graphiti returned nothing (empty FalkorDB / offline), fall back to
      // a keyword search over PostgreSQL via the typed gateway endpoint.
      // pg is a GatewayClient here — raw pg.query() always throws, so we route
      // through the dedicated /pg/search route via searchByText().
      if (results.length === 0) {
        try {
          const fallback = await pg.searchByText(input.query, {
            domain: input.domain,
            limit:  input.limit,
          })
          if (fallback.results?.length > 0) {
            return {
              result: {
                results:  fallback.results.map((r) => ({
                  topic_key:     `${r.topic}:${r.key}`,
                  summary:       r.summary || null,
                  author:        r.author,
                  confidence:    r.confidence,
                  status:        r.status,
                  score:         null,
                  source:        'postgres-fallback',
                  episode_id:    null,
                  related_facts: [],
                })),
                total:    fallback.results.length,
                query:    input.query,
                fallback: 'postgres',
              },
              versionImpact: buildAuditVersionImpact([], []),
            }
          }
        } catch { /* fallback unavailable — return empty */ }
      }

      return {
        result: { results, total: results.length, query: input.query },
        versionImpact: buildAuditVersionImpact([], []),
      }
    },
  )

  return pipelineResult.result
}
