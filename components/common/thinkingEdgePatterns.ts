import type { OrbState } from "thinking-orbs/engine";

/**
 * Raw intensity (0..1) of one dot in an edge strip, before the strip's
 * vertical envelope and column strength are applied.
 *
 * @param fromBottom dp from the strip's bottom edge
 * @param column     0 = outermost column (at the screen edge)
 * @param phase      0 for the left strip, PI for the right one
 * @param t          seconds, on the renderer's clock
 * @param height     strip height in dp
 */
export type TEdgePattern = (
  fromBottom: number,
  column: number,
  phase: number,
  t: number,
  height: number,
) => number;

const TAU = Math.PI * 2;

/** Cheap deterministic 0..1 noise. */
const hash = (a: number, b: number) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/** Waves rising up the edge. The original edge motion; generic "working". */
const flow: TEdgePattern = (fb, i, ph, t) => {
  const wave =
    0.5 + 0.5 * Math.sin(fb * (TAU / 70) - t * TAU * 0.8 + i * 0.9 + ph);
  const swell = 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(fb * 0.013 + t * 0.7 + ph));
  return 0.22 + 0.78 * wave * swell;
};

/** Thinking: the whole strip swells slowly, like breath. */
const breathing: TEdgePattern = (fb, i, ph, t) => {
  const breath = 0.5 + 0.5 * Math.sin(t * 1.7 + ph * 0.25);
  const drift =
    0.5 + 0.5 * Math.sin(fb * (TAU / 110) - t * TAU * 0.3 + i * 0.8 + ph);
  return 0.18 + 0.82 * breath * (0.55 + 0.45 * drift);
};

/** Reading: a bright band scans up and down, like a lookup. */
const searching: TEdgePattern = (fb, _i, ph, t, height) => {
  const band = (0.5 - 0.5 * Math.cos(t * 1.9 + ph * 0.5)) * height * 0.9;
  const d = (fb - band) / 20;
  return 0.12 + 0.88 * Math.exp(-d * d);
};

/** Segment size (dp) and tick (s) of the transaction ladder. */
export const CONFIRM_SEGMENT = 26;
export const CONFIRM_TICK_S = 0.24;

/**
 * Transaction: segments light up bottom to top one tick at a time, the
 * newest brightest, like blocks confirming; then the ladder restarts.
 * Both edges tick together.
 */
const shaping: TEdgePattern = (fb, _i, _ph, t, height) => {
  const segments = Math.ceil(height / CONFIRM_SEGMENT);
  const lit = Math.floor(t / CONFIRM_TICK_S) % (segments + 3);
  const segment = Math.floor(fb / CONFIRM_SEGMENT);
  if (segment < lit - 1) return 0.5;
  if (segment === lit - 1) return 1;
  return 0.08;
};

/** Reconnecting: sparse dots blink out of step, a signal cutting in and out. */
const connecting: TEdgePattern = (fb, i, ph, t) => {
  const h = hash(
    Math.floor(fb / 5) * 7.1 + i * 13.3 + ph * 3.7,
    Math.floor(t * 5),
  );
  return h > 0.78 ? 0.9 : 0.1;
};

/**
 * Wavelength (dp) of the Replying flow. Exported so a closed path (the
 * send button's halo) can fit whole waves and loop without a seam.
 */
export const COMPOSING_WAVELENGTH = 56;

/** Replying: a fast, smooth upward flow while words stream in. */
const composing: TEdgePattern = (fb, i, ph, t) => {
  const wave =
    0.5 +
    0.5 *
      Math.sin(
        fb * (TAU / COMPOSING_WAVELENGTH) - t * TAU * 1.25 + i * 0.9 + ph,
      );
  return 0.2 + 0.8 * wave;
};

const PATTERNS: Partial<Record<OrbState, TEdgePattern>> = {
  breathing,
  searching,
  shaping,
  connecting,
  composing,
};

/** The edge motion for an orb state; unmapped states get the plain flow. */
export function edgePattern(state: OrbState): TEdgePattern {
  return PATTERNS[state] ?? flow;
}

/** How long the edges crossfade from one state's motion to the next. */
export const EDGE_BLEND_S = 0.35;
