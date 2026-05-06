import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installHooks, QUORUM_HOOKS } from '../../src/install/hooks.js'

/** Creates a temp scriptsSrc directory populated with all required mock hook scripts. */
function makeMockScriptsSrc(baseDir) {
  const scriptsSrc = join(baseDir, 'scripts-src')
  mkdirSync(scriptsSrc, { recursive: true })
  const scripts = [
    'quorum-session-start.sh',
    'quorum-stop.sh',
    'quorum-pre-commit.sh',
    'quorum-task-complete.sh',
    'quorum-knowledge-source.sh'
  ]
  for (const s of scripts) {
    writeFileSync(join(scriptsSrc, s), '#!/usr/bin/env bash\n# mock\n')
  }
  return scriptsSrc
}

describe('installHooks', () => {
  let tmpDir, hooksDir, settingsPath, scriptsSrc

  beforeEach(() => {
    tmpDir = join(tmpdir(), `quorum-test-${Date.now()}`)
    hooksDir = join(tmpDir, 'hooks')
    settingsPath = join(tmpDir, 'settings.json')
    mkdirSync(hooksDir, { recursive: true })
    scriptsSrc = makeMockScriptsSrc(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates settings.json with hook entries when file does not exist', () => {
    installHooks({ hooksDir, settingsPath, scriptsSrc })
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
    installHooks({ hooksDir, settingsPath, scriptsSrc })
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(settings.permissions.allow).toContain('Bash(npm test:*)')
    expect(settings.theme).toBe('dark')
    expect(settings.hooks).toBeDefined()
  })

  it('does not duplicate hook entries on re-install', () => {
    installHooks({ hooksDir, settingsPath, scriptsSrc })
    installHooks({ hooksDir, settingsPath, scriptsSrc })
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
    installHooks({ hooksDir, settingsPath, scriptsSrc })
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    const stopHooks = settings.hooks.Stop
    expect(stopHooks.some(h => h.id === 'other-tool-hook')).toBe(true)
    expect(stopHooks.some(h => h.id === 'quorum-stop')).toBe(true)
  })

  // Issue 4: stale quorum entries under event keys not in QUORUM_HOOKS are preserved
  it('preserves stale quorum entries under event keys no longer in QUORUM_HOOKS', () => {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SubagentStop: [{
          id: 'quorum-legacy-hook',
          hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/quorum-legacy.sh' }]
        }]
      }
    }, null, 2))
    installHooks({ hooksDir, settingsPath, scriptsSrc })
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    // SubagentStop is not in QUORUM_HOOKS so it must not be touched
    expect(settings.hooks.SubagentStop).toBeDefined()
    expect(settings.hooks.SubagentStop[0].id).toBe('quorum-legacy-hook')
  })

  // Issue 5: file-copy coverage — scripts are actually copied to hooksDir
  it('copies all hook scripts to hooksDir', () => {
    installHooks({ hooksDir, settingsPath, scriptsSrc })
    const copied = readdirSync(hooksDir)
    expect(copied).toContain('quorum-session-start.sh')
    expect(copied).toContain('quorum-stop.sh')
    expect(copied).toContain('quorum-pre-commit.sh')
    expect(copied).toContain('quorum-task-complete.sh')
    expect(copied).toContain('quorum-knowledge-source.sh')
  })

  // Issue 5: error path — throws when a required script is missing from scriptsSrc
  it('throws when a required hook script is missing from scriptsSrc', () => {
    // Remove one required script from the mock source directory
    rmSync(join(scriptsSrc, 'quorum-session-start.sh'))
    expect(() => installHooks({ hooksDir, settingsPath, scriptsSrc })).toThrow(
      /Hook script not found/
    )
  })

  // Issue 3: throws when settings.json exists but is malformed JSON
  it('throws when settings.json exists but is malformed JSON', () => {
    writeFileSync(settingsPath, '{ this is not valid JSON }')
    expect(() => installHooks({ hooksDir, settingsPath, scriptsSrc })).toThrow(
      /settings\.json exists but could not be parsed/
    )
  })

  // Issue 2: command strings in settings.json use the supplied hooksDir, not homedir()
  it('writes command strings that reference the supplied hooksDir', () => {
    installHooks({ hooksDir, settingsPath, scriptsSrc })
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    const cmd = settings.hooks.UserPromptSubmit[0].hooks[0].command
    expect(cmd).toContain(hooksDir)
  })
})
