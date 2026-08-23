/**
 * Scallop adapter — a `DefiProtocolAdapter` for the Sui Intent Engine
 * (spec §4.4). Mirrors `solanaLst.ts` (the "supply to earn yield"
 * exemplar): `namespace:"sui"`, `chainId:"mainnet"`, `kind:"stablecoin_lending"`,
 * returning a `{ kind:"sui-ptb", transactionBlockBase64 }` UnsignedCall.
 *
 * NO SDK. We build the PTBs directly with `@mysten/sui` (the app's own v2),
 * calling Scallop's public lending contract:
 *
 *   supply   → scallop_protocol::mint::mint<T>(version, &mut market, coin, clock)
 *                → Coin<MarketCoin<T>>  (the yield-bearing receipt)
 *   withdraw → scallop_protocol::redeem::redeem<T>(version, &mut market, mCoin, clock)
 *                → Coin<T>
 *
 * The package + shared-object ids come from `scallop.config.ts`'s cached
 * address resolver (Scallop's HTTPS address API, not the SDK). This drops the
 * whole `@scallop-io/sui-scallop-sdk` → sui-kit → Pyth → axios dependency
 * graph that does not survive Hermes — there is no oracle in the supply path
 * (Scallop's docs: price updates are only for borrow/collateral), so a plain
 * supply needs none of it.
 *
 * MAINNET-ONLY: `chainId:"mainnet"` means `listDefiAdaptersForChain("sui",
 * "testnet")` resolves it nowhere — the network gate is free. Every failure
 * maps to a curated `DefiError`, never a raw RPC string (CLAUDE.md).
 */

import { toBase64 } from "@mysten/bcs";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import {
  Transaction,
  type TransactionObjectArgument,
} from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import {
  getSuiMainnetChain,
  type SuiChainConfig,
} from "@/constants/configs/chainConfig";
import { SuiSwapError } from "@/services/swap/sui/types";
import { classifySuiMoveError, DefiError } from "../errors/defiErrors";
import type {
  BuildDepositArgs,
  BuildWithdrawArgs,
  DefiPosition,
  DefiProtocolAdapter,
  PositionReadContext,
  UnsignedCall,
  ZapSupplyArgs,
  ZapSupplyResult,
} from "../types";
import { getScallopCore, resolveScallopCoin } from "./scallop.config";
import { leBytesToBigInt } from "./sui/coins";

const SLUG = "scallop-sui";
const NETWORK = "mainnet" as const;
const MINT_TARGET = "mint::mint" as const;
const REDEEM_TARGET = "redeem::redeem" as const;

function devWarn(scope: string, err: unknown): void {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn(`[scallopSui] ${scope}:`, err);
  }
}

function suiClientFor(chain: SuiChainConfig): SuiJsonRpcClient {
  return new SuiJsonRpcClient({ url: chain.rpcUrl, network: chain.network });
}

/** Native SUI in any address form (`0x2::sui::SUI` or zero-padded). */
function isNativeSui(coinType: string): boolean {
  return /^0x0*2::sui::SUI$/.test(coinType);
}

/**
 * Select + prepare the exact input coin for a deposit: native SUI is split off
 * the gas coin; any other coin is gathered (the wallet holds many small
 * `Coin<T>` objects), merged, then split — the same pattern as
 * `coinTransferService.ts`.
 */
async function prepareInputCoin(
  tx: Transaction,
  client: SuiJsonRpcClient,
  owner: string,
  coinType: string,
  amount: bigint,
): Promise<TransactionObjectArgument> {
  if (isNativeSui(coinType)) {
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
    return coin;
  }
  const { data } = await client.getCoins({ owner, coinType });
  if (!data || data.length === 0) {
    throw new DefiError("no_onchain_balance", `scallop: no ${coinType}`);
  }
  const objs = data.map((c) => tx.object(c.coinObjectId));
  const primary = objs[0];
  if (objs.length > 1) tx.mergeCoins(primary, objs.slice(1));
  const [coin] = tx.splitCoins(primary, [tx.pure.u64(amount)]);
  return coin;
}

