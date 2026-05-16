/**
 * Primary audit store — writeEntry()
 *
 * Regression tests for the groupId positional-argument bug.
 *
 * Bug: primary.writeEntry() embedded AUDIT_GROUP_ID inside the metadata object
 * instead of passing it as the third positional argument to addEpisode().
 * addEpisode(content, metadata, groupId) received undefined for groupId and
 * threw "groupId is required" on every call. writeFailureCompensation swallowed
 * the error and wrote an AUDIT_WRITE_FAILED entry to PostgreSQL for every single
 * remember/recall operation — the Graphiti audit store never received any entries.
 *
 * Fix: pass AUDIT_GROUP_ID as the third positional argument.
 *
 * Verifies:
 *   1. addEpisode is called with AUDIT_GROUP_ID as the third argument
 *   2. addEpisode is not called with groupId embedded in the metadata object
 *   3. writeEntry resolves without throwing
 *   4. writeFailureCompensation is called when addEpisode fails
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/graph/client.js', () => ({
  addEpisode: vi.fn(),
  AUDIT_GROUP_ID: 'quorum-audit',
  BLOCKED_METHODS: new Set(['delete_episode', 'delete_entity', 'purge']),
  isMethodBlocked: vi.fn(),
}))

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * Minimal complete audit entry as written by the secondary store before
 * being forwarded to the primary (Graphiti) store.
 * @returns {Record<string, unknown>}
 */
function makeAuditEntry(overrides = {}) {
  return {
    entry_id: 'entry_001',
    operation: 'INTENT',
    tool: 'remember',
    author: 'ayan',
    author_role: 'principal_architect',
    chain_position: 1,
    entry_hash: 'abc123',
    previous_hash: null,
    version_impact: { versions_created: [], versions_superseded: [] },
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('primary audit — writeEntry()', () => {
  afterEach(() => vi.clearAllMocks())

  it('calls addEpisode with AUDIT_GROUP_ID as the third positional argument', async () => {
    const { addEpisode, AUDIT_GROUP_ID } = await import('../../src/graph/client.js')
    vi.mocked(addEpisode).mockResolvedValue({ episode_id: 'ep_001' })

    const { writeEntry } = await import('../../src/audit/primary.js')
    await writeEntry(makeAuditEntry())

    expect(addEpisode).toHaveBeenCalledOnce()
    // Third positional argument must be AUDIT_GROUP_ID, not undefined
    const [, , thirdArg] = vi.mocked(addEpisode).mock.calls[0]
    expect(thirdArg).toBe(AUDIT_GROUP_ID)
  })

  it('does NOT embed groupId inside the metadata object', async () => {
    const { addEpisode } = await import('../../src/graph/client.js')
    vi.mocked(addEpisode).mockResolvedValue({ episode_id: 'ep_001' })

    const { writeEntry } = await import('../../src/audit/primary.js')
    await writeEntry(makeAuditEntry())

    const [, metadataArg] = vi.mocked(addEpisode).mock.calls[0]
    // groupId must not be embedded in the second (metadata) argument
    expect(metadataArg).not.toHaveProperty('groupId')
  })

  it('resolves without throwing when addEpisode succeeds', async () => {
    const { addEpisode } = await import('../../src/graph/client.js')
    vi.mocked(addEpisode).mockResolvedValue({ episode_id: 'ep_001' })

    const { writeEntry } = await import('../../src/audit/primary.js')
    await expect(writeEntry(makeAuditEntry())).resolves.not.toThrow()
  })

  it('rejects when addEpisode fails (caller handles via writeFailureCompensation)', async () => {
    const { addEpisode } = await import('../../src/graph/client.js')
    vi.mocked(addEpisode).mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8000'))

    const { writeEntry } = await import('../../src/audit/primary.js')
    await expect(writeEntry(makeAuditEntry())).rejects.toThrow('ECONNREFUSED')
  })

  it('builds episode body from operation, author, tool, and chain_position', async () => {
    const { addEpisode } = await import('../../src/graph/client.js')
    vi.mocked(addEpisode).mockResolvedValue({ episode_id: 'ep_001' })

    const { writeEntry } = await import('../../src/audit/primary.js')
    await writeEntry(makeAuditEntry({ operation: 'OUTCOME', author: 'alice', tool: 'recall', chain_position: 42 }))

    const [contentArg] = vi.mocked(addEpisode).mock.calls[0]
    expect(contentArg).toContain('OUTCOME')
    expect(contentArg).toContain('alice')
    expect(contentArg).toContain('recall')
    expect(contentArg).toContain('42')
  })
})

describe('primary audit — writeFailureCompensation()', () => {
  afterEach(() => vi.clearAllMocks())

  it('writes AUDIT_WRITE_FAILED to the secondary store with the original entry_id and error', async () => {
    const mockSecondary = { writeAuditEntry: vi.fn().mockResolvedValue({}) }
    const mockPg = {}

    const { writeFailureCompensation } = await import('../../src/audit/primary.js')
    await writeFailureCompensation(mockSecondary, mockPg, 'entry_001', 'connect ECONNREFUSED')

    expect(mockSecondary.writeAuditEntry).toHaveBeenCalledOnce()
    const [, entry] = mockSecondary.writeAuditEntry.mock.calls[0]
    expect(entry.operation).toBe('AUDIT_WRITE_FAILED')
    expect(entry.tool).toBe('internal')
    expect(entry.author).toBe('system')
    expect(entry.governance_json.original_entry_id).toBe('entry_001')
    expect(entry.governance_json.error).toContain('ECONNREFUSED')
  })

  it('does not throw if the secondary write also fails (logs only)', async () => {
    const mockSecondary = { writeAuditEntry: vi.fn().mockRejectedValue(new Error('secondary also down')) }
    const mockPg = {}

    const { writeFailureCompensation } = await import('../../src/audit/primary.js')
    // Must not throw — double failure is logged, not rethrown
    await expect(
      writeFailureCompensation(mockSecondary, mockPg, 'entry_001', 'primary store error'),
    ).resolves.toBeUndefined()
  })
})
