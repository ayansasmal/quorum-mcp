# quorum-mcp — Backlog

> MCP server backlog. Gateway/dashboard backlog lives in the `quorum` repo.
>
> **Columns:** 🔴 Bug · 🟡 To Do · 🔵 In Progress · ✅ Done
> **Priority:** P1 (now) → P7 (later)

---

## Board

| ID | Title | Priority | Status | Notes |
|----|-------|----------|--------|-------|
| BL-02 | Port `cli.js` to GatewayClient HTTP | P2 | ✅ Done | pg removed. All commands use GatewayClient. `audit lineage` deferred — needs gateway endpoint. |
| BL-02a | `GET /pg/audit/lineage/:topic/:key` gateway endpoint | P3 | ✅ Done | Added to `gateway/src/routes/pg.js`. Used by `scripts/audit-cli.js lineage`. |
| BL-03 | `npx quorum start` command | P2 | 🟡 To Do | Blocked on BL-07 (lite compose). `bin` field + npm org already done. |
| BL-04 | LLM retry in conflict detection | P3 | 🟡 To Do | Retry wrapper on `gw._post('/governance/detect-conflict')` — 3 attempts with backoff. |
| BL-07 | Graphiti graceful degradation in `graph/client.js` | P5 | 🟡 To Do | `graphitiAvailable` flag — lite compose lives in the `quorum` repo. |
| BL-10 | MCP OAuth 2.1 client auth flow | P2 | ✅ Done | Full PKCE flow in authenticate.js. Graceful degradation when BL-12 not live. |
| BL-08 | `ingest_pr()` MCP tool | P6 | 🟡 To Do | `dry_run: true` default. GitHub Action deferred to v1.0. |
| BL-09 | Prompt rendering unit tests | P7 | 🟡 To Do | Pure function tests + manual validation script. No LLM calls in CI. |

---

## Detail

### ✅ BL-02 — Port `cli.js` to GatewayClient HTTP
**File:** `cli.js`

`pg` was removed from `package.json` but `cli.js` still creates a direct `pg.Pool`.
These commands will crash with `Cannot find package 'pg'` when installed from npm:

| Command | Currently | Replace with |
|---------|-----------|--------------|
| `quorum history <topic:key>` | `historyHandler(pool, ...)` | `gw.getVersionHistory(topic, key)` |
| `quorum audit verify` | `getAllEntries(pool)` | `gw.getAllEntries({})` |
| `quorum audit export` | `getAllEntries(pool, opts)` | `gw.getAllEntries(opts)` |
| `quorum audit stats` | `pool.query(...)`, `countEntries(pool)` | `gw.countEntries()` |
| `quorum audit lineage` | `pool.query(...)` | `gw.getAllEntries({})` + local filter |

Use `getGatewayClient()` after loading `.quorum` file defaults at CLI startup.

**Acceptance criteria:**
- [ ] `import pg from 'pg'` removed from `cli.js`
- [ ] All commands work via gateway HTTP
- [ ] `grep -r "from 'pg'" .` returns no output

---

### 🟡 BL-03 — `npx quorum start` command
**File:** `cli.js`

Foundation already done: `bin.quorum = ./dist/cli.js` in `package.json`, npm org `as-quorum` created, `quorum init` works.

Missing: the `start` subcommand that launches the lite Docker stack (defined in `quorum` repo).

```js
program
  .command('start')
  .description('Start the Quorum local stack (lite mode — no Graphiti)')
  .action(() => {
    // spawn docker compose -f <bundled lite compose> up -d
  })
```

**Blocked on:** BL-07 (lite compose must exist in `quorum` repo first)

**Acceptance criteria:**
- [ ] `npx quorum start` pulls and starts the lite stack
- [ ] `npx quorum stop` brings it down
- [ ] README updated with one-liner install

---

### 🟡 BL-04 — LLM retry + `reflect()` fallback + startup check
**Files:** `src/governance/conflict.js` · `src/tools/reflect.js` · `src/server.js`

Three independent changes, one commit:

**1. Retry wrapper** (`conflict.js`)
Wrap `callLLM()` with 3-attempt exponential backoff (200ms → 400ms → 800ms).
Covers all three call sites: contradiction check, enrichment, extraction.

**2. `reflect()` fallback** (`reflect.js`)
When `extractKnowledge()` returns `[]` (missing API key or LLM error), store the raw
task summary as a single DRAFT observation:
```js
{ confidence: 0.35, entity_type: 'observation', content: taskSummary, tags: ['unextracted'] }
```
The `unextracted` tag makes it easy to find and re-process later.

**3. Startup env check** (`src/server.js`, 1 line)
```js
if (!process.env.OPENAI_API_KEY)
  console.error('[Quorum] WARNING: OPENAI_API_KEY not set — LLM features disabled')
```

**Acceptance criteria:**
- [ ] Transient LLM 500s are retried up to 3 times with backoff
- [ ] `reflect()` always stores something even without LLM
- [ ] Missing API key is logged at startup, not silently swallowed

---

### 🟡 BL-07 — Graphiti graceful degradation (`graph/client.js`)
**File:** `src/graph/client.js`

Note: the lite `docker-compose.lite.yml` lives in the `quorum` repo. This item covers only the client-side degradation flag.

```js
let graphitiAvailable = false

export async function ping() {
  try {
    const res = await fetch(`${GRAPHITI_URL}/health`, { signal: AbortSignal.timeout(2000) })
    graphitiAvailable = res.ok
  } catch {
    graphitiAvailable = false
  }
  return graphitiAvailable
}

// All search/graph functions check the flag first
export async function searchNodes(query, groupId) {
  if (!graphitiAvailable) return { results: [], degraded: true }
  // ... existing code
}
```

