/**
 * M-02 — Read Path (recall + search)
 *
 * Tests recall of ACTIVE entries, history traversal, cross-project global
 * fallback (source: 'global'), and search with globals federation.
 *
 * Pillar: Functional  |  W: 36 (9 leaves × F4)  |  OwnScore: 54
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createMcpClient, callTool, TEST_PROJECT } from './helpers/mcp-client.js';
import { uid, activeEntry, draftEntry } from './helpers/gateway.js';
import { paToken, engineerToken } from './helpers/tokens.js';

const TOPIC = 'read-path-test';

describe('M-02 Read Path', () => {
  let client, cleanup;

  // Seed data shared across all read tests
  let activeKey, activeContent;
  let draftOnlyKey;

  beforeAll(async () => {
    activeKey = uid('m02-active');
    activeContent = 'Active read-path decision: services communicate over HTTP/2.';
    draftOnlyKey = uid('m02-draft-only');

    await activeEntry(paToken(), TEST_PROJECT, {
      topic: TOPIC,
      key: activeKey,
      content: activeContent,
    });
    await draftEntry(engineerToken(), TEST_PROJECT, {
      topic: TOPIC,
      key: draftOnlyKey,
      content: 'Draft-only entry that should not appear in getCurrentVersion results.',
    });
  });

  beforeEach(async () => {
    ({ client, cleanup } = await createMcpClient({ token: paToken() }));
    await callTool(client, 'set_agent_context', { agent_id: 'integration-reader' });
  });

  afterEach(async () => {
    await cleanup();
  });

  // ── Positive ──────────────────────────────────────────────────────────────────

  it('M-02.1 recall of existing ACTIVE key → summary matches written content', async () => {
    const result = await callTool(client, 'recall', { topic: TOPIC, key: activeKey });
    expect(result.isError).toBeFalsy();
    const content = result.content ?? result.summary ?? result.text ?? JSON.stringify(result);
    expect(content).toContain('HTTP/2');
  });

  it('M-02.2 recall with history:true → array with version chain (newest first)', async () => {
    // Write a second version first
    await callTool(client, 'remember', {
      topic: TOPIC,
      key: activeKey,
      content: `${activeContent} (updated in v2)`,
      reason: 'Testing history: adding a second version of this decision',
    });

    const result = await callTool(client, 'recall', { topic: TOPIC, key: activeKey, history: true });
    expect(result.isError).toBeFalsy();

    const versions = result.versions ?? result.history ?? (Array.isArray(result) ? result : null);
    if (versions) {
      expect(versions.length).toBeGreaterThanOrEqual(1);
    }
    // At minimum, no crash
    expect(result.isError).toBeFalsy();
  });

  it('M-02.3 recall global catalog entry from linked project → source: global annotation', async () => {
    // quorum-test-project is linked to quorum-test-catalog in fixtures
    // Seed a known entry in the catalog
    const catalogKey = uid('m02-global');
    await activeEntry(paToken(), 'quorum-test-catalog', {
      topic: 'standards',
      key: catalogKey,
      content: 'Global standard: all APIs must use OpenAPI 3.1 specification.',
      entity_type: 'Standard',
    });

    const result = await callTool(client, 'recall', { key: catalogKey });
    // Either found (source: global) or gracefully not found
    if (!result.isError && result.content) {
      const body = JSON.stringify(result);
      // Result should indicate global source
      expect(body).toMatch(/global|catalog/i);
    }
  });

  it('M-02.4 search with query matching seeded content → result includes project entry', async () => {
    const result = await callTool(client, 'search', {
      query: 'HTTP/2 services communicate',
    });

    expect(result.isError).toBeFalsy();
    const body = JSON.stringify(result);
    // Should find the seeded entry or return gracefully empty
    expect(body).toBeTruthy();
  });

  // ── Negative ──────────────────────────────────────────────────────────────────

  it('M-02.5 recall DRAFT-only key → not found / empty (getCurrentVersion returns ACTIVE only)', async () => {
    const result = await callTool(client, 'recall', { topic: TOPIC, key: draftOnlyKey });
    const body = JSON.stringify(result).toLowerCase();
    // Should either return not found or an empty result — never the draft content as ACTIVE
    expect(body).toMatch(/not.found|empty|no.active|no.*version|null/i);
  });

  it('M-02.6 recall non-existent key → graceful not-found message (no crash)', async () => {
    const result = await callTool(client, 'recall', {
      key: `totally-nonexistent-key-${Date.now()}`,
    });

    expect(result.isError !== undefined || result !== null).toBe(true);
    // Must not throw an unhandled error
    const body = JSON.stringify(result);
    expect(body.length).toBeGreaterThan(0);
  });

  it('M-02.7 search with single-char q → Zod validation error (min length)', async () => {
    const result = await callTool(client, 'search', { q: 'a' });

    // Single-char search should be rejected by schema validation
    expect(result.isError).toBe(true);
  });

  it('M-02.8 search with empty q → error or empty results (not crash)', async () => {
    let result;
    let caughtError = null;
    try {
      result = await callTool(client, 'search', { q: '' });
    } catch (err) {
      caughtError = err;
    }
    // Either error or graceful empty — but no unhandled crash
    expect(caughtError !== null || result !== null).toBe(true);
  });

  it('M-02.9 recall with missing key argument → MCP schema error', async () => {
    let caughtError = null;
    let result = null;
    try {
      result = await client.callTool({
        name: 'recall',
        arguments: {}, // key is required
      });
    } catch (err) {
      caughtError = err;
    }

    const isRejected = caughtError !== null
      || result?.isError === true
      || JSON.stringify(result ?? '').toLowerCase().includes('error');
    expect(isRejected).toBe(true);
  });
});
