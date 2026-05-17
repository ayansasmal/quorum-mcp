# Quorum Tool Reference

Full parameter schemas, return shapes, and edge cases for all 12 MCP tools.

---

## `set_agent_context(agent_id)`

**Call this first — before any write tool.** Required gate: `remember`, `reflect`, `forget`, and `review`
are all blocked until this is called. Call once per session (not per tool call).

**Parameters:**
- `agent_id` — kebab-case identifier for this agent (e.g. `claude-code`, `subagent-auth-fix`).
  Must match `^[a-z][a-z0-9-]{0,39}$`. Max 40 characters.

**Do not pass `session_id` or `author_type`** — both are derived server-side:
- `session_id` is derived from `hash(PID + hrtime)` → `sess_` + 8 hex chars, uniquely scoping each MCP process lifetime
- `author_type` is always `'agent'` (never caller-supplied); distinguishes MCP writes from future human dashboard writes

**Returns:**
```json
{ "status": "context_set", "agent_id": "claude-code", "session_id": "sess_3f9a1b2c",
  "author_type": "agent",
  "note": "All writes in this session will be attributed to claude-code (sess_3f9a1b2c)." }
```

**Error if `agent_id` is invalid:**
```json
{ "error": "invalid_agent_id", "message": "agent_id must match ^[a-z][a-z0-9-]{0,39}$" }
```

---

## `remember(topic, key, content, options?)`

Store or update a knowledge node. Always creates a new version — never edits in place.

**Parameters:**
- `topic` — domain namespace (`auth`, `api`, `db`, `infra`, `testing`, `payments`, `security`, ...)
- `key` — unique identifier within topic (kebab-case, e.g. `token-strategy`)
- `content` — the knowledge to store; include rationale, not just conclusions
- `options.confidence` — `0.0–1.0` (role floor applied automatically; see knowledge-guidelines.md)
- `options.tags` — string array for cross-domain searchability
- `options.conflict_id` — from `pending()` response; required when resolving a pending conflict
- `options.resolution` — `"supersede" | "coexist_split" | "coexist_merge" | "reject" | "escalate"`
- `options.reason` — required when `resolution` is set (≥10 meaningful characters)
- `options.split_existing_key` — new key for the existing entry (required for `coexist_split`)
- `options.split_incoming_key` — new key for the incoming entry (required for `coexist_split`)
- `options.split_existing_content` — optional refined content for split A
- `options.split_incoming_content` — optional refined content for split B
- `options.merged_content` — combined entry content (required for `coexist_merge`)

**Do not pass `author`** — injected server-side from identity (GitHub token → git email → `QUORUM_AUTHOR`).

**Dual-store write:** writes to PostgreSQL (`knowledge_versions`) AND Graphiti/FalkorDB. If Graphiti is unavailable during conflict detection, the entry is stored as `PENDING_CONFLICT_CHECK` (graceful). If Graphiti fails during the episode write itself, the entire pipeline fails with `FAILED_OUTCOME` audit — these two downtime paths are asymmetric.

**Returns:**
```json
{ "status": "stored", "version": 1, "topic": "auth", "key": "token-strategy" }
{ "status": "superseded", "version": 2, "previous_version": 1 }
{ "status": "conflict_detected", "conflict_id": "cfl_abc123", "brief": "...",
  "message": "Human decision required. Call remember() again with conflict_id + resolution." }
{ "status": "stored_pending_conflict_check", "warning": "Graphiti unavailable — conflict check deferred" }
```

---

## `recall(topic, key, options?)`

Retrieve knowledge by topic:key.

**Parameters:**
- `topic`, `key` — target node
- `options.history` — `true` → full version chain v1 → vN
- `options.at` — ISO date string → version ACTIVE on that date
- `options.version` — integer → specific version

**Default** (no options) → latest ACTIVE version only.

**Returns:** XML-wrapped context block. Pay attention to:
- `confidence < 0.60` — stale or unverified; cross-check before using
- `triggered_by: reflect` — Claude-authored, may still be DRAFT
- `status: SUPERSEDED` — use ACTIVE version instead
- `status: PENDING_CONFLICT_CHECK` — conflict check deferred (Graphiti was unavailable); treat as tentative
- `source: global` — company-wide policy; **do not supersede from this project**

---

## `search(query, domain?, limit?)`

Semantic + BM25 + graph traversal search across all ACTIVE knowledge.

**Parameters:**
- `query` — natural language search string
- `domain` — optional topic filter
- `limit` — default 10, max 50

**Returns:** ranked results with author, confidence, version, and topic:key for each hit.

**Search strategy:** runs Graphiti semantic search (vector + BM25) for the project namespace and global namespace in parallel. If Graphiti returns zero results, falls back to PostgreSQL ILIKE on the `summary` column — results tagged `source: postgres-fallback`. The fallback is keyword-only with no semantic similarity.

Frequent recall of an entry signals trust in that author's domain knowledge — the authority formula rewards knowledge that gets used.

---

## `pending(topic?)`

