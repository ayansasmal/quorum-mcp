import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Quorum hook schema definitions for Claude Code settings.json.
 *
 * @type {Record<string, Array<{id: string, matcher?: string, script: string}>>}
 */
export const QUORUM_HOOKS = {
  UserPromptSubmit: [
    {
      id: 'quorum-session-start',
      script: 'quorum-session-start.sh',
    },
  ],
  Stop: [
    {
      id: 'quorum-stop',
      script: 'quorum-stop.sh',
    },
  ],
  PreToolUse: [
    {
      id: 'quorum-pre-commit',
      matcher: 'Bash',
      script: 'quorum-pre-commit.sh',
    },
  ],
  PostToolUse: [
    {
      id: 'quorum-task-complete',
      matcher: 'TodoWrite',
      script: 'quorum-task-complete.sh',
    },
    {
      id: 'quorum-knowledge-source',
      matcher: 'Write',
      script: 'quorum-knowledge-source.sh',
    },
    {
      id: 'quorum-knowledge-source-edit',
      matcher: 'Edit',
      script: 'quorum-knowledge-source.sh',
    },
  ],
}

/** @type {string[]} */
const REQUIRED_SCRIPTS = [...new Set(
  Object.values(QUORUM_HOOKS).flat().map(({ script }) => script),
)]

/** @type {Set<string>} */
const MANAGED_HOOK_IDS = new Set(
  Object.values(QUORUM_HOOKS).flat().map(({ id }) => id),
)

/**
 * Determine whether a value is a plain JSON object.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Build hook entries with concrete destination script paths.
 *
 * @param {string} hooksDir
 * @returns {Record<string, Array<{id: string, matcher?: string, hooks: Array<{type: string, command: string}>}>>}
 */
function buildHookEntries(hooksDir) {
  /** @type {Record<string, Array<{id: string, matcher?: string, hooks: Array<{type: string, command: string}>}>>} */
  const result = {}
  for (const [event, handlers] of Object.entries(QUORUM_HOOKS)) {
    result[event] = handlers.map(({ script, ...rest }) => ({
      ...rest,
      hooks: [{ type: 'command', command: `bash ${join(hooksDir, script)}` }],
    }))
  }
  return result
}

/**
 * Validate bundled source scripts before inspecting or mutating destinations.
 *
 * @param {string} scriptsSrc
 * @returns {void}
 */
function validateBundledScripts(scriptsSrc) {
  for (const script of REQUIRED_SCRIPTS) {
    /** @type {string} */
    const sourcePath = join(scriptsSrc, script)
    if (!existsSync(sourcePath)) {
      throw new Error(`Hook script not found: ${sourcePath}`)
    }
  }
}

/**
 * Read and structurally validate Claude settings.
 *
 * @param {string} settingsPath
 * @returns {Record<string, unknown>}
 */
function readAndValidateSettings(settingsPath) {
  /** @type {unknown} */
  let settings = {}
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    } catch (err) {
      throw new Error(`settings.json exists but could not be parsed: ${settingsPath}\n${err.message}`)
    }
  }

  if (!isPlainObject(settings)) {
    throw new Error(`settings.json root must be a plain object: ${settingsPath}`)
  }

  if (settings.hooks !== undefined && !isPlainObject(settings.hooks)) {
    throw new Error(`settings.json hooks must be a plain object: ${settingsPath}`)
  }

  /** @type {Record<string, unknown>} */
  const hooks = settings.hooks ?? {}
  for (const event of Object.keys(QUORUM_HOOKS)) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
      throw new Error(`settings.json hooks.${event} must be an array: ${settingsPath}`)
    }
  }

  return settings
}

/**
 * Inspect installed hook scripts.
 *
 * @param {string} hooksDir
 * @param {string} scriptsSrc
 * @returns {Array<{script: string, sourcePath: string, destinationPath: string, status: 'correct'|'missing'|'stale'|'not_executable'}>}
 */
