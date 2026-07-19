/**
 * Chain-agnostic accessors for `ChainConfig` — single source of truth
 * for "what's this chain's identifier / human-readable label?".
 *
 * Why this exists:
 *   Before these helpers, every screen did
 *   `activeChain.namespace === "eip155" ? activeChain.chain.id : undefined`
 *   (and the equivalent for `.chain.name`). Each of those was an N=1
 *   assumption — when Solana was added, every site silently defaulted to
 *   `undefined` for Solana and only some were audited to add a second
 *   branch. Adding Sui or Bitcoin would repeat the same dance.
 *
 *   With this module, callers ask the kit for its own chain identifier.
 *   New chains register a kit with `getChainId` / `formatChainLabel` hooks
 *   and every site that uses these helpers is correct automatically — no
 *   shared-code edits required.
 *
 * Contract:
 *   - Both helpers are safe to call on any `ChainConfig`. If the kit for
 *     the chain's namespace isn't registered (should not happen in a
 *     booted app; can happen mid-Fast-Refresh), they return a predictable
 *     fallback (`null` / `chain.namespace` string) rather than throwing.
 *   - `getEvmChainId` is a thin convenience for the (currently common)
 *     case of "I need the number that viem wants". It returns `undefined`
 *     for non-EVM chains, matching the previous inline pattern exactly.
 */

import type { TBlockchain } from "@/api/types/blockchain";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { Namespace } from "@/services/chains/types";
import { walletKitRegistry } from "./registry";

/**
 * Returns the chain's native identifier, or `null` if the registered kit
 * doesn't expose one (or no kit is registered for the namespace).
 */
export function getChainId(chain: ChainConfig): number | string | null {
  if (!walletKitRegistry.has(chain.namespace)) return null;
  const kit = walletKitRegistry.get(chain.namespace);
  return kit.getChainId?.(chain) ?? null;
}

/**
 * EVM-typed convenience — returns the viem `chain.id` number, or
 * `undefined` for anything non-EVM. Direct drop-in for call sites doing
 * `activeChain.namespace === "eip155" ? activeChain.chain.id : undefined`.
 */
export function getEvmChainId(chain: ChainConfig): number | undefined {
  const id = getChainId(chain);
  return typeof id === "number" ? id : undefined;
}

/**
 * Human-readable chain label (e.g. `"Ethereum Mainnet"`, `"Solana Mainnet"`).
 * Falls back to the kit's `displayName`, then the raw namespace string.
 */
export function formatChainLabel(chain: ChainConfig): string {
  if (!walletKitRegistry.has(chain.namespace)) return chain.namespace;
  const kit = walletKitRegistry.get(chain.namespace);
  return kit.formatChainLabel?.(chain) ?? kit.displayName ?? chain.namespace;
}

/**
 * Native currency ticker for `chain` — `"ETH"`, `"SOL"`, `"MATIC"`, etc.
 * Returns `null` when the registered kit doesn't expose one. Used by
 * shared surfaces (agent wallet-context builder) that need the symbol
 * without switching on namespace themselves.
 */
export function getNativeSymbol(chain: ChainConfig): string | null {
  if (!walletKitRegistry.has(chain.namespace)) return null;
  const kit = walletKitRegistry.get(chain.namespace);
  return kit.nativeSymbol?.(chain) ?? null;
}

/**
 * Canonical storage/comparison form of a wallet `address` on `namespace`,
 * via the registered kit's `canonicalizeAddress` capability. Falls back to
 * the address unchanged when the kit (or namespace) doesn't implement it —
 * so shared code never has to know a chain's case rule. This is the seam
 * that replaced blanket `address.toLowerCase()` in shared code (which
 * corrupts case-sensitive Solana base58 / Stellar base32 addresses).
 */
export function canonicalizeAddress(
  namespace: Namespace,
  address: string,
): string {
  if (!walletKitRegistry.has(namespace)) return address;
  return (
    walletKitRegistry.get(namespace).canonicalizeAddress?.(address) ?? address
  );
}

/**
 * True when `a` and `b` are the same wallet address under `namespace`'s case
 * rule. Nullish inputs are never equal. Prefer this over `===` /
 * `.toLowerCase()` comparisons for any wallet address.
 */
export function addressesEqual(
  namespace: Namespace,
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    canonicalizeAddress(namespace, a) === canonicalizeAddress(namespace, b)
  );
}

