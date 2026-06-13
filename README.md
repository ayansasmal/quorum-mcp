# quorum-mcp

**Governed engineering and business memory for Claude Code and AI agents.**

[![npm](https://img.shields.io/npm/v/@as-quorum/mcp?label=%40as-quorum%2Fmcp&color=cb0000&logo=npm)](https://www.npmjs.com/package/@as-quorum/mcp)
[![Tests](https://img.shields.io/badge/tests-620%20passing-brightgreen?logo=vitest&logoColor=white)](https://github.com/ayansasmal/quorum-mcp)
[![Coverage — Lines](https://img.shields.io/badge/lines-86%25-brightgreen)](https://github.com/ayansasmal/quorum-mcp)
[![Coverage — Branches](https://img.shields.io/badge/branches-79%25-brightgreen)](https://github.com/ayansasmal/quorum-mcp)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-blueviolet?logo=anthropic)](https://modelcontextprotocol.io)
[![Gateway](https://img.shields.io/badge/requires-Quorum%20Gateway-orange)](https://github.com/ayansasmal/quorum)
[![License](https://img.shields.io/badge/license-ELv2-blue)](LICENSE)

`quorum-mcp` is the MCP server package for [Quorum](https://github.com/ayansasmal/quorum) — a temporal knowledge graph that gives Claude Code and multi-agent systems a shared, self-evolving memory of engineering decisions, business requirements, patterns, and institutional knowledge. It enforces governance: conflict detection, authority weighting, human-in-the-loop approval, and a tamper-evident audit trail.

Quorum stores two complementary types of knowledge:
- **Engineering knowledge** — the technical *why* and *how*: architectural decisions, patterns, constraints, runbooks
- **Business knowledge** — the product *why* and *when*: feature requirements, business rules, compliance constraints

Both are governed identically and accessible to anyone on the team via Claude.

> **Requires a running Quorum gateway.** This package is the client side only. The gateway + dashboard live in the [`quorum`](https://github.com/ayansasmal/quorum) repo.

---

## How it works

```
Claude Code / AI Agents / PMs / BAs
        │  MCP (stdio)
        ▼
  quorum-mcp  ──── HTTP ────►  Quorum Gateway (:3001)
               Bearer JWT              │
               X-Quorum-Project    ┌───┴────────────────┐
                                Graphiti          PostgreSQL
                                   │              (audit chain)
                                FalkorDB
```

The MCP server exposes 14 tools to Claude. All persistence goes through the Quorum gateway over HTTP — this package never touches a database directly.

**Identity model:** the JWT carries only `{ sub, is_admin }`. The active project is sent as the `X-Quorum-Project` header on every request. `resolveCtx()` resolves this from the `.quorum` file in the project root and threads it through all tool calls. Executive roles (`director`, `vp_engineering`, `group_executive`) are blocked from deviation governance actions by `enforceDeviationActionAuthority()`.

**Dual-store audit pipeline:** every tool call writes INTENT + OUTCOME entries to PostgreSQL (durable, SHA256 tamper-evident chain) and Graphiti (semantic traversal). If Graphiti is unavailable, writes are stored as `PENDING_CONFLICT_CHECK` in PostgreSQL for later reprocessing.

---

## Prerequisites

1. A running Quorum gateway — see the [`quorum`](https://github.com/ayansasmal/quorum) repo for setup
2. Node.js ≥ 22
3. Claude Code CLI (`claude`)

---

## Connect to Claude Code

```bash
npm install -g @as-quorum/mcp
quorum install
```

`quorum install` sets up everything in one step:
- Copies the skill to `~/.claude/skills/quorum/`
- Installs the 5 hook scripts to `~/.claude/hooks/`
- Wires hook entries into `~/.claude/settings.json`
- Registers the MCP server at user scope via `claude mcp add --scope user`

Set the gateway URL — **required** (there is no default):

```bash
export QUORUM_GATEWAY_URL=https://quorum.your-org.internal
```

Then connect a project:

```bash
cd your-project
quorum init        # creates .quorum file with project group_id
```

---

## Tools

| Tool | What it does |
|------|-------------|
| `set_agent_context` | Register agent identity before any write — required gate before `remember`/`reflect`/`forget`/`review` |
| `remember` | Store a decision, pattern, constraint, or requirement — versioned, with provenance |
| `recall` | Fetch current version of a specific knowledge entry; XML output for Claude context; annotated `source: 'global'` for catalog entries |
| `search` | Semantic search across the knowledge graph and linked global catalogs; results annotated `source`/`catalog_id` |
| `reflect` | Extract and store learnable knowledge from a completed task (stored as DRAFT) |
| `history` | Full version history of an entry (who changed what, when, and why) |
| `export` | Export knowledge as Markdown or Confluence-ready format |
| `forget` | Soft-delete an entry (requires reason ≥ 10 chars, creates DEPRECATED version) |
| `review` | Approve or reject a DRAFT entry (no self-approval enforced constitutionally) |
| `pending` | Surface unresolved conflicts, DRAFTs, open deviations, and overdue deferrals awaiting human review |
| `authenticate` | PKCE OAuth 2.1 flow — opens browser to GitHub login, stores slim JWT in-memory |
| `config_upload` | Upload a `<group_id>.quorum.json` config to S3 and sync membership index |
| `deviate` | Record a deviation from a global catalog entry — idempotent upsert, severity derived server-side |
| `conformance` | Return project conformance score (0–100%) or UNCERTIFIED status with linked catalog breakdown |

---

### Content constraints (enforced by gateway and MCP)

| Field | Constraint |
|-------|-----------|
| `content` | Max 500 chars, plain text — no `<` or `>` characters |
| `topic` | Kebab-case slug, max 60 chars (e.g. `auth`, `db-layer`, `product`, `compliance`) |
| `key` | Kebab-case slug, max 80 chars (e.g. `token-strategy`, `guest-checkout-requirement`) |
| `tags` | Max 10 tags, each kebab-case, max 40 chars |
| `reason` | Min 10 chars, max 500 chars, plain text |
| `confidence` | Float 0.5–1.0 |

These limits are enforced at the Zod layer (MCP) and the gateway validation layer. Violations return a structured error before any network call.

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `QUORUM_GATEWAY_URL` | *(required — no default)* | URL of the Quorum gateway. Set in your shell or via `claude mcp add -e`. |
| `QUORUM_AUTHOR` | git email | Identity override — useful in CI contexts |

> **Authentication:** auth is automatic — every tool checks for a valid JWT and triggers the PKCE browser flow if missing. You do not need to call `authenticate()` manually. The JWT is stored in-memory only and cleared on MCP restart.
>
> **Cold start:** `authenticate` does not require a `project_id`. A GitHub-authenticated user with no existing memberships can obtain a JWT and call `config_upload` before a `.quorum` file exists; project context begins only after the first config is uploaded.

---

## Install the Quorum skill and hooks

The skill and hooks make Quorum an always-present part of your team's SDLC — surfacing pending items at session start, recalling context before decisions, capturing knowledge at task end, and prompting `reflect()` before commits.

```bash
npx @as-quorum/mcp install
```

This installs three things:
1. Copies the bundled skill to `~/.claude/skills/quorum/`
2. Copies 5 Claude Code hook scripts to `~/.claude/hooks/` and wires them into `~/.claude/settings.json`
3. Registers the MCP server with `claude mcp add`

To skip individual steps:
```bash
npx @as-quorum/mcp install --skip-mcp    # skill + hooks only
npx @as-quorum/mcp install --skip-skill  # hooks + MCP registration only
npx @as-quorum/mcp install --skip-hooks  # skill + MCP registration only
```

**Activating hooks in a project:** create a `.quorum` file in the project root with the project group_id on line 1. Hooks are self-limiting — they are silent in any directory without this file.

```bash
echo "my-project-group-id" > .quorum
```

---

## Project structure

```
src/
  server.js           — MCP entry point, tool registration, resolveCtx()
  quorum-file.js      — .quorum project file auto-discovery
  tools/              — One file per MCP tool (set_agent_context · remember · recall · search
                        reflect · history · export · forget · review · pending
                        authenticate · config_upload · deviate · conformance)
  governance/         — conflict.js · authority.js · confidence.js · constitutional.js
                        provenance.js (buildVersionRecord — writes to PG summary column)
  audit/              — pipeline.js · chain.js · primary.js · secondary.js
  graph/              — client.js (Graphiti — BLOCKED_METHODS enforced)
                        schema.js · queries.js
  identity/           — resolver.js (4-layer: JWT sub → QUORUM_AUTHOR → git email → anonymous)
  config/             — loader.js · migrations.js · schema.js
  gateway/
    client.js         — HTTP client: Bearer JWT + X-Quorum-Project header on every request
  install/
    hooks.js          — Hook script installer
    postinstall.js    — registerMcpServer() via `claude mcp add --scope user`
  prompts/            — LLM prompt templates (editable Markdown)
cli.js                — quorum CLI (init · install · audit · history)
hooks/                — 5 Claude Code hook scripts (bundled with npm)
skill/                — SKILL.md + references/ (bundled with npm)
tests/
  constitutional/     — Layer 1: invariant tests (100% coverage required)
  governance/         — Layer 2: conflict detection, authority, confidence
  tools/              — Per-tool handler tests (remember · recall · reflect · ...)
  audit/              — pipeline.test.js · secondary.test.js
  graph/              — queries.test.js
  identity/           — resolver.test.js
  gateway/            — gateway-client.test.js · gateway-client-extended.test.js
```

---

## Development

```bash
npm install
npm run build:all    # compile server + CLI → dist/
npm run setup        # install skill, hooks, MCP (alias for: quorum install)
npm run dev          # node --watch src/server.js (no build step needed for MCP server)
npm test             # run all tests (37 files, 620 tests)
npm test -- --coverage  # coverage report (lines 86%, branches 79%, functions 84%)
```

> **Important:** the MCP server runs from `dist/server.js` (esbuild bundle). Source edits require `npm run build:all` before changes take effect in Claude Code.

---

## Test coverage

| Metric | Coverage | Threshold |
|--------|----------|-----------|
| Lines | **86%** | 75% |
| Branches | **79%** | 75% |
| Functions | **84%** | 75% |

Test files: **37** · Tests: **620 passing**

Coverage provider: v8 · Excluded from coverage pool: `server.js`, `quorum-file.js`, `prompts/loader.js`, `install/postinstall.js`, `config/loader.js` (S3/file I/O), `config/migrations.js` (DB schema migrations).

---

## Governance rules (constitutionally enforced)

| Rule | Where enforced |
|------|---------------|
| No hard delete | `src/graph/client.js` — `BLOCKED_METHODS` list |
| Audit append-only | `src/audit/secondary.js` — `updateEntry`/`deleteEntry` always throw |
| Reason ≥ 10 chars | `src/governance/constitutional.js` — `enforceReasonRequired()` |
| No self-approval | `src/governance/constitutional.js` — `enforceNoSelfApproval()` |
| Claude writes → DRAFT | `src/tools/remember.js` — `storeFirst()` checks identity |
| `triggered_by` always set | Schema enforcement — null value rejected |
| Content in PostgreSQL | `src/governance/provenance.js` — `buildVersionRecord()` writes `summary: params.content` |
| Agent identity before writes | `src/server.js` Gate 3 — `set_agent_context()` required before `remember`/`reflect`/`forget`/`review` |
| `author_type` always `'agent'` | `src/tools/set-agent-context.js` — never accepted from caller input |
| Global write authority (v0.4) | `src/governance/constitutional.js` `enforceGlobalWriteAuthority()` — architect+ only; config-driven via `getConfig()?.is_global === true` |
| Deviation action authority (v0.4) | `src/governance/constitutional.js` `enforceDeviationActionAuthority()` — architect+ only; blocks executive roles |
| Defer deadline (v0.4) | `src/governance/constitutional.js` `enforceValidDeferDeadline()` — must be 30/45/60/90 days |

---

## Shipped bug fixes

| Bug | Description | Fix |
|-----|-------------|-----|
| **D** | `recall()` read `version.content` — always undefined; PostgreSQL stores content in `summary` column | `version.summary ?? version.content` |
| **E** | `storePendingConflictCheck` passed `project_id` (snake_case) to `buildVersionRecord` which expects `projectId` (camelCase) — always threw | renamed to `projectId` |
| **F** | `primary.writeEntry()` embedded `groupId` inside the metadata object instead of as the third positional arg to `addEpisode(content, metadata, groupId)` — every audit write failed silently | moved to third positional arg |

---

## Documentation

A curated index of the docs bundled with this package. (Backend gateway/dashboard docs live in the [`quorum`](../quorum/README.md) repo; the workspace-level index is at [`../README.md`](../README.md).)

### Skill — installed into Claude Code

| Doc | What's in it |
|-----|--------------|
| [skill/SKILL.md](skill/SKILL.md) | The Quorum skill — full MCP tool usage guide loaded into Claude Code |
| [skill/references/tool-reference.md](skill/references/tool-reference.md) | Per-tool schemas and parameters for all 14 tools |
| [skill/references/onboarding.md](skill/references/onboarding.md) | Connecting a project to a Quorum stack (login + federation setup) |
| [skill/references/login.md](skill/references/login.md) | Authentication flow for the MCP server |
| [skill/references/conflict-resolution.md](skill/references/conflict-resolution.md) | Resolving conflicts surfaced by `remember()` |
| [skill/references/knowledge-guidelines.md](skill/references/knowledge-guidelines.md) | What makes good knowledge — writing guidance |
| [skill/references/scan.md](skill/references/scan.md) | `quorum:scan` conformance scan orchestration |

### Testing & internals

| Doc | What's in it |
|-----|--------------|
| [docs/MCP-TEST-PLAN.md](docs/MCP-TEST-PLAN.md) | Risk-weighted MCP integration test plan — 6 journeys (M-01–M-06), 54 leaves, OwnScore 655 |
| [docs/journey-story-04-06-2026-mcp.md](docs/journey-story-04-06-2026-mcp.md) | MCP integration journey narratives (J-MCP-01 … J-MCP-06) |
| [src/prompts/](src/prompts/) | Editable LLM prompt templates — contradiction check, knowledge extraction, enrichment |

---

## License

Elastic License 2.0 — see [LICENSE](LICENSE). Self-hosting is permitted. You may not offer Quorum as a managed service or distribute modified copies.
