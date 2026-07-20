import { useEffect, useMemo, useState } from "react";
import type { TProductVariant } from "@/api/types/product";
import {
  applyFacetFilter,
  buildFacetSections,
  countSelected,
  emptySelection,
  type PpobFilterSelection,
} from "@/services/ppob";

interface UsePackageFilterResult {
  /** Facet sections for the current variants; empty => no filter UI. */
  sections: ReturnType<typeof buildFacetSections>;
  /** Committed selection driving the visible list. */
  selection: PpobFilterSelection;
  setSelection: (selection: PpobFilterSelection) => void;
  /** Variants after applying the committed selection. */
  filtered: TProductVariant[];
  /** Number of selected options (for the badge). */
  activeCount: number;
  /** Whether there's anything to filter (drives the Filter button). */
  hasFilters: boolean;
}

/**
 * Owns the committed filter selection for the active tab and derives the
 * filtered variant list. Selection resets whenever `resetKey` changes
 * (product or tab switch) so stale chips never carry across a context
 * where they don't exist.
 */
export function usePackageFilter(
  variants: TProductVariant[] | undefined,
  resetKey: string,
): UsePackageFilterResult {
  const sections = useMemo(() => buildFacetSections(variants), [variants]);

  const [selection, setSelection] = useState<PpobFilterSelection>(
    emptySelection(),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on context change
  useEffect(() => {
    setSelection(emptySelection());
  }, [resetKey]);

  const filtered = useMemo(
    () => applyFacetFilter(variants, selection),
    [variants, selection],
  );

  return {
    sections,
    selection,
    setSelection,
    filtered,
    activeCount: countSelected(selection),
    hasFilters: sections.length > 0,
  };
}
