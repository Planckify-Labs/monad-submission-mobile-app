import { useQuery } from "@tanstack/react-query";
import { dappApi } from "@/api/endpoints/dapps";
import type { TDappSearchParams } from "@/api/types/dapp";

export const useDappCategories = () => {
  return useQuery({
    queryKey: ["dapp-categories"],
    queryFn: dappApi.getDappCategories,
  });
};

export const useDapps = () => {
  return useQuery({
    queryKey: ["dapps"],
    queryFn: dappApi.getDappList,
  });
};

export const usePopularDapps = () => {
  return useQuery({
    queryKey: ["dapps", "popular"],
    queryFn: dappApi.getPopularDapps,
  });
};

export const useSponsoredDapps = () => {
  return useQuery({
    queryKey: ["dapps", "sponsored"],
    queryFn: dappApi.getSponsoredDapps,
  });
};

export const usePromotions = () => {
  return useQuery({
    queryKey: ["dapp-promotions"],
    queryFn: dappApi.getPromotions,
  });
};

export const useFavoriteDapps = () => {
  return useQuery({
    queryKey: ["dapps", "favorites"],
    queryFn: dappApi.getFavoriteDapps,
  });
};

export const useDappsByCategory = (categoryId: string) => {
  return useQuery({
    queryKey: ["dapps", "category", categoryId],
    queryFn: () => dappApi.getDappsByCategory(categoryId),
    enabled: !!categoryId,
  });
};

/**
 * NOT WIRED UP SERVER-SIDE. `dapps.controller.ts` has no `search` route, so
 * `GET /dapps/search` falls through to `@Get(":id")` and 404s with
 * "Dapp not found". Nothing calls this today.
 *
 * Address-bar suggestions deliberately do not use it: they rank the
 * catalogue already in the React Query cache (see
 * `hooks/dapps-browser/useOmniboxSuggestions.ts`), which is instant,
 * works offline, and needs no round-trip per keystroke. Adding the
 * endpoint is only worth it once the catalogue outgrows what the client
 * holds.
 */
export const useDappSearch = (params?: TDappSearchParams) => {
  return useQuery({
    queryKey: ["dapps", "search", params],
    queryFn: () => dappApi.searchDapps(params),
    enabled: !!params,
  });
};

export const useDappById = (id: string) => {
  return useQuery({
    queryKey: ["dapps", id],
    queryFn: () => dappApi.getDappById(id),
    enabled: !!id,
  });
};
