/**
 * Layer 4 — execution integrity, at sign and submit (spec §11 Layer 4,
 * §11.6 #5).
 *
 * This is the **on-device trust anchor** (§11.1). Everything above it can be
 * satisfied by a backend we are trusting; these checks are the ones a
 * compromised backend cannot talk its way past, because they read the call that
 * is actually about to be signed.
 *
 * Provider-backed and therefore chain-agnostic: EVM decodes calldata, Sui
 * inspects PTB moveCalls, Solana inspects instruction accounts — all collapsing
 * to the same `DecodedIntent`, so "the recipient is the user's own wallet" is
 * one check on every chain.
 */

import { getChainSafetyProvider } from "../registry";
import type { SafetyCheck } from "../types";

/**
 * Chain binding (§11 Layer 4, `[N]`). The signed transaction must be bound to
 * the chain we validated the target on — EIP-155 `chainId` on EVM, the network
 * passphrase on Stellar, cluster + program id on Solana. Without it, a call
 * validated on one chain can be replayed on another where the same address is
 * a different contract entirely.
 */
export const ChainBindingCheck: SafetyCheck = {
  id: "chain-binding",
  layer: 4,
  appliesTo: { stages: ["submit"] },
  run: async (ctx) => {
    const provider = getChainSafetyProvider(ctx.namespace);
    if (!provider || !ctx.call) return { ok: true };
    return provider.assertChainBinding(ctx.call, ctx.chainId)
      ? { ok: true }
      : {
          ok: false,
          fail: "unsupported_chain",
          detail: "the built call is not bound to the intended chain",
        };
  },
};

/**
 * Decoded-intent match (§11 Layer 4, `[E→N]`). The preview already shows the
 * user what the call does; this is the MACHINE assertion that it really does
 * it — especially for `router-call`, whose calldata we did not author.
 *
 * Asserted: the destination is the resolved target or an allowlisted router,
 * the asset is the pool's underlying, the amount is what was requested, and the
 * recipient is the user's OWN wallet — never a third party.
 */
export const DecodedIntentMatchCheck: SafetyCheck = {
  id: "decoded-intent-match",
  layer: 4,
  appliesTo: { stages: ["submit"] },
  run: async (ctx) => {
    const provider = getChainSafetyProvider(ctx.namespace);
    if (!provider || !ctx.call) return { ok: true };

    const intent = await provider.decodeIntent(ctx.call);
    if (!intent) {
      return {
        ok: false,
        fail: "decoded_intent_mismatch",
        detail: "could not decode the built call",
      };
    }

    // The destination must be something Layer 1 already vouched for.
    const allowlisted = await provider.isAllowlisted(ctx.target, ctx.chainId);
    if (!allowlisted) {
      return {
        ok: false,
        fail: "target_not_allowlisted",
        detail: "call destination is not an approved target",
      };
    }

    // Funds and receipts come back to the user, always.
    if (
      intent.recipient &&
      intent.recipient.toLowerCase() !== ctx.wallet.toLowerCase()
    ) {
      return {
        ok: false,
        fail: "decoded_intent_mismatch",
        detail: "the call pays out to an address that is not the user's wallet",
      };
    }

    if (
      intent.assetIn &&
      intent.assetIn.toLowerCase() !== ctx.underlyingExpected.toLowerCase()
    ) {
      return {
        ok: false,
        fail: "decoded_intent_mismatch",
        detail: "the call moves a different asset than the pool's underlying",
      };
    }

    if (
      ctx.requestedAmount !== "MAX" &&
      intent.amountIn !== null &&
      intent.amountIn !== ctx.requestedAmount
    ) {
      return {
        ok: false,
        fail: "decoded_intent_mismatch",
        detail: "the call moves a different amount than requested",
      };
    }

    return { ok: true };
  },
};

/**
 * Approval scoping (§11 Layer 4, `[N]`, §8.4). Approve the EXACT amount to the
 * EXACT spender; never infinite. An infinite approval outlives the deposit and
 * turns any future compromise of that contract into a loss of the whole balance.
 */
export const ApprovalScopingCheck: SafetyCheck = {
  id: "approval-scoping",
  layer: 4,
  appliesTo: { stages: ["submit"] },
  run: async (ctx) => {
    const provider = getChainSafetyProvider(ctx.namespace);
    if (!provider || !ctx.call) return { ok: true };
    const intent = await provider.decodeIntent(ctx.call);
    if (!intent || intent.approvalAmount === null) return { ok: true };

    if (
      ctx.requestedAmount !== "MAX" &&
      intent.approvalAmount > ctx.requestedAmount
    ) {
      return {
        ok: false,
        fail: "decoded_intent_mismatch",
        detail: "approval is for more than the deposit amount",
      };
    }
    if (
      intent.spender &&
      intent.destination &&
      intent.spender.toLowerCase() !== intent.destination.toLowerCase()
    ) {
      return {
        ok: false,
        fail: "decoded_intent_mismatch",
        detail: "approval spender is not the call's destination",
      };
    }
    return { ok: true };
  },
};

