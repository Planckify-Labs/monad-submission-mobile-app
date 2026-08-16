/**
 * Layer 2 — economic / value safety, pre-sign (spec §11 Layer 2, §11.6 #1).
 *
 * The arithmetic here is chain-agnostic: amount bounds, cap headroom, the
 * expected-output band and the slippage-floor rule operate on metadata and
 * provider previews, never on a chain SDK. That makes them one implementation
 * for every chain.
 *
 * The decimals check is the highest-value item in the whole layer. A wrong
 * scale does not revert — it silently deposits 10¹² times the intended amount.
 */

import { getChainSafetyProvider } from "../registry";
import type { SafetyCheck } from "../types";

/** How far below the protocol's own preview we tolerate before refusing. */
const PREVIEW_TOLERANCE_BPS = 1000; // 10%

/**
 * §11.6 #1 — decimals / units correctness. **Must-have.**
 *
 * Assert the amount was scaled with the asset's ON-CHAIN `decimals()`, not a
 * hardcoded symbol→decimals map. The `decimalsForSymbol` fallback in the
 * executors is exactly the 6-vs-18 footgun this closes: a USDC row that scales
 * as 18 decimals deposits a trillion times too much, and nothing reverts.
 */
export const DecimalsMatchCheck: SafetyCheck = {
  id: "decimals-match",
  layer: 2,
  appliesTo: { stages: ["presign"] },
  run: async (ctx) => {
    if (ctx.requestedAmount === "MAX") return { ok: true };
    if (typeof ctx.requestedHuman !== "number") return { ok: true };

    const provider = getChainSafetyProvider(ctx.namespace);
    const onchain =
      (await provider?.readDecimals?.(ctx.underlyingExpected, ctx.chainId)) ??
      null;
    if (onchain === null) {
      // We could not read the token's decimals. The amount may well be right,
      // but we cannot prove it, and this check exists precisely because the
      // failure is silent — so refuse.
      return {
        ok: false,
        fail: "decimals_mismatch",
        detail: "could not read the asset's on-chain decimals",
      };
    }
    if (
      typeof ctx.assetDecimals === "number" &&
      ctx.assetDecimals !== onchain
    ) {
      return {
        ok: false,
        fail: "decimals_mismatch",
        detail: "the scale used to build the amount is not the token's",
      };
    }
    // Cross-check the raw amount against human × 10^onchainDecimals. Compare
    // by magnitude, not equality: floating-point human input legitimately
    // rounds in the last places, but a decimals error is off by orders of ten.
    const expected =
      BigInt(Math.round(ctx.requestedHuman * 1e6)) *
      10n ** BigInt(Math.max(onchain - 6, 0));
    const actual = ctx.requestedAmount;
    if (expected > 0n) {
      const ratio =
        actual > expected ? actual / expected : expected / actual || 1n;
      if (ratio >= 10n) {
        return {
          ok: false,
          fail: "decimals_mismatch",
          detail: "raw amount differs from the requested amount by ≥10×",
        };
      }
    }
    return { ok: true };
  },
};

/**
 * Deposit-cap headroom (§11 Layer 2, `[N]`). ERC-4626 `maxDeposit`, a Comet
 * supply cap, an Aave reserve at cap. Avoids a guaranteed revert and, worse,
 * a mid-cap partial fill the user did not ask for.
 *
 * Presence-checked: a provider that cannot read caps returns undefined and the
 * check passes, because "no cap information" is not evidence of a breach.
 */
export const DepositCapHeadroomCheck: SafetyCheck = {
  id: "deposit-cap-headroom",
  layer: 2,
  appliesTo: { stages: ["presign"] },
  run: async (ctx) => {
    if (ctx.requestedAmount === "MAX") return { ok: true };
    const provider = getChainSafetyProvider(ctx.namespace);
    const headroom = await provider?.readDepositCapHeadroom?.(
      ctx.target,
      ctx.wallet,
      ctx.chainId,
    );
    if (headroom === undefined || headroom === null) return { ok: true };
    if (headroom < ctx.requestedAmount) {
      return {
        ok: false,
        fail: "deposit_cap_exceeded",
        detail: "the protocol cannot accept this much right now",
      };
    }
    return { ok: true };
  },
};

/**
 * Expected-output band (§11 Layer 2). The protocol's own preview must return a
 * positive amount within tolerance. A vault that prices a real deposit at zero
 * shares is either broken or empty in a way that rounds the deposit away —
 * this is also the share-inflation / donation-attack tell for a fresh vault.
 */
