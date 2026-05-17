/**
 * Extended tests for src/governance/conflict.js
 *
 * Covers the branches not exercised by the existing conflict.test.js:
 *   - detectConflict with actual contradiction found
 *   - detectConflict: LLM check fails (catch path → contradicts: false)
 *   - generateEnrichment: success + failure paths
 *   - checkContradiction: 404/501 → not-implemented message
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

// ── Top-level mocks ───────────────────────────────────────────────────────────

vi.mock('../../src/graph/client.js', () => ({
  searchNodes: vi.fn(),
  searchFacts: vi.fn(),
  addEpisode: vi.fn(),
  addSupersedingEpisode: vi.fn(),
  getEvolutionChain: vi.fn(),
  deleteEpisodeSoft: vi.fn(),
  ping: vi.fn(),
  BLOCKED_METHODS: new Set(['delete_episode', 'delete_entity', 'purge']),
  isMethodBlocked: vi.fn(),
}))

vi.mock('../../src/config/loader.js', () => ({
  getConfig: vi.fn(() => ({
    thresholds: { conflict_threshold: 0.85, authority_threshold: 0.20 },
    domains: {},
  })),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeGatewayClient(overrides = {}) {
  return {
    _post: vi.fn(),
    ...overrides,
  }
}

function makeNode(overrides = {}) {
  return {
    score: 0.9,
    summary: 'Use JWT for Lambda services',
    content: 'Use JWT',
    metadata: { key: 'db:pool-size' }, // different key → not same topic:key
    name: 'db:pool-size',
    ...overrides,
  }
}

// ── detectConflict — contradiction found ──────────────────────────────────────

describe('detectConflict — contradiction found', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns conflict:true when LLM says contents contradict', async () => {
    const { searchNodes } = await import('../../src/graph/client.js')
    vi.mocked(searchNodes).mockResolvedValue({ nodes: [makeNode()] })

    const gw = makeGatewayClient({
      _post: vi.fn().mockResolvedValue({ contradicts: true, reason: 'JWT vs sessions conflict', possible_split: false }),
    })

    const { detectConflict } = await import('../../src/governance/conflict.js')
    const result = await detectConflict('Use sessions for all services', 'auth', 'token-strategy', 'auth', gw)

    expect(result.conflict).toBe(true)
    expect(result.reason).toContain('JWT vs sessions conflict')
    expect(result.existing).toBeDefined()
  })

  it('returns conflict:false when LLM says no contradiction despite high similarity', async () => {
    const { searchNodes } = await import('../../src/graph/client.js')
    vi.mocked(searchNodes).mockResolvedValue({ nodes: [makeNode()] })

    const gw = makeGatewayClient({
      _post: vi.fn().mockResolvedValue({ contradicts: false, reason: 'same idea, different phrasing', possible_split: false }),
    })

    const { detectConflict } = await import('../../src/governance/conflict.js')
    const result = await detectConflict('JWT recommended for Lambda', 'auth', 'new-key', 'auth', gw)

    expect(result.conflict).toBe(false)
  })

  it('flags for human review when LLM check throws a generic error', async () => {
    const { searchNodes } = await import('../../src/graph/client.js')
    vi.mocked(searchNodes).mockResolvedValue({ nodes: [makeNode()] })

    const gw = makeGatewayClient({
      _post: vi.fn().mockRejectedValue(new Error('network error')),
    })

    const { detectConflict } = await import('../../src/governance/conflict.js')
    // checkContradiction catches ALL errors internally and returns { contradicts: true }
    // to flag for human review — governance must not silently swallow uncertainty.
    const result = await detectConflict('Use sessions', 'auth', 'new-key', 'auth', gw)

    expect(result.conflict).toBe(true)
    expect(result.reason).toContain('unavailable')
  })

  it('sets possible_split and split_suggestion when LLM returns them', async () => {
    const { searchNodes } = await import('../../src/graph/client.js')
    vi.mocked(searchNodes).mockResolvedValue({ nodes: [makeNode()] })

    const gw = makeGatewayClient({
      _post: vi.fn().mockResolvedValue({
        contradicts: true,
        reason: 'split scenario',
        possible_split: true,
        split_suggestion: 'scope by service type',
      }),
    })

    const { detectConflict } = await import('../../src/governance/conflict.js')
    const result = await detectConflict('Use sessions for ECS', 'auth', 'token', 'auth', gw)

    expect(result.possible_split).toBe(true)
    expect(result.split_suggestion).toBe('scope by service type')
  })

  it('skips nodes below conflict threshold', async () => {
    const { searchNodes } = await import('../../src/graph/client.js')
    vi.mocked(searchNodes).mockResolvedValue({
      nodes: [makeNode({ score: 0.5 })], // below default 0.85 threshold
    })

    const gw = makeGatewayClient({
      _post: vi.fn().mockResolvedValue({ contradicts: true, reason: 'conflict' }),
    })

    const { detectConflict } = await import('../../src/governance/conflict.js')
    const result = await detectConflict('Some content', 'auth', 'new-key', 'auth', gw)

    // Low similarity — LLM should not even be called
    expect(gw._post).not.toHaveBeenCalled()
    expect(result.conflict).toBe(false)
  })

  it('skips nodes that match the same topic:key (own update)', async () => {
    const { searchNodes } = await import('../../src/graph/client.js')
    vi.mocked(searchNodes).mockResolvedValue({
      nodes: [makeNode({ score: 0.95, metadata: { key: 'auth:token-strategy' }, name: 'auth:token-strategy' })],
    })

    const gw = makeGatewayClient({
      _post: vi.fn().mockResolvedValue({ contradicts: true, reason: 'conflict' }),
    })

    const { detectConflict } = await import('../../src/governance/conflict.js')
    const result = await detectConflict('Updated JWT content', 'auth', 'token-strategy', 'auth', gw)

    // Same key — should be treated as an update, not a conflict
    expect(gw._post).not.toHaveBeenCalled()
    expect(result.conflict).toBe(false)
  })
})

// ── detectConflict — LLM not implemented ────────────────────────────────────

describe('detectConflict — LLM returns 404/501 (not implemented)', () => {
  afterEach(() => vi.clearAllMocks())

  it('flags for human review when 404 from gateway', async () => {
    const { searchNodes } = await import('../../src/graph/client.js')
    vi.mocked(searchNodes).mockResolvedValue({ nodes: [makeNode()] })

    const gw = makeGatewayClient({
      _post: vi.fn().mockRejectedValue(new Error('404 Not Found')),
    })

    const { detectConflict } = await import('../../src/governance/conflict.js')
    // 404 errors are treated as "LLM not configured" — checkContradiction catches them
    // internally and returns { contradicts: true } to flag for human review (not silence).
    const result = await detectConflict('New content', 'auth', 'new-key', 'auth', gw)
    expect(result.conflict).toBe(true)
    expect(result.reason).toContain('not yet enabled')
  })
})

// ── generateEnrichment ────────────────────────────────────────────────────────

describe('generateEnrichment', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns enriched analysis from gateway', async () => {
    const gw = makeGatewayClient({
      _post: vi.fn().mockResolvedValue({
        analysis: 'These represent two different auth scenarios',
        risks_if_approved: ['May introduce inconsistency'],
        questions_for_reviewer: ['Which services does this apply to?'],
      }),
    })

    const { generateEnrichment } = await import('../../src/governance/conflict.js')
    const result = await generateEnrichment(
      'Use JWT for Lambda',
      'Use sessions for ECS',
      'Different auth approaches',
      false,
      undefined,
      gw,
    )

    expect(result.analysis).toBe('These represent two different auth scenarios')
    expect(gw._post).toHaveBeenCalledWith('/governance/enrich', expect.objectContaining({
      existing: 'Use JWT for Lambda',
      incoming: 'Use sessions for ECS',
    }))
  })

  it('returns fallback when gateway throws', async () => {
    const gw = makeGatewayClient({
      _post: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
    })

    const { generateEnrichment } = await import('../../src/governance/conflict.js')
    const result = await generateEnrichment(
      'existing content',
      'incoming content',
      'conflict reason',
      false,
      undefined,
      gw,
    )

    expect(result.analysis).toContain('Enrichment unavailable')
    expect(result.risks_if_approved).toBeInstanceOf(Array)
  })

  it('passes possible_split and split_suggestion to gateway', async () => {
    const gw = makeGatewayClient({
      _post: vi.fn().mockResolvedValue({}),
    })

    const { generateEnrichment } = await import('../../src/governance/conflict.js')
    await generateEnrichment(
      'A',
      'B',
      'reason',
      true,
      'Split by service type',
      gw,
    )

    const callBody = gw._post.mock.calls[0][1]
    expect(callBody.possible_split).toBe(true)
    expect(callBody.split_suggestion).toBe('Split by service type')
  })

  it('sets possible_split in fallback result', async () => {
    const gw = makeGatewayClient({
      _post: vi.fn().mockRejectedValue(new Error('down')),
    })

    const { generateEnrichment } = await import('../../src/governance/conflict.js')
    const result = await generateEnrichment(
      'A', 'B', 'reason', true, 'scope by service', gw,
    )

    expect(result.possible_split).toBe(true)
    expect(result.split_suggestion).toBe('scope by service')
  })
})
