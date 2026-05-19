/**
 * Quorum MCP Server entry point.
 *
 * Startup sequence:
 *   1. Verify QUORUM_GATEWAY_URL is set (required — no default)
 *   2. Verify SHA256 audit chain integrity via gateway (non-fatal if not yet authenticated)
 *   3. Load S3 config (or local path / env fallback)
 *   4. Resolve caller identity (from JWT via gateway)
 *   5. Validate MCP manifest has no delete-capable tools
 *   6. Start /health HTTP endpoint
 *   7. Connect MCP stdio transport
 *
 * The MCP always communicates with a Quorum gateway over HTTP — never directly
 * to PostgreSQL or Graphiti. QUORUM_GATEWAY_URL must be set explicitly.
 *
 * Identity is resolved fresh on every tool call — not captured at startup —
 * so role changes in DDB/Redis (propagated via the gateway profile cache) are
 * reflected immediately. Tool schemas do not accept author/reviewer as input —
 * server-side only.
 */

import { findAndLoadQuorumFile } from './quorum-file.js';
import { log } from './logger.js';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from 'node:http';

import { verifyChain, ChainIntegrityViolation } from './audit/chain.js';
import { getAllEntries, countEntries } from './audit/secondary.js';
import { validateManifestHasNoDeleteTools } from './governance/constitutional.js';
import { ping as pingGraphiti } from './graph/client.js';
import { loadConfig, stopConfigPoller } from './config/loader.js';
import { resolveIdentity } from './identity/resolver.js';
import { getGatewayClient, isAuthenticated } from './gateway/client.js';
import * as authenticate from './tools/authenticate.js';
import * as setAgentContext from './tools/set-agent-context.js';
import { getAgentCtx } from './tools/set-agent-context.js';

import * as remember from './tools/remember.js';
import * as recall from './tools/recall.js';
import * as search from './tools/search.js';
import * as forget from './tools/forget.js';
import * as history from './tools/history.js';
import * as review from './tools/review.js';
import * as reflect from './tools/reflect.js';
import * as exportTool from './tools/export.js';
import * as pending from './tools/pending.js';
import * as configUpload from './tools/config-upload.js';

// ── Gateway URL (required) ─────────────────────────────────────────────────────
// QUORUM_GATEWAY_URL must be set — either via the .quorum project file,
// QUORUM_GATEWAY_URL env var, or `claude mcp add -e QUORUM_GATEWAY_URL=...`.
// No default is provided: a missing URL fails fast at tool-call time rather
// than silently targeting the wrong gateway.
if (!process.env.QUORUM_GATEWAY_URL) {
  console.error('[Quorum] ⚠  QUORUM_GATEWAY_URL is not set — tools will fail until a gateway URL is configured.');
  console.error('[Quorum]    Set it in your .quorum file or via: claude mcp add -e QUORUM_GATEWAY_URL=https://... quorum');
} else {
  console.error(`[Quorum] Gateway: ${process.env.QUORUM_GATEWAY_URL}`);
}
console.error(
  '[Quorum] ℹ  Not authenticated — call authenticate() to log in via GitHub OAuth',
);

// ── MCP Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'quorum',
  version: '0.2.0',
});

const tools = [
  { name: 'set_agent_context', def: setAgentContext },
  { name: 'authenticate', def: authenticate },
  { name: 'config_upload', def: configUpload },
  { name: 'search', def: search },
  { name: 'remember', def: remember },
  { name: 'recall', def: recall },
  { name: 'forget', def: forget },
  { name: 'history', def: history },
  { name: 'review', def: review },
  { name: 'reflect', def: reflect },
  { name: 'export', def: exportTool },
  { name: 'pending', def: pending },
];

/**
 * Resolve project context fresh on every tool call — stateless, no env mutation.
 *
 * Resolution order:
 *   1. MCP roots (Claude Code workspace dir) — walk up for .quorum file
 *   2. PWD / cwd — walk up for .quorum file
 *   3. Explicit env vars (QUORUM_PROJECT_ID / QUORUM_GROUP_ID)
 *
 * @returns {Promise<{ projectId: string, groupId?: string, gatewayUrl: string } | null>}
 */
