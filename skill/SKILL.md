---
name: quorum
description: >
  ALWAYS invoke at session start for any engineering or business task in a
  Quorum-connected project (.quorum file present). Primary knowledge
  source — consult before any implementation decision, architectural
  choice, product requirement, or code change. Skip only for pure read
  sessions with no decisions made.
---

# Quorum Skill

Quorum is a **governed temporal knowledge graph** for engineering and cross-functional teams. It stores
decisions, patterns, constraints, runbooks, and business requirements with full versioning, conflict detection,
authority weighting, and a tamper-evident audit trail.

Quorum stores two complementary types of knowledge:
- **Engineering knowledge** — the technical *why* and *how*: architectural decisions, patterns, constraints, runbooks
- **Business knowledge** — the product *why* and *when*: feature requirements, business rules, compliance constraints

Anyone on the team — engineers, PMs, BAs, compliance officers — uses Claude to interact with Quorum.

**Your responsibilities — in priority order:**
1. Surface pending decisions at session start — non-negotiable
2. Recall relevant knowledge **before** making implementation choices — proactively, without being asked
3. Capture decisions and constraints the moment they are made — not at the end
4. Extract and submit learnable knowledge after the task — via `reflect()`
5. Relay human conflict resolutions — you cannot self-approve
6. Discover latent knowledge in existing files and surface candidates for human confirmation

---

## Session Start (always, without being asked)

### Step 0 — Register agent identity (required before any writes)

Before calling remember(), reflect(), forget(), or review(), register this agent session:

```
set_agent_context({ agent_id: "your-name" })
```

Naming convention:
- Main Claude Code session: `claude-code` or `claude-code-<task-slug>`
- Subagent: `subagent-<specialty>` (e.g. `subagent-auth`, `subagent-db-optimizer`)

Rules: kebab-case only, starts with a letter, max 40 chars.

Write tools return `agent_context_required` until this is called. Read tools (recall, search, pending, history) do not require it.

---

### Step 1 — Is this project connected to Quorum?

```bash
ls .quorum 2>/dev/null
```

| Result | Action |
|--------|--------|
| Not found | Ask once: *"I don't see a `.quorum` file. Want me to onboard this project to Quorum?"* |
| Found, but graph is empty (< 5 entries) | Run discovery scan — CLAUDE.md + MEMORY.md + recent git log — before Step 1 |
| Found, graph has entries | Skip scan — go straight to Step 1 |

---

### Step 2 — Surface pending items

```
pending()    ← returns conflict_briefs and draft_reviews — handle them differently
```

| Return type | How to handle |
|-------------|---------------|
| `conflict_briefs` — unresolved conflicts | **Block on resolution before writing any code.** Present each conflict and get human decision. See Conflict Resolution section. |
| `draft_reviews` — DRAFTs awaiting approval | **Do not block.** Note them: *"N DRAFT entries await your review at http://localhost:3002/pending."* Then continue. |

---

### Step 3 — Load relevant context

Read the task and infer all domains involved. Pull knowledge for each upfront:

| Task mentions | Search |
|--------------|--------|
| auth, login, token, session, OAuth | `search("auth")` |
| database, query, migration, schema | `search("db")` |
| API, endpoint, REST, HTTP | `search("api")` |
| deploy, infra, secrets, container | `search("infra")` |
| test, coverage, mock, integration | `search("testing")` |
| payment, billing, subscription | `search("payments")` |
| security, vulnerability, CVE, audit, pentest | `search("security")` |
| cache, Redis, CDN, TTL, invalidation | `search("caching")` |
| monitoring, alerts, metrics, SLO, SLA, observability | `search("monitoring")` |
| queue, worker, job, async, event-driven, consumer | `search("async")` |
| product, feature, requirement, user story, roadmap | `search("product")` |
| compliance, regulation, GDPR, legal, privacy, policy | `search("compliance")` |
| **No keyword matches** | `search("<raw task description literally>")` |

**Before removing or significantly changing any feature**, always check for product requirements:
```
search("<feature name>", domain="product,compliance")
```
A product requirement may exist that governs why the feature exists.

---

## During Task — Proactive Knowledge Use

Do not wait to be asked. When you encounter any of these, act immediately:

### You are about to make an implementation choice

**Two-tool pattern — always in this order:**

