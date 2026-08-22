/**
 * Cetus CLMM adapter — a `DefiProtocolAdapter` for pool-level Sui deposits
 * (docs/defi-pool-level-deposits-spec.md §7, Phase 3). Built 2026-08-22.
 * DEPOSIT-ONLY, FULL-RANGE ONLY — see `cetus.resolver.ts` / `types.ts`'s
 * `cetus-clmm-pool` entry.
 *
 * A concentrated-liquidity position always needs BOTH pool legs — there is
 * no such thing as a single-asset LP deposit — so unlike every other Sui
 * adapter here, this one internally swap-splits the user's single input
 * asset before adding liquidity. The swap routes through the SAME pool
 * (`router::swap`), never an external router: that guarantees the exact
 * pair already exists (it's the pool being deposited into) and needs no
 * separate DEX-availability check.
 *
 * PTB, all in one atomic transaction:
 *   1. read `pool::current_sqrt_price` (a devInspect pre-read, not part of
 *      the built PTB — needed off-chain to size the swap)
 *   2. estimateFullRangeSwapSplit (clmmMath.ts) → keepAmount / swapAmount,
 *      then pad swapAmount with a fee/slippage safety margin (see the
 *      SWAP_SAFETY_BPS comment at its call site)
 *   3. split the input coin; router::swap the `swapAmount` leg
 *   4. pool::open_position (full range, per-pool: fullRangeTicksFor(tickSpacing))
 *   5. pool::add_liquidity_fix_coin(position, amount, fix_amount_a) — the
 *      CONTRACT computes the exact liquidity + the other leg's requirement;
 *      this is why step 2's estimate only has to be close, not exact
 *   6. pool::add_liquidity_pay_amount(&receipt) -> (u64, u64) — read the
 *      EXACT amounts back, in-PTB, no off-chain guessing for the final split
 *   7. split both held balances to those exact amounts, repay_add_liquidity
 *   8. transfer the Position NFT + any leftover coin (either leg) to sender
 *
 * Device-verified 2026-08-22 via `sui_devInspectTransactionBlock` against
 * live mainnet. The B→A input direction (isAssetA=false — e.g. depositing
 * SUI into a USDC/SUI pool) was proven end to end through this exact
 * adapter's `buildDeposit`, full flow including `tx.build({client})`'s own
 * stricter internal dry run. The mirrored A→B direction (isAssetA=true)
 * doesn't have a real funded test wallet available for this pool, so it was
 * verified in two parts instead: the `router::swap(a2b=true)` call itself
 * was proven on live mainnet in isolation (bootstrapped via a same-PTB
 * SUI→USDC swap first, to get a real coin to swap back), and the rest of the
 * pipeline (open_position/add_liquidity_fix_coin/pay_amount/repay) is
 * exactly the code already proven for the other direction — isAssetA only
 * changes which side is zeroed, which bool literals get passed, and which
 * output gets the keepCoin merge, all reviewed for type/role consistency.
 * The swap-sizing math (`clmmMath.ts`) was cross-checked bit-exact against
 * Cetus's own published SDK formulas before being trusted here — see that
 * file's header.
 *
 * `router::swap`'s `sqrt_price_limit` is a REAL slippage/MEV bound
 * (`sqrtPriceLimitWithTolerance`), not the protocol's absolute MIN/MAX —
 * that gap (equivalent to zero protection) was found and fixed 2026-08-22
 * while building Turbos's adapter alongside this one; re-verified via
 * devInspect after the fix.
 *
 * WITHDRAW is NOT wired: `remove_liquidity` + fee/reward collection +
 * `close_position` needs its own careful pass (position NFT bookkeeping,
 * what to do with accrued fees) — deliberately out of scope this round,
 * same discipline as Suilend/Current/Kai's withdraw gaps.
 *
 * MAINNET-ONLY. Every failure maps to a curated `DefiError`, never a raw RPC
 * string (CLAUDE.md).
 */

