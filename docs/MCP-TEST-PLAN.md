# MCP Integration Test Plan

**Version:** 1.0 | **Date:** 2026-06-04 | **Suite:** `quorum-mcp/tests/integration/`

> MCP gateway layer E2E: the gateway E2E suite (`quorum/tests/e2e/`) tests the HTTP surface directly.
> This plan covers the MCP layer — the full path from JSON-RPC framing through tool handlers to real gateway HTTP.

---

## Decision Framework

Same OwnScore/FailureCost model as `quorum/docs/e2e/TEST-PLAN.md`. Applies here because MCP tool handlers contain governance enforcement code that is never exercised by the gateway E2E tests.

```
W          = leaf_count × FrequencyTier
OwnScore   = W × Criticality × Detectability
FailureCost = OwnScore + Σ(correlated scenario OwnScores)
```

### FrequencyTier

| F | Label | Meaning |
|---|-------|---------|
| F4 | Core | Every production agent session uses this path |
| F3 | Regular | Most production sessions use this (daily, not per-call) |
| F2 | Occasional | Some sessions — triggered by specific workflows |
| F1 | Rare | Edge cases, error recovery |

### Criticality (C)

| C | Meaning |
|---|---------|
| 3.0 | Governance violation — incorrect state transition, silent data loss |
| 2.5 | Authority bypass — wrong user can do wrong thing |
| 2.0 | Correctness — data is wrong but visible |
| 1.5 | Functional regression — feature broken but state intact |
| 1.0 | Operational — performance / observability / DX |

### Detectability (D)

| D | Meaning |
|---|---------|
| 2.0 | Silent — no log, no error surface |
| 1.5 | Delayed — detected at review or deploy |
| 1.0 | Noisy — immediate error, fast feedback |

### CI Decision Rules

```
Blocked scenarios  (OwnScore ≥ 200 OR FailureCost ≥ 400)  → fix before merge (⛔)
Yellow scenarios   (OwnScore ≥ 50 OR FailureCost ≥ 150)   → must-address (🟡)
Green scenarios    (below thresholds)                       → monitor (🟢)
```

---

## Prerequisites

The two repos are independent — no scripted linkage. Integration tests treat `QUORUM_GATEWAY_URL` as an external contract.

**Local dev workflow:**

```bash
# Terminal 1 — start the test gateway stack
cd quorum
npm run test:e2e:env:setup      # starts gateway + postgres + redis + localstack

# Terminal 2 — run MCP integration tests
cd quorum-mcp
QUORUM_GATEWAY_URL=http://localhost:3001 npm run test:integration
```

**CI:** Set `QUORUM_GATEWAY_URL` to a running test environment (Docker Compose stack started in the CI job). quorum-mcp CI does not depend on quorum CI.

---

## Current Suite Status

**As of 2026-06-05: 54/54 passing. 0 failures.**

```
 ✓ M-01-identity-write.test.js     (10 tests)
 ✓ M-02-read-path.test.js          (9 tests)
 ✓ M-03-conflict-round-trip.test.js (10 tests)
 ✓ M-04-deprecation-paths.test.js  (9 tests)
 ✓ M-05-deviation-conformance.test.js (8 tests)
 ✓ M-06-protocol-contracts.test.js (8 tests)
```

**Last fix (2026-06-05):** M-04.4 — `GatewayClient.insertPendingDecision()` was returning the full row from `POST /pg/pending` instead of extracting `conflict_id`. The review tool received an object as `request_id`, failing MCP schema validation (`-32602 Input validation error: expected string, received object`). Fix: `return row?.conflict_id ?? row` in `src/gateway/client.js`. This maintained the duck-type contract with `queries.js`'s raw-pg path, which also returns a `conflict_id` string.

---

## Scenario Scoring Table

| ID | Journey | Leaves | F | W | Pillar | C | D | OwnScore | FailureCost | Gate |
|----|---------|--------|---|---|--------|---|---|---------|-------------|------|
| M-01 | J-MCP-01 Agent Identity & Write | 10 | F4 | 40 | Governance ⛔ | 2.5 | 2.0 | **200** | **440** | ⛔ |
| M-02 | J-MCP-02 Read Path | 9 | F4 | 36 | Functional | 1.5 | 1.0 | **54** | **54** | 🟡 |
| M-03 | J-MCP-03 Conflict Round-Trip | 10 | F4 | 40 | Governance ⛔ | 3.0 | 2.0 | **240** | **655** | ⛔ |
| M-04 | J-MCP-04 Deprecation Paths | 9 | F3 | 27 | Governance ⛔ | 2.5 | 1.5 | **101** | **191** | ⛔ |
| M-05 | J-MCP-05 Deviation & Conformance | 8 | F2 | 16 | Functional | 1.5 | 1.5 | **36** | **36** | 🟢 |
| M-06 | J-MCP-06 Protocol Contracts | 8 | F3 | 24 | Operational | 1.0 | 1.0 | **24** | **24** | 🟢 |
| **Total** | | **54** | | **183** | | | | **655** | | |

