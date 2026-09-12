import { useMemo, useSyncExternalStore } from "react";
import { useDappCatalog } from "@/hooks/dapps-browser/useDappCatalog";
import { FaviconStore } from "@/services/dappsBrowser/faviconStore";
import { BrowserHistoryStore } from "@/services/dappsBrowser/historyStore";
import {
  buildSuggestions,
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
