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

The Gateway-MCP Token (ES256 JWT) carries:

| Claim | Description |
|-------|-------------|
| `sub` | Your GitHub username |
| `project` | The `group_id` of the project you authenticated against |
| `role` | Your role: `principal_architect` \| `senior_engineer` \| `engineer` \| `junior` |
| `team` | Your team name from the project config |
| `base_confidence` | Your authority weight for knowledge writes |
| `permissions` | Scoped permission set derived from role |

---

## Project mismatch — automatic switch

If you previously authenticated against a different Quorum project and open a repo
with a `.quorum` file pointing to a different `project_id`, the MCP server detects
the mismatch and automatically calls `POST /auth/switch` to re-scope your token.

If the switch fails (you are not a member of the target project), you will see:

```
status: project_mismatch
message: You authenticated as '<other-project>' but this workspace uses '<this-project>'.
hint: Ask your Quorum principal architect to add you to the project config, then re-authenticate.
```

**Fix:** Ask the principal architect to add your GitHub username to
`<project_id>.quorum.json` and re-upload the config. Then call `authenticate()`.

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

## Direct mode (no gateway)

If `QUORUM_GATEWAY_URL` is not set, the MCP server runs in direct mode — it
talks to Graphiti directly and no authentication is required. Identity falls back to:

1. `QUORUM_AUTHOR` env var
2. `git config user.email`
3. `anonymous`

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
| `project_mismatch` | JWT project ≠ `.quorum` project_id, and switch failed | Ask architect to add you to project config |
| `oauth_not_available` | Gateway OAuth endpoint not responding | Check `curl http://localhost:3001/health` |
| `registration_failed` | Dynamic client registration rejected | Check gateway logs |
| `token_exchange_failed` | Code/verifier exchange failed | Restart flow; check gateway logs if persists |
| `state_mismatch` | CSRF check failed | Restart the MCP server (`claude mcp restart quorum`), then retry |
