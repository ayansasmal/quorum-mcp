/**
 * Tests for src/identity/resolver.js
 *
 * The resolver has a module-level cache (_identity). Each test that changes
 * env vars must call clearIdentityCache() and restore the env after.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}))

vi.mock('../../src/config/loader.js', () => ({
  getConfig: vi.fn(),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(members = [], roles = {}) {
  return { members, roles, domains: {} }
}

function makeMember(overrides = {}) {
  return {
    name: 'Alice',
    team: 'platform',
    role: 'principal_architect',
    github_username: 'alice',
    git_email: 'alice@example.com',
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('resolveIdentity — Layer 4: anonymous fallback', () => {
  beforeEach(async () => {
    // Clear env and cache before each test
    delete process.env.QUORUM_GITHUB_TOKEN
    delete process.env.QUORUM_AUTHOR
    const { clearIdentityCache } = await import('../../src/identity/resolver.js')
    clearIdentityCache()
  })

  afterEach(async () => {
    vi.clearAllMocks()
    const { clearIdentityCache } = await import('../../src/identity/resolver.js')
    clearIdentityCache()
  })

  it('returns anonymous when no env vars and git returns nothing', async () => {
    const { execFileSync } = await import('node:child_process')
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not found') })

    const { resolveIdentity } = await import('../../src/identity/resolver.js')
    const identity = await resolveIdentity({ forceRefresh: true })

    expect(identity.name).toBe('anonymous')
    expect(identity.method).toBe('anonymous')
    expect(identity.base_confidence).toBe(0.5)
    expect(identity.team).toBeNull()
    expect(identity.role).toBeNull()
  })

  it('caches identity after first resolution (no forceRefresh)', async () => {
    const { execFileSync } = await import('node:child_process')
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('no git') })

    const { resolveIdentity } = await import('../../src/identity/resolver.js')
    const first = await resolveIdentity({ forceRefresh: true })
    const second = await resolveIdentity()

    expect(first).toBe(second) // exact same object reference (cached)
  })
})

describe('resolveIdentity — Layer 3: QUORUM_AUTHOR env var', () => {
  beforeEach(async () => {
    delete process.env.QUORUM_GITHUB_TOKEN
    const { execFileSync } = await import('node:child_process')
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('no git') })
    const { clearIdentityCache } = await import('../../src/identity/resolver.js')
    clearIdentityCache()
  })

  afterEach(async () => {
    delete process.env.QUORUM_AUTHOR
    vi.clearAllMocks()
    const { clearIdentityCache } = await import('../../src/identity/resolver.js')
    clearIdentityCache()
  })

  it('resolves via QUORUM_AUTHOR when member found in config', async () => {
    process.env.QUORUM_AUTHOR = 'Alice'
    const { getConfig } = await import('../../src/config/loader.js')
    vi.mocked(getConfig).mockReturnValue(makeConfig([makeMember()], { principal_architect: { base_confidence: 0.9 } }))

    const { resolveIdentity } = await import('../../src/identity/resolver.js')
    const identity = await resolveIdentity({ forceRefresh: true })

    expect(identity.method).toBe('env_var')
    expect(identity.name).toBe('Alice')
    expect(identity.role).toBe('principal_architect')
    expect(identity.team).toBe('platform')
  })

  it('resolves via QUORUM_AUTHOR with anonymous confidence when not in config', async () => {
    process.env.QUORUM_AUTHOR = 'bob-unknown'
    const { getConfig } = await import('../../src/config/loader.js')
    vi.mocked(getConfig).mockReturnValue(makeConfig([makeMember()]))

    const { resolveIdentity } = await import('../../src/identity/resolver.js')
    const identity = await resolveIdentity({ forceRefresh: true })

    expect(identity.method).toBe('env_var')
    expect(identity.name).toBe('bob-unknown')
    expect(identity.base_confidence).toBe(0.5)
    expect(identity.role).toBeNull()
  })
})

describe('resolveIdentity — Layer 2: git email', () => {
  beforeEach(async () => {
    delete process.env.QUORUM_GITHUB_TOKEN
    delete process.env.QUORUM_AUTHOR
    const { clearIdentityCache } = await import('../../src/identity/resolver.js')
    clearIdentityCache()
  })

  afterEach(async () => {
    vi.clearAllMocks()
    const { clearIdentityCache } = await import('../../src/identity/resolver.js')
    clearIdentityCache()
  })

  it('resolves via git email when member found in config', async () => {
    const { execFileSync } = await import('node:child_process')
    vi.mocked(execFileSync).mockReturnValue('alice@example.com\n')
    const { getConfig } = await import('../../src/config/loader.js')
    vi.mocked(getConfig).mockReturnValue(makeConfig([makeMember()], { principal_architect: { base_confidence: 0.9 } }))

    const { resolveIdentity } = await import('../../src/identity/resolver.js')
    const identity = await resolveIdentity({ forceRefresh: true })

    expect(identity.method).toBe('git_email')
    expect(identity.name).toBe('Alice')
    expect(identity.role).toBe('principal_architect')
  })

  it('uses email as name when not in config', async () => {
    const { execFileSync } = await import('node:child_process')
    vi.mocked(execFileSync).mockReturnValue('unknown@example.com\n')
    const { getConfig } = await import('../../src/config/loader.js')
    vi.mocked(getConfig).mockReturnValue(makeConfig([makeMember()]))

    const { resolveIdentity } = await import('../../src/identity/resolver.js')
    const identity = await resolveIdentity({ forceRefresh: true })

    expect(identity.method).toBe('git_email')
    expect(identity.name).toBe('unknown@example.com')
    expect(identity.base_confidence).toBe(0.5)
  })

  it('falls through to anonymous when execFileSync returns empty string', async () => {
    const { execFileSync } = await import('node:child_process')
    vi.mocked(execFileSync).mockReturnValue('   \n') // whitespace only

    const { resolveIdentity } = await import('../../src/identity/resolver.js')
    const identity = await resolveIdentity({ forceRefresh: true })

    expect(identity.method).toBe('anonymous')
  })
})

describe('resolveIdentity — Layer 1: QUORUM_GITHUB_TOKEN', () => {
  beforeEach(async () => {
    delete process.env.QUORUM_AUTHOR
    const { clearIdentityCache } = await import('../../src/identity/resolver.js')
    clearIdentityCache()
  })

  afterEach(async () => {
    delete process.env.QUORUM_GITHUB_TOKEN
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    const { clearIdentityCache } = await import('../../src/identity/resolver.js')
    clearIdentityCache()
  })

  it('resolves via GitHub token when member found in config', async () => {
    process.env.QUORUM_GITHUB_TOKEN = 'ghp_test123'
    const { execFileSync } = await import('node:child_process')
    vi.mocked(execFileSync).mockReturnValue('alice@example.com\n')

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ login: 'alice' }),
    }))

    const { getConfig } = await import('../../src/config/loader.js')
    vi.mocked(getConfig).mockReturnValue(makeConfig([makeMember()], { principal_architect: { base_confidence: 0.9 } }))

    const { resolveIdentity } = await import('../../src/identity/resolver.js')
    const identity = await resolveIdentity({ forceRefresh: true })

    expect(identity.method).toBe('github_token')
    expect(identity.name).toBe('Alice')
    expect(identity.role).toBe('principal_architect')
  })

  it('uses github username when verified but not in config', async () => {
    process.env.QUORUM_GITHUB_TOKEN = 'ghp_test123'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ login: 'unknown-user' }),
    }))
    const { getConfig } = await import('../../src/config/loader.js')
    vi.mocked(getConfig).mockReturnValue(makeConfig([makeMember()]))

    const { clearIdentityCache, resolveIdentity } = await import('../../src/identity/resolver.js')
    clearIdentityCache()
    const identity = await resolveIdentity({ forceRefresh: true })

    expect(identity.method).toBe('github_token')
    expect(identity.name).toBe('unknown-user')
    expect(identity.base_confidence).toBe(0.5)
  })

  it('falls through to git email when GitHub API returns non-ok', async () => {
    process.env.QUORUM_GITHUB_TOKEN = 'ghp_bad'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    }))
    const { execFileSync } = await import('node:child_process')
    vi.mocked(execFileSync).mockReturnValue('alice@example.com\n')
    const { getConfig } = await import('../../src/config/loader.js')
    vi.mocked(getConfig).mockReturnValue(makeConfig([makeMember()], { principal_architect: { base_confidence: 0.9 } }))

    const { clearIdentityCache, resolveIdentity } = await import('../../src/identity/resolver.js')
    clearIdentityCache()
    const identity = await resolveIdentity({ forceRefresh: true })

    // Falls through: github fails → git email resolves
    expect(identity.method).toBe('git_email')
  })

  it('falls through when fetch throws', async () => {
    process.env.QUORUM_GITHUB_TOKEN = 'ghp_bad'
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))
    const { execFileSync } = await import('node:child_process')
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('no git') })

    const { clearIdentityCache, resolveIdentity } = await import('../../src/identity/resolver.js')
    clearIdentityCache()
    const identity = await resolveIdentity({ forceRefresh: true })

    expect(identity.method).toBe('anonymous')
  })
})

describe('getIdentity', () => {
  afterEach(async () => {
    vi.clearAllMocks()
    const { clearIdentityCache } = await import('../../src/identity/resolver.js')
    clearIdentityCache()
  })

  it('returns null before resolveIdentity is called', async () => {
    const { clearIdentityCache, getIdentity } = await import('../../src/identity/resolver.js')
    clearIdentityCache()
    expect(getIdentity()).toBeNull()
  })

  it('returns cached identity after resolution', async () => {
    const { execFileSync } = await import('node:child_process')
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('no git') })
    delete process.env.QUORUM_GITHUB_TOKEN
    delete process.env.QUORUM_AUTHOR

    const { clearIdentityCache, resolveIdentity, getIdentity } = await import('../../src/identity/resolver.js')
    clearIdentityCache()
    await resolveIdentity({ forceRefresh: true })
    const cached = getIdentity()

    expect(cached).not.toBeNull()
    expect(cached.method).toBe('anonymous')
  })
})

describe('applyConfidenceFloor', () => {
  it('uses provided confidence when above floor', async () => {
    const { applyConfidenceFloor } = await import('../../src/identity/resolver.js')
    const identity = { base_confidence: 0.5 }
    expect(applyConfidenceFloor(0.9, identity)).toBe(0.9)
  })

  it('uses floor when provided confidence is below it', async () => {
    const { applyConfidenceFloor } = await import('../../src/identity/resolver.js')
    const identity = { base_confidence: 0.7 }
    expect(applyConfidenceFloor(0.4, identity)).toBe(0.7)
  })

  it('uses exact floor when provided equals floor', async () => {
    const { applyConfidenceFloor } = await import('../../src/identity/resolver.js')
    const identity = { base_confidence: 0.7 }
    expect(applyConfidenceFloor(0.7, identity)).toBe(0.7)
  })
})

describe('clearIdentityCache', () => {
  it('resets cached identity to null', async () => {
    const { execFileSync } = await import('node:child_process')
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('no git') })
    delete process.env.QUORUM_GITHUB_TOKEN
    delete process.env.QUORUM_AUTHOR

    const { resolveIdentity, getIdentity, clearIdentityCache } = await import('../../src/identity/resolver.js')
    await resolveIdentity({ forceRefresh: true })
    expect(getIdentity()).not.toBeNull()

    clearIdentityCache()
    expect(getIdentity()).toBeNull()
  })
})
