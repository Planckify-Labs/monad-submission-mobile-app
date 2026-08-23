/**
 * Slippage policy (spec §12 Q4, §11 Layer-2 "slippage floor").
 *
 * One auditable policy for every slippage-bearing family — Curve and Solidly
 * LP, Balancer joins, router-call quotes, 4626 vaults that enforce a min-out,
 * and LST DEX exits — instead of a per-adapter number nobody can review.
 *
 * The rules, and why:
 *
 *  - **A zero minimum is never allowed.** `min_mint_amount: 0` is an open
 *    invitation to sandwich the deposit; the build is blocked rather than
 *    shipped with a placeholder (§5.3 "hard requirement, block build if unset").
 *  - **Minimums come from the protocol's own view** (`calc_token_amount`,
 *    `previewDeposit`, `quoteAddLiquidity`, the router's quote) at build time,
 *    never from a cached or model-supplied number.
 *  - **Tighter for conservative users.** The tier the user already chose for
 *    risk should also decide how much price movement they accept.
 *  - **A hard ceiling caps the worst case.** Beyond it the build fails with
 *    `slippage_too_high` — no amount of caller insistence widens it.
 */

import { DefiError } from "./errors/defiErrors";
import type { RiskTier } from "./types";

/** Basis points; 10_000 bps = 100%. */
export const BPS_DENOMINATOR = 10_000n;

/**
 * Server ceiling (§12 Q4). A request above this is refused rather than clamped:
 * silently tightening a caller's 5% to 3% would make the resulting min-out a
 * number nobody chose.
 */
export const MAX_SLIPPAGE_BPS = 300;

interface TierSlippage {
  /** Correlated assets — stable/stable, LST/native. */
  readonly stable: number;
  /** Anything else. */
  readonly volatile: number;
}

const TIER_SLIPPAGE: Record<RiskTier, TierSlippage> = {
  conservative: { stable: 25, volatile: 50 },
  balanced: { stable: 50, volatile: 100 },
  aggressive: { stable: 50, volatile: 100 },
};

export interface SlippageContext {
  tier?: RiskTier;
  /** True for stable-stable / correlated pairs. */
  stable?: boolean;
  /** Caller override, still subject to `MAX_SLIPPAGE_BPS`. */
  overrideBps?: number;
}

/** The slippage budget in bps for this deposit, after policy + ceiling. */
export function slippageBpsFor(ctx: SlippageContext = {}): number {
  const tier = ctx.tier ?? "balanced";
  const base = ctx.stable
    ? TIER_SLIPPAGE[tier].stable
    : TIER_SLIPPAGE[tier].volatile;
  const requested = ctx.overrideBps ?? base;
  if (!Number.isFinite(requested) || requested < 0) {
    throw new DefiError("slippage_too_high", "slippage must be a positive bps");
  }
  if (requested > MAX_SLIPPAGE_BPS) {
    throw new DefiError(
      "slippage_too_high",
      `requested ${requested}bps exceeds the ${MAX_SLIPPAGE_BPS}bps ceiling`,
    );
  }
  return requested;
}

/**
 * Apply the budget to a protocol-quoted expected output.
 *
 * `expected` MUST come from the protocol's own view at build time. A zero or
 * negative quote means the view could not price the deposit, and a min-out of
 * zero is exactly what this function exists to prevent — so it throws instead
 * of returning one.
 */
export function applySlippage(expected: bigint, bps: number): bigint {
  if (expected <= 0n) {
    throw new DefiError(
      "slippage_too_high",
      "protocol preview returned no expected output; refusing a zero minimum",
    );
  }
  const budget = BigInt(Math.round(bps));
  const min = (expected * (BPS_DENOMINATOR - budget)) / BPS_DENOMINATOR;
  // Rounding on a dust-sized deposit can floor to zero; that is still a zero
  // minimum, so it is still refused.
  if (min <= 0n) {
    throw new DefiError(
      "slippage_too_high",
      "computed minimum rounds to zero; amount is too small to protect",
    );
  }
  return min;
}

/** Convenience: quote → enforced minimum in one call. */
export function minOutFor(expected: bigint, ctx: SlippageContext = {}): bigint {
  return applySlippage(expected, slippageBpsFor(ctx));
}

/**
 * The upper-bound counterpart of `applySlippage`, for protocols whose
 * instruction is "exact output, max input" rather than "exact input, min
 * output" — e.g. Raydium CPMM's `deposit(lpAmount, amountMaxA, amountMaxB)`
 * takes the LP amount to mint as the driving input and caps how much of each
 * token the program may pull to mint it, the inverse of Uniswap v2's
 * `addLiquidity`. `expected` MUST come from the protocol's own live reserves
 * at build time, same rule as `applySlippage`.
 */
export function applyMaxSlippage(expected: bigint, bps: number): bigint {
  if (expected <= 0n) {
    throw new DefiError(
      "slippage_too_high",
      "protocol preview returned no expected input; refusing an unbounded maximum",
    );
  }
  const budget = BigInt(Math.round(bps));
  return (expected * (BPS_DENOMINATOR + budget)) / BPS_DENOMINATOR;
}

/** Convenience: quote → enforced maximum in one call. */
export function maxInFor(expected: bigint, ctx: SlippageContext = {}): bigint {
  return applyMaxSlippage(expected, slippageBpsFor(ctx));
}
