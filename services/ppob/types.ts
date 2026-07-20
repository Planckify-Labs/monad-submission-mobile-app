/**
 * PPOB (Payment Point Online Bank) product categorization contracts.
 *
 * The "Pulsa & Data Package" catalog is a flat list of variants whose
 * names follow a *partner-specific* naming convention (today every row is
 * fulfilled by the `vcGamer` vendor). To split that flat list into
 * user-facing tabs — "Phone Credit" vs "Data" — we can't hardcode one set
 * of regexes, because the next PPOB partner (Digiflazz, iak, …) will name
 * its products differently.
 *
 * So categorization docks the same way chain capabilities do
 * (`services/walletKit/`, `services/gasAbstraction/`): each partner ships
 * a `PpobCategorizer`, registers it into `ppobCategorizerRegistry` at
 * boot, and shared UI resolves one by vendor via a presence-check —
 * never branching on the vendor string itself. Adding a partner = add a
 * file under `partners/` + one `register()` line in `boot.ts`; no call
 * site changes.
 */

import type { TProductVariant } from "@/api/types/product";

/**
 * Canonical category vocabulary shared by every partner. A new partner
 * that needs another bucket (e.g. "roaming") extends this union — the one
 * shared edit, mirroring how `Namespace` grows when a chain lands. The
 * registry/grouping code treats keys generically, so nothing else changes.
 *
 * `other` is the safety-net bucket for variants a partner recognizes as
 * neither data nor phone credit (a new product family the regexes don't
 * know yet). It's declared last so its tab renders last, and the grouping
 * drops empty categories — so "Other" only ever appears when something
 * genuinely lands in it.
 */
export type PpobCategoryKey = "phone_credit" | "data" | "other";

/** A category tab: stable key + user-facing label. */
export interface PpobCategory {
  key: PpobCategoryKey;
  /** Hand-written UI label (no raw vendor/product strings). */
  label: string;
}

/**
 * Structured facets parsed from a variant's *name*, used to power the
 * filter sheet (package family / data quota / validity). These are
 * partner-specific — vcGamer's naming conventions differ from the next
 * PPOB partner's — so extraction lives on the categorizer. Price is NOT
 * here: it comes from the generic `ProductPrice` rows, so shared code
 * computes it (see `facets.ts`).
 */
export interface PpobNameFacets {
  /**
   * Package/product-line label, provider-agnostic: derived by stripping
   * the operator name, quota, validity and price tokens off the variant
   * name (e.g. "Freedom Internet 10 GB 30 Hari" -> "Freedom Internet").
   * `null` when nothing meaningful remains (e.g. plain pulsa nominal).
   */
  family: string | null;
  /** Total data quota in MB (GB counted as 1000 MB), summed across combo
   * tokens. `null` for non-data variants (pulsa, active-period). */
  dataMb: number | null;
  /** Validity window in days (Bulan counted as 30). `null` when absent. */
  validityDays: number | null;
}

/**
 * One PPOB fulfillment partner's categorizer. `vendor` matches
 * `TVendor.name` (case-insensitive); `categories` is the ordered tab set;
 * `categorize` maps a single variant into one of those keys.
 */
export interface PpobCategorizer {
  /** Vendor identifier — matched against `TVendor.name`, case-insensitive. */
  readonly vendor: string;
  /** Ordered category tabs this partner exposes. */
  readonly categories: readonly PpobCategory[];
  /**
   * Classify one variant into a category key. Always returns a key from
   * `categories` (falls back to the partner's default bucket for
   * unrecognized names) so a variant can never drop out of the catalog.
   */
  categorize(variant: TProductVariant): PpobCategoryKey;
  /**
   * OPTIONAL capability (space docking): parse filterable facets from a
   * variant name. Presence-checked by `facets.ts` — a partner that omits
   * it simply gets no filter sheet, no branch anywhere. vcGamer implements
   * it; a future partner opts in by adding the method.
   */
  extractFacets?(variant: TProductVariant): PpobNameFacets;
}

/** A resolved, non-empty group of variants under one category. */
export interface PpobCategoryGroup {
  key: PpobCategoryKey;
  label: string;
  variants: TProductVariant[];
}