**Suite OwnScore: 655** | 10% gate: **66 pts** | 5% gate: **33 pts**

**Fix priority:** M-03 → M-01 → M-04 → M-02 → M-05 → M-06

---

## Correlations

| Scenario | Correlates | FailureCost breakdown |
|----------|-----------|----------------------|
| M-03 (240) | S-02.2, S-06, S-17 (same `detectConflict` path) | 240 + 120 + 135 + 160 = **655** |
| M-01 (200) | M-03 (identity failure breaks write = breaks conflict detection) | 200 + 240 = **440** |
| M-04 (101) | S-03 (same forget/deprecation-request flow) | 101 + 90 = **191** |

---

## Gap Coverage Summary

### What these tests catch that no other layer catches

| Gap | Scenario | Notes |
|-----|----------|-------|
| MCP schema validation before handler | M-06.5, M-06.6, M-01.10 | SDK validates required fields; unit tests never fire this |
| `set_agent_context` gate enforcement in real protocol | M-01.6 | Unit tests mock the gate; integration confirms it fires in JSON-RPC path |
| `resolveCtx()` env fallback (path 3) | all | Integration tests exercise QUORUM_PROJECT_ID env fallback end-to-end |
| Conflict detection round-trip (MCP → gateway → MCP response) | M-03.1–M-03.5 | The detect→pending→resolve cycle was never tested through MCP protocol |
| `content[0].type === 'text'` + valid JSON in every response | M-06.2 | Protocol contract — unit tests inspect raw handler return, not MCP framing |
| `author_type: 'agent'` written to DB (not accepted from input) | M-01.1 | End-to-end persistence check not done by unit tests |

---

## Scenario Detail

### M-01 — Agent Identity & Write Lifecycle

**File:** `tests/integration/M-01-identity-write.test.js`

| # | Leaf | Type | Assertion |
|---|------|------|-----------|
| 1 | set_agent_context succeeds; PA write → ACTIVE | ✅ | `knowledge_status === 'ACTIVE'` |
| 2 | engineer write → DRAFT | ✅ | `status !== 'ACTIVE'` |
| 3 | agent_id persists across writes in same session | ✅ | both writes succeed ACTIVE |
| 4 | recall after PA write confirms ACTIVE in gateway | ✅ | content matches |
| 5 | valid kebab-case agent_id → no error | ✅ | `isError` falsy |
| 6 | remember without set_agent_context → blocked | ❌ | `agent_context_required` |
| 7 | remember with reason < 10 chars → REASON_REQUIRED | ❌ | `isError: true` |
| 8 | engineer write to global catalog → GLOBAL_WRITE_AUTHORITY | ❌ | `isError: true` |
| 9 | invalid agent_id (uppercase) → error | ❌ | `isError: true` |
| 10 | missing required content field → MCP schema error | ❌ | exception or `isError` |

### M-02 — Read Path

**File:** `tests/integration/M-02-read-path.test.js`

| # | Leaf | Type | Assertion |
|---|------|------|-----------|
| 1 | recall ACTIVE key → summary matches content | ✅ | content contains seed text |
| 2 | recall with history:true → version array | ✅ | versions length ≥ 1 |
| 3 | global catalog recall → source: global annotation | ✅ | body matches /global\|catalog/ |
| 4 | search matching content → result includes entry | ✅ | body non-empty |
| 5 | recall DRAFT-only key → not found (ACTIVE only) | ❌ | body matches /not.found/ |
| 6 | recall nonexistent key → graceful message | ❌ | body non-empty (no crash) |
| 7 | search single-char q → Zod error | ❌ | `isError: true` |
| 8 | search empty q → error or empty (no crash) | ❌ | no unhandled exception |
| 9 | recall missing key argument → MCP schema error | ❌ | exception or `isError` |

### M-03 — Conflict Detection Round-Trip

**File:** `tests/integration/M-03-conflict-round-trip.test.js`

| # | Leaf | Type | Assertion |
|---|------|------|-----------|
| 1 | PA writes v1, engineer contradicts → conflict_detected | ✅ | `status === 'conflict_detected'` |
| 2 | pending() shows conflict in decisions[] | ✅ | found entry with key |
| 3 | PA resolves with supersede → resolved | ✅ | status matches /resolved\|ACTIVE/ |
| 4 | pending() absent after resolution | ✅ | conflict not in decisions |
| 5 | gateway confirms new ACTIVE content | ✅ | recall content matches merged |
| 6 | pending() topic filter works | ✅ | cross-topic leak absent |
| 7 | resolve without merged_content → error | ❌ | error about merged_content |
| 8 | engineer cannot resolve (non-PA) → authority error | ❌ | body matches /authority/ |
| 9 | resolve already-resolved conflict_id → error | ❌ | `isError` or no duplicate |
| 10 | reason < 10 chars → REASON_REQUIRED | ❌ | `isError: true` |