async function resolveCtx() {
  // 1. Try MCP roots (Claude Code sends workspace dir per session — safe for parallel sessions)
  try {
    const result = await Promise.race([
      server.server.listRoots(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('listRoots timeout')), 500)),
    ])
    for (const root of result.roots ?? []) {
      const uri = root.uri ?? ''
      if (!uri.startsWith('file://')) continue
      const dir = decodeURIComponent(uri.slice('file://'.length))
      const cfg = findAndLoadQuorumFile(dir)
      if (cfg) {
        // Prefer q_project_id (canonical) when present; otherwise normalize group_id.
        // Hyphen→underscore normalization avoids RediSearch tag-filter pitfalls in FalkorDB.
        const projectId = cfg.q_project_id
          ? cfg.q_project_id.trim()
          : cfg.project_id.trim().replace(/-/g, '_')
        log.debug('resolveCtx: resolved from MCP roots', { dir, projectId, gatewayUrl: cfg.gateway_url })
        return { projectId, groupId: cfg.project_id.trim(), gatewayUrl: cfg.gateway_url }
      }
    }
  } catch (err) {
    log.debug('resolveCtx: listRoots failed', { error: err.message })
  }

  // 2. Fall back to PWD / cwd (for when claude launched from project dir)
  for (const dir of [process.env.PWD, process.cwd()].filter(Boolean)) {
    const cfg = findAndLoadQuorumFile(dir)
    if (cfg) {
      const projectId = cfg.q_project_id
        ? cfg.q_project_id.trim()
        : cfg.project_id.trim().replace(/-/g, '_')
      log.debug('resolveCtx: resolved from cwd', { dir, projectId, gatewayUrl: cfg.gateway_url })
      return { projectId, groupId: cfg.project_id.trim(), gatewayUrl: cfg.gateway_url }
    }
  }

  // 3. Fall back to explicit env vars (CI/enterprise contexts)
  const rawQProjectId = process.env.QUORUM_Q_PROJECT_ID?.trim() ?? null
  const rawProjectId  = process.env.QUORUM_PROJECT_ID?.trim() ?? process.env.QUORUM_GROUP_ID?.trim() ?? null
  const gatewayUrl    = process.env.QUORUM_GATEWAY_URL ?? null
  if (rawQProjectId || rawProjectId) {
    const projectId = rawQProjectId ?? rawProjectId.replace(/-/g, '_')
    log.debug('resolveCtx: resolved from env vars', { projectId, gatewayUrl })
    return { projectId, groupId: rawProjectId ?? null, gatewayUrl: gatewayUrl ?? null }
  }

  log.warn('resolveCtx: no project context found — no .quorum file and no env vars set')
  return null
}

/**
 * Sanitize an error message before returning it to Claude.
 * Strips URLs, file paths, and internal implementation details to avoid
 * leaking gateway addresses or filesystem layout via error messages.
 * The full error is kept in the debug log.
 * @param {Error} err
 * @returns {string}
 */
function sanitizeErrorForClaude(err) {
  const msg = err.message ?? 'Unknown error'
  return msg
    .replace(/https?:\/\/[^\s]+/g, '[gateway]')
    .replace(/\/[a-z][a-z0-9/_-]+\.[a-z]+/g, '[path]')
    .slice(0, 200)
}

/**
 * Register all tools with the MCP server.
 *
 * Identity is resolved fresh on every tool call — not captured at startup — so
 * role changes in DDB/Redis are reflected immediately. The per-call cost is one
 * async function call (gateway JWT decode is purely in-memory; the network is
 * only touched on fallback to resolveIdentity()). Identity is never sourced
 * from tool input.
 *
 * Pool resolution is also deferred to call time (not startup) so that the
 * authenticate() tool can inject a token at runtime and subsequent tool calls
 * transparently pick up the new gateway client.
 */
