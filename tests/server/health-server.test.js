import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { startHealthServer } from '../../src/server.js'

/**
 * Create a fake HTTP server that reports a listener failure asynchronously.
 *
 * @param {NodeJS.ErrnoException} error
 * @returns {EventEmitter & { listen: ReturnType<typeof vi.fn> }}
 */
function createFailingServer(error) {
  const server = new EventEmitter()
  server.listen = vi.fn(() => {
    queueMicrotask(() => server.emit('error', error))
    return server
  })
  return server
}

describe('startHealthServer', () => {
  afterEach(() => {
    delete process.env.QUORUM_MCP_PORT
  })

  test('uses port 50000 by default', () => {
    const server = new EventEmitter()
    server.listen = vi.fn(() => server)
    const createServer = vi.fn(() => server)

    startHealthServer({ createServer })

    expect(server.listen).toHaveBeenCalledWith(50000, '127.0.0.1', expect.any(Function))
  })

  test('uses QUORUM_MCP_PORT when configured', () => {
    process.env.QUORUM_MCP_PORT = '51000'
    const server = new EventEmitter()
    server.listen = vi.fn(() => server)
    const createServer = vi.fn(() => server)

    startHealthServer({ createServer })

    expect(server.listen).toHaveBeenCalledWith(51000, '127.0.0.1', expect.any(Function))
  })

  test('keeps MCP startup alive when the health port is already in use', async () => {
    const error = Object.assign(new Error('address already in use'), {
      code: 'EADDRINUSE',
    })
    const server = createFailingServer(error)
    const createServer = vi.fn(() => server)
    const warn = vi.fn()

    expect(() => startHealthServer({
      port: 8000,
      createServer,
      warn,
    })).not.toThrow()

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(server.listen).toHaveBeenCalledWith(8000, '127.0.0.1', expect.any(Function))
    expect(warn).toHaveBeenCalledWith(
      '[Quorum] WARNING: Health endpoint unavailable on 127.0.0.1:8000 (EADDRINUSE) — MCP stdio remains available',
    )
  })
})