function inspectScripts(hooksDir, scriptsSrc) {
  return REQUIRED_SCRIPTS.map((script) => {
    /** @type {string} */
    const sourcePath = join(scriptsSrc, script)
    /** @type {string} */
    const destinationPath = join(hooksDir, script)
    if (!existsSync(destinationPath)) {
      return { script, sourcePath, destinationPath, status: 'missing' }
    }

    /** @type {boolean} */
    const contentMatches = readFileSync(sourcePath).equals(readFileSync(destinationPath))
    if (!contentMatches) {
      return { script, sourcePath, destinationPath, status: 'stale' }
    }

    /** @type {boolean} */
    const isExecutable = (statSync(destinationPath).mode & 0o111) !== 0
    return {
      script,
      sourcePath,
      destinationPath,
      status: isExecutable ? 'correct' : 'not_executable',
    }
  })
}

/**
 * Compare one installed settings entry with the expected managed entry.
 *
 * @param {Record<string, unknown>} actual
 * @param {Record<string, unknown>} expected
 * @returns {boolean}
 */
function hookEntryMatches(actual, expected) {
  if (!isPlainObject(actual)) return false
  if (actual.id !== expected.id) return false
  if (actual.matcher !== expected.matcher) return false
  if (!Array.isArray(actual.hooks) || actual.hooks.length !== 1) return false

  /** @type {unknown} */
  const actualHook = actual.hooks[0]
  /** @type {unknown} */
  const expectedHook = expected.hooks[0]
  return isPlainObject(actualHook)
    && isPlainObject(expectedHook)
    && actualHook.type === expectedHook.type
    && actualHook.command === expectedHook.command
}

/**
 * Inspect all managed settings entries.
 *
 * @param {Record<string, unknown>} hooks
 * @param {string} hooksDir
 * @returns {Array<{id: string, event: string, status: 'correct'|'missing'|'incorrect'}>}
 */
function inspectSettingsEntries(hooks, hooksDir) {
  /** @type {Record<string, Array<Record<string, unknown>>>} */
  const expectedByEvent = buildHookEntries(hooksDir)
  /** @type {Array<{id: string, event: string, status: 'correct'|'missing'|'incorrect'}>} */
  const report = []

  for (const [event, expectedEntries] of Object.entries(expectedByEvent)) {
    /** @type {unknown[]} */
    const eventEntries = Array.isArray(hooks[event]) ? hooks[event] : []
    for (const expected of expectedEntries) {
      /** @type {Array<{event: string, entry: Record<string, unknown>}>} */
      const matches = []
      for (const [candidateEvent, candidateEntries] of Object.entries(hooks)) {
        if (!Array.isArray(candidateEntries)) continue
        for (const entry of candidateEntries) {
          if (isPlainObject(entry) && entry.id === expected.id) {
            matches.push({ event: candidateEvent, entry })
          }
        }
      }

      /** @type {'correct'|'missing'|'incorrect'} */
      let status = 'missing'
      if (matches.length > 0) {
        const correct = matches.length === 1
          && matches[0].event === event
          && eventEntries.includes(matches[0].entry)
          && hookEntryMatches(matches[0].entry, expected)
        status = correct ? 'correct' : 'incorrect'
      }
      report.push({ id: expected.id, event, status })
    }
  }

  return report
}

/**
 * Inspect scripts and settings without changing either destination.
 *
 * @param {object} opts
 * @param {string} opts.hooksDir
 * @param {string} opts.settingsPath
 * @param {string} opts.scriptsSrc
 * @returns {{
 *   needsRepair: boolean,
 *   scripts: Array<{script: string, sourcePath: string, destinationPath: string, status: string}>,
 *   settings: Array<{id: string, event: string, status: string}>,
 * }}
 */
export function inspectHooks({ hooksDir, settingsPath, scriptsSrc }) {
  validateBundledScripts(scriptsSrc)
  /** @type {Record<string, unknown>} */
  const settings = readAndValidateSettings(settingsPath)
  /** @type {Array<{script: string, sourcePath: string, destinationPath: string, status: string}>} */
  const scripts = inspectScripts(hooksDir, scriptsSrc)
  /** @type {Array<{id: string, event: string, status: string}>} */
  const settingsEntries = inspectSettingsEntries(settings.hooks ?? {}, hooksDir)
  return {
    needsRepair: scripts.some(({ status }) => status !== 'correct')
      || settingsEntries.some(({ status }) => status !== 'correct'),
    scripts,
    settings: settingsEntries,
  }
}

/**
 * Build settings with only managed hook IDs replaced.
 *
 * @param {Record<string, unknown>} settings
 * @param {string} hooksDir
 * @returns {Record<string, unknown>}
 */
