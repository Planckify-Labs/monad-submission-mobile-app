/**
 * Pure helpers extracted from `useWallet` so they can be exercised by
 * node test runner without pulling in react / react-native / expo.
 *
 * Per spec §7.5, `changeActiveChainInternal` owns the one allowed
 * namespace `if` in this layer because it's mapping backend
 * `TBlockchain` rows to the `ChainConfig` discriminated union. That's
 * data-shape translation, not behavior dispatch — dispatch belongs to
 * `WalletKitAdapter`.
 */

import type { TBlockchain } from "@/api/types/blockchain";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import type { Namespace } from "@/services/chains/types";
import { registerProxyOrigin } from "@/services/rpc/proxyAuth";

/**
 * `TBlockchain` may gain a `namespace` field in a future API revision.
 * Until then we infer the namespace from `isEVM` + (when available) the
 * unique `chainSlug` and a `name`/`rpcUrl` fallback heuristic — Solana
 * was the only non-EVM chain in v2.3.0, but Sui rows now ride the same
 * `isEVM: false` flag so we MUST disambiguate before they collide on
 * the same chain-config key.
 */
type BlockchainWithMaybeNamespace = TBlockchain & {
  namespace?: "eip155" | "solana" | "sui" | "stellar";
  chainSlug?: string | null;
};

export function resolveNamespace(
  b: BlockchainWithMaybeNamespace,
): "eip155" | "solana" | "sui" | "stellar" {
  if (b.namespace === "sui") return "sui";
  if (b.namespace === "solana") return "solana";
  if (b.namespace === "stellar") return "stellar";
  if (b.namespace === "eip155") return "eip155";

  // Authoritative slug check (preferred path; backend exposes `chainSlug`
  // for non-EVM rows).
  if (typeof b.chainSlug === "string") {
    if (b.chainSlug.startsWith("sui-")) return "sui";
    if (b.chainSlug.startsWith("solana-")) return "solana";
    if (b.chainSlug.startsWith("stellar-")) return "stellar";
  }

  // Heuristic fallback for backends that don't yet emit `chainSlug` —
  // matches by name prefix or RPC host. This keeps the picker correct
  // even before the API revision lands.
  const name = (b.name ?? "").toLowerCase();
  const rpc = (b.rpcUrl ?? "").toLowerCase();
  if (b.isEVM === false) {
    if (name.startsWith("sui") || rpc.includes("sui.io")) return "sui";
    if (name.startsWith("stellar") || rpc.includes("stellar.org")) {
      return "stellar";
    }
    return "solana";
  }
  return "eip155";
}

/**
 * Produces a stable discriminator string for a `ChainConfig` suitable
 * for use as a React Query cache key fragment. Reads the discriminant
 * of the union (namespace-specific field) without requiring callers to
 * `switch` on `namespace` inline — the single namespace branch lives
 * here, mirroring the §7.5 "data-shape mapping" exception used by
 * `buildChainConfigFromBlockchain`.
 */
/**
 * An "account" is a set of TWallet rows derived from the same BIP-39
 * mnemonic. Each row inside represents a single namespace (EVM, Solana,
 * …). Private-key imports have no shared seed, so they collapse to a
 * single-row account keyed by their address.
 *
 * The rest of the UI treats accounts — not individual wallet rows — as
 * the unit a user selects. The active wallet row within a selected
 * account is derived from the active chain's namespace (`walletFor`).
 */
export type WalletAccount = {
  /** Stable key for React lists. Derived from the first wallet's address. */
  id: string;
  /** Display name with per-namespace suffixes stripped (e.g. "Main Wallet"). */
  name: string;
  /** Rows that belong to this account, in insertion order (EVM → Solana). */
  wallets: TWallet[];
};

// Strip namespace-specific suffixes added by `defaultWalletNameFor`
// (e.g. "Main Wallet · ETH" → "Main Wallet"). Falls back to the
// original name when no known suffix is present.
function canonicalAccountName(name: string): string {
  return (
    name.replace(/\s*[·•|-]\s*(ETH|SOL|SOLANA|ETHEREUM)\s*$/i, "").trim() ||
    name
  );
}

