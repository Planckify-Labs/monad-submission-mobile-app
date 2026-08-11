/**
 * Copy for the "you don't hold a wallet on this chain yet" state.
 *
 * Centralised for two reasons. First, this string appears on at least
 * four unrelated surfaces (chain switcher, agent tool cards, dApp
 * connect sheet, bridge failures) and they drifted apart when each one
 * wrote its own. Second, chain display names come from the wallet-kit
 * registry rather than a local map, so docking a fifth chain needs no
 * edit here and no edit in any consumer.
 *
 * Deliberately NOT a React component: the dApp `ConnectSheet` needs the
 * bare strings for its own layout, while list surfaces want the shared
 * `MissingWalletNotice`. Both read from here so the wording matches.
 */

import type { Namespace } from "@/services/chains/types";
import { walletKitRegistry } from "@/services/walletKit/registry";

export type MissingWalletCopy = {
  /** Chain display name on its own, for inline use. */
  chainName: string;
  /** Headline: states the gap. */
  title: string;
  /** One line on what adding a wallet unlocks. */
  body: string;
  /** Button label. */
  cta: string;
};

/**
 * `walletKitRegistry.get` throws for an unregistered namespace by
 * design. A missing-wallet notice is a dead end for the user either
 * way, so fall back to the raw namespace rather than crashing the
 * surface that was trying to explain the problem.
 */
function displayNameFor(namespace: Namespace): string {
  try {
    return walletKitRegistry.get(namespace).displayName ?? namespace;
  } catch {
    return namespace;
  }
}

export function missingWalletCopy(namespace: Namespace): MissingWalletCopy {
  const chainName = displayNameFor(namespace);
  return {
    chainName,
    title: `No ${chainName} wallet yet`,
    body: `Add one to use ${chainName} in the app.`,
    cta: `Add ${chainName} wallet`,
  };
}
