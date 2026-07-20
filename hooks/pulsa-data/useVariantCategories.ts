import { useMemo, useState } from "react";
import type { TProductVariant } from "@/api/types/product";
import { groupVariantsByCategory, type PpobCategoryKey } from "@/services/ppob";

interface UseVariantCategoriesResult {
  /**
   * `true` when the resolved partner splits this product into more than
   * one non-empty category (i.e. the tab bar should render). `false` when
   * there's no categorizer for the vendor, or every variant lands in a
   * single bucket — the caller then shows the flat list unchanged.
   */
  showTabs: boolean;
  groups: ReturnType<typeof groupVariantsByCategory>;
  activeKey: PpobCategoryKey;
  setActiveKey: (key: PpobCategoryKey) => void;
  /** Variants for the active tab, or all variants when tabs are hidden. */
  activeVariants: TProductVariant[];
}

/**
 * Splits a product's variants into PPOB categories (Phone Credit / Data)
 * via the space-docked categorizer registry and tracks the selected tab.
 * Falls back to the flat variant list for undocked partners or
 * single-category products, so nothing regresses when categorization
 * doesn't apply.
 */
export function useVariantCategories(
  variants: TProductVariant[] | undefined,
): UseVariantCategoriesResult {
  const groups = useMemo(() => groupVariantsByCategory(variants), [variants]);

  const showTabs = (groups?.length ?? 0) > 1;

  const [selected, setSelected] = useState<PpobCategoryKey | null>(null);

  // Resolve the effective tab: the user's pick if it still has a group,
  // otherwise the first group. Derived (not stored) so it self-heals when
  // the product — and thus its groups — changes on provider switch.
  const activeKey: PpobCategoryKey =
    (selected && groups?.some((g) => g.key === selected) ? selected : null) ??
    groups?.[0]?.key ??
    "phone_credit";

  const activeVariants = useMemo(() => {
    if (!showTabs || !groups) return variants ?? [];
    return groups.find((g) => g.key === activeKey)?.variants ?? [];
  }, [showTabs, groups, activeKey, variants]);

  return {
    showTabs,
    groups,
    activeKey,
    setActiveKey: setSelected,
    activeVariants,
  };
}
