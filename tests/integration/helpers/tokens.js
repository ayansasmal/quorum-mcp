/**
 * Token factory for MCP integration tests.
 *
 * Re-exports the same factory functions used by the gateway E2E suite, pointing
 * at the shared test private key in quorum/e2e/fixtures/. Both repos
 * share the same key so the gateway accepts these tokens in test mode.
 *
 * Role mapping for quorum-test-project (canonical fixtures):
 *   test-pe        → principal_architect  (ACTIVE writes, can approve)
 *   test-engineer  → engineer             (DRAFT writes only)
 *   test-architect → architect            (PA in quorum-test-peer-project)
 *   test-admin     → is_admin: true       (admin routes)
 */

export {
  peToken as paToken,
  pe2Token,
  engineerToken,
  architectToken,
  adminToken,
  token,
} from '../../../../quorum/e2e/helpers/jwt.js';

// Re-export with MCP-test-specific aliases so test files read clearly
export { peToken } from '../../../../quorum/e2e/helpers/jwt.js';
