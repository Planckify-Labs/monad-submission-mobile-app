/**
 * EIP-747 `wallet_watchAsset` — the store behind the approval.
 *
 * Until this existed, `execWatchAsset` called an `onWatchAsset` hook
 * that **nothing ever wired**, then returned `true`. So a dApp asked us
 * to track a token, the user approved it on a sheet, and we told the
 * dApp "added" having done nothing at all. That is worse than not
 * supporting the method: a wallet that answers `false` (or throws) lets
 * the dApp tell the user to add the token manually, while a wallet that
 * answers `true` sends them looking for a token that will never appear.
 *
 * The app has no user-managed token list yet, so this is deliberately
 * scoped to being the durable record that list will read. It does the
 * part that must not be faked — recording what the user actually agreed
 * to, and answering the dApp honestly about whether we did — and stops
 * short of inventing a balances UI.
 *
 * ### What is recorded, and what is not trusted
 *
 * Everything here is **dApp-supplied**: the symbol, the decimals, the
 * image. A site can call a token "USDC" with 6 decimals and point at any
 * contract it likes. So the address is the identity (that is what the
 * key is built from) and the rest is a label. Any future UI reading this
 * must show the contract address alongside the symbol for the same
 * reason `CounterpartyLabel` always shows the address next to an ENS
 * name: a name the user did not choose is a hint, not a fact.
 *
 * `addedBy` exists for the same reason. When a token turns out to be
 * hostile, "which site asked for this" is the first question, and it
 * cannot be reconstructed later.
 */

import { storage } from "@/lib/storage/mmkv";
import type { EvmWatchAssetPayload } from "@/services/chains/evm/payloads";

const STORAGE_KEY = "wallet.watchedAssets.v1";

export interface WatchedAsset {
  /** CAIP-2-ish chain scope. Kept numeric for EVM. */
  chainId: number;
  address: string;
  standard: "ERC20" | "ERC721" | "ERC1155";
  /** dApp-supplied. Display only, never an identity. */
  symbol?: string;
  /** dApp-supplied. Absent for NFTs. */
  decimals?: number;
  image?: string;
  /** Present for ERC-721 / ERC-1155. */
  tokenId?: string;
  /** Origin that requested it, for after-the-fact attribution. */
  addedBy: string;
  addedAt: number;
}

/** Chain + address is the identity; the rest is a label the site chose. */
function keyOf(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

function readAll(): Record<string, WatchedAsset> {
  try {
    const raw = storage.getString(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, WatchedAsset>;
  } catch (e) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn("[watchedAssets] read failed", e);
    }
    return {};
  }
}

function writeAll(map: Record<string, WatchedAsset>): boolean {
  try {
    storage.set(STORAGE_KEY, JSON.stringify(map));
    return true;
  } catch (e) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn("[watchedAssets] write failed", e);
    }
    return false;
  }
}

/**
 * Record an approved `wallet_watchAsset`.
 *
 * Returns whether it was actually persisted, and the caller must return
 * that to the dApp rather than a hardcoded `true`. A storage failure
 * that reports success is the exact dishonesty this module replaces.
 *
 * Re-watching an asset updates its label but keeps the original
 * `addedAt` and `addedBy`: the interesting fact is who introduced it,
 * not who mentioned it most recently.
 */
export function addWatchedAsset(
  payload: EvmWatchAssetPayload,
  origin: string,
): boolean {
  const map = readAll();
  const key = keyOf(payload.chainId, payload.address);
  const existing = map[key];
  map[key] = {
    chainId: payload.chainId,
    address: payload.address.toLowerCase(),
    standard: payload.standard,
    symbol: payload.symbol,
    decimals: payload.standard === "ERC20" ? payload.decimals : undefined,
    image: payload.image,
    tokenId: payload.standard === "ERC20" ? undefined : payload.tokenId,
    addedBy: existing?.addedBy ?? origin,
    addedAt: existing?.addedAt ?? Date.now(),
  };
  return writeAll(map);
}

/** Everything the user has agreed to track, newest first. */
export function listWatchedAssets(chainId?: number): WatchedAsset[] {
  return Object.values(readAll())
    .filter((a) => chainId === undefined || a.chainId === chainId)
    .sort((a, b) => b.addedAt - a.addedAt);
}

export function isWatchedAsset(chainId: number, address: string): boolean {
  return keyOf(chainId, address) in readAll();
}

/** Removal is the user's, not the dApp's: EIP-747 has no un-watch. */
export function removeWatchedAsset(chainId: number, address: string): boolean {
  const map = readAll();
  const key = keyOf(chainId, address);
  if (!(key in map)) return false;
  delete map[key];
  return writeAll(map);
}

/** Test seam. */
export function __clearWatchedAssets(): void {
  writeAll({});
}
