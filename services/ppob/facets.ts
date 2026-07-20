/**
 * Filter facets for the PPOB catalog — the data model behind the filter
 * sheet (docs reference: the "Paket data" filter). Everything is derived
 * from the *current* set of variants, so the chips shown are always
 * provider-appropriate: XL surfaces "Xtra Combo"/"HOTROD", Telkomsel
 * surfaces "Data Flash"/"Data Combo Sakti", etc. No hardcoded families.
 *
 * Partner-specific parsing (family / quota / validity) comes from the
 * docked categorizer's optional `extractFacets`; price comes from the
 * generic `ProductPrice` rows. A partner without `extractFacets` yields
 * zero sections → the UI hides the filter entry entirely.
 */

import type { TProductVariant } from "@/api/types/product";
import { ppobCategorizerRegistry } from "./registry";
import type { PpobCategorizer, PpobNameFacets } from "./types";

export type PpobFacetKind = "family" | "price" | "quota" | "validity";

/** A single selectable chip. `id` encodes the predicate (see `optionMatches`). */
export interface PpobFacetOption {
  id: string;
  label: string;
}

export interface PpobFacetSection {
  kind: PpobFacetKind;
  /** Section heading (hand-written). */
  title: string;
  options: PpobFacetOption[];
}

/** Selected option ids per section. Serializable (plain arrays). */
export type PpobFilterSelection = Record<PpobFacetKind, string[]>;

/** All facets of one variant (name-derived + price from ProductPrice). */
export interface PpobDisplayFacets extends PpobNameFacets {
  pricePoints: number | null;
}

type VariantFacets = PpobDisplayFacets;

const FACET_KINDS: PpobFacetKind[] = ["family", "price", "quota", "validity"];

const SECTION_TITLES: Record<PpobFacetKind, string> = {
  family: "Package",
  price: "Price",
  quota: "Quota",
  validity: "Validity",
};

export function emptySelection(): PpobFilterSelection {
  return { family: [], price: [], quota: [], validity: [] };
}

export function countSelected(selection: PpobFilterSelection): number {
  return FACET_KINDS.reduce((n, k) => n + selection[k].length, 0);
}

export function hasAnySelection(selection: PpobFilterSelection): boolean {
  return countSelected(selection) > 0;
}

/** Immutably add/remove an option id within its section. */
export function toggleFacetOption(
  selection: PpobFilterSelection,
  kind: PpobFacetKind,
  id: string,
): PpobFilterSelection {
  const current = selection[kind];
  const next = current.includes(id)
    ? current.filter((x) => x !== id)
    : [...current, id];
  return { ...selection, [kind]: next };
}

/** The section a selected option id belongs to (its encoded prefix). */
export function facetKindOf(optionId: string): PpobFacetKind {
  return optionId.split(":")[0] as PpobFacetKind;
}

// ---------------------------------------------------------------------------
// Facet computation
// ---------------------------------------------------------------------------

function priceOf(variant: TProductVariant): number | null {
  const raw = variant.ProductPrice?.[0]?.sellPrice;
  if (raw == null) return null;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : null;
}

function facetsOf(
  variant: TProductVariant,
  categorizer: PpobCategorizer,
): VariantFacets {
  const name = categorizer.extractFacets?.(variant) ?? {
    family: null,
    dataMb: null,
    validityDays: null,
  };
  return { ...name, pricePoints: priceOf(variant) };
}

/**
 * Public per-variant facets for card display — resolves the categorizer
 * from the variant's vendor. All name-derived fields are `null` when no
 * categorizer is docked / it has no `extractFacets`; price still comes
 * from `ProductPrice`.
 */
export function describeVariant(variant: TProductVariant): PpobDisplayFacets {
  const vendor = variant.ProductPrice?.[0]?.vendor?.name;
  const categorizer = ppobCategorizerRegistry.resolve(vendor);
  const name = categorizer?.extractFacets?.(variant) ?? {
    family: null,
    dataMb: null,
    validityDays: null,
  };
  return { ...name, pricePoints: priceOf(variant) };
}

