import { Dimensions } from "react-native";

export const { width: SCREEN_WIDTH } = Dimensions.get("window");

export const PROMO_CARD_WIDTH = SCREEN_WIDTH * 0.85;
export const POPULAR_CARD_WIDTH = 200;

/**
 * Hub hero geometry. The card is inset by `HERO_GUTTER` on the left and
 * leaves `HERO_PEEK` of the next slide showing on the right, which is what
 * tells the user the carousel is swipeable without a hint string.
 */
export const HERO_GUTTER = 16;
export const HERO_PEEK = 40;
export const HERO_SPACING = 8;
export const HERO_WIDTH = SCREEN_WIDTH - HERO_GUTTER - HERO_PEEK;
export const HERO_HEIGHT = 184;

/** Rows in the dense directory. Fixed so the list scrolls predictably. */
export const DIRECTORY_ROW_HEIGHT = 72;

export const COLORS = {
  PRIMARY_RED: "#c71c4b",
  MATTE_BLACK: "#000000",
  GRAY_400: "#9CA3AF",
  GRAY_600: "#6B7280",
  WHITE: "#FFFFFF",
  TRANSPARENT_WHITE_20: "rgba(255, 255, 255, 0.2)",
  // Text-selection highlight in the address bar. Android paints
  // `selectionColor` at FULL opacity behind the glyphs, so passing the
  // solid brand red rendered the URL as black on dark red. This is the
  // same red at low alpha, matching the tint used on brand surfaces, so
  // the selection reads as ours and the URL stays legible. iOS derives its
  // own light highlight from a solid tint and keeps the solid value.
  SELECTION_TINT: "rgba(199, 28, 75, 0.22)",
  // Address-bar caution state: a hostname carrying non-ASCII or punycode
  // labels, which may not read the way it renders.
  AMBER: "#b45309",
  // Address-bar shield once the page has finished loading over a good
  // connection. Same emerald as the wallet button's connected border, so
  // the two healthy signals in the bar read as one colour.
  EMERALD: "#047857",
} as const;

export const ANIMATION = {
  SCROLL_THROTTLE: 8,
  SCROLL_TIMEOUT: 250,
  SCROLL_THRESHOLD: 0.3,
  DECELERATION_RATE: 0.98,
} as const;

export const ICON_SIZES = {
  SMALL: 16,
  MEDIUM: 20,
  LARGE: 24,
} as const;

export const CATEGORY_STYLES = {
  defi: {
    color: "#3b82f6",
    bgColor: "bg-blue-500/10",
  },
  dex: {
    color: "#10b981",
    bgColor: "bg-green-500/10",
  },
  gaming: {
    color: "#8b5cf6",
    bgColor: "bg-purple-500/10",
  },
  default: {
    color: COLORS.PRIMARY_RED,
    bgColor: "bg-light-primary-red/10",
  },
} as const;