```
search("what you're about to decide")    ← find candidate keys
recall("topic", "key")                   ← load the exact entry once you know the key
```

`search()` is for **exploration** — use it when you don't know the exact key.
`recall()` is for **precision** — use it once `search()` has surfaced the right key.
Never call `recall()` with a guessed key — if the key doesn't exist, you get nothing back.

Examples:
- Choosing an auth mechanism → `search("auth token")` → `recall("auth", "token-strategy")`
- Writing a database query → `search("db connection")` → `recall("db", "connection-pooling")`
- Designing an API response → `search("api errors")` → `recall("api", "error-standards")`
- Handling a retry → `search("retry backoff")` → `recall("infra", "retry-strategy")`
- Modifying checkout → `search("checkout")` → `recall("product", "guest-checkout-requirement")`

**If recalled knowledge contradicts what you were about to do** → stop, surface the
conflict to the human, do not silently override.

---

### Before any Write or Edit

Ask: "am I about to touch something that might have Quorum knowledge?" Apply
this check for any file related to auth, payments, security, core patterns, or
anything that surfaced in this session's `search()` results. If yes:

```
recall("topic", "key")
```

If recalled knowledge conflicts with what you are about to write → stop and
surface the conflict to the human. Do not write first and check later.
Interpret the recalled response using the signal table in "Reading recalled entries — act on these signals" below.
This check is non-negotiable for sensitive domains (auth, payments, security,
infra). For all other files, apply judgment.

---

**Reading recalled entries — act on these signals:**

| Signal in recall response | What to do |
|--------------------------|------------|
| `confidence < 0.60` | Treat as hypothesis, not constraint. Flag to human before applying. |
| `status: SUPERSEDED` | Fetch the ACTIVE version — never apply a superseded entry. |
| `triggered_by: reflect` + `status: DRAFT` | Not yet human-approved. Verify with human before using as a hard constraint. |
| `source: global` | Company-wide policy. Do not supersede from this project. Escalate conflicts upward. |

**Before superseding any existing entry:**

```
history("topic", "key")   ← understand why prior versions were written before overwriting
```

Never supersede without reading the history. An entry may have gone through deliberate
reversals — superseding blindly can undo months of governed decisions.

---

### You discover a new constraint or requirement

> **Content constraints apply** — content must be ≤ 500 chars with no HTML (`<` `>` forbidden); topic and key must be kebab-case slugs; reason (for supersede/promote) must be ≥ 10 chars. See `references/knowledge-guidelines.md` § Content Constraints for the full table.

Call `remember()` **immediately** — do not wait for the task to finish.
Constraints and requirements discovered mid-task are the most valuable kind; they get lost otherwise.

**Key naming:** kebab-case noun-phrase, specific enough to be unique within the topic.
Good: `connection-pool-size`, `guest-checkout-requirement`. Bad: `db_stuff`, `requirement1`.

```javascript
// Engineering constraint
remember("domain", "key", "constraint statement", {
  confidence: 0.80,
  tags: ["domain", "constraint-type", "affected-component"],
  reason: "discovered while implementing X"
})

// Business requirement
remember("product", "key", "requirement statement — why it exists, who it serves, when it applies", {
  entity_type: "Requirement",
  confidence: 0.80,
  tags: ["product", "feature-name"],
  reason: "stated by product owner / captured from PRD"
})
```

**Tags are cross-domain search hooks.** Tag with: the domain (`auth`), the constraint
type (`performance`, `security`, `limit`), and affected component (`lambda`, `postgres`).
Example: `tags: ["auth", "security", "lambda"]` makes an auth constraint findable from
a Lambda or security search. Skip tags only for entries purely self-contained within one domain.

If `remember()` returns `stored_pending_conflict_check` → tell the human:
*"Entry stored but conflict check was deferred (Graphiti unavailable). Review at /pending
once the graph is back — a hidden conflict may exist."*

---

### You see existing knowledge being violated

```javascript
remember("domain", "key", "corrected statement", {
  reason: "existing entry conflicts with current implementation — see PR #...",
  confidence: 0.85
})
```

This creates a conflict for human review. Do not silently override existing knowledge.

---

### Sensitive domains — pull everything, not just one key

In `auth`, `payments`, `infra`, `security`, `compliance` domains: do a full domain scan before touching anything:

