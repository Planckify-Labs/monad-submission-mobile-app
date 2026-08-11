import { WifiOff } from "lucide-react-native";
import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Modal,
  Platform,
  Pressable,
  Text,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type UnsupportedChainModalProps = {
  visible: boolean;
  chainName: string;
  onClose: () => void;
  onSwitchNetwork: () => void;
};

const MODAL_HEIGHT = 380;

export default function DepositUnsupportedChainModal({
  visible,
  chainName,
  onClose,
  onSwitchNetwork,
}: UnsupportedChainModalProps) {
  const { bottom } = useSafeAreaInsets();
  const bottomOffset = Platform.OS === "ios" ? 16 : bottom > 0 ? bottom : 0;

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(MODAL_HEIGHT)).current;

  // `mounted` trails `visible` by the length of the exit animation. The
  // sheet used to unmount on the same frame `visible` went false, which
  // both skipped the slide-out and tore down the native dialog window
  // while it was still showing — the state Android is happy to leave
  // stranded over whatever screen comes next.
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) setMounted(true);
  }, [visible]);

  useEffect(() => {
    if (!mounted) return;

    if (visible) {
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.spring(translateY, {
          toValue: 0,
          tension: 65,
          friction: 11,
          useNativeDriver: true,
        }),
      ]).start();
      return;
    }

    const exit = Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: MODAL_HEIGHT,
        duration: 200,
        useNativeDriver: true,
      }),
    ]);
    // Only drop the dialog once the slide-out actually finished; an
    // interrupted exit (the sheet became relevant again) keeps it mounted.
    exit.start(({ finished }) => {
      if (finished) setMounted(false);
    });
    return () => exit.stop();
  }, [visible, mounted, fadeAnim, translateY]);

  const handleSwitchNetwork = () => {
    onClose();
    setTimeout(() => onSwitchNetwork(), 250);
  };

  if (!mounted) return null;

  return (
    <Modal
      transparent
      visible={mounted}
      animationType="none"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1 }}>
        <TouchableWithoutFeedback onPress={onClose}>
          <Animated.View
            style={{
              flex: 1,
              backgroundColor: "rgba(0, 0, 0, 0.5)",
              opacity: fadeAnim,
            }}
          />
        </TouchableWithoutFeedback>

        <Animated.View
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            backgroundColor: "#f5f5f5",
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            paddingBottom: bottomOffset,
            transform: [{ translateY }],
          }}
        >
          <View className="px-6 pt-6 pb-4">
            {/* Icon */}
            <View style={{ alignItems: "center", marginBottom: 20 }}>
              <View className="bg-amber-100 p-5 rounded-full mb-4">
                <WifiOff size={48} color="#d97706" strokeWidth={2} />
              </View>
              <Text className="text-light-matte-black font-bold text-xl mb-2">
                Network Not Supported
              </Text>
              <Text className="text-light-matte-black/60 text-center text-sm px-4">
                Adding points is not available on{" "}
                <Text className="font-semibold text-light-matte-black/80">
                  {chainName}
                </Text>
                . Please switch to a supported network to continue.
              </Text>
            </View>

            {/* Action Buttons */}
            <View className="gap-3">
              <Pressable
                className="bg-light-primary-red p-4 rounded-full shadow-md"
                onPress={handleSwitchNetwork}
              >
                <Text className="text-white font-bold text-base text-center">
                  Switch Network
                </Text>
              </Pressable>

              <Pressable
                className="bg-light-main-container p-4 rounded-full"
                onPress={onClose}
              >
                <Text className="text-light-matte-black/70 font-medium text-base text-center">
                  Dismiss
                </Text>
              </Pressable>
            </View>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}
