/**
 * Layer 5 — protocol state and post-execution (spec §11 Layer 5, §11.6 #3).
 *
 * Provider-backed, so chain-agnostic: an Aave reserve's `isFrozen`, a Comet
 * supply pause, a Sui `assert_version` gate and a Stellar contract's paused
 * flag are all the same question — "is the protocol accepting this right now?"
 */

import { getChainSafetyProvider } from "../registry";
import type { SafetyCheck } from "../types";

/**
 * Protocol pause / frozen check (§11 Layer 5, `[N]`). Read the protocol's OWN
 * emergency state before depositing. A frozen reserve or a paused Comet will
 * revert, but a deprecated Morpho market or an expired Pendle PT may not — it
 * will simply accept funds into something nobody is maintaining.
 */
export const ProtocolHaltedCheck: SafetyCheck = {
  id: "protocol-halted",
  layer: 5,
  run: async (ctx) => {
    const provider = getChainSafetyProvider(ctx.namespace);
    if (!provider) return { ok: true };
    const halted = await provider.isProtocolHalted(ctx.target, ctx.chainId);
    return halted
      ? {
          ok: false,
          fail: "protocol_paused",
          detail: "the protocol has paused or frozen this market",
        }
      : { ok: true };
  },
};

/**
 * Position-delta assertion (§11 Layer 5, `[N]`). After a deposit, the position
 * must actually have grown; after a withdraw, the funds must be back. A mined,
 * successful transaction is not proof the user got what they paid for — a
 * mis-encoded call can succeed and deposit somewhere else entirely.
 *
 * Runs at the `postexec` stage, so it never blocks a deposit; a mismatch is a
 * reconciliation alert, and the check surfaces it rather than swallowing it.
 */
export const PositionDeltaCheck: SafetyCheck = {
  id: "position-delta",
  layer: 5,
  appliesTo: { stages: ["postexec"] },
  run: async (ctx) => {
    const provider = getChainSafetyProvider(ctx.namespace);
    if (!provider) return { ok: true };
    const delta = await provider.readPositionDelta(
      ctx.target,
      ctx.wallet,
      ctx.chainId,
    );
    if (delta <= 0n) {
      return {
        ok: false,
        fail: "submission_unconfirmed",
        detail: "position did not increase after the deposit",
      };
    }
    return { ok: true };
  },
};

/**
 * Reorg / finality policy (§11.6 #3). "Done" needs the chain's finality depth
 * before the position is marked settled and anything downstream fires — 1 on an
 * instant-finality L2, more where reorgs happen. Until then the state is
 * `awaiting_finality`, which is a PENDING state, not a user error.
 */
export const FinalityCheck: SafetyCheck = {
  id: "finality-depth",
  layer: 5,
  appliesTo: { stages: ["postexec"] },
  run: async (ctx) => {
    const provider = getChainSafetyProvider(ctx.namespace);
    const depth = provider?.finalityDepth?.(ctx.chainId);
    if (typeof depth !== "number" || depth <= 1) return { ok: true };
    // Confirmation counting belongs to the submitter, which owns the receipt.
    // What this check contributes is the policy: a chain with a real reorg
    // window must not report "settled" on one confirmation.
    const confirmations = Number(ctx.sim?.stateDelta?.confirmations ?? 0);
    return confirmations >= depth
      ? { ok: true }
      : {
          ok: false,
          fail: "awaiting_finality",
          detail: `waiting for ${depth} confirmations on this chain`,
        };
  },
};

export const LAYER5_CHECKS: readonly SafetyCheck[] = [
  ProtocolHaltedCheck,
  PositionDeltaCheck,
  FinalityCheck,
];