/**
 * Groups a flat wallet list into accounts. Wallets sharing a
 * `seedGroupId` collapse into one account; non-seeded wallets (private-
 * key imports) each form a single-row account keyed by their address.
 * Input order is preserved.
 *
 * TWV-2026-057 Tier 1 — this used to key the map by the raw mnemonic
 * (`w.seedPhrase`), which is the reason the plaintext seed had to live
 * in React state at all. `seedGroupId` is a salted keyed hash assigned
 * by the wallet service and carries no key material.
 */
export function groupWalletsIntoAccounts(wallets: TWallet[]): WalletAccount[] {
  const accountsBySeed = new Map<string, WalletAccount>();
  const accountOrder: string[] = [];
  const accountsById = new Map<string, WalletAccount>();

  for (const w of wallets) {
    const seed =
      typeof w.seedGroupId === "string" && w.seedGroupId.length > 0
        ? w.seedGroupId
        : null;
    if (seed) {
      const existing = accountsBySeed.get(seed);
      if (existing) {
        existing.wallets.push(w);
        continue;
      }
      const id = w.address;
      const account: WalletAccount = {
        id,
        name: canonicalAccountName(w.name || "Wallet"),
        wallets: [w],
      };
      accountsBySeed.set(seed, account);
      accountsById.set(id, account);
      accountOrder.push(id);
      continue;
    }
    // No seed → its own single-row account.
    const id = w.address;
    const account: WalletAccount = {
      id,
      name: canonicalAccountName(w.name || "Wallet"),
      wallets: [w],
    };
    accountsById.set(id, account);
    accountOrder.push(id);
  }

  return accountOrder
    .map((id) => accountsById.get(id))
    .filter((a): a is WalletAccount => !!a);
}

/**
 * Finds the wallet row inside `account` that matches `namespace`. Falls
 * back to the first row when no exact match exists — relevant for
 * private-key imports whose namespace may not match the active chain.
 */
export function walletForNamespace(
  account: WalletAccount,
  namespace: Namespace,
): TWallet {
  return (
    account.wallets.find((w) => w.namespace === namespace) ?? account.wallets[0]
  );
}

/**
 * Given a flat wallet list and an account id, returns the row that
 * represents the account's active selection for the given namespace.
 * Used by `setActiveAccount` to translate an account click into the
 * correct `TWallet` index.
 */
export function walletIndexForAccountAndNamespace(
  wallets: TWallet[],
  accountId: string,
  namespace: Namespace,
): number {
  const accounts = groupWalletsIntoAccounts(wallets);
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return -1;
  const target = walletForNamespace(account, namespace);
  return wallets.findIndex((w) => w.address === target.address);
}

export function chainCacheKey(chain: ChainConfig): string {
  if (chain.namespace === "eip155") {
    return `eip155:${chain.chain.id}`;
  }
  if (chain.namespace === "solana") {
    return `solana:${chain.cluster}`;
  }
  if (chain.namespace === "stellar") {
    return `stellar:${chain.network}`;
  }
  return `sui:${chain.network}`;
}

