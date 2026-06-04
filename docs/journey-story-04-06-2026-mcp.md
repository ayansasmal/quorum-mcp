# MCP Integration Journey Stories
## Date: 2026-06-04 | Suite: quorum-mcp/tests/integration/

> These stories describe the six MCP integration journeys (J-MCP-01 through J-MCP-06).
> Each journey bridges the gap between the gateway E2E tests (which call HTTP directly)
> and the quorum-mcp unit tests (which mock the gateway). These integration tests exercise
> the full path: **MCP JSON-RPC → tool handler → real HTTP gateway → MCP response**.

---

## J-MCP-01 — Agent Identity & Write Lifecycle

**Scenario ID:** M-01 | **File:** `M-01-identity-write.test.js` | **OwnScore: 200** ⛔

### Story

An AI agent — perhaps Claude Code, perhaps a CI pipeline running `claude` in headless mode — connects to the Quorum MCP server for the first time. Before it can write anything, it must identify itself by calling `set_agent_context({ agent_id: 'my-agent' })`. This is Gate 3 in the server: without it, every write tool returns `agent_context_required`.

Once identified, a principal architect agent writes a decision. The MCP server calls the gateway's `/pg/versions` endpoint and the entry lands as `ACTIVE` — immediately authoritative. An engineer agent doing the same thing gets `DRAFT` back — the governance rules flow correctly through the MCP layer.

What this story tests that no other layer catches: the JSON-RPC schema validation fires *before* the handler for missing required fields. Unit tests mock the handler — they never exercise the SDK's own validation layer. And the `author_type: 'agent'` value must be written to the database, never accepted from tool input.

### Sub-scenarios

| # | Description | Type |
|---|-------------|------|
| M-01.1 | set_agent_context succeeds; PA write → ACTIVE in gateway | ✅ Positive |
| M-01.2 | Engineer write → DRAFT (governance by role) | ✅ Positive |
| M-01.3 | agent_id persists across multiple writes in same session | ✅ Positive |
| M-01.4 | recall after PA write confirms ACTIVE entry in gateway | ✅ Positive |
| M-01.5 | Valid kebab-case agent_id is accepted | ✅ Positive |
| M-01.6 | remember without set_agent_context → agent_context_required | ❌ Negative |
| M-01.7 | reason < 10 chars → REASON_REQUIRED constitutional error | ❌ Negative |
| M-01.8 | engineer write to global catalog → GLOBAL_WRITE_AUTHORITY error | ❌ Negative |
| M-01.9 | Invalid agent_id (uppercase) → rejected by Zod pattern | ❌ Negative |
| M-01.10 | Missing required `content` field → MCP SDK schema error | ❌ Negative |

### Gaps not covered

- `reflect` tool identity path (same gate, different write semantics)
- Token expiry mid-session (requires time manipulation)
- `author_type` assertion via direct DB query (would need gateway bypass route)

---

## J-MCP-02 — Read Path (recall + search)

**Scenario ID:** M-02 | **File:** `M-02-read-path.test.js` | **OwnScore: 54** 🟡

### Story

An agent needs to recall an engineering decision. It calls `recall({ key: 'my-key' })`. Behind the scenes, the MCP server calls `GatewayClient.getCurrentVersion()`, which queries the gateway's `/api/knowledge/:key` endpoint. If the current version is `ACTIVE`, it comes back. If it's only `DRAFT`, it should not come back — the agent must see the same governance-filtered view as the dashboard.

The federation story matters too: if the agent's project is linked to a global catalog (via `globals: ['quorum-test-catalog']` in the `.quorum` config), a `recall` miss in the project falls through to the catalog, and the result carries `source: 'global'` + `catalog_id`. An agent that doesn't see this annotation might treat global knowledge as local and make incorrect writes.

### Sub-scenarios

| # | Description | Type |
|---|-------------|------|
| M-02.1 | recall ACTIVE key → summary matches written content | ✅ Positive |
| M-02.2 | recall with history:true → version chain (newest first) | ✅ Positive |
| M-02.3 | recall global catalog entry → source: global annotation | ✅ Positive |
| M-02.4 | search matching content → result includes seeded entry | ✅ Positive |
| M-02.5 | recall DRAFT-only key → not found (getCurrentVersion = ACTIVE only) | ❌ Negative |
| M-02.6 | recall nonexistent key → graceful not-found (no crash) | ❌ Negative |
| M-02.7 | search single-char q → Zod validation error | ❌ Negative |
| M-02.8 | search empty q → error or graceful empty (no crash) | ❌ Negative |
| M-02.9 | recall missing `key` argument → MCP schema error | ❌ Negative |