export const ExpectedOutputBandCheck: SafetyCheck = {
  id: "expected-output-band",
  layer: 2,
  appliesTo: { stages: ["presign"] },
  run: async (ctx) => {
    if (ctx.previewOut === null) return { ok: true };
    if (ctx.previewOut <= 0n) {
      return {
        ok: false,
        fail: "slippage_too_high",
        detail: "the protocol previews no output for this deposit",
      };
    }
    return { ok: true };
  },
};

/**
 * APY drift (§11 Layer 2, `[E]`). A stale opportunity is not a safety hole on
 * its own, but depositing on a number that moved 40% since it was shown is a
 * decision the user did not actually make.
 */
const APY_DRIFT_TOLERANCE_PCT = 5;

export const ApyDriftCheck: SafetyCheck = {
  id: "apy-drift",
  layer: 2,
  appliesTo: { stages: ["presign"] },
  run: async (ctx) => {
    if (
      typeof ctx.expectedApy !== "number" ||
      typeof ctx.cachedApy !== "number" ||
      ctx.cachedApy <= 0
    ) {
      return { ok: true };
    }
    const driftPct =
      (Math.abs(ctx.cachedApy - ctx.expectedApy) / ctx.cachedApy) * 100;
    return driftPct > APY_DRIFT_TOLERANCE_PCT
      ? {
          ok: false,
          fail: "apy_drift_too_high",
          detail: "the rate moved since this was suggested",
        }
      : { ok: true };
  },
};

/**
 * Slippage floor for the kinds that can be sandwiched (§11 Layer 2, §12 Q4).
 * A zero minimum hard-blocks the build. The minimum itself is computed by the
 * adapter from the protocol's own view; this check is the backstop that a
 * minimum exists at all, because "we forgot to set one" and "we set zero" look
 * identical on-chain.
 */
export const SlippageFloorCheck: SafetyCheck = {
  id: "slippage-floor-present",
  layer: 2,
  appliesTo: {
    kinds: ["curve-lp", "solidly-lp", "balancer-lp", "router-call"],
    stages: ["submit"],
  },
  run: async (ctx) => {
    const provider = getChainSafetyProvider(ctx.namespace);
    if (!provider || !ctx.call) return { ok: true };
    const intent = await provider.decodeIntent(ctx.call);
    if (!intent) return { ok: true }; // reported by decoded-intent-match
    if (intent.minOut === null || intent.minOut <= 0n) {
      return {
        ok: false,
        fail: "slippage_too_high",
        detail: "no minimum output is set on a slippage-bearing call",
      };
    }
    if (
      ctx.previewOut !== null &&
      ctx.previewOut > 0n &&
      intent.minOut * 10_000n <
        ctx.previewOut * BigInt(10_000 - PREVIEW_TOLERANCE_BPS)
    ) {
      return {
        ok: false,
        fail: "slippage_too_high",
        detail:
          "the minimum output is further below the quote than policy allows",
      };
    }
    return { ok: true };
  },
};

/**
 * Does the wallet actually hold what it is about to deposit?
 *
 * Not a guard — the chain would refuse anyway — but an ACCURACY check. Without
 * it the first thing that notices an empty wallet is the dry-run, which reports
 * the generic "the dry-run reverted" → `deposit_failed`; the agent then has
 * nothing true to tell the user and invents a story about decimals or pool ids
 * (observed, and the same failure the Sui classifier's `insufficient_funds`
 * mapping was written to stop). Answering `insufficient_funds` here is both
 * earlier and honest, and it lands before the approval transaction spends gas
 * on a deposit that cannot happen.
 *
 * Fails OPEN when the balance cannot be read: "the RPC did not answer" is not
 * evidence the wallet is empty, and claiming it would be its own inaccuracy.
 */
export const SufficientBalanceCheck: SafetyCheck = {
  id: "sufficient-balance",
  layer: 2,
  appliesTo: { stages: ["presign"] },
  run: async (ctx) => {
    if (ctx.requestedAmount === "MAX") return { ok: true };
    const provider = getChainSafetyProvider(ctx.namespace);
    if (!provider?.readBalance) return { ok: true };

    const held = await provider.readBalance(
      ctx.underlyingExpected,
      ctx.wallet,
      ctx.chainId,
    );
    if (held === null) return { ok: true };
    return held >= ctx.requestedAmount
      ? { ok: true }
      : {
          ok: false,
          fail: "insufficient_funds",
          detail: "the wallet holds less of the asset than the deposit needs",
        };
  },
};

export const LAYER2_CHECKS: readonly SafetyCheck[] = [
  SufficientBalanceCheck,
  DecimalsMatchCheck,
  DepositCapHeadroomCheck,
  ExpectedOutputBandCheck,
  ApyDriftCheck,
  SlippageFloorCheck,
];
