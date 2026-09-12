/**
 * Wallet binding for deep-link requests — spec §4.7.
 *
 * Deep-link requests do not have a "current" wallet. In order:
 *   1. namespace presence (`services/walletPresence`),
 *   2. protocol-pinned account (SEP-0007 `pubkey`, Phantom session key…),
 *   3. prior grant / session (Class C, resolved by the adapters),
 *   4. otherwise the user picks, defaulting to the most recently used
 *      wallet for that namespace,
 *   5. `intent.wallet` is the bound wallet, full stop.
 *
 * Nothing here reads the home-screen active wallet
 * (`feedback_dapp_bridge_isolation`).
 */

import type { TWallet } from "@/constants/types/walletTypes";
import type { Namespace } from "@/services/chains/types";
import { addressesEqual } from "@/services/walletKit/chainInfo";
import {
  getWalletForNamespace,
  resolveNamespaceAccess,
} from "@/services/walletPresence";
import type { DeepLinkRejectCode } from "./types";

export type WalletBinding =
  | { kind: "bound"; wallet: TWallet }
  | { kind: "pick"; candidates: TWallet[]; defaultWallet: TWallet }
  | { kind: "reject"; code: DeepLinkRejectCode };

export function bindWallet(args: {
  namespace: Namespace;
  wallets: TWallet[];
  pinnedAccount?: string;
  /** Account id / address of the wallet last used on this namespace. */
  preferredAccountId?: string;
}): WalletBinding {
  const { namespace, wallets, pinnedAccount, preferredAccountId } = args;

  const access = resolveNamespaceAccess({
    wallets,
    activeWallet: null,
    namespace,
    role: "counterparty",
    preferredAccountId,
  });
  if (!access.ok) return { kind: "reject", code: "no_wallet_for_namespace" };

  const candidates = wallets.filter((w) => w.namespace === namespace);
  if (candidates.length === 0) {
    return { kind: "reject", code: "no_wallet_for_namespace" };
  }

  if (pinnedAccount) {
    const match = candidates.find((w) =>
      addressesEqual(namespace, w.address, pinnedAccount),
    );
    if (!match) return { kind: "reject", code: "wrong_account" };
    return { kind: "bound", wallet: match };
  }

  if (candidates.length === 1) return { kind: "bound", wallet: candidates[0] };

  const defaultWallet =
    getWalletForNamespace(wallets, namespace, preferredAccountId) ??
    candidates[0];
  return { kind: "pick", candidates, defaultWallet };
}
