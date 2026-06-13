import { describe, expect, test } from 'vitest'

import { formatHookInstallReport } from '../../src/install/hooks.js'

describe('formatHookInstallReport', () => {
  test('reports a correct installation as a no-op', () => {
    expect(formatHookInstallReport({
      changed: false,
      repairedScripts: [],
      repairedEntries: [],
      backupPath: null,
    })).toEqual([
      '✓ Hooks already installed and correctly wired',
    ])
  })

  test('reports each repair category and backup path', () => {
    expect(formatHookInstallReport({
      changed: true,
      repairedScripts: ['quorum-stop.sh', 'quorum-pre-commit.sh'],
      repairedEntries: ['quorum-stop'],
      backupPath: '/home/test/.claude/settings.json.bak',
    })).toEqual([
      '✓ Hook scripts repaired: quorum-stop.sh, quorum-pre-commit.sh',
      '✓ Hook settings repaired: quorum-stop',
      '✓ Previous settings backed up → /home/test/.claude/settings.json.bak',
    ])
  })
})
