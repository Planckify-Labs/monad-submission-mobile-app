/**
 * Bluefin Spot CLMM adapter — a `DefiProtocolAdapter` for pool-level Sui
 * deposits (docs/defi-pool-level-deposits-spec.md §7, Phase 3). Built
 * 2026-08-22, same session as `cetusSui.ts`/`turbosSui.ts` — same reasoning
 * for WHY a single-asset deposit needs an internal swap-split zap (see
 * `cetusSui.ts`'s header), but its own mix of the other two protocols'
 * interfaces:
 *
 * `pool::open_position(config, pool, tickLower, tickUpper) -> Position`
 * takes just 4 args like Cetus (two's-complement u32 ticks, no separate
 * bool like Turbos). `gateway::provide_liquidity_with_fixed_amount` takes
 * explicit `amount`/`amountAMax`/`amountBMax` like Turbos's `mint` (no
 * hot-potato receipt/repay dance) — confirmed against 2 real, recent,
 * successful mainnet transactions, INCLUDING checking that transaction's own
 * `balanceChanges`/`objectChanges` to confirm the liquidity call auto-
 * refunds any unused offered balance to the sender internally (not just
 * that it succeeded — same discipline `cetus.config.ts`'s header describes
 * learning the hard way).
 *
 * The internal swap uses the LOW-LEVEL `pool::swap` (takes/returns
 * `Balance<A>`/`Balance<B>`, composable in one PTB), NOT the convenience
 * `gateway::swap_assets` — that one was found, via a real transaction with
 * no disposal commands after it, to auto-transfer its output coins straight
 * to the sender. That makes it an "entry"-style function: fine standalone,
 * but not chainable into the same PTB as a deposit, since its outputs never
 * come back as a PTB value this adapter could hand to `open_position`/
 * `provide_liquidity_with_fixed_amount`.
 *
 * PTB, all in one atomic transaction:
 *   1. read the pool object's own `current_sqrt_price` field directly via
 *      `sui_getObject` (no devInspect moveCall pre-read needed, same as
 *      Turbos — Bluefin stores it as a plain struct field too)
 *   2. estimateFullRangeSwapSplit (clmmMath.ts) → swapAmount, then pad it
 *      with a safety margin — UNLIKE Turbos, `provide_liquidity_with_fixed_
 *      amount` FIXES one side exactly and only CAPS the other, so it hits
 *      the exact same "frictionless estimate undershoots the real,
 *      fee-reduced swap output" failure Cetus's `add_liquidity_fix_coin`
 *      does (`utils::deposit_balance` abort 1004, found via devInspect
 *      2026-08-22) — see the swapMargin comment at its call site
 *   3. split the input coin; `pool::swap` the `swapAmount` leg via
 *      Balance<T> conversion, with a REAL min-out floor
 *      (`estimateSwapOutput` + tolerance) and a tightened `sqrt_price_limit`
 *      (`sqrtPriceLimitWithTolerance`) — same-block MEV is still possible
 *      even inside one atomic PTB (see that function's header)
 *   4. merge the swap's small leftover-of-input back into the kept coin
 *   5. `pool::open_position` full-range ticks via
 *      `fullRangeTicksFor(tickSpacing)`, encoded two's-complement (Cetus's
 *      convention, not Turbos's abs+bool pair)
 *   6. read back the EXACT held balance of each leg via chained
 *      `coin::value` calls, reused for BOTH `amount` (the fixed side) and
 *      that side's own "Max" argument — mirrors the real transaction's own
 *      pattern of passing the identical value twice
 *   7. `gateway::provide_liquidity_with_fixed_amount(Clock, GlobalConfig,
 *      pool, position, coinA, coinB, amount, amountAMax, amountBMax,
 *      fix_amount_a)` — any unused offered COIN balance is auto-refunded to
 *      the sender internally; `position` is a `&mut Position` parameter
 *      here (a borrow, not a consuming take), so this adapter still has to
 *      transfer the Position NFT itself
 *   8. transfer the Position NFT to sender (found the hard way: omitting
 *      this aborts client-side with `UnusedValueWithoutDrop` — a `&mut`
 *      parameter borrows a value, it doesn't consume it)
 *
 * Device-verified 2026-08-22 via `sui_devInspectTransactionBlock` against
 * live mainnet. The A-input direction (isAssetA=true — depositing SUI into
 * this SUI/USDC pool) was proven end to end through this exact adapter's
 * `buildDeposit`, full flow including `tx.build({client})`'s own stricter
 * dry run. The mirrored direction (isAssetA=false) didn't have a funded
 * wallet available for this pool either, so — same technique used for
 * Cetus/Turbos — its `pool::swap(a2b=false)` call was proven on live
 * mainnet in isolation (bootstrapped via a same-PTB SUI→USDC swap first),
 * confirming its argument shape and (Balance<A>, Balance<B>) return order
 * match what `buildDeposit` expects; the rest of the pipeline
 * (open_position/provide_liquidity_with_fixed_amount/position transfer) is
 * the exact code already proven for the other direction. One thing this
 * isolation pass caught along the way: using the pool's ABSOLUTE
 * MIN/MAX_SQRT_PRICE as the swap's price bound (rather than
 * `sqrtPriceLimitWithTolerance`'s tight, near-current-price bound) makes
 * `pool::swap` abort outright on this tick_spacing=1 pool — not just weaker
 * MEV protection, an outright failure — reinforcing that the tight bound
 * this adapter already uses is load-bearing, not just best practice. The
 * swap-split math (`clmmMath.ts`) is the SAME code already cross-checked
 * bit-exact against Cetus's published SDK formulas — protocol-agnostic by
 * design, and Bluefin's own SDK publishes the identical MIN/MAX_TICK_INDEX /
 * MIN/MAX_SQRT_PRICE constants, confirming the math generalizes a third
 * time.
 *
 * WITHDRAW is NOT wired: `pool::remove_liquidity` + `gateway::close_position`
 * needs its own careful pass (position NFT bookkeeping, what to do with
 * accrued fees/rewards) — deliberately out of scope this round, same
 * discipline as Cetus/Turbos/Suilend/Current/Kai's withdraw gaps.
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
  BLUEFIN_CURRENT_PACKAGE,
  BLUEFIN_GLOBAL_CONFIG,
} from "./bluefin.config";
import {
  estimateFullRangeSwapSplit,
  estimateSwapOutput,
  fullRangeTicksFor,
  sqrtPriceLimitWithTolerance,
} from "./sui/clmmMath";
import { eqSuiCoinType, prepareInputCoin } from "./sui/coins";

const SLUG = "bluefin-spot-sui";
const NETWORK = "mainnet" as const;
// 3%, doing double duty: the swap's min-out/price-limit tolerance, AND the
// swap-sizing safety margin (see the swapMargin comment at its call site).
const SWAP_SLIPPAGE_BPS = 300n;

/** Two's-complement u32 encoding of a (possibly negative) tick index — same
 *  transform as `cetusSui.ts`'s `tickAsU32`, Bluefin's `open_position` uses
 *  the identical bare-u32 convention (confirmed via a real transaction). */
