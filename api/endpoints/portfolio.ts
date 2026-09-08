import { api } from "@/constants/configs/ky";
import type {
  TDiscoveredAsset,
  TPortfolioEnvelope,
  TPortfolioNft,
  TPortfolioPosition,
  TPortfolioQuery,
} from "../types/portfolio";
import { buildSearchParams } from "../utils/api-helpers";

export interface TPortfolioNftQuery extends TPortfolioQuery {
  pageSize?: number;
  pageAfter?: string;
}

/**
 * `refresh` is omitted entirely unless it is true. The server treats an absent
 * param as "serve cache", which is what every automatic refetch wants: only a
 * user's pull-to-refresh should spend upstream quota.
 */
function toSearchParams(query: TPortfolioQuery & Record<string, unknown>) {
  const { chains, refresh, ...rest } = query;
  return buildSearchParams({
    chain_ids: chains && chains.length > 0 ? chains.join(",") : undefined,
    refresh: refresh === true ? "true" : undefined,
    ...rest,
  });
}

export const portfolioApi = {
  /**
   * Assets the wallet is known to hold, identity only. Feeds the token list;
   * balances are still read on-chain by the caller.
   */
  getDiscoveredAssets: async (query: TPortfolioQuery = {}) => {
    return api
      .get("portfolio/discovered-assets", {
        searchParams: toSearchParams({ ...query }),
      })
      .json<TPortfolioEnvelope<TDiscoveredAsset[]>>();
  },

  getDefiPositions: async (query: TPortfolioQuery = {}) => {
    return api
      .get("portfolio/defi-positions", {
        searchParams: toSearchParams({ ...query }),
      })
      .json<TPortfolioEnvelope<TPortfolioPosition[]>>();
  },

  getNfts: async (query: TPortfolioNftQuery = {}) => {
    const { pageSize, pageAfter, ...base } = query;
    return api
      .get("portfolio/nfts", {
        searchParams: toSearchParams({
          ...base,
          page_size: pageSize,
          page_after: pageAfter,
        }),
      })
      .json<TPortfolioEnvelope<TPortfolioNft[]>>();
  },
};
