/**
 * authenticate() — MCP OAuth 2.1 + PKCE flow against the Quorum Gateway.
 *
 * Auth model (MCP spec 2025-03-26, Third-Party Authorization Flow):
 *   1. Discover gateway OAuth metadata (RFC8414)
 *   2. Register this MCP client dynamically (RFC7591)
 *   3. Generate PKCE code_verifier + code_challenge (S256)
 *   4. Start a local HTTP callback listener on a random port (listen(0))
 *   5. Open the browser to gateway /oauth/authorize
 *   6. Engineer authenticates with GitHub inside the gateway — MCP never sees GitHub token
 *   7. Gateway redirects to localhost callback with ?code=...
 *   8. MCP exchanges code + verifier via POST /oauth/token
 *   9. Stores the Gateway-MCP Token (ES256 JWT) in-memory via setGatewayToken()
 *  10. Closes the callback listener
 *
 * The Gateway-MCP Token carries: sub, project, role, team, base_confidence, permissions.
 * It is the only token the MCP server ever holds — GitHub token never leaves the gateway.
 *
 * Graceful degradation: if BL-12 (gateway OAuth 2.1 server) is not yet live,
 * the tool returns a clear message instead of throwing.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { z } from 'zod'
import { setGatewayToken, getGatewayClient, isAuthenticated } from '../gateway/client.js'

const OAUTH_TIMEOUT_MS = 5 * 60 * 1000  // 5 minutes

export const schema = z.object({
  project_id: z.string().optional().describe(
    'Project ID to authenticate against. Defaults to QUORUM_PROJECT_ID env var or the project in the .quorum file.',
  ),
})

// ── PKCE helpers ───────────────────────────────────────────────────────────────

function generatePKCE() {
  const verifier  = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

// ── OAuth metadata discovery ───────────────────────────────────────────────────

/**
 * Fetch RFC8414 OAuth 2.1 Authorization Server Metadata from the gateway.
 * @param {string} gatewayUrl
 * @returns {Promise<{ authorization_endpoint: string, token_endpoint: string, registration_endpoint?: string }>}
 */
async function discoverMetadata(gatewayUrl) {
  const res = await fetch(`${gatewayUrl}/.well-known/oauth-authorization-server`)
  if (!res.ok) {
    throw new Error(`OAuth metadata discovery failed (${res.status}) — gateway OAuth 2.1 server not yet live`)
  }
  return res.json()
}

// ── Dynamic client registration ────────────────────────────────────────────────

/**
 * Register this MCP instance as an OAuth 2.1 client (RFC7591).
 * Returns the client_id assigned by the gateway.
 * @param {string} registrationEndpoint
 * @param {string} redirectUri
 * @returns {Promise<string>} client_id
 */
async function registerClient(registrationEndpoint, redirectUri) {
  const res = await fetch(registrationEndpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      client_name:   'quorum-mcp',
      redirect_uris: [redirectUri],
      grant_types:   ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',  // public client (PKCE)
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Client registration failed (${res.status}): ${err.error_description ?? res.statusText}`)
  }
  const data = await res.json()
  return data.client_id
}

// ── Local callback server ──────────────────────────────────────────────────────

/**
 * Start a local HTTP server on an ephemeral port to receive the OAuth callback.
 * Resolves with { code, state } when the redirect arrives, or rejects on timeout.
 * @returns {Promise<{ server: import('node:http').Server, port: number, codePromise: Promise<{ code: string, state: string }> }>}
 */
function startCallbackServer() {
  return new Promise((resolve) => {
    let resolveCode, rejectCode
    const codePromise = new Promise((res, rej) => {
      resolveCode = res
      rejectCode  = rej
    })

    const httpServer = createServer((req, res) => {
      const url    = new URL(req.url, 'http://localhost')
      const code   = url.searchParams.get('code')
      const state  = url.searchParams.get('state')
      const error  = url.searchParams.get('error')

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<html><body><h2>Authentication failed.</h2><p>You can close this tab.</p></body></html>')
        rejectCode(new Error(`OAuth error: ${error} — ${url.searchParams.get('error_description') ?? ''}`))
        return
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><h2>Quorum authenticated.</h2><p>You can close this tab and return to your editor.</p></body></html>')
        resolveCode({ code, state })
      }
    })

    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address()
      resolve({ server: httpServer, port, codePromise })
    })
  })
}

// ── Browser launcher ───────────────────────────────────────────────────────────

function openBrowser(url) {
  const platform = process.platform
  const [cmd, ...args] = platform === 'darwin'
    ? ['open', url]
    : platform === 'win32'
      ? ['cmd', '/c', 'start', url]
      : ['xdg-open', url]

  spawnSync(cmd, [...args], { stdio: 'ignore' })
}

// ── Token exchange ─────────────────────────────────────────────────────────────

/**
 * Exchange the authorization code for a Gateway-MCP Token.
 * @param {string} tokenEndpoint
 * @param {string} clientId
 * @param {string} code
 * @param {string} redirectUri
 * @param {string} verifier
 * @returns {Promise<string>} access_token (ES256 JWT)
 */
async function exchangeCode(tokenEndpoint, clientId, code, redirectUri, verifier) {
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    redirect_uri:  redirectUri,
    client_id:     clientId,
    code_verifier: verifier,
  })

  const res = await fetch(tokenEndpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Token exchange failed (${res.status}): ${err.error_description ?? res.statusText}`)
  }

  const data = await res.json()
  if (!data.access_token) {
    throw new Error('Token exchange succeeded but no access_token in response')
  }
  return data.access_token
}

