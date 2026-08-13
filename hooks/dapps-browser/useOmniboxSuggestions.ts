import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { TDapp } from "@/api/types/dapp";
import { useFavoriteDApps } from "@/hooks/useFavoriteDApps";
import { FaviconStore } from "@/services/dappsBrowser/faviconStore";
import { BrowserHistoryStore } from "@/services/dappsBrowser/historyStore";
import {
  buildSuggestions,
  type CatalogEntry,
  type HistoryEntry,
  type SuggestionListItem,
} from "@/services/dappsBrowser/suggest";

/**
 * Suggestions for the browser address bar.
 *
 * The corpus is assembled from what the app already has rather than a
 * search request:
 *
 *  - the dApp catalogue sitting in the React Query cache under the
 *    `["dapps", …]` key family (popular / sponsored / per-category), which
 *    `lib/storage/queryPersister.ts` mirrors into MMKV, so it is populated
 *    on frame 0 of a cold start and works with no connection;
 *  - the user's starred favourites, which are local-first in MMKV;
 *  - locally recorded browsing history.
 *
 * That combination is also what makes the list feel instant: ranking is a
 * synchronous pass over a few hundred rows, so it can run on every
 * keystroke with no debounce. There is no server call to make here in any
 * case, since the API exposes no dapp search route.
 */

const isDappArray = (value: unknown): value is TDapp[] =>
  Array.isArray(value) && value.every((row) => row && typeof row === "object");

function toCatalogEntry(
  dapp: TDapp,
  isFavorite: (id: string) => boolean,
): CatalogEntry | null {
  if (!dapp.id || !dapp.websiteUrl) return null;
  return {
    id: dapp.id,
    name: dapp.name ?? "",
    description: dapp.description ?? "",
    websiteUrl: dapp.websiteUrl,
    logoUrl: dapp.logoUrl ?? "",
    categoryName: dapp.category?.name ?? "",
    appearance: dapp.appearance,
    // Favourites are local-first, so the MMKV view wins over whatever the
    // server flag said when this row was cached.
    isFavorite: isFavorite(dapp.id),
    isPopular: Boolean(dapp.isPopular),
  };
}

/**
 * Every dApp the app has seen, unioned across the `["dapps", …]` cache
 * entries and the favourites store, deduped by id.
 */
function useDappCatalog(enabled: boolean): CatalogEntry[] {
  const queryClient = useQueryClient();
  const { favoriteDApps, isFavorite } = useFavoriteDApps();
  const [cacheVersion, setCacheVersion] = useState(0);

  // Rebuild when a dapp query settles. Scoped to the `dapps` key family and
  // only while the overlay is open, so a background refetch elsewhere in
  // the app doesn't re-rank a list nobody is looking at.
  useEffect(() => {
    if (!enabled) return;
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.query.queryKey[0] !== "dapps") return;
      setCacheVersion((version) => version + 1);
    });
  }, [enabled, queryClient]);

  return useMemo(() => {
    if (!enabled) return [];
    // `cacheVersion` is the invalidation signal for the imperative
    // `getQueriesData` read below, which nothing else can observe. Without
    // it the catalogue would freeze at whatever happened to be cached when
    // the overlay first opened.
    void cacheVersion;
    const byId = new Map<string, CatalogEntry>();

    for (const [, data] of queryClient.getQueriesData({
      queryKey: ["dapps"],
    })) {
      if (!isDappArray(data)) continue;
      for (const dapp of data) {
        const entry = toCatalogEntry(dapp, isFavorite);
        if (entry && !byId.has(entry.id)) byId.set(entry.id, entry);
      }
    }

    // Favourites carry a denormalized snapshot, so a starred dApp still
    // suggests even when its category was never fetched on this device.
    for (const favorite of favoriteDApps) {
      if (byId.has(favorite.id) || !favorite.websiteUrl) continue;
      byId.set(favorite.id, {
        id: favorite.id,
        name: favorite.name ?? "",
        description: favorite.description ?? "",
        websiteUrl: favorite.websiteUrl,
        logoUrl: favorite.logoUrl ?? "",
        categoryName: "",
        appearance: favorite.appearance,
        isFavorite: true,
        isPopular: false,
      });
    }

    return [...byId.values()];
  }, [enabled, cacheVersion, queryClient, favoriteDApps, isFavorite]);
}

const EMPTY_HISTORY: HistoryEntry[] = [];

function useBrowserHistory(enabled: boolean): HistoryEntry[] {
  const entries = useSyncExternalStore(
    BrowserHistoryStore.subscribe,
    BrowserHistoryStore.list,
  );
  return enabled ? entries : EMPTY_HISTORY;
}

export function useOmniboxSuggestions(
  query: string,
  enabled: boolean,
): SuggestionListItem[] {
  const catalog = useDappCatalog(enabled);
  const history = useBrowserHistory(enabled);
  // Site icons cached from earlier visits, so a host the catalogue does
  // not carry still shows its own logo rather than a letter.
  const favicons = useSyncExternalStore(
    FaviconStore.subscribe,
    FaviconStore.map,
  );

  return useMemo(() => {
    if (!enabled) return [];
    return buildSuggestions({ query, catalog, history, favicons });
  }, [enabled, query, catalog, history, favicons]);
}
