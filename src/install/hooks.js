import { readFileSync, writeFileSync, cpSync, chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Quorum hook wiring definitions for Claude Code settings.json.
 * Each key is a Claude Code hook event; each value is an array of hook handler objects.
 *
 * @type {Record<string, Array<{id: string, matcher?: string, hooks: Array<{type: string, command: string}>}>>}
 */
export const QUORUM_HOOKS = {
  UserPromptSubmit: [
    {
      id: 'quorum-session-start',
      hooks: [{ type: 'command', command: `bash ${join(homedir(), '.claude', 'hooks', 'quorum-session-start.sh')}` }]
    }
  ],
  Stop: [
    {
      id: 'quorum-stop',
      hooks: [{ type: 'command', command: `bash ${join(homedir(), '.claude', 'hooks', 'quorum-stop.sh')}` }]
    }
  ],
  PreToolUse: [
    {
      id: 'quorum-pre-commit',
      matcher: 'Bash',
      hooks: [{ type: 'command', command: `bash ${join(homedir(), '.claude', 'hooks', 'quorum-pre-commit.sh')}` }]
    }
  ],
  PostToolUse: [
    {
      id: 'quorum-task-complete',
      matcher: 'TodoWrite',
      hooks: [{ type: 'command', command: `bash ${join(homedir(), '.claude', 'hooks', 'quorum-task-complete.sh')}` }]
    },
    {
      id: 'quorum-knowledge-source',
      matcher: 'Write',
      hooks: [{ type: 'command', command: `bash ${join(homedir(), '.claude', 'hooks', 'quorum-knowledge-source.sh')}` }]
    },
    {
      id: 'quorum-knowledge-source-edit',
      matcher: 'Edit',
      hooks: [{ type: 'command', command: `bash ${join(homedir(), '.claude', 'hooks', 'quorum-knowledge-source.sh')}` }]
    }
  ]
}

/**
 * Installs Quorum hook scripts and merges hook wiring into Claude Code settings.json.
 * Safe to call multiple times — does not duplicate entries.
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
    if (existsSync(src)) {
      cpSync(src, dest, { force: true })
      chmodSync(dest, 0o755)
    }
  }

  let settings = {}
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    } catch {
      settings = {}
    }
  }

  settings.hooks = mergeHooks(settings.hooks || {}, QUORUM_HOOKS)
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
}

/**
 * Merges Quorum hook entries into an existing hooks object without duplicating quorum entries.
 * Non-quorum hooks (those whose id does not start with 'quorum-') are preserved as-is.
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
