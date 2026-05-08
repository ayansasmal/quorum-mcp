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
| BL-10 | MCP OAuth 2.1 client auth flow | P2 | ✅ Done | Full PKCE flow in authenticate.js. Gateway BL-12 also ✅ Done — full OAuth round-trip live. |
| BL-08 | `ingest_pr()` MCP tool | P6 | 🟡 To Do | `dry_run: true` default. GitHub Action deferred to v1.0. |
| BL-13 | SDLC hooks + SKILL.md enforcement | P2 | ✅ Done | 5 hook scripts + `src/install/hooks.js` + `quorum install --skip-hooks`. SKILL.md updated with "ALWAYS invoke", hook signal table, pull-side recall gate. |

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

### ✅ BL-13 — SDLC hooks + SKILL.md enforcement
**Files:** `hooks/quorum-*.sh` · `src/install/hooks.js` · `tests/install/hooks.test.js` · `skill/SKILL.md` · `cli.js` · `package.json`

5 Claude Code hooks that make Quorum an always-present part of the engineering SDLC:

| Hook | Event | Signal |
|------|-------|--------|
| `quorum-session-start.sh` | `UserPromptSubmit` | `[QUORUM: session_start_required]` — once per calendar day per project |
| `quorum-stop.sh` | `Stop` | `[QUORUM: N file(s) changed — reflect?]` — when ≥3 files changed and reflect not done |
| `quorum-pre-commit.sh` | `PreToolUse: Bash` | `[QUORUM: pre-commit]` + staged file list |
| `quorum-task-complete.sh` | `PostToolUse: TodoWrite` | `[QUORUM: task-completed]` — when a task status becomes "completed" |
| `quorum-knowledge-source.sh` | `PostToolUse: Write/Edit` | `[QUORUM: knowledge-source-updated]` — memory files and CLAUDE.md only |

All hooks guard with `[ -f ".quorum" ] || exit 0` — self-limiting, silent in non-connected projects.

`src/install/hooks.js` — idempotent installer: copies scripts to `hooksDir`, merges hook wiring into `settings.json` without destroying existing entries. Fail-fast on missing scripts and corrupt settings.json.

`skill/SKILL.md` updated: "ALWAYS invoke" frontmatter, hook signal response table, pull-side `recall()` gate before Write/Edit on sensitive domains.

`quorum install` extended with `--skip-hooks` flag.

**Acceptance criteria:**
- [x] All 5 hooks installed to `~/.claude/hooks/` by `quorum install`
- [x] Re-install is idempotent (no duplicate settings.json entries)
- [x] Hooks silent in projects without `.quorum` sentinel file
- [x] SKILL.md has hook signal table and pull-side protocol
- [x] 13 unit tests in `tests/install/hooks.test.js` (186 total passing)

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
| 2026-05-07 | BL-03 dropped: platform team deploys Quorum centrally; engineers connect from local Claude Code — no local stack CLI needed | (backlog) |
| 2026-05-08 | BL-04 dropped: error messages already actionable; LLM surfaces next steps on failure — silent retry adds complexity without value | (backlog) |
| 2026-05-08 | BL-07 dropped: MCP `graphitiAvailable` flag dropped — gateway `/health` surfaces Graphiti status; surface failures clearly instead | (backlog) |
| 2026-05-08 | BL-09 dropped: prompts moved to gateway as inlined template literals (BL-11); `src/prompts/*.md` orphaned; response normalization too simple to unit-test | (backlog) |
| 2026-05-07 | BL-04 scope narrowed — OPENAI_API_KEY removed; startup env check dropped; retry now on gateway calls | (backlog) |
| 2026-05-06 | BL-13: SDLC hooks — 5 hook scripts, hooks.js installer, SKILL.md enforcement | feat/sdlc-hooks |
| 2026-05-06 | Tests migrated from engram monorepo — constitutional + governance + tools | 747eeb6 |
| 2026-05-06 | BL-02a: `GET /pg/audit/lineage/:topic/:key` added to gateway (engram) | f98a174 |
| 2026-05-06 | BL-12: OAuth 2.1 Authorization Server in gateway — unblocks BL-10 end-to-end | f98a174 |
| 2026-05-04 | BL-10: MCP OAuth 2.1 + PKCE flow — full client-side implementation | f37f560 |
| 2026-05-04 | Remove OPENAI_API_KEY from MCP — conflict/enrich/extract route through gateway | 9066c8f |
| 2026-05-04 | BL-02: pg removed from cli.js — all commands now use GatewayClient HTTP | 9b6618b |
| 2026-05-04 | `quorum install` CLI command — copies skill + runs `claude mcp add` | 9b6618b |
| 2026-05-04 | Repo split from monorepo — `mcp/` extracted to `quorum-mcp` | 7a904bc |
