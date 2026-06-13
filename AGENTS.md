# @as-quorum/mcp

Published npm package. Engineers install this to connect Codex and AI agents to a Quorum gateway.

```bash
npm install -g @as-quorum/mcp
# or one-step install (registers MCP + copies skill):
npx @as-quorum/mcp install
```

---

## Purpose

MCP server that exposes 14 tools to Codex: `set_agent_context`, `remember`, `recall`, `search`, `reflect`, `history`, `export`, `forget`, `review`, `pending`, `authenticate`, `config_upload`, `deviate`, `conformance`.

Always communicates with a Quorum gateway over HTTP. **Never connects to PostgreSQL directly.** Default gateway URL: `http://localhost:3001` (local dev Docker stack).

**Identity model (v0.3):** the JWT carries only `{ sub, is_admin }`. The active project is sent as the `X-Quorum-Project` header on every request. `resolveCtx()` reads the `.quorum` file in the project root and threads project context through all tool calls.

**Dual-store audit pipeline:** every tool call writes INTENT + OUTCOME entries to PostgreSQL (durable, SHA256 tamper-evident chain) and Graphiti (semantic traversal). If Graphiti is unavailable, writes are stored as `PENDING_CONFLICT_CHECK` in PostgreSQL for later reprocessing. The `summary` column in `knowledge_versions` is the canonical durable content store — survives FalkorDB volume wipes.

---

## Key Files

```
src/
  server.js               — Entry point: startup, tool registration, non-fatal loopback health endpoint (`:50000`)
  quorum-file.js          — .quorum project file auto-discovery (sets env vars)
  tools/                  — One file per MCP tool
  governance/             — conflict.js · authority.js · confidence.js · provenance.js
  audit/                  — pipeline.js · chain.js · primary.js · secondary.js
  graph/                  — client.js (Graphiti) · schema.js · queries.js (pg-compat + GatewayClient duck-type) · validate.js (shared input validation)
  config/                 — schema.js · loader.js · quorum.schema.json
  identity/               — resolver.js (4-layer identity chain)
  gateway/
    client.js             — Outbound HTTP client to gateway (NOT the gateway server)
  install/
    hooks.js              — Hook script installer: copies hooks/, merges settings.json (idempotent)
  export/                 — markdown.js · confluence.js
  prompts/                — loader.js
cli.js                    — quorum init / quorum install (--skip-mcp / --skip-skill / --skip-hooks) CLI
hooks/                    — 5 Codex hook scripts (bundled with npm; installed to ~/.Codex/hooks/)
skill/                    — SKILL.md + references/ (bundled with npm package)
dist/                     — Compiled output (esbuild, gitignored)
tests/integration/        — MCP integration tests (require running gateway); excluded from npm test
  helpers/tokens.js       — JWT factories (re-exports from quorum/tests/e2e/helpers/jwt.js)
  helpers/gateway.js      — HTTP seed helpers (activeEntry, draftEntry, uid) — uses Node fetch
  helpers/mcp-client.js   — createMcpClient() + callTool() via InMemoryTransport + createMcpServer()
  M-01-*.test.js          — Identity & write lifecycle (OwnScore 200 ⛔)
  M-02-*.test.js          — Read path: recall + search (OwnScore 54)
  M-03-*.test.js          — Conflict detection round-trip (OwnScore 240 ⛔, FailureCost 655)
  M-04-*.test.js          — Deprecation paths (OwnScore 101 ⛔)
  M-05-*.test.js          — Deviation & conformance (OwnScore 36)
  M-06-*.test.js          — MCP protocol contracts (OwnScore 24)
docs/MCP-TEST-PLAN.md     — Risk-weighted test plan for integration suite (OwnScore 655, 6 journeys)
docs/journey-story-04-06-2026-mcp.md — Journey narratives for J-MCP-01 through J-MCP-06
docs/superpowers/specs/2026-06-13-safe-hook-installation-design.md — Approved ownership and atomic-repair rules for Claude settings hooks
docs/superpowers/plans/2026-06-13-safe-hook-installation.md — TDD implementation plan for safe hook inspection, repair, and reporting
```