/** Human "1 GB" / "1.5 GB" / "800 MB" from MB, or `null`. */
export function formatQuota(dataMb: number | null): string | null {
  if (dataMb == null) return null;
  if (dataMb >= 1000) {
    const gb = dataMb / 1000;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  }
  return `${dataMb} MB`;
}

/** Human "7 days" / "1 day" from a day count, or `null`. */
export function formatValidity(days: number | null): string | null {
  if (days == null) return null;
  return `${days} ${days === 1 ? "day" : "days"}`;
}

// ---------------------------------------------------------------------------
// Fixed bucket definitions (quota, validity). `lo` exclusive, `hi` inclusive
// (hi = null => open-ended). Encoded into option ids as "<kind>:<lo>:<hi>".
// ---------------------------------------------------------------------------

interface Bucket {
  lo: number;
  hi: number | null;
  label: string;
}

const QUOTA_BUCKETS: Bucket[] = [
  { lo: -1, hi: 999, label: "< 1 GB" },
  { lo: 999, hi: 5000, label: "1-5 GB" },
  { lo: 5000, hi: 10000, label: "5-10 GB" },
  { lo: 10000, hi: 20000, label: "10-20 GB" },
  { lo: 20000, hi: null, label: "> 20 GB" },
];

const VALIDITY_BUCKETS: Bucket[] = [
  { lo: 0, hi: 3, label: "≤ 3 days" },
  { lo: 3, hi: 7, label: "4-7 days" },
  { lo: 7, hi: 30, label: "8-30 days" },
  { lo: 30, hi: null, label: "> 30 days" },
];

function bucketId(kind: PpobFacetKind, b: Bucket): string {
  return `${kind}:${b.lo}:${b.hi ?? ""}`;
}

function inBucket(
  value: number | null,
  lo: number,
  hi: number | null,
): boolean {
  if (value == null) return false;
  return value > lo && (hi === null || value <= hi);
}

// ---------------------------------------------------------------------------
// Price: auto-scaled buckets from the current price range.
// ---------------------------------------------------------------------------

/** Round to a "nice" value (quarter-magnitude step) for readable boundaries. */
function niceRound(x: number): number {
  if (x <= 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(x));
  const step = magnitude / 4;
  return Math.max(step, Math.round(x / step) * step);
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.floor(((sorted.length - 1) * p) / 100);
  return sorted[idx];
}

function buildPriceOptions(prices: number[]): PpobFacetOption[] {
  const clean = prices
    .filter((p): p is number => p != null)
    .sort((a, b) => a - b);
  // Too few / too flat to bucket meaningfully.
  if (clean.length < 8 || clean[0] === clean[clean.length - 1]) return [];

  const cuts = [25, 50, 75]
    .map((p) => niceRound(percentile(clean, p)))
    .filter((v, i, arr) => v > 0 && arr.indexOf(v) === i)
    .sort((a, b) => a - b);
  if (cuts.length < 2) return [];

  const fmt = (n: number) => n.toLocaleString();
  const options: PpobFacetOption[] = [];
  options.push({ id: `price:-1:${cuts[0]}`, label: `< ${fmt(cuts[0])}` });
  for (let i = 0; i < cuts.length - 1; i++) {
    options.push({
      id: `price:${cuts[i]}:${cuts[i + 1]}`,
      label: `${fmt(cuts[i])} - ${fmt(cuts[i + 1])}`,
    });
  }
  const last = cuts[cuts.length - 1];
  options.push({ id: `price:${last}:`, label: `> ${fmt(last)}` });
  return options;
}

// ---------------------------------------------------------------------------
// Section building
// ---------------------------------------------------------------------------

