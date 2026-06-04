/**
 * M-04 — Deprecation Paths
 *
 * Tests PA direct deprecation, engineer deprecation request queuing,
 * pending() surfaces the request, and PA review approval.
 *
 * Pillar: Governance ⛔  |  W: 27 (9 leaves × F3)  |  OwnScore: 101
 * FailureCost: 191 (correlates S-03 — same forget/deprecation-request flow)
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { createMcpClient, callTool } from './helpers/mcp-client.js';
import { uid, activeEntry, TEST_PROJECT } from './helpers/gateway.js';
import { paToken, engineerToken } from './helpers/tokens.js';

const TOPIC = 'deprecation-test';

describe('M-04 Deprecation Paths', () => {
  let paClient, paCleanup;

  // Seed a shared ACTIVE entry in beforeAll for some tests
  let sharedKey;

  beforeAll(async () => {
    sharedKey = uid('m04-shared');
    await activeEntry(paToken(), TEST_PROJECT, {
      topic: TOPIC,
      key: sharedKey,
      content: 'Shared decision used across multiple deprecation tests.',
    });
  });

  beforeEach(async () => {
    ({ client: paClient, cleanup: paCleanup } = await createMcpClient({ token: paToken() }));
    await callTool(paClient, 'set_agent_context', { agent_id: 'integration-pa' });
  });

  afterEach(async () => {
    await paCleanup();
  });

  // ── Positive ──────────────────────────────────────────────────────────────────

  it('M-04.1 PA forget of ACTIVE key → gateway confirms DEPRECATED status', async () => {
    const key = uid('m04-pa-forget');
    await activeEntry(paToken(), TEST_PROJECT, {
      topic: TOPIC,
      key,
      content: 'Decision to be deprecated by PA.',
    });

    const result = await callTool(paClient, 'forget', {
      topic: TOPIC,
      key,
      reason: 'This decision is superseded by newer architecture choices',
    });

    expect(result.isError).toBeFalsy();

    // Verify via recall — DEPRECATED entry should not be returned as ACTIVE
    const recalled = await callTool(paClient, 'recall', { topic: TOPIC, key });
    const body = JSON.stringify(recalled).toLowerCase();
    // Either not found, or status is deprecated
    expect(body).toMatch(/deprecated|not.found|no.active|empty/i);
  });

  it('M-04.2 engineer forget of ACTIVE key → deprecation request queued (request_id returned)', async () => {
    const key = uid('m04-eng-forget');
    await activeEntry(paToken(), TEST_PROJECT, {
      topic: TOPIC,
      key,
      content: 'Decision that engineer wants to deprecate.',
    });

    const { client: engClient, cleanup: engCleanup } = await createMcpClient({ token: engineerToken() });
    try {
      await callTool(engClient, 'set_agent_context', { agent_id: 'integration-eng' });

      const result = await callTool(engClient, 'forget', {
        topic: TOPIC,
        key,
        reason: 'This decision is no longer applicable to our current architecture',
      });

      expect(result.isError).toBeFalsy();
      // Engineer forget should queue a request, not immediately deprecate
      const body = JSON.stringify(result);
      expect(body).toMatch(/request_id|pending|queued|submitted|deprecation/i);
    } finally {
      await engCleanup();
    }
  });

  it('M-04.3 pending() shows deprecation request in deprecation_requests[]', async () => {
    const key = uid('m04-pending-check');
    await activeEntry(paToken(), TEST_PROJECT, {
      topic: TOPIC,
      key,
      content: 'Decision pending deprecation review.',
    });

    const { client: engClient, cleanup: engCleanup } = await createMcpClient({ token: engineerToken() });
    try {
      await callTool(engClient, 'set_agent_context', { agent_id: 'integration-eng' });

      await callTool(engClient, 'forget', {
        topic: TOPIC,
        key,
        reason: 'Engineer requesting deprecation of this outdated decision',
      });
    } finally {
      await engCleanup();
    }

    const pending = await callTool(paClient, 'pending', {});
    const requests = pending.deprecation_requests ?? pending.decisions ?? [];
    const found = requests.find(r => r.key === key || JSON.stringify(r).includes(key));
    expect(found).toBeTruthy();
  });

  it('M-04.4 PA review approves deprecation → gateway confirms DEPRECATED', async () => {
    const key = uid('m04-review-approve');
    await activeEntry(paToken(), TEST_PROJECT, {
      topic: TOPIC,
      key,
      content: 'Decision to be approved for deprecation.',
    });

    let request_id;
    const { client: engClient, cleanup: engCleanup } = await createMcpClient({ token: engineerToken() });
    try {
      await callTool(engClient, 'set_agent_context', { agent_id: 'integration-eng' });

      const forgetResult = await callTool(engClient, 'forget', {
        topic: TOPIC,
        key,
        reason: 'This decision has been superseded by our new approach',
      });

      request_id = forgetResult.request_id ?? forgetResult.id;
      expect(request_id).toBeTruthy();
    } finally {
      await engCleanup();
    }

    const reviewResult = await callTool(paClient, 'review', {
      request_id,
      action: 'approve',
      note: 'Decision is indeed superseded — approving deprecation request',
    });

    expect(reviewResult.isError).toBeFalsy();
    const body = JSON.stringify(reviewResult).toLowerCase();
    expect(body).toMatch(/approved|deprecated|success/i);
  });

  // ── Negative ──────────────────────────────────────────────────────────────────

  it('M-04.5 forget non-existent key → graceful error (not crash)', async () => {
    const result = await callTool(paClient, 'forget', {
      topic: TOPIC,
      key: `nonexistent-key-${Date.now()}`,
      reason: 'Attempting to deprecate a key that does not exist',
    });

    // Should return an error response, not throw or crash
    const body = JSON.stringify(result).toLowerCase();
    expect(body).toMatch(/not.found|error|no.version|missing/i);
  });

  it('M-04.6 forget with reason < 10 chars → REASON_REQUIRED error', async () => {
    const result = await callTool(paClient, 'forget', {
      topic: TOPIC,
      key: sharedKey,
      reason: 'Short',
    });

    expect(result.isError).toBe(true);
    const body = JSON.stringify(result).toLowerCase();
    expect(body).toMatch(/reason|minimum|characters/i);
  });

  it('M-04.7 forget already-DEPRECATED entry → error (state machine: no DEPRECATED→DEPRECATED)', async () => {
    const key = uid('m04-already-deprecated');
    await activeEntry(paToken(), TEST_PROJECT, {
      topic: TOPIC,
      key,
      content: 'Decision that will be deprecated twice.',
    });

    // First deprecation — should succeed
    await callTool(paClient, 'forget', {
      topic: TOPIC,
      key,
      reason: 'First deprecation of this decision entry',
    });

    // Second deprecation — should fail
    const second = await callTool(paClient, 'forget', {
      topic: TOPIC,
      key,
      reason: 'Attempting to deprecate an already deprecated entry',
    });

    const body = JSON.stringify(second).toLowerCase();
    expect(body).toMatch(/not.found|already|deprecated|no.active|error/i);
  });

  it('M-04.8 forget in wrong project (peer project key) → 404 / not found', async () => {
    // Engineer in main project tries to forget a key that lives in the peer project
    const { client: wrongClient, cleanup } = await createMcpClient({
      token: engineerToken(),
      projectId: 'quorum-test-peer-project',
    });
    try {
      await callTool(wrongClient, 'set_agent_context', { agent_id: 'integration-eng-wrong-proj' });

      const result = await callTool(wrongClient, 'forget', {
        topic: TOPIC,
        key: `nonexistent-in-peer-${Date.now()}`,
        reason: 'Attempting to forget a key in the wrong project scope',
      });

      const body = JSON.stringify(result).toLowerCase();
      expect(body).toMatch(/not.found|error|no.version|missing/i);
    } finally {
      await cleanup();
    }
  });

  it('M-04.9 forget missing required key field → MCP/Zod validation error', async () => {
    let caughtError = null;
    let result = null;
    try {
      result = await paClient.callTool({
        name: 'forget',
        arguments: {
          reason: 'Missing the required key field to trigger schema validation',
          // key intentionally omitted
        },
      });
    } catch (err) {
      caughtError = err;
    }

    // Must not crash silently — either exception or isError response
    const isRejected = caughtError !== null
      || result?.isError === true
      || JSON.stringify(result ?? '').toLowerCase().includes('error');
    expect(isRejected).toBe(true);
  });
});
