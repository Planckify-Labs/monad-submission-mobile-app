/**
 * Layer 5 — protocol state and post-execution (spec §11 Layer 5, §11.6 #3).
 *
 * Provider-backed, so chain-agnostic: an Aave reserve's `isFrozen`, a Comet
 * supply pause, a Sui `assert_version` gate and a Stellar contract's paused
 * flag are all the same question — "is the protocol accepting this right now?"
 *
 * The two `postexec` checks below are the only ones in the whole pipeline
 * that run AFTER funds have moved, which changes what a failure means. Every
 * other layer is a gate: it fails and nothing happens. These two cannot undo
 * anything, so a failure is a RECONCILIATION ALERT — "the transaction
 * succeeded but we could not see the position move" — and the caller must
 * surface it without turning a landed deposit into a reported failure. That
 * asymmetry is enforced at the call site (`safety/postexec.ts` never throws),
 * not here, because a check's job is still just to state whether the property
 * holds.
 */

import { getChainSafetyProvider } from "../registry";
import { NO_TARGET_TO_VERIFY, type SafetyCheck } from "../types";

/**
 * Protocol pause / frozen check (§11 Layer 5, `[N]`). Read the protocol's OWN
 * emergency state before depositing. A frozen reserve or a paused Comet will
 * revert, but a deprecated Morpho market or an expired Pendle PT may not — it
 * will simply accept funds into something nobody is maintaining.
 *
 * Scoped to the pre-execution stages. It used to carry no stage scope at all,
 * which meant that once `postexec` was actually wired it would start asking
 * "is this protocol paused?" about a deposit that had already landed — a
 * question with no useful answer, since a pause that begins after the deposit
 * is not a reason to flag the deposit, and it would have cost an extra RPC
 * read on every settled transaction.
 */
export const ProtocolHaltedCheck: SafetyCheck = {
  id: "protocol-halted",
  layer: 5,
  appliesTo: {
    stages: ["presign", "submit", "broadcast"],
    requiresTarget: true,
  },
  run: async (ctx) => {
    if (!ctx.target) return NO_TARGET_TO_VERIFY;
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
 * Position-delta assertion (§11 Layer 5, `[N]`). After a deposit the position
 * must actually have grown; after a withdraw it must have shrunk. A mined,
 * successful transaction is not proof the user got what they paid for — a
 * mis-encoded call can succeed and deposit somewhere else entirely.
 *
 * It is a DELTA, which needs two readings. The earlier version had only one:
 * it read the balance after execution and failed when that was `<= 0`. Against
 * every provider in this codebase — all three return an absolute balance, not
 * a difference — that asks "does the user have a position at all", which any
 * user who already held one passes for free. The single case the check exists
 * to catch (a deposit that succeeded on chain and landed nowhere) is exactly
 * the case a pre-existing position hides. So the caller snapshots the balance
 * immediately before submitting and passes it as `ctx.positionBefore`.
 *
 * Non-fatal in two situations, both of them "we could not look" rather than
 * "we looked and it was wrong":
 *   - no snapshot was taken (`positionBefore` absent), and
 *   - the post-execution read failed (`null`, per `readPositionBalance`).
 * Treating either as a mismatch would raise an alarm about money that moved
 * perfectly well, which is worse than staying quiet — and the caller reports
 * the transaction as unverified in both cases anyway.
 */
export const PositionDeltaCheck: SafetyCheck = {
  id: "position-delta",
  layer: 5,
  appliesTo: { stages: ["postexec"], requiresTarget: true },
  run: async (ctx) => {
    if (!ctx.target) return NO_TARGET_TO_VERIFY;
    const provider = getChainSafetyProvider(ctx.namespace);
    if (!provider) return { ok: true };

    const before = ctx.positionBefore;
    if (before === undefined) return { ok: true };

    const after = await provider.readPositionBalance(
      ctx.target,
      ctx.wallet,
      ctx.chainId,
    );
    if (after === null) return { ok: true };

    // Direction is read from the action, not from the target or the stage.
    // Without this the check is deposit-shaped, and wiring `postexec` on the
    // withdraw path would have flagged every correct withdrawal as a failure
    // for doing precisely what it was asked to do.
    if (ctx.action === "withdraw") {
      return after < before
        ? { ok: true }
        : {
            ok: false,
            fail: "submission_unconfirmed",
            detail: "position did not decrease after the withdrawal",
          };
    }
    return after > before
      ? { ok: true }
      : {
          ok: false,
          fail: "submission_unconfirmed",
          detail: "position did not increase after the deposit",
        };
  },
};

/**
 * Reorg / finality policy (§11.6 #3). "Done" needs the chain's finality depth
 * before the position is marked settled and anything downstream fires — 1 on an
 * instant-finality L2, more where reorgs happen. Until then the state is
 * `awaiting_finality`, which is a PENDING state, not a user error.
 *
 * Confirmation counting belongs to the submitter, which owns the receipt, so
 * the count arrives on the context. What this check contributes is the policy:
 * a chain with a real reorg window must not report "settled" on one
 * confirmation. A caller that cannot supply a count leaves the field unset and
 * the check stays quiet rather than asserting a depth it never measured.
 */
export const FinalityCheck: SafetyCheck = {
  id: "finality-depth",
  layer: 5,
  appliesTo: { stages: ["postexec"] },
  run: async (ctx) => {
    const provider = getChainSafetyProvider(ctx.namespace);
    const depth = provider?.finalityDepth?.(ctx.chainId);
    if (typeof depth !== "number" || depth <= 1) return { ok: true };
    if (ctx.confirmations === undefined) return { ok: true };
    return ctx.confirmations >= depth
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
