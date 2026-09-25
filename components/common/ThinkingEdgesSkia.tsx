// Skia renderer behind `ThinkingEdges`. Import `./ThinkingEdges`, never
// this file: that wrapper checks the binary actually has Skia first.
//
// Dotted energy along the left and right screen edges while the agent
// works: the orb's ink (tinted dots, fading toward white with depth),
// rising from the input. Its motion follows the orb's state, so the edges
// say what the agent is doing without words (see thinkingEdgePatterns.ts),
// crossfading when the state changes. Drawn only inside the chat's 16dp side
// padding, so it never overlaps a message or card. It shares the orb's
// presence curve, so the two arrive and leave together: the edges light
// up from the bottom as the orb blooms, and recede downward as it goes.
//
// Same threading as the orb: each frame is recorded into an SkPicture on
// the JS thread and handed to Skia through a shared value. The orb draws
// on the same thread, so dots are bucketed by intensity and the paint
// color changes about a dozen times a frame instead of once per dot.

import {
  Canvas,
  createPicture,
  Picture,
  Skia,
  type SkPicture,
} from "@shopify/react-native-skia";
import { useEffect, useMemo, useRef } from "react";
import { View } from "react-native";
import Reanimated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
} from "react-native-reanimated";
import type { OrbState } from "thinking-orbs/engine";
import {
  nowSeconds,
  parseHex,
  startDrawLoop,
  useAppActive,
  usePresence,
  writeInk,
} from "./ThinkingOrbSkia";
import { EDGE_BLEND_S, edgePattern } from "./thinkingEdgePatterns";

export interface ThinkingEdgesProps {
  /** Rise up the edges when true, recede when false. @default true */
  visible?: boolean;
  /** Height of each strip in dp, measured up from its bottom edge. */
  height: number;
  /** Ink tint, `#rgb` or `#rrggbb`. Grayscale when absent. */
  color?: string;
  /** The orb state whose motion the edges take on. @default "working" */
  state?: OrbState;
  /** Hold the current frame, e.g. while scrolled off screen. */
  paused?: boolean;
}

/** Strip width, dp. Every dot stays inside it, under the side padding. */
const STRIP_W = 16;
/** Vertical spacing between dot rows, dp. */
const ROW = 5;
/** Columns from the screen edge inward: x offset (dp) and strength. */
const COLUMNS = [
  { x: 3, s: 1 },
  { x: 7.5, s: 0.72 },
  { x: 12, s: 0.42 },
] as const;
/** Intensity buckets: one paint color per bucket per frame. */
const LEVELS = 12;

type TDot = { x: number; y: number; r: number };

export function SkiaThinkingEdges({
  visible = true,
  height,
  color,
  state = "working",
  paused = false,
}: ThinkingEdgesProps) {
  const reduced = useReducedMotion();
  const appActive = useAppActive();

  const empty = useMemo(() => createPicture(() => {}), []);
  const left = useSharedValue<SkPicture>(empty);
  const right = useSharedValue<SkPicture>(empty);
  const paint = useMemo(() => Skia.Paint(), []);
  const rgba = useRef(new Float32Array(4)).current;
  const tint = useMemo(() => parseHex(color), [color]);
  // Whether frames are on screen (see startDrawLoop).
  const drawingRef = useRef(false);

  // Appearing and disappearing run on the UI thread (see usePresence): a
  // clip grows up from the bottom, revealing the strips as if the energy
  // climbs out of the input, while they fade in; leaving reverses it.
  // Purely ambient, so under reduced motion they never show.
  const shown = usePresence(visible && !reduced);
  const revealStyle = useAnimatedStyle(() => ({
    height: shown.value * height,
    opacity: shown.value,
  }));

  // The state lives in refs the render loop reads each frame, so a state
  // change crossfades the motion without restarting the loop or the
  // appear/disappear transition.
  const stateRef = useRef(state);
  const prevStateRef = useRef(state);
  const changedAtRef = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    if (stateRef.current === state) return;
    prevStateRef.current = stateRef.current;
    stateRef.current = state;
    changedAtRef.current = nowSeconds();
  }, [state]);

  useEffect(() => {
    paint.setAntiAlias(true);

    // One side's picture. `phase` puts the right side half a cycle apart,
    // so the two edges don't move as a mirror image.
    const recordSide = (
      t: number,
      phase: number,
      mirror: boolean,
    ): SkPicture => {
      const current = edgePattern(stateRef.current);
      const previous = edgePattern(prevStateRef.current);
      const blend = Math.min(1, (t - changedAtRef.current) / EDGE_BLEND_S);
      const buckets: TDot[][] = Array.from({ length: LEVELS }, () => []);
      for (let fromBottom = ROW / 2; fromBottom < height; fromBottom += ROW) {
        const u = fromBottom / height;
        // Strongest low, near the orb; soft at the very bottom.
        const envelope = (1 - u) ** 0.8 * Math.min(1, fromBottom / 24);
        for (let i = 0; i < COLUMNS.length; i++) {
          const col = COLUMNS[i];
          const live = current(fromBottom, i, phase, t, height);
          const raw =
            blend >= 1
              ? live
              : previous(fromBottom, i, phase, t, height) * (1 - blend) +
                live * blend;
          const intensity = envelope * col.s * raw;
          const level = Math.round(intensity * (LEVELS - 1));
          if (level <= 0) continue;
          const x =
            col.x + Math.sin(fromBottom * 0.045 + t * 1.3 + phase + i) * 1.1;
          buckets[Math.min(LEVELS - 1, level)].push({
            x: mirror ? STRIP_W - x : x,
            y: height - fromBottom,
            r: 0.55 + 1.6 * intensity,
          });
        }
      }
      return createPicture(
        (canvas) => {
          for (let level = 1; level < LEVELS; level++) {
            const dots = buckets[level];
            if (dots.length === 0) continue;
            const intensity = level / (LEVELS - 1);
            writeInk(
              rgba,
              1 - intensity,
              Math.min(1, 0.3 + intensity),
              tint,
              false,
            );
            paint.setColor(rgba);
            for (const d of dots) canvas.drawCircle(d.x, d.y, d.r, paint);
          }
        },
        Skia.XYWHRect(0, 0, STRIP_W, height),
      );
    };

    const record = (t: number) => {
      left.value = recordSide(t, 0, false);
      right.value = recordSide(t, Math.PI, true);
    };
    const clear = () => {
      left.value = empty;
      right.value = empty;
    };

    const show = visible && !reduced;
    if (paused || !appActive) {
      // Hold one frame while paused or backgrounded; the loop resumes
      // after.
      if (show) record(nowSeconds());
      else clear();
      drawingRef.current = show;
      return;
    }
    return startDrawLoop(show, drawingRef, record, clear);
  }, [
    visible,
    height,
    reduced,
    paused,
    appActive,
    tint,
    paint,
    rgba,
    left,
    right,
    empty,
  ]);

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ position: "absolute", left: 0, right: 0, bottom: 0, height }}
    >
      <Reanimated.View
        style={[
          {
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            overflow: "hidden",
          },
          revealStyle,
        ]}
      >
        <Canvas
          style={{
            position: "absolute",
            left: 0,
            bottom: 0,
            width: STRIP_W,
            height,
          }}
        >
          <Picture picture={left} />
        </Canvas>
        <Canvas
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
            width: STRIP_W,
            height,
          }}
        >
          <Picture picture={right} />
        </Canvas>
      </Reanimated.View>
    </View>
  );
}
