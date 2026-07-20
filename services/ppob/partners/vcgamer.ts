/**
 * vcGamer PPOB categorizer.
 *
 * Splits the "Pulsa & Data Package" catalog into two tabs by matching the
 * variant name against vcGamer's naming conventions. The patterns below
 * were derived from the full live catalog (726 variants, 658 distinct
 * names across all 7 operators: Telkomsel, XL, Indosat, Axis, By.U,
 * Smartfren, Tri). Validated split: every data package matched
 * `DATA_PATTERN`; every remaining row (pulsa nominal, active-period
 * extension, voice) fell to `phone_credit`. Zero conflicts, zero
 * unclassified — see `vcgamer.test.ts`.
 *
 * Decision rule: DATA is the discriminating signal. Anything a data
 * package carries — a GB/MB quota, or a data-plan family name (Internet,
 * Freedom, HOTROD, AlwaysOn, Xtra Combo, AIGO, Videomax, …) — routes to
 * "data". Everything else is a non-data top-up (airtime nominal, card
 * validity, voice minutes) and routes to "phone_credit".
 */

import type { TProductVariant } from "@/api/types/product";
import type {
  PpobCategorizer,
  PpobCategory,
  PpobCategoryKey,
  PpobNameFacets,
} from "../types";

const PROVIDER_PREFIX =
  /^\s*(?:Telkomsel|Indosat|Smartfren|Tri|Three|Xl|Axis|By\.?U)\b/i;
const SIZE_TIER_SUFFIX = /\s+(?:XXXL|XXL|XL|XS|S|M|L)\+?$/i;
const QUOTA_TOKEN = /(\d+(?:[.,]\d+)?)\s*(GB|MB)\b/gi;

/**
 * Package family, provider-agnostic. Strips provider name, quota,
 * validity, price and separator tokens off the variant name; collapses
 * trailing size tiers ("Xtra Combo Flex L/M/XXL" -> "Xtra Combo Flex").
 * Derived + validated against the full live catalog (see the family
 * analysis in `vcgamer.test.ts`).
 */
function extractFamily(rawName: string): string | null {
  let s = rawName.trim();
  s = s.replace(/\(.*?\)/g, " "); // parentheticals
  s = s.replace(/\d+(?:[.,]\d+)?\s*(?:GB|MB)\b/gi, " "); // quota
  s = s.replace(/\d+\s*(?:Hari|Bulan|Menit)\b/gi, " "); // validity / minutes
  s = s.replace(/\bBerlaku\b/gi, " ");
  s = s.replace(/\b\d{1,3}(?:[.,]\d{3})+\b/g, " "); // rupiah / points amounts
  s = s.replace(/^\s*Voucher\s+/i, " "); // leading "Voucher"
  s = s.replace(PROVIDER_PREFIX, " "); // leading operator name
  s = s.replace(/[+/]/g, " "); // combo separators
  s = s.replace(/\b\d+\b/g, " "); // leftover bare numbers
  s = s.replace(/\s+/g, " ").trim();
  let prev = "";
  while (prev !== s) {
    prev = s;
    s = s.replace(SIZE_TIER_SUFFIX, "").trim();
  }
  return s || null;
}

/** Total data quota in MB (GB = 1000 MB), summed across combo tokens. */
function extractDataMb(rawName: string): number | null {
  QUOTA_TOKEN.lastIndex = 0;
  let total = 0;
  let found = false;
  let m: RegExpExecArray | null;
  while ((m = QUOTA_TOKEN.exec(rawName)) !== null) {
    found = true;
    const value = Number.parseFloat(m[1].replace(",", "."));
    if (Number.isFinite(value)) {
      total += m[2].toUpperCase() === "GB" ? value * 1000 : value;
    }
  }
  return found ? Math.round(total) : null;
}

