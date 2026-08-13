/**
 * Local browsing history for the dApps browser.
 *
 * Keyed by host, one entry per site, so the suggestion list stays short
 * and each row is a place rather than a page. The recorded URL keeps its
 * path but drops query and fragment (see `toHistoryUrl`), because those
 * carry session tokens, referral codes and wallet addresses that have no
 * business on disk.
 *
 * MMKV is not encrypted, so this is deliberately the minimum that makes
 * the address bar useful: host, title, count, timestamp. Nothing here
 * leaves the device, and `clear()` is wired to the Clear browsing data
 * action in the connection manager.
 */

import { storage } from "@/lib/storage/mmkv";
import { FaviconStore } from "./faviconStore";
import { parseUrl, SEARCH_ENGINE_URL, toHistoryUrl } from "./omnibox";

const HISTORY_KEY = "takumipay_browser_history";

/** Beyond this the least-recently-visited entries are evicted. */
const MAX_ENTRIES = 100;

/**
 * Repeat navigations inside this window count as one visit. Single-page
 * dApps fire a navigation state change on every route change, which would
 * otherwise inflate `visitCount` into a meaningless number.
 */
const VISIT_WINDOW_MS = 30_000;

export interface BrowserHistoryEntry {
  /** Origin plus path, no query or fragment. */
  url: string;
  /** Lowercased host, without `www.`. The primary key. */
  host: string;
  title: string;
  visitCount: number;
  lastVisitedAt: number;
}

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Cached, sorted view handed to `useSyncExternalStore`. It must keep the
 * same identity between mutations: returning a fresh array from
 * `getSnapshot` on every render is an infinite re-render loop.
 */
let snapshot: BrowserHistoryEntry[] | null = null;

function emit(): void {
  snapshot = null;
  for (const listener of listeners) listener();
}

function read(): BrowserHistoryEntry[] {
  const raw = storage.getString(HISTORY_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is BrowserHistoryEntry =>
        Boolean(entry) &&
        typeof entry.host === "string" &&
        typeof entry.url === "string" &&
        typeof entry.lastVisitedAt === "number",
    );
  } catch {
    return [];
  }
}

function write(entries: BrowserHistoryEntry[]): void {
  storage.set(HISTORY_KEY, JSON.stringify(entries));
}

/** The search engine is plumbing, not a place the user chose to visit. */
const searchEngineHost = parseUrl(SEARCH_ENGINE_URL)?.host ?? "";

export const BrowserHistoryStore = {
  /** Most recently visited first. Stable identity until the next write. */
  list(): BrowserHistoryEntry[] {
    if (snapshot === null) {
      snapshot = read().sort((a, b) => b.lastVisitedAt - a.lastVisitedAt);
    }
    return snapshot;
  },

  /**
   * Records a committed top-frame navigation. Silently ignores anything
   * not worth remembering (non-https, unparseable, the search engine).
   */
  record({ url, title }: { url: string; title?: string }): void {
    const normalised = toHistoryUrl(url);
    if (!normalised) return;

    const parsed = parseUrl(normalised);
    if (!parsed) return;
    const host = parsed.host.replace(/^www\./, "");
    if (!host || host === searchEngineHost) return;

    const now = Date.now();
    const entries = read();
    const existing = entries.find((entry) => entry.host === host);

    if (existing) {
      const isNewVisit = now - existing.lastVisitedAt > VISIT_WINDOW_MS;
      existing.url = normalised;
      existing.title = title?.trim() || existing.title;
      existing.lastVisitedAt = now;
      if (isNewVisit) existing.visitCount += 1;
    } else {
      entries.push({
        url: normalised,
        host,
        title: title?.trim() || host,
        visitCount: 1,
        lastVisitedAt: now,
      });
    }

    entries.sort((a, b) => b.lastVisitedAt - a.lastVisitedAt);
    write(entries.slice(0, MAX_ENTRIES));
    emit();
  },

  remove(host: string): void {
    // The cached icon is a record of the same visit, so it goes with it.
    // Forgetting a site while keeping its logo would be a strange kind of
    // forgetting.
    FaviconStore.remove(host);
    const entries = read();
    const next = entries.filter((entry) => entry.host !== host);
    if (next.length === entries.length) return;
    write(next);
    emit();
  },

  clear(): void {
    FaviconStore.clear();
    write([]);
    emit();
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
