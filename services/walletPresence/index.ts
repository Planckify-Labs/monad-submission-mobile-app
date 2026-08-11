/**
 * Wallet-namespace access layer (Layer 0).
 *
 * One question gets asked all over this app — "can the user act on
 * namespace X?" — and before this module it was answered ad hoc in a
 * dozen places with three different rules and no shared vocabulary. The
 * damage showed up as: a chain switcher that let a private-key-only EVM
 * user select Sui (desyncing `activeChain` from `activeWallet` with no
 * recovery path), agent yield cards offering deposits into chains the
 * user has no key for, and "That isn't available on this network yet."
 * shown for a chain that is perfectly available — the user just doesn't
 * own a wallet on it.
 *
 * The reason a single boolean was never enough: a namespace plays FOUR
 * different roles depending on what's being asked, and each role has a
 * different correct answer.
 *
 *   - `active`       — the tool acts as / on the wallet currently on
 *                      screen. For writes this is load-bearing beyond
 *                      convenience: substituting a different owned wallet
 *                      is the exact bug class
 *                      `feedback_dapp_bridge_isolation` forbids, because
 *                      what the user sees must be what signs. Owning a Sui
 *                      wallet does NOT authorise signing with it while an
 *                      EVM wallet is displayed.
 *   - `counterparty` — a destination / receive address. Any OWNED wallet
 *                      on that namespace is valid; it never signs, so the
 *                      active-wallet constraint does not apply. Demanding
 *                      "active" here is a bug (it blocked seed-phrase
 *                      users from bridging to chains they own).
 *   - `discovery`    — listing, filtering, labelling. Ownership is
 *                      advisory: report it, never hard-fail on it.
 *   - `agnostic`     — never touches a namespace at all.
 *
 * Conflating `active` and `counterparty` is the root bug this module
 * exists to make unrepresentable. Callers name the role; the rule
 * follows from the role.
 *
 * This module is deliberately pure (no react, react-native, or expo
 * imports) so the node test runner and vitest can both exercise it
 * without the RN stubbing harness.
 */

import type { TWallet } from "@/constants/types/walletTypes";
import { groupWalletsIntoAccounts } from "@/hooks/useWallet.helpers";
import type { Namespace } from "@/services/chains/types";

export type NamespaceRole =
  | "active"
  | "counterparty"
  | "discovery"
  | "agnostic";

/**
 * Result of an access question.
 *
 * The `not_active` / `not_owned` split is load-bearing, not cosmetic:
 * it is the difference between "switch your wallet" and "you need to
 * create one first". Collapsing them is why the app used to tell users a
 * chain was unsupported when the chain was fine.
 */
export type NamespaceAccess =
  /** A usable wallet was resolved for this role. */
  | { ok: true; wallet: TWallet }
  /** Discovery only: nothing owned here, but that is not a failure. */
  | { ok: true; wallet: null }
  /** Owned, but not the active wallet, and the role requires active. */
  | { ok: false; code: "not_active"; owned: TWallet }
  /** No wallet on this namespace exists on the device at all. */
  | { ok: false; code: "not_owned" };

/** Does the device hold any wallet on this namespace? */
export function hasWalletForNamespace(
  wallets: TWallet[],
  namespace: Namespace,
): boolean {
  return wallets.some((w) => w.namespace === namespace);
}

/**
 * The user's own wallet on `namespace`, preferring one derived from the
 * same account (mnemonic) as `preferredAccountId` before falling back to
 * any other wallet on that namespace.
 *
 * The account preference matters for cross-chain destinations: bridging
 * Base → Solana should land in the Solana wallet derived from the SAME
 * seed the user is sending from, not an unrelated imported one that
 * happens to sort first.
 *
 * Note this checks `namespace` explicitly rather than delegating to
 * `walletForNamespace`, whose any-row fallback would happily return a
 * wrong-namespace wallet for a private-key-only account.
 */
export function getWalletForNamespace(
  wallets: TWallet[],
  namespace: Namespace,
  preferredAccountId?: string,
): TWallet | undefined {
  if (preferredAccountId) {
    const account = groupWalletsIntoAccounts(wallets).find(
      (a) =>
        a.id === preferredAccountId ||
        a.wallets.some((w) => w.address === preferredAccountId),
    );
    const sameAccount = account?.wallets.find((w) => w.namespace === namespace);
    if (sameAccount) return sameAccount;
  }
  return wallets.find((w) => w.namespace === namespace);
}

/** Every namespace the device holds at least one wallet on. */
export function ownedNamespaces(wallets: TWallet[]): Namespace[] {
  const seen = new Set<Namespace>();
  for (const w of wallets) {
    if (w.namespace) seen.add(w.namespace);
  }
  return Array.from(seen);
}

/**
 * The one entry point. Answers "can the user act on `namespace` in this
 * `role`?" and, when yes, hands back the wallet to act with.
 *
 * `preferredAccountId` may be either a `WalletAccount.id` or any wallet
 * address belonging to the account — callers usually have the latter
 * (e.g. the source wallet of a bridge) and should not have to group
 * wallets themselves just to ask.
 */
export function resolveNamespaceAccess(args: {
  wallets: TWallet[];
  activeWallet: TWallet | null;
  namespace: Namespace;
  role: NamespaceRole;
  preferredAccountId?: string;
}): NamespaceAccess {
  const { wallets, activeWallet, namespace, role, preferredAccountId } = args;

  // Nothing to check — the caller told us this action has no namespace
  // dimension. Report the active wallet if there is one so `agnostic`
  // callers can still use the return shape uniformly.
  if (role === "agnostic") {
    return activeWallet
      ? { ok: true, wallet: activeWallet }
      : { ok: true, wallet: null };
  }

  const owned = getWalletForNamespace(wallets, namespace, preferredAccountId);

  if (role === "discovery") {
    // Advisory only. Absence is information, never an error — a user with
    // no Sui wallet should still be able to SEE Sui yield opportunities,
    // they just can't act on them in-app yet.
    return { ok: true, wallet: owned ?? null };
  }

  if (!owned) return { ok: false, code: "not_owned" };

  if (role === "active") {
    // Binds to what the user is looking at. Owning a wallet on this
    // namespace is necessary but NOT sufficient.
    if (activeWallet && activeWallet.namespace === namespace) {
      return { ok: true, wallet: activeWallet };
    }
    return { ok: false, code: "not_active", owned };
  }

  // counterparty — never signs, so any owned wallet is legitimate.
  return { ok: true, wallet: owned };
}
