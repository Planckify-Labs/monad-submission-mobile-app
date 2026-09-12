import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { TDapp } from "@/api/types/dapp";
import { useFavoriteDApps } from "@/hooks/useFavoriteDApps";
import type { CatalogEntry } from "@/services/dappsBrowser/suggest";

/**
 * The dApp catalogue as the app already holds it: the `["dapps", …]`
 * React Query cache (popular / sponsored / per-category, mirrored into
 * MMKV by `lib/storage/queryPersister.ts`, so populated on frame 0 of a
 * cold start and available offline) unioned with the local favourites.
 * No request is made here; consumers that want fresh rows fetch them
 * through the dapps hooks and this view picks them up.
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
export function useDappCatalog(enabled: boolean): CatalogEntry[] {
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
