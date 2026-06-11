/**
 * Tests for src/audit/secondary.js
 *
 * writeAuditEntry() has a duck-type guard: if pg.writeAuditEntry is a function,
 * delegate to it. Otherwise, run the full transactional PG path.
 *
 * We test:
 *   1. Delegation (gateway client mode)
 *   2. Raw PG path via a mock client (connect/query/release)
 *   3. Constitutional guards: updateEntry() and deleteEntry() always throw
 *   4. getAuditEntry, getAllEntries, countEntries, exportEntries delegation paths
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/audit/chain.js', () => ({
  buildEntryWithHash: vi.fn((entry, prevHash, chainPos) => ({
    ...entry,
    previous_hash: prevHash,
    chain_position: chainPos,
    entry_hash: 'mock-hash-abc123',
  })),
  nextChainPosition: vi.fn().mockResolvedValue(1),
}))

vi.mock('../../src/governance/constitutional.js', () => ({
  enforceAppendOnlyAudit: vi.fn(() => {
    throw new Error('ConstitutionalViolation: audit log is append-only')
  }),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a mock pg client that simulates connect/BEGIN/query/COMMIT/release.
 */
function makeMockClient(queryResults = []) {
  let callIndex = 0
  const mockClient = {
    query: vi.fn(async () => {
      const result = queryResults[callIndex++]
      if (result instanceof Error) throw result
      return result ?? {}
    }),
    release: vi.fn(),
  }
  return mockClient
}

/**
 * Build a mock pool that returns a given client.
 */
function makeMockPool(client, overrides = {}) {
  return {
    connect: vi.fn().mockResolvedValue(client),
    query: vi.fn(),
    ...overrides,
  }
}

function makeEntry(overrides = {}) {
  return {
    entry_id: 'entry_001',
    operation: 'INTENT',
    tool: 'remember',
    timestamp: new Date().toISOString(),
    author: 'alice',
    author_role: 'engineer',
    session_id: 'session-1',
    content_hash: null,
    governance_json: { topic: 'auth', key: 'token' },
    outcome_json: { status: 'pending' },
    version_impact: { versions_created: [], versions_superseded: [] },
    q_project_id: 'test-project',
    ...overrides,
  }
}

// ── writeAuditEntry ───────────────────────────────────────────────────────────

describe('writeAuditEntry — gateway delegation', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to pg.writeAuditEntry when it is a function', async () => {
    const expected = makeEntry({ entry_id: 'delegated-entry' })
    const pg = { writeAuditEntry: vi.fn().mockResolvedValue(expected) }
    const { writeAuditEntry } = await import('../../src/audit/secondary.js')
    const result = await writeAuditEntry(pg, makeEntry())
    expect(pg.writeAuditEntry).toHaveBeenCalledOnce()
    expect(result).toEqual(expected)
  })
})

describe('writeAuditEntry — raw PG path', () => {
  afterEach(() => vi.clearAllMocks())

  it('runs BEGIN/INSERT/COMMIT in a transaction', async () => {
    const { nextChainPosition, buildEntryWithHash } = await import('../../src/audit/chain.js')
    vi.mocked(nextChainPosition).mockResolvedValue(1)
    vi.mocked(buildEntryWithHash).mockReturnValue({
      ...makeEntry(),
      previous_hash: null,
      chain_position: 1,
      entry_hash: 'mock-hash',
    })

    const mockClient = makeMockClient([
      {},                            // BEGIN
      { rows: [] },                  // SELECT prev hash
      {},                            // INSERT
      {},                            // COMMIT
    ])
    const pg = makeMockPool(mockClient)

    const { writeAuditEntry } = await import('../../src/audit/secondary.js')
    const result = await writeAuditEntry(pg, makeEntry())

    expect(mockClient.query).toHaveBeenCalledWith('BEGIN')
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT')
    expect(mockClient.release).toHaveBeenCalled()
    expect(result.entry_hash).toBe('mock-hash')
  })

  it('rolls back and rethrows on INSERT failure', async () => {
    const { nextChainPosition, buildEntryWithHash } = await import('../../src/audit/chain.js')
    vi.mocked(nextChainPosition).mockResolvedValue(1)
    vi.mocked(buildEntryWithHash).mockReturnValue({
      ...makeEntry(),
      previous_hash: null,
      chain_position: 1,
      entry_hash: 'mock-hash',
    })

    const insertError = new Error('unique constraint violation')
    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce({})                  // BEGIN
        .mockResolvedValueOnce({ rows: [] })         // SELECT prev hash
        .mockRejectedValueOnce(insertError)          // INSERT fails
        .mockResolvedValueOnce({}),                  // ROLLBACK
      release: vi.fn(),
    }
    const pg = makeMockPool(mockClient)

    const { writeAuditEntry } = await import('../../src/audit/secondary.js')
    await expect(writeAuditEntry(pg, makeEntry())).rejects.toThrow('unique constraint violation')
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK')
    expect(mockClient.release).toHaveBeenCalled()
  })
})

// ── getAuditEntry ─────────────────────────────────────────────────────────────