```
search("auth")        ← all auth patterns + constraints
search("payments")    ← all payment rules
search("security")    ← all security constraints
search("compliance")  ← all regulatory and legal constraints
```

Sensitive domain violations are the costliest to fix after the fact.

---

## After Task — Reflect and Capture

Ask: *"What did I decide, discover, or reinforce that a future engineer or product owner should know?"*

If the answer is anything → call `reflect()` once:

```javascript
reflect("concise task summary — what was built and why", {
  decisions_made: ["decision 1 with rationale", "decision 2 with rationale"],
  patterns_used:  ["pattern used and why it fits here"],
  constraints:    ["constraint discovered or confirmed"]
})
```

**After `reflect()` returns:**
- Tell the human: *"I've submitted N knowledge entries to Quorum for your review at http://localhost:3002/pending."*
- If any entry returned `conflict_detected` → do not close the session silently. Brief the human on each conflict and resolve them the same way as a mid-task conflict. See Conflict Resolution section.
- If any entry returned `stored_pending_conflict_check` → tell the human: *"Conflict check deferred for N entries — review at /pending once Graphiti is back."*

**Skip `reflect()` entirely** for: pure read sessions, abandoned tasks, sessions
where no real architectural, design, or product decisions were made. Over-extraction degrades
signal quality. See [`references/knowledge-guidelines.md`](references/knowledge-guidelines.md).

---

## Conformance Scanning — v0.4

### When to call `deviate()`

Call `deviate()` when a code review or security review finding matches an entry in one of the
project's linked global catalogs. Do NOT call `deviate()` for unmatched findings — use
`remember()` for those (they become project-level DRAFTs for PE/PA review).

```javascript
// A finding matched a global catalog entry via search() — source: 'global'
deviate({
  catalog_id: "security-standards",   // group_id of the matched global catalog
  topic:       "security",            // must match the catalog entry's topic (kebab-case)
  key:         "sql-injection-prevention",  // must match the catalog entry's key (kebab-case)
  description: "parameterized queries not used in UserRepository.findByEmail()",
  evidence: {
    files:   ["src/repositories/user.js"],
    lines:   ["line 47"],
    excerpt: "db.query(`SELECT * FROM users WHERE email = '${email}'`)"
  },
  source: "code-review"  // 'agent' | 'code-review' | 'security-review'
})
```

**Important rules:**
- `catalog_id` must be in the project's `globals` list — `deviate()` returns `not_linked` otherwise
- `topic:key` must exist in that catalog — returns `not_found` if the entry doesn't exist
- One call per **pattern**, not per file instance. Group all instances of the same pattern into the `evidence.files` array
- Severity is derived server-side from the catalog entry's confidence × author role weight — never accept from client

**Return values:**

| Return | Meaning | Action |
|--------|---------|--------|
| `{ status: 'recorded', is_new: true }` | New deviation recorded | Continue scan |
| `{ status: 'recorded', is_new: false }` | Existing deviation — `last_seen_at` updated | Continue scan |
| `{ status: 'not_linked' }` | `catalog_id` not in project's `globals` list | Use `remember()` instead |
| `{ status: 'not_found' }` | `topic:key` not in catalog | Use `remember()` instead |

---

### When to call `conformance()`

Call `conformance()` to see the current project conformance state before and after a scan:

```javascript
// Basic state check (no deviation details)
conformance()

// Full state with top 10 open deviations sorted by severity
conformance({ include_details: true })
```

**Return value interpretation:**

| `status` field | Meaning | What to tell the human |
|---------------|---------|------------------------|
| `UNCERTIFIED` | Catalog coverage < 10 entries, no scan run, or no globals linked | Show the `message` field — it explains the specific reason |
| `CERTIFIED` | Scored | Report `score`, `breakdown`, `last_scan_at` |

---

### `quorum:scan` — Orchestration Pattern

> Load [`references/scan.md`](references/scan.md) for the full scan protocol.

**Quick reference — scan workflow:**

```
1. conformance()                             ← baseline before scan
2. git diff HEAD~1 --name-only               ← identify changed files (incremental)
3. For each changed file: run code-review + security-review skills
4. For each finding:
     a. search("finding keywords") — look for a matching global catalog entry
     b. If match found (source: 'global'):
        deviate({ catalog_id, topic, key, description, evidence, source: 'code-review' })
     c. If no match found:
        remember(topic, key, description, { entity_type, reason })  ← project-level DRAFT
5. conformance({ include_details: true })    ← updated state after scan
6. Return summary: { deviations_new, deviations_confirmed, deviations_resolved }
```

