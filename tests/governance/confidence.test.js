/**
 * Tests for src/governance/confidence.js
 *
 * Pure functions — no mocking required.
 */

import { describe, it, expect } from 'vitest'

describe('initialConfidence', () => {
  it('returns 0.7 when no value provided', async () => {
    const { initialConfidence } = await import('../../src/governance/confidence.js')
    expect(initialConfidence(undefined)).toBe(0.7)
  })

  it('returns 0.7 when null provided', async () => {
    const { initialConfidence } = await import('../../src/governance/confidence.js')
    expect(initialConfidence(null)).toBe(0.7)
  })

  it('returns 0.7 when non-number provided', async () => {
    const { initialConfidence } = await import('../../src/governance/confidence.js')
    expect(initialConfidence('high')).toBe(0.7)
  })

  it('returns provided value when in range', async () => {
    const { initialConfidence } = await import('../../src/governance/confidence.js')
    expect(initialConfidence(0.85)).toBe(0.85)
  })

  it('clamps to 1.0 when above max', async () => {
    const { initialConfidence } = await import('../../src/governance/confidence.js')
    expect(initialConfidence(1.5)).toBe(1.0)
  })

  it('clamps to 0.0 when below min', async () => {
    const { initialConfidence } = await import('../../src/governance/confidence.js')
    expect(initialConfidence(-0.5)).toBe(0.0)
  })

  it('returns exact 0 when 0 provided', async () => {
    const { initialConfidence } = await import('../../src/governance/confidence.js')
    expect(initialConfidence(0)).toBe(0.0)
  })

  it('returns exact 1 when 1 provided', async () => {
    const { initialConfidence } = await import('../../src/governance/confidence.js')
    expect(initialConfidence(1)).toBe(1.0)
  })
})

describe('onRecall', () => {
  it('adds 0.01 to confidence', async () => {
    const { onRecall } = await import('../../src/governance/confidence.js')
    expect(onRecall(0.8)).toBeCloseTo(0.81)
  })

  it('clamps to 1.0 when at max', async () => {
    const { onRecall } = await import('../../src/governance/confidence.js')
    expect(onRecall(1.0)).toBe(1.0)
  })

  it('clamps to 1.0 when bump would exceed max', async () => {
    const { onRecall } = await import('../../src/governance/confidence.js')
    expect(onRecall(0.995)).toBe(1.0)
  })

  it('works from a low base', async () => {
    const { onRecall } = await import('../../src/governance/confidence.js')
    expect(onRecall(0.0)).toBeCloseTo(0.01)
  })
})

describe('onAgeDecay', () => {
  it('decays by 0.005 per week', async () => {
    const { onAgeDecay } = await import('../../src/governance/confidence.js')
    expect(onAgeDecay(0.9, 1)).toBeCloseTo(0.895)
  })

  it('decays proportionally for multiple weeks', async () => {
    const { onAgeDecay } = await import('../../src/governance/confidence.js')
    expect(onAgeDecay(0.9, 10)).toBeCloseTo(0.85)
  })

  it('clamps to 0.0 when decay would go negative', async () => {
    const { onAgeDecay } = await import('../../src/governance/confidence.js')
    expect(onAgeDecay(0.01, 10)).toBe(0.0)
  })

  it('no decay for 0 weeks', async () => {
    const { onAgeDecay } = await import('../../src/governance/confidence.js')
    expect(onAgeDecay(0.8, 0)).toBe(0.8)
  })
})

describe('onConflictRaised', () => {
  it('subtracts 0.1 from confidence', async () => {
    const { onConflictRaised } = await import('../../src/governance/confidence.js')
    expect(onConflictRaised(0.9)).toBeCloseTo(0.8)
  })

  it('clamps to 0.0 when below min', async () => {
    const { onConflictRaised } = await import('../../src/governance/confidence.js')
    expect(onConflictRaised(0.05)).toBe(0.0)
  })

  it('does not go below 0', async () => {
    const { onConflictRaised } = await import('../../src/governance/confidence.js')
    expect(onConflictRaised(0.0)).toBe(0.0)
  })
})

describe('onConflictResolvedFor', () => {
  it('adds 0.1 to confidence', async () => {
    const { onConflictResolvedFor } = await import('../../src/governance/confidence.js')
    expect(onConflictResolvedFor(0.7)).toBeCloseTo(0.8)
  })

  it('clamps to 1.0 when above max', async () => {
    const { onConflictResolvedFor } = await import('../../src/governance/confidence.js')
    expect(onConflictResolvedFor(0.95)).toBe(1.0)
  })

  it('does not exceed 1', async () => {
    const { onConflictResolvedFor } = await import('../../src/governance/confidence.js')
    expect(onConflictResolvedFor(1.0)).toBe(1.0)
  })
})
