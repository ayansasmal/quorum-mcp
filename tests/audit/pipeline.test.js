/**
 * Tests for src/audit/pipeline.js
 *
 * withAuditPipeline() wraps every MCP tool call in:
 *   1. INTENT pre-entry (secondary + primary)
 *   2. Execute operation()
 *   3. OUTCOME post-entry (secondary + primary)
 *   4. version_audit_links insertion
 *
 * On failure: writes FAILED_OUTCOME and rethrows.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/audit/secondary.js', () => ({
  writeAuditEntry: vi.fn(),
}))

vi.mock('../../src/audit/primary.js', () => ({
  writeEntry: vi.fn(),
  writeFailureCompensation: vi.fn(),
}))

vi.mock('../../src/graph/queries.js', () => ({
  insertVersionAuditLink: vi.fn(),
}))

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makePreEntry(overrides = {}) {
  return {
    entry_id: 'pre_test-op-id',
    operation: 'INTENT',
    tool: 'remember',
    timestamp: new Date().toISOString(),
    author: 'alice',
    ...overrides,
  }
}

function makePostEntry(overrides = {}) {
  return {
    entry_id: 'post_test-op-id',
    operation: 'OUTCOME',
    tool: 'remember',
    timestamp: new Date().toISOString(),
    author: 'alice',
    ...overrides,
  }
}

const baseContext = {
  tool: 'remember',
  author: 'alice',
  authorRole: 'engineer',
  sessionId: 'session-1',
  topic: 'auth',
  key: 'token-strategy',
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('withAuditPipeline — success path', () => {
  afterEach(() => vi.clearAllMocks())

  it('calls writeAuditEntry twice (INTENT + OUTCOME)', async () => {
    const { writeAuditEntry } = await import('../../src/audit/secondary.js')
    const { writeEntry } = await import('../../src/audit/primary.js')
    vi.mocked(writeAuditEntry)
      .mockResolvedValueOnce(makePreEntry())
      .mockResolvedValueOnce(makePostEntry())
    vi.mocked(writeEntry).mockResolvedValue(undefined)

    const { withAuditPipeline } = await import('../../src/audit/pipeline.js')
    await withAuditPipeline({}, baseContext, async () => ({
      result: { status: 'ok' },
      versionImpact: { versions_created: [], versions_superseded: [] },
    }))

    expect(writeAuditEntry).toHaveBeenCalledTimes(2)
    const ops = vi.mocked(writeAuditEntry).mock.calls.map((c) => c[1].operation)
    expect(ops).toContain('INTENT')
    expect(ops).toContain('OUTCOME')
  })

  it('returns the operation result', async () => {
    const { writeAuditEntry } = await import('../../src/audit/secondary.js')
    const { writeEntry } = await import('../../src/audit/primary.js')
    vi.mocked(writeAuditEntry)
      .mockResolvedValueOnce(makePreEntry())
      .mockResolvedValueOnce(makePostEntry())
    vi.mocked(writeEntry).mockResolvedValue(undefined)

    const { withAuditPipeline } = await import('../../src/audit/pipeline.js')
    const output = await withAuditPipeline({}, baseContext, async () => ({
      result: { status: 'stored', topic: 'auth' },
      versionImpact: { versions_created: [], versions_superseded: [] },
    }))

    expect(output.result).toEqual({ status: 'stored', topic: 'auth' })
  })

  it('returns preAuditId and postAuditId', async () => {
    const { writeAuditEntry } = await import('../../src/audit/secondary.js')
    const { writeEntry } = await import('../../src/audit/primary.js')
    vi.mocked(writeAuditEntry)
      .mockResolvedValueOnce(makePreEntry({ entry_id: 'pre_abc' }))
      .mockResolvedValueOnce(makePostEntry({ entry_id: 'post_abc' }))
    vi.mocked(writeEntry).mockResolvedValue(undefined)

    const { withAuditPipeline } = await import('../../src/audit/pipeline.js')
    const output = await withAuditPipeline({}, baseContext, async () => ({
      result: {},
      versionImpact: { versions_created: [], versions_superseded: [] },
    }))

    expect(output.preAuditId).toBe('pre_abc')
    expect(output.postAuditId).toBe('post_abc')
  })

  it('calls writeEntry for both entries (primary store)', async () => {
    const { writeAuditEntry } = await import('../../src/audit/secondary.js')
    const { writeEntry } = await import('../../src/audit/primary.js')
    vi.mocked(writeAuditEntry)
      .mockResolvedValueOnce(makePreEntry())
      .mockResolvedValueOnce(makePostEntry())
    vi.mocked(writeEntry).mockResolvedValue(undefined)

    const { withAuditPipeline } = await import('../../src/audit/pipeline.js')
    await withAuditPipeline({}, baseContext, async () => ({
      result: {},
      versionImpact: { versions_created: [], versions_superseded: [] },
    }))

    expect(writeEntry).toHaveBeenCalledTimes(2)
  })

  it('inserts version_audit_links for created versions', async () => {
    const { writeAuditEntry } = await import('../../src/audit/secondary.js')
    const { writeEntry } = await import('../../src/audit/primary.js')
    const { insertVersionAuditLink } = await import('../../src/graph/queries.js')
    vi.mocked(writeAuditEntry)
      .mockResolvedValueOnce(makePreEntry())
      .mockResolvedValueOnce(makePostEntry({ entry_id: 'post_xyz' }))
    vi.mocked(writeEntry).mockResolvedValue(undefined)
    vi.mocked(insertVersionAuditLink).mockResolvedValue(undefined)

    const { withAuditPipeline } = await import('../../src/audit/pipeline.js')
    await withAuditPipeline({}, baseContext, async () => ({
      result: {},
      versionImpact: {
        versions_created: [{ version: 1, versionId: 'q_k1_v1', qKeyId: 'q_k1' }],
        versions_superseded: [],
      },
    }))

    expect(insertVersionAuditLink).toHaveBeenCalledOnce()
    const linkArg = vi.mocked(insertVersionAuditLink).mock.calls[0][1]
    expect(linkArg.linkType).toBe('created')
    expect(linkArg.auditEntryId).toBe('post_xyz')
  })

  it('inserts version_audit_links for superseded versions', async () => {
    const { writeAuditEntry } = await import('../../src/audit/secondary.js')
    const { writeEntry } = await import('../../src/audit/primary.js')
    const { insertVersionAuditLink } = await import('../../src/graph/queries.js')
    vi.mocked(writeAuditEntry)
      .mockResolvedValueOnce(makePreEntry())
      .mockResolvedValueOnce(makePostEntry({ entry_id: 'post_xyz' }))
    vi.mocked(writeEntry).mockResolvedValue(undefined)
    vi.mocked(insertVersionAuditLink).mockResolvedValue(undefined)

    const { withAuditPipeline } = await import('../../src/audit/pipeline.js')
    await withAuditPipeline({}, baseContext, async () => ({
      result: {},
      versionImpact: {
        versions_created: [],
        versions_superseded: [{ version: 1, status_before: 'ACTIVE', versionId: 'q_k1_v1', qKeyId: 'q_k1' }],
      },
    }))

    const linkArg = vi.mocked(insertVersionAuditLink).mock.calls[0][1]
    expect(linkArg.linkType).toBe('superseded')
  })

  it('skips version links when versionId or qKeyId is missing', async () => {
    const { writeAuditEntry } = await import('../../src/audit/secondary.js')
    const { writeEntry } = await import('../../src/audit/primary.js')
    const { insertVersionAuditLink } = await import('../../src/graph/queries.js')
    vi.mocked(writeAuditEntry)
      .mockResolvedValueOnce(makePreEntry())
      .mockResolvedValueOnce(makePostEntry())
    vi.mocked(writeEntry).mockResolvedValue(undefined)

    const { withAuditPipeline } = await import('../../src/audit/pipeline.js')
    await withAuditPipeline({}, baseContext, async () => ({
      result: {},
      versionImpact: {
        // Missing versionId / qKeyId — should be skipped
        versions_created: [{ version: 1 }],
        versions_superseded: [],
      },
    }))

    expect(insertVersionAuditLink).not.toHaveBeenCalled()
  })

  it('skips version links when topic/key not in context', async () => {
    const { writeAuditEntry } = await import('../../src/audit/secondary.js')
    const { writeEntry } = await import('../../src/audit/primary.js')
    const { insertVersionAuditLink } = await import('../../src/graph/queries.js')
    vi.mocked(writeAuditEntry)
      .mockResolvedValueOnce(makePreEntry())
      .mockResolvedValueOnce(makePostEntry())
    vi.mocked(writeEntry).mockResolvedValue(undefined)

    const contextWithoutTopicKey = { tool: 'export', author: 'alice' }

    const { withAuditPipeline } = await import('../../src/audit/pipeline.js')
    await withAuditPipeline({}, contextWithoutTopicKey, async () => ({
      result: {},
      versionImpact: {
        versions_created: [{ version: 1, versionId: 'q_k1_v1', qKeyId: 'q_k1' }],
        versions_superseded: [],
      },
    }))

    expect(insertVersionAuditLink).not.toHaveBeenCalled()
  })
})

describe('withAuditPipeline — failure path', () => {
  afterEach(() => vi.clearAllMocks())

  it('writes FAILED_OUTCOME and rethrows when operation throws', async () => {
    const { writeAuditEntry } = await import('../../src/audit/secondary.js')
    const { writeEntry } = await import('../../src/audit/primary.js')
    vi.mocked(writeAuditEntry)
      .mockResolvedValueOnce(makePreEntry())
      .mockResolvedValueOnce(makePreEntry({ entry_id: 'fail_xyz', operation: 'FAILED_OUTCOME' }))
    vi.mocked(writeEntry).mockResolvedValue(undefined)

    const { withAuditPipeline } = await import('../../src/audit/pipeline.js')
    await expect(
      withAuditPipeline({}, baseContext, async () => {
        throw new Error('operation failed')
      })
    ).rejects.toThrow('operation failed')

    // Second call to writeAuditEntry should be FAILED_OUTCOME
    expect(writeAuditEntry).toHaveBeenCalledTimes(2)
    const failEntry = vi.mocked(writeAuditEntry).mock.calls[1][1]
    expect(failEntry.operation).toBe('FAILED_OUTCOME')
    expect(failEntry.outcome_json.status).toBe('failed')
    expect(failEntry.outcome_json.error).toBe('operation failed')
  })

  it('still rethrows when FAILED_OUTCOME write also fails', async () => {
    const { writeAuditEntry } = await import('../../src/audit/secondary.js')
    const { writeEntry } = await import('../../src/audit/primary.js')
    vi.mocked(writeAuditEntry)
      .mockResolvedValueOnce(makePreEntry())
      .mockRejectedValueOnce(new Error('secondary also down'))
    vi.mocked(writeEntry).mockResolvedValue(undefined)

    const { withAuditPipeline } = await import('../../src/audit/pipeline.js')
    await expect(
      withAuditPipeline({}, baseContext, async () => {
        throw new Error('operation failed')
      })
    ).rejects.toThrow('operation failed') // original error, not secondary error
  })

  it('calls writeFailureCompensation when primary writeEntry fails', async () => {
    const { writeAuditEntry } = await import('../../src/audit/secondary.js')
    const { writeEntry, writeFailureCompensation } = await import('../../src/audit/primary.js')
    vi.mocked(writeAuditEntry)
      .mockResolvedValueOnce(makePreEntry({ entry_id: 'pre_fail' }))
      .mockResolvedValueOnce(makePostEntry())
    vi.mocked(writeEntry).mockRejectedValue(new Error('primary down'))
    vi.mocked(writeFailureCompensation).mockResolvedValue(undefined)

    const { withAuditPipeline } = await import('../../src/audit/pipeline.js')
    // Should NOT throw — primary failure is compensated, not fatal
    await withAuditPipeline({}, baseContext, async () => ({
      result: {},
      versionImpact: { versions_created: [], versions_superseded: [] },
    }))

    expect(writeFailureCompensation).toHaveBeenCalled()
  })
})

describe('withAuditPipeline — versionImpact fallback', () => {
  afterEach(() => vi.clearAllMocks())

  it('uses empty versionImpact when operation returns no versionImpact', async () => {
    const { writeAuditEntry } = await import('../../src/audit/secondary.js')
    const { writeEntry } = await import('../../src/audit/primary.js')
    vi.mocked(writeAuditEntry)
      .mockResolvedValueOnce(makePreEntry())
      .mockResolvedValueOnce(makePostEntry())
    vi.mocked(writeEntry).mockResolvedValue(undefined)

    const { withAuditPipeline } = await import('../../src/audit/pipeline.js')
    // Operation returns result but no versionImpact
    const output = await withAuditPipeline({}, baseContext, async () => ({ result: { status: 'ok' } }))
    expect(output.result).toEqual({ status: 'ok' })
  })
})