**Critical constraints (enforce strictly):**
- One `deviate()` per distinct **pattern** — never one per file instance
- Never call `deviate()` for a `catalog_id` not in the project's `globals` list
- Never call `deviate()` if `topic:key` does not exist in the specified catalog
- Group file locations into `evidence.files`, not into separate `deviate()` calls

---

### Responding to `pending()` deviation data (v0.4)

`pending()` returns a `deviations` section alongside the existing `decisions` and `deprecation_requests`:

```javascript
{
  deviations: {
    open:              [...],   // OPEN deviations — brief the human
    overdue_deferrals: [...]    // DEFERRED with defer_until passed — treat with urgency
  }
}
```

**How to handle:**

| Section | Action |
|---------|--------|
| `open` count > 0 | Note: *"N deviations are open. Dashboard → http://localhost:3002/deviations"* — do not block the session |
| `overdue_deferrals` > 0 | Surface with urgency: *"N overdue deferrals need re-actioning — they are scoring at full weight until resolved"* |

Deviations are informational at session start — they do not block the way unresolved conflicts do.

---

### Portfolio Intelligence — v0.4

Portfolio scoring aggregates conformance across all projects in your org hierarchy.
There is **no `portfolio()` MCP tool** — portfolio is dashboard-only.

**Who can access portfolio:**

| Role | Access |
|------|--------|
| `principal_architect` | Own team's portfolio view |
| `director`, `vp_engineering`, `group_executive` | All projects under their `hierarchy.node_id` |
| `is_admin` | All projects org-wide |
| All other roles | 403 Forbidden |

**Dashboard:** `http://localhost:3002` → Stats page → ConformanceCard

**What the portfolio rollup shows:**
- Per-project conformance score, status (CERTIFIED / UNCERTIFIED), and last scan metadata
- Weighted rollup: `Σ(score × criticality) / Σ(criticality)` across CERTIFIED projects only
- UNCERTIFIED projects counted separately — they do not affect the rollup score
- Projects filter by `hierarchy.node_id` so directors see only their subtree

**From the MCP (current project only):**

```javascript
conformance()                            ← current project score and status
conformance({ include_details: true })   ← + top 10 open deviations sorted by severity desc
```

When a portfolio-role user asks "how are all our projects doing?" — direct them to the
dashboard Stats page. When they ask about the **current** project's conformance — use `conformance()`.

---

## Conflict Resolution — Guide, Don't Just Report

When a conflict is detected (`conflict_detected` in response or in `pending()`):

**Do not just dump the raw conflict.** Read the `analysis` field in the response — it contains
an LLM analysis of the contradiction. Use it to inform your suggested resolution. Brief
the human like this:

> "There's a conflict on `auth:token-strategy`:
> - **Existing** (by @senior-architect, 3 months ago, confidence 0.90): 'Use session tokens'
> - **Incoming** (your current decision, confidence 0.85): 'Use JWT for Lambda services'
>
> Analysis: *[`analysis` field — e.g., "existing rule predates Lambda adoption; new rule is likely scoped to Lambda contexts"]*
>
> Suggested resolution: **coexist_split** — the existing rule covers ECS services,
> the new one covers Lambda. Want me to apply that?"

If `pending()` returns a conflict with `stale_warning: true` → the underlying entry has
changed since the conflict was raised. Surface this first:
*"This conflict may be outdated — the underlying knowledge has been updated since it was
flagged. Want me to re-run the conflict check rather than resolve a potentially stale one?"*

Options to offer:
| Resolution | When to suggest |
|-----------|----------------|
| `supersede` | New knowledge is clearly more accurate or up-to-date |
| `coexist_split` | Both are valid in different contexts — suggest context boundaries |
| `coexist_merge` | Both contain truth — suggest a merged statement |
| `reject` | New addition is wrong or already covered |
| `escalate` | Genuinely ambiguous — needs a human decision |

```javascript
// Once the human decides:
remember("topic", "key", "resolved content", {
  conflict_id: "cfl_...",
  resolution: "coexist_split",
  reason: "ECS services use sessions (revocable), Lambda uses JWT (stateless)"
})
```

---

## Authentication