export function registerTools() {
  for (const { name, def } of tools) {
    server.tool(name, def.schema, async input => {
      log.startCall(name)
      try {
        // Resolve fresh ctx on every call — stateless, no env mutation.
        // Each Claude Code session has its own MCP server process + stdio pipe,
        // so listRoots() returns this session's directory — safe for parallel sessions.
        log.info(`tool:${name}`, { input })
        const ctx = await resolveCtx();

        // Gate 1: no project context — .quorum file missing and no env fallback
        if (!ctx && name !== 'authenticate' && name !== 'config_upload') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'no_project_context',
                  message:
                    'No .quorum file found in this workspace. Quorum cannot be used until this project is onboarded.',
                  hint: 'Run the /quorum onboard skill to connect this project to Quorum. This creates the .quorum file and uploads the project config to the gateway.',
                  debug_log: log.path,
                }),
              },
            ],
            isError: true,
          };
        }

        // Gate 2: project context known but not yet authenticated (gateway mode only)
        if (ctx?.gatewayUrl && !isAuthenticated() && name !== 'authenticate') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'not_authenticated',
                  message:
                    'Not authenticated with the Quorum gateway. Call authenticate() to log in via GitHub OAuth.',
                  hint: 'authenticate() will open your browser to complete the GitHub OAuth flow.',
                  debug_log: log.path,
                }),
              },
            ],
            isError: true,
          };
        }

        // Gate 3: write tools require agent context to be set first
        const WRITE_TOOLS = new Set(['remember', 'reflect', 'forget', 'review'])
        if (WRITE_TOOLS.has(name) && !getAgentCtx()) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: 'agent_context_required',
                message: 'Call set_agent_context({ agent_id }) before writing to Quorum.',
                hint: 'set_agent_context identifies this agent session for audit and governance. Use a descriptive kebab-case name (e.g. "claude-code", "subagent-auth-fix").',
              }),
            }],
            isError: true,
          }
        }

        // Resolve gateway client from ctx URL (or env fallback inside getGatewayClient)
        const activePool = getGatewayClient(ctx?.gatewayUrl);

        // Inject project scope — v0.3: project travels as X-Quorum-Project header, not JWT claim
        if (activePool?.setProjectId) activePool.setProjectId(ctx?.projectId ?? null)

        // Merge agent context into ctx for write tools
        const agentCtx = getAgentCtx()
        if (ctx && agentCtx) {
          ctx.agentId    = agentCtx.agent_id
          ctx.sessionId  = agentCtx.session_id
          ctx.authorType = agentCtx.author_type
        }

        // Resolve identity fresh on every call — captures live role from the
        // gateway profile cache so role changes in DDB/Redis take effect
        // immediately (Gap 5). Falls back to local resolution when the gateway
        // path is unavailable so the server keeps working pre-auth.
        let identity
        try {
          identity = activePool
            ? await activePool.getIdentity()
            : await resolveIdentity()
        } catch {
          identity = await resolveIdentity()
        }

        const result = await def.handler(activePool, input, identity, ctx);
        return {
          content: [
            {
              type: 'text',
              text:
                typeof result === 'string'
                  ? result
                  : JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        log.error(`tool:${name} failed`, { error: err.message, stack: err.stack })
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: sanitizeErrorForClaude(err),
              debug_log: log.path,
            }),
          }],
          isError: true,
        };
      } finally {
        log.endCall()
      }
    });
  }
}

// ── Startup ────────────────────────────────────────────────────────────────────

async function verifyStoreSync() {
  const gw = getGatewayClient();
  if (!gw) return; // not yet authenticated — skip
  const count = await gw.countEntries().catch(() => -1);
  if (count === -1) {
    console.error('[Quorum] WARNING: Could not reach audit store via gateway');
  }
}