**Acceptance criteria:**
- [ ] Server starts and tools work when Graphiti is unavailable
- [ ] `search()` returns `degraded: true` instead of throwing

---

### 🟡 BL-08 — `ingest_pr()` MCP tool
**Files (new):** `src/pr/github.js` · `src/pr/extractor.js` · `src/tools/ingest_pr.js`

```
ingest_pr({ pr_url: "https://github.com/org/repo/pull/123", dry_run: true })
```

- `dry_run: true` (default) — returns would-be DRAFTs for review, stores nothing
- `dry_run: false` — stores via `remember()` with `triggered_by: 'ingest_pr'`
- If a `principal_architect` approved the PR, elevate extracted confidence +0.10
- GitHub Action for automatic ingest deferred until extraction quality validated

**Acceptance criteria:**
- [ ] `dry_run: true` returns extracted items without storing
- [ ] `dry_run: false` stores via the normal `remember()` pipeline
- [ ] Principal architect approval elevates confidence
- [ ] Works with `GITHUB_TOKEN` env for private repos

---

### 🟡 BL-09 — Prompt rendering unit tests
**Files:** `tests/governance/prompt-rendering.test.js` · `scripts/validate-prompts.js`

Three LLM prompts live in `src/prompts/` and are editable. Tests cover the
deterministic parts (rendering, parsing) — not LLM output quality.

1. Unit-test: `buildConflictPrompt(node1, node2)` produces expected string
2. Unit-test: LLM response parser handles all shapes (object, array, null, malformed JSON)
3. `scripts/validate-prompts.js` — 5–10 labelled fixture cases, run manually before a model upgrade

**Acceptance criteria:**
- [ ] Prompt rendering functions have unit tests
- [ ] Parser handles malformed LLM output without throwing
- [ ] Manual validation script exists and is documented in CONTRIBUTING.md

---

### ✅ BL-10 — MCP OAuth 2.1 client auth flow
**Files:** `src/gateway/client.js` · `src/tools/authenticate.js` · `src/server.js`

**Note:** Client-side flow is implemented. Requires quorum BL-12 (gateway OAuth 2.1 server) to be live for end-to-end operation. Graceful degradation returns `oauth_not_available` status when gateway doesn't expose `/.well-known/oauth-authorization-server`.

Replaced the GitHub PAT injection model with the standard MCP OAuth 2.1 Authorization Code + PKCE flow. Zero env vars needed for MCP auth.

**Implemented flow:**
1. `authenticate()` tool called (or re-auth to switch project)
2. Discovers `/.well-known/oauth-authorization-server` on gateway
3. Registers dynamically via `POST /oauth/register` → receives `client_id`
4. Generates PKCE `code_verifier` (32 random bytes, base64url) + `code_challenge` (SHA256/S256)
5. Starts local HTTP callback listener on `listen(0)` (random ephemeral port)
6. Opens browser to gateway `/oauth/authorize` with PKCE + `state`
7. Engineer authenticates with GitHub inside gateway — MCP never sees GitHub token
8. Gateway redirects to `127.0.0.1:<port>/callback?code=...&state=...`
9. MCP validates `state` (CSRF protection), exchanges `code + verifier` via `POST /oauth/token`
10. Stores Gateway-MCP Token (ES256 JWT) via `setGatewayToken()` — in-memory only
11. `isAuthenticated()` gates all subsequent tool calls

**Acceptance criteria:**
- [x] Zero env vars needed for MCP auth
- [x] Local callback listener starts on a random available port (`listen(0)`)
- [x] PKCE `S256` used — `code_verifier` never sent until token exchange
- [x] Token stored in-memory only — cleared on MCP process restart
- [x] `authenticate()` tool triggers re-auth (pass `project_id` to switch project)
- [x] Works with Claude Code, Cursor, and any MCP-compliant client
- [ ] `QUORUM_GITHUB_TOKEN` removed from identity/resolver.js (kept as fallback Layer 1 for pre-auth identity resolution — may clean up in v1.0)

---

## Deferred to v1.0

| Item | Reason |
|------|--------|
| GitHub Action for PR ingest | After BL-08 manual quality validated |
| LLM accuracy CI gate | Needs real usage data for golden dataset |

---

## Changelog

| Date | Item | Commit |
|------|------|--------|
| 2026-05-06 | Tests migrated from engram monorepo — constitutional + governance + tools | 747eeb6 |
| 2026-05-06 | BL-02a: `GET /pg/audit/lineage/:topic/:key` added to gateway (engram) | f98a174 |
| 2026-05-06 | BL-12: OAuth 2.1 Authorization Server in gateway — unblocks BL-10 end-to-end | f98a174 |
| 2026-05-04 | BL-10: MCP OAuth 2.1 + PKCE flow — full client-side implementation | f37f560 |
| 2026-05-04 | Remove OPENAI_API_KEY from MCP — conflict/enrich/extract route through gateway | 9066c8f |
| 2026-05-04 | BL-02: pg removed from cli.js — all commands now use GatewayClient HTTP | 9b6618b |
| 2026-05-04 | `quorum install` CLI command — copies skill + runs `claude mcp add` | 9b6618b |
| 2026-05-04 | Repo split from monorepo — `mcp/` extracted to `quorum-mcp` | 7a904bc |
