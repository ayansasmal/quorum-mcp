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
 *   log.startCall(toolName)   → creates per-call file, returns call metadata
 *   log.endCall()             → clears per-call file reference
 *   log.path                  → per-call file (if active), else shared mcp.log
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }
const currentLevel = LEVELS[process.env.QUORUM_LOG_LEVEL ?? 'info'] ?? 1

const LOG_DIR   = join(homedir(), '.quorum')
const CALLS_DIR = join(LOG_DIR, 'calls')
export const SHARED_LOG = process.env.QUORUM_LOG_FILE ?? join(LOG_DIR, 'mcp.log')

try { mkdirSync(LOG_DIR,   { recursive: true }) } catch { /* ignore */ }
try { mkdirSync(CALLS_DIR, { recursive: true }) } catch { /* ignore */ }

/** Active per-call log file. Null between calls. */
let _callLogFile = null
/** Active per-call trace metadata. Null between calls. */
let _callContext = null

/**
 * Check whether verbose end-to-end tracing is enabled for this process.
 *
 * @returns {boolean}
 */
function isVerboseTraceEnabled() {
  return process.env.QUORUM_TRACE_VERBOSE === 'true'
}

/**
 * Append a JSON-line entry to a single file.
 * Never throws — logging must never crash the MCP server.
 */
function writeTo(file, entry) {
  try { appendFileSync(file, JSON.stringify(entry) + '\n') } catch { /* ignore */ }
}

/**
 * Build a structured log entry, attaching per-call trace metadata when available.
 *
 * @param {string} level
 * @param {string} msg
 * @param {unknown} data
 * @returns {Record<string, unknown>}
 */
function buildEntry(level, msg, data) {
  const entry = {
    ts:  new Date().toISOString(),
    lvl: level,
    msg,
    ...(data != null ? { data } : {}),
  }
  if (_callContext) {
    _callContext.seq += 1
    entry.trace_id = _callContext.traceId
    entry.tool = _callContext.toolName
    entry.seq = _callContext.seq
  }
  return entry
}

function write(level, msg, data) {
  if ((LEVELS[level] ?? 0) < currentLevel) return
  const entry = buildEntry(level, msg, data)
  writeTo(SHARED_LOG, entry)
  if (_callLogFile) writeTo(_callLogFile, entry)
}

/**
 * Emit a verbose trace entry only when QUORUM_TRACE_VERBOSE=true.
 *
 * @param {string} msg
 * @param {unknown} data
 * @returns {void}
 */
function writeTrace(msg, data) {
  if (!isVerboseTraceEnabled()) return
  const entry = buildEntry('trace', msg, data)
  writeTo(SHARED_LOG, entry)
  if (_callLogFile) writeTo(_callLogFile, entry)
}

export const log = {
  debug: (msg, data) => write('debug', msg, data),
  info:  (msg, data) => write('info',  msg, data),
  warn:  (msg, data) => write('warn',  msg, data),
  error: (msg, data) => write('error', msg, data),
  trace: (msg, data) => writeTrace(msg, data),

  /**
   * Create a per-call log file and activate it.
   * Call this at the top of each tool dispatch before any logging.
   * @param {string} toolName
   * @returns {{ path: string, traceId: string, end: () => void }} active call metadata
   */
  startCall(toolName) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    _callLogFile = join(CALLS_DIR, `${ts}_${toolName}.log`)
    _callContext = {
      toolName,
      traceId: randomUUID(),
      seq: 0,
    }
    const traceId = _callContext.traceId
    return {
      path: _callLogFile,
      traceId,
      end: () => {
        if (_callContext?.traceId === traceId) {
          log.endCall()
        }
      },
    }
  },

  /** Clear the per-call log reference at the end of each tool dispatch. */
  endCall() {
    _callLogFile = null
    _callContext = null
  },

  /**
   * Path to include in error responses — per-call file if active, else shared log.
   * The LLM reads this file to diagnose the failure.
  * @returns {string}
   */
  get path() { return _callLogFile ?? SHARED_LOG },

  /**
   * @returns {string | null}
   */
  get traceId() { return _callContext?.traceId ?? null },

  /**
   * @returns {boolean}
   */
  get verboseTraceEnabled() { return isVerboseTraceEnabled() },
}
