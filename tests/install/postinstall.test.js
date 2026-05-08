import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerMcpServer } from '../../src/install/postinstall.js'

describe('registerMcpServer', () => {
  let tmpDir, settingsPath

  beforeEach(() => {
    tmpDir = join(tmpdir(), `quorum-postinstall-test-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
    settingsPath = join(tmpDir, 'settings.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates settings.json with mcpServers entry when file does not exist', () => {
    registerMcpServer(settingsPath, '/usr/local/lib/quorum/dist/server.js')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(settings.mcpServers.quorum).toEqual({
      command: 'node',
      args: ['/usr/local/lib/quorum/dist/server.js'],
    })
  })

  it('merges into existing settings.json without clobbering other keys', () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [] }, otherKey: 42 }, null, 2))
    registerMcpServer(settingsPath, '/path/to/server.js')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(settings.hooks).toBeDefined()
    expect(settings.otherKey).toBe(42)
    expect(settings.mcpServers.quorum.command).toBe('node')
  })

  it('overwrites a stale quorum mcpServers entry on re-install', () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ mcpServers: { quorum: { command: 'npx', args: ['old-path'] } } }, null, 2),
    )
    registerMcpServer(settingsPath, '/new/path/server.js')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(settings.mcpServers.quorum).toEqual({ command: 'node', args: ['/new/path/server.js'] })
  })

  it('preserves other mcpServers entries when merging', () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ mcpServers: { other: { command: 'python', args: ['other.py'] } } }, null, 2),
    )
    registerMcpServer(settingsPath, '/path/server.js')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(settings.mcpServers.other).toEqual({ command: 'python', args: ['other.py'] })
    expect(settings.mcpServers.quorum).toBeDefined()
  })
})
