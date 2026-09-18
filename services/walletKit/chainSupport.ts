/**
 * Which chains the app EXPOSES, as opposed to which it can run. Every
 * `WalletKitAdapter` still boots (`bootWalletKits` registers all of them,
 * unconditionally — that invariant is untouched), and the api still
 * serves every chain; this layer decides what a user can see and pick.
 *
 * Monad Metropolis build (`FEATURE_PASSKEY_ONLY_ONBOARDING`, the same
 * switch as the passkey-only login and the AUSD agent rail): only Monad
 * mainnet (143) and Monad Testnet (10143) are surfaced — chain pickers,
 * the pay/deposit/send screens, the agent's chain context, wallet lists
 * and wallet derivation all read through here. Everything else is
 * HIDDEN, not deleted: rows on other namespaces stay in SecureStore and
 * come back the moment the flag is off.
 *
 * App-side only, deliberately. Deactivating chains on the shared api
 * would hide them from real Play Store users to make a demo look focused;
 * the judges never see the api. (Same call the Stellar-only build made —
 * `services/walletKit/chainSupport.ts` on `stellar-hackathon`.)
 *
 * With the flag off every function here is the identity: nothing is
 * filtered, so `main` behaves exactly as before.
 */

import type { TBlockchain } from "@/api/types/blockchain";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import { FEATURE_PASSKEY_ONLY_ONBOARDING } from "@/constants/configs/featureFlags";
import type { TWallet } from "@/constants/types/walletTypes";
import { resolveNamespace } from "@/hooks/useWallet.helpers";
import {
  MONAD_MAINNET_CHAIN_ID,
  MONAD_TESTNET_CHAIN_ID,
} from "@/services/chains/evm/monad";
import type { Namespace } from "@/services/chains/types";
import { walletKitRegistry } from "./registry";
import type { WalletKitAdapter } from "./types";

/** True when the app is restricted to the Monad chains. */
export const CHAIN_LOCKDOWN_ACTIVE = FEATURE_PASSKEY_ONLY_ONBOARDING;

/** EVM chain ids the locked-down app surfaces. Order = preference. */
export const LOCKDOWN_CHAIN_IDS: readonly number[] = [
  MONAD_MAINNET_CHAIN_ID,
  MONAD_TESTNET_CHAIN_ID,
];

/** The chain a locked-down app lands on when the active one is hidden. */
export const LOCKDOWN_DEFAULT_CHAIN_ID = MONAD_MAINNET_CHAIN_ID;

const LOCKDOWN_NAMESPACES: readonly Namespace[] = ["eip155"];

export function isNamespaceSupported(ns: Namespace): boolean {
  if (!CHAIN_LOCKDOWN_ACTIVE) return true;
  return LOCKDOWN_NAMESPACES.includes(ns);
}

export function isChainIdSupported(
  chainId: number | null | undefined,
): boolean {
  if (!CHAIN_LOCKDOWN_ACTIVE) return true;
  return chainId != null && LOCKDOWN_CHAIN_IDS.includes(chainId);
}

/** A `/blockchains` row the app may surface. */
export function isBlockchainSupported(row: TBlockchain): boolean {
  if (!CHAIN_LOCKDOWN_ACTIVE) return true;
  return (
    isNamespaceSupported(resolveNamespace(row)) &&
    isChainIdSupported(row.chainId)
  );
}

/** A resolved `ChainConfig` the app may act on. */
export function isChainConfigSupported(chain: ChainConfig): boolean {
  if (!CHAIN_LOCKDOWN_ACTIVE) return true;
  if (chain.namespace !== "eip155")
    return isNamespaceSupported(chain.namespace);
  return isChainIdSupported(chain.chain.id);
}

/** A wallet row the app may show. Other namespaces stay in storage. */
export function isWalletSupported(wallet: Pick<TWallet, "namespace">): boolean {
  return isNamespaceSupported(wallet.namespace);
}

/** Filters a `/blockchains` row list down to what the app surfaces. */
export function filterSupportedBlockchains(rows: TBlockchain[]): TBlockchain[] {
  if (!CHAIN_LOCKDOWN_ACTIVE) return rows;
  return rows.filter(isBlockchainSupported);
}

/** Display-only wallet filter for lists, switchers and pairings. */
export function filterSupportedWallets<T extends Pick<TWallet, "namespace">>(
  wallets: T[],
): T[] {
  if (!CHAIN_LOCKDOWN_ACTIVE) return wallets;
  return wallets.filter(isWalletSupported);
}

/** `walletKitRegistry.getAll()`, minus kits the app doesn't surface. */
export function getSupportedWalletKits(): WalletKitAdapter[] {
  const all = walletKitRegistry.getAll();
  if (!CHAIN_LOCKDOWN_ACTIVE) return all;
  return all.filter((kit) => isNamespaceSupported(kit.namespace));
}