---

## Development

```bash
npm run build:all    # compile src/server.js + cli.js → dist/
npm run dev          # node --watch src/server.js (uncompiled, for local dev)
npm run start        # run compiled dist/server.js
npm test             # run all unit tests (38 files, 629 tests) — excludes integration tests
npm test -- --coverage  # with v8 coverage report (75% threshold: lines, branches, functions)
npm run test:constitutional  # Layer 1 only (blocking CI gate)

# Integration tests — require a running gateway (QUORUM_GATEWAY_URL must be set):
QUORUM_GATEWAY_URL=http://localhost:3001 npm run test:integration   # 6 files, 54 leaves
```

---

## Architecture Constraints

**Never add `pg` calls to new code.** The `pg` parameter on functions in `graph/queries.js` and `audit/secondary.js` is kept for backward-compat with gateway's workspace import — those functions duck-type: `if (typeof pg.methodName === 'function') return pg.methodName(...)` and fall through to raw SQL only when a real `pg.Pool` is passed (which only the gateway does).

**Shared validation module:** `src/shared/graph/validate.js` is a vendored copy of `gateway/src/shared/graph/validate.js`. Contains `validateKnowledgeInput(fields, opts)` and `ValidationError`. Must be manually synced when the canonical (gateway) copy changes.

**GatewayClient** (`src/gateway/client.js`) is the only persistence interface the MCP uses. It implements typed methods — `getCurrentVersion()`, `insertVersion()`, `writeAuditEntry()`, etc. — that map to the gateway's `/pg/*` REST API. Every request carries a `Bearer` JWT and `X-Quorum-Project` header. Its `query()` method throws intentionally. **Contract invariant:** `insertPendingDecision()` returns the `conflict_id` string (not the full row) — matches the raw-pg path in `queries.js` which also returns a string. The gateway's `POST /pg/pending` returns the full row; the client extracts `row.conflict_id` to maintain this contract.

**Identity:** Resolved once per session (from JWT in gateway mode). Never accepted as tool input — server-side only.

**`createMcpServer()` export:** `src/server.js` exports `createMcpServer()` (creates fresh `McpServer` + calls `registerTools(s)`) and `registerTools(targetServer = server)` (parameterised — defaults to module-level singleton). These are used by integration tests; `startup()` continues to use the singleton unchanged. `resolveCtx(mcpServer)` is also parameterised — integration tests hit env fallback (path 3) because InMemoryTransport client doesn't serve `listRoots`.

**Runtime endpoints:** `QUORUM_GATEWAY_URL` is required for gateway calls; `QUORUM_DASHBOARD_URL` is optional and supplies human-facing deep links; `QUORUM_MCP_PORT` optionally overrides the loopback health endpoint's default port `50000`. `startHealthServer()` treats listener failures such as `EADDRINUSE` as warnings because Claude can run multiple stdio MCP processes concurrently.

**Cold-start onboarding:** `authenticate` accepts empty input and `config_upload` is exempt from the no-project-context gate. Verify this through an MCP `Client` + `InMemoryTransport`, not by calling handlers directly.

**v0.4 Wave A (complete):** Constitutional + DB Foundation — `enforceGlobalWriteAuthority` (lifts GAP-27 soft-return to constitutional throw; config-driven via `getConfig()?.is_global`), `enforceDeviationActionAuthority`, `enforceValidDeferDeadline`; `DeviationStatus`, `DeviationActionType`, `VALID_DEFER_DAYS` in `src/graph/schema.js`; `QuorumConfigSchema` extended with `hierarchy`, `is_global`, `global_scope`, `is_public`, `globals`; executive roles (`director`, `vp_engineering`, `group_executive`) in `src/governance/authority.js`.

