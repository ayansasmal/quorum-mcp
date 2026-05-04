#!/usr/bin/env node
/**
 * Quorum CLI — quorum <command>
 *
 * Commands:
 *   install                       Install skill + register MCP with Claude Code
 *   init                          Create .quorum project file in current directory
 *   history <topic:key>           Full version timeline
 *   audit verify                  Verify SHA256 audit chain integrity
 *   audit lineage <topic:key>     Full lineage trace for a knowledge node
 *   audit export                  Export audit log (JSONL)
 *   audit stats                   Audit chain statistics
 *   config validate <file>        Validate a local quorum.config.json against the schema
 *   config show                   Show currently loaded config from gateway
 *   projects list                 List projects the authenticated engineer belongs to
 */

import { program } from 'commander'
import { readFileSync, writeFileSync, existsSync, cpSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { GatewayClient } from './src/gateway/client.js'
import { verifyChain } from './src/audit/chain.js'
import { handler as historyHandler } from './src/tools/history.js'
import { findQuorumFile, loadQuorumFile, suggestProjectId } from './src/quorum-file.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Gateway helpers ────────────────────────────────────────────────────────────

/**
 * Resolve gateway URL and project ID from .quorum file or env vars.
 * Exits with a clear error if QUORUM_GATEWAY_URL is not available.
 * @returns {{ gatewayUrl: string, projectId: string }}
 */
function resolveGatewayConfig() {
  const quorumFile = findQuorumFile()
  const loaded = quorumFile ? loadQuorumFile(quorumFile) : null

  const gatewayUrl = process.env.QUORUM_GATEWAY_URL ?? loaded?.gateway_url ?? ''
  const projectId  = process.env.QUORUM_PROJECT_ID  ?? loaded?.project_id  ?? 'default'

  if (!gatewayUrl) {
    console.error('Error: QUORUM_GATEWAY_URL is not set.')
    console.error('Run `quorum init` to create a .quorum file, or set QUORUM_GATEWAY_URL in your environment.')
    process.exit(1)
  }

  return { gatewayUrl, projectId }
}

/**
 * Create an authenticated GatewayClient for CLI commands.
 * Requires QUORUM_GITHUB_TOKEN in the environment.
 * @returns {GatewayClient}
 */
function getCliGatewayClient() {
  const { gatewayUrl, projectId } = resolveGatewayConfig()
  const githubToken = process.env.QUORUM_GITHUB_TOKEN

  if (!githubToken) {
    console.error('Error: QUORUM_GITHUB_TOKEN is not set.')
    console.error('Set it to a GitHub Personal Access Token so the gateway can verify your identity.')
    process.exit(1)
  }

  return new GatewayClient(gatewayUrl, githubToken, projectId)
}

/**
 * Fetch a raw JWT token from the gateway (for config/projects commands that pass it manually).
 * @param {string} gatewayUrl
 * @returns {Promise<string>} JWT access token
 */
async function fetchToken(gatewayUrl) {
  const githubToken = process.env.QUORUM_GITHUB_TOKEN
  if (!githubToken) {
    console.error('Error: QUORUM_GITHUB_TOKEN is not set.')
    console.error('Set it to a GitHub Personal Access Token so the gateway can verify your identity.')
    process.exit(1)
  }

  const res = await fetch(`${gatewayUrl}/auth/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ github_token: githubToken }),
  })

  if (!res.ok) {
    const body = await res.text()
    console.error(`Error: Gateway auth failed (${res.status}): ${body}`)
    process.exit(1)
  }

  const data = await res.json()
  return data.token
}

// ── install ───────────────────────────────────────────────────────────────────

program
  .command('install')
  .description('Install the Quorum skill and register the MCP server with Claude Code')
  .option('--skip-mcp',   'Skip claude mcp add registration')
  .option('--skip-skill', 'Skip skill installation')
  .action(async (opts) => {
    if (!opts.skipSkill) {
      const skillSrc  = join(__dirname, 'skill')
      const skillDest = join(homedir(), '.claude', 'skills', 'quorum')
      try {
        mkdirSync(join(homedir(), '.claude', 'skills'), { recursive: true })
        cpSync(skillSrc, skillDest, { recursive: true, force: true })
        console.log(`✓ Skill installed → ${skillDest}`)
      } catch (err) {
        console.error(`✗ Skill install failed: ${err.message}`)
        process.exit(1)
      }
    }

    if (!opts.skipMcp) {
      const result = spawnSync(
        'claude',
        ['mcp', 'add', 'quorum', '--', 'npx', '@as-quorum/mcp'],
        { stdio: 'inherit' },
      )
      if (result.status !== 0) {
        console.error('✗ MCP registration failed. Is the claude CLI installed?')
        console.error('  Run manually: claude mcp add quorum -- npx @as-quorum/mcp')
        process.exit(1)
      }
      console.log('✓ MCP server registered with Claude Code')
    }

    console.log('')
    console.log('Quorum is ready. Run `quorum init` in any project to connect it to a gateway.')
  })

// ── history ────────────────────────────────────────────────────────────────────

program
  .command('history <topicKey>')
  .description('Show full version timeline for a knowledge node (e.g. auth:token-strategy)')
  .action(async (topicKey) => {
    const [topic, ...keyParts] = topicKey.split(':')
    const key = keyParts.join(':')

    if (!topic || !key) {
      console.error('Usage: quorum history <topic:key>')
      process.exit(1)
    }

    const gw = getCliGatewayClient()
    try {
      const result = await historyHandler(gw, { topic, key, author: 'cli' })
      if (!result) {
        console.log(`No knowledge found for ${topicKey}`)
      } else {
        console.log(result.formatted ?? JSON.stringify(result, null, 2))
      }
    } catch (err) {
      console.error('Error:', err.message)
      process.exit(1)
    }
  })

// ── audit verify ──────────────────────────────────────────────────────────────

program
  .command('audit verify')
  .description('Verify SHA256 audit chain integrity')
  .action(async () => {
    const gw = getCliGatewayClient()
    try {
      const entries = await gw.getAllEntries({})
      if (entries.length === 0) {
        console.log('Audit chain: empty (no entries yet)')
        return
      }
      const result = verifyChain(entries)
      console.log(`✓ Chain integrity: OK (${result.entries} entries verified)`)
    } catch (err) {
      if (err.name === 'ChainIntegrityViolation') {
        console.error(`✗ Chain integrity VIOLATED at position ${err.position}`)
        console.error(`  Expected: ${err.expected}`)
        console.error(`  Actual:   ${err.actual}`)
        process.exit(1)
      }
      console.error('Error:', err.message)
      process.exit(1)
    }
  })

// ── audit lineage ─────────────────────────────────────────────────────────────

program
  .command('audit lineage <topicKey>')
  .description('Show full audit lineage for a knowledge node')
  .action(async () => {
    // Requires a gateway endpoint (GET /pg/audit/lineage/:topic/:key) not yet implemented.
    // Use the dashboard Audit Timeline at http://localhost:3002/audit in the meantime.
    console.error('audit lineage is not yet available via the gateway.')
    console.error('Use the Audit Timeline in the dashboard: http://localhost:3002/audit')
    process.exit(1)
  })

// ── audit export ──────────────────────────────────────────────────────────────

program
  .command('audit export')
  .description('Export audit log as JSONL')
  .option('--from <date>', 'Start date (ISO)')
  .option('--to <date>',   'End date (ISO)')
  .option('--format <fmt>', 'Output format: jsonl (default)', 'jsonl')
  .action(async (opts) => {
    const gw = getCliGatewayClient()
    try {
      const entries = await gw.getAllEntries({ from: opts.from, to: opts.to })
      for (const entry of entries) {
        console.log(JSON.stringify(entry))
      }
    } catch (err) {
      console.error('Error:', err.message)
      process.exit(1)
    }
  })

// ── audit stats ───────────────────────────────────────────────────────────────

program
  .command('audit stats')
  .description('Show audit chain statistics')
  .action(async () => {
    const gw = getCliGatewayClient()
    try {
      const [count, entries] = await Promise.all([
        gw.countEntries(),
        gw.getAllEntries({}),
      ])
      const latest = entries.reduce(
        (max, e) => (e.chain_position > (max?.chain_position ?? -1) ? e : max),
        null,
      )

      console.log('\nQuorum Audit Stats')
      console.log('─'.repeat(40))
      console.log(`Total entries:    ${count}`)
      if (latest) {
        console.log(`Latest position:  ${latest.chain_position}`)
        console.log(`Latest entry:     ${new Date(latest.timestamp).toISOString()} by @${latest.author} (${latest.tool})`)
      }
      console.log('')
    } catch (err) {
      console.error('Error:', err.message)
      process.exit(1)
    }
  })

// ── init ──────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Create a .quorum project file in the current directory')
  .option('--gateway-url <url>', 'Quorum Gateway URL (can also be set via env QUORUM_GATEWAY_URL)')
  .option('--project-id <id>',  'Project ID for this repository (default: directory name)')
  .option('--yes', 'Skip interactive prompts and use provided options / defaults')
  .action(async (opts) => {
    const targetPath = join(process.cwd(), '.quorum')

    if (existsSync(targetPath)) {
      console.log(`.quorum already exists at ${targetPath}`)
      console.log('Delete it first if you want to re-initialize.')
      process.exit(1)
    }

    let gatewayUrl = opts.gatewayUrl ?? process.env.QUORUM_GATEWAY_URL ?? ''
    let projectId  = opts.projectId  ?? process.env.QUORUM_PROJECT_ID  ?? suggestProjectId()

    if (!opts.yes) {
      const rl  = createInterface({ input: process.stdin, output: process.stdout })
      const ask = (q) => new Promise((res) => rl.question(q, res))

      try {
        gatewayUrl = (await ask(`Gateway URL [${gatewayUrl || 'required'}]: `)).trim() || gatewayUrl
        projectId  = (await ask(`Project ID [${projectId}]: `)).trim() || projectId
      } finally {
        rl.close()
      }
    }

    if (!gatewayUrl) {
      console.error('Error: gateway_url is required. Pass --gateway-url or set QUORUM_GATEWAY_URL.')
      process.exit(1)
    }

    const content = JSON.stringify({ gateway_url: gatewayUrl, project_id: projectId }, null, 2) + '\n'
    writeFileSync(targetPath, content, 'utf8')

    console.log(`✓ Created .quorum`)
    console.log(`  gateway_url: ${gatewayUrl}`)
    console.log(`  project_id:  ${projectId}`)
    console.log('')
    console.log('Commit this file to your repository so all engineers auto-discover the gateway.')
    console.log('It is safe to commit — it contains no credentials.')
  })

// ── config validate ───────────────────────────────────────────────────────────

const configCmd = program.command('config').description('Quorum config management')

configCmd
  .command('validate <file>')
  .description('Validate a local quorum.config.json against the Quorum schema')
  .action(async (file) => {
    const { gatewayUrl } = resolveGatewayConfig()
    const filePath = resolve(file)

    let raw
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch (err) {
      console.error(`Error reading ${filePath}: ${err.message}`)
      process.exit(1)
    }

    const res = await fetch(`${gatewayUrl}/config/validate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(raw),
    })

    const body = await res.json()

    if (res.ok) {
      console.log(`✓ Config is valid (${filePath})`)
      console.log(`  Project:   ${body.project}`)
      console.log(`  Members:   ${body.members}`)
      console.log(`  Roles:     ${body.roles.join(', ')}`)
      console.log(`  Domains:   ${body.domains.join(', ') || '(none)'}`)
    } else {
      console.error(`✗ Config is invalid (${res.status})`)
      if (body.errors) {
        for (const err of body.errors) {
          console.error(`  ${err.path?.join('.') ?? 'root'}: ${err.message}`)
        }
      } else {
        console.error(JSON.stringify(body, null, 2))
      }
      process.exit(1)
    }
  })