### Gaps not covered

- `history` tool full pagination (multiple pages)
- `export` tool (Markdown/Confluence) — needs file system or Confluence credential
- Cross-project recall with division hierarchy (division catalog fallback loop)

---

## J-MCP-03 — Conflict Detection Round-Trip

**Scenario ID:** M-03 | **File:** `M-03-conflict-round-trip.test.js` | **OwnScore: 240** ⛔ | **FailureCost: 655**

### Story

This is the heart of Quorum. When two agents write contradicting content for the same key, the system must detect the conflict and prevent silent contradiction. From the MCP perspective, this is a three-act play:

**Act 1 — Write:** PA agent writes v1 as `ACTIVE`. Engineer agent writes contradicting content for the same key. The MCP tool handler calls `detectConflict()` before writing — if a contradiction is found, it stores the engineer's write as `PENDING_CONFLICT_CHECK` and returns `{ status: 'conflict_detected', conflict_id }` to the agent.

**Act 2 — Surface:** PA agent calls `pending()`. The response contains `decisions[]` with the pending conflict, including `topic`, `key`, and `conflict_reason`. The PA can now review the contradiction.

**Act 3 — Resolve:** PA calls `remember()` with `conflict_id`, `resolution: 'supersede'`, and `merged_content`. The handler calls the gateway to resolve the pending conflict and write the final ACTIVE version. Calling `pending()` again confirms the conflict is gone.

This round-trip has never been tested through the MCP protocol layer before. The gateway E2E tests exercise it via HTTP, the unit tests mock the gateway — but neither catches bugs in the tool handler's conflict resolution logic or the MCP content block format when returning conflict state.

### Sub-scenarios

| # | Description | Type |
|---|-------------|------|
| M-03.1 | PA writes v1, engineer writes contradiction → conflict_detected + conflict_id | ✅ Positive |
| M-03.2 | pending() shows conflict in decisions[] | ✅ Positive |
| M-03.3 | PA resolves with supersede + merged_content → resolved/ACTIVE | ✅ Positive |
| M-03.4 | pending() does not contain conflict after resolution | ✅ Positive |
| M-03.5 | gateway confirms new ACTIVE version after resolution (via recall) | ✅ Positive |
| M-03.6 | pending() topic filter returns only conflicts for that topic | ✅ Positive |
| M-03.7 | resolve with supersede but no merged_content → error | ❌ Negative |
| M-03.8 | engineer cannot resolve conflict (non-PA) → authority error | ❌ Negative |
| M-03.9 | resolve already-resolved conflict_id → error (no duplicate) | ❌ Negative |
| M-03.10 | reason < 10 chars on remember → REASON_REQUIRED | ❌ Negative |

### Why FailureCost is 655

- M-03 OwnScore: 240
- S-02.2 (same `detectConflict` call path in gateway E2E): +120
- S-06 (conflict resolution gateway flow): +135
- S-17 (conflict pending review): +160
- **Total: 655**

A regression in `detectConflict()` would silently let contradictions through in both the MCP layer and the gateway E2E layer. This is the test that matters most.

---

## J-MCP-04 — Deprecation Paths

**Scenario ID:** M-04 | **File:** `M-04-deprecation-paths.test.js` | **OwnScore: 101** ⛔ | **FailureCost: 191**

### Story

A principal architect wants to deprecate a stale decision. Calling `forget({ key, reason })` as a PA should immediately mark the entry `DEPRECATED` in the gateway. An engineer calling `forget` for the same key should instead submit a deprecation request — because engineers cannot unilaterally remove knowledge that a PA established.

The `pending()` tool then shows the queued request in `deprecation_requests[]`. The PA calls `review({ request_id, action: 'approve', reason })` to approve it, and the gateway marks the entry `DEPRECATED`.

What's new in the MCP layer: the `forget` tool handler must correctly branch on role (PA = direct deprecation, engineer = queue request), and the `review` tool must correctly call `GatewayClient` with the right action type. Unit tests mock both; this integration test confirms the full path end-to-end.

### Sub-scenarios

| # | Description | Type |
|---|-------------|------|
| M-04.1 | PA forget → DEPRECATED confirmed via recall | ✅ Positive |
| M-04.2 | Engineer forget → deprecation request queued (request_id returned) | ✅ Positive |
| M-04.3 | pending() shows deprecation_requests[] with the queued entry | ✅ Positive |
| M-04.4 | PA review approves → gateway confirms DEPRECATED | ✅ Positive |
| M-04.5 | forget nonexistent key → graceful error message (no crash) | ❌ Negative |
| M-04.6 | forget reason < 10 chars → REASON_REQUIRED | ❌ Negative |
| M-04.7 | forget already-DEPRECATED → state machine error | ❌ Negative |
| M-04.8 | forget in wrong project scope → 404/not found from gateway | ❌ Negative |
| M-04.9 | forget missing required `key` field → MCP schema error | ❌ Negative |

