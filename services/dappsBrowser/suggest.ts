/**
 * Ranking for the address-bar suggestion list.
 *
 * The corpus is assembled entirely on-device: the dApp catalogue already
 * sitting in the React Query cache (which `lib/storage/queryPersister.ts`
 * mirrors into MMKV, so it survives a restart and works offline), the
 * user's starred favourites, and locally recorded browsing history. There
 * is no search round-trip, which is what lets the list update on every
 * keystroke — and the API has no `dapps/search` route to call anyway.
 *
 * Pure and RN-free so the ordering rules are unit-testable.
 */

import type { TAppearance } from "@/api/types/dapp";
import {
  type OmniboxIntent,
  parseOmnibox,
  parseUrl,
  SEARCH_ENGINE_NAME,
  searchUrlFor,
} from "./omnibox";

/**
 * One dApp from the catalogue, flattened to what ranking needs plus the
 * bits the row renders. `appearance` is carried as the raw API value and
 * resolved in the component (`utils/dappAppearance` pulls in react-native,
 * which would make this module untestable).
 */
export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  websiteUrl: string;
  logoUrl: string;
  categoryName: string;
  appearance?: TAppearance | null;
  isFavorite: boolean;
  isPopular: boolean;
}

/** One previously visited site. */
export interface HistoryEntry {
  url: string;
  host: string;
  title: string;
  visitCount: number;
  lastVisitedAt: number;
}

export type SuggestionKind = "navigate" | "search" | "dapp" | "history";

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  /** Primary line. */
  title: string;
  /** Secondary line: the host, or the search engine. */
  subtitle: string;
  /** Optional brand-red chip beside the title, e.g. the dApp's category. */
  badge?: string;
  /** What tapping the row opens. */
  url: string;
  logoUrl?: string;
  /** Raw API appearance; the row resolves it for the logo tile. */
  appearance?: TAppearance | null;
  /** Present on catalogue-backed rows. */
  dappId?: string;
  isFavorite?: boolean;
  /**
   * Set only on rows backed by local history, and carries the key that
   * `BrowserHistoryStore` is keyed by. Its presence is what makes a row
   * removable: a catalogue app is not the user's data to delete, a site
   * they visited is.
   */
  historyHost?: string;
}

/** Flat list so one FlashList can render headers and rows together. */
export type SuggestionListItem =
  | { type: "header"; id: string; label: string }
  | { type: "row"; id: string; suggestion: Suggestion };

export interface BuildSuggestionsArgs {
  query: string;
  catalog: readonly CatalogEntry[];
  history: readonly HistoryEntry[];
  /**
   * host -> site icon, cached from previous visits. Fills the logo for
   * sites the catalogue has never heard of, which would otherwise render
   * as a bare initial.
   */
  favicons?: ReadonlyMap<string, string>;
  now?: number;
  recentLimit?: number;
  appsLimit?: number;
}

const DEFAULT_RECENT_LIMIT = 4;
const DEFAULT_APPS_LIMIT = 6;
const DAY_MS = 86_400_000;

// A site you have already visited outranks one you have not, all else equal.
const HISTORY_BASE_BONUS = 25;
const FAVORITE_BONUS = 30;
const POPULAR_BONUS = 12;

// Weak signals are capped below a name match so a category or blurb hit
// can never push an unrelated dApp above the one the user named.
const CATEGORY_CAP = 45;
const DESCRIPTION_CAP = 30;

const normalise = (value: string): string => value.trim().toLowerCase();

/** Bare host of a catalogue URL, without `www.`. "" when unparseable. */
export function hostOfUrl(url: string): string {
  const parsed = parseUrl(url);
  return parsed ? parsed.host.replace(/^www\./, "") : "";
}

/**
 * Coarse match tiers rather than a continuous score: the ordering stays
 * easy to reason about and easy to assert. -1 means no match at all.
 */
function matchTier(text: string, query: string): number {
  if (!text) return -1;
  const value = normalise(text);
  if (value === query) return 100;
  if (value.startsWith(query)) return 80;
  // Word-boundary prefix, so "perps" finds "Jupiter Perps".
  if (value.split(/[^a-z0-9]+/).some((word) => word.startsWith(query))) {
    return 60;
  }
  if (value.includes(query)) return 40;
  return -1;
}

/** Host matching also looks inside labels, so "uniswap" finds app.uniswap.org. */
function scoreHost(host: string, query: string): number {
  if (!host) return -1;
  if (host === query) return 120;
  if (host.startsWith(query)) return 100;
  const labels = host.split(".");
  if (labels.some((label) => label === query)) return 90;
  if (labels.some((label) => label.startsWith(query))) return 70;
  if (host.includes(query)) return 40;
  return -1;
}

