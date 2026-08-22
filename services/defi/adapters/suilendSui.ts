/**
 * Suilend adapter — a `DefiProtocolAdapter` for pool-level Sui deposits
 * (docs/defi-pool-level-deposits-spec.md §7, Phase 3). Suilend is a Sui money
 * market whose supply mints a `Coin<CToken<P,T>>` receipt (like Scallop's
 * MarketCoin) — ONE adapter covers every Suilend reserve, dispatched by
 * `DepositTarget.kind === "suilend-market"`.
 *
 * NO SDK. PTBs are built directly with `@mysten/sui`, calling Suilend's public
 * lending_market gateway:
 *
 *   deposit → lending_market::deposit_liquidity_and_mint_ctokens<P,T>(
 *               lendingMarket, reserveArrayIndex, clock, coin) -> Coin<CToken<P,T>>
 *
 * The `reserve::CToken<P,T>` receipt goes to the sender. `P` (marketType) is the
 * market phantom `<pkg>::suilend::MAIN_POOL` — that address is the type's
 * ORIGINAL/immutable publish address, which is NOT the same as the CURRENT
 * moveCall target once a protocol upgrades (see `suilend.config.ts`).
 *
 * CORRECTED 2026-08-22 — this adapter (and its resolver/bootstrap registration)
 * was withheld since 2026-07-03 for a reason that turned out to be wrong.
 * Original claim: "deposit AND withdraw both assert a fresh reserve price
 * (abort code 1), needs a Pyth pull-oracle push in-tx." Verified against
 * `solendprotocol/suilend`'s `lending_market.move` AND live
 * `sui_devInspectTransactionBlock`: `deposit_liquidity_and_mint_ctokens` and
 * `redeem_ctokens_and_withdraw_liquidity_request` call NEITHER Pyth nor any
 * price/oracle function — their only asserts are version/amount/coin-type/
 * rate-limiter. Abort code 1 is `EIncorrectVersion`: this file used to derive
 * the moveCall package from `marketType`'s immutable prefix, which is stale
 * (Suilend's on-chain `UpgradeCap.version` is 22 today; even the published
 * `@suilend/sdk@11.0.4` only knows up to "PKG_V11"). Fixed by fetching the
 * current package from the `UpgradeCap` (`suilend.config.ts`, "config not
 * constants" — same fix NAVI already needed for the identical bug shape, see
 * `navi.config.ts`).
 *
 * SCOPE (deposit-only, still true, but for a different reason now): deposit +
 * the atomic swap→supply zap are in-app, DEVICE-VERIFIED via devInspect
 * against live mainnet 2026-08-22. WITHDRAW stays deferred — the Move source
 * shows no oracle blocker, so it is very likely fine with the same package
 * fix, but it has NOT been exercised against a real on-chain position (no
 * owned CToken to devInspect with), so `buildWithdraw` still fails closed
 * with a curated "withdraw on site" message and `readPosition` still returns
 * null until that verification happens — not because of Pyth. MAINNET-ONLY
 * (`chainId:"mainnet"`).
 */

import { toBase64 } from "@mysten/bcs";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import type { SuiChainConfig } from "@/constants/configs/chainConfig";
import { SuiSwapError } from "@/services/swap/sui/types";
import { classifySuiMoveError, DefiError } from "../errors/defiErrors";
import type {
  BuildDepositArgs,
  BuildWithdrawArgs,
  DefiPosition,
  DefiProtocolAdapter,
  DepositTarget,
  UnsignedCall,
  ZapSupplyArgs,
  ZapSupplyResult,
} from "../types";
import { prepareInputCoin } from "./sui/coins";
import { getSuilendPackage } from "./suilend.config";

const SLUG = "suilend-sui";
const NETWORK = "mainnet" as const;
const DEPOSIT_TARGET = "lending_market::deposit_liquidity_and_mint_ctokens";

function devWarn(scope: string, err: unknown): void {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn(`[suilendSui] ${scope}:`, err);
  }
}

function suiClientFor(chain: SuiChainConfig): SuiJsonRpcClient {
  return new SuiJsonRpcClient({ url: chain.rpcUrl, network: chain.network });
}

/**
 * The `suilend-market` target is mandatory: the reserve is addressed by a
 * numeric `reserveArrayIndex` + the shared `LendingMarket` the LLM must never
 * supply, so without the resolved target there's nothing to deposit into.
 */
function requireSuilendTarget(
  target: DepositTarget | undefined,
): Extract<DepositTarget, { kind: "suilend-market" }> {
  if (target?.kind !== "suilend-market") {
    throw new DefiError(
      "deposit_failed",
      "suilend: a resolved pool target is required (market + reserve index)",
    );
  }
  return target;
}

/**
 * Atomic swap→supply zap (§4.7) — MAINNET-ONLY. ONE PTB: the injected swap leg
 * produces the reserve coin (T), which feeds `deposit_liquidity_and_mint_ctokens`
 * (a PUBLIC fn returning the cToken); the cToken + any swap leftovers transfer
 * back. Requires the `suilend-market` target.
 */
