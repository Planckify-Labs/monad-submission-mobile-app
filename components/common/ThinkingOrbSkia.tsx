// Skia renderer behind `ThinkingOrb`. Import `./ThinkingOrb`, never this
// file: that wrapper checks the binary actually has Skia before loading it.
//
// Adapted from thinking-orbs-native, Copyright (c) 2026 Jakub Antalik,
// MIT License (full text: node_modules/thinking-orbs/LICENSE, same author
// and terms). Source: github.com/Jakubantalik/Libraries.dev, under
// packages/thinking-orbs/ports/react-native. That port is not published
// to npm, so the renderer lives here; the geometry is NOT
// re-implemented. It comes from `thinking-orbs/engine`, the same compiled
// frame functions the web component runs, and this file only turns each
// frame's dot list into Skia draw calls.
//
// Differences from upstream:
//   - `color` tints the ink. The web package has this prop but the RN port
//     lacks it; the ramp below is the web's `inkColor`, so depth still
//     reads as near dots in full color fading toward the substrate.
//   - Light substrate by default instead of following the OS scheme. The
//     agent surfaces are light-only, and under OS dark mode an `auto` orb
//     would invert its ink on a white chip.
//   - `decorative` hides it from screen readers where a text label beside
//     it already says the same thing.
//
// Threading (from upstream): each frame is recorded into an SkPicture on
// the JS thread and handed to Skia through a shared value, so a frame is
// one picture record plus one UI-thread draw, not a React render.