### Auth is always required

The MCP server always routes through the Quorum Gateway — there is no direct
mode. `QUORUM_GATEWAY_URL` defaults to `http://localhost:3001` and is registered
automatically via `postinstall`. All Graphiti operations go through the gateway's
`/graphiti/*` proxy, which requires a valid JWT + `X-Quorum-Project` header.

JWT required. Identity from GitHub OAuth → slim JWT `{ sub, is_admin }`.
Override audit identity in CI with `QUORUM_AUTHOR=<github-username>`.

---

### Auth flow

Auth is **automatic** — every tool checks for a valid token and triggers the flow
if missing. You do not need to call `authenticate()` manually.

When auth is needed:
1. Say: *"Quorum auth needed — a browser tab will open, back in a moment."*
2. The MCP server opens the browser to the gateway login page automatically
3. The engineer signs in with GitHub — the browser shows "Quorum authenticated."
4. Control returns to Claude Code — retry the tool that triggered the flow
5. Say: *"Auth done — continuing."*

The token is in-memory only. If the MCP server restarts, auth is needed again on
next tool use. See [`references/login.md`](references/login.md) for the full flow,
token contents, project mismatch handling, and error reference.

### Proactive auth at session start

Check auth state **before** Step 1 (`pending()`):

```
authenticate()   ← returns already_authenticated (fast) or opens browser
```

A 401 mid-session interrupts the engineer's flow — auth first removes that risk.

### Auth failure signals

| Signal | Action |
|--------|--------|
| `401 Unauthorized` or `jwt_expired` | Call `authenticate()`, then retry |
| `project_mismatch` | Engineer not in project config — escalate to principal architect |
| `auth_timeout` | Browser tab not completed — call the tool again to restart |

### Project ID constraint

`group_id` **must use hyphens, not underscores** — the gateway schema enforces
`/^[a-z0-9-]+$/` and rejects underscores. Use `amethyst-munchkin`, not `amethyst_munchkin`.

The gateway Graphiti proxy silently normalises hyphens → underscores before every
Graphiti/FalkorDB call, so RediSearch tag filters work correctly. This normalisation
is invisible to callers — never try to work around it by using underscores in `group_id`.

When `q_project_id` is present in `.quorum`, `resolveCtx()` sends it directly in the
`X-Quorum-Project` header — no underscore normalisation is needed because `q_project_id`
is an opaque integer ID (`q_p{n}`) with no hyphens. The `group_id → q_project_id` DB
lookup is skipped entirely on the gateway side, reducing per-request latency.

Add `q_project_id` to `.quorum` during Phase 5 of onboarding — the `config_upload` tool
returns it in the `next_step` field of the Phase 4 response.

---

## Onboarding a New Project

**Triggers:** "add this project to Quorum", "onboard this project", "connect this repo to Quorum"

Follow the full 10-phase protocol: [`references/onboarding.md`](references/onboarding.md).

**Phase overview:**
1. Check for existing setup (`.quorum` file) — hard-stop if already onboarded
2. Gather team info — project ID (**hyphens only, no underscores**, e.g. `platform-team`), members, domains, gateway URL
3. Create + validate `<group_id>.quorum.json` config — `group_id` must use `-` not `_`; `owner` (GitHub username) is **required**
4. Upload config via `config_upload({ config_path: "<id>.quorum.json" })` — save the `q_project_id` from the response
5. Create `.quorum` discovery file (`quorum init`) and add the `q_project_id` from Phase 4
6. Share install instructions with team (`npm install -g @as-quorum/mcp`)
7. Verify own skill + hooks are present
8. **Ingest existing knowledge** — CLAUDE.md, MEMORY.md, session transcripts → DRAFT entries
9. Commit `.quorum` (config is gitignored — lives in S3); add `.quorum-reflected`, `.quorum-offline.log` to `.gitignore`
10. Verify connection with a fresh session

**Phase 8 is the highest-value step** — it bootstraps the team's memory from institutional
knowledge that already exists, rather than starting from zero.

---

## Knowledge Discovery — Surface Latent Knowledge

Quorum's graph is only as good as what gets into it. Most institutional knowledge
lives in files that already exist — `CLAUDE.md`, `MEMORY.md`, README sections,
ADRs, code comments, test names, config values, PRDs, Jira tickets. This section
tells you when and how to scan for it and surface candidates for human confirmation
before storing.