export function buildChainConfigFromBlockchain(
  blockchain: TBlockchain,
): ChainConfig {
  const b = blockchain as BlockchainWithMaybeNamespace;
  const namespace = resolveNamespace(b);

  // `rpcUrl` from the backend feed IS the rpc-proxy endpoint, so this is where
  // we learn which origin our proxy key may be sent to. Registering here (rather
  // than hardcoding an origin) keeps the app correct when the proxy moves
  // between localhost, a LAN IP, and a production domain.
  registerProxyOrigin(b.rpcUrl);

  if (namespace === "solana") {
    const lowerName = b.name.toLowerCase();
    const lowerRpc = b.rpcUrl.toLowerCase();
    const isDevnet =
      lowerName.includes("devnet") || lowerRpc.includes("devnet");
    const cluster: "mainnet-beta" | "devnet" =
      b.isTestnet || isDevnet ? "devnet" : "mainnet-beta";
    return {
      namespace: "solana",
      cluster,
      rpcUrl: b.rpcUrl,
      iconUrl:
        (b.tokens?.find((t) => t.isNativeCurrency) ?? b.tokens?.[0])?.logoUrl ??
        undefined,
      isTestnet: b.isTestnet ?? isDevnet,
      smartContracts: b.smartContracts,
    };
  }

  if (namespace === "sui") {
    // Simple fallback: backend doesn't yet expose a `network` field, so
    // mirror the Solana approach and infer testnet/mainnet from the
    // `isTestnet` flag. Devnet rows would need an explicit signal from
    // the backend feed (revisit when SuiWalletKit lands in task 08).
    const network: "mainnet" | "testnet" | "devnet" = b.isTestnet
      ? "testnet"
      : "mainnet";
    return {
      namespace: "sui",
      network,
      rpcUrl: b.rpcUrl,
      iconUrl:
        (b.tokens?.find((t) => t.isNativeCurrency) ?? b.tokens?.[0])?.logoUrl ??
        undefined,
      isTestnet: b.isTestnet ?? false,
      smartContracts: b.smartContracts,
    };
  }

  if (namespace === "stellar") {
    // The backend's generic `rpcUrl` column now carries the **Soroban RPC**
    // endpoint for Stellar rows — the endpoint the API itself calls for
    // `takumi_pay` contract reads — NOT the Horizon endpoint this app's
    // classic wallet kit (balances / transfers / trustlines, spec §0/§3.6)
    // needs. (It used to hold Horizon; the API repurposed the column when it
    // dropped its dedicated Soroban field.) Horizon needs no per-provider key
    // and has canonical public endpoints per network, so we derive it here
    // rather than trusting the feed — same "hardcode a public per-network
    // Horizon endpoint" posture `resolveStellarChainConfigForPassphrase` and
    // the static `supportedChains` mainnet entry already use.
    const network: "mainnet" | "testnet" = b.isTestnet ? "testnet" : "mainnet";
    const horizonUrl =
      network === "testnet"
        ? "https://horizon-testnet.stellar.org"
        : "https://horizon.stellar.org";
    // Populate the reserved Soroban slot only when the feed actually gives a
    // Soroban endpoint. `stellar-mainnet` still serves a Horizon URL in
    // `rpcUrl` (no Soroban mainnet deployment yet) — don't mislabel that as
    // Soroban; leave it undefined until a real Soroban mainnet URL lands.
    const sorobanRpcUrl = b.rpcUrl.toLowerCase().includes("soroban")
      ? b.rpcUrl
      : undefined;
    return {
      namespace: "stellar",
      network,
      horizonUrl,
      rpcUrl: sorobanRpcUrl,
      iconUrl:
        (b.tokens?.find((t) => t.isNativeCurrency) ?? b.tokens?.[0])?.logoUrl ??
        undefined,
      isTestnet: b.isTestnet ?? false,
      smartContracts: b.smartContracts,
    };
  }

  // Prefer an explicitly-flagged native token; fall back to the first
  // token the backend emitted. A blockchain with zero tokens is rare
  // but valid (freshly-added chain, indexer behind) — the fallbacks
  // below keep the ChainConfig renderable without lying about EVM
  // specifics ("Ether" / "ETH" on a Polygon row).
  const nativeToken =
    b.tokens?.find((t) => t.isNativeCurrency) ?? b.tokens?.[0];
  return {
    namespace: "eip155",
    chain: {
      // Backend `chainId` may be null for non-EVM rows. By the time
      // this branch runs we've already narrowed to EVM via
      // `resolveNamespace`, so a null here is a backend data error —
      // fall back to 0 so viem's types stay satisfied and the error
      // surfaces downstream instead of crashing this helper.
      id: b.chainId ?? 0,
      name: b.name,
      nativeCurrency: {
        name: nativeToken?.name ?? b.name,
        symbol: nativeToken?.symbol ?? "N/A",
        decimals: nativeToken?.decimals ?? 18,
      },
      rpcUrls: {
        default: { http: [b.rpcUrl] },
        public: { http: [b.rpcUrl] },
      },
      blockExplorers: b.blockExplorer
        ? {
            default: {
              name: b.name,
              url: b.blockExplorer,
            },
          }
        : undefined,
    },
    iconUrl: nativeToken?.logoUrl ?? undefined,
    isTestnet:
      b.name.toLowerCase().includes("testnet") ||
      b.name.toLowerCase().includes("sepolia") ||
      b.name.toLowerCase().includes("goerli"),
    smartContracts: b.smartContracts,
  };
}
