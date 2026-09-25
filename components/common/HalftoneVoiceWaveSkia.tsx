// Skia renderer behind `HalftoneVoiceWave`. Import `./HalftoneVoiceWave`,
// never this file: that wrapper checks the binary actually has Skia first.
//
// The live mic level as a sound wave in the orb's dot language: three
// interweaving wave strands drawn as lines of halftone dots, z-sorted
// back to front with the orb's depth shading (the front strand in full
// ink with larger dots, the back ones smaller and faded toward white).
// The strands drift in opposite directions. The voice (noise-gated, see
// voiceLevel) drives height, drift speed and dot size together: speaking
// waves regularly, shouting waves big and fast, and silence settles into
// a calm, near-flat dotted line. The ends taper so the wave swells from
// the center.

import {
  Canvas,
  createPicture,
  Picture,
  Skia,
  type SkPicture,
} from "@shopify/react-native-skia";
import { type AudioRecorder, useAudioRecorderState } from "expo-audio";
import { useEffect, useMemo, useRef, useState } from "react";
import { type LayoutChangeEvent, View } from "react-native";
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import {
  MAX_HEIGHT,
  POLL_INTERVAL_MS,
} from "@/components/home/TakumiAgent/AudioWaveBars";
import {
  nowSeconds,
  parseHex,
  startDrawLoop,
  useAppActive,
  usePresence,
  writeInk,
} from "./ThinkingOrbSkia";
import { createVoiceGate, voiceLevel } from "./voiceLevel";

export interface HalftoneVoiceWaveProps {
  recorder: AudioRecorder;
  /** Ink tint, `#rgb` or `#rrggbb`. Grayscale when absent. */
  color?: string;
}

const TAU = Math.PI * 2;

/**
 * Wave strands, back to front: cycles across the width, drift speed
 * (rad/s, sign = direction), share of the full height, depth (the ink's
 * `white`: 0 = nearest) and base dot radius.
 */
const STRANDS = [
  { cycles: 3.1, speed: 5.3, height: 0.5, depth: 0.6, r: 0.8, phase: 2.1 },
  { cycles: 2.3, speed: -3.4, height: 0.72, depth: 0.35, r: 1.0, phase: 0.9 },
  { cycles: 1.6, speed: 4.2, height: 1, depth: 0, r: 1.3, phase: 0 },
] as const;
/** Spacing between dots along a strand, dp. */
const DOT_SPACING = 3;
/** Share of the full height left in silence: a barely-there ripple. */
const IDLE = 0.03;
/**
 * Drift speed scales with the voice, so loud speech churns harder: this
 * share of each strand's speed at rest, rising to 1 + ENERGY_BOOST at full.
 */
const CALM_SPEED = 0.35;
const ENERGY_BOOST = 1.6;
/** How much bigger the dots get at full voice. */
const DOT_SWELL = 0.45;
/** Amplitude smoothing per second: fast attack, slower release. */
const ATTACK = 18;
const RELEASE = 5;
/** Depth buckets: one paint color per bucket per frame. */
const LEVELS = 12;

export function SkiaHalftoneVoiceWave({
  recorder,
  color,
}: HalftoneVoiceWaveProps) {
  const appActive = useAppActive();
  const recorderState = useAudioRecorderState(recorder, POLL_INTERVAL_MS);

  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) =>
    setWidth(Math.round(e.nativeEvent.layout.width));

  const empty = useMemo(() => createPicture(() => {}), []);
  const picture = useSharedValue<SkPicture>(empty);
  const paint = useMemo(() => Skia.Paint(), []);
  const rgba = useRef(new Float32Array(4)).current;
  const tint = useMemo(() => parseHex(color), [color]);
  const drawingRef = useRef(false);

  // The latest voice level (0 in silence, see voiceLevel), which the
  // render loop eases toward each frame. One gate sample per recorder
  // poll: durationMillis moves on every poll, even when metering repeats.
  const targetRef = useRef(0);
  const gateRef = useRef(createVoiceGate());
  const pollAt = recorderState.durationMillis;
  const metering = recorderState.metering;
  const lastPollRef = useRef<number | null>(null);
  useEffect(() => {
    if (lastPollRef.current === pollAt) return;
    lastPollRef.current = pollAt;
    targetRef.current = voiceLevel(gateRef.current, metering, nowSeconds());
  }, [pollAt, metering]);

  // Fades in on the UI thread when recording starts.
  const shown = usePresence(true);
  const fadeStyle = useAnimatedStyle(() => ({ opacity: shown.value }));

  useEffect(() => {
    paint.setAntiAlias(true);
    const center = MAX_HEIGHT / 2;
    const maxAmplitude = MAX_HEIGHT / 2 - 2;
    let amplitude = 0;
    let last = nowSeconds();
    // Accumulated drift, so speed changes with the voice never jump.
    let drift = 0;

    const record = (now: number) => {
      if (width <= 0) return;
      const dt = Math.min(0.1, now - last);
      last = now;
      const target = targetRef.current;
      const rate = target > amplitude ? ATTACK : RELEASE;
      amplitude += (target - amplitude) * Math.min(1, dt * rate);
      const height = maxAmplitude * (IDLE + (1 - IDLE) * amplitude);
      drift += dt * (CALM_SPEED + ENERGY_BOOST * amplitude);
      const swell = 1 + DOT_SWELL * amplitude;

      const buckets: { x: number; y: number; r: number }[][] = Array.from(
        { length: LEVELS },
        () => [],
      );
      const alphas = new Float32Array(LEVELS);
      for (const strand of STRANDS) {
        for (let x = DOT_SPACING / 2; x < width; x += DOT_SPACING) {
          const u = x / width;
          // Taper to nothing at both ends, so the wave swells from the center.
          const taper = Math.sin(Math.PI * u) ** 1.5;
          const y =
            center +
            height *
              strand.height *
              taper *
              Math.sin(
                TAU * strand.cycles * u + strand.phase + drift * strand.speed,
              );
          const white = Math.min(1, strand.depth + (1 - taper) * 0.55);
          const lvl = Math.round(white * (LEVELS - 1));
          buckets[lvl].push({
            x,
            y,
            r: strand.r * (0.8 + 0.3 * taper) * swell,
          });
          alphas[lvl] = Math.max(alphas[lvl], 0.35 + 0.65 * taper);
        }
      }
      picture.value = createPicture(
        (canvas) => {
          // Farthest (palest) first, so nearer dots sit on top.
          for (let lvl = LEVELS - 1; lvl >= 0; lvl--) {
            const dots = buckets[lvl];
            if (dots.length === 0) continue;
            writeInk(rgba, lvl / (LEVELS - 1), alphas[lvl], tint, false);
            paint.setColor(rgba);
            for (const d of dots) canvas.drawCircle(d.x, d.y, d.r, paint);
          }
        },
        Skia.XYWHRect(0, 0, width, MAX_HEIGHT),
      );
    };
    const clear = () => {
      picture.value = empty;
    };
    if (!appActive) {
      record(nowSeconds());
      return;
    }
    return startDrawLoop(true, drawingRef, record, clear);
  }, [width, appActive, tint, paint, rgba, picture, empty]);

  return (
    <View
      onLayout={onLayout}
      style={{ flex: 1, height: MAX_HEIGHT }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Reanimated.View style={[{ flex: 1 }, fadeStyle]}>
        {width > 0 ? (
          <Canvas style={{ width, height: MAX_HEIGHT }}>
            <Picture picture={picture} />
          </Canvas>
        ) : null}
      </Reanimated.View>
    </View>
  );
}