import { toBase64 } from "@mysten/bcs";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import {
  Transaction,
  type TransactionObjectArgument,
} from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import type { SuiChainConfig } from "@/constants/configs/chainConfig";
import { classifySuiMoveError, DefiError } from "../errors/defiErrors";
import type {
  BuildDepositArgs,
  BuildWithdrawArgs,
  DefiPosition,
  DefiProtocolAdapter,
  DepositTarget,
  UnsignedCall,
} from "../types";
import {
  CETUS_CLMM_PACKAGE,
  CETUS_GLOBAL_CONFIG,
  CETUS_INTEGRATE_PACKAGE,
} from "./cetus.config";
import {
  estimateFullRangeSwapSplit,
  fullRangeTicksFor,
  sqrtPriceLimitWithTolerance,
} from "./sui/clmmMath";
import { eqSuiCoinType, leBytesToBigInt, prepareInputCoin } from "./sui/coins";

const SLUG = "cetus-sui";
const NETWORK = "mainnet" as const;

/** Two's-complement u32 encoding of a (possibly negative) tick index — the
 *  entry fn's param is a bare U32, so a signed tick has to be reinterpreted
 *  as unsigned bits, same transform Cetus's own SDK applies
 *  (`asUintN(BigInt(tick))`) before passing one. */
function tickAsU32(tick: number): number {
  return tick >>> 0;
}

function devWarn(scope: string, err: unknown): void {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn(`[cetusSui] ${scope}:`, err);
  }
}

function suiClientFor(chain: SuiChainConfig): SuiJsonRpcClient {
  return new SuiJsonRpcClient({ url: chain.rpcUrl, network: chain.network });
}

function requireCetusTarget(
  target: DepositTarget | undefined,
): Extract<DepositTarget, { kind: "cetus-clmm-pool" }> {
  if (target?.kind !== "cetus-clmm-pool") {
    throw new DefiError(
      "deposit_failed",
      "cetus: a resolved pool target is required (pool + both leg types)",
    );
  }
  return target;
}