export async function buildSuilendZapSupply(
  args: ZapSupplyArgs,
): Promise<ZapSupplyResult> {
  if (args.chain.namespace !== "sui") {
    throw new DefiError("unsupported_chain", "suilend: requires sui namespace");
  }
  const { lendingMarket, marketType, reserveArrayIndex, coinType } =
    requireSuilendTarget(args.target);
  try {
    const client = suiClientFor(args.chain);
    const pkg = await getSuilendPackage(client);
    const tx = new Transaction();
    tx.setSender(args.wallet.address);

    const swap = await args.appendSwap(tx);
    if (!swap) {
      throw new DefiError("deposit_failed", "zap: swap leg unavailable");
    }

    const [ctoken] = tx.moveCall({
      target: `${pkg}::${DEPOSIT_TARGET}`,
      typeArguments: [marketType, coinType],
      arguments: [
        tx.object(lendingMarket),
        tx.pure.u64(BigInt(reserveArrayIndex)),
        tx.object(SUI_CLOCK_OBJECT_ID),
        swap.outputCoin,
      ],
    });
    tx.transferObjects(
      [ctoken, ...swap.leftoverCoins],
      tx.pure.address(args.wallet.address),
    );

    const bytes = await tx.build({ client });
    return {
      ptbBase64: toBase64(bytes),
      expectedOut: swap.expectedOut,
      priceImpact: swap.priceImpact,
      toCoinType: swap.toCoinType,
      poolObjectId: swap.poolObjectId,
    };
  } catch (err) {
    if (err instanceof DefiError) throw err;
    if (err instanceof SuiSwapError) throw err; // preserve actionable swap reason
    devWarn("buildSuilendZapSupply", err);
    throw classifySuiMoveError(err, "deposit_failed");
  }
}

export const SuilendSuiAdapter: DefiProtocolAdapter = {
  slug: SLUG,
  namespace: "sui",
  kind: "stablecoin_lending",
  chainId: NETWORK, // string id → free network gate via listDefiAdaptersForChain
  displayName: "Suilend",
  staticSafetyScore: 78,
  externalSlugs: ["suilend"],
  targetKinds: ["suilend-market"],
  buildZapSupply: buildSuilendZapSupply,

  async buildDeposit({
    wallet,
    chain,
    amount,
    target,
  }: BuildDepositArgs): Promise<UnsignedCall> {
    if (chain.namespace !== "sui") {
      throw new DefiError(
        "unsupported_chain",
        "suilend: requires sui namespace",
      );
    }
    const { lendingMarket, marketType, reserveArrayIndex, coinType } =
      requireSuilendTarget(target);
    try {
      const client = suiClientFor(chain);
      const pkg = await getSuilendPackage(client);
      const tx = new Transaction();
      tx.setSender(wallet.address);

      const depositCoin = await prepareInputCoin(
        tx,
        client,
        wallet.address,
        coinType,
        amount,
      );

      // deposit_liquidity_and_mint_ctokens<P,T>(lendingMarket, reserveArrayIndex,
      //   clock, coin) -> Coin<CToken<P,T>>. No oracle needed on the mint path
      // (verified against source + live devInspect, 2026-08-22 — see the file
      // header). `pkg` is the CURRENT package (suilend.config.ts); `marketType`'s
      // own prefix stays the immutable type identity for `typeArguments`.
      const [ctoken] = tx.moveCall({
        target: `${pkg}::${DEPOSIT_TARGET}`,
        typeArguments: [marketType, coinType],
        arguments: [
          tx.object(lendingMarket),
          tx.pure.u64(BigInt(reserveArrayIndex)),
          tx.object(SUI_CLOCK_OBJECT_ID),
          depositCoin,
        ],
      });
      tx.transferObjects([ctoken], tx.pure.address(wallet.address));

      const bytes = await tx.build({ client });
      return { kind: "sui-ptb", transactionBlockBase64: toBase64(bytes) };
    } catch (err) {
      if (err instanceof DefiError) throw err;
      devWarn("buildDeposit", err);
      throw classifySuiMoveError(err, "deposit_failed");
    }
  },

  async buildWithdraw(_args: BuildWithdrawArgs): Promise<UnsignedCall> {
    // Deferred, but NOT for the reason this comment used to give (corrected
    // 2026-08-22 — see the file header): `redeem_ctokens_and_withdraw_liquidity_request`
    // in Suilend's own Move source calls no Pyth/price function at all, and the
    // package-staleness bug that blocked deposit is fixed the same way here
    // (`getSuilendPackage`). What's actually missing is verification: unlike
    // deposit, this hasn't been exercised via `sui_devInspectTransactionBlock`
    // against a real owned CToken (none available to test with outside a live
    // position), so it stays fail-closed with a curated message until a fork/
    // device test confirms it end to end — not because of an oracle push.
    throw new DefiError(
      "withdraw_failed",
      "In-app withdrawal isn't available for Suilend yet. Withdraw at suilend.fi.",
    );
  },

  async readPosition(): Promise<DefiPosition | null> {
    // Omitted for now: NOT a Pyth blocker (corrected 2026-08-22, see the file
    // header) — a live cToken→underlying value would need a read/simulate path
    // that hasn't been written yet. The position still shows its recorded
    // deposit amount via the generic amountAtDeposit fallback (this adapter
    // just doesn't supply a live update).
    return null;
  },
};
