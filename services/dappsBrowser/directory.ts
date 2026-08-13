/**
 * Shaping and ordering for the dApps hub directory.
 *
 * The hub is two lists over one corpus: a short "Jump back in" strip of
 * places the user already has a relationship with, and a ranked directory
 * of everything the catalogue knows about. Both are derived here so the
 * ordering rules are pure, RN-free and unit-testable, exactly like
 * `suggest.ts` next door (the address bar's twin of this file).
 *
 * The corpus itself comes from the per-category endpoints, since the API
 * has no `GET /dapps` root route — see `hooks/dapps-browser/useDappDirectory.ts`.
 */

import type { TAppearance, TDapp } from "@/api/types/dapp";
import { hostOfUrl } from "./suggest";

/** One dApp as the dense directory row renders it. */
export interface DirectoryEntry {
  id: string;
  name: string;
  description: string;
  websiteUrl: string;
  logoUrl: string;
  appearance?: TAppearance | null;
  categoryId: string;
  categoryName: string;
  /** Bare host, the second half of the metadata line. */
  host: string;
  isFavorite: boolean;
  isPopular: boolean;
  /** Some wallet currently holds a permission grant for this host. */
  isConnected: boolean;
  sortOrder: number;
}

/** One chip in the "Jump back in" strip. */
export interface JumpBackInChip {
  /** Stable across sources: the host is the identity of a place. */
  id: string;
  label: string;
  url: string;
  logoUrl?: string;
  appearance?: TAppearance | null;
  /** Fallback glyph when the entry has no logo. */
  initial: string;
  isConnected: boolean;
}

/** History, narrowed to what this module reads. */
export interface VisitedSite {
  url: string;
  host: string;
  title: string;
  lastVisitedAt: number;
}

/** A starred dApp, from the local-first favourites store. */
export interface FavoriteSite {
  id: string;
  name: string;
  websiteUrl: string;
  logoUrl?: string;
  appearance?: TAppearance | null;
}

const DEFAULT_CHIP_LIMIT = 10;

/** "All" is a sentinel tab id, never a category id from the API. */
export const ALL_CATEGORY_ID = "all";

const firstLetter = (value: string): string => {
  const trimmed = value.trim();
  return trimmed ? trimmed[0].toUpperCase() : "?";
};

export function toDirectoryEntry(
  dapp: TDapp,
  options: {
    isFavorite: (id: string) => boolean;
    connectedHosts: ReadonlySet<string>;
  },
): DirectoryEntry | null {
  if (!dapp.id || !dapp.websiteUrl) return null;
  const host = hostOfUrl(dapp.websiteUrl);
  return {
    id: dapp.id,
    name: dapp.name ?? "",
    description: dapp.description ?? "",
    websiteUrl: dapp.websiteUrl,
    logoUrl: dapp.logoUrl ?? "",
    appearance: dapp.appearance,
    categoryId: dapp.categoryId ?? dapp.category?.id ?? "",
    categoryName: dapp.category?.name ?? "",
    host,
    // Favourites are local-first, so the MMKV view wins over whatever the
    // server flag said when this row was cached.
    isFavorite: options.isFavorite(dapp.id),
    isPopular: Boolean(dapp.isPopular),
    isConnected: host ? options.connectedHosts.has(host) : false,
    sortOrder: dapp.sortOrder ?? 0,
  };
}

/**
 * Ranked directory for one tab.
 *
 * The order is a chart, not a personalisation: editorially popular apps
 * first, then the backend's `sortOrder`, then alphabetical. Favourites and
 * live sessions deliberately do NOT float to the top here, because the
 * rank numbers beside each row would stop meaning anything if they moved
 * per user. Whatever is personal to the user is one strip above, in the
 * chips.
 */
export function buildDirectory(args: {
  entries: readonly DirectoryEntry[];
  categoryId: string;
}): DirectoryEntry[] {
  const { entries, categoryId } = args;
  const scoped =
    categoryId === ALL_CATEGORY_ID
      ? [...entries]
      : entries.filter((entry) => entry.categoryId === categoryId);

  return scoped.sort(
    (a, b) =>
      Number(b.isPopular) - Number(a.isPopular) ||
      a.sortOrder - b.sortOrder ||
      a.name.localeCompare(b.name),
  );
}

/**
 * The "Jump back in" strip: recently visited sites first, then starred
 * apps the user has not opened lately. One entry per host, so a site that
 * is both visited and starred takes its recent placement and keeps the
 * catalogue's name and logo.
 */
export function buildJumpBackIn(args: {
  history: readonly VisitedSite[];
  entries: readonly DirectoryEntry[];
  favorites: readonly FavoriteSite[];
  connectedHosts: ReadonlySet<string>;
  /**
   * host -> site icon, cached from previous visits. Gives a chip for a
   * site outside the catalogue a real logo instead of its initial.
   */
  favicons?: ReadonlyMap<string, string>;
  limit?: number;
}): JumpBackInChip[] {
  const limit = args.limit ?? DEFAULT_CHIP_LIMIT;
  if (limit <= 0) return [];

  const byHost = new Map<string, DirectoryEntry>();
  for (const entry of args.entries) {
    if (entry.host && !byHost.has(entry.host)) byHost.set(entry.host, entry);
  }

  const chips: JumpBackInChip[] = [];
  const seen = new Set<string>();

  const push = (chip: JumpBackInChip) => {
    if (seen.has(chip.id) || chips.length >= limit) return;
    seen.add(chip.id);
    chips.push(chip);
  };

  const recent = [...args.history].sort(
    (a, b) => b.lastVisitedAt - a.lastVisitedAt,
  );

  for (const visit of recent) {
    if (!visit.host) continue;
    const known = byHost.get(visit.host);
    push({
      id: visit.host,
      label: known?.name || visit.title || visit.host,
      url: known?.websiteUrl || visit.url,
      // Curated artwork first, then the site's own icon; the initial is
      // only for a site that has offered neither.
      logoUrl: known?.logoUrl || args.favicons?.get(visit.host) || undefined,
      appearance: known?.appearance,
      initial: firstLetter(known?.name || visit.title || visit.host),
      isConnected: args.connectedHosts.has(visit.host),
    });
  }

  for (const favorite of args.favorites) {
    if (!favorite.websiteUrl) continue;
    const host = hostOfUrl(favorite.websiteUrl);
    if (!host) continue;
    const known = byHost.get(host);
    push({
      id: host,
      label: favorite.name || known?.name || host,
      url: favorite.websiteUrl,
      logoUrl:
        favorite.logoUrl ||
        known?.logoUrl ||
        args.favicons?.get(host) ||
        undefined,
      appearance: favorite.appearance ?? known?.appearance,
      initial: firstLetter(favorite.name || host),
      isConnected: args.connectedHosts.has(host),
    });
  }

  return chips;
}

/**
 * Two-digit rank label. The list is a chart, so 1 reads as "01" and the
 * column keeps its width until the catalogue passes 99 apps.
 */
export function rankLabel(index: number): string {
  return String(index + 1).padStart(2, "0");
}

/**
 * Metadata line under a directory row: category, then where a tap goes.
 *
 * The design calls for the chains an app runs on, which the API does not
 * expose on `TDapp` yet. Until it does, the host is the honest substitute:
 * it is the one piece of information on this row the user can check a tap
 * against. Add the chains ahead of the host when the field lands.
 */
export function metaLine(entry: DirectoryEntry): string {
  return [entry.categoryName, entry.host].filter(Boolean).join("  ·  ");
}