describe('getAuditEntry', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates when pg.getAuditEntry is a function', async () => {
    const pg = { getAuditEntry: vi.fn().mockResolvedValue({ entry_id: 'x' }) }
    const { getAuditEntry } = await import('../../src/audit/secondary.js')
    const result = await getAuditEntry(pg, 'x')
    expect(pg.getAuditEntry).toHaveBeenCalledWith('x')
    expect(result).toEqual({ entry_id: 'x' })
  })

  it('queries pg when no delegation method', async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [{ entry_id: 'x' }] }) }
    const { getAuditEntry } = await import('../../src/audit/secondary.js')
    const result = await getAuditEntry(pg, 'x')
    expect(result).toEqual({ entry_id: 'x' })
  })

  it('returns null when not found', async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const { getAuditEntry } = await import('../../src/audit/secondary.js')
    const result = await getAuditEntry(pg, 'nonexistent')
    expect(result).toBeNull()
  })
})

// ── getAllEntries ─────────────────────────────────────────────────────────────

describe('getAllEntries', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates when pg.getAllEntries is a function', async () => {
    const pg = { getAllEntries: vi.fn().mockResolvedValue([{ entry_id: 'a' }]) }
    const { getAllEntries } = await import('../../src/audit/secondary.js')
    const result = await getAllEntries(pg, { projectId: 'test' })
    expect(pg.getAllEntries).toHaveBeenCalledWith({ projectId: 'test' })
    expect(result).toHaveLength(1)
  })

  it('runs unfiltered query when no options', async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const { getAllEntries } = await import('../../src/audit/secondary.js')
    const result = await getAllEntries(pg)
    expect(pg.query.mock.calls[0][0]).not.toContain('WHERE')
    expect(result).toEqual([])
  })

  it('adds qProjectId filter', async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const { getAllEntries } = await import('../../src/audit/secondary.js')
    await getAllEntries(pg, { qProjectId: 'my-project' })
    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain('q_project_id')
  })

  it('adds from filter', async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const { getAllEntries } = await import('../../src/audit/secondary.js')
    await getAllEntries(pg, { from: '2024-01-01' })
    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain('timestamp >=')
  })

  it('adds to filter', async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const { getAllEntries } = await import('../../src/audit/secondary.js')
    await getAllEntries(pg, { to: '2024-12-31' })
    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain('timestamp <=')
  })

  it('adds tool filter', async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const { getAllEntries } = await import('../../src/audit/secondary.js')
    await getAllEntries(pg, { tool: 'remember' })
    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain('tool =')
  })

  it('combines multiple filters', async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [{ entry_id: 'a' }] }) }
    const { getAllEntries } = await import('../../src/audit/secondary.js')
    const result = await getAllEntries(pg, { qProjectId: 'proj', from: '2024-01-01', tool: 'recall' })
    expect(pg.query.mock.calls[0][0]).toContain('WHERE')
    expect(result).toHaveLength(1)
  })
})

// ── countEntries ──────────────────────────────────────────────────────────────

describe('countEntries', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates when pg.countEntries is a function', async () => {
    const pg = { countEntries: vi.fn().mockResolvedValue(42) }
    const { countEntries } = await import('../../src/audit/secondary.js')
    const result = await countEntries(pg, 'my-project')
    expect(pg.countEntries).toHaveBeenCalledOnce()
    expect(result).toBe(42)
  })

  it('counts all entries without projectId filter', async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [{ count: 10 }] }) }
    const { countEntries } = await import('../../src/audit/secondary.js')
    const result = await countEntries(pg)
    expect(pg.query.mock.calls[0][0]).not.toContain('WHERE')
    expect(result).toBe(10)
  })

  it('counts with qProjectId filter', async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [{ count: 5 }] }) }
    const { countEntries } = await import('../../src/audit/secondary.js')
    const result = await countEntries(pg, 'my-project')
    expect(pg.query.mock.calls[0][0]).toContain('q_project_id')
    expect(result).toBe(5)
  })
})

// ── exportEntries ─────────────────────────────────────────────────────────────

describe('exportEntries', () => {
  afterEach(() => vi.clearAllMocks())

  it('delegates to getAllEntries with options', async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [{ entry_id: 'e1' }] }) }
    const { exportEntries } = await import('../../src/audit/secondary.js')
    const result = await exportEntries(pg, { from: '2024-01-01' })
    expect(result).toHaveLength(1)
  })

  it('works with no options', async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const { exportEntries } = await import('../../src/audit/secondary.js')
    const result = await exportEntries(pg)
    expect(result).toEqual([])
  })
})

// ── Constitutional guards ─────────────────────────────────────────────────────

describe('updateEntry — append-only enforcement', () => {
  afterEach(() => vi.clearAllMocks())

  it('always throws ConstitutionalViolation', async () => {
    const { updateEntry } = await import('../../src/audit/secondary.js')
    expect(() => updateEntry()).toThrow('append-only')
  })
})

describe('deleteEntry — append-only enforcement', () => {
  afterEach(() => vi.clearAllMocks())

  it('always throws ConstitutionalViolation', async () => {
    const { deleteEntry } = await import('../../src/audit/secondary.js')
    expect(() => deleteEntry()).toThrow('append-only')
  })
})
