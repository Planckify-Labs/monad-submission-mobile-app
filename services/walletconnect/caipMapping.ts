/**
 * CAIP-2 namespace mapping for WalletConnect v2.
 * Extensible: adding Solana / Sui is one entry.
 */

import type { Namespace } from "@/services/chains/types";

// CAIP-2 format: "namespace:reference"
// e.g., "eip155:1" → Ethereum mainnet
//      "sui:mainnet" → Sui mainnet (non-numeric reference)

// Sui CAIP-2 references are short network names, not numeric chain IDs.
// We map them to virtual integers so the existing `chainId: number`
// surface stays stable for callers that only handle numeric refs.
const SUI_NETWORK_TO_VCHAINID: Record<string, number> = {
  mainnet: 1,
  testnet: 2,
  devnet: 3,
};

// Stellar CAIP-2 references (per CAIP-28,
// namespaces.chainagnostic.org/stellar/caip2) are `pubnet` / `testnet` —
// NOT `mainnet`. This is the one namespace where the CAIP-2 wire
// reference diverges from this app's internal `ChainConfig.network`
// value (`"mainnet"` | `"testnet"`); see {@link stellarNetworkToCaipReference}
// / {@link caipReferenceToStellarNetwork} for that translation. The
// virtual-chainId map below keys on the CAIP-2 reference string (mirroring
// the Sui map above, which keys on Sui's CAIP ref — for Sui the internal
// and CAIP names happen to be identical, so no separate translation was
// needed there).
const STELLAR_NETWORK_TO_VCHAINID: Record<string, number> = {
  pubnet: 1,
  testnet: 2,
};

/** Internal `ChainConfig.network` → CAIP-2 reference (`"mainnet"` → `"pubnet"`). */
export function stellarNetworkToCaipReference(
  network: "mainnet" | "testnet",
): "pubnet" | "testnet" {
  return network === "mainnet" ? "pubnet" : "testnet";
}

/** CAIP-2 reference → internal `ChainConfig.network`. `null` if unrecognised. */
export function caipReferenceToStellarNetwork(
  ref: string,
): "mainnet" | "testnet" | null {
  if (ref === "pubnet") return "mainnet";
  if (ref === "testnet") return "testnet";
  return null;
}

export function caip2ToNamespace(
  caip2: string,
): { namespace: Namespace; chainId: number } | null {
  const [ns, ref] = caip2.split(":");
  if (!ns || !ref) return null;

  const mapping: Record<string, Namespace> = {
    eip155: "eip155",
    solana: "solana",
    sui: "sui",
    stellar: "stellar",
  };

  const namespace = mapping[ns];
  if (!namespace) return null;

  if (namespace === "sui") {
    const vChain = SUI_NETWORK_TO_VCHAINID[ref];
    if (vChain === undefined) return null;
    return { namespace, chainId: vChain };
  }

  if (namespace === "stellar") {
    const vChain = STELLAR_NETWORK_TO_VCHAINID[ref];
    if (vChain === undefined) return null;
    return { namespace, chainId: vChain };
  }

  const chainId = parseInt(ref, 10);
  if (isNaN(chainId)) return null;

  return { namespace, chainId };
}

export function namespaceToCaip2(
  namespace: Namespace,
  chainId: number,
): string {
  const nsMapping: Record<Namespace, string> = {
    eip155: "eip155",
    solana: "solana",
    sui: "sui",
    stellar: "stellar",
  };

  if (namespace === "sui") {
    const ref = Object.keys(SUI_NETWORK_TO_VCHAINID).find(
      (k) => SUI_NETWORK_TO_VCHAINID[k] === chainId,
    );
    return `sui:${ref ?? "mainnet"}`;
  }

  if (namespace === "stellar") {
    const ref = Object.keys(STELLAR_NETWORK_TO_VCHAINID).find(
      (k) => STELLAR_NETWORK_TO_VCHAINID[k] === chainId,
    );
    return `stellar:${ref ?? "pubnet"}`;
  }

  return `${nsMapping[namespace]}:${chainId}`;
}

export function accountToCaip10(
  namespace: Namespace,
  chainId: number,
  address: string,
): string {
  return `${namespaceToCaip2(namespace, chainId)}:${address}`;
}

// ── Solana CAIP-2 references (deep-link spec §7.3) ────────────────────
//
// The CAIP-2 `solana` namespace uses `truncate(genesisHash, 32)` as the
// reference (ChainAgnostic `solana/caip2.md`), and that is what AppKit /
// WalletConnect dApps send. The app's internal keys (`solana:mainnet`,
// MWA style, `PermissionStore`) are an alias. Both forms are accepted on
// input; the kit emits the genesis-hash form on the wire.

export const SOLANA_GENESIS_REFS = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
} as const;

export type SolanaWcCluster = keyof typeof SOLANA_GENESIS_REFS;

/** Cluster → WalletConnect CAIP-2 (`solana:<genesis prefix>`). */
export function solanaClusterToWcCaip2(cluster: SolanaWcCluster): string {
  return `solana:${SOLANA_GENESIS_REFS[cluster]}`;
}

/**
 * Any accepted `solana:*` CAIP-2 form → cluster. Accepts the genesis-hash
 * references, the app's `mainnet|devnet|testnet` aliases, and the legacy
 * `mainnet-beta`. `null` for anything else.
 */
export function wcCaip2ToSolanaCluster(caip2: string): SolanaWcCluster | null {
  const [ns, ref] = caip2.split(":");
  if (ns !== "solana" || !ref) return null;
  for (const [cluster, genesis] of Object.entries(SOLANA_GENESIS_REFS)) {
    if (ref === genesis) return cluster as SolanaWcCluster;
  }
  if (ref === "mainnet" || ref === "mainnet-beta") return "mainnet-beta";
  if (ref === "devnet") return "devnet";
  if (ref === "testnet") return "testnet";
  return null;
}