function buildBucketOptions(
  kind: "quota" | "validity",
  buckets: Bucket[],
  values: (number | null)[],
): PpobFacetOption[] {
  return buckets
    .filter((b) => values.some((v) => inBucket(v, b.lo, b.hi)))
    .map((b) => ({ id: bucketId(kind, b), label: b.label }));
}

function buildFamilyOptions(families: (string | null)[]): PpobFacetOption[] {
  const counts = new Map<string, number>();
  for (const f of families) {
    if (f) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([family]) => ({ id: `family:${family}`, label: family }));
}

/**
 * Build the filter sections for a set of variants. Returns `[]` when no
 * categorizer is docked, the partner has no `extractFacets`, or nothing
 * is filterable — the caller then hides the filter button.
 *
 * A section is included only when it has ≥2 options (a single option
 * can't narrow anything). Family options are drawn only from variants the
 * partner classifies as `data`, so the pulsa tab never shows package
 * chips.
 */
export function buildFacetSections(
  variants: readonly TProductVariant[] | undefined,
): PpobFacetSection[] {
  if (!variants?.length) return [];

  const vendor = variants[0]?.ProductPrice?.[0]?.vendor?.name;
  const categorizer = ppobCategorizerRegistry.resolve(vendor);
  if (!categorizer?.extractFacets) return [];

  const families: (string | null)[] = [];
  const quotas: (number | null)[] = [];
  const validities: (number | null)[] = [];
  const prices: number[] = [];

  for (const v of variants) {
    const f = facetsOf(v, categorizer);
    // Package family is a data-only concept.
    if (categorizer.categorize(v) === "data") families.push(f.family);
    quotas.push(f.dataMb);
    validities.push(f.validityDays);
    if (f.pricePoints != null) prices.push(f.pricePoints);
  }

  const sections: PpobFacetSection[] = [
    {
      kind: "family",
      title: SECTION_TITLES.family,
      options: buildFamilyOptions(families),
    },
    {
      kind: "price",
      title: SECTION_TITLES.price,
      options: buildPriceOptions(prices),
    },
    {
      kind: "quota",
      title: SECTION_TITLES.quota,
      options: buildBucketOptions("quota", QUOTA_BUCKETS, quotas),
    },
    {
      kind: "validity",
      title: SECTION_TITLES.validity,
      options: buildBucketOptions("validity", VALIDITY_BUCKETS, validities),
    },
  ];

  return sections.filter((s) => s.options.length >= 2);
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function optionMatches(optionId: string, facets: VariantFacets): boolean {
  if (optionId.startsWith("family:")) {
    const family = optionId.slice("family:".length);
    return facets.family === family;
  }
  const [kind, loStr, hiStr] = optionId.split(":");
  const lo = Number(loStr);
  const hi = hiStr === "" || hiStr === undefined ? null : Number(hiStr);
  const value =
    kind === "quota"
      ? facets.dataMb
      : kind === "validity"
        ? facets.validityDays
        : kind === "price"
          ? facets.pricePoints
          : null;
  return inBucket(value, lo, hi);
}

/**
 * Filter variants by the selection. Semantics: OR within a section, AND
 * across sections (a variant must satisfy every section that has a
 * selection). An unselected section is ignored.
 */
export function applyFacetFilter(
  variants: readonly TProductVariant[] | undefined,
  selection: PpobFilterSelection,
): TProductVariant[] {
  const list = variants ? [...variants] : [];
  if (!list.length || !hasAnySelection(selection)) return list;

  const vendor = list[0]?.ProductPrice?.[0]?.vendor?.name;
  const categorizer = ppobCategorizerRegistry.resolve(vendor);
  if (!categorizer?.extractFacets) return list;

  const activeKinds = FACET_KINDS.filter((k) => selection[k].length > 0);

  return list.filter((v) => {
    const facets = facetsOf(v, categorizer);
    return activeKinds.every((kind) =>
      selection[kind].some((optId) => optionMatches(optId, facets)),
    );
  });
}
