// Dotted energy along the screen edges while the agent works, in the
// orb's visual language. The renderer is `./ThinkingEdgesSkia`; this
// wrapper applies the brand tint and the Skia guard (`./skiaAvailable`).
// It is purely ambient, so without Skia it renders nothing rather than a
// fallback.

import type { ComponentType } from "react";
import { isSkiaAvailable } from "./skiaAvailable";
import type { ThinkingEdgesProps } from "./ThinkingEdgesSkia";
import { ORB_BRAND_COLOR } from "./ThinkingOrb";

export type { ThinkingEdgesProps } from "./ThinkingEdgesSkia";

// `undefined` = not loaded yet, `null` = Skia absent from this binary.
let skiaEdges: ComponentType<ThinkingEdgesProps> | null | undefined;

function loadSkiaEdges(): ComponentType<ThinkingEdgesProps> | null {
  if (skiaEdges !== undefined) return skiaEdges;
  if (!isSkiaAvailable()) {
    skiaEdges = null;
  } else {
    const renderer =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("./ThinkingEdgesSkia") as typeof import("./ThinkingEdgesSkia");
    skiaEdges = renderer.SkiaThinkingEdges;
  }
  return skiaEdges;
}

export function ThinkingEdges(props: ThinkingEdgesProps) {
  const SkiaEdges = loadSkiaEdges();
  if (!SkiaEdges) return null;
  return <SkiaEdges {...props} color={props.color ?? ORB_BRAND_COLOR} />;
}
