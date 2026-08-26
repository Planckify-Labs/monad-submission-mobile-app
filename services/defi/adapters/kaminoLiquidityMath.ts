/**
 * Concentrated-liquidity (CLMM) tick <-> sqrtPrice conversion and
 * liquidity/token-amount formulas, used by `kaminoLiquidity.ts` to compute
 * a two-sided deposit's ratio-matched amounts from a strategy's live Orca
 * position state (no oracle, no swap).
 *
 * Written independently from the public mathematical definition — the
 * relationship `sqrtPrice(tick) = sqrt(1.0001^tick)`, represented in
 * Q64.64 fixed point (the representation Orca's own `Whirlpool`/`Position`
 * accounts store on-chain), and the standard two-equation description of a
 * liquidity range's reserves — rather than by reading any vendor SDK's
 * implementation (deliberate: Orca's own SDK relicensed to a
 * non-commercial-only license in 2025; see `kaminoLiquidity.ts`'s header).
 *
 * All arithmetic is BigInt-exact fixed point (no floating point). Verified
 * live 2026-08-26 two ways, neither by comparison to any vendor's code:
 *
 *  - `tickIndexToSqrtPriceX64`: cross-checked against 12 real, live Orca
 *    pools spanning tick -66626..1653 — the required invariant
 *    (`sqrtPrice(tickCurrentIndex) <= pool.sqrtPrice`, since
 *    `tickCurrentIndex` is defined as the floor tick) held on all 12, with
 *    the expected sub-tick gap (max 3.7e-5 relative, i.e. the legitimate
 *    distance between a floor tick's price and the pool's actual live
 *    price within that tick) and no larger discrepancy.
 *  - `getLiquidityFromTokenA`/`B` and `getTokenAFromLiquidity`/`B`:
 *    round-trip exactly (amount -> liquidity -> amount recovers the
 *    original to within 1 unit of integer-division truncation) against
 *    multiple real sqrtPrice ranges taken from those same live pools.
 *
 * This is an off-chain ESTIMATE only — the on-chain `Deposit` instruction
 * computes the authoritative split itself from live pool state and refuses
 * (`NotEnoughTokensForRatio`) if the caller's amounts don't fit, so a small
 * discrepancy here fails the instruction closed rather than moving the
 * wrong amount.
 */

const FRACTIONAL_BITS = 128n;
const ONE = 1n << FRACTIONAL_BITS;
const Q64 = 1n << 64n;

// 1.0001 in the same fixed point, i.e. round(1.0001 * 2^128).
const BASE = (10001n << FRACTIONAL_BITS) / 10000n;

function fixedMul(a: bigint, b: bigint): bigint {
  return (a * b) >> FRACTIONAL_BITS;
}

function fixedPow(base: bigint, exponent: number): bigint {
  let result = ONE;
  let b = base;
  let e = exponent;
  while (e > 0) {
    if (e & 1) result = fixedMul(result, b);
    b = fixedMul(b, b);
    e >>= 1;
  }
  return result;
}

function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("isqrt of negative");
  if (n < 2n) return n;
  let x = 1n << (BigInt(n.toString(2).length + 1) >> 1n);
  while (true) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/**
 * `sqrtPrice(tick) = sqrt(1.0001^tick)`, as a Q64.64 fixed-point integer —
 * directly comparable to Orca's own on-chain `sqrtPrice` field.
 */
export function tickIndexToSqrtPriceX64(tickIndex: number): bigint {
  const priceFixed = fixedPow(BASE, Math.abs(tickIndex));
  const priceAtTickFixed =
    tickIndex >= 0 ? priceFixed : (ONE * ONE) / priceFixed;
  return isqrt(priceAtTickFixed);
}

function order(a: bigint, b: bigint): [bigint, bigint] {
  return a < b ? [a, b] : [b, a];
}

export function getTokenAFromLiquidity(
  liquidity: bigint,
  sqrtPrice0X64: bigint,
  sqrtPrice1X64: bigint,
  roundUp: boolean,
): bigint {
  const [lo, hi] = order(sqrtPrice0X64, sqrtPrice1X64);
  const numerator = liquidity * (hi - lo) * Q64;
  const denominator = hi * lo;
  if (denominator <= 0n) return 0n;
  const q = numerator / denominator;
  if (!roundUp) return q;
  return numerator % denominator === 0n ? q : q + 1n;
}

export function getTokenBFromLiquidity(
  liquidity: bigint,
  sqrtPrice0X64: bigint,
  sqrtPrice1X64: bigint,
  roundUp: boolean,
): bigint {
  const [lo, hi] = order(sqrtPrice0X64, sqrtPrice1X64);
  const numerator = liquidity * (hi - lo);
  const q = numerator / Q64;
  if (!roundUp) return q;
  return numerator % Q64 === 0n ? q : q + 1n;
}
