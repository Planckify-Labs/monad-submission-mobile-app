import { router } from "expo-router";
import { CheckCircle, Home } from "lucide-react-native";
import React, { useEffect, useRef } from "react";
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

type PaymentSuccessModalProps = {
  visible: boolean;
  onClose: () => void;
  productName?: string;
  pointsSpent?: string;
  redemptionId?: string;
  onViewActivity?: () => void;
};

const MODAL_HEIGHT = 500;

export default function PaymentSuccessModal({
  visible,
  onClose,
  productName,
  pointsSpent,
  redemptionId,
  onViewActivity,
}: PaymentSuccessModalProps) {
  const { bottom } = useSafeAreaInsets();
  const bottomOffset = Platform.OS === "ios" ? 16 : bottom > 0 ? bottom : 0;

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(MODAL_HEIGHT)).current;
  const scaleAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
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
        Animated.spring(scaleAnim, {
          toValue: 1,
          delay: 200,
          tension: 50,
          friction: 7,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
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
      ]).start();
    }
  }, [visible, fadeAnim, translateY, scaleAnim]);

  const handleViewActivity = () => {
    onClose();
    if (onViewActivity) {
      onViewActivity();
    } else {
      router.replace("/activities");
    }
  };

  const handleGoHome = () => {
    onClose();
    router.replace("/");
  };

  if (!visible) return null;

  return (
    <Modal
      transparent
      visible={visible}
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
            {/* Success Icon */}
            <Animated.View
              style={{
                alignItems: "center",
                marginBottom: 20,
                transform: [{ scale: scaleAnim }],
              }}
            >
              <View className="bg-green-100 p-6 rounded-full mb-4">
                <CheckCircle size={64} color="#10b981" strokeWidth={2} />
              </View>
              <Text className="text-light-matte-black font-bold text-2xl mb-2">
                Order placed!
              </Text>
              <Text className="text-light-matte-black/60 text-center text-sm">
                {productName
                  ? `We're preparing your ${productName}. We'll notify you the moment it's ready.`
                  : "We're preparing your order. We'll notify you the moment it's ready."}
              </Text>
            </Animated.View>

            <View className="bg-white rounded-2xl p-4 mb-4 shadow-sm">
              <Text className="text-light-matte-black font-bold text-base mb-3">
                Redemption Details
              </Text>

              {productName && (
                <View className="flex-row justify-between items-center mb-2">
                  <Text className="text-light-matte-black/60 text-sm">
                    Product
                  </Text>
                  <Text
                    className="text-light-matte-black text-sm font-medium"
                    numberOfLines={1}
                  >
                    {productName}
                  </Text>
                </View>
              )}

              {pointsSpent && (
                <View className="flex-row justify-between items-center mb-2">
                  <Text className="text-light-matte-black/60 text-sm">
                    Points Spent
                  </Text>
                  <Text className="text-light-primary-red text-sm font-bold">
                    {parseInt(pointsSpent).toLocaleString()} points
                  </Text>
                </View>
              )}

              {redemptionId && (
                <View className="flex-row justify-between items-center">
                  <Text className="text-light-matte-black/60 text-sm">
                    Redemption ID
                  </Text>
                  <Text
                    className="text-light-matte-black text-xs font-mono"
                    numberOfLines={1}
                  >
                    #{redemptionId.substring(0, 12)}...
                  </Text>
                </View>
              )}
            </View>

            <View className="flex gap-2 flex-row justify-center">
              <Pressable
                className="p-4 grow rounded-full"
                onPress={handleGoHome}
              >
                <View className="flex-row items-center justify-center">
                  <Home size={20} stroke="#c71c4b" strokeWidth={2} />
                  <Text className="text-light-matte-black font-bold text-base ml-2">
                    Back to Home
                  </Text>
                </View>
              </Pressable>
              <Pressable
                className="bg-light-primary-red p-4 grow rounded-xl shadow-xs"
                onPress={handleViewActivity}
              >
                <View className="flex-row items-center justify-center">
                  <Text className="text-white font-bold text-base ml-2">
                    Track order
                  </Text>
                </View>
              </Pressable>
            </View>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}
