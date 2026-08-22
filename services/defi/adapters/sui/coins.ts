/**
 * Shared Sui coin-selection helpers for Move DeFi adapters.
 *
 * Every Sui deposit/withdraw adapter faces the same chore: turn a raw `u64`
 * amount into a single `Coin<T>` argument, where a wallet holds many small
 * `Coin<T>` objects and native SUI must be split off the gas coin. This is the
 * one genuinely reusable slice across Sui venues (Scallop keeps its own inline
 * copy for now; Ember and later venues share this). No SDK — plain
 * `@mysten/sui` PTB building, mirroring `coinTransferService.ts`.
 */

import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import {
  type Transaction,
  type TransactionObjectArgument,
} from "@mysten/sui/transactions";
import { DefiError } from "../../errors/defiErrors";

/** Native SUI in any address form (`0x2::sui::SUI` or zero-padded). */
export function isNativeSui(coinType: string): boolean {
  return /^0x0*2::sui::SUI$/.test(coinType);
}

/**
 * Normalise a Move type/coin-type string for containment/equality checks:
 * lowercase and collapse leading address zeros, so `0x2::sui::SUI` matches
 * `0x000…0002::sui::SUI`. Mirrors the API's `sui-rpc.ts` twin exactly (kept
 * as a separate copy, not a shared package, same as every other Sui
 * primitive duplicated across the two repos here).
 */
export function normSuiType(s: string): string {
  return s.toLowerCase().replace(/0x0+/g, "0x");
}

/** Compare two Sui coin types tolerating address zero-padding + struct casing. */
export function eqSuiCoinType(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return normSuiType(a) === normSuiType(b);
}

/**
 * Decode a little-endian BCS unsigned integer (u64/u128/u256) from a
 * `devInspect` return-value byte array into a bigint. Width-agnostic — the loop
 * folds however many bytes the getter returned, so it serves u64 shares/amounts
 * and u256 balances alike.
 */
export function leBytesToBigInt(bytes: ArrayLike<number>): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

/**
 * The underlying's `module::STRUCT` tail (e.g. `usdc::USDC`) — used to match a
 * wallet's coin objects regardless of address zero-padding or which (possibly
 * upgraded) package minted them.
 */
export function moduleStructTail(coinType: string): string {
  return coinType.split("::").slice(-2).join("::");
}

/**
 * Select + prepare the exact input coin for a deposit: native SUI is split off
 * the gas coin; any other coin is gathered (the wallet holds many small
 * `Coin<T>` objects), merged, then split to the exact `amount`.
 */
export async function prepareInputCoin(
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
    throw new DefiError("no_onchain_balance", `no ${coinType}`);
  }
  const objs = data.map((c) => tx.object(c.coinObjectId));
  const primary = objs[0];
  if (objs.length > 1) tx.mergeCoins(primary, objs.slice(1));
  const [coin] = tx.splitCoins(primary, [tx.pure.u64(amount)]);
  return coin;
}

/**
 * Gather ALL of the owner's `Coin<coinType>` objects into one merged coin
 * argument (for a full-balance / MAX exit). Returns `null` when the wallet
 * holds none — the caller maps that to `no_onchain_balance`.
 */
export async function gatherAllCoins(
  tx: Transaction,
  client: SuiJsonRpcClient,
  owner: string,
  coinType: string,
): Promise<TransactionObjectArgument | null> {
  const { data } = await client.getCoins({ owner, coinType });
  if (!data || data.length === 0) return null;
  const objs = data.map((c) => tx.object(c.coinObjectId));
  const primary = objs[0];
  if (objs.length > 1) tx.mergeCoins(primary, objs.slice(1));
  return primary;
}