function buildRepairedSettings(settings, hooksDir) {
  /** @type {Record<string, unknown>} */
  const existingHooks = settings.hooks ?? {}
  /** @type {Record<string, unknown>} */
  const repairedHooks = { ...existingHooks }

  for (const [event, handlers] of Object.entries(existingHooks)) {
    if (!Array.isArray(handlers)) continue
    repairedHooks[event] = handlers.filter(
      (handler) => !isPlainObject(handler) || !MANAGED_HOOK_IDS.has(handler.id),
    )
  }

  for (const [event, expectedEntries] of Object.entries(buildHookEntries(hooksDir))) {
    /** @type {unknown[]} */
    const preserved = Array.isArray(repairedHooks[event]) ? repairedHooks[event] : []
    repairedHooks[event] = [...preserved, ...expectedEntries]
  }

  return { ...settings, hooks: repairedHooks }
}

/**
 * Atomically replace settings and retain the immediately previous file.
 *
 * @param {string} settingsPath
 * @param {Record<string, unknown>} settings
 * @returns {string|null}
 */
function writeSettingsAtomically(settingsPath, settings) {
  mkdirSync(dirname(settingsPath), { recursive: true })
  /** @type {string} */
  const temporaryPath = join(
    dirname(settingsPath),
    `.${basename(settingsPath)}.quorum-${process.pid}-${Date.now()}.tmp`,
  )
  /** @type {string|null} */
  const backupPath = existsSync(settingsPath) ? `${settingsPath}.bak` : null

  try {
    writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`)
    if (backupPath) copyFileSync(settingsPath, backupPath)
    renameSync(temporaryPath, settingsPath)
    return backupPath
  } catch (err) {
    rmSync(temporaryPath, { force: true })
    throw err
  }
}

/**
 * Repair only scripts and managed settings entries that inspection found stale.
 *
 * @param {object} opts
 * @param {string} opts.hooksDir
 * @param {string} opts.settingsPath
 * @param {string} opts.scriptsSrc
 * @returns {{changed: boolean, repairedScripts: string[], repairedEntries: string[], backupPath: string|null}}
 */
export function installHooks({ hooksDir, settingsPath, scriptsSrc }) {
  /** @type {ReturnType<typeof inspectHooks>} */
  const inspection = inspectHooks({ hooksDir, settingsPath, scriptsSrc })
  /** @type {string[]} */
  const repairedScripts = []

  if (inspection.scripts.some(({ status }) => status !== 'correct')) {
    mkdirSync(hooksDir, { recursive: true })
  }

  for (const script of inspection.scripts) {
    if (script.status === 'correct') continue
    if (script.status === 'missing' || script.status === 'stale') {
      cpSync(script.sourcePath, script.destinationPath, { force: true })
    }
    chmodSync(script.destinationPath, 0o755)
    repairedScripts.push(script.script)
  }

  /** @type {string[]} */
  const repairedEntries = inspection.settings
    .filter(({ status }) => status !== 'correct')
    .map(({ id }) => id)
  /** @type {string|null} */
  let backupPath = null

  if (repairedEntries.length > 0) {
    /** @type {Record<string, unknown>} */
    const settings = readAndValidateSettings(settingsPath)
    /** @type {Record<string, unknown>} */
    const repairedSettings = buildRepairedSettings(settings, hooksDir)
    backupPath = writeSettingsAtomically(settingsPath, repairedSettings)
  }

  return {
    changed: repairedScripts.length > 0 || repairedEntries.length > 0,
    repairedScripts,
    repairedEntries,
    backupPath,
  }
}

/**
 * Format a hook installation report for CLI output.
 *
 * @param {{changed: boolean, repairedScripts: string[], repairedEntries: string[], backupPath: string|null}} report
 * @returns {string[]}
 */
export function formatHookInstallReport(report) {
  if (!report.changed) {
    return ['✓ Hooks already installed and correctly wired']
  }

  /** @type {string[]} */
  const lines = []
  if (report.repairedScripts.length > 0) {
    lines.push(`✓ Hook scripts repaired: ${report.repairedScripts.join(', ')}`)
  }
  if (report.repairedEntries.length > 0) {
    lines.push(`✓ Hook settings repaired: ${report.repairedEntries.join(', ')}`)
  }
  if (report.backupPath) {
    lines.push(`✓ Previous settings backed up → ${report.backupPath}`)
  }
  return lines
}
