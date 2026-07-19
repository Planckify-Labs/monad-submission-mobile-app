/**
 * Mobile agent tool executor registry.
 *
 * This is the mobile-side counterpart to the server's `TOOL_REGISTRY`
 * (see `takumi-agent-api/src/tools/registry.ts`). The SSE dispatcher
 * imports `EXECUTORS` and looks up the right function by the `name`
 * field on each `tool_pending` payload.
 *
 * Every entry here MUST correspond to a tool with `executor: "mobile"`
 * in the server registry. Drift is caught at boot by
 * `assertRegistryParity` (below) and in CI by `pnpm check:agents`
 * (Task 18).
 *
 * Wallet executors live under `./wallet/`; DeFi stub executors under
 * `./defi/`. The flat `EXECUTORS` map is preserved via composition
 * (spec §7.2). Each per-agent bucket is wrapped with
 * `composeAgentExecutors` so a tool dropped into the wrong folder
 * fails loudly at module load.
 */

export * from "./chainRouter";
export * from "./types";

import { AGENT_MANIFEST, resolveAgentForTool } from "./agentManifest";
import {
  AGENT_FOR_EXECUTOR,
  composeAgentExecutors,
} from "./composeAgentExecutors";
import { DEFI_EXECUTORS as DEFI_TOOL_EXECUTORS } from "./defi";
import type { MobileToolExecutor } from "./types";
import {
  ADDRESS_BOOK_EXECUTORS,
  CAPABILITY_EXECUTORS,
  POINTS_EXECUTORS,
  READ_EXECUTORS,
  SIMULATE_EXECUTORS,
  SOLANA_EXECUTORS,
  SOLANA_TAKUMI_PAY_EXECUTORS,
  STELLAR_EXECUTORS,
  SUI_EXECUTORS,
  WRITE_EXECUTORS,
  X402_EXECUTORS,
} from "./wallet";

const WALLET_EXECUTORS = composeAgentExecutors("wallet", {
  ...CAPABILITY_EXECUTORS,
  ...READ_EXECUTORS,
  ...SIMULATE_EXECUTORS,
  ...WRITE_EXECUTORS,
  ...POINTS_EXECUTORS,
  ...ADDRESS_BOOK_EXECUTORS,
  ...SOLANA_EXECUTORS,
  ...SOLANA_TAKUMI_PAY_EXECUTORS,
  ...SUI_EXECUTORS,
  ...STELLAR_EXECUTORS,
  ...X402_EXECUTORS,
});

const DEFI_EXECUTORS = composeAgentExecutors("defi", {
  ...DEFI_TOOL_EXECUTORS,
});

/**
 * The registry itself. Keys are the canonical tool names the server
 * emits via `tool_pending.name`.
 *
 *     const executor = EXECUTORS[payload.name];
 *     if (!executor) return rejectTool(payload, "unknown_tool");
 *     const result = await executor(payload.input, context);
 *
 * Do NOT introduce fuzzy matching — unknown tools must fail loudly.
 */
export const EXECUTORS: Record<string, MobileToolExecutor> = {
  ...WALLET_EXECUTORS,
  ...DEFI_EXECUTORS,
};

/**
 * Expected mobile tool list — the mobile mirror of every `executor: "mobile"`
 * server tool. Lives in a dedicated import-free module
 * (`./expectedMobileTools`) so `registryParity.test.ts` can load it under
 * vitest without pulling this file's RN-heavy executor graph. Re-exported here
 * for the existing `import { EXPECTED_MOBILE_TOOLS } from "./index"` callers.
 */
export { EXPECTED_MOBILE_TOOLS } from "./expectedMobileTools";
import { EXPECTED_MOBILE_TOOLS } from "./expectedMobileTools";

/**
 * Runtime assertion helper called once at app bootstrap.
 *
 * Two layers of parity:
 *   1. Every name in `EXPECTED_MOBILE_TOOLS` has an entry in
 *      `EXECUTORS` (catches missing executor implementations).
 *   2. The bucket each executor was registered under (`composeAgentExecutors`
 *      writes to `AGENT_FOR_EXECUTOR`) matches the agent the manifest
 *      claims owns its prefix (catches a tool dropped into the wrong
 *      subfolder).
 *
 * Failures throw — registry drift must crash loudly. The orchestrator
 * surfaces friendly copy to users on a boot fault (CLAUDE.md
 * user-facing-error rule).
 */
export function assertRegistryParity(): void {
  for (const name of EXPECTED_MOBILE_TOOLS) {
    if (!(name in EXECUTORS)) {
      throw new Error(
        `[agent-executors] missing executor for tool "${name}" — ` +
          "check services/agent-executors/index.ts",
      );
    }
  }
  for (const [toolName, agentId] of AGENT_FOR_EXECUTOR.entries()) {
    const expected = resolveAgentForTool(toolName, AGENT_MANIFEST);
    if (!expected) {
      throw new Error(
        `[agent-executors] prefix mismatch: tool "${toolName}" registered under "${agentId}" but no agent in the manifest claims its prefix`,
      );
    }
    if (expected !== agentId) {
      throw new Error(
        `[agent-executors] prefix mismatch: tool "${toolName}" registered under "${agentId}" but manifest assigns it to "${expected}"`,
      );
    }
  }
}
