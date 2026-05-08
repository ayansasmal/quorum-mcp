import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerMcpServer } from '../../src/install/postinstall.js'

describe('registerMcpServer', () => {
  let tmpDir, claudeJsonPath

  beforeEach(() => {
    tmpDir = join(tmpdir(), `quorum-postinstall-test-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
    claudeJsonPath = join(tmpDir, '.claude.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates .claude.json with user-scoped mcpServers entry when file does not exist', () => {
    registerMcpServer(claudeJsonPath, '/usr/local/lib/quorum/dist/server.js')
    const config = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    expect(config.mcpServers.quorum).toEqual({
      type:    'stdio',
      command: 'node',
      args:    ['/usr/local/lib/quorum/dist/server.js'],
      env:     {},
    })
  })

  it('merges into existing .claude.json without clobbering other keys', () => {
    writeFileSync(claudeJsonPath, JSON.stringify({ projects: {}, userID: 'abc' }, null, 2))
    registerMcpServer(claudeJsonPath, '/path/to/server.js')
    const config = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    expect(config.projects).toBeDefined()
    expect(config.userID).toBe('abc')
    expect(config.mcpServers.quorum.command).toBe('node')
  })

  it('overwrites a stale quorum mcpServers entry on re-install', () => {
    writeFileSync(
      claudeJsonPath,
      JSON.stringify({ mcpServers: { quorum: { type: 'stdio', command: 'npx', args: ['old-path'], env: {} } } }, null, 2),
    )
    registerMcpServer(claudeJsonPath, '/new/path/server.js')
    const config = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    expect(config.mcpServers.quorum).toEqual({
      type: 'stdio', command: 'node', args: ['/new/path/server.js'], env: {},
    })
  })

  it('preserves other mcpServers entries when merging', () => {
    writeFileSync(
      claudeJsonPath,
      JSON.stringify({ mcpServers: { other: { type: 'stdio', command: 'python', args: ['other.py'], env: {} } } }, null, 2),
    )
    registerMcpServer(claudeJsonPath, '/path/server.js')
    const config = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    expect(config.mcpServers.other).toEqual({ type: 'stdio', command: 'python', args: ['other.py'], env: {} })
    expect(config.mcpServers.quorum).toBeDefined()
  })
})
