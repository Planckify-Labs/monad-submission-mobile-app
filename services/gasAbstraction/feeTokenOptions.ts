/**
 * Pure grouping for the Gas Settings option list: per-chain fee tokens
 * (as reported live by a `GasAbstractionProvider.listFeeTokens`) → one
 * option per symbol, each carrying the chains it pays gas on. Kept free
 * of React so it is Node-testable; `hooks/useGasFeeTokenOptions` feeds it.
 *
 * Rules: no `react` / `react-native` / `viem` imports.
 */

import { type FeeToken, feeTokenSymbolMatches } from "./types";

/** A chain the app surfaces, as the option list needs to describe it. */
export interface GasFeeTokenChainRef {
  /** `chainCacheKey` of the chain, e.g. `eip155:143`. */
  key: string;
  /** Display name from the blockchain catalogue, e.g. "Monad". */
  name: string;
  isTestnet: boolean;
}

export interface GasFeeTokenChain extends GasFeeTokenChainRef {
  /** The token as the provider tags it on THIS chain (address / decimals differ per chain). */
  token: FeeToken;
}

export interface GasFeeTokenOption {
  /** Symbol as first reported by the provider, e.g. "USDC", "USDT0", "mUSD". */
  symbol: string;
  /** Every surfaced chain the provider accepts this symbol on, in probe order. */
  chains: GasFeeTokenChain[];
}

/**
 * Groups per-chain fee tokens into one option per symbol (case-
 * insensitive, first-seen casing wins). Order: the symbol accepted on the
 * most chains first, ties by first appearance, so the broadly useful
 * choice leads without hardcoding it. Chains with no entry in
 * `tokensByKey` (not served, still loading, errored) contribute nothing.
 */
export function groupFeeTokenOptions(
  chains: readonly GasFeeTokenChainRef[],
  tokensByKey: ReadonlyMap<string, readonly FeeToken[]>,
): GasFeeTokenOption[] {
  const options: GasFeeTokenOption[] = [];
  for (const chain of chains) {
    for (const token of tokensByKey.get(chain.key) ?? []) {
      const symbol = token.symbol.trim();
      if (symbol.length === 0) continue;
      let option = options.find((o) => feeTokenSymbolMatches(o.symbol, symbol));
      if (!option) {
        option = { symbol, chains: [] };
        options.push(option);
      }
      if (option.chains.some((c) => c.key === chain.key)) continue;
      option.chains.push({
        key: chain.key,
        name: chain.name,
        isTestnet: chain.isTestnet,
        token,
      });
    }
  }
  return options
    .map((o, index) => ({ o, index }))
    .sort((a, b) => b.o.chains.length - a.o.chains.length || a.index - b.index)
    .map(({ o }) => o);
}