/** Validity in days (Bulan counted as 30); `null` when the name has none. */
function extractValidityDays(rawName: string): number | null {
  let days: number | null = null;
  const hari = rawName.match(/(\d+)\s*Hari\b/i);
  if (hari) days = Number.parseInt(hari[1], 10);
  const bulan = rawName.match(/(\d+)\s*Bulan\b/i);
  if (bulan) {
    const asDays = Number.parseInt(bulan[1], 10) * 30;
    days = days === null ? asDays : Math.max(days, asDays);
  }
  return days;
}

const CATEGORIES: readonly PpobCategory[] = [
  { key: "phone_credit", label: "Phone Credit" },
  { key: "data", label: "Data" },
  // Safety net — only ever populated (and thus only ever shown) by a
  // variant that matches neither DATA_PATTERN nor PHONE_CREDIT_PATTERN.
  { key: "other", label: "Other" },
] as const;

/**
 * Data-package signals. Matches when the name carries either:
 *   1. a data quota — `1 GB`, `1.5 GB`, `500 MB`, `1GB` (space optional,
 *      decimal `.`/`,` allowed); or
 *   2. a data-plan family keyword vcGamer uses across operators.
 *
 * Examples routed here: "Data Internet Sakti 1.5 GB 7 Hari",
 * "Freedom Internet 10 GB 30 Hari", "HOTROD 1 GB 2 Hari",
 * "Xtra Combo Flex XL", "Telkomsel Data Flash 10.000" (a data plan whose
 * label is a rupiah amount — the `Data` keyword still catches it).
 */
const DATA_PATTERN =
  /\d(?:[.,]\d+)?\s*(?:GB|MB)\b|\bInternet\b|\bData\b|\bKuota\b|\bAlwaysOn\b|\bHOTROD\b|\bFreedom\b|\bXtra\s*Combo\b|\bXTRA\s*ON\b|\bAIGO\b|\bVideomax\b/i;

/**
 * Positive signals for non-data top-ups. Now load-bearing: a name that
 * matches neither this nor `DATA_PATTERN` routes to `other` (not silently
 * to phone credit), so a new/unrecognized product family surfaces in its
 * own tab instead of being mislabeled. Covers pulsa nominal ("Pulsa
 * Reguler 5.000", "5.000 Reguler", "Telkomsel 5.000"), card validity
 * ("Tambah Masa Aktif Kartu 5 Hari") and voice ("Telepon Unlimited … 60
 * Menit"). Validated to match all 199 non-data rows in the live catalog.
 */
const PHONE_CREDIT_PATTERN =
  /\bPulsa\b|\bReguler\b|\bMasa\s*Aktif\b|\bTelepon\b|\bMenit\b|^(?:Telkomsel|Indosat|Smartfren|Tri|Three|Xl|Axis|By\.?U)\s+[\d.]+$|^Voucher\s+\w+\s+[\d.]+$/i;

export function createVcGamerCategorizer(): PpobCategorizer {
  return {
    vendor: "vcGamer",
    categories: CATEGORIES,
    categorize(variant: TProductVariant): PpobCategoryKey {
      const name = (variant.name ?? "").trim();

      if (DATA_PATTERN.test(name)) return "data";
      if (PHONE_CREDIT_PATTERN.test(name)) return "phone_credit";

      // Neither pattern matched — likely a new vcGamer product family the
      // regexes don't know yet. Route it to `other` so it stays visible
      // (never silently hidden or mislabeled) and warn in dev so we can
      // teach the regexes. The `typeof` guard keeps this a safe no-op
      // under vitest/Node where the RN `__DEV__` global is undefined.
      const isDev = typeof __DEV__ !== "undefined" && __DEV__;
      if (isDev) {
        console.warn(
          `[ppob/vcGamer] unrecognized variant name, routed to "other": "${name}"`,
        );
      }
      return "other";
    },
    extractFacets(variant: TProductVariant): PpobNameFacets {
      const name = (variant.name ?? "").trim();
      return {
        family: extractFamily(name),
        dataMb: extractDataMb(name),
        validityDays: extractValidityDays(name),
      };
    },
  };
}
