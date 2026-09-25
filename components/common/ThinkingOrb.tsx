// Dotted "thinking" orb: an animated stand-in for a spinner while the
// agent works. The renderer is `./ThinkingOrbSkia`; this wrapper adds the
// app's design defaults and a guard for binaries without Skia.
//
// Design defaults: brand primary-red ink. The renderer's light substrate
// and `decorative` prop cover the rest (see its header).
//
// Skia guard: see `./skiaAvailable`. Without Skia the orb falls back to
// the spinner it replaced.

import type { ComponentType } from "react";
import { ActivityIndicator, View, type ViewStyle } from "react-native";
import { isSkiaAvailable } from "./skiaAvailable";
import type { ThinkingOrbProps } from "./ThinkingOrbSkia";

export type { OrbState, ThinkingOrbProps } from "./ThinkingOrbSkia";

export const ORB_BRAND_COLOR = "#c71c4b";

// `undefined` = not loaded yet, `null` = Skia absent from this binary.
let skiaOrb: ComponentType<ThinkingOrbProps> | null | undefined;

function loadSkiaOrb(): ComponentType<ThinkingOrbProps> | null {
  if (skiaOrb !== undefined) return skiaOrb;
  if (!isSkiaAvailable()) {
    skiaOrb = null;
  } else {
    const renderer =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("./ThinkingOrbSkia") as typeof import("./ThinkingOrbSkia");
    skiaOrb = renderer.SkiaThinkingOrb;
  }
  return skiaOrb;
}

export function ThinkingOrb(props: ThinkingOrbProps) {
  const color = props.color ?? ORB_BRAND_COLOR;
  const SkiaOrb = loadSkiaOrb();
  if (SkiaOrb) return <SkiaOrb {...props} color={color} />;

  const box = props.displaySize ?? props.size ?? 64;
  const style: ViewStyle = { width: box, height: box };
  // Hold the space so a hidden orb doesn't reflow what's around it.
  if (props.visible === false) return <View style={[style, props.style]} />;
  return (
    <ActivityIndicator
      size={box >= 40 ? "large" : "small"}
      color={color}
      style={[style, props.style]}
      accessibilityElementsHidden={props.decorative}
      importantForAccessibility={
        props.decorative ? "no-hide-descendants" : "auto"
      }
    />
  );
}