function tickAsU32(tick: number): number {
  return tick >>> 0;
}

function devWarn(scope: string, err: unknown): void {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn(`[bluefinSpotSui] ${scope}:`, err);
  }
}

function suiClientFor(chain: SuiChainConfig): SuiJsonRpcClient {
  return new SuiJsonRpcClient({ url: chain.rpcUrl, network: chain.network });
}

function requireBluefinTarget(
  target: DepositTarget | undefined,
): Extract<DepositTarget, { kind: "bluefin-spot-pool" }> {
  if (target?.kind !== "bluefin-spot-pool") {
    throw new DefiError(
      "deposit_failed",
      "bluefin-spot: a resolved pool target is required (pool + both leg types)",
    );
  }
  return target;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Read `Pool<A,B>.current_sqrt_price` directly off the object's own fields
 *  — no devInspect moveCall needed, Bluefin stores it as a plain struct
 *  field (same as Turbos). */
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
  const raw = isRecord(fields) ? fields.current_sqrt_price : undefined;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new DefiError(
      "deposit_failed",
      "bluefin-spot: could not read pool price",
    );
  }
  return BigInt(raw);
}

export const BluefinSpotSuiAdapter: DefiProtocolAdapter = {
  slug: SLUG,
  namespace: "sui",
  kind: "yield_vault",
  chainId: NETWORK,
  displayName: "Bluefin Spot",
  staticSafetyScore: 55,
  externalSlugs: ["bluefin-spot"],
  targetKinds: ["bluefin-spot-pool"],

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
        "bluefin-spot: requires sui namespace",
      );
    }
    const { pool, coinTypeA, coinTypeB, tickSpacing } =
      requireBluefinTarget(target);
    const inputCoinType = asset.contract ?? coinTypeA;
    const isAssetA = eqSuiCoinType(inputCoinType, coinTypeA);
    if (!isAssetA && !eqSuiCoinType(inputCoinType, coinTypeB)) {
      throw new DefiError(
        "deposit_failed",
        "bluefin-spot: deposit asset doesn't match either pool leg",
      );
    }
    try {
      const client = suiClientFor(chain);
      const curSqrtPrice = await readPoolSqrtPrice(client, pool);
      const rawSplit = estimateFullRangeSwapSplit(
        curSqrtPrice,
        amount,
        isAssetA,
      );
      // Unlike Turbos's `mint` (both sides flexible, contract just uses
      // whichever is binding), `provide_liquidity_with_fixed_amount` FIXES
      // one side exactly (`fix_amount_a`) and only CAPS the other — the same
      // "fix one side, the other must independently be enough" shape as
      // Cetus's `add_liquidity_fix_coin`, and it hits the exact same
      // failure mode: `estimateFullRangeSwapSplit` is frictionless, so the
      // real (fee-reduced) swap proceeds undershoot what the fixed side
      // then requires (`utils::deposit_balance` abort code 1004, found via
      // devInspect 2026-08-22). Same fix as `cetusSui.ts`: pad swapAmount
      // with a safety margin so the swapped-to leg comfortably covers it —
      // overshoot just means a larger (still-refunded) leftover.
      const swapMargin = (amount * SWAP_SLIPPAGE_BPS) / 10_000n;
      const paddedSwap = rawSplit.swapAmount + swapMargin;
      const swapAmount =
        rawSplit.swapAmount > 0n
          ? paddedSwap < amount
            ? paddedSwap
            : amount
          : 0n;
      const typeArguments = [coinTypeA, coinTypeB];

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
        const keepCoin = inputCoin; // mutated in place; now holds the unswapped amount
        const expectedOut = estimateSwapOutput(
          curSqrtPrice,
          swapAmount,
          isAssetA,
        );
        const minOut = (expectedOut * (10_000n - SWAP_SLIPPAGE_BPS)) / 10_000n;
        const sqrtPriceLimit = sqrtPriceLimitWithTolerance(
          curSqrtPrice,
          isAssetA,
          SWAP_SLIPPAGE_BPS,
        );

        const [inBalance] = tx.moveCall({
          target: "0x2::coin::into_balance",
          typeArguments: [isAssetA ? coinTypeA : coinTypeB],
          arguments: [swapCoin],
        });
        const [zeroBalance] = tx.moveCall({
          target: "0x2::balance::zero",
          typeArguments: [isAssetA ? coinTypeB : coinTypeA],
          arguments: [],
        });
        const balanceArgsA = isAssetA ? inBalance : zeroBalance;
        const balanceArgsB = isAssetA ? zeroBalance : inBalance;

        const [balOutA, balOutB] = tx.moveCall({
          target: `${BLUEFIN_CURRENT_PACKAGE}::pool::swap`,
          typeArguments,
          arguments: [
            tx.object(SUI_CLOCK_OBJECT_ID),
            tx.object(BLUEFIN_GLOBAL_CONFIG),
            tx.object(pool),
            balanceArgsA,
            balanceArgsB,
            tx.pure.bool(isAssetA), // a2b
            tx.pure.bool(true), // by_amount_in
            tx.pure.u64(swapAmount),
            tx.pure.u64(minOut),
            tx.pure.u128(sqrtPriceLimit),
          ],
        });

        const [outCoinA] = tx.moveCall({
          target: "0x2::coin::from_balance",
          typeArguments: [coinTypeA],
          arguments: [balOutA],
        });
        const [outCoinB] = tx.moveCall({
          target: "0x2::coin::from_balance",
          typeArguments: [coinTypeB],
          arguments: [balOutB],
        });

        if (isAssetA) {
          tx.mergeCoins(outCoinA, [keepCoin]);
        } else {
          tx.mergeCoins(outCoinB, [keepCoin]);
        }
        coinA = outCoinA;
        coinB = outCoinB;
      } else {
        const zeroOther = tx.moveCall({
          target: "0x2::coin::zero",
          typeArguments: [isAssetA ? coinTypeB : coinTypeA],
          arguments: [],
        });
        coinA = isAssetA ? inputCoin : zeroOther;
        coinB = isAssetA ? zeroOther : inputCoin;
      }

      const { lower: tickLower, upper: tickUpper } =
        fullRangeTicksFor(tickSpacing);

      const position = tx.moveCall({
        target: `${BLUEFIN_CURRENT_PACKAGE}::pool::open_position`,
        typeArguments,
        arguments: [
          tx.object(BLUEFIN_GLOBAL_CONFIG),
          tx.object(pool),
          tx.pure.u32(tickAsU32(tickLower)),
          tx.pure.u32(tickAsU32(tickUpper)),
        ],
      });

      // Read the EXACT held balances back in-PTB — no off-chain guessing.
      // Reused for BOTH `amount` (the fixed side) and that side's own "Max"
      // argument, mirroring the real transaction's own pattern of passing
      // the identical value twice (see file header).
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

      tx.moveCall({
        target: `${BLUEFIN_CURRENT_PACKAGE}::gateway::provide_liquidity_with_fixed_amount`,
        typeArguments,
        arguments: [
          tx.object(SUI_CLOCK_OBJECT_ID),
          tx.object(BLUEFIN_GLOBAL_CONFIG),
          tx.object(pool),
          position,
          coinA,
          coinB,
          isAssetA ? amountA : amountB,
          amountA,
          amountB,
          tx.pure.bool(isAssetA), // fix_amount_a
        ],
      });

      // `position` is a `&mut Position` parameter above, not consumed by
      // value — the liquidity call auto-refunds unused COIN balance to the
      // sender internally, but the Position NFT itself is only ever
      // borrowed, never transferred, by either call. Confirmed against the
      // normalized signature (`sui_getNormalizedMoveFunction`) AND the real
      // production transaction, whose own final command is exactly this
      // transfer (found the hard way: the built-without-this-transfer PTB
      // aborts client-side with `UnusedValueWithoutDrop`, 2026-08-22).
      tx.transferObjects([position], tx.pure.address(wallet.address));

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
      "In-app withdrawal isn't available for Bluefin yet. Withdraw at trade.bluefin.io.",
    );
  },

  async readPosition(): Promise<DefiPosition | null> {
    // Not implemented: same reasoning as cetusSui.ts/turbosSui.ts — a CLMM
    // position's value needs live pool price + tick math and the position
    // is an NFT, not a fungible balance. Falls back to the generic
    // recorded-deposit view.
    return null;
  },
};
