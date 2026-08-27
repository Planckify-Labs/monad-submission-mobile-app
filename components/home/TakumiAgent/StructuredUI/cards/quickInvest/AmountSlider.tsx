/**
 * The live amount slider from mockup concept #11 — a plain `PanResponder`
 * track rather than a slider dependency.
 *
 * No new package, for two reasons. The repo ships no slider library, and
 * adding one would put a new module in front of `pollyfills.ts`'s frozen
 * `Object.prototype` (TWV-2026-021 — three crashes so far arrived exactly
 * that way). More decisively, every Reanimated/Gesture-Handler slider needs
 * a `GestureHandlerRootView` above it, and there is none above the agent
 * chat: the only one in the app wraps `app/address-book.tsx`. A
 * `GestureDetector` here would silently receive nothing at all.
 * `PanResponder` is core React Native and needs no root view.
 *
 * ─── Why this measures absolute coordinates ──────────────────────────
 *
 * The obvious implementation reads `e.nativeEvent.locationX`, and it is
 * wrong: `locationX` is relative to whichever view RECEIVED the touch. The
 * moment a finger crosses the thumb, that is the 20px thumb rather than the
 * track, so the position collapses to 0–20 and the value snaps to the
 * minimum, then jumps back on the way off. It reads to the user as the
 * slider fighting them.
 *
 * So the track's own left edge is measured and every event is placed with
 * absolute `pageX`, through the unit-tested `valueAtPageX`. The thumb is
 * additionally `pointerEvents="none"` so it can never be a touch target in
 * the first place — belt and braces, because the same class of bug returns
 * the instant anyone adds another child here.
 *
 * The other half of that bug lived in the caller: bounds derived from the
 * LIVE value grew as the user dragged right, so the thumb chased the
 * finger. `sliderBounds` now takes `openingAmountUsd` to make that
 * unmisreadable.
 */

import { useCallback, useRef, useState } from "react";
import {
  type AccessibilityActionEvent,
  PanResponder,
  type View as RNView,
  Text,
  View,
} from "react-native";
import type { SliderBounds } from "@/services/defi/quickInvest";
import { snapToStep, valueAtPageX } from "@/services/defi/quickInvest";
import { tapFeedback } from "@/utils/hapticsUtils";

const BRAND_RED = "#c71c4b";
const THUMB = 20;
const TRACK = 6;
/** Platform minimum for a comfortable touch target. */
const MIN_HIT_HEIGHT = 44;
/**
 * A fast drag crosses a step every few pixels. Firing a tick on each one
 * saturates the haptic queue and turns a slide into a buzz, so ticks are
 * rate-limited while the VALUE still updates on every step.
 */
const HAPTIC_MIN_GAP_MS = 45;