**Golden rule: always `search()` before proposing. Never suggest storing something
that is already in Quorum.**

---

### When to run discovery

| Trigger | What to scan |
|---------|-------------|
| First session in a project | `CLAUDE.md`, `MEMORY.md`, `README.md`, `docs/` |
| Human says "onboard this project" | Full scan — all sources below |
| Human says "what should we add to Quorum?" | Full scan |
| You open a file with dense comments or ADR-style notes | That file |
| You read a long test file | Extract business rules from test names + assertions |
| You read a config file (limits, thresholds, pool sizes) | Extract constraints |
| Human pastes a decision, email, Slack thread, or PRD excerpt | Extract immediately |

---

### What to look for in each source

#### `CLAUDE.md` / `MEMORY.md`
These files are the richest source. Read them fully and extract:
- Any sentence stating a technical decision or rationale
- Any "we use X because Y" or "always do X" or "never do Y"
- Any constraint with a number (timeout, pool size, retry count)
- Any mention of a tool choice with reasoning

```bash
cat CLAUDE.md .claude/CLAUDE.md 2>/dev/null
cat ~/.claude/projects/$(echo $PWD | tr '/' '-')/memory/MEMORY.md 2>/dev/null
```

#### Product requirements and business rules
Look for anywhere the *why* of a feature is stated:
- PRD documents or feature specs in `docs/`
- Jira ticket descriptions pasted into conversation
- Acceptance criteria in test files
- Comments that say "this exists because..." or "required by..."
- Feature flags that encode a product decision

Store these as `entity_type: "Requirement"` with topic `product` or `compliance`.

#### `README.md` / `docs/*.md`
Look for:
- Architecture decision sections
- "Why we chose X over Y" paragraphs
- Runbook procedures
- Non-obvious setup steps that encode constraints

#### Source code comments
Lines starting with `// NOTE:`, `// IMPORTANT:`, `// WHY:`, `// HACK:`, `// TODO:`,
or multi-line comments explaining *why* (not *what*) the code does something.

```bash
grep -rn "NOTE:\|IMPORTANT:\|WHY:\|HACK:\|DECISION:" src/ --include="*.js" --include="*.ts"
```

#### Test files
Test names encode business rules. Scan test `describe`/`it` blocks for:
- "should reject X when Y" → constraint
- "should use X for Z" → pattern
- "must not allow X" → hard constraint
- "returns X when user is guest" → product requirement

```bash
grep -rn "it(\|test(\|describe(" tests/ --include="*.test.*" -A 1
```

#### Config and environment files
Numeric values in config often encode constraints no one wrote down:
- Pool sizes, timeout values, retry counts, rate limits
- Feature flags that encode a decision about what's enabled

```bash
cat .env.example docker-compose.yml 2>/dev/null | grep -E "[0-9]+" | head -30
```

#### Recent git history
Commit messages with rationale are a goldmine:

```bash
git log --oneline -20                          # scan subjects
git log --format="%s%n%b" -10 | head -60      # subjects + bodies
```

Look for commits that explain *why* a change was made, not just *what* changed.

---

### How to present candidates — batch, don't drip

Never ask the human to confirm one entry at a time. Batch everything you found,
deduplicate against existing Quorum knowledge, then present a numbered list:

> **Quorum discovery — I found 7 knowledge candidates in this project.**
> Please confirm which to store (reply with the numbers, e.g. "1 3 5", or "all" / "none"):
>
> 1. **api:error-standards** *(Pattern, confidence 0.80)*
>    "All API errors follow RFC 7807 Problem Detail: type, title, status, detail"
>    *Source: CLAUDE.md line 14*
>
> 2. **db:connection-pooling** *(Constraint, confidence 0.85)*
>    "PostgreSQL pool size: 10 per service instance, max 100 total across all instances"
>    *Source: .env.example + docker-compose.yml*
>
> 3. **product:guest-checkout-requirement** *(Requirement, confidence 0.85)*
>    "Guest checkout must remain available. Conversion data shows 40% abandonment on mandatory registration."
>    *Source: docs/checkout-prd.md section 3*
>
> 4. **compliance:gdpr-data-residency** *(Requirement, confidence 0.90)*
>    "All EU user data must remain in eu-west-1. Required for GDPR compliance with enterprise customers."
>    *Source: docs/legal/data-residency.md*

