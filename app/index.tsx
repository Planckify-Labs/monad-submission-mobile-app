import { useFocusEffect } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  BackHandler,
  Dimensions,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import HomeMain from "@/components/home/Main/HomeMain";
import ScanToPayChatModeFloatingButtons from "@/components/home/Main/ScanToPayChatModeFloatingButtons";
import AgentMode from "@/components/home/TakumiAgent/AgentMode";
import { track } from "@/services/analytics/posthog";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

export default function Home() {
  const scrollViewRef = useRef<ScrollView>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  // Track if agent mode has ever been opened to keep it mounted once visited
  const [hasVisitedAgentMode, setHasVisitedAgentMode] = useState(false);

  const scrollToIndex = useCallback((index: number) => {
    scrollViewRef.current?.scrollTo({
      x: SCREEN_WIDTH * index,
      animated: true,
    });
    setCurrentIndex(index);
  }, []);

  // AgentMode is a ~15-useEffect, reanimated-heavy tree whose first
  // mount costs several hundred ms. We used to pre-mount it via
  // `InteractionManager.runAfterInteractions` right after home idled —
  // but post-unlock that fired while the user's first taps were still
  // in flight and contributed to the "app freeze after unlock" bug.
  // Mount on actual navigation instead. The first tap to switch into
  // chat mode will pay a small lag; every subsequent tap is instant.
  const handleChatModePress = useCallback(
    (trigger: string) => {
      track("feature_opened", { feature: "agent_mode", trigger });
      setHasVisitedAgentMode(true);
      scrollToIndex(1);
    },
    [scrollToIndex],
  );

  // Session start/end is driven by `currentIndex` itself, not by the tap
  // handlers above — that way every path back to Home (hardware back,
  // a future close button, whatever) ends the session, without having to
  // instrument each one individually. Guard on `!== null` so mounting on
  // Home (currentIndex already 0) never fires a spurious "ended" event.
  const agentSessionStartRef = useRef<number | null>(null);
  useEffect(() => {
    if (currentIndex === 1) {
      agentSessionStartRef.current = Date.now();
      track("agent_session_started");
    } else if (agentSessionStartRef.current !== null) {
      const duration_seconds = Math.round(
        (Date.now() - agentSessionStartRef.current) / 1000,
      );
      track("agent_session_ended", { duration_seconds });
      agentSessionStartRef.current = null;
    }
  }, [currentIndex]);

  // Register the hardware-back handler only while Home is the focused
  // screen. If we used a plain useEffect, the handler would stay live
  // even after the agent pushes a route on top of Home — and because
  // BackHandler fires globally in LIFO order (before React Navigation's
  // pop handler), the first back press on that pushed screen would be
  // swallowed here (currentIndex still === 1 → scrollToIndex(0) + return
  // true), so it took two presses to actually leave the screen and the
  // second press jumped straight to Home. useFocusEffect tears the
  // handler down on blur, so pushed screens get a normal back button.
  useFocusEffect(
    useCallback(() => {
      const backHandler = BackHandler.addEventListener(
        "hardwareBackPress",
        () => {
          if (currentIndex === 1) {
            scrollToIndex(0);
            return true;
          }
          return false;
        },
      );

      return () => backHandler.remove();
    }, [currentIndex, scrollToIndex]),
  );

  const { bottom } = useSafeAreaInsets();
  const bottomOffset = Platform.OS === "ios" ? 0 : bottom > 0 ? bottom : 0;
  return (
    <>
      <SystemBars style="dark" />
      <SafeAreaView style={[styles.container]} edges={["top"]}>
        <ScrollView
          ref={scrollViewRef}
          horizontal={true}
          scrollEnabled={false}
          pagingEnabled={true}
          showsHorizontalScrollIndicator={false}
          style={styles.horizontalScroll}
          contentContainerStyle={{ paddingBottom: bottomOffset }}
        >
          <View style={{ width: SCREEN_WIDTH }}>
            <HomeMain onOpenAgentChat={handleChatModePress} />
          </View>
          <View style={{ width: SCREEN_WIDTH }}>
            {hasVisitedAgentMode && <AgentMode isActive={currentIndex === 1} />}
          </View>
        </ScrollView>

        {currentIndex === 0 && (
          <ScanToPayChatModeFloatingButtons
            onChatModePress={() => handleChatModePress("floating_button")}
          />
        )}
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f6f9",
  },
  horizontalScroll: {
    flex: 1,
  },
});