/** Worth 20 for a visit today, decaying to 0 over two weeks. */
function recencyBoost(lastVisitedAt: number, now: number): number {
  const days = (now - lastVisitedAt) / DAY_MS;
  if (days <= 0) return 20;
  return Math.max(0, Math.round(20 - days * (20 / 14)));
}

/** Repeat visits count, with diminishing returns. */
function frequencyBoost(visitCount: number): number {
  return Math.min(20, Math.round(Math.log2(Math.max(1, visitCount)) * 8));
}

export function scoreCatalogEntry(entry: CatalogEntry, query: string): number {
  const best = Math.max(
    scoreHost(hostOfUrl(entry.websiteUrl), query),
    matchTier(entry.name, query),
    Math.min(matchTier(entry.categoryName, query), CATEGORY_CAP),
    Math.min(matchTier(entry.description, query), DESCRIPTION_CAP),
  );
  if (best < 0) return -1;
  return (
    best +
    (entry.isFavorite ? FAVORITE_BONUS : 0) +
    (entry.isPopular ? POPULAR_BONUS : 0)
  );
}

export function scoreHistoryEntry(
  entry: HistoryEntry,
  query: string,
  now: number,
): number {
  const best = Math.max(
    scoreHost(entry.host, query),
    matchTier(entry.title, query),
  );
  if (best < 0) return -1;
  return (
    best +
    HISTORY_BASE_BONUS +
    recencyBoost(entry.lastVisitedAt, now) +
    frequencyBoost(entry.visitCount)
  );
}

function catalogSuggestion(entry: CatalogEntry): Suggestion {
  return {
    id: `dapp:${entry.id}`,
    kind: "dapp",
    title: entry.name,
    // Host on the second line, category as the chip: the host is what
    // tells the user where a tap actually goes.
    subtitle: hostOfUrl(entry.websiteUrl),
    badge: entry.categoryName || undefined,
    url: entry.websiteUrl,
    logoUrl: entry.logoUrl,
    appearance: entry.appearance,
    dappId: entry.id,
    isFavorite: entry.isFavorite,
  };
}

/**
 * A visited site, enriched from the catalogue when we know it: the row
 * keeps its "recent" placement (where the user expects a revisit) but
 * borrows the real name and logo.
 */
function historySuggestion(
  entry: HistoryEntry,
  match: CatalogEntry | undefined,
  favicon: string | undefined,
): Suggestion {
  return {
    id: `history:${entry.host}`,
    kind: "history",
    title: match?.name || entry.title || entry.host,
    subtitle: entry.host,
    badge: match?.categoryName || undefined,
    url: entry.url,
    // The catalogue's artwork is curated, so it outranks the site's own
    // icon; the favicon is what a stranger to the catalogue gets.
    logoUrl: match?.logoUrl || favicon,
    appearance: match?.appearance,
    dappId: match?.id,
    isFavorite: match?.isFavorite,
    historyHost: entry.host,
  };
}

