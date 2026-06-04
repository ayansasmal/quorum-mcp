/**
 * MCP client factory for integration tests.
 *
 * Creates a real MCP client + server pair via InMemoryTransport — no stdio,
 * no process spawning. The full JSON-RPC protocol (schema validation, argument
 * coercion, content block format) is exercised in-process against the real
 * tool handlers, which call the real gateway over HTTP.
 *
 * Per-test isolation:
 *   - A fresh McpServer + InMemoryTransport pair is created per test.
 *   - _resetGatewayClient() clears the singleton between tests so token /
 *     URL changes take effect.
 *   - QUORUM_PROJECT_ID env var is set before connecting; resolveCtx() path 3
 *     picks it up when listRoots() returns empty (InMemoryTransport client
 *     doesn't implement roots/list).
 *   - loadConfig() is called with QUORUM_CONFIG_PATH pointing to the matching
 *     fixture file so getConfig() returns valid project data (members, globals,
 *     is_global) inside tool handlers without needing S3 or @aws-sdk/client-s3.
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/server.js';
import { setGatewayToken, setGatewayProfile, getGatewayToken, getGatewayProfile, _resetGatewayClient } from '../../../src/gateway/client.js';
import { loadConfig, getConfig, stopConfigPoller } from '../../../src/config/loader.js';
import { _resetAgentCtx } from '../../../src/tools/set-agent-context.js';

/** Decode the payload of a JWT without verifying signature — tests only. */
function jwtSub(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')).sub;
  } catch { return null; }
}

const __dir        = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dir, '../../../../quorum/tests/e2e/fixtures');

export const TEST_PROJECT  = 'quorum-test-project';
export const PEER_PROJECT  = 'quorum-test-peer-project';

/**
 * Create a connected MCP client wired to a fresh server instance.
 *
 * Sets QUORUM_GATEWAY_URL + QUORUM_PROJECT_ID env vars before connecting
 * so resolveCtx() can resolve the project via env fallback (path 3).
 * Loads the matching .quorum.json fixture so getConfig() works inside tools.
 *
 * @param {{ token: string, projectId?: string }} opts
 * @returns {Promise<{ client: Client, cleanup: () => Promise<void> }>}
 */
export async function createMcpClient({ token, projectId } = {}) {
  // Snapshot current state so nested clients can restore it on cleanup.
  const savedToken   = getGatewayToken();
  const savedProfile = getGatewayProfile();

  _resetGatewayClient();
  _resetAgentCtx();
  setGatewayToken(token);

  const pid = projectId ?? TEST_PROJECT;
  process.env.QUORUM_GATEWAY_URL  = process.env.QUORUM_GATEWAY_URL ?? 'http://localhost:3001';
  process.env.QUORUM_PROJECT_ID   = pid;

  // Load project config from fixture so getConfig() inside tool handlers returns
  // accurate data (is_global, globals, members) without S3 or AWS SDK.
  stopConfigPoller();
  const fixturePath = resolve(FIXTURES_DIR, `${pid}.quorum.json`);
  if (existsSync(fixturePath)) {
    process.env.QUORUM_CONFIG_PATH = fixturePath;
  } else {
    delete process.env.QUORUM_CONFIG_PATH;
  }
  await loadConfig();

  // Inject the member's role from the fixture config as the runtime profile.
  // In production, authenticate() does this via the gateway token exchange.
  // Without this, getIdentity() returns role: null and all users take the
  // non-PA branch in tools like forget.js.
  const sub = jwtSub(token);
  const cfg = getConfig();
  const member = sub && cfg?.members?.find(m => m.github_username === sub);
  setGatewayProfile(member
    ? { role: member.role, team: member.team ?? 'platform', base_confidence: member.base_confidence ?? 0.7 }
    : null
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpServer = createMcpServer();
  await mcpServer.connect(serverTransport);

  const client = new Client({ name: 'integration-test-runner', version: '1.0.0' });
  await client.connect(clientTransport);

  return {
    client,
    cleanup: async () => {
      try { await client.close(); } catch { /* ignore */ }
      // Restore the token/profile that were active before this client was created.
      // This prevents nested createMcpClient() calls (e.g. inline engClient inside
      // a paClient test) from permanently overwriting the outer client's identity.
      if (savedToken !== null) {
        setGatewayToken(savedToken);
        setGatewayProfile(savedProfile);
      }
    },
  };
}

/**
 * Call an MCP tool and return the parsed JSON response.
 *
 * All Quorum tools return `content[0].text` as JSON. This helper handles the
 * unwrap so tests can assert directly on the result object.
 *
 * @param {Client} client
 * @param {string} name - Tool name (e.g. 'remember', 'recall')
 * @param {object} args - Tool arguments
 * @returns {Promise<{ isError?: boolean, [key: string]: any }>}
 */
export async function callTool(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
  const text = response?.content?.[0]?.text;
  if (!text) return response;
  try {
    return { ...JSON.parse(text), isError: response.isError };
  } catch {
    return { raw: text, isError: response.isError };
  }
}
