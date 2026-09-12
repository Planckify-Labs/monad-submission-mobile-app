/**
 * Chain-config resolution for deep-link execution — namespace-agnostic.
 *
 * Handlers describe a target as `{ namespace, ref }` where `ref` is the
 * kit's own chain identifier as a string (`"137"`, `"devnet"`,
 * `"testnet"`). We match it against the cached `/blockchains` rows
 * through the kit's `getChainId`, so no code here knows what a cluster
 * or a network is. Static `supportedChains` is the fallback when the
 * feed has not been cached yet.
 */

import type { TBlockchain } from "@/api/types/blockchain";
import {
  type ChainConfig,
  supportedChains,
} from "@/constants/configs/chainConfig";
import { buildChainConfigFromBlockchain } from "@/hooks/useWallet.helpers";
import type { Namespace } from "@/services/chains/types";
import type { PayChannel } from "@/services/paymentIntent/types";
import { walletKitRegistry } from "@/services/walletKit/registry";

export interface ChainRef {
  namespace: Namespace;
  /** Kit chain id as a string, or `null` for "the family's default". */
  ref: string | null;
}

/** Flatten a `PayChannel.target` into a `ChainRef`. */
export function chainRefOfTarget(
  namespace: Namespace,
  target: Extract<PayChannel, { kind: "wallet" }>["target"],
): ChainRef {
  if (!target) return { namespace, ref: null };
  if ("chainId" in target) return { namespace, ref: String(target.chainId) };
  if ("cluster" in target) return { namespace, ref: target.cluster };
  return { namespace, ref: target.network };
}

function kitChainId(cfg: ChainConfig): string | null {
  if (!walletKitRegistry.has(cfg.namespace)) return null;
  const id = walletKitRegistry.get(cfg.namespace).getChainId?.(cfg);
  return id === null || id === undefined ? null : String(id);
}

/**
 * Every chain config offered for `namespace`: the cached feed rows when
 * present, else the static `supportedChains` entries.
 */
export function chainConfigsForNamespace(
  namespace: Namespace,
  rows: TBlockchain[] | null,
): ChainConfig[] {
  return configsFor(namespace, rows);
}

function configsFor(
  namespace: Namespace,
  rows: TBlockchain[] | null,
): ChainConfig[] {
  const fromRows: ChainConfig[] = [];
  for (const row of rows ?? []) {
    try {
      const cfg = buildChainConfigFromBlockchain(row);
      if (cfg.namespace === namespace) fromRows.push(cfg);
    } catch {
      // A malformed row must not take the whole lookup down.
    }
  }
  if (fromRows.length > 0) return fromRows;
  return supportedChains.filter((c) => c.namespace === namespace);
}

/**
 * Resolve the config a deep-link request should execute on. `null` when
 * the namespace has no rows at all or the named chain is not offered
 * (the caller maps that to `unsupported_chain`).
 */
export function resolveChainConfig(
  target: ChainRef,
  rows: TBlockchain[] | null,
): ChainConfig | null {
  const cfgs = configsFor(target.namespace, rows);
  if (cfgs.length === 0) return null;
  if (target.ref === null) {
    return cfgs.find((c) => !c.isTestnet) ?? cfgs[0];
  }
  return cfgs.find((c) => kitChainId(c) === target.ref) ?? null;
}

/**
 * `true` when the feed (or static config) offers `ref` for `namespace`.
 * With no cached rows the answer is `null` ("cannot verify") so a
 * handler's pure `parse()` can defer the check to `build()`.
 */
export function isChainOffered(
  target: ChainRef,
  rows: TBlockchain[] | null,
): boolean | null {
  if (!rows) return null;
  return resolveChainConfig(target, rows) !== null;
}
