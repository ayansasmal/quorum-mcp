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
import { getConfig } from '../config/loader.js'

const EXCLUDED_STATUSES = new Set([
  KnowledgeStatus.DRAFT,
  KnowledgeStatus.DEPRECATED,
  KnowledgeStatus.REJECTED,
])

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
 * @param {{ projectId: string, gatewayUrl: string } | null} [ctx]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function handler(pg, input, identity, ctx) {
  const projectId = ctx?.projectId
  if (!projectId) throw new Error('search: ctx.projectId is required — ensure a .quorum file exists in this workspace')

  // Linked global catalogs for cross-catalog reads (Wave B federation).
  // getConfig() throws when config is not loaded (e.g. early startup or tests
  // without a mock) — fall back to empty array so searches remain project-scoped.
  let globals = []
  try { globals = getConfig()?.globals ?? [] } catch { /* config not loaded */ }

  const pipelineResult = await withAuditPipeline(
    pg,
    {
      tool: 'search',
      author: input.author ?? 'unknown',
      sessionId: input.session_id,
      governanceData: { query: input.query, domain: input.domain },
    },
    async () => {
      // Run project search + one search per linked global catalog in parallel.
      // Separate per-catalog searches preserve catalog_id attribution on each result.
      // Facts are searched with all group IDs combined (facts are cross-referenced by
      // node UUID, not by catalog, so per-catalog attribution is not needed there).
      const [projectResult, factsResult, ...globalResults] = await Promise.allSettled([
        searchNodes(input.query, { limit: input.limit * 2, groupId: projectId }),
        searchFacts(input.query, { groupIds: [projectId, ...globals] }),
        ...globals.map((catalogId) => searchNodes(input.query, { limit: input.limit, groupId: catalogId })),
      ])

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