async function startup() {
  console.error('[Quorum] Starting up...');

  // 1. Verify audit chain integrity — via gateway (non-fatal if not yet authenticated)
  try {
    const gw = getGatewayClient();
    const entries = gw ? await gw.getAllEntries({}).catch(() => []) : [];
    if (entries.length > 0) {
      const result = verifyChain(entries);
      console.error(
        `[Quorum] ✓ Audit chain verified (${result.entries} entries)`,
      );
    } else {
      console.error(
        '[Quorum] ✓ Audit chain empty — fresh start or not yet authenticated',
      );
    }
  } catch (err) {
    if (err instanceof ChainIntegrityViolation) {
      console.error(
        `[Quorum] FATAL: Audit chain integrity violation at position ${err.position}`,
      );
      console.error(`[Quorum] Expected: ${err.expected}`);
      console.error(`[Quorum] Actual:   ${err.actual}`);
      process.exit(1);
    }
    console.error(
      '[Quorum] WARNING: Could not verify audit chain:',
      err.message,
    );
  }

  // 2. Verify gateway is reachable (skip if not yet authenticated)
  await verifyStoreSync();

  // 3. Load config from S3 / local file / env fallback
  // Config must be loaded before identity resolution (identity maps roles from config)
  try {
    const config = await loadConfig(null);
    console.error(
      `[Quorum] ✓ Config loaded (project: ${config.project}, members: ${config.members.length})`,
    );
  } catch (err) {
    console.error(
      `[Quorum] WARNING: Config load failed — using env defaults: ${err.message}`,
    );
  }

  // 4. Resolve caller identity for diagnostics ONLY — the actual identity used
  // by tool handlers is resolved fresh per call (see registerTools). This
  // one-time resolve is kept solely so the startup log surfaces who the server
  // believes it's running as.
  const activeGatewayClient = getGatewayClient();
  let identity;
  try {
    identity = activeGatewayClient
      ? await activeGatewayClient.getIdentity()
      : await resolveIdentity();
  } catch {
    identity = await resolveIdentity();
  }
  console.error(
    `[Quorum] ✓ Identity resolved: ${identity.name} (method: ${identity.method}, role: ${identity.role ?? 'none'}) — re-resolved on every tool call`,
  );

  // 5. Validate MCP manifest has no delete-capable tools
  validateManifestHasNoDeleteTools(tools.map(t => ({ name: t.name })));
  console.error('[Quorum] ✓ Tool manifest validated (no delete tools)');

  // 6. Register tools — identity is resolved fresh inside each handler invocation
  registerTools();

  // 7. Start health HTTP endpoint
  startHealthServer();

  // 8. Connect MCP transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[Quorum] ✓ MCP server connected via stdio');
  console.error(`[Quorum] Ready — ${tools.length} tools registered`);
}

// ── Health HTTP server ─────────────────────────────────────────────────────────

function startHealthServer() {
  const port = parseInt(process.env.QUORUM_PORT ?? '8000', 10);

  const httpServer = createServer(async (req, res) => {
    if (req.url !== '/health' && req.url !== '/') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const [graphConnected, auditConnected] = await Promise.all([
      pingGraphiti(),
      getGatewayClient()
        ?.ping()
        .then(() => true)
        .catch(() => false) ?? false,
    ]);

    const status = graphConnected && auditConnected ? 'healthy' : 'degraded';
    const code = status === 'healthy' ? 200 : 503;

    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status,
        graph: graphConnected ? 'connected' : 'unavailable',
        audit: auditConnected ? 'connected' : 'unavailable',
        timestamp: new Date().toISOString(),
      }),
    );
  });

  httpServer.listen(port, () => {
    console.error(
      `[Quorum] ✓ Health endpoint: http://localhost:${port}/health`,
    );
  });
}

// ── Graceful shutdown ──────────────────────────────────────────────────────────

async function shutdown() {
  console.error('[Quorum] Shutting down...');
  stopConfigPoller();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ── Run ────────────────────────────────────────────────────────────────────────

// Only auto-run startup when executed as the main entrypoint — not when
// imported by tests. import.meta.url uses the file:// scheme; process.argv[1]
// is the resolved path of the entry script.
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`
      || import.meta.url.endsWith(process.argv[1] ?? '')
  } catch {
    return false
  }
})()

if (isMain) {
  startup().catch(err => {
    console.error('[Quorum] Startup failed:', err);
    process.exit(1);
  });
}
