# @as-quorum/mcp

Published npm package. Engineers install this to connect Claude Code and AI agents to a Quorum gateway.

```bash
npm install -g @as-quorum/mcp
# or one-step install (registers MCP + copies skill):
npx @as-quorum/mcp install
```

---

## Purpose

MCP server that exposes 14 tools to Claude Code: `set_agent_context`, `remember`, `recall`, `search`, `reflect`, `history`, `export`, `forget`, `review`, `pending`, `authenticate`, `config_upload`, `deviate`, `conformance`.

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
    hooks.js              — Hook inspector/repairer: exact-ID ownership, selective copies, atomic settings backup
  export/                 — markdown.js · confluence.js
  prompts/                — loader.js
cli.js                    — quorum init / quorum install (--skip-mcp / --skip-skill / --skip-hooks) CLI
hooks/                    — 5 Claude Code hook scripts (bundled with npm; installed to ~/.claude/hooks/)
skill/                    — SKILL.md + references/ (bundled with npm package)
dist/                     — Compiled output (esbuild, gitignored)
tests/integration/        — MCP integration tests (require running gateway); excluded from npm test
  helpers/tokens.js       — JWT factories (re-exports from quorum/e2e/helpers/jwt.js)
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
npm test             # run all unit tests (41 files, 645 tests) — excludes integration tests
npm test -- --coverage  # with v8 coverage report (75% threshold: lines, branches, functions)
npm run test:constitutional  # Layer 1 only (blocking CI gate)

# Release automation:
npm run release:patch   # or release:minor / release:major
git push --follow-tags  # triggers .github/workflows/release.yml

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

**Logs + verbose tracing:** `quorum-mcp` always writes a shared JSONL log to `~/.quorum/mcp.log` and creates one per-call JSONL log per tool invocation under `~/.quorum/calls/<timestamp>_<tool>.log`. Error responses return the active per-call path via `debug_log` when available. `QUORUM_TRACE_VERBOSE=true` adds end-to-end raw payload tracing to those same files: MCP tool inputs/results, outbound gateway request/response payloads, and governance payloads derived before `/governance/*` gateway calls. Keep it off by default for published installs; turn it on explicitly in local shells or Claude config when debugging.

**Config loader resilience (`src/config/loader.js`):** the module caches config in `_config`; `getConfig()` **throws** `"Config not loaded"` when `_config === null`. Because Claude can spawn/reconnect stdio MCP processes, a fresh process whose `startup()` `loadConfig()` had not yet completed (or hung on a probe) would make every `getConfig()`-dependent tool fail. Three guards prevent this:
- `getConfigSafe()` / `isConfigLoaded()` — non-throwing reads. Write-path flag reads in `remember.js` (`is_global`, `globals`) use `getConfigSafe()?.…` so an unloaded config **degrades** the MCP-side global-write check to `false` instead of failing the tool. This is safe defence-in-depth: the **authoritative** global-write guard is the gateway-side `enforceGlobalWriteAuthority()`.
- **Lazy-ensure** — `remember()`'s handler calls `if (!isConfigLoaded()) await loadConfig(pg)` before any config-dependent enforcement, so a process that never finished startup still loads config on first write.
- **Infallible `buildEnvFallback()`** — if the env-fallback schema parse throws, the raw default shape is returned (logged) rather than leaving `_config` null. `loadConfig()` also clears any existing `_pollTimer` before re-arming, so the lazy-load path cannot leak interval timers.

This contract is **vendored** — the gateway copy at `gateway/src/shared/config/loader.js` mirrors `getConfigSafe`/`isConfigLoaded`/the infallible fallback/the timer guard and must stay in sync.

**`database` override (physical graph placement, decoupled from `group_id`):** `src/graph/client.js`'s `addEpisode(content, metadata, groupId, database)` and `addSupersedingEpisode(newContent, oldEpisodeId, metadata, groupId, database)` accept a trailing optional `database` parameter, forwarded into the `add_memory` MCP tool call only when defined. It selects which physical FalkorDB database an episode is written to, independent of `group_id` (logical isolation, unchanged). In gateway mode this MCP-side parameter is not itself the enforcement point — the gateway's `routes/graphiti.js` write-path proxy is the one that actually injects `database` server-side, based on the caller's `migrated_to_shared_graph` config flag (`gateway/src/shared/config/schema.js`, mirrored in `src/config/schema.js`). This client-side parameter exists so both vendored copies stay structurally identical and so direct (non-gateway) callers of `addEpisode`/`addSupersedingEpisode` can also pass it explicitly. Traces back to `database: str | None = None` on `graphiti_core.Graphiti.add_episode` in the quorum-graphiti fork.