/**
 * Simulate before sign (§11 Layer 4, `[E]`). Mandatory, and the ONLY authority
 * for router-call calldata we did not author: if the dry-run reverts, we do not
 * know what the call would have done, and that is reason enough not to send it.
 */
export const SimulateBeforeSignCheck: SafetyCheck = {
  id: "simulate-before-sign",
  layer: 4,
  // `broadcast`, NOT `submit`: at submit time an ERC-20 deposit has no
  // allowance yet (the approve is a separate transaction the executor sends
  // after these checks), so the dry-run reverts on the allowance every single
  // first-time deposit and reports "the dry-run reverted" for a call that is
  // perfectly fine. Simulating once the approvals are settled is both the
  // accurate reading and the one closest to the signature.
  appliesTo: { stages: ["broadcast"] },
  run: async (ctx) => {
    const provider = getChainSafetyProvider(ctx.namespace);
    if (!provider || !ctx.call) return { ok: true };
    const sim = ctx.sim ?? (await provider.simulate(ctx.call, ctx));
    return sim.ok
      ? { ok: true }
      : {
          ok: false,
          fail: "deposit_failed",
          detail: "the dry-run reverted",
        };
  },
};

/**
 * Quote freshness / deadline (§11 Layer 4, `[N]`, §12 Q8). A router quote past
 * its expiry is stale, sandwichable calldata — re-fetch, never sign.
 */
export const QuoteFreshnessCheck: SafetyCheck = {
  id: "quote-freshness",
  layer: 4,
  appliesTo: { kinds: ["router-call"], stages: ["submit"] },
  run: async (ctx) => {
    const provider = getChainSafetyProvider(ctx.namespace);
    if (!provider || !ctx.call) return { ok: true };
    const intent = await provider.decodeIntent(ctx.call);
    if (!intent || intent.deadline === null) return { ok: true };
    const now = Math.floor(Date.now() / 1000);
    return intent.deadline > now
      ? { ok: true }
      : {
          ok: false,
          fail: "quote_expired",
          detail: "the quote's deadline has passed",
        };
  },
};

/**
 * Idempotency / double-submit guard (§11 Layer 4, §11.6 #5). One intent, one
 * submission. Guards against a double tap, a retry storm, and an agent
 * re-invoking the same tool call — each of which would otherwise deposit twice.
 */
const inFlight = new Map<string, number>();
const IN_FLIGHT_TTL_MS = 2 * 60 * 1000;

export function releaseSubmission(key: string): void {
  inFlight.delete(key);
}

/** Test seam. */
export function resetInFlightSubmissions(): void {
  inFlight.clear();
}

export const IdempotencyCheck: SafetyCheck = {
  id: "idempotency",
  layer: 4,
  appliesTo: { stages: ["submit"] },
  run: async (ctx) => {
    if (!ctx.submissionKey) return { ok: true };
    const now = Date.now();
    // Drop expired entries so a crashed submission cannot block the key forever.
    for (const [key, at] of inFlight) {
      if (now - at > IN_FLIGHT_TTL_MS) inFlight.delete(key);
    }
    if (inFlight.has(ctx.submissionKey)) {
      return {
        ok: false,
        fail: "duplicate_submission",
        detail: "an identical deposit is already in flight",
      };
    }
    inFlight.set(ctx.submissionKey, now);
    return { ok: true };
  },
};

/**
 * Gas sanity (§11 Layer 4, `[N]`). An absurd fee estimate is either a
 * griefing attempt or a call that is about to do something very different from
 * what we think — either way, not something to sign silently.
 */
const MAX_REASONABLE_FEE_WEI = 10n ** 18n / 10n; // 0.1 native units

export const GasSanityCheck: SafetyCheck = {
  id: "gas-sanity",
  layer: 4,
  appliesTo: { stages: ["submit"] },
  run: async (ctx) => {
    if (ctx.feeEstimate === null || ctx.feeEstimate === undefined) {
      return { ok: true };
    }
    return ctx.feeEstimate <= MAX_REASONABLE_FEE_WEI
      ? { ok: true }
      : {
          ok: false,
          fail: "deposit_failed",
          detail: "estimated fee is outside the sane band",
        };
  },
};

export const LAYER4_CHECKS: readonly SafetyCheck[] = [
  ChainBindingCheck,
  DecodedIntentMatchCheck,
  ApprovalScopingCheck,
  QuoteFreshnessCheck,
  GasSanityCheck,
  SimulateBeforeSignCheck,
  IdempotencyCheck,
];