Once the human replies, store the approved ones:

```javascript
// For each approved candidate:
remember("topic", "key", "content", {
  confidence: 0.80,
  tags: ["domain", "source-type"],
  reason: "discovered in CLAUDE.md during project scan"
})
```

All entries enter as `DRAFT`. Tell the human: *"Stored N entries as DRAFT —
review them at http://localhost:3002/pending."*

---

### Ongoing passive discovery — notice and flag

Even outside a full scan, keep a passive eye open:

| You notice | Action |
|-----------|--------|
| A code comment that says "always X" or "never Y" | Propose storing it |
| A function with a surprising limit (timeout, retry, size) | Propose storing the constraint |
| An error message that reveals a hard constraint | Propose storing it immediately |
| A pattern repeated 3+ times with no Quorum entry | Propose storing the pattern |
| A feature being removed with no product requirement check | Run `search("<feature name>", domain="product,compliance")` first |
| A deprecated approach still present in old code | `search()` to find the Quorum entry → `history()` to check what depends on it → propose: *"This approach appears obsolete. The Quorum entry `topic:key` is still ACTIVE. Want me to deprecate it with `forget()`?"* |

For all except deprecated approaches: one sentence, low friction. Human says yes or no.
*"I noticed a constraint/pattern/requirement here that isn't in Quorum — want me to add it?"*

---

## Constitutional Rules — Server-Enforced

Violations are **rejected**, not warned:

| Rule | What to do instead |
|------|-----------------|
| No hard delete | `forget(topic, key, reason)` — creates DEPRECATED version |
| Audit is append-only | Never attempt to edit or delete audit entries |
| Reason required (≥10 chars) | Always provide a meaningful reason for supersede/deprecate |
| No self-approval | Surface to human; relay their decision via `review()` |
| Claude writes are always DRAFT | `reflect()` and `remember()` as agent always enter DRAFT |
| `triggered_by` always set | Set automatically by the server — if you see a `triggered_by: null` error, the server version is outdated |
| Atomic ACTIVE transition | If an entry is stuck in PENDING_ACTIVE state, report to human — do not retry manually |
| Bidirectional audit↔version | If `history()` returns a version with no `created_by_audit`, the audit chain is broken — escalate to human. Do not attempt to repair it manually or call `forget()` to clean up. |

---

## Quick Reference

```
# Session start (always)
ls .quorum                                       ← verify project is connected
set_agent_context({ agent_id: "claude-code" })   ← required before any writes (Gate 3)
pending()                                        ← conflicts block; drafts note-only; open deviations = informational
search("task domain")                            ← load context before touching code

# Retrieve — always search first, then recall
search("what you're deciding")                   ← find candidate keys
recall("topic", "key")                           ← load exact entry once key is known
recall("topic", "key", { history: true })        ← full version chain
recall("topic", "key", { at: "2024-11-30" })     ← point-in-time
recall("topic", "key", { version: 2 })           ← specific version
history("topic", "key")                          ← ALWAYS call before superseding

# Store
remember("topic", "key", "content")
remember("topic", "key", "content", {
  confidence: 0.85,
  tags: ["domain", "type", "component"],         ← cross-domain search hooks
  reason: "why this matters"
})
# Business requirement
remember("product", "key", "requirement", {
  entity_type: "Requirement",
  confidence: 0.85,
  tags: ["product", "feature-name"],
  reason: "stated by product owner"
})
# → if stored_pending_conflict_check → warn human, Graphiti unavailable

# Resolve conflict (conflict_id from pending() or conflict_detected response)
remember("topic", "key", "resolved content", {
  conflict_id: "cfl_...",
  resolution: "supersede" | "coexist_split" | "coexist_merge" | "reject" | "escalate",
  reason: "rationale for resolution"
})

# Post-task
reflect("what was built and why", {
  decisions_made: ["..."],
  patterns_used:  ["..."],
  constraints:    ["..."]
})
# → if conflict_detected in response → resolve before closing session
# → if stored_pending_conflict_check → warn human, Graphiti unavailable

# Governance
review("approve" | "reject" | "request_changes", "topic", "key", "reason")
history("topic", "key")
export("topic", "markdown")
forget("topic", "key", "reason — min 10 chars")
```

