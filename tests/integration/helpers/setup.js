/**
 * Vitest globalSetup — seeds fixture project configs before the MCP integration
 * tests run. Mirrors quorum/e2e/helpers/setup.js (Playwright globalSetup).
 *
 * Responsibilities:
 *   1. Wait until the gateway is healthy.
 *   2. Upload all fixture .quorum.json configs via POST /config/upload (idempotent).
 *
 * The fixture files live in quorum/e2e/fixtures/. With the qc/ parent
 * mounted at /workspace in Docker, this resolves to:
 *   /workspace/quorum/e2e/fixtures/
 *
 * This file is executed by Vitest's globalSetup runner (not inside a worker),
 * so it uses plain Node.js fetch rather than any test-runner globals.
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import jwt from 'jsonwebtoken'

const __dir    = dirname(fileURLToPath(import.meta.url))
// Resolves to quorum/e2e/helpers/ — same parent-relative path as tokens.js
const HELPERS_DIR  = resolve(__dir, '../../../../quorum/e2e/helpers')
const FIXTURES_DIR = resolve(HELPERS_DIR, '../fixtures')
const PRIV_KEY = readFileSync(resolve(HELPERS_DIR, '../fixtures/test-private-key.pem'))

const GATEWAY  = process.env.QUORUM_GATEWAY_URL ?? 'http://localhost:3001'

function makeToken(sub) {
  return jwt.sign({ sub }, PRIV_KEY, {
    algorithm:  'ES256',
    expiresIn:  '1h',
    keyid:      'test-key-1',
    issuer:     'quorum-gateway',
  })
}

async function waitForGateway(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${GATEWAY}/health`)
      if (r.ok) return
      last = `HTTP ${r.status}`
    } catch (err) {
      last = err.message
    }
    await new Promise(r => setTimeout(r, 2_000))
  }
  throw new Error(`globalSetup: gateway not healthy after ${timeoutMs / 1000}s. Last: ${last}`)
}

async function uploadFixture(file, token) {
  const path   = resolve(FIXTURES_DIR, file)
  const config = JSON.parse(readFileSync(path, 'utf8'))
  const res = await fetch(`${GATEWAY}/config/upload`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(config),
  })
  if (res.status === 200 || res.status === 201) {
    const label = res.status === 201 ? 'uploaded ✓' : 'updated ✓'
    console.log(`[mcp-setup] ${file} — ${label}`)
    return
  }
  const text = await res.text().catch(() => '')
  throw new Error(`[mcp-setup] fixture upload failed — ${file}: HTTP ${res.status} — ${text}`)
}

export default async function setup() {
  console.log('[mcp-setup] waiting for gateway...')
  await waitForGateway()
  console.log('[mcp-setup] gateway healthy ✓')

  const peToken        = makeToken('test-pe')
  const architectToken = makeToken('test-architect')

  const fixtures = [
    ['quorum-test-catalog.quorum.json',          peToken],
    ['quorum-test-project.quorum.json',           peToken],
    ['quorum-test-isolated-project.quorum.json',  peToken],
    ['quorum-test-peer-project.quorum.json',       architectToken],
    ['quorum-test-division-catalog.quorum.json',  peToken],
    ['quorum-test-division-project.quorum.json',  peToken],
  ]

  for (const [file, token] of fixtures) {
    await uploadFixture(file, token)
  }

  console.log('[mcp-setup] all fixtures seeded ✓')
}