---

## J-MCP-05 — Deviation & Conformance

**Scenario ID:** M-05 | **File:** `M-05-deviation-conformance.test.js` | **OwnScore: 36** 🟢

### Story

A CI pipeline scans the codebase and discovers that `payment-service` isn't using the structured logging pattern defined in the global catalog. It calls `deviate({ catalog_id, topic, pattern, description, source: 'scan' })`. The MCP tool handler validates that `projectId` is set in ctx, then delegates everything to `pg.recordDeviation()` — a thin proxy by design.

If the same deviation is reported again (same `catalog_id` + `pattern`), the gateway upserts: `last_seen_at` is updated, no duplicate row created. The agent gets `is_new: false` back.

The PA then calls `conformance({})` to get the project's conformance score. The tool proxies to `GET /api/conformance` and returns `{ score, status, breakdown }`. With `include_details: true`, it also fetches the top 10 OPEN deviations sorted by severity.

### Sub-scenarios

| # | Description | Type |
|---|-------------|------|
| M-05.1 | deviate() returns deviation_id, status, severity | ✅ Positive |
| M-05.2 | deviate() idempotent — same args, same id, is_new: false | ✅ Positive |
| M-05.3 | conformance() returns score, status, breakdown | ✅ Positive |
| M-05.4 | conformance(include_details:true) returns sorted deviations | ✅ Positive |
| M-05.5 | deviate() for project not linked to catalog → not_linked / error | ❌ Negative |
| M-05.6 | deviate() missing catalog_id → Zod schema error | ❌ Negative |
| M-05.7 | conformance() unreachable gateway → graceful error | ❌ Negative |
| M-05.8 | conformance() UNCERTIFIED project → contextual message (no crash) | ❌ Negative |

---

## J-MCP-06 — MCP Protocol Contracts

**Scenario ID:** M-06 | **File:** `M-06-protocol-contracts.test.js` | **OwnScore: 24** 🟢

### Story

Before any feature can be trusted, the contract must hold. This journey tests the MCP protocol layer itself, independent of any specific tool's business logic.

The tool manifest must expose all 14 tools. Every response must have `content[0].type === 'text'` and `content[0].text` must be valid JSON — no raw strings, no exceptions leaking into the content block. Extra fields in tool arguments must be silently stripped (Zod `.strip()`), not cause errors.

Most importantly: the SDK must validate required fields before the handler fires. If `remember` is called without `content`, the SDK should return `isError: true` before any gateway call is made. This is a contract that unit tests can never verify because they bypass the SDK entirely.

### Sub-scenarios

| # | Description | Type |
|---|-------------|------|
| M-06.1 | tools/list → exactly 14 tools, all expected names present | ✅ Positive |
| M-06.2 | tool response format: content[0].type=text, text valid JSON | ✅ Positive |
| M-06.3 | set_agent_context persists: agent_id flows through to write audit | ✅ Positive |
| M-06.4 | remember schema: topic, key, content all in required[] | ✅ Positive |
| M-06.5 | missing required content → isError:true (SDK validates before handler) | ❌ Negative |
| M-06.6 | confidence as string → Zod type error, isError:true (no 500) | ❌ Negative |
| M-06.7 | nonexistent tool name → MCP error (no unhandled rejection) | ❌ Negative |
| M-06.8 | extra unknown fields in args → stripped, tool succeeds | ✅ Positive |

---

## Scoring Summary

| Journey | OwnScore | Gate | FailureCost | Priority |
|---------|---------|------|------------|---------|
| J-MCP-03 Conflict Round-Trip | **240** | ⛔ | **655** | 1 |
| J-MCP-01 Identity & Write | **200** | ⛔ | **440** | 2 |
| J-MCP-04 Deprecation Paths | **101** | ⛔ | **191** | 3 |
| J-MCP-02 Read Path | **54** | 🟡 | **54** | 4 |
| J-MCP-05 Deviation & Conformance | **36** | 🟢 | **36** | 5 |
| J-MCP-06 Protocol Contracts | **24** | 🟢 | **24** | 6 |
| **Suite Total** | **655** | | | |

**Suite OwnScore: 655** | **54 test leaves** | **10% gate: 66 pts** | **5% gate: 33 pts**
