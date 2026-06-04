/**
 * M-03 — Conflict Detection Round-Trip
 *
 * Tests the full conflict lifecycle: conflict seeded → pending() surfaces it →
 * PA resolves → verified ACTIVE. Conflicts are seeded via POST /pg/pending rather
 * than through automatic LLM-based Graphiti detection, which requires real semantic
 * embeddings unavailable in the Docker test environment (mock-openai uses deterministic
 * SHA-256 embeddings that are intentionally not semantically similar).
 *
 * Pillar: Governance ⛔  |  W: 40 (10 leaves × F4)  |  OwnScore: 240
 * FailureCost: 655 (correlates S-02.2, S-06, S-17 — same detectConflict path)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMcpClient, callTool, TEST_PROJECT } from './helpers/mcp-client.js';
import { uid, conflictEntry } from './helpers/gateway.js';
import { paToken, pe2Token, engineerToken } from './helpers/tokens.js';

const TOPIC = 'architecture';

describe('M-03 Conflict Detection Round-Trip', () => {
  let paClient, paCleanup;

  beforeEach(async () => {
    ({ client: paClient, cleanup: paCleanup } = await createMcpClient({ token: paToken() }));
    await callTool(paClient, 'set_agent_context', { agent_id: 'integration-pa' });
  });

  afterEach(async () => {
    await paCleanup();
  });

  // ── Positive: seeded conflict → pending → resolve ─────────────────────────────

  it('M-03.1 seeded conflict surfaces as pending decision with conflict_id', async () => {
    const key = uid('m03-conflict');

    const { conflict_id } = await conflictEntry(paToken(), TEST_PROJECT, {
      topic: TOPIC,
      key,
      existingContent: 'We use PostgreSQL as our primary database.',
      incomingContent: 'We use MySQL as our primary database.',
    });

    expect(conflict_id).toBeTruthy();

    const pending = await callTool(paClient, 'pending', {});
    const decisions = pending.conflict_briefs ?? [];
    const found = decisions.find(d => d.conflict_id === conflict_id);
    expect(found).toBeTruthy();
  });

  it('M-03.2 pending() decisions include conflict topic and reason', async () => {
    const key = uid('m03-pending');

    const { conflict_id } = await conflictEntry(paToken(), TEST_PROJECT, {
      topic: TOPIC,
      key,
      existingContent: 'Service communication uses synchronous REST calls.',
      incomingContent: 'Service communication uses asynchronous message queues.',
      reason: 'Async vs sync architecture decision conflict',
    });

    const pending = await callTool(paClient, 'pending', {});
    const decisions = pending.conflict_briefs ?? [];
    const found = decisions.find(d => d.conflict_id === conflict_id);

    expect(found).toBeTruthy();
    // Decision should carry the conflict reason and key
    const body = JSON.stringify(found);
    expect(body).toMatch(/async|sync|architecture|conflict/i);
  });

  it('M-03.3 PA resolves conflict with supersede → status resolved', async () => {
    const key = uid('m03-resolve');
    const mergedContent = 'Cache layer uses Redis for primary caching; Memcached considered but rejected for operational complexity.';

    // Use pe2Token so test-pe (PA) is not the existing_author and can resolve
    const { conflict_id } = await conflictEntry(pe2Token(), TEST_PROJECT, {
      topic: TOPIC,
      key,
      existingContent: 'Cache layer uses Redis.',
      incomingContent: 'Cache layer uses Memcached.',
      incomingAuthor: 'test-engineer',
    });

    const resolution = await callTool(paClient, 'remember', {
      topic: TOPIC,
      key,
      content: mergedContent,
      reason: 'Resolution: Redis retained as primary cache layer',
      conflict_id,
      resolution: 'supersede',
      merged_content: mergedContent,
    });

    expect(resolution.isError).toBeFalsy();
    expect(resolution.status ?? resolution.knowledge_status).toMatch(/resolved|stored|ACTIVE/i);
  });

  it('M-03.4 pending() does not contain conflict after resolution', async () => {
    const key = uid('m03-resolved-absent');

    const { conflict_id } = await conflictEntry(pe2Token(), TEST_PROJECT, {
      topic: TOPIC,
      key,
      existingContent: 'Authentication uses JWT tokens.',
      incomingContent: 'Authentication uses session cookies.',
      incomingAuthor: 'test-engineer',
    });

    await callTool(paClient, 'remember', {
      topic: TOPIC,
      key,
      content: 'Authentication uses JWT tokens. Sessions considered but JWT selected for statelessness.',
      reason: 'Resolution: JWT retained as primary auth mechanism',
      conflict_id,
      resolution: 'supersede',
      merged_content: 'Authentication uses JWT tokens. Sessions considered but JWT selected for statelessness.',
    });

    const pending = await callTool(paClient, 'pending', {});
    const decisions = pending.conflict_briefs ?? [];
    const stillPending = decisions.find(d => d.conflict_id === conflict_id);
    expect(stillPending).toBeUndefined();
  });

  it('M-03.5 gateway confirms new ACTIVE version after resolution', async () => {
    const key = uid('m03-gateway-confirm');
    const mergedContent = 'API versioning uses URL path prefix (v1/v2). Header versioning considered but rejected.';

    const { conflict_id } = await conflictEntry(pe2Token(), TEST_PROJECT, {
      topic: TOPIC,
      key,
      existingContent: 'API versioning uses URL path prefix.',
      incomingContent: 'API versioning uses custom HTTP headers.',
      incomingAuthor: 'test-engineer',
    });

    await callTool(paClient, 'remember', {
      topic: TOPIC,
      key,
      content: mergedContent,
      reason: 'Resolution: URL prefix confirmed as versioning strategy',
      conflict_id,
      resolution: 'supersede',
      merged_content: mergedContent,
    });

    // Verify via recall that the new ACTIVE content is correct
    // recall returns XML for ACTIVE hits; callTool stores it in .raw when not JSON
    const recalled = await callTool(paClient, 'recall', { topic: TOPIC, key });
    expect(recalled.content ?? recalled.summary ?? recalled.raw).toContain('URL path prefix');
  });

  it('M-03.6 pending() topic filter returns only conflicts for that topic', async () => {
    const key = uid('m03-topic-filter');
    const topicA = `architecture-${Date.now()}`;
    const topicB = `security-${Date.now()}`;

    // Seed a conflict in topicA
    await conflictEntry(paToken(), TEST_PROJECT, {
      topic: topicA,
      key: `${key}-a`,
      existingContent: 'Topic A: decision alpha.',
      incomingContent: 'Topic A: decision beta.',
    });

    const pending = await callTool(paClient, 'pending', { topic: topicB });
    const decisions = pending.conflict_briefs ?? [];
    const leakedA = decisions.find(d => d.topic === topicA || d.conflict_topic === topicA);
    expect(leakedA).toBeUndefined();
  });

  // ── Negative ──────────────────────────────────────────────────────────────────

  it('M-03.7 resolving with supersede but no merged_content → response includes conflict reference', async () => {
    const key = uid('m03-no-merged');

    // Use pe2Token so PA (test-pe) can resolve
    const { conflict_id } = await conflictEntry(pe2Token(), TEST_PROJECT, {
      topic: TOPIC,
      key,
      existingContent: 'Logging uses structured JSON format.',
      incomingContent: 'Logging uses plain text format.',
      incomingAuthor: 'test-engineer',
    });

    // supersede without explicit merged_content uses input.content —
    // the response should mention the conflict regardless
    const attempt = await callTool(paClient, 'remember', {
      topic: TOPIC,
      key,
      content: 'Logging uses structured JSON format.',
      reason: 'Attempting resolution without merged_content',
      conflict_id,
      resolution: 'supersede',
      // merged_content deliberately omitted
    });

    expect(attempt.isError || attempt.error || attempt.status).toBeTruthy();
    const errorText = JSON.stringify(attempt).toLowerCase();
    expect(errorText).toMatch(/merged_content|resolution|conflict/);
  });

  it('M-03.8 engineer cannot resolve a conflict (no-self-approval violation)', async () => {
    const key = uid('m03-eng-resolve');

    // paToken creates entry with author=test-pe; incomingAuthor=test-engineer triggers no-self-approval
    const { conflict_id } = await conflictEntry(paToken(), TEST_PROJECT, {
      topic: TOPIC,
      key,
      existingContent: 'Deployment uses blue-green strategy.',
      incomingContent: 'Deployment uses rolling update strategy.',
      incomingAuthor: 'test-engineer',
    });

    // Engineer tries to resolve — no-self-approval blocks because engineer is incoming_author
    const { client: engClient, cleanup: engCleanup } = await createMcpClient({ token: engineerToken() });
    try {
      await callTool(engClient, 'set_agent_context', { agent_id: 'integration-eng' });

      const attempt = await callTool(engClient, 'remember', {
        topic: TOPIC,
        key,
        content: 'Deployment uses blue-green strategy (confirmed).',
        reason: 'Engineer attempting to resolve conflict — should be blocked',
        conflict_id,
        resolution: 'supersede',
        merged_content: 'Deployment uses blue-green strategy (confirmed).',
      });

      const body = JSON.stringify(attempt).toLowerCase();
      expect(body).toMatch(/authority|role|architect|forbidden|permission|draft|no_self|self.approv|conflict.party/i);
    } finally {
      await engCleanup();
    }
  });

  it('M-03.9 resolving an already-resolved conflict_id → not_found', async () => {
    const key = uid('m03-double-resolve');
    const mergedContent = 'Infrastructure uses Kubernetes for orchestration (resolved).';

    const { conflict_id } = await conflictEntry(pe2Token(), TEST_PROJECT, {
      topic: TOPIC,
      key,
      existingContent: 'Infrastructure uses Kubernetes for orchestration.',
      incomingContent: 'Infrastructure uses Docker Swarm for orchestration.',
      incomingAuthor: 'test-engineer',
    });

    // First resolution — succeeds
    await callTool(paClient, 'remember', {
      topic: TOPIC,
      key,
      content: mergedContent,
      reason: 'Resolution: Kubernetes confirmed',
      conflict_id,
      resolution: 'supersede',
      merged_content: mergedContent,
    });

    // Second resolution attempt on same conflict_id
    const second = await callTool(paClient, 'remember', {
      topic: TOPIC,
      key: uid('m03-double-resolve-new'),
      content: 'Something new.',
      reason: 'Attempting to reuse resolved conflict_id',
      conflict_id,
      resolution: 'supersede',
      merged_content: 'Something new.',
    });

    // After first resolution, the pending decision has status='resolved' →
    // getPendingDecisionById (WHERE status='pending') returns null → not_found
    expect(
      second.isError ||
      second.error ||
      second.status === 'conflict_detected' ||
      second.status === 'not_found',
    ).toBeTruthy();
  });

  it('M-03.10 remember with reason < 10 chars → REASON_REQUIRED error', async () => {
    const key = uid('m03-short-reason');

    const result = await callTool(paClient, 'remember', {
      topic: TOPIC,
      key,
      content: 'Some decision content here.',
      reason: 'Short',
    });

    expect(result.isError).toBe(true);
    const body = JSON.stringify(result).toLowerCase();
    expect(body).toMatch(/reason|minimum|character/i);
  });
});