// ── Handler ────────────────────────────────────────────────────────────────────

/**
 * @param {import('../gateway/client.js').GatewayClient} _gw
 * @param {z.infer<typeof schema>} input
 * @returns {Promise<Record<string, unknown>>}
 */
export async function handler(_gw, input) {
  const gatewayUrl = process.env.QUORUM_GATEWAY_URL

  if (!gatewayUrl) {
    return {
      status:  'not_applicable',
      message: 'QUORUM_GATEWAY_URL is not set — authentication is not required without a gateway.',
    }
  }

  const projectId = input.project_id ?? process.env.QUORUM_PROJECT_ID ?? null

  // Allow re-auth even if already authenticated (e.g. engineer switching project)
  if (isAuthenticated() && !input.project_id) {
    const gw   = getGatewayClient()
    const auth = await gw.verifyAuth()
    return {
      status:     'already_authenticated',
      user:       auth.sub,
      project:    auth.project,
      role:       auth.role ?? 'none',
      team:       auth.team ?? 'none',
      expires_in: auth.expiresIn,
      note:       'Already authenticated. Pass project_id to switch project.',
    }
  }

  // ── Step 1: Discover gateway OAuth metadata ────────────────────────────────
  let metadata
  try {
    metadata = await discoverMetadata(gatewayUrl)
  } catch (err) {
    return {
      status:  'oauth_not_available',
      message: err.message,
      hint:    'The Quorum gateway OAuth 2.1 server (BL-12) is not yet live. Check gateway deployment.',
    }
  }

  const authEndpoint  = metadata.authorization_endpoint
  const tokenEndpoint = metadata.token_endpoint
  const regEndpoint   = metadata.registration_endpoint

  if (!authEndpoint || !tokenEndpoint) {
    return {
      status:  'oauth_metadata_incomplete',
      message: 'Gateway OAuth metadata is missing authorization_endpoint or token_endpoint.',
    }
  }

  // ── Step 2: Start local callback server ────────────────────────────────────
  const { server: callbackServer, port, codePromise } = await startCallbackServer()
  const redirectUri = `http://127.0.0.1:${port}/callback`

  // ── Step 3: Dynamic client registration ───────────────────────────────────
  let clientId = 'quorum-mcp'
  if (regEndpoint) {
    try {
      clientId = await registerClient(regEndpoint, redirectUri)
    } catch (err) {
      callbackServer.close()
      return {
        status:  'registration_failed',
        message: err.message,
      }
    }
  }

  // ── Step 4: Generate PKCE ──────────────────────────────────────────────────
  const { verifier, challenge } = generatePKCE()
  const state = randomBytes(16).toString('base64url')

  // ── Step 5: Build authorize URL + open browser ─────────────────────────────
  const authParams = new URLSearchParams({
    response_type:         'code',
    client_id:             clientId,
    redirect_uri:          redirectUri,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
    state,
    ...(projectId ? { project_id: projectId } : {}),
  })
  const authorizeUrl = `${authEndpoint}?${authParams}`

  openBrowser(authorizeUrl)

  // ── Step 6: Await callback (5-minute timeout) ──────────────────────────────
  let code, returnedState
  try {
    const result = await Promise.race([
      codePromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('OAuth timeout — browser auth was not completed within 5 minutes')), OAUTH_TIMEOUT_MS),
      ),
    ])
    code          = result.code
    returnedState = result.state
  } catch (err) {
    callbackServer.close()
    return {
      status:  'auth_timeout',
      message: err.message,
      hint:    'Open the authorize URL manually if the browser did not open: ' + authorizeUrl,
    }
  } finally {
    callbackServer.close()
  }

  // Validate state to prevent CSRF
  if (returnedState !== state) {
    return {
      status:  'state_mismatch',
      message: 'OAuth state parameter mismatch — possible CSRF attempt. Do not retry without restarting the flow.',
    }
  }

  // ── Step 7: Exchange code for Gateway-MCP Token ────────────────────────────
  let accessToken
  try {
    accessToken = await exchangeCode(tokenEndpoint, clientId, code, redirectUri, verifier)
  } catch (err) {
    return {
      status:  'token_exchange_failed',
      message: err.message,
    }
  }

  // ── Step 8: Store token + verify ──────────────────────────────────────────
  setGatewayToken(accessToken)

  const gw   = getGatewayClient()
  const auth = await gw.verifyAuth()

  return {
    status:     'authenticated',
    user:       auth.sub,
    project:    auth.project,
    role:       auth.role ?? 'none',
    team:       auth.team ?? 'none',
    expires_in: auth.expiresIn,
    note:       'Gateway-MCP Token stored in-memory only. Re-auth required if the MCP server restarts.',
  }
}