```
# Conformance (v0.4)
conformance()                                    ← current score/status for this project
conformance({ include_details: true })           ← + top 10 open deviations by severity

# Deviation recording (v0.4) — only after search() confirms global catalog match
deviate({
  catalog_id: "security-standards",             ← group_id of the global catalog
  topic:      "security",                        ← must match catalog entry's topic
  key:        "sql-injection-prevention",        ← must match catalog entry's key
  description: "finding description",
  evidence:   { files: [...], lines: [...], excerpt: "..." },
  source:     "code-review"                      ← 'agent'|'code-review'|'security-review'
})
# → not_linked: catalog_id not in project globals → use remember() instead
# → not_found:  topic:key not in catalog           → use remember() instead
# → recorded:   deviation created or last_seen_at updated
```

**Review queue:** Dashboard → http://localhost:3002/pending (preferred for humans)
**Deviations:** Dashboard → http://localhost:3002/deviations (PE action panel)

---

## Responding to Hook Signals

Hooks inject `[QUORUM: ...]` signals into context automatically. When you see
one, act on it immediately — before responding to anything else.

| Signal | Action |
|--------|--------|
| `[QUORUM: session_start_required]` | Run full session-start protocol: `pending()` then `search()` for task domains. Delete `.quorum-reflected` if it exists (stale from prior session). |
| `[QUORUM: pre-commit]` + staged files | Check `.quorum-reflected` first — if it exists, skip `reflect()` (already done this session). Otherwise: run capture protocol for the staged files listed, call `reflect()`, touch `.quorum-reflected`. |
| `[QUORUM: task-completed]` | Run single-task knowledge extraction on the completed task description. Batch candidates, present for confirmation. Store approved ones with `remember()`. Note: this does NOT touch `.quorum-reflected` — `remember()` is targeted extraction, not a full session reflect. The `pre-commit` signal will still call `reflect()` to capture any remaining decisions. |
| `[QUORUM: knowledge-source-updated]` + file | Run single-file discovery on that file only. Batch candidates, present for confirmation. Do not full-project scan. |
| `[QUORUM: N file(s) changed — reflect() before ending session?]` | Offer `reflect()`. If accepted, run it and touch `.quorum-reflected`. |

If Quorum is unreachable when acting on a signal: append (not overwrite) a one-line note to
`.quorum-offline.log` using `echo "$(date +%Y-%m-%d) <signal> — gateway unreachable" >> .quorum-offline.log`
and continue without blocking. Never fail silently.

---

## Confidence Guidelines

| Situation | Confidence |
|-----------|------------|
| Established, documented decision — high certainty | 0.90–0.95 |
| Strong pattern — team follows this consistently | 0.80–0.85 |
| Working assumption — likely correct, not yet verified | 0.65–0.75 |
| Hypothesis — needs validation | 0.50–0.60 |
| Uncertain — flag for review | < 0.50 — consider skipping |

**For discovered knowledge** (source may be stale — use lower starting confidence):

| Discovery source | Confidence |
|-----------------|------------|
| CLAUDE.md / MEMORY.md — explicit decision | 0.80 |
| README / docs — documented pattern | 0.75 |
| Code comment — WHY-style explanation | 0.70 |
| Config value — numeric constraint | 0.70 |
| Test name — inferred business rule | 0.65 |
| Git commit message | 0.65 |
| Implicit from code structure | 0.55 |

Never inflate confidence. A 0.95 that turns out wrong is more damaging than a 0.70.
Always let the human adjust confidence before confirming discovery candidates — they
know better than the file how current the knowledge is.

---

## References

Load when you need full detail:

| File | When to load |
|------|-------------|
| [`references/tool-reference.md`](references/tool-reference.md) | Full parameter schemas, return shapes, edge cases |
| [`references/conflict-resolution.md`](references/conflict-resolution.md) | Full conflict brief format, all resolution options with examples |
| [`references/knowledge-guidelines.md`](references/knowledge-guidelines.md) | What to store, quality bar, over-extraction guard, discovery vs. reflect() |
| [`references/onboarding.md`](references/onboarding.md) | Full 10-phase project onboarding protocol |
| [`references/login.md`](references/login.md) | Auth flow, token contents, project mismatch, error reference |
| [`references/scan.md`](references/scan.md) | Full `quorum:scan` orchestration protocol — incremental scan, evidence grouping, resolve-fixed flow |
