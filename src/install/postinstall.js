#!/usr/bin/env node
/**
 * postinstall.js — Runs automatically after `npm install -g @as-quorum/mcp`.
 *
 * Copies skill/ and hooks/ to ~/.claude, merges hook wiring into settings.json,
 * and registers the MCP server at user scope in ~/.claude.json.
 *
 * Exits 0 in all error cases so npm install never fails due to a Claude Code
 * setup issue.
 */

import { readFileSync, writeFileSync, cpSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
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
 * Merges the Quorum MCP server entry into ~/.claude.json at user (global) scope.
 * Claude Code stores user-scoped MCP servers under the top-level `mcpServers` key
 * in ~/.claude.json — distinct from project-scoped entries under `projects.<cwd>.mcpServers`.
 *
 * Writes a concrete `node <abs-path>` command so the entry works without npx or
 * PATH resolution at Claude Code startup time.
 *
 * @param {string} claudeJsonPath - Path to ~/.claude.json
 * @param {string} serverPath     - Absolute path to dist/server.js
 */
export function registerMcpServer(claudeJsonPath, serverPath) {
  let config = {}
  if (existsSync(claudeJsonPath)) {
    try {
      config = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    } catch {
      // ~/.claude.json is corrupt — skip rather than clobber user's Claude state
      return
    }
  }

  config.mcpServers = config.mcpServers || {}
  config.mcpServers.quorum = {
    type:    'stdio',
    command: 'node',
    args:    [serverPath],
    env:     {},
  }

  writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + '\n')
}

async function main() {
  const claudeDir      = join(homedir(), '.claude')
  const hooksDir       = join(claudeDir, 'hooks')
  const settingsPath   = join(claudeDir, 'settings.json')
  const claudeJsonPath = join(homedir(), '.claude.json')
  const skillSrc       = join(pkgRoot, 'skill')
  const skillDest      = join(claudeDir, 'skills', 'quorum')
  const scriptsSrc     = join(pkgRoot, 'hooks')
  const serverPath     = join(pkgRoot, 'dist', 'server.js')

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

  // 3. Register MCP server at user scope in ~/.claude.json
  try {
    registerMcpServer(claudeJsonPath, serverPath)
    console.log(`[quorum] ✓ MCP server registered at user scope (${serverPath})`)
  } catch (err) {
    console.warn(`[quorum] ✗ MCP registration skipped: ${err.message}`)
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
