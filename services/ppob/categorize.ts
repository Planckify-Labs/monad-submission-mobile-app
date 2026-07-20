/**
 * Shared grouping helper — turns a product's flat variant list into the
 * vendor's category groups, dispatching through `ppobCategorizerRegistry`
 * so no UI code ever branches on the vendor string.
 */

import type { TProductVariant } from "@/api/types/product";
import { ppobCategorizerRegistry } from "./registry";
import type { PpobCategoryGroup } from "./types";

/**
 * Read the fulfillment vendor for a product from its variants. Every
 * price row carries its `vendor`; a product is single-vendor in practice
 * (the whole "Telkomsel" product is fulfilled by vcGamer), so the first
 * variant with a priced vendor decides the categorizer.
 */
export function resolveVendorFromVariants(
  variants: readonly TProductVariant[] | undefined,
): string | null {
  if (!variants?.length) return null;
  for (const v of variants) {
    const vendorName = v.ProductPrice?.[0]?.vendor?.name;
    if (vendorName) return vendorName;
  }
  return null;
}

/**
 * Group `variants` into the resolved partner's categories, preserving the
 * partner's declared category order and dropping empty groups.
 *
 * Returns `null` when no categorizer is docked for the product's vendor
 * (or there are no variants) — the caller then renders the catalog flat,
 * exactly as before, so an unknown/new partner never breaks the screen.
 */
export function groupVariantsByCategory(
  variants: readonly TProductVariant[] | undefined,
): PpobCategoryGroup[] | null {
  if (!variants?.length) return null;

  const vendor = resolveVendorFromVariants(variants);
  const categorizer = ppobCategorizerRegistry.resolve(vendor);
  if (!categorizer) return null;

  const buckets = new Map<string, TProductVariant[]>();
  for (const cat of categorizer.categories) buckets.set(cat.key, []);

  for (const variant of variants) {
    const key = categorizer.categorize(variant);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(variant);
    else buckets.set(key, [variant]);
  }

  return categorizer.categories
    .map((cat) => ({
      key: cat.key,
      label: cat.label,
      variants: buckets.get(cat.key) ?? [],
    }))
    .filter((group) => group.variants.length > 0);
}
