/**
 * Tests for src/tools/config-upload.js
 *
 * config_upload() reads a local JSON file and POSTs it via the gateway client.
 * The gateway client is passed as the first argument (gw).
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpConfig(content) {
  const dir = tmpdir()
  const filename = `quorum-test-${Date.now()}.quorum.json`
  const filePath = join(dir, filename)
  writeFileSync(filePath, JSON.stringify(content), 'utf8')
  return filePath
}

function makeGatewayClient(overrides = {}) {
  return {
    _post: vi.fn(),
    _gatewayUrl: 'http://localhost:3001',
    ...overrides,
  }
}

const validConfig = {
  group_id: 'test-project',
  owner: 'alice',
  members: [],
  domains: {},
  roles: {},
  thresholds: { conflict_threshold: 0.85, authority_threshold: 0.20 },
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('config-upload — file read errors', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns file_read_failed when file does not exist', async () => {
    const gw = makeGatewayClient()
    const { handler } = await import('../../src/tools/config-upload.js')
    const result = await handler(gw, { config_path: '/nonexistent/path/to/config.quorum.json' })
    expect(result.status).toBe('error')
    expect(result.error).toBe('file_read_failed')
    expect(result.message).toContain('Could not read config file')
  })

  it('returns file_parse_failed when file contains invalid JSON', async () => {
    const dir = tmpdir()
    const filePath = join(dir, `bad-json-${Date.now()}.quorum.json`)
    writeFileSync(filePath, 'this is { not valid JSON', 'utf8')

    const gw = makeGatewayClient()
    const { handler } = await import('../../src/tools/config-upload.js')
    const result = await handler(gw, { config_path: filePath })

    expect(result.status).toBe('error')
    expect(result.error).toBe('file_parse_failed')
    expect(result.message).toContain('Invalid JSON')
  })
})

describe('config-upload — successful upload', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns onboarded status with project_id from gateway', async () => {
    const filePath = makeTmpConfig(validConfig)
    const gw = makeGatewayClient({
      _post: vi.fn().mockResolvedValue({
        project_id: 'test-project',
        q_project_id: 'q_p42',
        message: 'Project onboarded successfully.',
      }),
    })

    const { handler } = await import('../../src/tools/config-upload.js')
    const result = await handler(gw, { config_path: filePath })

    expect(result.status).toBe('onboarded')
    expect(result.project_id).toBe('test-project')
    expect(result.q_project_id).toBe('q_p42')
    expect(gw._post).toHaveBeenCalledWith('/config/upload', validConfig)
  })

  it('falls back to group_id when gateway does not return project_id', async () => {
    const filePath = makeTmpConfig(validConfig)
    const gw = makeGatewayClient({
      _post: vi.fn().mockResolvedValue({
        q_project_id: 'q_p5',
        message: 'OK',
      }),
    })

    const { handler } = await import('../../src/tools/config-upload.js')
    const result = await handler(gw, { config_path: filePath })

    expect(result.project_id).toBe('test-project') // from config group_id
    expect(result.q_project_id).toBe('q_p5')
  })

  it('includes next_step with q_project_id when available', async () => {
    const filePath = makeTmpConfig(validConfig)
    const gw = makeGatewayClient({
      _post: vi.fn().mockResolvedValue({
        project_id: 'test-project',
        q_project_id: 'q_p10',
        message: 'OK',
      }),
    })

    const { handler } = await import('../../src/tools/config-upload.js')
    const result = await handler(gw, { config_path: filePath })

    expect(result.next_step).toContain('q_project_id')
    expect(result.next_step).toContain('q_p10')
  })

  it('includes next_step without q_project_id when not returned', async () => {
    const filePath = makeTmpConfig(validConfig)
    const gw = makeGatewayClient({
      _post: vi.fn().mockResolvedValue({
        project_id: 'test-project',
        message: 'OK',
      }),
    })

    const { handler } = await import('../../src/tools/config-upload.js')
    const result = await handler(gw, { config_path: filePath })

    expect(result.next_step).toContain('.quorum file')
    expect(result.q_project_id).toBeNull()
  })
})

describe('config-upload — 409 already onboarded', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns already_onboarded when gateway returns 409', async () => {
    const filePath = makeTmpConfig(validConfig)
    const err = new Error('Conflict (409)')
    err.status = 409
    const gw = makeGatewayClient({ _post: vi.fn().mockRejectedValue(err) })

    const { handler } = await import('../../src/tools/config-upload.js')
    const result = await handler(gw, { config_path: filePath })

    expect(result.status).toBe('already_onboarded')
    expect(result.project_id).toBe('test-project')
    expect(result.hint).toContain('Phase 5')
  })

  it('returns already_onboarded when error message includes (409)', async () => {
    const filePath = makeTmpConfig(validConfig)
    const err = new Error('Request failed (409) Already exists')
    const gw = makeGatewayClient({ _post: vi.fn().mockRejectedValue(err) })

    const { handler } = await import('../../src/tools/config-upload.js')
    const result = await handler(gw, { config_path: filePath })

    expect(result.status).toBe('already_onboarded')
  })
})

describe('config-upload — gateway upload failure', () => {
  afterEach(() => vi.clearAllMocks())

  it('rethrows non-409 gateway errors', async () => {
    const filePath = makeTmpConfig(validConfig)
    const err = new Error('Internal Server Error (500)')
    err.status = 500
    const gw = makeGatewayClient({ _post: vi.fn().mockRejectedValue(err) })

    const { handler } = await import('../../src/tools/config-upload.js')
    await expect(handler(gw, { config_path: filePath })).rejects.toThrow('Internal Server Error')
  })

  it('rethrows 400 validation errors', async () => {
    const filePath = makeTmpConfig(validConfig)
    const err = new Error('Bad Request (400): owner is required')
    err.status = 400
    const gw = makeGatewayClient({ _post: vi.fn().mockRejectedValue(err) })

    const { handler } = await import('../../src/tools/config-upload.js')
    await expect(handler(gw, { config_path: filePath })).rejects.toThrow('400')
  })
})
