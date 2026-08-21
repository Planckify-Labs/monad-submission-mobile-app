import type {
  TokenListResponse,
  TToken,
  TTokenIdentity,
  TTokenSearchParams,
} from "@/api/types/token";
import { publicApi } from "@/constants/configs/ky";
import {
  apiCall,
  fetchById,
  fetchList,
  searchItems,
} from "../utils/api-helpers";

const _logTokenOperation = (operation: string, data?: any) => {
  console.log(`Token API: ${operation}`, data || "");
};

export const tokenApi = {
  /**
   * Symbol + icon for one contract. Resolves through our own backend (which
   * caches and holds the Alchemy key) rather than calling a vendor from the
   * device: this runs on the approval sheet, where a direct client call would
   * tell a third party which token the user is about to approve.
   *
   * Never throws and never surfaces an error string. Identity is decoration
   * on a security surface, so a failure degrades to "no icon" and the sheet
   * renders the plain address exactly as it did before.
   */
  getTokenIdentity: async (
    chainId: number,
    address: string,
  ): Promise<TTokenIdentity> => {
    try {
      return await publicApi
        .get("tokens/metadata", {
          searchParams: { chainId: String(chainId), address },
        })
        .json<TTokenIdentity>();
    } catch (err) {
      if (__DEV__) console.warn("[tokenApi] identity lookup failed", err);
      return { symbol: null, logo: null, decimals: null };
    }
  },

  getTokenList: () =>
    apiCall(async () => {
      const response = await fetchList<TokenListResponse>(
        publicApi,
        "tokens",
        "Failed to fetch token list",
      );
      return response;
    }, "Failed to fetch token list"),

  searchTokens: (params?: TTokenSearchParams) =>
    apiCall(async () => {
      const response = await searchItems<TokenListResponse>(
        publicApi,
        "tokens/search",
        params || {},
        "Failed to search tokens",
      );
      return response;
    }, "Failed to search tokens"),

  getTokenById: (id: string) =>
    apiCall(async () => {
      const response = await fetchById<TToken>(
        publicApi,
        "tokens",
        id,
        "Failed to fetch token by id",
      );
      return response;
    }, "Failed to fetch token by id"),
};
