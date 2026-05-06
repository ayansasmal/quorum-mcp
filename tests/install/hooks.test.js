import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installHooks, QUORUM_HOOKS } from '../../src/install/hooks.js'

describe('installHooks', () => {
  let tmpDir, hooksDir, settingsPath

  beforeEach(() => {
    tmpDir = join(tmpdir(), `quorum-test-${Date.now()}`)
    hooksDir = join(tmpDir, 'hooks')
    settingsPath = join(tmpDir, 'settings.json')
    mkdirSync(hooksDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates settings.json with hook entries when file does not exist', () => {
    installHooks({ hooksDir, settingsPath, scriptsSrc: 'hooks' })
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(settings.hooks).toBeDefined()
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1)
    expect(settings.hooks.Stop).toHaveLength(1)
    expect(settings.hooks.PreToolUse).toHaveLength(1)
    expect(settings.hooks.PostToolUse).toHaveLength(3)
  })

  it('merges hook entries into existing settings.json without destroying other config', () => {
    writeFileSync(settingsPath, JSON.stringify({
      permissions: { allow: ['Bash(npm test:*)'] },
      theme: 'dark'
    }, null, 2))
    installHooks({ hooksDir, settingsPath, scriptsSrc: 'hooks' })
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(settings.permissions.allow).toContain('Bash(npm test:*)')
    expect(settings.theme).toBe('dark')
    expect(settings.hooks).toBeDefined()
  })

  it('does not duplicate hook entries on re-install', () => {
    installHooks({ hooksDir, settingsPath, scriptsSrc: 'hooks' })
    installHooks({ hooksDir, settingsPath, scriptsSrc: 'hooks' })
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1)
    expect(settings.hooks.Stop).toHaveLength(1)
  })

  it('preserves non-quorum hook entries from existing settings', () => {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [{
          id: 'other-tool-hook',
          hooks: [{ type: 'command', command: 'bash ~/other.sh' }]
        }]
      }
    }, null, 2))
    installHooks({ hooksDir, settingsPath, scriptsSrc: 'hooks' })
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    const stopHooks = settings.hooks.Stop
    expect(stopHooks.some(h => h.id === 'other-tool-hook')).toBe(true)
    expect(stopHooks.some(h => h.id === 'quorum-stop')).toBe(true)
  })
})
