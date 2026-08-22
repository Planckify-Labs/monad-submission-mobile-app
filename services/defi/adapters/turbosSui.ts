/**
 * Turbos Finance CLMM adapter — a `DefiProtocolAdapter` for pool-level Sui
 * deposits (docs/defi-pool-level-deposits-spec.md §7, Phase 3). Built
 * 2026-08-22, same session as `cetusSui.ts` — same reasoning for WHY a
 * single-asset deposit needs an internal swap-split zap (see that file's
 * header), but a materially simpler on-chain interface:
 *
 * `position_manager::mint` takes EXPLICIT `amountA`/`amountB` (no hot-potato
 * receipt/repay dance like Cetus's `add_liquidity_fix_coin`/
 * `add_liquidity_pay_amount`) and does not return anything the caller must
 * dispose of — confirmed against 5 real, recent, successful mainnet
 * transactions (argument order, shapes, AND that no destructured return
 * value is ever consumed downstream) that both the position NFT and any
 * unused leg get sent to the `recipient` argument internally.
 *
 * This adapter reads `amountA`/`amountB` back from the ACTUAL held coin
 * balances IN-PTB (chained `coin::value` results used directly as `mint`'s
 * u64 arguments), not an off-chain estimate — so unlike Cetus there is no
 * risk of an "insufficient balance" abort from the swap under-delivering
 * relative to a frictionless estimate: whatever we actually hold after the
 * swap is exactly what gets offered, and `mint` only ever uses up to what a
 * balanced full-range position needs, refunding any excess of the other leg
 * itself.
 *
 * PTB, all in one atomic transaction:
 *   1. read the pool object's own `sqrt_price`/`tick_spacing` fields
 *      directly via `sui_getObject` (Turbos stores them as plain struct
 *      fields — no devInspect moveCall pre-read needed, unlike Cetus)
 *   2. estimateFullRangeSwapSplit (clmmMath.ts) → keepAmount / swapAmount
 *      (a sizing estimate only — see above for why no fee/safety margin is
 *      needed here, unlike Cetus)
 *   3. split the input coin; `swap_router::swap_{a_b,b_a}_with_return_` the
 *      `swapAmount` leg, with a REAL min-out floor (`estimateSwapOutput` +
 *      tolerance) — same-block MEV is still possible even inside one atomic
 *      PTB (see that function's header), so this is genuine protection, not
 *      a formality
 *   4. merge the swap's small leftover-of-input back into the kept coin
 *   5. `pool::` full-range ticks via `fullRangeTicksFor(tickSpacing)`,
 *      encoded as Turbos's (absValue:u32, isNegative:bool) pair — not
 *      Cetus's two's-complement u32
 *   6. read back the EXACT held balance of each leg via chained
 *      `coin::value` calls
 *   7. `position_manager::mint(pool, Positions, vec[coinA], vec[coinB],
 *      tickLower, tickUpper, amountA, amountB, amountAMin, amountBMin,
 *      recipient, deadline, Clock, Versioned)` — position NFT + any refund
 *      go to `recipient` internally; nothing left for this adapter to
 *      transfer itself
 *
 * Device-verified 2026-08-22 via `sui_devInspectTransactionBlock` against
 * live mainnet. The B-input direction (isAssetA=true here — depositing SUI
 * into a SUI/USDC pool) was proven end to end through this exact adapter's
 * `buildDeposit`, full flow including `tx.build({client})`'s own stricter
 * dry run. The mirrored direction (isAssetA=false) didn't have a funded
 * wallet available for this pool either, so — same technique used for
 * Cetus — its `swap_router::swap_b_a_with_return_` call was proven on live
 * mainnet in isolation (bootstrapped via a same-PTB SUI→USDC swap first),
 * confirming BOTH its argument shape and its (proceeds, leftover) return
 * order match what `buildDeposit`'s direction-agnostic destructuring
 * expects; the rest of the pipeline (mint, tick encoding, in-PTB balance
 * read-back) is the exact code already proven for the other direction. The
 * swap-split math (`clmmMath.ts`) is the SAME code already cross-checked
 * bit-exact against Cetus's published SDK formulas — protocol-agnostic by
 * design, and Turbos publishes the identical MIN/MAX_TICK_INDEX /
 * MIN/MAX_SQRT_PRICE constants in its own SDK, confirming the math
 * generalizes.
 *
 * WITHDRAW is NOT wired: `decrease_liquidity` + `collect`/`collect_reward` +
 * `burn` needs its own careful pass (position NFT bookkeeping, what to do
 * with accrued fees/rewards) — deliberately out of scope this round, same
 * discipline as Cetus/Suilend/Current/Kai's withdraw gaps.
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
  estimateFullRangeSwapSplit,
  estimateSwapOutput,
  fullRangeTicksFor,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
} from "./sui/clmmMath";
import { eqSuiCoinType, prepareInputCoin } from "./sui/coins";
import { getTurbosConfig } from "./turbos.config";

const SLUG = "turbos-sui";
const NETWORK = "mainnet" as const;
const DEADLINE_MS = 5 * 60 * 1000; // 5 minutes
const SWAP_SLIPPAGE_BPS = 300n; // 3% min-out tolerance on the internal swap leg

function devWarn(scope: string, err: unknown): void {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn(`[turbosSui] ${scope}:`, err);
  }
}

function suiClientFor(chain: SuiChainConfig): SuiJsonRpcClient {
  return new SuiJsonRpcClient({ url: chain.rpcUrl, network: chain.network });
}

function requireTurbosTarget(
  target: DepositTarget | undefined,
): Extract<DepositTarget, { kind: "turbos-clmm-pool" }> {
  if (target?.kind !== "turbos-clmm-pool") {
    throw new DefiError(
      "deposit_failed",
      "turbos: a resolved pool target is required (pool + both leg types)",
    );
  }
  return target;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Read `Pool<A,B,Fee>.sqrt_price` directly off the object's own fields — no
 *  devInspect moveCall needed, Turbos stores it as a plain struct field. */
