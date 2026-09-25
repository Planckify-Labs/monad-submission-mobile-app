import { type AudioRecorder, useAudioRecorderState } from "expo-audio";
import React, { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";

const BAR_COUNT = 40;
const BAR_WIDTH = 3;
const BAR_GAP = 2;
const MIN_HEIGHT = 1.5;
export const MAX_HEIGHT = 22;
export const POLL_INTERVAL_MS = 50;
const BAR_COLOR = "#999";
const FLOOR_DB = -60;

// expo-audio reports metering in dB (typically -160..0). Voice peaks
// land between -25 and -5 dB, so we clamp the floor at -60 dB (just
// below background-noise level) and apply a square-root curve so soft
// speech still moves the bars visibly without exploding loud peaks.
export function meteringToNorm(metering: number | undefined): number {
  if (metering === undefined || !Number.isFinite(metering)) return 0;
  const clamped = Math.max(FLOOR_DB, Math.min(0, metering));
  const linear = (clamped - FLOOR_DB) / -FLOOR_DB;
  return Math.sqrt(linear);
}

const BAR_INDICES: ReadonlyArray<number> = Array.from(
  { length: BAR_COUNT },
  (_, i) => i,
);

type BarProps = {
  index: number;
  samples: { value: number[] };
  marginRight: number;
};

function Bar({ index, samples, marginRight }: BarProps) {
  // Each bar reads its own slot out of the shared samples array. The
  // animated style re-evaluates on the UI thread whenever the array is
  // reassigned — no JS-side re-render per tick.
  const style = useAnimatedStyle(() => {
    const norm = samples.value[index] ?? 0;
    return { height: MIN_HEIGHT + norm * (MAX_HEIGHT - MIN_HEIGHT) };
  });
  return (
    <Animated.View
      style={[
        {
          width: BAR_WIDTH,
          borderRadius: BAR_WIDTH / 2,
          backgroundColor: BAR_COLOR,
          marginRight,
        },
        style,
      ]}
    />
  );
}

export function AudioWaveBars({ recorder }: { recorder: AudioRecorder }) {
  const state = useAudioRecorderState(recorder, POLL_INTERVAL_MS);
  const norm = meteringToNorm(state.metering);

  // A single shared value holds the rolling sample window. The newest
  // sample is appended on the right so peaks scroll right-to-left like
  // a live oscilloscope / voice-memo waveform.
  const samples = useSharedValue<number[]>(
    Array.from({ length: BAR_COUNT }, () => 0),
  );

  useEffect(() => {
    samples.value = [...samples.value.slice(1), norm];
  }, [norm, samples]);

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        flex: 1,
        height: MAX_HEIGHT,
        overflow: "hidden",
      }}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      {BAR_INDICES.map((i) => (
        <Bar
          key={i}
          index={i}
          samples={samples}
          marginRight={i < BAR_COUNT - 1 ? BAR_GAP : 0}
        />
      ))}
    </View>
  );
}