**v0.4 Wave B (complete):** Federation — Cross-project reads
- `normalizeGroupId()` exported from `src/graph/client.js`; `searchNodes`/`searchFacts` accept `groupIds: string[]` array
- `detectConflict()` (`src/governance/conflict.js`): added `projectId` + `globals` params; scopes conflict search to `[projectId, ...globals]` — no more silent contradiction of linked global catalog entries
- `remember.js`: passes `getConfig()?.globals ?? []` to `detectConflict`
- `search.js`: config-driven globals via `getConfig()`; per-catalog `searchNodes` calls preserve `catalog_id` attribution; results annotated `source: 'project'|'global'`, `catalog_id: string|null`
- `recall.js`: config-driven globals fallback loop after project miss; XML result annotated `source` + `catalog_id` attributes; sourced-from-global comment injected when applicable

**v0.4 Wave C+D (complete):** Deviation Write Path + PE Governance
- `src/tools/deviate.js` (new): thin proxy tool — validates `projectId` in ctx, delegates ALL business logic to `pg.recordDeviation()` (gateway handles catalog link validation, severity derivation, idempotent upsert). Returns `{ deviation_id, catalog_id, severity, status, message, is_new }` from gateway.
- `src/gateway/client.js`: added `recordDeviation(record)` → `POST /api/deviations`; added `getDeviations(filters)` → `GET /api/deviations?...` with full filter support (`status`, `catalog_id`, `topic`, `severity_min`, `source`, `limit`, `offset`)
- `src/tools/pending.js`: extended response shape with `deviations: { open, overdue_deferrals }` and `summary.open_deviations` + `summary.overdue_deferrals` counts via new `fetchDeviationAlerts()` helper — gracefully returns empty if `pg.getDeviations` is absent (older gateway)
- `src/governance/authority.js`: `DEFAULT_ROLE_SCORES` is now `export const` (required for gateway's deviation severity formula to import the same canonical values)
- `src/graph/queries.js`: fixed `insertDeviationAction` SQL params order bug (was `actor_role` before `actor`; columns are `actor, actor_role`)

**v0.4 Wave E+F (complete):** Conformance Scoring + Portfolio Intelligence
- `src/tools/conformance.js` (new): thin proxy tool — validates `projectId` in ctx, delegates to `pg.getConformance()` (gateway `GET /api/conformance`). UNCERTIFIED returns contextual message variant (no scan / no catalogs / sparse coverage). `include_details: true` fetches top 10 OPEN deviations via `pg.getDeviations({ status: 'OPEN', limit: 10 })` and sorts by severity desc (capped at 10). Registered as 14th tool in `src/server.js`.
- `src/gateway/client.js`: added `getConformance()` → `GET /api/conformance`; added `getPortfolio(opts)` → `GET /api/portfolio?node_id=...`
- `src/graph/queries.js`: added `getPortfolioScores(pg, projectInfos)` — vendored copy of gateway function; `Promise.allSettled` for per-project failure isolation; checks `pg.getPortfolioScores()` override first (test injection)
- `skill/references/scan.md` (new): full `quorum:scan` skill doc — incremental scan orchestration (check conformance → git diff → code-review → security-review → deviate()/remember() per finding → resolve fixed → updated conformance → return summary); scheduled scanning via `quorum:schedule`; key constraints documented (one call per pattern, never deviate() for non-linked catalogs)
- Tests: `tests/tools/conformance.test.js` (15 tests — projectId validation, 3 UNCERTIFIED message variants, no-getDeviations call when UNCERTIFIED, CERTIFIED pass-through, include_details sort+cap, empty/undefined deviations graceful, audit pipeline author)

**v0.4 Wave G (complete):** Documentation
- `skill/SKILL.md`: Conformance Scanning section — deviate(), conformance(), quorum:scan orchestration (when to call each, return value tables, pending() deviation handling); updated quick reference; references/scan.md added to references table
- `README.md`: tool count 12→14; test count 559→620 (37 files); 14-tool table with set_agent_context + deviate + conformance; v0.4 governance rules table; updated project structure tools list
- Wave B source fixes (entity_type preservation): `graph/client.js` — export normalizeGroupId, fix searchNodes/searchFacts for groupIds[]; `governance/provenance.js` — pass entity_type through buildVersionRecord; `tools/forget.js` + `tools/review.js` — preserve entity_type on DEPRECATED version record

**Post-Wave-G additions (complete):**
- `src/graph/schema.js`: `Standard` entity type added — org-wide baseline measured by conformance scoring; properties: `scope`, `rationale`, `exception_process`, `domain`. `Guideline` entity type added — recommended practice with allowed exceptions; properties: `rationale`, `when_to_deviate`, `domain`. Both synced from canonical `gateway/src/shared/graph/schema.js`. `Standard` is the preferred type for global catalog entries.
- Hierarchy `org` tier: valid levels in `HierarchySchema` now `org → group → division → department → service` (5 levels). Synced from gateway `QuorumConfigSchema`.
- `src/config/schema.js`: `base_confidence` field added to `MemberSchema` (required for `POST /config/upload` alignment with gateway validation).

**Agent identity (v0.3):** `set_agent_context({ agent_id })` is Gate 3 — must be called before any write tool (`remember`, `reflect`, `forget`, `review`). `agent_id` is validated as `^[a-z][a-z0-9-]{0,39}$`. `session_id` is derived server-side from `hash(PID + hrtime.bigint())` → `sess_` + 8 hex chars. `author_type` is always `'agent'` (never caller-supplied) — distinguishes agent MCP writes from human dashboard writes (`author_type: 'human'` on all dashboard create/promote/supersede/deprecate actions). All three fields are written to `knowledge_versions.agent_id`, `.session_id`, `.author_type` via `buildVersionRecord()`.

**Skill + Hooks:** Install with `npx @as-quorum/mcp install`. Copies `skill/SKILL.md` to `~/.Codex/skills/quorum/`, copies `hooks/quorum-*.sh` to `~/.Codex/hooks/`, merges hook wiring into `~/.Codex/settings.json`, and runs `Codex mcp add`. Use `--skip-mcp`, `--skip-skill`, or `--skip-hooks` to skip individual steps. Hooks are self-limiting: each script checks `[ -f ".quorum" ] || exit 0` — silent in any project without a `.quorum` sentinel file.

---

## Non-Negotiable Rules (enforced by constitutional tests)

| Rule | Location |
|------|----------|
| No hard delete | `src/graph/client.js` `BLOCKED_METHODS` |
| Audit append-only | `src/audit/secondary.js` — `updateEntry`/`deleteEntry` always throw |
| Reason ≥ 10 chars | `src/governance/constitutional.js` `enforceReasonRequired()` |
| No self-approval | `src/governance/constitutional.js` `enforceNoSelfApproval()` |
| Codex writes → DRAFT | `src/tools/remember.js` `storeFirst()` — `author === 'Codex'` forces DRAFT |
| `triggered_by` always set | Schema enforcement — null value rejected |
| Content in PostgreSQL | `src/governance/provenance.js` `buildVersionRecord()` writes `summary: params.content` |
| Agent identity before writes | `src/server.js` Gate 3 — `set_agent_context()` required before `remember`/`reflect`/`forget`/`review` |
| `author_type` always `'agent'` | `src/tools/set-agent-context.js` — never accepted from caller input |
| Global write authority (v0.4) | `src/governance/constitutional.js` `enforceGlobalWriteAuthority()` — architect+ only; config-driven via `getConfig()?.is_global === true` |
| Deviation action authority (v0.4) | `src/governance/constitutional.js` `enforceDeviationActionAuthority()` — architect+ only; blocks executive roles |
| Defer deadline (v0.4) | `src/governance/constitutional.js` `enforceValidDeferDeadline()` — must be 30/45/60/90 days |
