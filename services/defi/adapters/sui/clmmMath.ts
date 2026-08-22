/**
 * Shared full-range concentrated-liquidity math (Sui CLMMs) — dependency-free
 * `bigint` port of Cetus's own `@cetusprotocol/cetus-sui-clmm-sdk` formulas
 * (`estimateLiquidityForCoinA/B`, `ClmmPoolUtil.getCoinAmountFromLiquidity`,
 * `ClmmPoolUtil.calculateDepositRatioFixTokenA` — read from the SDK's own
 * published source, 2026-08-22), NOT the SDK itself: adding it as a real
 * dependency risks the exact `Object.prototype`-freeze trap `pollyfills.ts`
 * already warns about (CLAUDE.md, "Frozen prototypes"), and this repo's own
 * standing rule is "prefer the plain primitive over pulling a heavy SDK"
 * (`scallop.config.ts` et al). Ported functions preserve the ORIGINAL
 * two-step truncation order (a Q64.64 `>> 64` before the final division,
 * not one combined division) — those can round differently, and matching
 * the reference bit-for-bit matters more than a "cleaner" one-liner.
 *
 * ONLY covers the full-range case (tick -443636 to 443636): that sidesteps
 * the hardest and most bug-prone part of any CLMM library — general
 * tick-index ↔ sqrt-price conversion (~20 bit-shift magic constants in every
 * real implementation) — because full range's bounds are two PUBLISHED
 * constants, not a computed value. This is a deliberate scope cut (see
 * `cetusSui.ts`'s header), not an oversight: no per-DEX tick picker exists in
 * this app, so full range is the only shape this adapter ever needs.
 *
 * Every exported function here was cross-checked against
 * `@cetusprotocol/cetus-sui-clmm-sdk`'s real output for matched inputs before
 * this file was trusted (see the PR/commit description, not reproduced here
 * to avoid a stale "verified" claim rotting in a comment).
 */

/** Full-range tick bounds — Cetus's own published constants, mainnet. */
export const MIN_TICK_INDEX = -443636;
export const MAX_TICK_INDEX = 443636;
export const MIN_SQRT_PRICE = 4295048016n;
export const MAX_SQRT_PRICE = 79226673515401279992447579055n;

const Q64 = 1n << 64n;

/**
 * Per-pool full-range tick bounds — NOT a universal constant. Found the hard
 * way (devInspect abort in `position::check_position_tick_range`, 2026-08-22):
 * `open_position` rejects a `(tick_lower, tick_upper)` pair unless both are
 * multiples of the POOL's own `tick_spacing` (2/4/6/8/10/20/…/260, one per
 * fee tier — `MIN_TICK_INDEX`/`MAX_TICK_INDEX` only happen to be valid for
 * spacings that divide 443636 evenly, which most don't: 443636 / 10 =
 * 44363.6). Rounds INWARD (ceil for the lower bound, floor for the upper) so
 * the result never exceeds the protocol-wide min/max even after rounding.
 */