/**
 * Sign-in protocol chain name for a wallet namespace. `eip155` → "Ethereum"
 * (SIWE / EIP-4361), `solana` → "Solana" (SIWS). Used to keep sign-in CTAs
 * ("Sign In With Ethereum" / "Sign in with Solana…") aligned to the active
 * wallet's chain family without screens hard-coding the EVM branch.
 *
 * When `namespace` is missing or unknown, returns "Wallet" — the screen
 * stays readable instead of rendering "Sign in with undefined".
 */
export function getChainFamilyLabel(namespace: string | undefined): string {
  if (!namespace) return "Wallet";
  try {
    const kit = walletKitRegistry.get(namespace as never);
    return kit.displayName ?? capitalize(namespace);
  } catch {
    return capitalize(namespace);
  }
}

/**
 * Compact uppercase badge code for a namespace (`"EVM"` / `"SOL"` / `"SUI"`).
 * Object-literal lookup — no `namespace === …` branching — so shared UI
 * (e.g. the dApp connection manager) can render a chain chip without
 * tripping `check:chains`. Unknown namespaces fall back to uppercase.
 */
const CHAIN_BADGE_LABELS: Record<Namespace, string> = {
  eip155: "EVM",
  solana: "SOL",
  sui: "SUI",
  stellar: "XLM",
};
export function chainBadgeLabel(namespace: Namespace | undefined): string {
  if (!namespace) return "—";
  return CHAIN_BADGE_LABELS[namespace] ?? namespace.toUpperCase();
}

/**
 * Auth-nonce `chainSlug` for `chain` (`"solana-devnet"`, `"sui-testnet"`,
 * …) via the registered kit. `null` for EVM (which keys on `chainId`) or
 * when no kit is registered. Prefer `getNonceParams` at call sites.
 */
export function getAuthChainSlug(chain: ChainConfig): string | null {
  if (!walletKitRegistry.has(chain.namespace)) return null;
  return (
    walletKitRegistry.get(chain.namespace).getAuthChainSlug?.(chain) ?? null
  );
}

/**
 * Builds the `auth/nonce` query params for a sign-in. `source` is the
 * namespace authority (the wallet for auth flows, the chain for
 * chain-led flows like pay-merchant) — both `TWallet` and `ChainConfig`
 * expose `.namespace`. Non-EVM families authenticate with a `chainSlug`,
 * EVM with a numeric `chainId`.
 *
 * Race-safety (preserves the auth.tsx behaviour): when `chain` has settled
 * to `source.namespace` we read its precise slug; otherwise — `activeChain`
 * momentarily lags a wallet switch — we fall back to the family's
 * `defaultAuthChainSlug` (mainnet) so the request never drops to the wrong
 * (SIWE) path and 400s. Returns `{}` when there's no registered kit.
 */
export function getNonceParams(
  source: { namespace: Namespace } | null | undefined,
  chain: ChainConfig | null | undefined,
): { chainId?: number; chainSlug?: string } {
  if (!source || !walletKitRegistry.has(source.namespace)) return {};
  const kit = walletKitRegistry.get(source.namespace);
  if (kit.getAuthChainSlug) {
    const slug =
      chain && chain.namespace === source.namespace
        ? kit.getAuthChainSlug(chain)
        : (kit.defaultAuthChainSlug ?? null);
    return slug ? { chainSlug: slug } : {};
  }
  const chainId = chain ? getEvmChainId(chain) : undefined;
  return chainId !== undefined ? { chainId } : {};
}

/**
 * True when the `/blockchains` row `row` is the same network as `chain`.
 * Delegates to the kit's `matchesBlockchainRow`; `false` when the kit
 * doesn't implement it or isn't registered. Lets balance/payment screens
 * pick the matching API row without branching on namespace.
 */
export function matchesBlockchainRow(
  chain: ChainConfig,
  row: TBlockchain,
): boolean {
  if (!walletKitRegistry.has(chain.namespace)) return false;
  return (
    walletKitRegistry.get(chain.namespace).matchesBlockchainRow?.(chain, row) ??
    false
  );
}

/**
 * Backend payment-rail string for `chain` (`"solana"` / `"evm"`). Defaults
 * to `"evm"` for kits without a dedicated rail, preserving the historical
 * "solana or evm" mapping in pay-merchant intent creation.
 */
export function preferredChainRail(chain: ChainConfig): "evm" | "solana" {
  if (!walletKitRegistry.has(chain.namespace)) return "evm";
  return walletKitRegistry.get(chain.namespace).preferredPaymentRail ?? "evm";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
