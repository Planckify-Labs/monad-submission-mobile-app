export { bootPpobCategorizers } from "./boot";
export {
  groupVariantsByCategory,
  resolveVendorFromVariants,
} from "./categorize";
export {
  applyFacetFilter,
  buildFacetSections,
  countSelected,
  describeVariant,
  emptySelection,
  facetKindOf,
  formatQuota,
  formatValidity,
  hasAnySelection,
  type PpobDisplayFacets,
  type PpobFacetKind,
  type PpobFacetOption,
  type PpobFacetSection,
  type PpobFilterSelection,
  toggleFacetOption,
} from "./facets";
export { ppobCategorizerRegistry } from "./registry";
export type {
  PpobCategorizer,
  PpobCategory,
  PpobCategoryGroup,
  PpobCategoryKey,
  PpobNameFacets,
} from "./types";
