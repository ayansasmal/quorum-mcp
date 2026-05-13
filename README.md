# quorum-mcp

**Governed engineering memory for Claude Code and AI agents.**

`quorum-mcp` is the MCP server package for [Quorum](https://github.com/ayansasmal/quorum) — a temporal knowledge graph that gives Claude Code and multi-agent systems a shared, self-evolving memory of engineering decisions, patterns, and institutional knowledge. It enforces governance: conflict detection, authority weighting, human-in-the-loop approval, and a tamper-evident audit trail.

> **Requires a running Quorum gateway.** This package is the client side only. The gateway + dashboard live in the [`quorum`](https://github.com/ayansasmal/quorum) repo.

---

## How it works

```
Claude Code / AI Agents
        │  MCP (stdio)
        ▼
  quorum-mcp  ──── HTTP ────►  Quorum Gateway (:3001)
               Bearer JWT              │
               X-Quorum-Project    ┌───┴────────┐
                                Graphiti   PostgreSQL
                                   │
                                FalkorDB
```

The MCP server exposes 10 tools to Claude Code. All persistence goes through the Quorum gateway over HTTP — this package never touches a database directly.

**Identity model (v0.3):** the JWT carries only `{ sub, is_admin }`. The active project is sent as the `X-Quorum-Project` header on every request. `resolveCtx()` resolves this from the `.quorum` file in the project root and threads it through all tool calls.

---

## Prerequisites

1. A running Quorum gateway — see the [`quorum`](https://github.com/ayansasmal/quorum) repo for setup
2. Node.js ≥ 20
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

Set the gateway URL if it's not on `localhost:3001`:

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
| `remember` | Store a decision, pattern, or constraint — versioned, with provenance |
| `recall` | Fetch current version of a specific knowledge entry; XML output for Claude context |
| `search` | Semantic search across the knowledge graph; PG ILIKE fallback if Graphiti empty |
| `reflect` | Extract and store learnable knowledge from a completed task (stored as DRAFT) |
| `history` | Full version history of an entry (who changed what, when, and why) |
| `export` | Export knowledge as Markdown or Confluence-ready format |
| `forget` | Soft-delete an entry (requires reason ≥ 10 chars, creates DEPRECATED version) |
| `review` | Approve or reject a DRAFT entry (no self-approval enforced constitutionally) |
| `pending` | Surface unresolved conflicts and DRAFTs awaiting human review |
| `authenticate` | PKCE OAuth 2.1 flow — opens browser to GitHub login, stores slim JWT in-memory |
| `config_upload` | Upload a `<group_id>.quorum.json` config to S3 and sync membership index |

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `QUORUM_GATEWAY_URL` | `http://localhost:3001` | URL of the Quorum gateway |
| `QUORUM_AUTHOR` | git email | Identity override — useful in CI contexts |

> **Authentication:** auth is automatic — every tool checks for a valid JWT and triggers the PKCE browser flow if missing. You do not need to call `authenticate()` manually. The JWT is stored in-memory only and cleared on MCP restart.

---

## Install the Quorum skill and hooks

The skill and hooks make Quorum an always-present part of your engineering SDLC — surfacing pending items at session start, recalling context before decisions, capturing knowledge at task end, and prompting `reflect()` before commits.

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
  tools/              — One file per MCP tool (remember · recall · search · reflect
                        history · export · forget · review · pending · authenticate
                        config_upload)
  governance/         — conflict.js · authority.js · confidence.js · constitutional.js
                        provenance.js (buildVersionRecord — PG summary column write)
  audit/              — pipeline.js · chain.js · primary.js · secondary.js
  graph/              — client.js (Graphiti — group_ids omitted from search calls)
                        schema.js · queries.js
  identity/           — resolver.js (4-layer: JWT sub → QUORUM_AUTHOR → git email → anonymous)
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
  gateway-client.test.js — X-Quorum-Project header threading tests
```

---

## Development

```bash
npm install
npm run build:all    # compile server + CLI → dist/
npm run setup        # install skill, hooks, MCP (alias for: quorum install)
npm run dev          # node --watch src/server.js (no build step needed for MCP server)
npm test             # constitutional + governance + tool tests
```

---

## Governance rules (constitutionally enforced)

| Rule | Where enforced |
|------|---------------|
| No hard delete | `src/graph/client.js` — `BLOCKED_METHODS` list |
| Audit append-only | `src/audit/secondary.js` — `updateEntry`/`deleteEntry` always throw |
| Reason ≥ 10 chars | `src/governance/constitutional.js` — `enforceReason()` |
| No self-approval | `src/governance/constitutional.js` — `enforceNoSelfApproval()` |
| Claude writes → DRAFT | `src/tools/remember.js` — `storeFirst()` checks identity.name |
| `triggered_by` always set | Schema enforcement — null value rejected |
| Content in PostgreSQL | `src/governance/provenance.js` — `buildVersionRecord()` writes `summary: params.content` |

---

## Backlog

See [docs/BACKLOG.md](docs/BACKLOG.md) for open items.

---

## License

Apache-2.0