export function fullRangeTicksFor(tickSpacing: number): {
  lower: number;
  upper: number;
} {
  if (!Number.isFinite(tickSpacing) || tickSpacing <= 0) {
    return { lower: MIN_TICK_INDEX, upper: MAX_TICK_INDEX };
  }
  const lower = Math.ceil(MIN_TICK_INDEX / tickSpacing) * tickSpacing;
  const upper = Math.floor(MAX_TICK_INDEX / tickSpacing) * tickSpacing;
  return { lower, upper };
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * Liquidity implied by a fixed amount of coin A, mirrors
 * `estimateLiquidityForCoinA` exactly: `floor(floor(amount*upper*lower / 2^64)
 * / (upper-lower))` — the intermediate `>> 64` is a SEPARATE truncating step,
 * not folded into one division (see file header).
 */
export function liquidityFromCoinA(
  amount: bigint,
  sqrtPriceX: bigint,
  sqrtPriceY: bigint,
): bigint {
  const lower = minBig(sqrtPriceX, sqrtPriceY);
  const upper = maxBig(sqrtPriceX, sqrtPriceY);
  const denom = upper - lower;
  if (amount <= 0n || denom <= 0n) return 0n;
  const numX64 = (amount * upper * lower) / Q64; // fromX64_BN
  return numX64 / denom;
}

/** Liquidity implied by a fixed amount of coin B: `floor((amount<<64) / (upper-lower))`. */
export function liquidityFromCoinB(
  amount: bigint,
  sqrtPriceX: bigint,
  sqrtPriceY: bigint,
): bigint {
  const lower = minBig(sqrtPriceX, sqrtPriceY);
  const upper = maxBig(sqrtPriceX, sqrtPriceY);
  const denom = upper - lower;
  if (amount <= 0n || denom <= 0n) return 0n;
  return (amount * Q64) / denom;
}

/**
 * `{coinA, coinB}` required for `liquidity` at `curSqrtPrice`, full range.
 * Mirrors `ClmmPoolUtil.getCoinAmountFromLiquidity`'s "in range" branch only
 * — full range means `curSqrtPrice` is ALWAYS strictly between MIN/MAX, so
 * the below/above branches (which that function also has, for a position
 * fully out of range) can never apply here and are intentionally omitted.
 */
export function fullRangeCoinAmounts(
  liquidity: bigint,
  curSqrtPrice: bigint,
): { coinA: bigint; coinB: bigint } {
  const lower = MIN_SQRT_PRICE;
  const upper = MAX_SQRT_PRICE;
  if (liquidity <= 0n) return { coinA: 0n, coinB: 0n };
  // coinA = floor( (L << 64) * (upper - cur) / (cur * upper) )
  const coinA =
    (liquidity * Q64 * (upper - curSqrtPrice)) / (curSqrtPrice * upper);
  // coinB = floor( L * (cur - lower) / 2^64 )
  const coinB = (liquidity * (curSqrtPrice - lower)) / Q64;
  return { coinA, coinB };
}

/**
 * Rough swap-sizing split for zapping ONE input asset into a full-range
 * position: given `totalAmount` of whichever side `isAssetA` names, returns
 * how much to KEEP as that side and how much to SWAP into the other side.
 *
 * Deliberately an ESTIMATE, not exact-final math: the actual on-chain call
 * (`add_liquidity_fix_coin` + `add_liquidity_pay_amount`) computes and
 * returns the EXACT amounts needed, read back in the same PTB — this only
 * has to get close enough that the swap leaves enough of the other side.
 * Undersizing fails the tx closed (no funds move); oversizing just means
 * more leftover refunded. Precision here is a UX/gas concern, not a safety
 * one.
 *
 * Uses TWO genuinely separate quantities, solved as a linear system —
 * conflating them (an earlier draft of this function did) silently
 * degenerates to an always-50/50 split regardless of price, which is wrong
 * for anything but a pool exactly at price 1:
 *   - the TARGET composition ratio for a balanced full-range position at the
 *     current price (`ratioA : ratioB`, from `fullRangeCoinAmounts` at an
 *     arbitrary reference liquidity — the ratio is independent of the
 *     reference value chosen, only used to cancel units), and
 *   - the SWAP's marginal exchange rate, the literal spot price
 *     `curSqrtPrice² / 2^128` (B per A) — a different quantity that happens
 *     to share `curSqrtPrice` but is not interchangeable with the ratio
 *     above.
 *
 * Solving `keepAmount / (swapAmount·price) = ratioA/ratioB` (input is A) or
 * its mirror (input is B) for `keepAmount + swapAmount = totalAmount` gives
 * the closed forms below, kept as an exact fraction (no lossy intermediate
 * float) until the one final integer division.
 */
export function estimateFullRangeSwapSplit(
  curSqrtPrice: bigint,
  totalAmount: bigint,
  isAssetA: boolean,
): { keepAmount: bigint; swapAmount: bigint } {
  if (totalAmount <= 0n || curSqrtPrice <= 0n) {
    return { keepAmount: totalAmount, swapAmount: 0n };
  }
  const REF_LIQUIDITY = 1_000_000_000_000_000_000n;
  const { coinA: ratioA, coinB: ratioB } = fullRangeCoinAmounts(
    REF_LIQUIDITY,
    curSqrtPrice,
  );
  if (ratioA <= 0n || ratioB <= 0n) {
    // Degenerate (shouldn't happen for a healthy pool at a real price) —
    // keep everything, swap nothing; add_liquidity fails closed if wrong.
    return { keepAmount: totalAmount, swapAmount: 0n };
  }
  const priceNum = curSqrtPrice * curSqrtPrice; // spot price numerator, B per A
  const priceDen = Q64 * Q64; // 2^128
  // s = priceNum * ratioA ; k = ratioB * priceDen — see file header derivation.
  const s = priceNum * ratioA;
  const k = ratioB * priceDen;
  const denom = s + k;
  if (denom <= 0n) return { keepAmount: totalAmount, swapAmount: 0n };
  const keepAmount = isAssetA
    ? (totalAmount * s) / denom
    : (totalAmount * k) / denom;
  const swapAmount = totalAmount - keepAmount;
  return { keepAmount, swapAmount };
}

/**
 * Frictionless (no pool fee, no price-impact curvature) expected OUTPUT for
 * swapping `amountIn` of one side at the CURRENT spot price
 * (`curSqrtPrice² / 2^128`, the same quantity `estimateFullRangeSwapSplit`
 * derives internally). Always an OVER-estimate of the real output — genuine
 * output is always somewhat less, from pool fee and price-impact curvature —
 * so callers apply their own tolerance haircut to get a swap's min-out floor.
 *
 * This exists for one reason: a swap's `sqrt_price_limit` bound is the ONLY
 * on-chain protection against same-block MEV (a searcher moving the pool
 * price between when this transaction lands in a block and when it executes)
 * — atomicity inside ONE transaction does not protect against that, since
 * the attacker's transaction can still be ordered immediately before it in
 * the same block. Passing the protocol's absolute MIN/MAX_SQRT_PRICE as the
 * limit (accepting literally any execution price) is equivalent to no
 * protection at all.
 */
export function estimateSwapOutput(
  curSqrtPrice: bigint,
  amountIn: bigint,
  isAssetA: boolean,
): bigint {
  if (amountIn <= 0n || curSqrtPrice <= 0n) return 0n;
  const priceNum = curSqrtPrice * curSqrtPrice; // spot price numerator, B per A
  const priceDen = Q64 * Q64; // 2^128
  // Giving A, receiving B: out = amountIn * price (B per A).
  // Giving B, receiving A: out = amountIn / price.
  return isAssetA
    ? (amountIn * priceNum) / priceDen
    : (amountIn * priceDen) / priceNum;
}

/**
 * A `sqrt_price_limit` bound tightened by `toleranceBps` around the current
 * price, for protocols (Cetus) whose swap call has no SEPARATE min-out
 * parameter — the price bound is the only slippage/MEV protection available
 * at all (see `estimateSwapOutput`'s header for why the bound matters even
 * inside one atomic PTB). Applies the tolerance directly to sqrtPrice, not
 * price; since sqrtPrice moves by roughly HALF of any price-tolerance
 * percentage, this yields a same-or-TIGHTER (never looser) bound than
 * `toleranceBps` on the actual execution price — erring conservative is the
 * safe direction for a protection bound.
 */
export function sqrtPriceLimitWithTolerance(
  curSqrtPrice: bigint,
  isAssetA: boolean,
  toleranceBps: bigint,
): bigint {
  const scale = 10_000n;
  const limit = isAssetA
    ? (curSqrtPrice * (scale - toleranceBps)) / scale // a2b: price falls, floor it
    : (curSqrtPrice * (scale + toleranceBps)) / scale; // b2a: price rises, cap it
  if (limit < MIN_SQRT_PRICE) return MIN_SQRT_PRICE;
  if (limit > MAX_SQRT_PRICE) return MAX_SQRT_PRICE;
  return limit;
}
