// A ring of halftone dots around a circular control, carrying the
// agent's Replying motion (see thinkingEdgePatterns) wrapped around the
// circle. The renderer is `./HalftoneHaloSkia`; this wrapper holds the
// geometry, the brand tint and the Skia guard (`./skiaAvailable`). It is
// purely decorative, so without Skia it renders nothing.
//
// Place it inside a zero-size, absolutely positioned anchor at the
// control's center: it centers itself on that point and never takes
// touches. Render it before its neighbours so opaque ones (an input pill)
// cover any dots that reach them.

import type { ComponentType } from "react";
import { View } from "react-native";
import { isSkiaAvailable } from "./skiaAvailable";
import { ORB_BRAND_COLOR } from "./ThinkingOrb";

export interface HalftoneHaloProps {
  /** Bloom in around the control when true, dissolve when false. */
  visible: boolean;
  /** Radius of the control the halo surrounds, dp. */
  radius: number;
  /** Ink tint, `#rgb` or `#rrggbb`. @default brand primary red */
  color?: string;
  /**
   * Direction (radians; 0 = right, PI = left) the ring fades toward, e.g.
   * a neighbouring control. Omit for an even ring.
   */
  fadeToward?: number;
  /** Hold the current frame, e.g. while covered. */
  paused?: boolean;
}

/** Rings outward from the control: gap from its edge (dp) and strength. */
export const HALO_RINGS = [
  { gap: 4, s: 1 },
  { gap: 8.5, s: 0.72 },
  { gap: 13, s: 0.42 },
] as const;
/** Largest dot radius the renderer draws, dp. */
const MAX_DOT_R = 2.2;

/** Side of the square the halo draws into, for a control of `radius`. */
export function haloSize(radius: number): number {
  return Math.ceil(
    2 * (radius + HALO_RINGS[HALO_RINGS.length - 1].gap + MAX_DOT_R),
  );
}

// `undefined` = not loaded yet, `null` = Skia absent from this binary.
let skiaHalo: ComponentType<HalftoneHaloProps> | null | undefined;

function loadSkiaHalo(): ComponentType<HalftoneHaloProps> | null {
  if (skiaHalo !== undefined) return skiaHalo;
  if (!isSkiaAvailable()) {
    skiaHalo = null;
  } else {
    const renderer =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("./HalftoneHaloSkia") as typeof import("./HalftoneHaloSkia");
    skiaHalo = renderer.SkiaHalftoneHalo;
  }
  return skiaHalo;
}

export function HalftoneHalo(props: HalftoneHaloProps) {
  const SkiaHalo = loadSkiaHalo();
  if (!SkiaHalo) return null;
  const size = haloSize(props.radius);
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        position: "absolute",
        left: -size / 2,
        top: -size / 2,
        width: size,
        height: size,
      }}
    >
      <SkiaHalo {...props} color={props.color ?? ORB_BRAND_COLOR} />
    </View>
  );
}
