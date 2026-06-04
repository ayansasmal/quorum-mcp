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
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/server.js';
import { setGatewayToken, _resetGatewayClient } from '../../../src/gateway/client.js';

export const TEST_PROJECT  = 'quorum-test-project';
export const PEER_PROJECT  = 'quorum-test-peer-project';

/**
 * Create a connected MCP client wired to a fresh server instance.
 *
 * Sets QUORUM_GATEWAY_URL + QUORUM_PROJECT_ID env vars before connecting
 * so resolveCtx() can resolve the project via env fallback (path 3).
 *
 * @param {{ token: string, projectId?: string }} opts
 * @returns {Promise<{ client: Client, cleanup: () => Promise<void> }>}
 */
export async function createMcpClient({ token, projectId } = {}) {
  _resetGatewayClient();
  setGatewayToken(token);

  process.env.QUORUM_GATEWAY_URL  = process.env.QUORUM_GATEWAY_URL ?? 'http://localhost:3001';
  process.env.QUORUM_PROJECT_ID   = projectId ?? TEST_PROJECT;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpServer = createMcpServer();
  await mcpServer.connect(serverTransport);

  const client = new Client({ name: 'integration-test-runner', version: '1.0.0' });
  await client.connect(clientTransport);

  return {
    client,
    cleanup: async () => {
      try { await client.close(); } catch { /* ignore */ }
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
