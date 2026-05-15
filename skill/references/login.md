# Authentication Reference

## How auth works

Every Quorum MCP tool checks for a valid Gateway-MCP Token before executing. If no
token is present (or it has expired), the tool triggers the auth flow automatically —
you never need to call `authenticate()` manually unless you are switching projects.

**Auth is in-memory only.** The token lives in the MCP server process. If Claude Code
restarts the MCP server (e.g. after a system restart or `claude mcp restart quorum`),
you will be asked to authenticate again on next tool use.

**Token TTL is 1 hour.** For long sessions, a `401 jwt_expired` response may appear
mid-task. The tool that triggered the 401 will surface it — call `authenticate()` to
re-open the browser flow, then retry the tool. The browser flow is fast (5–15 seconds
if already signed in to GitHub).

---

## The auth flow — what the engineer sees

When auth is needed, the MCP server:

1. Opens a browser tab to the Quorum Gateway login page
2. You sign in with GitHub (same account used in your project config)
3. The browser shows **"Quorum authenticated. You can close this tab."**
4. Control returns to Claude Code — the tool continues automatically

The entire flow uses OAuth 2.1 + PKCE. The GitHub token **never leaves the gateway** —
the MCP server only receives a scoped Gateway-MCP JWT.

**Timeout:** If the browser tab is not completed within 5 minutes, auth times out. Run
the tool again to restart the flow.

---

## What the token contains

The Gateway-MCP Token (ES256 JWT) is a **slim token** — it carries only identity, not
project context. Project context is supplied per-request via the `X-Quorum-Project` header.

| Claim | Description |
|-------|-------------|
| `sub` | Your GitHub username |
| `is_admin` | `true` if you are a Quorum platform admin; omitted otherwise |
| `jti` | JWT ID (unique per token; used for revocation) |
| `exp` / `iat` | Expiry and issue timestamps |

**`project`, `role`, `team`, `base_confidence` are NOT in the token.** They are
resolved from your user profile on the gateway (`GET /user/profile/:username`, cached
in Redis) on each request, using the `X-Quorum-Project` header to identify which
project's membership record to read. The auth response body includes `role`, `team`,
and `project` for display — but they are not JWT claims.

---

## Project mismatch

Because the token is slim (no `project` claim), project context flows through the
`.quorum` file and the `X-Quorum-Project` header — not the token. Switching projects
is automatic: the MCP server reads `q_project_id` (or `project_id`) from the `.quorum`
file in the current directory and sends it on every request. No re-authentication needed
when switching repos.

`POST /auth/switch` and `GET /auth/projects` are **retired (410 Gone)** in v0.3.
Use `GET /user/profile/:username` and the `X-Quorum-Project` header pattern instead.

If you are not a member of the target project, you will see:

```
status: project_mismatch
message: You are not a member of project '<this-project>'.
hint: Ask your Quorum principal architect to add you to the project config, then retry.
```

**Fix:** Ask the principal architect to add your GitHub username to
`<project_id>.quorum.json` and re-upload the config. Then retry the failing tool.

---

## Already authenticated

If the MCP server already holds a valid token, tools run without prompting.
Calling `authenticate()` explicitly when already authenticated returns:

```
status: already_authenticated
user: <your-github-username>
project: <project>
role: <role>
```

To switch projects explicitly:
```
authenticate({ project_id: "other-project-id" })
```

---

## Gateway-only architecture

The MCP server **always** routes through the Quorum Gateway — there is no
"direct mode". `QUORUM_GATEWAY_URL` defaults to `http://localhost:3001` and is
registered automatically during `npm install -g @as-quorum/mcp`.

All Graphiti operations (`remember`, `recall`, `search`, `reflect`, `history`,
`forget`) flow through the gateway's `/graphiti/*` proxy, which:
- Validates your JWT before forwarding to Graphiti
- Injects the correct `group_id` from your `X-Quorum-Project` header
- Normalises hyphens → underscores for FalkorDB/RediSearch internally

You never connect to Graphiti directly — the gateway is the only entry point.

---

## CI / non-interactive environments

Browser OAuth requires an interactive session. For CI pipelines where no browser
is available, set:

```bash
export QUORUM_AUTHOR=your-github-username   # identity for audit trail
# No JWT — CI has read-heavy workloads; writes go through human-gated pipelines
```

---

## Error reference

| Status | Cause | Fix |
|--------|-------|-----|
| `auth_timeout` | Browser tab not completed within 5 min | Run the tool again to restart flow |
| `project_mismatch` | Your GitHub username is not in the target project's config | Ask architect to add you to project config |
| `oauth_not_available` | Gateway OAuth endpoint not responding | Check `curl http://localhost:3001/health` |
| `registration_failed` | Dynamic client registration rejected | Check gateway logs |
| `token_exchange_failed` | Code/verifier exchange failed | Restart flow; check gateway logs if persists |
| `state_mismatch` | CSRF check failed | Restart the MCP server (`claude mcp restart quorum`), then retry |