**Hook installation safety:** `inspectHooks()` validates bundled scripts and Claude settings before any mutation. `installHooks()` repairs only the exact managed IDs in `QUORUM_HOOKS`, preserves unrelated and unknown legacy Quorum hooks, copies only missing/stale scripts, fixes executable mode, and leaves a correct installation untouched. Settings repair writes a sibling temporary file, backs up the previous file to `settings.json.bak`, then atomically renames. Malformed JSON, non-object roots/hooks, or non-array managed events abort before script or settings changes.

**Hook install reporting:** `formatHookInstallReport()` is the shared output contract for `cli.js` and `src/install/postinstall.js`. Callers must render its returned lines rather than inferring success from `installHooks()` so no-op, repaired scripts, repaired settings IDs, and backup paths stay consistent.

**Cold-start onboarding:** `authenticate` accepts empty input and `config_upload` is exempt from the no-project-context gate. Verify this through an MCP `Client` + `InMemoryTransport`, not by calling handlers directly.

> Full chronological history — v0.4 waves A through G, and every dated post-Wave-G fix (header derivation, `resolveGlobals()`, search concurrency throttle, stale-session reset): [docs/CHANGELOG.md](docs/CHANGELOG.md)

**Agent identity (v0.3):** `set_agent_context({ agent_id })` is Gate 3 — must be called before any write tool (`remember`, `reflect`, `forget`, `review`). `agent_id` is validated as `^[a-z][a-z0-9-]{0,39}$`. `session_id` is derived server-side from `hash(PID + hrtime.bigint())` → `sess_` + 8 hex chars. `author_type` is always `'agent'` (never caller-supplied) — distinguishes agent MCP writes from human dashboard writes (`author_type: 'human'` on all dashboard create/promote/supersede/deprecate actions). All three fields are written to `knowledge_versions.agent_id`, `.session_id`, `.author_type` via `buildVersionRecord()`.

**Skill + Hooks:** Install with `npx @as-quorum/mcp install`. Copies `skill/SKILL.md` to `~/.claude/skills/quorum/`, copies `hooks/quorum-*.sh` to `~/.claude/hooks/`, merges hook wiring into `~/.claude/settings.json`, and runs `claude mcp add`. Use `--skip-mcp`, `--skip-skill`, or `--skip-hooks` to skip individual steps. Hooks are self-limiting: each script checks `[ -f ".quorum" ] || exit 0` — silent in any project without a `.quorum` sentinel file.

---

## Non-Negotiable Rules (enforced by constitutional tests)

| Rule | Location |
|------|----------|
| No hard delete | `src/graph/client.js` `BLOCKED_METHODS` |
| Audit append-only | `src/audit/secondary.js` — `updateEntry`/`deleteEntry` always throw |
| Reason ≥ 10 chars | `src/governance/constitutional.js` `enforceReasonRequired()` |
| No self-approval | `src/governance/constitutional.js` `enforceNoSelfApproval()` |
| Claude writes → DRAFT | `src/tools/remember.js` `storeFirst()` — `author === 'claude'` forces DRAFT |
| `triggered_by` always set | Schema enforcement — null value rejected |
| Content in PostgreSQL | `src/governance/provenance.js` `buildVersionRecord()` writes `summary: params.content` |
| Agent identity before writes | `src/server.js` Gate 3 — `set_agent_context()` required before `remember`/`reflect`/`forget`/`review` |
| `author_type` always `'agent'` | `src/tools/set-agent-context.js` — never accepted from caller input |
| Global write authority (v0.4) | `src/governance/constitutional.js` `enforceGlobalWriteAuthority()` — architect+ only; config-driven via `getConfig()?.is_global === true` |
| Deviation action authority (v0.4) | `src/governance/constitutional.js` `enforceDeviationActionAuthority()` — architect+ only; blocks executive roles |
| Defer deadline (v0.4) | `src/governance/constitutional.js` `enforceValidDeferDeadline()` — must be 30/45/60/90 days |