import {
  Canvas,
  createPicture,
  PaintStyle,
  Picture,
  Skia,
  type SkPaint,
  type SkPicture,
} from "@shopify/react-native-skia";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppState, View, type ViewStyle } from "react-native";
import Reanimated, {
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import {
  MODE_FRAMES,
  type OrbSize,
  type OrbState,
  resolvePreset,
} from "thinking-orbs/engine";

export type { OrbState };

export interface ThinkingOrbProps {
  /** Which animation to show. @default "working" */
  state?: OrbState;
  /** Tuned size preset: 64 (avatar scale) or 20 (inline scale). @default 64 */
  size?: OrbSize;
  /** Ink tint, `#rgb` or `#rrggbb`. Grayscale when absent. */
  color?: string;
  /** Ink ramp for a dark substrate (fades toward black, not white). */
  dark?: boolean;
  /** Speed multiplier on top of the preset's tuned speed. @default 1 */
  speed?: number;
  /** Freeze on the current frame. */
  paused?: boolean;
  /**
   * Bloom in (grow from the center while fading up) when this turns true,
   * shrink away when it turns false. Keep the orb mounted and toggle this
   * rather than mounting on demand: a freshly mounted Skia canvas needs a
   * moment before it can draw, which swallows most of an entrance.
   * @default true
   */
  visible?: boolean;
  /**
   * Render at this many dp while keeping the `size` preset's geometry.
   * The canvas is sized to it and the vector frame scaled in, so it stays
   * sharp, unlike a transform on the view.
   */
  displaySize?: number;
  /** Hide from screen readers when adjacent text already labels it. */
  decorative?: boolean;
  /** Overrides the per-state default label. */
  accessibilityLabel?: string;
  style?: ViewStyle;
}

const LABELS: Record<OrbState, string> = {
  working: "Working",
  searching: "Searching",
  solving: "Solving",
  listening: "Listening",
  connecting: "Connecting",
  weaving: "Weaving",
  composing: "Composing",
  breathing: "Thinking",
  shaping: "Shaping",
};

/** The static frame reduced-motion users see, same instant as the web. */
const REDUCED_MOTION_T = 0.6;

// Presence transition (appear/disappear), shared with ThinkingEdgesSkia
// so the two arrive and leave together. It runs on the UI thread through
// Reanimated, not in the JS render loop: the moments it plays (a message
// just sent, a turn just finished) are when the JS thread is busiest, and
// a JS-driven fade got two or three frames there and read as a pop.
// Skia's Android canvas is a TextureView, so a parent view's opacity and
// transform apply to it.
const ENTER_MS = 500;
const EXIT_MS = 320;
/** Scale the orb blooms out from, as a fraction of its full size. */
const BLOOM_FROM = 0.6;

/** 0..1 on the UI thread: eases in when `visible` turns true, out when false. */
export function usePresence(
  visible: boolean,
  instant = false,
): SharedValue<number> {
  const shown = useSharedValue(0);
  useEffect(() => {
    const target = visible ? 1 : 0;
    shown.value = instant
      ? target
      : withTiming(
          target,
          visible
            ? { duration: ENTER_MS, easing: Easing.out(Easing.cubic) }
            : { duration: EXIT_MS, easing: Easing.in(Easing.cubic) },
        );
  }, [visible, instant, shown]);
  return shown;
}

/** How long the JS loop keeps drawing after hiding, so the fade-out shows live frames. */
const DRAW_TAIL_S = EXIT_MS / 1000 + 0.15;

/**
 * Run a JS render loop for a presence-faded Skia view: draw every frame
 * while `visible`, keep drawing for the fade-out after it turns false,
 * then clear and stop, so a hidden view costs nothing. `drawing` tracks
 * whether anything is on screen, so a view that was never shown doesn't
 * spin up a loop just to fade nothing. Returns the effect cleanup.
 */
export function startDrawLoop(
  visible: boolean,
  drawing: { current: boolean },
  draw: (now: number) => void,
  clear: () => void,
): () => void {
  if (!visible && !drawing.current) {
    clear();
    return () => {};
  }
  const hiddenAt = visible ? Number.POSITIVE_INFINITY : nowSeconds();
  let raf = 0;
  let running = true;
  const frame = () => {
    const now = nowSeconds();
    if (now - hiddenAt > DRAW_TAIL_S) {
      drawing.current = false;
      clear();
      return;
    }
    drawing.current = true;
    draw(now);
    if (running) raf = requestAnimationFrame(frame);
  };
  frame();
  return () => {
    running = false;
    cancelAnimationFrame(raf);
  };
}

export type TRgb = { r: number; g: number; b: number };

/**
 * Write one mark's color into `out` (RGBA floats for `SkPaint.setColor`).
 * `white` is the engine's paper-theme ink value, 0 = nearest/darkest.
 * With a tint the grey ramp becomes a ramp on the tint (the web
 * package's `inkColor`): toward white on a light substrate, toward black
 * on a dark one. Quantised to 8-bit like the canvas painter, so
 * platforms land on identical colors.
 */
export function writeInk(
  out: Float32Array,
  white: number,
  alpha: number,
  tint: TRgb | undefined,
  dark: boolean,
): void {
  const w = Math.min(1, Math.max(0, white));
  if (tint) {
    const ramp = (c: number) =>
      Math.round(dark ? c * (1 - w) : c + (255 - c) * w) / 255;
    out[0] = ramp(tint.r);
    out[1] = ramp(tint.g);
    out[2] = ramp(tint.b);
  } else {
    const g = Math.round((dark ? 1 - w : w) * 255) / 255;
    out[0] = g;
    out[1] = g;
    out[2] = g;
  }
  out[3] = alpha;
}

export function parseHex(color: string | undefined): TRgb | undefined {
  if (!color) return undefined;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return undefined;
  const hex =
    m[1].length === 3
      ? m[1]
          .split("")
          .map((c) => c + c)
          .join("")
      : m[1];
  const n = Number.parseInt(hex, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** One clock for every orb on screen so several stay in phase. */
export function nowSeconds(): number {
  return performance.now() / 1000;
}

/** True while foregrounded; the render loop stops otherwise. */
export function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState !== "background");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) =>
      setActive(s !== "background"),
    );
    return () => sub.remove();
  }, []);
  return active;
}