export default function AmountSlider({
  value,
  bounds,
  onChange,
  disabled = false,
  minLabel,
  maxLabel,
  /** Formats the value for screen readers, e.g. `$750`. */
  formatValue,
}: {
  value: number;
  bounds: SliderBounds;
  onChange: (next: number) => void;
  disabled?: boolean;
  minLabel?: string;
  maxLabel?: string;
  formatValue?: (value: number) => string;
}) {
  const [width, setWidth] = useState(0);

  // Refs, not state: the responder is created once and would otherwise
  // close over the first render's values for the life of the component.
  const trackRef = useRef<RNView>(null);
  const originRef = useRef(0);
  const widthRef = useRef(0);
  const boundsRef = useRef(bounds);
  const onChangeRef = useRef(onChange);
  const lastRef = useRef(value);
  const lastHapticRef = useRef(0);
  boundsRef.current = bounds;
  onChangeRef.current = onChange;
  lastRef.current = value;

  const span = Math.max(1, bounds.max - bounds.min);
  const ratio = Math.min(1, Math.max(0, (value - bounds.min) / span));

  const commit = useCallback((next: number | null) => {
    // Only report real changes: a drag crosses many pixels per step, and a
    // repeat would re-render the whole card for nothing.
    if (next === null || next === lastRef.current) return;
    lastRef.current = next;
    const now = Date.now();
    if (now - lastHapticRef.current >= HAPTIC_MIN_GAP_MS) {
      lastHapticRef.current = now;
      tapFeedback();
    }
    onChangeRef.current(next);
  }, []);

  const emitFromPageX = useCallback(
    (pageX: number) => {
      commit(
        valueAtPageX({
          pageX,
          trackOriginX: originRef.current,
          trackWidth: widthRef.current,
          bounds: boundsRef.current,
        }),
      );
    },
    [commit],
  );

  const responder = useRef(
    PanResponder.create({
      // One finger only. A second touch landing on the track mid-drag would
      // otherwise fight the first for the value.
      onStartShouldSetPanResponder: (e) => e.nativeEvent.touches.length <= 1,
      onMoveShouldSetPanResponder: (e) => e.nativeEvent.touches.length <= 1,
      onPanResponderGrant: (e) => {
        // Re-measured per gesture rather than trusted from layout: the card
        // sits in a scrolling chat, and a stale origin is exactly what puts
        // the value under the wrong finger position. The emit happens INSIDE
        // the callback because `measureInWindow` is async — emitting outside
        // it would use the previous gesture's origin.
        const pageX = e.nativeEvent.pageX;
        trackRef.current?.measureInWindow((x, _y, w) => {
          originRef.current = x;
          if (w > 0) widthRef.current = w;
          emitFromPageX(pageX);
        });
      },
      onPanResponderMove: (e) => emitFromPageX(e.nativeEvent.pageX),
      // The chat list must not steal the gesture mid-drag; a slider that
      // hands over halfway leaves the value wherever the finger happened to
      // be. The grabbable strip is deliberately short so this costs little.
      onPanResponderTerminationRequest: () => false,
    }),
  ).current;

  /**
   * `accessibilityRole="adjustable"` promises TalkBack and VoiceOver that
   * a swipe up/down adjusts this control. Without these actions that
   * promise is empty and the slider is unusable with a screen reader — the
   * role alone does nothing.
   */
  const onAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      const b = boundsRef.current;
      const direction =
        event.nativeEvent.actionName === "increment" ? b.step : -b.step;
      commit(snapToStep(lastRef.current + direction, b));
    },
    [commit],
  );

  const valueText = formatValue ? formatValue(value) : String(value);

  return (
    <View className={disabled ? "opacity-40" : undefined}>
      <View
        ref={trackRef}
        {...(disabled ? {} : responder.panHandlers)}
        onLayout={(e) => {
          widthRef.current = e.nativeEvent.layout.width;
          setWidth(e.nativeEvent.layout.width);
        }}
        // The visible track is 6px; the grabbable area has to survive a
        // thumb and a fingertip.
        style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Amount to invest"
        accessibilityState={{ disabled }}
        accessibilityValue={{
          min: bounds.min,
          max: bounds.max,
          now: value,
          text: valueText,
        }}
        accessibilityActions={
          disabled
            ? undefined
            : [
                { name: "increment", label: "Increase amount" },
                { name: "decrement", label: "Decrease amount" },
              ]
        }
        onAccessibilityAction={disabled ? undefined : onAccessibilityAction}
      >
        <View
          className="rounded-full bg-light-matte-black/10"
          style={{ height: TRACK }}
        >
          <View
            pointerEvents="none"
            className="rounded-full bg-light-primary-red"
            style={{ height: TRACK, width: `${ratio * 100}%` }}
          />
          <View
            // Never a touch target. Without this the thumb becomes the
            // event's view and every position reads relative to its own
            // 20px box instead of the track.
            pointerEvents="none"
            style={{
              position: "absolute",
              left: Math.max(
                0,
                Math.min(width - THUMB, ratio * width - THUMB / 2),
              ),
              top: -(THUMB - TRACK) / 2,
              width: THUMB,
              height: THUMB,
              borderRadius: THUMB / 2,
              backgroundColor: "#ffffff",
              borderWidth: 4,
              borderColor: BRAND_RED,
              shadowColor: "#000",
              shadowOpacity: 0.22,
              shadowRadius: 3,
              shadowOffset: { width: 0, height: 2 },
              elevation: 3,
            }}
          />
        </View>
      </View>
      {minLabel || maxLabel ? (
        <View className="flex-row justify-between -mt-1">
          <Text className="text-[10px] text-gray-400">{minLabel ?? ""}</Text>
          <Text className="text-[10px] text-gray-400">{maxLabel ?? ""}</Text>
        </View>
      ) : null}
    </View>
  );
}
