#!/usr/bin/env node
/**
 * postinstall.js — Runs automatically after `npm install -g @as-quorum/mcp`.
 *
 * Copies skill/ and hooks/ to ~/.claude, merges hook wiring into settings.json,
 * and registers the MCP server at user scope via `claude mcp add --scope user`.
 *
 * Exits 0 in all error cases so npm install never fails due to a Claude Code
 * setup issue.
 */

import { cpSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { installHooks } from './hooks.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// When bundled: __dirname = <pkg>/dist/  → pkgRoot = <pkg>/
// When run from src/install/ (dev): __dirname = <pkg>/src/install/  → pkgRoot = <pkg>/
const pkgRoot = existsSync(join(__dirname, 'skill'))
  ? __dirname
  : existsSync(join(__dirname, '..', 'skill'))
    ? join(__dirname, '..')
    : join(__dirname, '..', '..')

/**
 * Registers the Quorum MCP server with Claude Code at user (global) scope
 * by invoking `claude mcp add --scope user`.
 *
 * User scope makes the server available in every project without needing
 * per-project registration. Uses a concrete `node <abs-path>` command so
 * Claude Code can start the server without PATH or npx resolution.
 *
 * @param {string} serverPath - Absolute path to dist/server.js
 * @throws {Error} If the claude CLI is not found or exits non-zero
 */
export function registerMcpServer(serverPath) {
  // Only bake QUORUM_GATEWAY_URL into the MCP registration if it is already set
  // in the caller's environment. Engineers set it via their shell profile or
  // .quorum project file; we do not default to localhost here.
  const gatewayUrl = process.env.QUORUM_GATEWAY_URL?.trim() || null
  const args = [
    'mcp', 'add', '--scope', 'user', 'quorum',
    ...(gatewayUrl ? ['-e', `QUORUM_GATEWAY_URL=${gatewayUrl}`] : []),
    '--', 'node', serverPath,
  ]

  let result = spawnSync('claude', args, { stdio: 'pipe' })

  if (result.error) {
    throw new Error(`claude CLI not found: ${result.error.message}`)
  }

  // If the server is already registered, remove it and re-add so env vars stay current.
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() || ''
    if (stderr.includes('already exists')) {
      spawnSync('claude', ['mcp', 'remove', 'quorum', '-s', 'user'], { stdio: 'pipe' })
      result = spawnSync('claude', args, { stdio: 'pipe' })
      if (result.error) throw new Error(`claude CLI not found: ${result.error.message}`)
      if (result.status !== 0) {
        throw new Error(`claude mcp add failed (exit ${result.status}): ${result.stderr?.toString().trim()}`)
      }
      return
    }
    throw new Error(`claude mcp add failed (exit ${result.status}): ${stderr}`)
  }
}

async function main() {
  const claudeDir    = join(homedir(), '.claude')
  const hooksDir     = join(claudeDir, 'hooks')
  const settingsPath = join(claudeDir, 'settings.json')
  const skillSrc     = join(pkgRoot, 'skill')
  const skillDest    = join(claudeDir, 'skills', 'quorum')
  const scriptsSrc   = join(pkgRoot, 'hooks')
  const serverPath   = join(pkgRoot, 'dist', 'server.js')

  let allOk = true

  // 1. Install skill
  try {
    mkdirSync(join(claudeDir, 'skills'), { recursive: true })
    cpSync(skillSrc, skillDest, { recursive: true, force: true })
    console.log(`[quorum] ✓ Skill installed → ${skillDest}`)
  } catch (err) {
    console.warn(`[quorum] ✗ Skill install skipped: ${err.message}`)
    allOk = false
  }

  // 2. Install hooks + settings.json hook wiring
  try {
    installHooks({ hooksDir, settingsPath, scriptsSrc })
    console.log(`[quorum] ✓ Hooks installed → ${hooksDir}`)
    console.log(`[quorum] ✓ Hook wiring merged → ${settingsPath}`)
  } catch (err) {
    console.warn(`[quorum] ✗ Hook install skipped: ${err.message}`)
    allOk = false
  }

  // 3. Register MCP server at user scope via claude CLI
  try {
    registerMcpServer(serverPath)
    console.log(`[quorum] ✓ MCP server registered at user scope (${serverPath})`)
  } catch (err) {
    console.warn(`[quorum] ✗ MCP registration skipped: ${err.message}`)
    console.warn(`[quorum]   Run manually: claude mcp add --scope user quorum -- node ${serverPath}`)
    allOk = false
  }

  if (allOk) {
    console.log('[quorum] Setup complete. Run `quorum init` in any project to connect to a gateway.')
  } else {
    console.log('[quorum] Setup completed with warnings. Run `quorum install` to retry.')
  }

  // Always exit 0 — never block `npm install -g`
  process.exit(0)
}

// Only run when this file is the entry point, not when imported by tests
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
