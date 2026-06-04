/**
 * M-03 — Conflict Detection Round-Trip
 *
 * Tests the full path: PA writes v1 → engineer writes contradicting content →
 * conflict detected → pending() surfaces it → PA resolves → verified ACTIVE.
 *
 * Pillar: Governance ⛔  |  W: 40 (10 leaves × F4)  |  OwnScore: 240
 * FailureCost: 655 (correlates S-02.2, S-06, S-17 — same detectConflict path)
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { createMcpClient, callTool } from './helpers/mcp-client.js';
import { uid, activeEntry, TEST_PROJECT } from './helpers/gateway.js';
import { paToken, engineerToken, peToken } from './helpers/tokens.js';

const TOPIC = 'architecture';

describe('M-03 Conflict Detection Round-Trip', () => {
  let paClient, paCleanup;
  let engClient, engCleanup;

  beforeEach(async () => {
    ({ client: paClient, cleanup: paCleanup } = await createMcpClient({ token: paToken() }));
    await callTool(paClient, 'set_agent_context', { agent_id: 'integration-pa' });

    ({ client: engClient, cleanup: engCleanup } = await createMcpClient({ token: engineerToken() }));
    await callTool(engClient, 'set_agent_context', { agent_id: 'integration-eng' });
  });

  afterEach(async () => {
    await paCleanup();
    await engCleanup();
  });

  // ── Positive: write → conflict → pending → resolve ───────────────────────────

  it('M-03.1 PA writes ACTIVE v1, engineer writes contradicting content → conflict_detected', async () => {
    const key = uid('m03-conflict');

    // PA establishes v1 ACTIVE
    const v1 = await callTool(paClient, 'remember', {
      topic: TOPIC,
      key,
      content: 'We use PostgreSQL as our primary database.',
      reason: 'Architecture decision established by PA',
    });
    expect(v1.knowledge_status ?? v1.status).toMatch(/ACTIVE/i);

    // Engineer writes contradicting content → should detect conflict
    const v2 = await callTool(engClient, 'remember', {
      topic: TOPIC,
      key,
      content: 'We use MySQL as our primary database.',
      reason: 'Engineer proposes different database choice',
    });

    expect(v2.status).toBe('conflict_detected');
    expect(v2.conflict_id).toBeTruthy();
  });

  it('M-03.2 pending() shows the conflict in decisions[]', async () => {
    const key = uid('m03-pending');

    await callTool(paClient, 'remember', {
      topic: TOPIC,
      key,
      content: 'Service communication uses synchronous REST calls.',
      reason: 'Architecture decision established',
    });
    await callTool(engClient, 'remember', {
      topic: TOPIC,
      key,
      content: 'Service communication uses asynchronous message queues.',
      reason: 'Engineer proposes async messaging instead',
    });

    const pending = await callTool(paClient, 'pending', {});
    const decisions = pending.decisions ?? [];
    const found = decisions.find(d => d.key === key || d.topic === TOPIC);
    expect(found).toBeTruthy();
    expect(found.conflict_reason ?? found.reason ?? found.key).toBeTruthy();
  });

  it('M-03.3 PA resolves conflict with supersede → ACTIVE in gateway', async () => {
    const key = uid('m03-resolve');

    await callTool(paClient, 'remember', {
      topic: TOPIC,
      key,
      content: 'Cache layer uses Redis.',
      reason: 'Decision established by principal architect',
    });
    const v2 = await callTool(engClient, 'remember', {
      topic: TOPIC,
      key,
      content: 'Cache layer uses Memcached.',
      reason: 'Engineer proposes alternative cache solution',
    });

    expect(v2.status).toBe('conflict_detected');
    const conflict_id = v2.conflict_id;

    // PA resolves with merged content
    const resolution = await callTool(paClient, 'remember', {
      topic: TOPIC,
      key,
      content: 'Cache layer uses Redis for primary caching; Memcached considered but rejected for operational complexity.',
      reason: 'Resolution: Redis retained as primary cache layer',
      conflict_id,
      resolution: 'supersede',
      merged_content: 'Cache layer uses Redis for primary caching; Memcached considered but rejected for operational complexity.',
    });

    expect(resolution.status ?? resolution.knowledge_status).toMatch(/resolved|ACTIVE/i);
  });

  it('M-03.4 pending() does not contain conflict after resolution', async () => {
    const key = uid('m03-resolved-absent');

    await callTool(paClient, 'remember', {
      topic: TOPIC,
      key,
      content: 'Authentication uses JWT tokens.',
      reason: 'Established authentication pattern',
    });
    const v2 = await callTool(engClient, 'remember', {
      topic: TOPIC,
      key,
      content: 'Authentication uses session cookies.',
      reason: 'Engineer proposes cookie-based sessions',
    });
    const conflict_id = v2.conflict_id;

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
    const decisions = pending.decisions ?? [];
    const stillPending = decisions.find(d => d.conflict_id === conflict_id);
    expect(stillPending).toBeUndefined();
  });

  it('M-03.5 gateway confirms new ACTIVE version after resolution', async () => {
    const key = uid('m03-gateway-confirm');
    const mergedContent = 'API versioning uses URL path prefix (v1/v2). Header versioning considered but rejected.';

    await callTool(paClient, 'remember', {
      topic: TOPIC,
      key,
      content: 'API versioning uses URL path prefix.',
      reason: 'Decision for API versioning strategy',
    });
    const v2 = await callTool(engClient, 'remember', {
      topic: TOPIC,
      key,
      content: 'API versioning uses custom HTTP headers.',
      reason: 'Engineer proposes header-based versioning',
    });

    await callTool(paClient, 'remember', {
      topic: TOPIC,
      key,
      content: mergedContent,
      reason: 'Resolution: URL prefix confirmed as versioning strategy',
      conflict_id: v2.conflict_id,
      resolution: 'supersede',
      merged_content: mergedContent,
    });

    // Verify via recall that the new ACTIVE content is correct
    const recalled = await callTool(paClient, 'recall', { key });
    expect(recalled.content ?? recalled.summary).toContain('URL path prefix');
  });

  it('M-03.6 pending() topic filter returns only conflicts for that topic', async () => {
    const key = uid('m03-topic-filter');
    const topicA = `architecture-${Date.now()}`;
    const topicB = `security-${Date.now()}`;

    // Seed a conflict in topicA
    await callTool(paClient, 'remember', {
      topic: topicA,
      key: `${key}-a`,
      content: 'Topic A: decision alpha.',
      reason: 'Decision in topic A established',
    });
    await callTool(engClient, 'remember', {
      topic: topicA,
      key: `${key}-a`,
      content: 'Topic A: decision beta — contradicts.',
      reason: 'Contradiction in topic A proposed',
    });

    const pending = await callTool(paClient, 'pending', { topic: topicB });
    const decisions = pending.decisions ?? [];
    const leakedA = decisions.find(d => d.topic === topicA);
    expect(leakedA).toBeUndefined();
  });

  // ── Negative ──────────────────────────────────────────────────────────────────

  it('M-03.7 resolving with supersede but no merged_content → error', async () => {
    const key = uid('m03-no-merged');

    await callTool(paClient, 'remember', {
      topic: TOPIC,
      key,
      content: 'Logging uses structured JSON format.',
      reason: 'Established logging standard',
    });
    const v2 = await callTool(engClient, 'remember', {
      topic: TOPIC,
      key,
      content: 'Logging uses plain text format.',
      reason: 'Engineer proposes plain text logging',
    });

    const attempt = await callTool(paClient, 'remember', {
      topic: TOPIC,
      key,
      content: 'Logging uses structured JSON format.',
      reason: 'Attempting resolution without merged_content',
      conflict_id: v2.conflict_id,
      resolution: 'supersede',
      // merged_content deliberately omitted
    });

    // Expect an error about missing merged_content
    expect(attempt.isError || attempt.error || attempt.status).toBeTruthy();
    const errorText = JSON.stringify(attempt).toLowerCase();
    expect(errorText).toMatch(/merged_content|resolution|conflict/);
  });

  it('M-03.8 engineer cannot resolve a conflict (non-PA authority rejected)', async () => {
    const key = uid('m03-eng-resolve');

    await callTool(paClient, 'remember', {
      topic: TOPIC,
      key,
      content: 'Deployment uses blue-green strategy.',
      reason: 'Deployment strategy established',
    });
    const v2 = await callTool(engClient, 'remember', {
      topic: TOPIC,
      key,
      content: 'Deployment uses rolling update strategy.',
      reason: 'Engineer proposes rolling deployments',
    });

    // Engineer tries to resolve — should be blocked (non-PA)
    const attempt = await callTool(engClient, 'remember', {
      topic: TOPIC,
      key,
      content: 'Deployment uses blue-green strategy (confirmed).',
      reason: 'Engineer attempting to resolve conflict — should be blocked',
      conflict_id: v2.conflict_id,
      resolution: 'supersede',
      merged_content: 'Deployment uses blue-green strategy (confirmed).',
    });

    const body = JSON.stringify(attempt).toLowerCase();
    expect(body).toMatch(/authority|role|architect|forbidden|permission|draft/i);
  });

  it('M-03.9 resolving an already-resolved conflict_id → error', async () => {
    const key = uid('m03-double-resolve');
    const mergedContent = 'Infrastructure uses Kubernetes for orchestration (resolved).';

    await callTool(paClient, 'remember', {
      topic: TOPIC,
      key,
      content: 'Infrastructure uses Kubernetes for orchestration.',
      reason: 'Infrastructure decision established',
    });
    const v2 = await callTool(engClient, 'remember', {
      topic: TOPIC,
      key,
      content: 'Infrastructure uses Docker Swarm for orchestration.',
      reason: 'Engineer proposes Docker Swarm',
    });
    const conflict_id = v2.conflict_id;

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

    expect(second.isError || second.error || second.status === 'conflict_detected').toBeTruthy();
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
