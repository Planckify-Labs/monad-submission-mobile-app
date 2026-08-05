/**
 * CAIP-2 / CAIP-19 helpers for the bridge surface.
 *
 * Spec: docs/bridge-capability-spec.md §5.1.
 *
 * Parsing is generic (the CAIP grammar is namespace-agnostic by design);
 * CONSTRUCTION from a `ChainConfig` is not, so it dispatches through the
 * `caip2For` / `toAssetCaip19` optional capabilities on `WalletKitAdapter`
 * rather than branching here. Adding a namespace means implementing those
 * two methods, never editing this file.
 *
 * Directory note: this lives under `services/bridgeRoutes/`, not
 * `services/bridge/` — the latter is the EIP-1193 dApp bridge and is a
 * completely different subsystem.
 */

import type { TCaip2, TCaip19 } from "@/api/types/bridge";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { Namespace } from "@/services/chains/types";
import { walletKitRegistry } from "@/services/walletKit/registry";

export interface ParsedCaip2 {
  namespace: string;
  reference: string;
}

export interface ParsedCaip19 {
  chain: TCaip2;
  chainNamespace: string;
  chainReference: string;
  assetNamespace: string;
  assetReference: string;
}

const CAIP2_RE = /^([-a-z0-9]{3,8}):([-_a-zA-Z0-9]{1,32})$/;
const CAIP19_RE =
  /^([-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32})\/([-a-z0-9]{3,8})(?::(.+))?$/;

export function parseCaip2(value: string): ParsedCaip2 | null {
  const m = CAIP2_RE.exec(value.trim());
  return m ? { namespace: m[1], reference: m[2] } : null;
}

export function parseCaip19(value: string): ParsedCaip19 | null {
  const m = CAIP19_RE.exec(value.trim());
  if (!m) return null;
  const chain = parseCaip2(m[1]);
  if (!chain) return null;
  return {
    chain: m[1],
    chainNamespace: chain.namespace,
    chainReference: chain.reference,
    assetNamespace: m[2],
    assetReference: m[3] ?? "",
  };
}

export function chainOfAsset(asset: TCaip19): TCaip2 | null {
  return parseCaip19(asset)?.chain ?? null;
}

/**
 * `ChainConfig` → CAIP-2, via the owning wallet kit.
 *
 * Presence-checked: a kit that has not docked `caip2For` yet simply
 * reports `null`, and the bridge surface treats that chain as
 * unreachable rather than guessing an id.
 */
export function chainToCaip2(chain: ChainConfig): TCaip2 | null {
  const kit = walletKitRegistry.has(chain.namespace)
    ? walletKitRegistry.get(chain.namespace)
    : null;
  return kit?.caip2For?.(chain) ?? null;
}

/**
 * `(ChainConfig, contractAddress)` → CAIP-19, via the owning wallet kit.
 * Pass `null`/omit `contractAddress` for the chain's native asset.
 */
export function assetToCaip19(
  chain: ChainConfig,
  contractAddress?: string | null,
): TCaip19 | null {
  const kit = walletKitRegistry.has(chain.namespace)
    ? walletKitRegistry.get(chain.namespace)
    : null;
  return kit?.toAssetCaip19?.(chain, contractAddress) ?? null;
}

/** Find the `ChainConfig` in `chains` whose CAIP-2 id is `caip2`. */
export function findChainByCaip2(
  chains: ChainConfig[],
  caip2: TCaip2,
): ChainConfig | null {
  return chains.find((c) => chainToCaip2(c) === caip2) ?? null;
}

/**
 * Extract the chain-native token identifier from a CAIP-19, in the shape
 * `sendTokenTransfer` / `checkBridgeDestinationReadiness` expect
 * (Stellar's compound `CODE:ISSUER`, an EVM contract, an SPL mint, a Sui
 * coin type). Returns `null` for a native asset, which is the same
 * "no contract" signal those APIs already use.
 *
 * Case is preserved verbatim: folding it would corrupt a Solana mint or a
 * Stellar strkey (`feedback_address_case_per_encoding`).
 */
export function assetContractFromCaip19(asset: TCaip19): string | null {
  const parsed = parseCaip19(asset);
  if (!parsed) return null;

  // Namespaces whose CAIP-19 encoding differs from their internal one
  // decode it themselves (Stellar's `CODE-ISSUER` back to `CODE:ISSUER`).
  // Presence-checked: everyone else carries the identifier verbatim and
  // falls through to the generic path below.
  const namespace = parsed.chainNamespace as Namespace;
  if (walletKitRegistry.has(namespace)) {
    const kit = walletKitRegistry.get(namespace);
    if (kit.fromAssetCaip19) return kit.fromAssetCaip19(asset);
  }
  if (
    parsed.assetNamespace === "slip44" ||
    parsed.assetNamespace === "native"
  ) {
    return null;
  }
  if (
    parsed.chainNamespace === "sui" &&
    /^0x0*2::sui::SUI$/.test(parsed.assetReference)
  ) {
    return null;
  }
  return parsed.assetReference || null;
}
