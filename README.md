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
                                      │
                              ┌───────┼────────┐
                           Graphiti  Postgres  DynamoDB
```

The MCP server exposes 10 tools to Claude Code. All persistence goes through the Quorum gateway over HTTP — this package never touches a database directly.

---

## Prerequisites

1. A running Quorum gateway — see the [`quorum`](https://github.com/ayansasmal/quorum) repo for setup
2. Node.js ≥ 20
3. Claude Code CLI (`claude`)

---

## Connect to Claude Code

```bash
claude mcp add quorum -- npx -y @as-quorum/mcp
```

Or if running locally from source:

```bash
# from this repo root
npm install
npm run build:all
claude mcp add quorum -- node /path/to/quorum-mcp/dist/server.js
```

Set the gateway URL if it's not on `localhost:3001`:

```bash
export QUORUM_GATEWAY_URL=https://quorum.your-org.internal
```

---

## Tools

| Tool | What it does |
|------|-------------|
| `remember` | Store a decision, pattern, or constraint — versioned, with provenance |
| `recall` | Fetch current version of a specific knowledge entry |
| `search` | Semantic search across the knowledge graph |
| `reflect` | Extract and store learnable knowledge from a completed task |
| `history` | Full version history of an entry (who changed what and when) |
| `export` | Export knowledge as Markdown or Confluence-ready format |
| `forget` | Soft-delete an entry (requires reason ≥ 10 chars, human approval) |
| `review` | Approve or reject a DRAFT entry (no self-approval) |
| `pending` | Surface unresolved conflicts and DRAFTs awaiting review |
| `authenticate` | Inject a GitHub OAuth token for dashboard-linked sessions |

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `QUORUM_GATEWAY_URL` | `http://localhost:3001` | URL of the Quorum gateway |
| `QUORUM_AUTHOR` | git email | Identity override — useful in CI contexts |
| `OPENAI_API_KEY` | — | Required for LLM features (conflict detection, extraction). Tools degrade gracefully without it. |

---

## Install the Quorum skill

The skill teaches Claude Code how to use Quorum automatically — surfacing pending items at session start, recalling context before decisions, and capturing knowledge at task end.

```bash
# copy bundled skill to user-level Claude Code skills directory
cp -r skill/ ~/.claude/skills/quorum/
```

Once installed, Claude Code activates it automatically in any project that has a `.quorum` file.

---

## Project structure

```
src/
  server.js           — MCP entry point, tool registration
  quorum-file.js      — .quorum project file auto-discovery
  tools/              — One file per MCP tool (10 tools)
  governance/         — conflict.js · authority.js · confidence.js · provenance.js
  audit/              — pipeline.js · chain.js · primary.js · secondary.js
  graph/              — client.js (Graphiti) · schema.js · queries.js
  config/             — schema.js · loader.js · quorum.schema.json
  identity/           — resolver.js (4-layer identity chain)
  gateway/
    client.js         — Outbound HTTP client to gateway
  prompts/            — LLM prompt templates (editable Markdown)
cli.js                — quorum CLI (init, install, audit, history)
skill/                — SKILL.md + references/ (bundled with npm)
dist/                 — Compiled output (esbuild, gitignored)
```

---

## Development

```bash
npm install
npm run dev          # node --watch src/server.js (no build step)
npm run build:all    # compile server + CLI → dist/
npm test             # constitutional + governance tests
```

### Governance rules (enforced by tests)

| Rule | Where |
|------|-------|
| No hard delete | `src/graph/client.js` — BLOCKED_METHODS list |
| Audit append-only | `src/audit/pipeline.js` |
| Reason ≥ 10 chars | `src/tools/remember.js`, `src/tools/forget.js` |
| No self-approval | `src/tools/review.js` |
| Claude writes → DRAFT | `src/tools/remember.js` — `storeFirst()` |
| `triggered_by` always set | Schema enforcement — never null |

---

## Backlog

See [docs/BACKLOG.md](docs/BACKLOG.md) for open items.

---

## License

Apache-2.0
