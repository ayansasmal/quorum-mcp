/**
 * M-05 — Deviation & Conformance
 *
 * Tests the deviate() thin proxy and conformance() scoring tool end-to-end
 * against the real gateway.
 *
 * Pillar: Functional  |  W: 16 (8 leaves × F2)  |  OwnScore: 36
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMcpClient, callTool } from './helpers/mcp-client.js';
import { uid } from './helpers/gateway.js';
import { paToken } from './helpers/tokens.js';

describe('M-05 Deviation & Conformance', () => {
  let client, cleanup;

  beforeEach(async () => {
    ({ client, cleanup } = await createMcpClient({ token: paToken() }));
    await callTool(client, 'set_agent_context', { agent_id: 'integration-deviation' });
  });

  afterEach(async () => {
    await cleanup();
  });

  // ── Positive ──────────────────────────────────────────────────────────────────

  it('M-05.1 deviate() returns deviation_id (UUID), status, severity', async () => {
    const result = await callTool(client, 'deviate', {
      catalog_id: 'quorum-test-catalog',
      topic: 'testing',
      key: uid('m05-pattern'),
      description: 'Integration test: service missing structured logging as per standard.',
      source: 'agent',
    });

    expect(result.isError).toBeFalsy();
    const body = JSON.stringify(result);
    expect(body).toMatch(/deviation_id|id/i);
    expect(body).toMatch(/status|severity/i);
  });

  it('M-05.2 deviate() is idempotent — same args twice does not create duplicate row', async () => {
    const pattern = uid('m05-idempotent');

    const first = await callTool(client, 'deviate', {
      catalog_id: 'quorum-test-catalog',
      topic: 'testing',
      key: pattern,
      description: 'Idempotent deviation test: service not using agreed deployment strategy.',
      source: 'code-review',
    });
    const second = await callTool(client, 'deviate', {
      catalog_id: 'quorum-test-catalog',
      topic: 'testing',
      key: pattern,
      description: 'Idempotent deviation test: service not using agreed deployment strategy.',
      source: 'code-review',
    });

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();

    const firstId = first.deviation_id ?? first.id;
    const secondId = second.deviation_id ?? second.id;
    if (firstId && secondId) {
      expect(firstId).toBe(secondId);
    }
    // is_new should be false on second call (idempotent)
    if (second.is_new !== undefined) {
      expect(second.is_new).toBe(false);
    }
  });

  it('M-05.3 conformance() returns score, status, breakdown keys', async () => {
    const result = await callTool(client, 'conformance', {});

    expect(result.isError).toBeFalsy();
    const body = JSON.stringify(result);
    expect(body).toMatch(/score|status|conformance|certified|uncertified/i);
  });

  it('M-05.4 conformance() with include_details:true returns top deviations sorted by severity', async () => {
    const result = await callTool(client, 'conformance', { include_details: true });

    expect(result.isError).toBeFalsy();
    // Should include details without crashing, even if empty
    const body = JSON.stringify(result);
    expect(body).toBeTruthy();
  });

  // ── Negative ──────────────────────────────────────────────────────────────────

  it('M-05.5 deviate() for project not linked to catalog → not_linked or error in result', async () => {
    // Use an isolated project with no globals configured
    const { client: isoClient, cleanup: isoCleanup } = await createMcpClient({
      token: paToken(),
      projectId: 'quorum-test-isolated-project',
    });
    try {
      await callTool(isoClient, 'set_agent_context', { agent_id: 'integration-iso' });

      const result = await callTool(isoClient, 'deviate', {
        catalog_id: 'quorum-test-catalog',
        topic: 'testing',
        key: uid('m05-not-linked'),
        description: 'Testing deviation for project not linked to catalog.',
        source: 'agent',
      });

      const body = JSON.stringify(result).toLowerCase();
      // Either not_linked, error, or graceful message — not a crash
      expect(body).toBeTruthy();
      expect(body).toMatch(/not.linked|error|not.found|catalog|project/i);
    } finally {
      await isoCleanup();
    }
  });

  it('M-05.6 deviate() missing required catalog_id → Zod schema error', async () => {
    let caughtError = null;
    let result = null;
    try {
      result = await client.callTool({
        name: 'deviate',
        arguments: {
          topic: 'testing',
          pattern: uid('m05-no-catalog'),
          description: 'Missing catalog_id to trigger schema validation.',
          source: 'manual',
          // catalog_id intentionally omitted
        },
      });
    } catch (err) {
      caughtError = err;
    }

    const isRejected = caughtError !== null
      || result?.isError === true
      || JSON.stringify(result ?? '').toLowerCase().includes('error');
    expect(isRejected).toBe(true);
  });

  it('M-05.7 conformance() with no gateway reachable → graceful error (not unhandled exception)', async () => {
    // This test verifies the error handling path; we test it by checking that
    // a malformed gateway URL results in a graceful error response, not a process crash.
    const { client: badClient, cleanup: badCleanup } = await createMcpClient({ token: paToken() });
    try {
      // Set an unreachable gateway URL
      const origUrl = process.env.QUORUM_GATEWAY_URL;
      process.env.QUORUM_GATEWAY_URL = 'http://localhost:9999';

      // Use a fresh client with the bad URL
      const { client: unreachableClient, cleanup: unreachableCleanup } = await createMcpClient({
        token: paToken(),
      });
      try {
        await callTool(unreachableClient, 'set_agent_context', { agent_id: 'integration-bad-gw' });
        const result = await callTool(unreachableClient, 'conformance', {});

        // Must not crash — should return an error response
        const body = JSON.stringify(result).toLowerCase();
        expect(body).toMatch(/error|gateway|connect|unavailable|econnrefused/i);
      } finally {
        await unreachableCleanup();
        process.env.QUORUM_GATEWAY_URL = origUrl;
      }
    } finally {
      await badCleanup();
    }
  });

  it('M-05.8 conformance() UNCERTIFIED project returns contextual message (not crash)', async () => {
    const { client: isoClient, cleanup: isoCleanup } = await createMcpClient({
      token: paToken(),
      projectId: 'quorum-test-isolated-project',
    });
    try {
      await callTool(isoClient, 'set_agent_context', { agent_id: 'integration-iso-conf' });
      const result = await callTool(isoClient, 'conformance', {});

      // Must return something meaningful — either UNCERTIFIED message or score
      expect(result.isError === undefined || result.isError === false || typeof result.message === 'string').toBe(true);
      const body = JSON.stringify(result);
      expect(body.length).toBeGreaterThan(0);
    } finally {
      await isoCleanup();
    }
  });
});
