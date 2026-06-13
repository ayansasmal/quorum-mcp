import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inspectHooks, installHooks, QUORUM_HOOKS } from '../../src/install/hooks.js'

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

  it('reports a correct installation and performs no settings rewrite', () => {
    installHooks({ hooksDir, settingsPath, scriptsSrc })
    const inodeBefore = statSync(settingsPath).ino
    const report = installHooks({ hooksDir, settingsPath, scriptsSrc })

    expect(report).toEqual({
      changed: false,
      repairedScripts: [],
      repairedEntries: [],
      backupPath: null,
    })
    expect(statSync(settingsPath).ino).toBe(inodeBefore)
    expect(existsSync(`${settingsPath}.bak`)).toBe(false)
  })

  it('classifies missing, stale, and non-executable scripts', () => {
    installHooks({ hooksDir, settingsPath, scriptsSrc })
    rmSync(join(hooksDir, 'quorum-stop.sh'))
    writeFileSync(join(hooksDir, 'quorum-pre-commit.sh'), '#!/bin/sh\n# stale\n')
    chmodSync(join(hooksDir, 'quorum-session-start.sh'), 0o644)

    const report = inspectHooks({ hooksDir, settingsPath, scriptsSrc })
    const statuses = Object.fromEntries(report.scripts.map(({ script, status }) => [script, status]))

    expect(statuses['quorum-stop.sh']).toBe('missing')
    expect(statuses['quorum-pre-commit.sh']).toBe('stale')
    expect(statuses['quorum-session-start.sh']).toBe('not_executable')
    expect(report.needsRepair).toBe(true)
  })

  it('repairs only affected scripts', () => {
    installHooks({ hooksDir, settingsPath, scriptsSrc })
    const correctPath = join(hooksDir, 'quorum-task-complete.sh')
    const correctInode = statSync(correctPath).ino
    rmSync(join(hooksDir, 'quorum-stop.sh'))
    writeFileSync(join(hooksDir, 'quorum-pre-commit.sh'), '#!/bin/sh\n# stale\n')
    chmodSync(join(hooksDir, 'quorum-session-start.sh'), 0o644)

    const report = installHooks({ hooksDir, settingsPath, scriptsSrc })

    expect(report.repairedScripts.sort()).toEqual([
      'quorum-pre-commit.sh',
      'quorum-session-start.sh',
      'quorum-stop.sh',
    ])
    expect(statSync(correctPath).ino).toBe(correctInode)
    expect(statSync(join(hooksDir, 'quorum-session-start.sh')).mode & 0o111).not.toBe(0)
    expect(readFileSync(join(hooksDir, 'quorum-pre-commit.sh'))).toEqual(
      readFileSync(join(scriptsSrc, 'quorum-pre-commit.sh')),
    )
  })

  it('classifies a managed entry with the wrong command as incorrect', () => {
    installHooks({ hooksDir, settingsPath, scriptsSrc })
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    settings.hooks.Stop[0].hooks[0].command = 'bash /tmp/not-quorum-stop.sh'
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2))

    const report = inspectHooks({ hooksDir, settingsPath, scriptsSrc })
    const stop = report.settings.find(({ id }) => id === 'quorum-stop')

    expect(stop.status).toBe('incorrect')
    expect(report.needsRepair).toBe(true)
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

  it('preserves unknown quorum entries inside a managed event', () => {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [{
          id: 'quorum-custom-local',
          hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/custom.sh' }]
        }]
      }
    }, null, 2))

    installHooks({ hooksDir, settingsPath, scriptsSrc })

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(settings.hooks.Stop.some(h => h.id === 'quorum-custom-local')).toBe(true)
    expect(settings.hooks.Stop.some(h => h.id === 'quorum-stop')).toBe(true)
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

  it.each([
    ['non-object root', [], /root must be a plain object/],
    ['non-object hooks', { hooks: [] }, /hooks must be a plain object/],
    ['non-array managed event', { hooks: { Stop: {} } }, /hooks\.Stop must be an array/],
  ])('refuses %s before mutating scripts', (_name, settings, expectedError) => {
    const destination = join(hooksDir, 'quorum-stop.sh')
    writeFileSync(destination, '#!/bin/sh\n# preserve me\n')
    writeFileSync(settingsPath, JSON.stringify(settings))

    expect(() => installHooks({ hooksDir, settingsPath, scriptsSrc })).toThrow(expectedError)
    expect(readFileSync(destination, 'utf8')).toBe('#!/bin/sh\n# preserve me\n')
  })

  it('creates a backup and repairs only an incorrect managed entry', () => {
    installHooks({ hooksDir, settingsPath, scriptsSrc })
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    settings.permissions = { allow: ['Bash(npm test:*)'] }
    settings.hooks.Stop[0].hooks[0].command = 'bash /tmp/not-quorum-stop.sh'
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
    const original = readFileSync(settingsPath, 'utf8')

    const report = installHooks({ hooksDir, settingsPath, scriptsSrc })
    const repaired = JSON.parse(readFileSync(settingsPath, 'utf8'))

    expect(report.repairedEntries).toEqual(['quorum-stop'])
    expect(report.backupPath).toBe(`${settingsPath}.bak`)
    expect(readFileSync(`${settingsPath}.bak`, 'utf8')).toBe(original)
    expect(repaired.permissions).toEqual(settings.permissions)
    expect(repaired.hooks.Stop[0].hooks[0].command).toBe(
      `bash ${join(hooksDir, 'quorum-stop.sh')}`,
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
