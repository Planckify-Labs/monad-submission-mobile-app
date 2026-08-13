import { type UseQueryResult, useQueries } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import { dappApi } from "@/api/endpoints/dapps";
import type { TDapp, TDappCategory } from "@/api/types/dapp";
import { useDappCategories, usePopularDapps } from "@/hooks/queries/useDapps";
import { useFavoriteDApps } from "@/hooks/useFavoriteDApps";
import {
  buildJumpBackIn,
  type DirectoryEntry,
  type JumpBackInChip,
  toDirectoryEntry,
} from "@/services/dappsBrowser/directory";
import { FaviconStore } from "@/services/dappsBrowser/faviconStore";
import { BrowserHistoryStore } from "@/services/dappsBrowser/historyStore";
import { useConnectedHosts } from "./useConnectedHosts";

/**
 * The whole dApp catalogue, flattened for the hub directory.
 *
 * There is no `GET /dapps` root route on the API (it is `@Get("all")`, and
 * that one is auth-gated), so "everything" has to be assembled from the
 * per-category endpoint, one request per active category, unioned with the
 * popular feed. That is the same request volume the old hub made, since it
 * rendered a `CategorySectionContainer` per category; the difference is
 * that the rows now land in one ranked list instead of one rail each.
 *
 * Those requests are also what fills the `["dapps", …]` React Query cache
 * that the address-bar suggestions rank over, so opening the hub keeps the
 * omnibox useful offline.
 */

export interface DappDirectory {
  /** Active categories, in backend order. Drives the tab bar. */
  categories: TDappCategory[];
  /** Every known dApp, deduped by id. Unordered; rank with `buildDirectory`. */
  entries: DirectoryEntry[];
  /** The "Jump back in" strip: recent visits, then starred apps. */
  chips: JumpBackInChip[];
  /** True while there is genuinely nothing to render yet. */
  isLoading: boolean;
  /** The category list itself failed, so the hub has no tabs and no rows. */
  isError: boolean;
  refetchCategories: () => void;
  /**
   * Star / unstar an app. Exposed from here rather than left to the caller
   * because `useFavoriteDApps` keeps its records in component state: a
   * second instance in the same tree would toggle a copy this hook never
   * sees, and the row's star would not light up until the screen remounted.
   */
  toggleFavorite: (entry: DirectoryEntry) => void;
}

/**
 * Module-scope so React Query can memoize on the results array alone.
 * Dedupes by id: a dApp can arrive from both its category and the popular
 * feed, and the first copy wins.
 */
const combineDapps = (results: UseQueryResult<TDapp[], Error>[]) => {
  const byId = new Map<string, TDapp>();
  for (const result of results) {
    for (const dapp of result.data ?? []) {
      if (dapp?.id && !byId.has(dapp.id)) byId.set(dapp.id, dapp);
    }
  }
  return {
    dapps: [...byId.values()],
    isPending: results.some((result) => result.isPending),
  };
};

export function useDappDirectory(): DappDirectory {
  const {
    data: categories,
    isLoading: categoriesLoading,
    error: categoriesError,
    refetch: refetchCategories,
  } = useDappCategories();

  const activeCategories = useMemo(
    () =>
      (categories ?? [])
        .filter((category) => category.isActive)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
    [categories],
  );

  // Popular is fetched as its own row set rather than filtered out of the
  // categories, so an app whose category is inactive still reaches the
  // chart. Same query key the old Popular rail used, so it is warm.
  const popular = usePopularDapps();

  const categoryQueries = useMemo(
    () =>
      activeCategories.map((category) => ({
        queryKey: ["dapps", "category", category.id],
        queryFn: () => dappApi.getDappsByCategory(category.id),
      })),
    [activeCategories],
  );

  const { dapps, isPending } = useQueries({
    queries: categoryQueries,
    combine: combineDapps,
  });

  const { favoriteDApps, isFavorite, toggleFavorite } = useFavoriteDApps();
  const connectedHosts = useConnectedHosts();
  const history = useSyncExternalStore(
    BrowserHistoryStore.subscribe,
    BrowserHistoryStore.list,
  );
  const favicons = useSyncExternalStore(
    FaviconStore.subscribe,
    FaviconStore.map,
  );

  const entries = useMemo(() => {
    const byId = new Map<string, DirectoryEntry>();
    for (const dapp of [...dapps, ...(popular.data ?? [])]) {
      if (byId.has(dapp.id)) continue;
      const entry = toDirectoryEntry(dapp, { isFavorite, connectedHosts });
      if (entry) byId.set(entry.id, entry);
    }
    return [...byId.values()];
  }, [dapps, popular.data, isFavorite, connectedHosts]);

  const chips = useMemo(
    () =>
      buildJumpBackIn({
        history,
        entries,
        favorites: favoriteDApps,
        connectedHosts,
        favicons,
      }),
    [history, entries, favoriteDApps, connectedHosts, favicons],
  );

  return {
    categories: activeCategories,
    entries,
    chips,
    // A single slow category must not blank the list: as soon as any rows
    // have arrived the directory renders and fills in behind them.
    isLoading: entries.length === 0 && (categoriesLoading || isPending),
    isError: Boolean(categoriesError) && activeCategories.length === 0,
    refetchCategories,
    toggleFavorite,
  };
}
