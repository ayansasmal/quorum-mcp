/**
 * MCP protocol verification for projectless self-serve onboarding.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createMcpServer } from '../../src/server.js'
import {
  _resetGatewayClient,
  setGatewayToken,
} from '../../src/gateway/client.js'

/**
 * Build an unverified slim JWT suitable for GatewayClient's local claim decoder.
 * @returns {string}
 */
function projectlessToken() {
  /** @type {string} */
  const payload = Buffer.from(JSON.stringify({
    sub:      'new-user',
    is_admin: false,
    exp:      Math.floor(Date.now() / 1000) + 900,
  })).toString('base64url')
  return `test.${payload}.signature`
}

describe('self-serve onboarding through an MCP client', () => {
  /** @type {Client | null} */
  let client = null
  /** @type {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer | null} */
  let mcpServer = null
  /** @type {Array<{ headers: Record<string, string>, body: object }>} */
  let uploads = []
  /** @type {string} */
  let runtimeToken = ''

  beforeEach(async () => {
    uploads = []
    delete process.env.QUORUM_PROJECT_ID
    delete process.env.QUORUM_CONFIG_PATH
    _resetGatewayClient()
    runtimeToken = projectlessToken()
    setGatewayToken(runtimeToken)

    process.env.QUORUM_GATEWAY_URL = 'http://gateway.test'
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      if (url === 'http://gateway.test/config/upload' && options.method === 'POST') {
        uploads.push({
          headers: options.headers,
          body:    JSON.parse(options.body),
        })
        return new Response(JSON.stringify({
          project_id:   'team-x',
          q_project_id: 'q_p99',
          bootstrapped: true,
        }), {
          status:  200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ message: 'not found' }), {
        status:  404,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    /** @type {[import('@modelcontextprotocol/sdk/shared/transport.js').Transport, import('@modelcontextprotocol/sdk/shared/transport.js').Transport]} */
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    mcpServer = createMcpServer()
    await mcpServer.connect(serverTransport)
    client = new Client({ name: 'self-serve-test', version: '1.0.0' })
    await client.connect(clientTransport)
  })

  afterEach(async () => {
    try { await client?.close() } catch { /* ignore cleanup errors */ }
    try { await mcpServer?.close() } catch { /* ignore cleanup errors */ }
    vi.unstubAllGlobals()
    _resetGatewayClient()
    delete process.env.QUORUM_GATEWAY_URL
    delete process.env.QUORUM_PROJECT_ID
    delete process.env.QUORUM_CONFIG_PATH
  })

  it('registers authenticate with no required project_id', async () => {
    /** @type {Awaited<ReturnType<Client['listTools']>>} */
    const listed = await client.listTools()
    /** @type {object | undefined} */
    const authenticate = listed.tools.find((tool) => tool.name === 'authenticate')

    expect(authenticate).toBeDefined()
    expect(authenticate.inputSchema.required ?? []).not.toContain('project_id')
  })

  it('uploads the first project without project context', async () => {
    /** @type {string} */
    const configPath = join(tmpdir(), `team-x-${Date.now()}.quorum.json`)
    writeFileSync(configPath, JSON.stringify({
      group_id: 'team-x',
      owner:    'new-user',
      members: [{
        name:               'New User',
        github_username:    'new-user',
        role:               'principal_architect',
        team:               'platform',
        base_confidence:    0.9,
      }],
      roles: {
        principal_architect: { base_confidence: 0.9 },
      },
      domains: {},
      thresholds: {
        conflict_threshold:  0.85,
        authority_threshold: 0.2,
      },
    }))

    /** @type {Awaited<ReturnType<Client['callTool']>>} */
    const response = await client.callTool({
      name:      'config_upload',
      arguments: { config_path: configPath },
    })
    /** @type {Record<string, unknown>} */
    const result = JSON.parse(response.content[0].text)

    expect(response.isError).not.toBe(true)
    expect(result.status).toBe('onboarded')
    expect(result.project_id).toBe('team-x')
    expect(result.q_project_id).toBe('q_p99')
    expect(uploads).toHaveLength(1)
    expect(uploads[0].headers.Authorization).toBe(`Bearer ${runtimeToken}`)
    expect(uploads[0].headers['X-Quorum-Project']).toBeUndefined()
    expect(uploads[0].body.group_id).toBe('team-x')
  })
})
