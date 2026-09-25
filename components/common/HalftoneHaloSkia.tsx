// Skia renderer behind `HalftoneHalo`. Import `./HalftoneHalo`, never
// this file: that wrapper checks the binary actually has Skia first.
//
// The Replying pattern runs along each ring, with the ring's circumference
// mapped onto a whole number of the pattern's wavelengths so the flow
// loops without a seam. Same ink, dot bucketing and threading as the edge
// strips; appearing and disappearing run on the UI thread (usePresence).

import {
  Canvas,
  createPicture,
  Picture,
  Skia,
  type SkPicture,
} from "@shopify/react-native-skia";
import { useEffect, useMemo, useRef } from "react";
import Reanimated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
} from "react-native-reanimated";
import { HALO_RINGS, type HalftoneHaloProps, haloSize } from "./HalftoneHalo";
import {
  nowSeconds,
  parseHex,
  startDrawLoop,
  useAppActive,
  usePresence,
  writeInk,
} from "./ThinkingOrbSkia";
import { COMPOSING_WAVELENGTH, edgePattern } from "./thinkingEdgePatterns";

const TAU = Math.PI * 2;
/** Spacing between dots along a ring, dp. */
const DOT_SPACING = 5;
/** Whole Replying waves around each ring, so the loop has no seam. */
const WAVE_CYCLES = 3;
/** Strength left on the side the ring fades toward. */
const FADE_FLOOR = 0.2;
/** Scale the halo blooms out from. */
const BLOOM_FROM = 0.85;
/** Intensity buckets: one paint color per bucket per frame. */
const LEVELS = 12;

type TRingDot = {
  x: number;
  y: number;
  /** Position along the ring in pattern units. */
  along: number;
  ring: number;
  weight: number;
};

export function SkiaHalftoneHalo({
  visible,
  radius,
  color,
  fadeToward,
  paused = false,
}: HalftoneHaloProps) {
  const reduced = useReducedMotion();
  const appActive = useAppActive();
  const size = haloSize(radius);

  const empty = useMemo(() => createPicture(() => {}), []);
  const picture = useSharedValue<SkPicture>(empty);
  const paint = useMemo(() => Skia.Paint(), []);
  const rgba = useRef(new Float32Array(4)).current;
  const tint = useMemo(() => parseHex(color), [color]);
  // Whether frames are on screen (see startDrawLoop).
  const drawingRef = useRef(false);

  // Purely decorative, so under reduced motion it never shows.
  const show = visible && !reduced;
  const shown = usePresence(show);
  const bloomStyle = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ scale: BLOOM_FROM + (1 - BLOOM_FROM) * shown.value }],
  }));

  // Dot positions never change for a given radius: lay them out once.
  const dots = useMemo(() => {
    const center = size / 2;
    const patternLength = WAVE_CYCLES * COMPOSING_WAVELENGTH;
    const out: TRingDot[] = [];
    HALO_RINGS.forEach((ring, i) => {
      const r = radius + ring.gap;
      const n = Math.max(12, Math.round((TAU * r) / DOT_SPACING));
      for (let j = 0; j < n; j++) {
        const theta = (j / n) * TAU;
        let weight: number = ring.s;
        if (fadeToward !== undefined) {
          // Angular distance to the fade direction, 0..PI.
          const d = Math.abs(
            ((((theta - fadeToward) % TAU) + TAU + Math.PI) % TAU) - Math.PI,
          );
          weight *= FADE_FLOOR + (1 - FADE_FLOOR) * (d / Math.PI) ** 1.2;
        }
        out.push({
          x: center + Math.cos(theta) * r,
          y: center + Math.sin(theta) * r,
          along: (j / n) * patternLength,
          ring: i,
          weight,
        });
      }
    });
    return out;
  }, [radius, fadeToward, size]);

  useEffect(() => {
    paint.setAntiAlias(true);
    const replying = edgePattern("composing");

    const record = (t: number) => {
      const buckets: { x: number; y: number; r: number }[][] = Array.from(
        { length: LEVELS },
        () => [],
      );
      for (const d of dots) {
        const intensity = d.weight * replying(d.along, d.ring, 0, t, 0);
        const level = Math.round(intensity * (LEVELS - 1));
        if (level <= 0) continue;
        buckets[Math.min(LEVELS - 1, level)].push({
          x: d.x,
          y: d.y,
          r: 0.55 + 1.6 * intensity,
        });
      }
      picture.value = createPicture(
        (canvas) => {
          for (let level = 1; level < LEVELS; level++) {
            const marks = buckets[level];
            if (marks.length === 0) continue;
            const intensity = level / (LEVELS - 1);
            writeInk(
              rgba,
              1 - intensity,
              Math.min(1, 0.3 + intensity),
              tint,
              false,
            );
            paint.setColor(rgba);
            for (const m of marks) canvas.drawCircle(m.x, m.y, m.r, paint);
          }
        },
        Skia.XYWHRect(0, 0, size, size),
      );
    };
    const clear = () => {
      picture.value = empty;
    };

    if (paused || !appActive) {
      if (show) record(nowSeconds());
      else clear();
      drawingRef.current = show;
      return;
    }
    return startDrawLoop(show, drawingRef, record, clear);
  }, [show, paused, appActive, dots, size, tint, paint, rgba, picture, empty]);

  return (
    <Reanimated.View style={[{ width: size, height: size }, bloomStyle]}>
      <Canvas style={{ width: size, height: size }}>
        <Picture picture={picture} />
      </Canvas>
    </Reanimated.View>
  );
}