export function SkiaThinkingOrb({
  state = "working",
  size = 64,
  color,
  dark = false,
  speed = 1,
  paused = false,
  visible = true,
  displaySize,
  decorative = false,
  accessibilityLabel,
  style,
}: ThinkingOrbProps) {
  const reduced = useReducedMotion();
  const appActive = useAppActive();

  // Shared value, not React state: Skia redraws on write, so a frame never
  // goes through a React render + Fabric commit.
  const empty = useMemo(() => createPicture(() => {}), []);
  const picture = useSharedValue<SkPicture>(empty);

  // One paint per pass, mutated in place; a fresh SkPaint per dot would
  // allocate hundreds of native objects a frame.
  const paints = useMemo(
    () => ({ fill: Skia.Paint(), stroke: Skia.Paint() }),
    [],
  );
  const rgba = useRef(new Float32Array(4)).current;
  // Whether frames are on screen (see startDrawLoop).
  const drawingRef = useRef(false);
  const shown = usePresence(visible, reduced);
  const bloomStyle = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ scale: BLOOM_FROM + (1 - BLOOM_FROM) * shown.value }],
  }));

  const {
    mode,
    speed: baseSpeed,
    opts,
  } = useMemo(() => resolvePreset(state, size), [state, size]);
  const effSpeed = baseSpeed * speed;
  const box = displaySize ?? size;
  const zoom = box / size;
  const tint = useMemo(() => parseHex(color), [color]);

  useEffect(() => {
    const { fill, stroke } = paints;
    fill.setAntiAlias(true);
    stroke.setAntiAlias(true);
    stroke.setStyle(PaintStyle.Stroke);

    const build = MODE_FRAMES[mode];

    const setInk = (paint: SkPaint, white: number, alpha: number) => {
      writeInk(rgba, white, alpha, tint, dark);
      paint.setColor(rgba);
    };

    // Draws the full orb; appearing and disappearing are the wrapper's
    // job (bloomStyle), on the UI thread.
    const record = (t: number) => {
      const frame = build(size, t, opts);
      picture.value = createPicture(
        (canvas) => {
          if (zoom !== 1) canvas.scale(zoom, zoom);
          // lines first, so nodes sit on top of their edges
          for (const l of frame.lines) {
            setInk(stroke, l.white, l.a ?? 1);
            stroke.setStrokeWidth(l.w);
            canvas.drawLine(l.x1, l.y1, l.x2, l.y2, stroke);
          }
          // dots arrive z-sorted into draw order
          for (const d of frame.dots) {
            setInk(fill, d.white, d.a ?? 1);
            canvas.drawCircle(d.x, d.y, d.r, fill);
          }
        },
        Skia.XYWHRect(0, 0, box, box),
      );
    };
    const clear = () => {
      picture.value = empty;
    };

    // No loop: reduced motion shows the static frame; paused or
    // backgrounded holds one frame so the orb is never blank.
    if (reduced || paused || !appActive) {
      if (visible) record(reduced ? REDUCED_MOTION_T : nowSeconds() * effSpeed);
      else clear();
      drawingRef.current = visible;
      return;
    }

    return startDrawLoop(
      visible,
      drawingRef,
      (now) => record(now * effSpeed),
      clear,
    );
  }, [
    mode,
    opts,
    size,
    box,
    zoom,
    tint,
    dark,
    effSpeed,
    paused,
    visible,
    reduced,
    appActive,
    paints,
    rgba,
    picture,
    empty,
  ]);

  const a11y =
    decorative || !visible
      ? {
          accessible: false,
          accessibilityElementsHidden: true,
          importantForAccessibility: "no-hide-descendants" as const,
        }
      : {
          accessible: true,
          accessibilityRole: "image" as const,
          accessibilityLabel: accessibilityLabel ?? LABELS[state],
        };

  return (
    <View {...a11y} style={[{ width: box, height: box }, style]}>
      <Reanimated.View style={[{ width: box, height: box }, bloomStyle]}>
        <Canvas style={{ width: box, height: box }}>
          <Picture picture={picture} />
        </Canvas>
      </Reanimated.View>
    </View>
  );
}
