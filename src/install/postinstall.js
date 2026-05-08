#!/usr/bin/env node
/**
 * postinstall.js — Runs automatically after `npm install -g @as-quorum/mcp`.
 *
 * Copies skill/ and hooks/ to ~/.claude, merges hook wiring into settings.json,
 * and registers the MCP server under mcpServers in settings.json.
 *
 * Only runs for global installs. Exits 0 in all error cases so npm install
 * never fails due to a Claude Code setup issue.
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
 * Guards against running during local `npm install` in the dev repo.
 * npm sets npm_config_global=true only for `npm install -g`.
 * @returns {boolean}
 */
function isGlobalInstall() {
  return process.env.npm_config_global === 'true'
}

/**
 * Merges the Quorum MCP server entry into the mcpServers section of settings.json.
 * Writes a concrete `node <abs-path>` command so the entry is portable without
 * requiring `npx` or PATH resolution at Claude Code startup time.
 *
 * @param {string} settingsPath - Path to ~/.claude/settings.json
 * @param {string} serverPath   - Absolute path to dist/server.js
 */
export function registerMcpServer(settingsPath, serverPath) {
  let settings = {}
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    } catch {
      // Already handled (and throws) in installHooks; if we reach here settings.json
      // must be valid since installHooks ran first.
      return
    }
  }

  settings.mcpServers = settings.mcpServers || {}
  settings.mcpServers.quorum = {
    command: 'node',
    args:    [serverPath],
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
}

async function main() {
  if (!isGlobalInstall()) {
    // Silent exit — local dev install, nothing to do
    process.exit(0)
  }

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

  // 3. Register MCP server in settings.json
  try {
    registerMcpServer(settingsPath, serverPath)
    console.log(`[quorum] ✓ MCP server registered (${serverPath})`)
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