/** Read `pool::current_sqrt_price(&Pool<A,B>) -> u128` via a throwaway devInspect. */
async function readCurrentSqrtPrice(
  client: SuiJsonRpcClient,
  pool: string,
  coinTypeA: string,
  coinTypeB: string,
  sender: string,
): Promise<bigint> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${CETUS_CLMM_PACKAGE}::pool::current_sqrt_price`,
    typeArguments: [coinTypeA, coinTypeB],
    arguments: [tx.object(pool)],
  });
  const res = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender,
  });
  const bytes = res.results?.[0]?.returnValues?.[0]?.[0];
  if (!bytes || bytes.length === 0) {
    throw new DefiError("deposit_failed", "cetus: could not read pool price");
  }
  return leBytesToBigInt(bytes);
}

export const CetusSuiAdapter: DefiProtocolAdapter = {
  slug: SLUG,
  namespace: "sui",
  kind: "yield_vault",
  chainId: NETWORK, // string id → free network gate via listDefiAdaptersForChain
  displayName: "Cetus",
  staticSafetyScore: 55,
  externalSlugs: ["cetus-clmm", "cetus"],
  targetKinds: ["cetus-clmm-pool"],

  async buildDeposit({
    wallet,
    chain,
    asset,
    amount,
    target,
  }: BuildDepositArgs): Promise<UnsignedCall> {
    if (chain.namespace !== "sui") {
      throw new DefiError("unsupported_chain", "cetus: requires sui namespace");
    }
    const { pool, coinTypeA, coinTypeB, tickSpacing } =
      requireCetusTarget(target);
    const inputCoinType = asset.contract ?? coinTypeA;
    const isAssetA = eqSuiCoinType(inputCoinType, coinTypeA);
    if (!isAssetA && !eqSuiCoinType(inputCoinType, coinTypeB)) {
      throw new DefiError(
        "deposit_failed",
        "cetus: deposit asset doesn't match either pool leg",
      );
    }
    try {
      const client = suiClientFor(chain);
      const curSqrtPrice = await readCurrentSqrtPrice(
        client,
        pool,
        coinTypeA,
        coinTypeB,
        wallet.address,
      );
      const rawSplit = estimateFullRangeSwapSplit(
        curSqrtPrice,
        amount,
        isAssetA,
      );
      // `estimateFullRangeSwapSplit` is frictionless (no pool fee, no price
      // impact); the real swap always delivers slightly less of the swapped
      // leg than that estimate, and `add_liquidity_fix_coin` requires the
      // EXACT amount computed from the (unmoved) fixed leg — undershooting
      // aborts the tx (`balance::split`, code 2/ENotEnough). Device-verified
      // 2026-08-22: a 0.05%-fee pool needed ~0.1% more of the swapped leg
      // than the frictionless math gave. Shift a safety margin from keep to
      // swap so a real swap's fee-adjusted output still covers it — this is
      // comfortably wide for every Cetus fee tier (max 2%); overshoot just
      // means a larger (still-refunded) leftover, never a lost fund.
      const SWAP_SAFETY_BPS = 300n; // 3%
      const swapMargin = (amount * SWAP_SAFETY_BPS) / 10_000n;
      const paddedSwap = rawSplit.swapAmount + swapMargin;
      const swapAmount =
        rawSplit.swapAmount > 0n
          ? paddedSwap < amount
            ? paddedSwap
            : amount
          : 0n;
      const keepAmount = amount - swapAmount;

      const tx = new Transaction();
      tx.setSender(wallet.address);

      const inputCoin = await prepareInputCoin(
        tx,
        client,
        wallet.address,
        inputCoinType,
        amount,
      );

      let coinA: TransactionObjectArgument;
      let coinB: TransactionObjectArgument;

      if (swapAmount > 0n) {
        // Split off ONLY the swap leg; the mutated `inputCoin` itself becomes
        // the keep leg (its balance is left at exactly `keepAmount`). Splitting
        // into two pieces that together consume the whole coin (the earlier
        // draft did `splitCoins(inputCoin, [keepAmount, swapAmount])`) leaves
        // the original `inputCoin` argument as an unconsumed zero-balance
        // remainder — Coin<T> has no `drop`, so the PTB builder rejects it
        // (`UnusedValueWithoutDrop`, found via `tx.build()`, 2026-08-22).
        const [swapCoin] = tx.splitCoins(inputCoin, [tx.pure.u64(swapAmount)]);
        const keepCoin = inputCoin;
        // a2b: true when swapping A→B (input is A, need B); direction and
        // sqrt_price_limit are opposite bounds (verified against a real
        // production router::swap call, 2026-08-22).
        const zeroOther = tx.moveCall({
          target: "0x2::coin::zero",
          typeArguments: [isAssetA ? coinTypeB : coinTypeA],
          arguments: [],
        });
        const swapArgsCoinA = isAssetA ? swapCoin : zeroOther;
        const swapArgsCoinB = isAssetA ? zeroOther : swapCoin;
        // `router::swap` has no SEPARATE min-out parameter — this bound is
        // the ONLY same-block MEV protection available (a searcher can still
        // move the pool price between this transaction landing in a block
        // and executing, even though everything inside the PTB itself is
        // atomic — see `sqrtPriceLimitWithTolerance`'s header). Passing the
        // protocol's absolute MIN/MAX_SQRT_PRICE here (an earlier version of
        // this file did) accepts literally any execution price, which is
        // equivalent to no protection at all — found and fixed 2026-08-22
        // while building Turbos's adapter alongside this one.
        const sqrtPriceLimit = sqrtPriceLimitWithTolerance(
          curSqrtPrice,
          isAssetA,
          SWAP_SAFETY_BPS,
        );
        const [outA, outB] = tx.moveCall({
          target: `${CETUS_INTEGRATE_PACKAGE}::router::swap`,
          typeArguments: [coinTypeA, coinTypeB],
          arguments: [
            tx.object(CETUS_GLOBAL_CONFIG),
            tx.object(pool),
            swapArgsCoinA,
            swapArgsCoinB,
            tx.pure.bool(isAssetA), // a2b
            tx.pure.bool(true), // by_amount_in
            tx.pure.u64(swapAmount),
            tx.pure.u128(sqrtPriceLimit),
            tx.pure.bool(false), // observed constant in production calls
            tx.object(SUI_CLOCK_OBJECT_ID),
          ],
        });
        coinA = outA;
        coinB = outB;
        if (!isAssetA) {
          // keepCoin is B; merge it into the swap's B output for a single
          // Coin<B> to work with below.
          tx.mergeCoins(coinB, [keepCoin]);
        } else {
          tx.mergeCoins(coinA, [keepCoin]);
        }
      } else {
        // Degenerate estimate (shouldn't happen for a healthy pool) — treat
        // the whole input as one leg, zero the other; add_liquidity_fix_coin
        // will fail closed if that's genuinely wrong.
        const zeroOther = tx.moveCall({
          target: "0x2::coin::zero",
          typeArguments: [isAssetA ? coinTypeB : coinTypeA],
          arguments: [],
        });
        coinA = isAssetA ? inputCoin : zeroOther;
        coinB = isAssetA ? zeroOther : inputCoin;
      }

      // Full range is PER-POOL, not a universal constant — open_position
      // rejects ticks that aren't multiples of this pool's own tick_spacing
      // (found via a live devInspect abort in `check_position_tick_range`,
      // 2026-08-22; see clmmMath.ts's `fullRangeTicksFor` header).
      const { lower: tickLower, upper: tickUpper } =
        fullRangeTicksFor(tickSpacing);
      const position = tx.moveCall({
        target: `${CETUS_CLMM_PACKAGE}::pool::open_position`,
        typeArguments: [coinTypeA, coinTypeB],
        arguments: [
          tx.object(CETUS_GLOBAL_CONFIG),
          tx.object(pool),
          // Tick indices are signed (i32) but the entry fn's param is a bare
          // U32 — the SDK itself does this exact two's-complement transform
          // (`asUintN(BigInt(tick))`) before passing a negative tick.
          tx.pure.u32(tickAsU32(tickLower)),
          tx.pure.u32(tickAsU32(tickUpper)),
        ],
      });

      // Fix on `keepAmount` — the side we control EXACTLY (no swap-slippage
      // uncertainty), not the swapped side. If the swap under-delivered the
      // other leg, the split below simply fails closed (insufficient
      // balance), never silently short.
      const fixAmount = keepAmount > 0n ? keepAmount : 1n;
      const receipt = tx.moveCall({
        target: `${CETUS_CLMM_PACKAGE}::pool::add_liquidity_fix_coin`,
        typeArguments: [coinTypeA, coinTypeB],
        arguments: [
          tx.object(CETUS_GLOBAL_CONFIG),
          tx.object(pool),
          position,
          tx.pure.u64(fixAmount),
          tx.pure.bool(isAssetA),
          tx.object(SUI_CLOCK_OBJECT_ID),
        ],
      });

      const [payA, payB] = tx.moveCall({
        target: `${CETUS_CLMM_PACKAGE}::pool::add_liquidity_pay_amount`,
        typeArguments: [coinTypeA, coinTypeB],
        arguments: [receipt],
      });

      const [splitA] = tx.moveCall({
        target: "0x2::coin::split",
        typeArguments: [coinTypeA],
        arguments: [coinA, payA],
      });
      const [balA] = tx.moveCall({
        target: "0x2::coin::into_balance",
        typeArguments: [coinTypeA],
        arguments: [splitA],
      });
      const [splitB] = tx.moveCall({
        target: "0x2::coin::split",
        typeArguments: [coinTypeB],
        arguments: [coinB, payB],
      });
      const [balB] = tx.moveCall({
        target: "0x2::coin::into_balance",
        typeArguments: [coinTypeB],
        arguments: [splitB],
      });

      tx.moveCall({
        target: `${CETUS_CLMM_PACKAGE}::pool::repay_add_liquidity`,
        typeArguments: [coinTypeA, coinTypeB],
        arguments: [
          tx.object(CETUS_GLOBAL_CONFIG),
          tx.object(pool),
          balA,
          balB,
          receipt,
        ],
      });

      tx.transferObjects(
        [position, coinA, coinB],
        tx.pure.address(wallet.address),
      );

      const bytes = await tx.build({ client });
      return { kind: "sui-ptb", transactionBlockBase64: toBase64(bytes) };
    } catch (err) {
      if (err instanceof DefiError) throw err;
      devWarn("buildDeposit", err);
      throw classifySuiMoveError(err, "deposit_failed");
    }
  },

  async buildWithdraw(_args: BuildWithdrawArgs): Promise<UnsignedCall> {
    throw new DefiError(
      "withdraw_failed",
      "In-app withdrawal isn't available for Cetus yet. Withdraw at cetus.zone.",
    );
  },

  async readPosition(): Promise<DefiPosition | null> {
    // Not implemented: a CLMM position's value needs live pool price + tick
    // math, and the position is an NFT, not a fungible balance — a
    // meaningfully different read than every other adapter here. The
    // position still shows its recorded deposit amount via the generic
    // fallback.
    return null;
  },
};
