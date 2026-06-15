import { describe, it, expect, vi, afterEach } from 'vitest'

const appendFileSync = vi.fn()
const mkdirSync = vi.fn()

vi.mock('node:fs', () => ({
  appendFileSync: (...args) => appendFileSync(...args),
  mkdirSync: (...args) => mkdirSync(...args),
}))

vi.mock('node:os', () => ({
  homedir: () => '/tmp/quorum-home',
}))

async function loadLogger() {
  vi.resetModules()
  return import('../src/logger.js')
}

afterEach(() => {
  vi.clearAllMocks()
  delete process.env.QUORUM_TRACE_VERBOSE
  delete process.env.QUORUM_LOG_FILE
})

describe('logger trace verbosity', () => {
  it('does not write trace entries when QUORUM_TRACE_VERBOSE is unset', async () => {
    const { log } = await loadLogger()

    log.trace('gateway request outbound', { path: '/pg/audit' })

    expect(appendFileSync).not.toHaveBeenCalled()
    expect(log.verboseTraceEnabled).toBe(false)
  })

  it('writes trace entries with per-call trace metadata when QUORUM_TRACE_VERBOSE=true', async () => {
    process.env.QUORUM_TRACE_VERBOSE = 'true'
    process.env.QUORUM_LOG_FILE = '/tmp/quorum-shared.log'
    const { log } = await loadLogger()

    log.startCall('remember')
    log.trace('gateway request outbound', { path: '/pg/audit', body: { tool: 'remember' } })

    expect(appendFileSync).toHaveBeenCalledTimes(2)

    const sharedEntry = JSON.parse(appendFileSync.mock.calls[0][1].trim())
    const callEntry = JSON.parse(appendFileSync.mock.calls[1][1].trim())

    expect(sharedEntry.lvl).toBe('trace')
    expect(sharedEntry.msg).toBe('gateway request outbound')
    expect(sharedEntry.data).toEqual({ path: '/pg/audit', body: { tool: 'remember' } })
    expect(sharedEntry.trace_id).toBeTypeOf('string')
    expect(sharedEntry.tool).toBe('remember')
    expect(sharedEntry.seq).toBe(1)

    expect(callEntry.trace_id).toBe(sharedEntry.trace_id)
    expect(callEntry.tool).toBe('remember')
    expect(callEntry.seq).toBe(1)
    expect(log.verboseTraceEnabled).toBe(true)
  })
})
