import React, { memo, useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import BrandMarkTile from "./BrandMarkTile";

const MATTE_BLACK = "#20222c";
const BRAND_RED = "#c71c4b";
const TILE_SIZE = 112;
const TRACK_WIDTH = 132;
const TRACK_HEIGHT = 4;
const BAR_WIDTH = TRACK_WIDTH * 0.42;

type DappLoadingOverlayProps = {
  // Bare hostname of the page being loaded (e.g. "jup.ag"). Optional so
  // the loader still renders cleanly before we have a URL.
  host?: string;
};

/**
 * Shown over the WebView while a dApp boots.
 *
 * Deliberately not a spinner with a logo in the middle, which is what
 * every app ships and what this screen used to do. The hero is
 * `BrandMarkTile`, the same miniature-browser-frame object the error and
 * blocked pages lead with, so the three states of "no page yet" are one
 * object rather than three unrelated illustrations.
 *
 * Motion is a loading bar rather than a spin: a browser is a thing that
 * makes progress, and a left-to-right sweep says that where a rotating
 * arc says "busy, no idea how long". Purely decorative, no data, no error
 * text.
 */
const DappLoadingOverlay = memo<DappLoadingOverlayProps>(
  function DappLoadingOverlay({ host }) {
    const sweep = useSharedValue(0);
    const breathe = useSharedValue(0);

    useEffect(() => {
      sweep.value = withRepeat(
        // Eased rather than linear so the bar accelerates in and settles
        // out, which reads as effort instead of a conveyor belt.
        withTiming(1, { duration: 1250, easing: Easing.inOut(Easing.cubic) }),
        -1,
        false,
      );
      breathe.value = withRepeat(
        withTiming(1, { duration: 1900, easing: Easing.inOut(Easing.quad) }),
        -1,
        true,
      );
    }, [sweep, breathe]);

    const barStyle = useAnimatedStyle(() => ({
      transform: [
        {
          translateX: interpolate(
            sweep.value,
            [0, 1],
            [-BAR_WIDTH, TRACK_WIDTH],
          ),
        },
      ],
    }));

    // A few percent of scale, just enough that the tile feels alive
    // without turning into a heartbeat.
    const tileStyle = useAnimatedStyle(() => ({
      transform: [{ scale: interpolate(breathe.value, [0, 1], [1, 1.035]) }],
    }));

    return (
      <View style={styles.overlay} pointerEvents="none">
        <Animated.View style={tileStyle}>
          <BrandMarkTile size={TILE_SIZE} />
        </Animated.View>

        <View style={styles.track}>
          <Animated.View style={[styles.bar, barStyle]} />
        </View>

        {host ? (
          <Text style={styles.host} numberOfLines={1}>
            {host}
          </Text>
        ) : null}
      </View>
    );
  },
);

export default DappLoadingOverlay;

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#f5f6f9",
    alignItems: "center",
    justifyContent: "center",
  },
  track: {
    marginTop: 28,
    width: TRACK_WIDTH,
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    backgroundColor: "rgba(32,34,44,0.08)",
    overflow: "hidden",
  },
  bar: {
    width: BAR_WIDTH,
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    backgroundColor: BRAND_RED,
  },
  host: {
    marginTop: 14,
    maxWidth: 240,
    color: MATTE_BLACK,
    fontSize: 13,
    fontWeight: "500",
    opacity: 0.45,
  },
});