Returns all unresolved conflicts and DRAFT entries awaiting review.

**Read with side-effect:** stale conflict detection runs on every call. If the underlying entry has been updated since a conflict was raised, `pending()` marks that conflict as `stale` in `pending_decisions` automatically. This mutation is intentional — it keeps the conflict list accurate — but means `pending()` is not a pure read.

**Parameters:**
- `topic` — optional filter

**Returns:**
```json
{
  "summary": { "total_pending": 3, "conflicts": 1, "drafts": 2 },
  "conflict_briefs": [
    {
      "conflict_id": "cfl_abc123",
      "topic": "auth", "key": "token-strategy",
      "existing": { "content": "...", "author": "senior-architect", "confidence": 0.85 },
      "incoming": { "content": "...", "author": "junior-dev", "confidence": 0.60 },
      "analysis": "LLM-generated contradiction analysis",
      "stale_warning": false,
      "more_pending_same_key": 0
    }
  ],
  "draft_reviews": [
    {
      "topic": "api", "key": "error-standards",
      "content": "...", "author": "claude", "triggered_by": "reflect"
    }
  ]
}
```

---

## `review(action, topic, key, note)`

Resolve a DRAFT knowledge entry.

**Parameters:**
- `action` — `"approve" | "reject" | "request_changes"`
- `topic`, `key` — target entry
- `note` — mandatory reason (≥10 meaningful characters)

**Constitutional constraint:** Claude is **never** the approving reviewer — not even for
knowledge authored by a different identity (e.g. a different `QUORUM_AUTHOR`). All DRAFT
reviews must be surfaced to the human. Claude relays the human's decision via `review()`;
it does not make the approval call itself.

**Search visibility after approval:** approving a DRAFT updates PostgreSQL only. The Graphiti
semantic search index is not immediately updated — `recall(topic, key)` works instantly but
`search(query)` may not surface the entry until Graphiti is re-synced.

---

## `reflect(task_summary, options?)`

Post-task knowledge extraction. Call once per completed task — not mid-task, not on
abandoned tasks.

**Parameters:**
- `task_summary` — 1–3 sentences: what was done and why
- `options.decisions` — array of decision strings with rationale
- `options.patterns` — array of pattern strings
- `options.constraints` — array of constraints discovered during the task

**Behaviour:**
- LLM extraction runs on the gateway (`POST /governance/extract` → OpenAI) — Claude Code does not make the LLM call directly
- Deduplicates against existing DRAFT entries via SHA-256 content hash — not semantic similarity
- Calls `remember()` internally for each novel entry — these calls bypass Gate re-checking (already passed Gate 3)
- All entries enter as `DRAFT` with `triggered_by: reflect`
- Each stored entry produces its own independent INTENT+OUTCOME audit pair — a 3-item `reflect` produces ~8 audit entries total
- Returns list of stored, skipped, and any conflicts detected

---

## `history(topic, key)`

Full version timeline — v1 → vN with authored reasons, `triggered_by` values, and
audit entry references.

Use before superseding existing knowledge to understand why prior versions were written.

**Degraded mode:** If Graphiti is unavailable, history still returns the full PostgreSQL version chain — all entries show `graph_linked: false`. No warning is surfaced; the data is still accurate (PostgreSQL is authoritative).

---

## `forget(topic, key, reason)`

Deprecate knowledge permanently. Never hard-deletes — creates a `DEPRECATED` marker
version. Requires `reason` (≥10 meaningful characters).

Use when knowledge is definitively obsolete, not just superseded by a newer entry.

**Two-row pattern:** creates a new DEPRECATED version row (reason + author recorded) AND transitions the old ACTIVE row to DEPRECATED. Both rows share `status = DEPRECATED` — this is correct; do not interpret it as duplicate data.

**Always require explicit human confirmation before calling `forget()`.** Say:
*"I think `topic:key` is obsolete because [reason]. Should I deprecate it?"*
Never deprecate autonomously — deprecation is visible to all engineers and
irreversible without a superseding entry.

---

## `export(topic?, format)`

Export knowledge to human-readable format.

**Parameters:**
- `format` — `"markdown" | "confluence"`
- `topic` — optional; omit for full export across all domains

**FalkorDB wipe caveat:** content is fetched from Graphiti via search, not a direct episode GET. After a FalkorDB wipe, content retrieval silently falls back to a placeholder — the exported document will contain `[Content stored in graph — search for this key to retrieve]` rows with no warning. Use `recall(topic, key)` after a wipe to verify content is preserved in PostgreSQL.

---

## `authenticate(project_id?)`

Authenticate with the Quorum Gateway via OAuth 2.1 + PKCE browser flow. Required in
gateway mode (`QUORUM_GATEWAY_URL` set). Token lives in MCP process memory only —
never written to disk.

**Parameters:**
- `project_id` — optional. Project slug (`group_id`) to authenticate against.
  Defaults to `QUORUM_PROJECT_ID` env var or the value in the `.quorum` file.
  Pass explicitly only when switching to a different project.