/** Append `mint::mint<coinType>(version, market, coin, clock)` → market coin. */
function appendMint(
  tx: Transaction,
  core: { protocolPkg: string; version: string; market: string },
  coinType: string,
  depositCoin: TransactionObjectArgument,
): TransactionObjectArgument {
  const [marketCoin] = tx.moveCall({
    target: `${core.protocolPkg}::${MINT_TARGET}`,
    typeArguments: [coinType],
    arguments: [
      tx.object(core.version),
      tx.object(core.market),
      depositCoin,
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  return marketCoin;
}

/**
 * The underlying's `module::STRUCT` tail (e.g. `usdc::USDC`) — used to match
 * the wallet's `…::reserve::MarketCoin<…>` objects regardless of address
 * zero-padding or which (possibly upgraded) package minted them.
 */
function moduleStructTail(coinType: string): string {
  return coinType.split("::").slice(-2).join("::");
}

/**
 * Best-effort supply enrichment for the preview — the resolved input coinType.
 * APY is left undefined for now (Scallop's public APY feed isn't wired); the
 * preview still renders "Supply N USDC to Scallop". Never throws.
 */
export async function readScallopSupplyMeta(
  assetSymbol: string,
  _ownerAddress: string,
): Promise<{ apy?: string; inputCoinType?: string }> {
  const coin = resolveScallopCoin(assetSymbol);
  if (!coin) return {};
  return { inputCoinType: coin.coinType };
}

/**
 * Atomic swap→supply (spec §4.7, the "why Sui" hero) — MAINNET-ONLY.
 *
 * Builds ONE Programmable Transaction Block that swaps `fromAsset`→`toAsset` on
 * a DEX and supplies the resulting coin to Scallop, all-or-nothing. Both legs
 * append to the SAME `@mysten/sui` `Transaction`: the DEX swap (via the
 * injected `appendSwap`) produces an output coin, which feeds straight into
 * Scallop's `mint`, and the market coin + any swap leftovers transfer back to
 * the user. On EVM/Solana there is no atomic multi-step preview like this —
 * that is the Sui-specific advantage the Intent Engine showcases.
 */
export async function buildScallopZapSupply(
  args: ZapSupplyArgs,
): Promise<ZapSupplyResult> {
  if (args.chain.namespace !== "sui") {
    throw new DefiError("unsupported_chain", "scallop: requires sui namespace");
  }
  const coin = resolveScallopCoin(args.supplyAssetSymbol);
  if (!coin) {
    throw new DefiError(
      "unsupported_asset",
      `scallop: ${args.supplyAssetSymbol}`,
    );
  }
  try {
    const core = await getScallopCore();
    const tx = new Transaction();
    tx.setSender(args.wallet.address);

    const swap = await args.appendSwap(tx);
    if (!swap) {
      throw new DefiError("deposit_failed", "zap: swap leg unavailable");
    }

    const marketCoin = appendMint(tx, core, coin.coinType, swap.outputCoin);
    tx.transferObjects(
      [marketCoin, ...swap.leftoverCoins],
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
    devWarn("buildScallopZapSupply", err);
    throw classifySuiMoveError(err, "deposit_failed");
  }
}

export const ScallopSuiAdapter: DefiProtocolAdapter = {
  slug: SLUG,
  namespace: "sui",
  kind: "stablecoin_lending",
  chainId: NETWORK, // string id → free network gate via listDefiAdaptersForChain
  displayName: "Scallop",
  staticSafetyScore: 80,
  // DeFiLlama project slug (and shorthand) so a discovered opportunity or
  // an agent-named venue resolves to this adapter without a central map.
  externalSlugs: ["scallop-lend", "scallop"],
  // Pool-level deposits (§7): when a resolved `{ kind: "scallop-market" }`
  // target is present, read the concrete { market, coinType } from it instead
  // of resolving from the symbol. Single-market today, so this is the
  // forward-compatible hook for a future Scallop pool resolver.
  targetKinds: ["scallop-market"],
  // Optional Sui Intent Engine capabilities, presence-checked by the
  // compiler — the supply preview meta and the atomic swap→supply zap.
  readSupplyMeta: readScallopSupplyMeta,
  buildZapSupply: buildScallopZapSupply,

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
        "scallop: requires sui namespace",
      );
    }
    const coinType =
      target?.kind === "scallop-market"
        ? target.coinType
        : resolveScallopCoin(asset.symbol)?.coinType;
    if (!coinType) {
      throw new DefiError("unsupported_asset", `scallop: ${asset.symbol}`);
    }
    try {
      const core = await getScallopCore();
      const resolvedCore =
        target?.kind === "scallop-market"
          ? { ...core, market: target.market }
          : core;
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
      const marketCoin = appendMint(tx, resolvedCore, coinType, depositCoin);
      tx.transferObjects([marketCoin], tx.pure.address(wallet.address));

      const bytes = await tx.build({ client });
      return { kind: "sui-ptb", transactionBlockBase64: toBase64(bytes) };
    } catch (err) {
      if (err instanceof DefiError) throw err;
      devWarn("buildDeposit", err);
      // Classify the raw Sui build error (e.g. InsufficientCoinBalance) into a
      // curated code+reason so the agent can be specific — not a blanket
      // "deposit_failed" that reads as "venue unavailable" (agent tool-error
      // standard).
      throw classifySuiMoveError(err, "deposit_failed");
    }
  },

  async buildWithdraw({
    wallet,
    chain,
    asset,
    amount,
    target,
  }: BuildWithdrawArgs): Promise<UnsignedCall> {
    if (chain.namespace !== "sui") {
      throw new DefiError(
        "unsupported_chain",
        "scallop: requires sui namespace",
      );
    }
    const coinType =
      target?.kind === "scallop-market"
        ? target.coinType
        : resolveScallopCoin(asset.symbol)?.coinType;
    if (!coinType) {
      throw new DefiError("unsupported_asset", `scallop: ${asset.symbol}`);
    }
    // First cut: full exit only. A partial withdraw by underlying amount needs
    // the market-coin↔underlying exchange rate to split exactly; until that's
    // read on-chain we support "withdraw all" (the common path).
    if (amount !== "MAX") {
      throw new DefiError(
        "withdraw_failed",
        "scallop: partial withdraw not supported yet",
      );
    }
    try {
      const core = await getScallopCore();
      const resolvedCore =
        target?.kind === "scallop-market"
          ? { ...core, market: target.market }
          : core;
      const client = suiClientFor(chain);

      // Gather the wallet's market coins for this asset. Match on the
      // `reserve::MarketCoin<…>` wrapper + the underlying's module::STRUCT tail
      // so address zero-padding / package upgrades never hide them.
      const tail = moduleStructTail(coinType);
      const { data } = await client.getAllCoins({ owner: wallet.address });
      const marketCoins = (data ?? []).filter(
        (c) =>
          c.coinType.includes("::reserve::MarketCoin<") &&
          c.coinType.includes(`::${tail}>`),
      );
      if (marketCoins.length === 0) {
        throw new DefiError(
          "no_onchain_balance",
          "scallop: nothing to withdraw",
        );
      }

      const tx = new Transaction();
      tx.setSender(wallet.address);
      const objs = marketCoins.map((c) => tx.object(c.coinObjectId));
      const primary = objs[0];
      if (objs.length > 1) tx.mergeCoins(primary, objs.slice(1));

      const [underlying] = tx.moveCall({
        target: `${resolvedCore.protocolPkg}::${REDEEM_TARGET}`,
        typeArguments: [coinType],
        arguments: [
          tx.object(resolvedCore.version),
          tx.object(resolvedCore.market),
          primary,
          tx.object(SUI_CLOCK_OBJECT_ID),
        ],
      });
      tx.transferObjects([underlying], tx.pure.address(wallet.address));

      const bytes = await tx.build({ client });
      return { kind: "sui-ptb", transactionBlockBase64: toBase64(bytes) };
    } catch (err) {
      if (err instanceof DefiError) throw err;
      devWarn("buildWithdraw", err);
      throw classifySuiMoveError(err, "withdraw_failed");
    }
  },

  async readPosition(
    walletAddress: string,
    ctx?: PositionReadContext,
  ): Promise<DefiPosition | null> {
    // Underlying coinType from the resolved scallop-market target, else the
    // position row's asset hint (single-market venue → symbol resolves it).
    const coinType =
      ctx?.target?.kind === "scallop-market"
        ? ctx.target.coinType
        : (ctx?.assetContract ??
          resolveScallopCoin(ctx?.assetSymbol ?? "")?.coinType);
    if (!coinType) return null;
    try {
      const core = await getScallopCore();
      const market =
        ctx?.target?.kind === "scallop-market"
          ? ctx.target.market
          : core.market;
      const client = suiClientFor(getSuiMainnetChain());

      // Gather the wallet's market coins for this reserve (same match as the
      // withdraw path — MarketCoin wrapper + underlying's module::STRUCT tail).
      const tail = moduleStructTail(coinType);
      const { data } = await client.getAllCoins({ owner: walletAddress });
      const marketCoins = (data ?? []).filter(
        (c) =>
          c.coinType.includes("::reserve::MarketCoin<") &&
          c.coinType.includes(`::${tail}>`),
      );
      if (marketCoins.length === 0) return null;

      // Value = dry-run Scallop's OWN redeem and read the output coin's value —
      // uses the protocol's exchange-rate math (no reserve field-order guessing).
      const tx = new Transaction();
      tx.setSender(walletAddress);
      const objs = marketCoins.map((c) => tx.object(c.coinObjectId));
      const primary = objs[0];
      if (objs.length > 1) tx.mergeCoins(primary, objs.slice(1));
      const [underlying] = tx.moveCall({
        target: `${core.protocolPkg}::${REDEEM_TARGET}`,
        typeArguments: [coinType],
        arguments: [
          tx.object(core.version),
          tx.object(market),
          primary,
          tx.object(SUI_CLOCK_OBJECT_ID),
        ],
      });
      tx.moveCall({
        target: "0x2::coin::value",
        typeArguments: [coinType],
        arguments: [underlying],
      });
      tx.transferObjects([underlying], tx.pure.address(walletAddress));

      const res = await client.devInspectTransactionBlock({
        transactionBlock: tx,
        sender: walletAddress,
      });
      if (res.error) return null;
      // The lone u64 return is `coin::value` (redeem returns an object, which
      // devInspect doesn't surface as a decodable value).
      let amount = 0n;
      for (const r of res.results ?? []) {
        const rv = r.returnValues?.[0];
        if (rv && rv[1] === "u64") amount = leBytesToBigInt(rv[0]);
      }
      if (amount <= 0n) return null;
      return {
        protocolSlug: SLUG,
        namespace: "sui",
        chainId: NETWORK,
        assetSymbol: ctx?.assetSymbol ?? "",
        amountAtDeposit: amount,
        amountAtDepositUsd: 0,
        currentAmount: amount,
        currentAmountUsd: 0,
        pnlUsd: 0,
      };
    } catch (err) {
      devWarn("readPosition", err);
      return null;
    }
  },
};