async function readPoolSqrtPrice(
  client: SuiJsonRpcClient,
  pool: string,
): Promise<bigint> {
  const obj = await client.getObject({
    id: pool,
    options: { showContent: true },
  });
  const data = isRecord(obj) ? (obj as { data?: unknown }).data : undefined;
  const content = isRecord(data) ? data.content : undefined;
  const fields = isRecord(content) ? content.fields : undefined;
  const raw = isRecord(fields) ? fields.sqrt_price : undefined;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new DefiError("deposit_failed", "turbos: could not read pool price");
  }
  return BigInt(raw);
}

export const TurbosSuiAdapter: DefiProtocolAdapter = {
  slug: SLUG,
  namespace: "sui",
  kind: "yield_vault",
  chainId: NETWORK,
  displayName: "Turbos Finance",
  staticSafetyScore: 55,
  externalSlugs: ["turbos", "turbos-finance"],
  targetKinds: ["turbos-clmm-pool"],

  async buildDeposit({
    wallet,
    chain,
    asset,
    amount,
    target,
  }: BuildDepositArgs): Promise<UnsignedCall> {
    if (chain.namespace !== "sui") {
      throw new DefiError(
        "unsupported_chain",
        "turbos: requires sui namespace",
      );
    }
    const { pool, coinTypeA, coinTypeB, feeType, tickSpacing } =
      requireTurbosTarget(target);
    const inputCoinType = asset.contract ?? coinTypeA;
    const isAssetA = eqSuiCoinType(inputCoinType, coinTypeA);
    if (!isAssetA && !eqSuiCoinType(inputCoinType, coinTypeB)) {
      throw new DefiError(
        "deposit_failed",
        "turbos: deposit asset doesn't match either pool leg",
      );
    }
    try {
      const client = suiClientFor(chain);
      const config = await getTurbosConfig();
      const curSqrtPrice = await readPoolSqrtPrice(client, pool);
      const { swapAmount } = estimateFullRangeSwapSplit(
        curSqrtPrice,
        amount,
        isAssetA,
      );
      const typeArguments = [coinTypeA, coinTypeB, feeType];
      const deadline = Date.now() + DEADLINE_MS;

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
        const [swapCoin] = tx.splitCoins(inputCoin, [tx.pure.u64(swapAmount)]);
        const keepCoin = inputCoin; // mutated in place; now holds keepAmount
        const expectedOut = estimateSwapOutput(
          curSqrtPrice,
          swapAmount,
          isAssetA,
        );
        const minOut = (expectedOut * (10_000n - SWAP_SLIPPAGE_BPS)) / 10_000n;
        const sqrtPriceLimit = isAssetA ? MIN_SQRT_PRICE : MAX_SQRT_PRICE;
        // `proceeds` is the coin we swapped INTO; `leftover` is a (near-zero,
        // since swapAmount == the whole swapCoin) change coin of the SAME
        // type as the input — has no `drop`, so it's merged into `keepCoin`
        // rather than left dangling (same class of bug fixed in cetusSui.ts).
        const [proceeds, leftover] = tx.moveCall({
          target: `${config.packageId}::swap_router::swap_${isAssetA ? "a_b" : "b_a"}_with_return_`,
          typeArguments,
          arguments: [
            tx.object(pool),
            tx.makeMoveVec({ elements: [swapCoin] }),
            tx.pure.u64(swapAmount),
            tx.pure.u64(minOut),
            tx.pure.u128(sqrtPriceLimit),
            tx.pure.bool(true), // amountSpecifiedIsInput
            tx.pure.address(wallet.address), // accounting only — proceeds are RETURNED, not auto-transferred (verified against a real transaction)
            tx.pure.u64(deadline),
            tx.object(SUI_CLOCK_OBJECT_ID),
            tx.object(config.versioned),
          ],
        });
        tx.mergeCoins(keepCoin, [leftover]);
        coinA = isAssetA ? keepCoin : proceeds;
        coinB = isAssetA ? proceeds : keepCoin;
      } else {
        const zeroOther = tx.moveCall({
          target: "0x2::coin::zero",
          typeArguments: [isAssetA ? coinTypeB : coinTypeA],
          arguments: [],
        });
        coinA = isAssetA ? inputCoin : zeroOther;
        coinB = isAssetA ? zeroOther : inputCoin;
      }

      // Read the EXACT held balances back in-PTB — no off-chain guessing for
      // `mint`'s amountA/amountB, unlike the swap-sizing estimate above.
      const [amountA] = tx.moveCall({
        target: "0x2::coin::value",
        typeArguments: [coinTypeA],
        arguments: [coinA],
      });
      const [amountB] = tx.moveCall({
        target: "0x2::coin::value",
        typeArguments: [coinTypeB],
        arguments: [coinB],
      });

      const { lower: tickLower, upper: tickUpper } =
        fullRangeTicksFor(tickSpacing);

      tx.moveCall({
        target: `${config.packageId}::position_manager::mint`,
        typeArguments,
        arguments: [
          tx.object(pool),
          tx.object(config.positions),
          tx.makeMoveVec({ elements: [coinA] }),
          tx.makeMoveVec({ elements: [coinB] }),
          tx.pure.u32(Math.abs(tickLower)),
          tx.pure.bool(tickLower < 0),
          tx.pure.u32(Math.abs(tickUpper)),
          tx.pure.bool(tickUpper < 0),
          amountA,
          amountB,
          // Modest non-zero floors, not real slippage protection: the
          // amounts above are read back EXACT and atomic (no time gap), so
          // the only thing these guard against is a genuinely degenerate
          // (near-zero) mint, not price movement.
          tx.pure.u64(1n),
          tx.pure.u64(1n),
          tx.pure.address(wallet.address), // recipient — mint transfers the position NFT + any refund here internally; nothing left for this adapter to do
          tx.pure.u64(deadline),
          tx.object(SUI_CLOCK_OBJECT_ID),
          tx.object(config.versioned),
        ],
      });

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
      "In-app withdrawal isn't available for Turbos yet. Withdraw at app.turbos.finance.",
    );
  },

  async readPosition(): Promise<DefiPosition | null> {
    // Not implemented: same reasoning as cetusSui.ts — a CLMM position's
    // value needs live pool price + tick math and the position is an NFT,
    // not a fungible balance. Falls back to the generic recorded-deposit view.
    return null;
  },
};
