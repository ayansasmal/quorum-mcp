# @as-quorum/mcp

Published npm package. Engineers install this to connect Claude Code and AI agents to a Quorum gateway.

```bash
npm install -g @as-quorum/mcp
# or one-step install (registers MCP + copies skill):
npx @as-quorum/mcp install
```

---

## Purpose

MCP server that exposes 11 tools to Claude Code: `remember`, `recall`, `search`, `reflect`, `history`, `export`, `forget`, `review`, `pending`, `authenticate`, `config_upload`.

Always communicates with a Quorum gateway over HTTP. **Never connects to PostgreSQL directly.** Default gateway URL: `http://localhost:3001` (local dev Docker stack).

**Identity model (v0.3):** the JWT carries only `{ sub, is_admin }`. The active project is sent as the `X-Quorum-Project` header on every request. `resolveCtx()` reads the `.quorum` file in the project root and threads project context through all tool calls.

**Dual-store audit pipeline:** every tool call writes INTENT + OUTCOME entries to PostgreSQL (durable, SHA256 tamper-evident chain) and Graphiti (semantic traversal). If Graphiti is unavailable, writes are stored as `PENDING_CONFLICT_CHECK` in PostgreSQL for later reprocessing. The `summary` column in `knowledge_versions` is the canonical durable content store — survives FalkorDB volume wipes.

---

## Key Files

```
src/
  server.js               — Entry point: startup, tool registration, health endpoint
  quorum-file.js          — .quorum project file auto-discovery (sets env vars)
  tools/                  — One file per MCP tool
  governance/             — conflict.js · authority.js · confidence.js · provenance.js
  audit/                  — pipeline.js · chain.js · primary.js · secondary.js
  graph/                  — client.js (Graphiti) · schema.js · queries.js (pg-compat + GatewayClient duck-type)
  config/                 — schema.js · loader.js · quorum.schema.json
  identity/               — resolver.js (4-layer identity chain)
  gateway/
    client.js             — Outbound HTTP client to gateway (NOT the gateway server)
  install/
    hooks.js              — Hook script installer: copies hooks/, merges settings.json (idempotent)
  export/                 — markdown.js · confluence.js
  prompts/                — loader.js
cli.js                    — quorum init / quorum install (--skip-mcp / --skip-skill / --skip-hooks) CLI
hooks/                    — 5 Claude Code hook scripts (bundled with npm; installed to ~/.claude/hooks/)
skill/                    — SKILL.md + references/ (bundled with npm package)
dist/                     — Compiled output (esbuild, gitignored)
```

---

## Development

```bash
npm run build:all    # compile src/server.js + cli.js → dist/
npm run dev          # node --watch src/server.js (uncompiled, for local dev)
npm run start        # run compiled dist/server.js
npm test             # run all tests (35 files, 541 tests)
npm test -- --coverage  # with v8 coverage report (75% threshold: lines, branches, functions)
npm run test:constitutional  # Layer 1 only (blocking CI gate)
```

---

## Architecture Constraints

**Never add `pg` calls to new code.** The `pg` parameter on functions in `graph/queries.js` and `audit/secondary.js` is kept for backward-compat with gateway's workspace import — those functions duck-type: `if (typeof pg.methodName === 'function') return pg.methodName(...)` and fall through to raw SQL only when a real `pg.Pool` is passed (which only the gateway does).

**GatewayClient** (`src/gateway/client.js`) is the only persistence interface the MCP uses. It implements typed methods — `getCurrentVersion()`, `insertVersion()`, `writeAuditEntry()`, etc. — that map to the gateway's `/pg/*` REST API. Every request carries a `Bearer` JWT and `X-Quorum-Project` header. Its `query()` method throws intentionally.

**Identity:** Resolved once per session (from JWT in gateway mode). Never accepted as tool input — server-side only.

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
