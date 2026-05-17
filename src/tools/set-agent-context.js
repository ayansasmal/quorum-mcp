/**
 * set_agent_context() — Register this agent's identity for the current session.
 *
 * Must be called before any write tool (remember, reflect, forget, review).
 * Write tools return agent_context_required until this is called.
 *
 * Sets module-level session state (safe: MCP server is a stdio subprocess —
 * one process per Claude Code session, no shared state across sessions).
 *
 * author_type is always 'agent' for MCP writes — server enforced, not caller-supplied.
 */

import { z } from 'zod'
import { createHash } from 'node:crypto'

export const schema = z.object({
  agent_id: z
    .string()
    .regex(
      /^[a-z][a-z0-9-]{0,39}$/,
      'agent_id must be kebab-case, start with a letter, max 40 chars (e.g. "claude-code", "subagent-auth")',
    )
    .describe('Descriptive name for this agent session (kebab-case, max 40 chars)'),
})

/**
 * Module-level agent context — set once per session via set_agent_context().
 * Exported via getAgentCtx() for use in server.js gate + ctx merging.
 * @type {{ agent_id: string, session_id: string, author_type: 'agent' } | null}
 */
let _agentCtx = null

/**
 * Return the current agent context, or null if not yet set.
 * @returns {{ agent_id: string, session_id: string, author_type: 'agent' } | null}
 */
export function getAgentCtx() {
  return _agentCtx
}

/**
 * @param {unknown} _pg  - not used (reads only)
 * @param {z.infer<typeof schema>} input
 * @returns {Promise<Record<string, unknown>>}
 */
export async function handler(_pg, input) {
  const sessionId = deriveSessionId()

  _agentCtx = {
    agent_id:    input.agent_id,
    session_id:  sessionId,
    author_type: 'agent',
  }

  return {
    status:      'context_set',
    agent_id:    input.agent_id,
    session_id:  sessionId,
    author_type: 'agent',
    note:        'All writes this session tagged with this agent identity. author_type is always "agent" for MCP writes.',
  }
}

/**
 * Derive a short session ID from process start time + PID.
 * Server-side only — not caller-supplied.
 * @returns {string}
 */
function deriveSessionId() {
  const seed = `${process.pid}-${process.hrtime.bigint()}`
  return 'sess_' + createHash('sha256').update(seed).digest('hex').slice(0, 8)
}
