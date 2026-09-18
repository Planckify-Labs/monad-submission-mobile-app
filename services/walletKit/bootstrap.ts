/**
 * `bootstrapFirstLoginWallets` — auto-mint one `TWallet` per registered
 * kit from a single BIP-39 mnemonic.
 *
 * Per spec §14.3 / §14.6 / F7:
 *   - Called by the login success-path (Task 18) when
 *     `loadWalletsFromStorage()` returns zero wallets, BEFORE
 *     `router.replace("/")` resolves so home has something to render.
 *   - One mnemonic for N wallets. Every returned wallet shares the
 *     same `seedPhrase`. Future §10 `derivationGroupId` linkage (F7)
 *     is not introduced here.
 *   - CSPRNG-only — the mnemonic comes from `generateWalletMnemonic`
 *     (TWV-2026-002). This module does not generate its own entropy.
 *   - Namespace list is pulled from the registry so Sui / Bitcoin kits
 *     register→auto-mint automatically once they land (§14.3 last
 *     bullet). No hard-coded namespaces.
 *   - Idempotent caller contract: this function returns wallets; the
 *     caller (Task 18) decides when / whether to persist via
 *     `walletService.saveWalletsToStorage`.
 *   - No mnemonic display / logging — the auto-mint mnemonic is only
 *     revealed via the settings-flow verify-words step (Task 26 /
 *     future).
 */

import type { TWallet } from "@/constants/types/walletTypes";
import type { Namespace } from "@/services/chains/types";
import { generateWalletMnemonic } from "@/services/walletService";
import { getSupportedWalletKits } from "./chainSupport";
import { deriveWalletsFromMnemonic } from "./deriveAll";

/**
 * Default name applied to each auto-minted wallet. Keeps the UI stable
 * across namespaces ("Main Wallet · ETH" / "Main Wallet · SOL" /
 * "Main Wallet · SUI"). Future namespaces fall back to an uppercase
 * namespace tag until they're added explicitly.
 *
 * Note: the fallback `ns.toUpperCase()` would already produce
 * `"Main Wallet · SUI"` for `ns === "sui"`, but the explicit branch
 * makes the supported set obvious to reviewers and gives us a single
 * place to tweak the Sui label if product copy ever diverges from the
 * other chains.
 */
export function walletNameFor(prefix: string, ns: Namespace): string {
  const label =
    ns === "eip155"
      ? "ETH"
      : ns === "solana"
        ? "SOL"
        : ns === "sui"
          ? "SUI"
          : (ns as string).toUpperCase();
  return `${prefix} · ${label}`;
}

export function defaultWalletNameFor(ns: Namespace): string {
  return walletNameFor("Main Wallet", ns);
}

/**
 * `namePrefix` names the minted wallets ("<prefix> · ETH"). Defaults to
 * "Main Wallet"; the Google sign-in path passes the account's name so a device
 * with several Google accounts' wallets stays legible.
 */
export async function bootstrapFirstLoginWallets(
  namePrefix = "Main Wallet",
): Promise<TWallet[]> {
  const mnemonic = generateWalletMnemonic(128);
  const namespaces = getSupportedWalletKits().map((k) => k.namespace);
  return deriveWalletsFromMnemonic(mnemonic, namespaces, (ns) =>
    walletNameFor(namePrefix, ns),
  );
}

/**
 * Re-derives the same wallet set from a mnemonic the user already owns —
 * recovered from an encrypted Drive backup, or typed in from their written-down
 * seed phrase.
 *
 * Identical to {@link bootstrapFirstLoginWallets} except that the entropy comes
 * from the caller rather than the CSPRNG, so a restore on a new device
 * reproduces the *same* addresses on every registered chain.
 */
export async function restoreWalletsFromMnemonic(
  mnemonic: string,
  namePrefix = "Main Wallet",
): Promise<TWallet[]> {
  const namespaces = getSupportedWalletKits().map((k) => k.namespace);
  return deriveWalletsFromMnemonic(mnemonic, namespaces, (ns) =>
    walletNameFor(namePrefix, ns),
  );
}