### M-04 — Deprecation Paths

**File:** `tests/integration/M-04-deprecation-paths.test.js`

| # | Leaf | Type | Assertion |
|---|------|------|-----------|
| 1 | PA forget → DEPRECATED in gateway | ✅ | recall shows deprecated/not found |
| 2 | engineer forget → request queued (request_id) | ✅ | body matches /request_id\|queued/ |
| 3 | pending() shows deprecation_requests[] | ✅ | found entry with key |
| 4 | PA review approves → DEPRECATED confirmed | ✅ | body matches /approved\|deprecated/ |
| 5 | forget nonexistent key → graceful error | ❌ | body matches /not.found/ |
| 6 | forget reason < 10 chars → REASON_REQUIRED | ❌ | `isError: true` |
| 7 | forget already-DEPRECATED → state machine error | ❌ | body matches /not.found\|deprecated/ |
| 8 | forget in wrong project → 404 / not found | ❌ | body matches /not.found\|error/ |
| 9 | forget missing key field → MCP schema error | ❌ | exception or `isError` |

### M-05 — Deviation & Conformance

**File:** `tests/integration/M-05-deviation-conformance.test.js`

| # | Leaf | Type | Assertion |
|---|------|------|-----------|
| 1 | deviate() → deviation_id, status, severity | ✅ | body matches /deviation_id/ |
| 2 | deviate() idempotent — same args twice, same id | ✅ | firstId === secondId |
| 3 | conformance() → score, status, breakdown | ✅ | body matches /score\|status/ |
| 4 | conformance(include_details:true) → top deviations | ✅ | no crash |
| 5 | deviate() project not linked to catalog → error | ❌ | body matches /not.linked\|error/ |
| 6 | deviate() missing catalog_id → Zod error | ❌ | exception or `isError` |
| 7 | conformance() unreachable gateway → graceful error | ❌ | body matches /error\|econnrefused/ |
| 8 | conformance() UNCERTIFIED project → contextual message | ❌ | body non-empty (no crash) |

### M-06 — MCP Protocol Contracts

**File:** `tests/integration/M-06-protocol-contracts.test.js`

| # | Leaf | Type | Assertion |
|---|------|------|-----------|
| 1 | tools/list → 14 tools, all names present | ✅ | names.length === 14 |
| 2 | response format: content[0].type=text, valid JSON | ✅ | no JSON.parse throw |
| 3 | set_agent_context persists across calls | ✅ | write succeeds, status ACTIVE |
| 4 | remember schema has topic,key,content required | ✅ | required array contains all 3 |
| 5 | missing required content → isError:true | ❌ | `response.isError === true` |
| 6 | wrong type for confidence → Zod error, no 500 | ❌ | `isError: true` |
| 7 | nonexistent tool name → MCP error (no crash) | ❌ | exception or `isError` |
| 8 | extra unknown fields → stripped, no crash | ✅ | content[0].type === 'text' |

---

## Infrastructure

### Files

| File | Purpose |
|------|---------|
| `tests/integration/helpers/tokens.js` | Re-exports JWT factories from `quorum/tests/e2e/helpers/jwt.js` |
| `tests/integration/helpers/gateway.js` | HTTP seed helpers (activeEntry, draftEntry, getEntry, uid) |
| `tests/integration/helpers/mcp-client.js` | `createMcpClient()` + `callTool()` — InMemoryTransport factory |
| `vitest.config.integration.js` | Vitest config: `testTimeout: 30_000`, no coverage |
| `src/server.js` | Modified: `createMcpServer()` export, `registerTools(targetServer)` |

### MCP Client Factory Design

```
test → createMcpClient({ token, projectId })
         ├─ _resetGatewayClient()        singleton isolation
         ├─ setGatewayToken(token)        injects Bearer JWT
         ├─ QUORUM_PROJECT_ID = projectId  resolveCtx() env fallback
         ├─ InMemoryTransport.createLinkedPair()
         ├─ createMcpServer().connect(serverTransport)
         └─ Client.connect(clientTransport) → { client, cleanup }

client.callTool({ name, arguments }) → MCP JSON-RPC → tool handler → HTTP gateway
```

`resolveCtx()` path 1 (`listRoots`) fails fast (InMemoryTransport client returns no roots capability) → falls through to path 3 env vars.
