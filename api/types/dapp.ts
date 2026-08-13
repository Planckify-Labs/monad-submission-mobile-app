/**
 * Shared visual-styling contract (v1) for dapps, categories and
 * promotions. The backend stores it as a single JSON column
 * (`appearance`); the mobile client validates it and fills design-token
 * defaults via `resolveAppearance` (see `utils/dappAppearance.ts`).
 *
 * Evolution rules — keep this safely extensible:
 *  - additive only: new fields are always optional
 *  - never repurpose/remove a key; bump `v` only on a breaking change
 *  - readers tolerate unknown keys (zod `.passthrough()`)
 */
export type TColorFill =
  | { type: "solid"; color: string }
  | { type: "gradient"; colors: string[]; angle?: number };

export interface TAppearance {
  v: 1;
  /** Card / banner surface fill. */
  background?: TColorFill;
  /** Primary text + icon color on that surface. */
  foreground?: string;
  /** CTA / badge / active-state highlight. */
  accent?: string;
  /** Tile behind the logo. */
  logoBackground?: TColorFill;
}

export interface TDappCategory {
  id: string;
  name: string;
  description: string;
  iconUrl: string;
  appearance?: TAppearance | null;
  sortOrder?: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  _count?: {
    dapps: number;
  };
}

export interface TDapp {
  id: string;
  name: string;
  description: string;
  logoUrl: string;
  websiteUrl: string;
  categoryId: string;
  /** Generalized styling tokens; replaces the old flat `bgColor`. */
  appearance?: TAppearance | null;
  sortOrder?: number;
  isPopular: boolean;
  isSponsor: boolean;
  isHighlight: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  category: TDappCategory;
  isFavorite: boolean;
}

/** Editorial banner shown in the hub carousel — not 1:1 with a dapp. */
export interface TDappPromotion {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  imageUrl: string;
  appearance?: TAppearance | null;
  /**
   * Label on the banner's call-to-action button ("Trade now", "Start
   * earning"). Optional and additive: the hero renders a house default
   * when the backend does not send one.
   */
  ctaLabel?: string | null;
  /** Where the banner opens; falls back to the linked dapp's site. */
  targetUrl: string | null;
  dappId: string | null;
  isSponsored: boolean;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type DappListResponse = TDapp[];

export type DappCategoryListResponse = TDappCategory[];

export type DappPromotionListResponse = TDappPromotion[];

export interface TDappSearchParams {
  name?: string;
  categoryId?: string;
  isPopular?: boolean;
  isSponsor?: boolean;
  isHighlight?: boolean;
  isActive?: boolean;
  isFavorite?: boolean;
  take?: number;
  cursor?: string;
}