function navigateSuggestion(
  intent: Extract<OmniboxIntent, { kind: "url" }>,
): Suggestion {
  return {
    id: "navigate",
    kind: "navigate",
    title: intent.url.replace(/^https:\/\//, ""),
    // The verb lives in the row's trailing label, so the subtitle says
    // what the thing IS rather than repeating what tapping it does.
    subtitle: "Web address",
    url: intent.url,
  };
}

function searchSuggestion(query: string, url: string): Suggestion {
  return {
    id: "search",
    kind: "search",
    title: query,
    subtitle: SEARCH_ENGINE_NAME,
    url,
  };
}

/** Zero state: what to show the moment the bar is focused, before typing. */
function buildZeroState(
  args: BuildSuggestionsArgs,
  recentLimit: number,
  appsLimit: number,
): SuggestionListItem[] {
  const items: SuggestionListItem[] = [];
  const catalogByHost = indexByHost(args.catalog);

  const recent = [...args.history]
    .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
    .slice(0, recentLimit);

  const usedDappIds = new Set<string>();
  if (recent.length > 0) {
    items.push({ type: "header", id: "h:recent", label: "Recent" });
    for (const entry of recent) {
      const match = catalogByHost.get(entry.host);
      if (match) usedDappIds.add(match.id);
      const suggestion = historySuggestion(
        entry,
        match,
        args.favicons?.get(entry.host),
      );
      items.push({ type: "row", id: suggestion.id, suggestion });
    }
  }

  // Favourites first, then the editorially popular ones.
  const suggested = [...args.catalog]
    .filter((entry) => !usedDappIds.has(entry.id))
    .filter((entry) => entry.isFavorite || entry.isPopular)
    .sort(
      (a, b) =>
        Number(b.isFavorite) - Number(a.isFavorite) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, appsLimit);

  if (suggested.length > 0) {
    items.push({ type: "header", id: "h:apps", label: "Suggested apps" });
    for (const entry of suggested) {
      const suggestion = catalogSuggestion(entry);
      items.push({ type: "row", id: suggestion.id, suggestion });
    }
  }

  return items;
}

function indexByHost(
  catalog: readonly CatalogEntry[],
): Map<string, CatalogEntry> {
  const byHost = new Map<string, CatalogEntry>();
  for (const entry of catalog) {
    const host = hostOfUrl(entry.websiteUrl);
    if (host && !byHost.has(host)) byHost.set(host, entry);
  }
  return byHost;
}

/**
 * Builds the full suggestion list for what is currently typed.
 *
 * Order is deliberate and mirrors a phone browser: the literal
 * interpretation of the input first (so a typed URL is always one tap
 * away and never buried under fuzzy matches), then places you have been,
 * then apps from the catalogue, then the web-search escape hatch last.
 */
export function buildSuggestions(
  args: BuildSuggestionsArgs,
): SuggestionListItem[] {
  const recentLimit = args.recentLimit ?? DEFAULT_RECENT_LIMIT;
  const appsLimit = args.appsLimit ?? DEFAULT_APPS_LIMIT;
  const now = args.now ?? Date.now();
  const query = normalise(args.query);

  if (!query) return buildZeroState(args, recentLimit + 1, appsLimit);

  const items: SuggestionListItem[] = [];
  const intent = parseOmnibox(args.query);

  if (intent?.kind === "url") {
    const suggestion = navigateSuggestion(intent);
    items.push({ type: "row", id: suggestion.id, suggestion });
  }

  // Once the input reads as a URL, its host is the far better match key:
  // scoring "https://app.uniswap.org" against a catalogue whose entries are
  // named "Uniswap" and hosted at app.uniswap.org finds nothing, which left
  // a typed or pasted URL showing no app card at all.
  const keys = [query];
  if (intent?.kind === "url") {
    const host = intent.host.replace(/^www\./, "");
    if (host !== query) keys.push(host);
  }
  const best = (score: (key: string) => number): number =>
    keys.reduce((acc, key) => Math.max(acc, score(key)), -1);

  const catalogByHost = indexByHost(args.catalog);

  const historyMatches = args.history
    .map((entry) => ({
      entry,
      score: best((key) => scoreHistoryEntry(entry, key, now)),
    }))
    .filter((scored) => scored.score >= 0)
    .sort(
      (a, b) =>
        b.score - a.score || b.entry.lastVisitedAt - a.entry.lastVisitedAt,
    )
    .slice(0, recentLimit);

  const usedDappIds = new Set<string>();
  if (historyMatches.length > 0) {
    items.push({ type: "header", id: "h:recent", label: "Recent" });
    for (const { entry } of historyMatches) {
      const match = catalogByHost.get(entry.host);
      if (match) usedDappIds.add(match.id);
      const suggestion = historySuggestion(
        entry,
        match,
        args.favicons?.get(entry.host),
      );
      items.push({ type: "row", id: suggestion.id, suggestion });
    }
  }

  const catalogMatches = args.catalog
    .filter((entry) => !usedDappIds.has(entry.id))
    .map((entry) => ({
      entry,
      score: best((key) => scoreCatalogEntry(entry, key)),
    }))
    .filter((scored) => scored.score >= 0)
    .sort(
      (a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name),
    )
    .slice(0, appsLimit);

  if (catalogMatches.length > 0) {
    items.push({ type: "header", id: "h:apps", label: "Apps" });
    for (const { entry } of catalogMatches) {
      const suggestion = catalogSuggestion(entry);
      items.push({ type: "row", id: suggestion.id, suggestion });
    }
  }

  // The web-search escape hatch always sits last, so it is available
  // without ever displacing a real match. Offered even when the input
  // parsed as a URL: "jup.ag" is a site, but it may also be what the user
  // meant to look up.
  const trimmed = args.query.trim();
  const suggestion = searchSuggestion(trimmed, searchUrlFor(trimmed));
  items.push({ type: "row", id: suggestion.id, suggestion });

  return items;
}
