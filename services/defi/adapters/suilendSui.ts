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
 * market phantom `<pkg>::suilend::MAIN_POOL`; the moveCall package is DERIVED
 * from it, so the target is fully self-contained (no config file).
 *
 * SCOPE (deposit-only, 2026-07-03): deposit + the atomic swap→supply zap are
 * in-app. WITHDRAW is intentionally NOT wired: Suilend's
 * `redeem_ctokens_and_withdraw_liquidity` aborts unless the reserve price was
 * refreshed in-tx, and the on-chain Pyth `PriceInfoObject` is a PULL oracle
 * (often minutes stale) → a reliable redeem needs a full Pyth/Wormhole VAA push
 * (Hermes → verify → update → refresh → redeem), the dependency the codebase
 * deliberately dropped for Scallop. Until that lands, `buildWithdraw` fails
 * closed with a curated "withdraw on site" message and `readPosition` returns
 * null. MAINNET-ONLY (`chainId:"mainnet"`).
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

/** The moveCall package = the address that owns the `MAIN_POOL` phantom type. */
function packageOf(marketType: string): string {
  const pkg = marketType.split("::")[0];
  if (!/^0x[0-9a-fA-F]+$/.test(pkg)) {
    throw new DefiError("deposit_failed", "suilend: malformed market type");
  }
  return pkg;
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
    const pkg = packageOf(marketType);
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

    const bytes = await tx.build({ client: suiClientFor(args.chain) });
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
      const pkg = packageOf(marketType);
      const client = suiClientFor(chain);
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
      //   clock, coin) -> Coin<CToken<P,T>>. No oracle needed on the mint path.
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
    // Deferred: Suilend's redeem requires a fresh Pyth price pushed in-tx (the
    // on-chain PriceInfoObject is a pull oracle, often stale). Until the
    // Pyth/Wormhole push lands, fail closed with a curated message so the user
    // is told to withdraw on-site rather than shown a confusing on-chain abort.
    throw new DefiError(
      "withdraw_failed",
      "In-app withdrawal isn't available for Suilend yet. Withdraw at suilend.fi.",
    );
  },

  async readPosition(): Promise<DefiPosition | null> {
    // Omitted for now: a live cToken→underlying value via simulate-redeem needs
    // the same fresh-price refresh the withdraw path does (aborts otherwise), so
    // the position shows its recorded deposit amount until the Pyth push lands.
    return null;
  },
};
