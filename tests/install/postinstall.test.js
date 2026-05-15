import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}))

describe('registerMcpServer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls claude mcp add with --scope user and concrete node path', async () => {
    spawnSync.mockReturnValue({ status: 0, error: null, stderr: Buffer.from('') })
    const { registerMcpServer } = await import('../../src/install/postinstall.js')

    registerMcpServer('/pkg/dist/server.js')

    expect(spawnSync).toHaveBeenCalledWith(
      'claude',
      ['mcp', 'add', '--scope', 'user', 'quorum',
        '-e', expect.stringMatching(/^QUORUM_GATEWAY_URL=.+/),
        '--', 'node', '/pkg/dist/server.js'],
      { stdio: 'pipe' },
    )
  })

  it('throws if the claude CLI is not found', async () => {
    spawnSync.mockReturnValue({ status: null, error: new Error('ENOENT'), stderr: Buffer.from('') })
    const { registerMcpServer } = await import('../../src/install/postinstall.js')

    expect(() => registerMcpServer('/pkg/dist/server.js')).toThrow('claude CLI not found')
  })

  it('throws with stderr on non-zero exit', async () => {
    spawnSync.mockReturnValue({ status: 1, error: null, stderr: Buffer.from('some error') })
    const { registerMcpServer } = await import('../../src/install/postinstall.js')

    expect(() => registerMcpServer('/pkg/dist/server.js')).toThrow('claude mcp add failed')
  })
})
