/**
 * config_upload() — Upload a project config to the Quorum Gateway.
 *
 * Onboarding Phase 4 tool. Reads a local <group_id>.quorum.json file and
 * POSTs it to POST /config/upload using the JWT already held in MCP server
 * memory from authenticate().
 *
 * No token handling is required — the GatewayClient injects the Authorization
 * header automatically on every request.
 *
 * This tool is exempt from Gate 1 (no_project_context) in server.js because
 * it runs BEFORE the .quorum file is created (Phase 5). Gate 2 (auth check)
 * still applies — authenticate() must be called first.
 *
 * Expected gateway responses:
 *   200 → { project_id, message } — project onboarded successfully
 *   409 → already_onboarded — project already exists in S3; proceed to Phase 5
 *   400 → validation error — fix the config and retry
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'

/**
 * Zod schema for config_upload tool parameters.
 *
 * @type {z.ZodObject}
 */
export const schema = z.object({
  config_path: z
    .string()
    .describe(
      'Absolute or relative path to the <group_id>.quorum.json config file, ' +
        'e.g. "platform-team.quorum.json". The filename must match the group_id field.',
    ),
})

/**
 * Upload a project config to the Quorum Gateway.
 *
 * Reads the config from the given file path and POSTs to /config/upload.
 * The in-memory JWT from authenticate() is injected automatically by the
 * GatewayClient — no manual token handling needed.
 *
 * @param {import('../gateway/client.js').GatewayClient} gw - Gateway client (JWT already stored)
 * @param {z.infer<typeof schema>} input - Tool parameters
 * @returns {Promise<Record<string, unknown>>} Gateway response or structured error
 */
export async function handler(gw, input) {
  // ── Read config file ─────────────────────────────────────────────────────────

  const filePath = resolve(input.config_path)
  let configData

  try {
    const raw = readFileSync(filePath, 'utf8')
    configData = JSON.parse(raw)
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EACCES') {
      return {
        status: 'error',
        error: 'file_read_failed',
        message: `Could not read config file at ${filePath}: ${err.message}`,
        hint: 'Check the path and ensure the file exists. The filename must match the group_id, e.g. platform-team.quorum.json',
      }
    }
    return {
      status: 'error',
      error: 'file_parse_failed',
      message: `Invalid JSON in ${filePath}: ${err.message}`,
      hint: 'Validate the config with the gateway: curl -s -X POST $GATEWAY_URL/config/validate -H "Content-Type: application/json" -d @<file>',
    }
  }

  // ── Upload via gateway ───────────────────────────────────────────────────────

  try {
    const result = typeof gw.uploadConfig === 'function'
      ? await gw.uploadConfig(configData)
      : await gw._post('/config/upload', configData)
    return {
      status:       'onboarded',
      project_id:   result.project_id ?? configData.group_id,
      q_project_id: result.q_project_id ?? null,
      message:      result.message ?? 'Project onboarded successfully.',
      next_step:    result.q_project_id
        ? `Add both project_id and q_project_id to your .quorum file:\n{"gateway_url":"${gw._gatewayUrl ?? 'YOUR_GATEWAY_URL'}","project_id":"${configData.group_id}","q_project_id":"${result.q_project_id}"}`
        : 'Create a .quorum file with gateway_url and project_id.',
    }
  } catch (err) {
    // 409 already_onboarded — not an error; project exists, proceed to Phase 5
    if (err.status === 409 || err.message.includes('(409)')) {
      return {
        status:       'already_onboarded',
        project_id:   configData.group_id,
        q_project_id: err.body?.q_project_id ?? null,
        message:      'Project already exists in Quorum.',
        hint:         'Proceed to Phase 5 — create the .quorum discovery file. You are connecting to an existing project, not creating a new one.',
      }
    }

    // Surface all other gateway errors (400 validation, 500, etc.) clearly
    throw err
  }
}
