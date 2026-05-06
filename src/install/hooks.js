import { readFileSync, writeFileSync, cpSync, chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Quorum hook schema definitions for Claude Code settings.json.
 * Each key is a Claude Code hook event; each value is an array of hook handler
 * schema objects (id, optional matcher). The `command` field is NOT included here —
 * it is derived at install time from the caller-supplied `hooksDir` parameter.
 *
 * @type {Record<string, Array<{id: string, matcher?: string, script: string}>>}
 */
export const QUORUM_HOOKS = {
  UserPromptSubmit: [
    {
      id: 'quorum-session-start',
      script: 'quorum-session-start.sh'
    }
  ],
  Stop: [
    {
      id: 'quorum-stop',
      script: 'quorum-stop.sh'
    }
  ],
  PreToolUse: [
    {
      id: 'quorum-pre-commit',
      matcher: 'Bash',
      script: 'quorum-pre-commit.sh'
    }
  ],
  PostToolUse: [
    {
      id: 'quorum-task-complete',
      matcher: 'TodoWrite',
      script: 'quorum-task-complete.sh'
    },
    {
      id: 'quorum-knowledge-source',
      matcher: 'Write',
      script: 'quorum-knowledge-source.sh'
    },
    {
      id: 'quorum-knowledge-source-edit',
      matcher: 'Edit',
      script: 'quorum-knowledge-source.sh'
    }
  ]
}

/**
 * Builds hook entries with concrete `command` strings derived from the given hooksDir.
 * Strips the internal `script` property and replaces it with a `hooks` array entry
 * containing the resolved command path.
 *
 * @param {string} hooksDir - Destination directory where hook scripts are installed
 * @returns {Record<string, Array<{id: string, matcher?: string, hooks: Array<{type: string, command: string}>}>>}
 */
function buildHookEntries(hooksDir) {
  const result = {}
  for (const [event, handlers] of Object.entries(QUORUM_HOOKS)) {
    result[event] = handlers.map(({ script, ...rest }) => ({
      ...rest,
      hooks: [{ type: 'command', command: `bash ${join(hooksDir, script)}` }]
    }))
  }
  return result
}

/**
 * Installs Quorum hook scripts and merges hook wiring into Claude Code settings.json.
 * Safe to call multiple times — does not duplicate entries.
 *
 * Throws if:
 * - A required source hook script is missing from `scriptsSrc` (packaging error)
 * - `settingsPath` exists but cannot be parsed as JSON (would destroy user config)
 *
 * @param {object} opts
 * @param {string} opts.hooksDir     - Destination directory for hook scripts (~/.claude/hooks)
 * @param {string} opts.settingsPath - Path to Claude Code settings.json
 * @param {string} opts.scriptsSrc   - Source directory containing hook bash scripts
 * @returns {void}
 */
export function installHooks({ hooksDir, settingsPath, scriptsSrc }) {
  mkdirSync(hooksDir, { recursive: true })

  const scripts = [
    'quorum-session-start.sh',
    'quorum-stop.sh',
    'quorum-pre-commit.sh',
    'quorum-task-complete.sh',
    'quorum-knowledge-source.sh'
  ]

  for (const script of scripts) {
    const src = join(scriptsSrc, script)
    const dest = join(hooksDir, script)
    if (!existsSync(src)) {
      throw new Error(`Hook script not found: ${src}`)
    }
    cpSync(src, dest, { force: true })
    chmodSync(dest, 0o755)
  }

  let settings = {}
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    } catch (err) {
      throw new Error(`settings.json exists but could not be parsed: ${settingsPath}\n${err.message}`)
    }
  }

  const hookEntries = buildHookEntries(hooksDir)
  settings.hooks = mergeHooks(settings.hooks || {}, hookEntries)
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
}

/**
 * Merges Quorum hook entries into an existing hooks object without duplicating quorum entries.
 * Non-quorum hooks (those whose id does not start with 'quorum-') are preserved as-is.
 *
 * Note: stale quorum entries under event keys not present in `incoming` (e.g., a
 * `SubagentStop` key added by a previous version of Quorum) are intentionally preserved.
 * This is safe for upgrades — old hook commands remain until manually removed.
 *
 * @param {Record<string, Array<object>>} existing - Existing hooks from settings.json
 * @param {Record<string, Array<object>>} incoming - Quorum hooks to merge in
 * @returns {Record<string, Array<object>>} Merged hooks object
 */
function mergeHooks(existing, incoming) {
  const merged = { ...existing }
  for (const [event, handlers] of Object.entries(incoming)) {
    const existingHandlers = merged[event] || []
    const nonQuorum = existingHandlers.filter(h => !h.id?.startsWith('quorum-'))
    merged[event] = [...nonQuorum, ...handlers]
  }
  return merged
}
