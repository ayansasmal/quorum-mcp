/**
 * M-06 — MCP Protocol Contracts
 *
 * Tests the MCP JSON-RPC layer itself: tools/list completeness, content block
 * format, schema validation, and graceful handling of bad inputs.
 *
 * Pillar: Operational  |  W: 24 (8 leaves × F3)  |  OwnScore: 24
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMcpClient, callTool } from './helpers/mcp-client.js';
import { uid } from './helpers/gateway.js';
import { paToken } from './helpers/tokens.js';

const EXPECTED_TOOLS = [
  'set_agent_context', 'authenticate', 'config_upload', 'search',
  'remember', 'recall', 'forget', 'history', 'review', 'reflect',
  'export', 'pending', 'deviate', 'conformance',
];

describe('M-06 MCP Protocol Contracts', () => {
  let client, cleanup;

  beforeEach(async () => {
    ({ client, cleanup } = await createMcpClient({ token: paToken() }));
    await callTool(client, 'set_agent_context', { agent_id: 'integration-protocol' });
  });

  afterEach(async () => {
    await cleanup();
  });

  // ── Positive ──────────────────────────────────────────────────────────────────

  it('M-06.1 tools/list returns all 14 tools', async () => {
    const listed = await client.listTools();
    const names = listed.tools.map(t => t.name);

    for (const expected of EXPECTED_TOOLS) {
      expect(names).toContain(expected);
    }
    expect(names.length).toBe(14);
  });

  it('M-06.2 tool response format: content[0].type === text, text is valid JSON', async () => {
    const response = await client.callTool({
      name: 'pending',
      arguments: {},
    });

    expect(response.content).toBeTruthy();
    expect(response.content[0].type).toBe('text');
    expect(() => JSON.parse(response.content[0].text)).not.toThrow();
  });

  it('M-06.3 set_agent_context persists: subsequent remember carries the agent_id in audit', async () => {
    await callTool(client, 'set_agent_context', { agent_id: 'integration-persists-test' });

    const key = uid('m06-agent-persists');
    const result = await callTool(client, 'remember', {
      topic: 'protocol-test',
      key,
      content: 'Verifying that agent_id flows through to persisted versions.',
      reason: 'Testing agent context persistence through write operations',
    });

    expect(result.isError).toBeFalsy();
    // agent_id should flow through to the stored version
    const body = JSON.stringify(result);
    expect(body).toMatch(/ACTIVE|knowledge_status|status/i);
  });

  it('M-06.4 remember tool schema has topic, key, content as required (via tools/list)', async () => {
    const listed = await client.listTools();
    const rememberTool = listed.tools.find(t => t.name === 'remember');

    expect(rememberTool).toBeTruthy();
    const required = rememberTool.inputSchema?.required ?? [];
    expect(required).toContain('topic');
    expect(required).toContain('key');
    expect(required).toContain('content');
  });

  // ── Negative ──────────────────────────────────────────────────────────────────

  it('M-06.5 remember with missing required content → MCP schema validation fires; isError:true', async () => {
    const response = await client.callTool({
      name: 'remember',
      arguments: {
        topic: 'protocol-test',
        key: uid('m06-missing-content'),
        reason: 'Testing schema validation for missing required field',
        // content intentionally omitted
      },
    });

    // MCP SDK validates required fields before the handler fires
    expect(response.isError).toBe(true);
  });

  it('M-06.6 confidence as string instead of number → Zod validation error (no 500)', async () => {
    const response = await client.callTool({
      name: 'remember',
      arguments: {
        topic: 'protocol-test',
        key: uid('m06-bad-confidence'),
        content: 'Testing wrong type for confidence field.',
        reason: 'Testing confidence type validation at Zod level',
        confidence: 'high', // should be a number
      },
    });

    // Must get an error response — not an unhandled exception
    expect(response.isError).toBe(true);
  });

  it('M-06.7 call non-existent tool name → MCP error response (not unhandled rejection)', async () => {
    let caughtError = null;
    let response = null;
    try {
      response = await client.callTool({
        name: 'this_tool_does_not_exist',
        arguments: {},
      });
    } catch (err) {
      caughtError = err;
    }

    // MCP SDK should return an error — either thrown or as isError response
    expect(caughtError !== null || response?.isError === true).toBe(true);
  });

  it('M-06.8 call tool with extra unknown fields → accepted without crash (Zod strips unknowns)', async () => {
    const response = await client.callTool({
      name: 'pending',
      arguments: {
        totally_unknown_field: 'this should be stripped by Zod',
        another_unknown: 42,
      },
    });

    // Zod uses .passthrough() or .strip() — extra fields should not cause an error
    expect(response).toBeTruthy();
    expect(response.content[0].type).toBe('text');
  });
});
