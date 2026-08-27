/**
 * "What is the user actually holding that these opportunities can take?"
 * — the idle-balance lookup behind Quick Invest States 2 and 3
 * (docs/defi-quick-invest-spec.md §6, §6.1, §11.4, §11.6).
 *
 * Three constraints from the spec are encoded here rather than commented:
 *
 *  - **The agent never supplies a balance.** It is read client-side via
 *    `useGroupedTokenBalances`, the same posture as "no LLM-supplied
 *    addresses" — the model stays out of financial arithmetic.
 *  - **Mobile has no live price source of its own (§6.1).** The only
 *    registered indexer provider reads balances by multicall and never
 *    sets `price`, and `fetchTokenPrices` fails *silently as an empty
 *    array*. USD therefore comes from the backend's Alchemy proxy
 *    (`strategiesApi.getAssetPrices`), which is batched (max 25) and
 *    returns `usd: null` — "price unknown", never an error — for anything
 *    it cannot resolve.
 *  - **Detection is EVM-only today (§11.6), without saying so.** The
 *    indexer resolves chains by numeric id and returns `[]` for a non-EVM
 *    row. That empty array is handled as "we could not detect", never as
 *    "the user has no funds", and there is no namespace comparison
 *    anywhere here — the limitation resolves itself when a provider docks.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { strategiesApi } from "@/api/endpoints/strategies";
import { useGroupedTokenBalances } from "@/hooks/queries/useTokenBalances";
import { isUsdPegged } from "@/services/defi/quickInvest";

/** The batch price DTO caps at 25 queries per call (`ArrayMaxSize(25)`). */
const MAX_PRICE_QUERIES = 25;

export type IdleAsset = {
  symbol: string;
  /** Human units (balance / 10^decimals). */
  amount: number;
  decimals: number;
  contractAddress?: string;
  /** USD spot price, or null when it genuinely could not be resolved. */
  priceUsd: number | null;
  /** `amount * priceUsd`, or null when the price is unknown. */
  usdValue: number | null;
};

export type IdleAssetsResult = {
  /** Held candidates, richest first. Empty when nothing was detected. */
  assets: IdleAsset[];
  /** §11.4 — the single largest USD-valued holding, no aggregation. */
  largest: IdleAsset | null;
  bySymbol: (symbol: string | null | undefined) => IdleAsset | null;
  isLoading: boolean;
};

function toHuman(balance: bigint, decimals: number): number {
  if (decimals <= 0) return Number(balance);
  // Split so a large balance doesn't lose its fractional part to float
  // precision before it is ever displayed.
  const base = 10n ** BigInt(decimals);
  const whole = balance / base;
  const frac = balance % base;
  return Number(whole) + Number(frac) / Number(base);
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

/**
 * Idle balances for the assets a set of opportunities is denominated in.
 *
 * `candidateSymbols` is the asset list from the opportunity rows, so we
 * only ever price things the card could actually deposit into — and stay
 * well inside the 25-query batch cap.
 */
export function useIdleAssetBalances(args: {
  address: string | undefined;
  chainId: number | null | undefined;
  candidateSymbols: readonly string[];
  enabled?: boolean;
}): IdleAssetsResult {
  const { address, chainId, candidateSymbols } = args;
  const enabled = args.enabled !== false && !!address && !!chainId;

  const { data: grouped, isLoading: balancesLoading } = useGroupedTokenBalances(
    enabled ? address : undefined,
    chainId ?? 0,
  );

  const wanted = useMemo(() => {
    const set = new Set(candidateSymbols.map(norm).filter(Boolean));
    return set;
  }, [candidateSymbols]);

  // Held candidates, before pricing. `hidden` is excluded on purpose: a
  // token the user hid or the spam filter flagged is not something to
  // headline an investment suggestion with.
  const held = useMemo(() => {
    const items = [
      ...(grouped?.data.main ?? []),
      ...(grouped?.data.discovered ?? []),
    ];
    const out: Omit<IdleAsset, "priceUsd" | "usdValue">[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const symbol = norm(item.symbol);
      if (!symbol || !wanted.has(symbol) || seen.has(symbol)) continue;
      const amount = toHuman(item.balance, item.decimals);
      if (!(amount > 0)) continue;
      seen.add(symbol);
      out.push({
        symbol,
        amount,
        decimals: item.decimals,
        contractAddress: item.contractAddress || undefined,
      });
    }
    return out.slice(0, MAX_PRICE_QUERIES);
  }, [grouped, wanted]);

  // Only non-pegged assets need a round trip: for a USD-pegged stablecoin
  // 1 token is $1, and a lookup would add drift without adding meaning
  // (§6.1 "scope check — smaller than it sounds").
  const priceQueries = useMemo(
    () =>
      held
        .filter((h) => !isUsdPegged(h.symbol))
        .map((h) => ({
          chainId: chainId ?? 0,
          assetSymbol: h.symbol,
          assetContract: h.contractAddress,
        })),
    [held, chainId],
  );

  const { data: prices, isLoading: pricesLoading } = useQuery({
    queryKey: [
      "defi",
      "asset-prices",
      chainId,
      priceQueries.map((q) => q.assetSymbol).join(","),
    ],
    enabled: enabled && priceQueries.length > 0,
    // Spot prices move, but not within one card interaction. Longer than
    // the global 60s default so dragging the slider never re-fetches.
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const rows = await strategiesApi.getAssetPrices(priceQueries);
      const map = new Map<string, number | null>();
      for (const r of rows) map.set(norm(r.asset_symbol), r.usd);
      return map;
    },
  });

  const assets = useMemo(() => {
    const out: IdleAsset[] = held.map((h) => {
      const priceUsd = isUsdPegged(h.symbol)
        ? 1
        : (prices?.get(h.symbol) ?? null);
      return {
        ...h,
        priceUsd,
        usdValue: priceUsd === null ? null : h.amount * priceUsd,
      };
    });
    // Richest first; an unpriced asset sorts last rather than as $0 — it is
    // "we don't know", not "it's worthless".
    out.sort((a, b) => (b.usdValue ?? -1) - (a.usdValue ?? -1));
    return out;
  }, [held, prices]);

  return useMemo(() => {
    const byUpper = new Map(assets.map((a) => [a.symbol, a]));
    return {
      assets,
      largest: assets.find((a) => (a.usdValue ?? 0) > 0) ?? null,
      bySymbol: (symbol) => byUpper.get(norm(symbol)) ?? null,
      isLoading: balancesLoading || pricesLoading,
    };
  }, [assets, balancesLoading, pricesLoading]);
}