// ── config show ───────────────────────────────────────────────────────────────

configCmd
  .command('show')
  .description('Show the currently loaded config for your project (fetched from gateway)')
  .action(async () => {
    const { gatewayUrl, projectId } = resolveGatewayConfig()
    const token = await fetchToken(gatewayUrl)

    const res = await fetch(`${gatewayUrl}/config/${encodeURIComponent(projectId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
      const body = await res.text()
      console.error(`Error: ${res.status} ${body}`)
      process.exit(1)
    }

    const config = await res.json()
    console.log(JSON.stringify(config, null, 2))
  })

// ── projects list ─────────────────────────────────────────────────────────────

const projectsCmd = program.command('projects').description('Quorum project discovery')

projectsCmd
  .command('list')
  .description('List Quorum projects you are a member of')
  .action(async () => {
    const { gatewayUrl } = resolveGatewayConfig()
    const token = await fetchToken(gatewayUrl)

    const res = await fetch(`${gatewayUrl}/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
      const body = await res.text()
      console.error(`Error: ${res.status} ${body}`)
      process.exit(1)
    }

    const { projects } = await res.json()

    if (!projects || projects.length === 0) {
      console.log('No projects found. Ask your team lead to add you to the project config in S3.')
      return
    }

    console.log(`\nQuorum Projects (${projects.length})\n${'─'.repeat(40)}`)
    for (const p of projects) {
      const marker = p.project_id === process.env.QUORUM_PROJECT_ID ? ' ←' : ''
      console.log(`  ${p.project_id.padEnd(30)} ${p.member_role ?? ''}${marker}`)
    }
    console.log('')
  })

program.parse()