**How it works:** The MCP server opens a browser tab to the gateway login page.
The engineer signs in with GitHub. The GitHub token **never reaches Claude or the
MCP server** — the gateway issues a scoped ES256 JWT (Gateway-MCP Token) which
is stored in-memory. The browser shows "Quorum authenticated" and the flow returns.

**Do not ask the engineer for a GitHub token.** The browser handles it entirely.

**Gate exemptions:** `authenticate` bypasses both Gate 1 (project context) and Gate 2 (JWT check) — it must be callable before either exists. Gate 3 does not apply (not a write tool). Backed on the gateway by `mcp-oauth.js` (RFC8414 discovery, RFC7591 dynamic client registration, PKCE S256).

**Trigger:** Auth runs automatically on first tool use. Call explicitly only to
switch projects or after a `jwt_expired` / `401` response.

**Always required.** `QUORUM_GATEWAY_URL` is always registered (defaults to
`http://localhost:3001`). The MCP never connects to Graphiti directly — all
operations route through the gateway. Identity for the audit trail resolves from
the JWT `sub` claim (GitHub username); override with `QUORUM_AUTHOR` in CI.

**Returns:**
```json
{ "status": "authenticated", "user": "github-username", "project": "platform-team",
  "role": "senior_engineer", "expires_in": 3600 }
{ "status": "already_authenticated", "user": "...", "project": "...", "role": "...",
  "note": "Already authenticated. Project context is per-request via X-Quorum-Project header (from .quorum file) — no re-auth needed to switch projects." }

{ "status": "project_mismatch", "message": "...", "hint": "Ask principal architect to add you." }
```

---

## `config_upload(options)`

Upload a project config to the Quorum Gateway. Uses the JWT already stored by
`authenticate()` — no token handling required. Call this during onboarding Phase 4.

**Parameters:**
- `options.config_path` — path to `<group_id>.quorum.json` file (required)

**Gate exemptions:** Gate 1 (`no_project_context`) bypassed — config upload runs before the `.quorum` file exists (Phase 4 of onboarding). Gate 2 (JWT auth) still applies — call `authenticate()` first. Gate 3 does not apply (not a write tool).

**Bootstrap self-authorization:** if the uploaded config lists the caller's GitHub username with role `principal_architect`, the gateway accepts the upload without a pre-existing project entry. This is the bootstrap path for brand new project onboarding — no other admin needs to add you first.

**Use during onboarding Phase 4 only.** For config updates after onboarding, use the
dashboard Config editor or `POST /sync/configs`.

**Returns:**
```json
{
  "status": "onboarded",
  "project_id": "platform-team",
  "q_project_id": "q_p1",
  "message": "Project '...' onboarded successfully.",
  "next_step": "Add both project_id and q_project_id to your .quorum file:\n{\"gateway_url\":\"...\",\"project_id\":\"platform-team\",\"q_project_id\":\"q_p1\"}"
}
{
  "status": "already_onboarded",
  "project_id": "platform-team",
  "q_project_id": "q_p1",
  "hint": "Project already exists. Proceed to Phase 5."
}
```

**`q_project_id`** is the Quorum-assigned internal ID (e.g. `q_p1`). Include it in
the `.quorum` file alongside `project_id` — the MCP will send it as the
`X-Quorum-Project` header, which lets the gateway skip a DB lookup on every request.

**Error conditions:**
- `file_read_failed` — `config_path` not found or unreadable
- `file_parse_failed` — file contains invalid JSON
- Gateway `400` validation errors are rethrown as-is with the gateway's error message

---

## Gateway API surface (not MCP tools — reference only)

These are HTTP endpoints on the Quorum Gateway (`QUORUM_GATEWAY_URL`), not MCP tools.
You cannot call them directly — the MCP server proxies through them automatically.

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /health` | — | Stack health: PostgreSQL, Graphiti, FalkorDB, S3 |
| `GET /schema/config` | — | JSON Schema (Draft 7) for `<group_id>.quorum.json` config files |
| `POST /config/validate` | — | Validate a config file without uploading |
| `GET /auth/github` | — | GitHub OAuth redirect entry point (browser flow) |
| `POST /auth/switch` | — | **410 Gone** — retired in v0.3; use `X-Quorum-Project` header instead |
| `GET /auth/projects` | — | **410 Gone** — retired in v0.3; use `GET /user/profile/:username` instead |
| `GET /user/profile/:username` | JWT | User profile: role, projects, base_confidence (Redis-cached) |
| `POST /config/upload` | JWT/sync token | Upload + validate config; store in S3 + sync to DDB |
| `POST /sync/configs` | JWT/sync token | S3→DDB full config sync (EventBridge-compatible) |
| `GET /graphiti/*path` | JWT + `X-Quorum-Project` | Transparent proxy to Graphiti MCP; injects `group_id`, normalises hyphens → underscores for FalkorDB |
| `GET /.well-known/oauth-authorization-server` | — | RFC8414 OAuth metadata discovery |
| `GET /.well-known/jwks.json` | — | JWKS endpoint for JWT verification |
