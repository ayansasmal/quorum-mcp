/**
 * recall() — Retrieve engineering knowledge by topic:key.
 *
 * Options:
 *   default          → returns ACTIVE version only
 *   { history: true} → full version chain (newest first)
 *   { at: "date" }   → version that was ACTIVE on that date
 *   { version: N }   → specific version N
 *
 * Returns structured XML format for Claude context injection.
 * Includes version freshness flag if updated within 7 days.
 */

import { z } from 'zod'
import { withAuditPipeline } from '../audit/pipeline.js'
import { getCurrentVersion, getVersionHistory, getVersionAtDate, getSpecificVersion, incrementDomainStat } from '../graph/queries.js'
import { buildAuditVersionImpact } from '../governance/provenance.js'
import { getConfig } from '../config/loader.js'

const FRESHNESS_DAYS = 7

/**
 * Escape a value for safe interpolation into XML content or attribute values.
 * Prevents prompt injection via stored knowledge content.
 * @param {unknown} s
 * @returns {string}
 */
function escapeXml(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export const schema = z.object({
  topic: z.string().min(1).describe('Knowledge domain'),
  key: z.string().min(1).describe('Unique identifier within the topic'),
  history: z.boolean().optional().describe('Return full version chain'),
  at: z.string().optional().describe('ISO date — return version active on this date'),
  version: z.number().int().positive().optional().describe('Return a specific version number'),
  session_id: z.string().optional(),
  author: z.string().optional().default('unknown').describe('Who is recalling (for audit)'),
})

/**
 * @param {import('pg').Pool} pg
 * @param {z.infer<typeof schema>} input
 * @param {import('../identity/resolver.js').ResolvedIdentity} [identity]
 * @param {{ projectId: string, gatewayUrl: string } | null} [ctx]
 * @returns {Promise<string | null>}
 */
export async function handler(pg, input, identity, ctx) {
  const projectId = ctx?.projectId
  if (!projectId) throw new Error('recall: ctx.projectId is required — ensure a .quorum file exists in this workspace')

  const pipelineResult = await withAuditPipeline(
    pg,
    {
      tool: 'recall',
      author: input.author ?? 'unknown',
      sessionId: input.session_id,
      topic: input.topic,
      key: input.key,
    },
    async () => {
      // ── History mode ──────────────────────────────────────────────────────
      if (input.history) {
        const versions = await getVersionHistory(pg, input.topic, input.key, projectId)
        if (versions.length === 0) return { result: { status: 'not_found', topic: input.topic, key: input.key }, versionImpact: buildAuditVersionImpact([], []) }
        return {
          result: formatHistory(input.topic, input.key, versions),
          versionImpact: buildAuditVersionImpact([], []),
        }
      }

      // ── Point-in-time mode ────────────────────────────────────────────────
      if (input.at) {
        const version = await getVersionAtDate(pg, input.topic, input.key, input.at, projectId)
        if (!version) return { result: { status: 'not_found', topic: input.topic, key: input.key }, versionImpact: buildAuditVersionImpact([], []) }
        return {
          result: formatVersion(version, { pointInTime: input.at }),
          versionImpact: buildAuditVersionImpact([], []),
        }
      }

      // ── Specific version mode ─────────────────────────────────────────────
      if (input.version != null) {
        const version = await getSpecificVersion(pg, input.topic, input.key, input.version, projectId)
        if (!version) return { result: { status: 'not_found', topic: input.topic, key: input.key }, versionImpact: buildAuditVersionImpact([], []) }
        return {
          result: formatVersion(version, { explicit: true }),
          versionImpact: buildAuditVersionImpact([], []),
        }
      }

      // ── Default: ACTIVE version with global catalog fallback (Wave B) ──────
      // getConfig() throws when config is not loaded — fall back to empty array
      // so recall remains project-scoped (safe backward-compat default).
      let globals = []
      try { globals = getConfig()?.globals ?? [] } catch { /* config not loaded */ }

      let version = await getCurrentVersion(pg, input.topic, input.key, projectId)
      let fromCatalogId = null  // group_id of the catalog this was found in; null = project-local

      // If no project-local result, walk linked global catalogs in order.
      // First catalog to have an ACTIVE version wins.
      if (!version) {
        for (const catalogId of globals) {
          version = await getCurrentVersion(pg, input.topic, input.key, catalogId)
          if (version) { fromCatalogId = catalogId; break }
        }
      }

      if (!version) return { result: { status: 'not_found', topic: input.topic, key: input.key }, versionImpact: buildAuditVersionImpact([], []) }

      // GAP-21: increment recalled_count for the author in this domain (fire-and-forget)
      incrementDomainStat(pg, {
        author: version.author,
        domain: input.topic,
        projectId,
        field: 'recalled_count',
      }).catch(() => {})

      return {
        result: formatVersion(version, { catalogId: fromCatalogId }),
        versionImpact: buildAuditVersionImpact([], []),
      }
    },
  )

  return pipelineResult.result
}

// ── Formatting ────────────────────────────────────────────────────────────────

/**
 * Format a single version as XML for Claude context injection.
 * @param {Record<string, unknown>} version
 * @param {{ pointInTime?: string, explicit?: boolean, catalogId?: string | null }} opts
 * @returns {string}
 */
function formatVersion(version, opts) {
  const daysSince = (Date.now() - new Date(version.created_at).getTime()) / (1000 * 60 * 60 * 24)
  const isRecent = daysSince < FRESHNESS_DAYS
  const isSuperseded = version.status === 'SUPERSEDED'
  const source = opts.catalogId ? 'global' : 'project'
  const catalogId = opts.catalogId ?? ''

  let xml = `<quorum_memory topic="${escapeXml(version.topic)}" key="${escapeXml(version.key)}" version="${escapeXml(version.version)}" status="${escapeXml(version.status)}" author="${escapeXml(version.author)}" updated="${formatDate(version.created_at)}" triggered_by="${escapeXml(version.triggered_by)}" source="${source}" catalog_id="${escapeXml(catalogId)}">`

  if (opts.catalogId) {
    xml += `\n  <!-- ℹ️  Sourced from global catalog '${escapeXml(opts.catalogId)}' — org-wide standard, readonly from this project -->`
  }

  if (opts.pointInTime) {
    xml += `\n  <!-- Point-in-time recall: active on ${opts.pointInTime} -->`
  }

  if (isSuperseded) {
    xml += `\n  <!-- ⚠️  SUPERSEDED by v${escapeXml(version.superseded_by_version)} on ${formatDate(version.superseded_at)} by @${escapeXml(version.superseded_by_author)} -->`
    if (version.supersedes_reason) {
      xml += `\n  <!-- Reason: ${escapeXml(version.supersedes_reason)} -->`
    }
  }

  if (isRecent && !isSuperseded) {
    xml += `\n  <!-- ℹ️  Updated ${Math.round(daysSince)} day(s) ago -->`
    if (version.supersedes_version) {
      xml += `\n  <!-- Supersedes v${escapeXml(version.supersedes_version)}. Reason: ${escapeXml(version.supersedes_reason ?? 'not specified')} -->`
    }
  }

  xml += `\n${escapeXml(version.summary ?? version.content ?? '')}`
  xml += `\n</quorum_memory>`

  return xml
}

/**
 * Format a full version history as structured text.
 * @param {string} topic
 * @param {string} key
 * @param {Array<Record<string, unknown>>} versions - ordered newest first
 * @returns {string}
 */
function formatHistory(topic, key, versions) {
  const lines = [
    `${topic}:${key} — Version History`,
    '─'.repeat(54),
  ]

  for (const v of versions) {
    const active = v.status === 'ACTIVE'
    const marker = active ? '●' : ' '
    lines.push(`v${v.version} ${marker} ${v.status.padEnd(10)} @${v.author}   ${formatDate(v.created_at)}`)
    if (v.supersedes_reason) {
      lines.push(`   Reason: ${v.supersedes_reason}`)
    }
    lines.push(`   Triggered by: ${v.triggered_by}`)
    if (v.superseded_by_version) {
      lines.push(`   Superseded by v${v.superseded_by_version} on ${formatDate(v.superseded_at)} by @${v.superseded_by_author}`)
    }
    lines.push(`   Audit: ${v.created_by_audit}`)
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * @param {string | Date | null} date
 * @returns {string}
 */
function formatDate(date) {
  if (!date) return 'unknown'
  return new Date(date).toISOString().split('T')[0]
}
