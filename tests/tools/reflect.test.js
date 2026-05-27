/**
 * Tests for src/tools/reflect.js
 *
 * reflect() extracts knowledge via /governance/extract, then calls remember()
 * for each item. All LLM calls go through the gateway client (gw._post).
 *
 * The handler receives (pg, input, identity, ctx) where pg is the gateway client
 * in MCP mode (duck-typed to match GatewayClient).
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/audit/pipeline.js', () => ({
  withAuditPipeline: vi.fn(async (_pg, _ctx, operation) => {
    const result = await operation()
    return result
  }),
}))

vi.mock('../../src/tools/remember.js', () => ({
  handler: vi.fn(),
}))

vi.mock('../../src/governance/provenance.js', () => ({
  buildAuditVersionImpact: vi.fn(() => ({ versions_created: [], versions_superseded: [] })),
}))

vi.mock('../../src/graph/schema.js', () => ({
  TriggeredBy: { REFLECT: 'reflect' },
  KnowledgeStatus: { ACTIVE: 'ACTIVE', DRAFT: 'DRAFT' },
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

const testCtx = { projectId: 'test-project', gatewayUrl: 'http://localhost:3001' }

function makeGatewayClient(extractItems = [], overrides = {}) {
  return {
    _post: vi.fn().mockResolvedValue({ items: extractItems }),
    getVersionHistory: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

function makeItem(overrides = {}) {
  return {
    topic: 'auth',
    key: 'token-strategy',
    content: 'Use JWT for Lambda services',
    entity_type: 'Decision',
    confidence: 0.8,
    mode: 'echoing',
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('reflect — LLM unavailable', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns note about unavailability when gateway returns 404', async () => {
    const gw = makeGatewayClient()
    gw._post = vi.fn().mockRejectedValue(new Error('404 Not Found'))

    const { handler } = await import('../../src/tools/reflect.js')
    const result = await handler(gw, {
      task_summary: 'Implemented auth strategy for Lambda',
      author: 'claude',
    }, undefined, testCtx)

    expect(result.extracted).toBe(0)
    expect(result.note).toContain('not have LLM configured')
  })

  it('returns note when gateway throws 501', async () => {
    const gw = makeGatewayClient()
    gw._post = vi.fn().mockRejectedValue(new Error('501 Not Implemented'))

    const { handler } = await import('../../src/tools/reflect.js')
    const result = await handler(gw, {
      task_summary: 'Implemented auth strategy',
      author: 'claude',
    }, undefined, testCtx)

    expect(result.note).toContain('not have LLM configured')
  })

  it('returns generic note when gateway throws unexpected error', async () => {
    const gw = makeGatewayClient()
    gw._post = vi.fn().mockRejectedValue(new Error('internal server error'))

    const { handler } = await import('../../src/tools/reflect.js')
    const result = await handler(gw, {
      task_summary: 'Implemented auth strategy',
      author: 'claude',
    }, undefined, testCtx)

    expect(result.note).toContain('not have LLM configured')
  })
})

describe('reflect — no items extracted', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns zero counts when LLM returns empty items', async () => {
    const gw = makeGatewayClient([]) // empty items

    const { handler } = await import('../../src/tools/reflect.js')
    const result = await handler(gw, {
      task_summary: 'Minor code cleanup — no decisions',
      author: 'claude',
    }, undefined, testCtx)

    expect(result.extracted).toBe(0)
    expect(result.stored).toBe(0)
    expect(result.conflicts).toBe(0)
    expect(result.note).toContain('No team-specific knowledge')
  })
})

describe('reflect — items extracted and stored', () => {
  afterEach(() => vi.clearAllMocks())

  it('calls rememberHandler for each extracted item', async () => {
    const items = [makeItem(), makeItem({ key: 'session-strategy', content: 'Use sessions for ECS' })]
    const gw = makeGatewayClient(items)

    const { handler: rememberHandler } = await import('../../src/tools/remember.js')
    vi.mocked(rememberHandler).mockResolvedValue({ status: 'stored' })

    const { handler } = await import('../../src/tools/reflect.js')
    const result = await handler(gw, {
      task_summary: 'Implemented auth strategy for Lambda and ECS',
      decisions_made: ['Use JWT for Lambda'],
      patterns_used: ['Stateless auth'],
      author: 'claude',
    }, undefined, testCtx)

    expect(rememberHandler).toHaveBeenCalledTimes(2)
    expect(result.extracted).toBe(2)
    expect(result.stored).toBe(2)
    expect(result.conflicts).toBe(0)
  })

  it('counts conflicts separately when remember returns conflict_detected', async () => {
    const items = [makeItem()]
    const gw = makeGatewayClient(items)

    const { handler: rememberHandler } = await import('../../src/tools/remember.js')
    vi.mocked(rememberHandler).mockResolvedValue({ status: 'conflict_detected', conflict_id: 'q_c1' })

    const { handler } = await import('../../src/tools/reflect.js')
    const result = await handler(gw, {
      task_summary: 'Task with conflict',
      author: 'claude',
    }, undefined, testCtx)

    expect(result.conflicts).toBe(1)
    expect(result.stored).toBe(0)
    expect(result.conflict_items).toHaveLength(1)
  })

  it('counts failed items when remember throws', async () => {
    const items = [makeItem()]
    const gw = makeGatewayClient(items)

    const { handler: rememberHandler } = await import('../../src/tools/remember.js')
    vi.mocked(rememberHandler).mockRejectedValue(new Error('db error'))

    const { handler } = await import('../../src/tools/reflect.js')
    const result = await handler(gw, {
      task_summary: 'Task with failure',
      author: 'claude',
    }, undefined, testCtx)

    expect(result.failed).toBe(1)
    expect(result.failed_items).toHaveLength(1)
    expect(result.failed_items[0].error).toBe('db error')
  })
})

describe('reflect — duplicate detection', () => {
  afterEach(() => vi.clearAllMocks())

  it('skips items where identical DRAFT content hash already exists', async () => {
    const content = 'Use JWT for Lambda services'
    const items = [makeItem({ content })]

    // Compute expected hash — same as reflect.js does
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha256').update(content).digest('hex')

    const gw = makeGatewayClient(items)
    gw.getVersionHistory = vi.fn().mockResolvedValue([
      { status: 'DRAFT', content_hash: hash },
    ])

    const { handler: rememberHandler } = await import('../../src/tools/remember.js')
    vi.mocked(rememberHandler).mockResolvedValue({ status: 'stored' })

    const { handler } = await import('../../src/tools/reflect.js')
    const result = await handler(gw, {
      task_summary: 'Duplicate task',
      author: 'claude',
    }, undefined, testCtx)

    // Item should be skipped (not remembered)
    expect(rememberHandler).not.toHaveBeenCalled()
    expect(result.skipped).toBe(1)
    expect(result.note).toContain('already in DRAFT')
  })

  it('shows all-skipped note when every item is a duplicate', async () => {
    const content = 'Use JWT for Lambda services'
    const items = [makeItem({ content })]
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha256').update(content).digest('hex')

    const gw = makeGatewayClient(items)
    gw.getVersionHistory = vi.fn().mockResolvedValue([
      { status: 'DRAFT', content_hash: hash },
    ])

    const { handler: rememberHandler } = await import('../../src/tools/remember.js')
    vi.mocked(rememberHandler).mockResolvedValue({ status: 'stored' })

    const { handler } = await import('../../src/tools/reflect.js')
    const result = await handler(gw, {
      task_summary: 'All duplicates',
      author: 'claude',
    }, undefined, testCtx)

    expect(result.note).toContain('already in DRAFT')
  })

  it('does not skip when history check throws (defaults to false)', async () => {
    const items = [makeItem()]
    const gw = makeGatewayClient(items)
    gw.getVersionHistory = vi.fn().mockRejectedValue(new Error('graphiti down'))

    const { handler: rememberHandler } = await import('../../src/tools/remember.js')
    vi.mocked(rememberHandler).mockResolvedValue({ status: 'stored' })

    const { handler } = await import('../../src/tools/reflect.js')
    const result = await handler(gw, {
      task_summary: 'Task with graphiti down',
      author: 'claude',
    }, undefined, testCtx)

    // Should proceed to remember (not skip)
    expect(rememberHandler).toHaveBeenCalledOnce()
    expect(result.stored).toBe(1)
  })
})

// ── constraints forwarding (TDD: fails until extractKnowledge() is updated) ──
//
// reflect() accepts a 'constraints' field in its schema but currently the
// extractKnowledge() function does NOT forward it to gw._post('/governance/extract').
// These tests document the expected behaviour after the fix.
//
// The fix: pass constraints to extractKnowledge() and include them in the
// POST /governance/extract body so the LLM prompt builder can incorporate them.

describe('reflect — constraints forwarding (TDD: fails until extractKnowledge fix)', () => {
  afterEach(() => vi.clearAllMocks())

  it('forwards constraints to POST /governance/extract when provided', async () => {
    const gw = makeGatewayClient([makeItem()])
    const { handler: rememberHandler } = await import('../../src/tools/remember.js')
    vi.mocked(rememberHandler).mockResolvedValue({ status: 'stored' })

    const { handler } = await import('../../src/tools/reflect.js')
    await handler(gw, {
      task_summary:   'Implement auth strategy for Lambda services',
      decisions_made: ['Use JWT for Lambda'],
      patterns_used:  ['Stateless auth'],
      constraints:    [
        'All writes require tamper-evident audit trail',
        'No hard deletes — append-only semantics',
      ],
      author: 'claude',
    }, undefined, testCtx)

    // gw._post is the stub capturing the extract call.
    // After the fix, constraints must appear in the call body.
    expect(gw._post).toHaveBeenCalledWith(
      '/governance/extract',
      expect.objectContaining({
        constraints: [
          'All writes require tamper-evident audit trail',
          'No hard deletes — append-only semantics',
        ],
      }),
    )
  })

  it('omits constraints key from extract body when constraints not provided', async () => {
    const gw = makeGatewayClient([makeItem()])
    const { handler: rememberHandler } = await import('../../src/tools/remember.js')
    vi.mocked(rememberHandler).mockResolvedValue({ status: 'stored' })

    const { handler } = await import('../../src/tools/reflect.js')
    await handler(gw, {
      task_summary: 'Implement auth strategy for Lambda',
      author: 'claude',
    }, undefined, testCtx)

    // When no constraints supplied, the extract body should not include the key
    // (avoids sending constraints: undefined to the gateway).
    const postCall = gw._post.mock.calls.find(c => c[0] === '/governance/extract')
    expect(postCall).toBeDefined()
    expect(postCall[1]).not.toHaveProperty('constraints')
  })

  it('does not fail when constraints is empty array', async () => {
    const gw = makeGatewayClient([makeItem()])
    const { handler: rememberHandler } = await import('../../src/tools/remember.js')
    vi.mocked(rememberHandler).mockResolvedValue({ status: 'stored' })

    const { handler } = await import('../../src/tools/reflect.js')
    const result = await handler(gw, {
      task_summary: 'Implement auth strategy',
      constraints:  [],
      author: 'claude',
    }, undefined, testCtx)

    expect(result.stored).toBe(1)
    expect(result.failed).toBe(0)
  })
})
