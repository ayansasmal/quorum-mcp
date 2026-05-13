/**
 * Quorum MCP logger.
 *
 * Two log targets:
 *   ~/.quorum/mcp.log              — shared log for all calls (startup + every tool call)
 *   ~/.quorum/calls/<ts>-<tool>.log — per-call log created fresh for each tool invocation
 *
 * stdout is the MCP protocol channel and must never be written to.
 * Level: QUORUM_LOG_LEVEL=debug|info|warn|error  (default: info)
 *
 * Usage in server.js:
 *   log.startCall(toolName)   → creates per-call file, returns its path
 *   log.endCall()             → clears per-call file reference
 *   log.path                  → per-call file (if active), else shared mcp.log
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }
const currentLevel = LEVELS[process.env.QUORUM_LOG_LEVEL ?? 'info'] ?? 1

const LOG_DIR   = join(homedir(), '.quorum')
const CALLS_DIR = join(LOG_DIR, 'calls')
export const SHARED_LOG = process.env.QUORUM_LOG_FILE ?? join(LOG_DIR, 'mcp.log')

try { mkdirSync(LOG_DIR,   { recursive: true }) } catch { /* ignore */ }
try { mkdirSync(CALLS_DIR, { recursive: true }) } catch { /* ignore */ }

/** Active per-call log file. Null between calls. */
let _callLogFile = null

/**
 * Append a JSON-line entry to a single file.
 * Never throws — logging must never crash the MCP server.
 */
function writeTo(file, level, msg, data) {
  const entry = {
    ts:  new Date().toISOString(),
    lvl: level,
    msg,
    ...(data != null ? { data } : {}),
  }
  try { appendFileSync(file, JSON.stringify(entry) + '\n') } catch { /* ignore */ }
}

/**
 * Write to shared log and (if a call is active) to the per-call log.
 */
function write(level, msg, data) {
  if ((LEVELS[level] ?? 0) < currentLevel) return
  writeTo(SHARED_LOG, level, msg, data)
  if (_callLogFile) writeTo(_callLogFile, level, msg, data)
}

export const log = {
  debug: (msg, data) => write('debug', msg, data),
  info:  (msg, data) => write('info',  msg, data),
  warn:  (msg, data) => write('warn',  msg, data),
  error: (msg, data) => write('error', msg, data),

  /**
   * Create a per-call log file and activate it.
   * Call this at the top of each tool dispatch before any logging.
   * @param {string} toolName
   * @returns {string} absolute path to the per-call log file
   */
  startCall(toolName) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    _callLogFile = join(CALLS_DIR, `${ts}_${toolName}.log`)
    return _callLogFile
  },

  /** Clear the per-call log reference at the end of each tool dispatch. */
  endCall() { _callLogFile = null },

  /**
   * Path to include in error responses — per-call file if active, else shared log.
   * The LLM reads this file to diagnose the failure.
   * @returns {string}
   */
  get path() { return _callLogFile ?? SHARED_LOG },
}
