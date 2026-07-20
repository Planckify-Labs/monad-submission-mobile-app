import React, { memo, useEffect, useRef, useState } from "react";
import {
  Animated,
  type LayoutChangeEvent,
  Pressable,
  Text,
  View,
} from "react-native";
import type { PpobCategoryGroup, PpobCategoryKey } from "@/services/ppob";

const PADDING = 6; // p-1.5

interface CategoryTabsProps {
  groups: PpobCategoryGroup[];
  activeKey: PpobCategoryKey;
  onSelect: (key: PpobCategoryKey) => void;
}

/**
 * Segmented control over a product's PPOB categories (e.g. "Phone Credit"
 * / "Data"). Generic over the number of groups so a future partner that
 * declares more categories renders without a code change. Mirrors the
 * animated-slider design of `MyAssetsAndExploreAssetTabs`.
 */
export const CategoryTabs = memo(function CategoryTabs({
  groups,
  activeKey,
  onSelect,
}: CategoryTabsProps) {
  const slideAnim = useRef(new Animated.Value(0)).current;
  const [containerWidth, setContainerWidth] = useState(0);

  const count = groups.length;
  const tabWidth =
    containerWidth > 0 ? (containerWidth - PADDING * 2) / count : 0;
  const activeIndex = Math.max(
    0,
    groups.findIndex((g) => g.key === activeKey),
  );

  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: activeIndex,
      useNativeDriver: true,
      tension: 80,
      friction: 10,
    }).start();
  }, [activeIndex, slideAnim]);

  const onLayout = (event: LayoutChangeEvent) => {
    setContainerWidth(event.nativeEvent.layout.width);
  };

  return (
    <View className="my-4">
      <View
        className="flex-row bg-white rounded-3xl p-1.5 relative"
        onLayout={onLayout}
        style={{
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.06,
          shadowRadius: 8,
          elevation: 2,
        }}
      >
        {containerWidth > 0 && (
          <Animated.View
            className="absolute top-1.5 bottom-1.5 rounded-2xl"
            style={{
              width: tabWidth,
              left: PADDING,
              backgroundColor: "#c71c4b",
              transform: [
                {
                  translateX: slideAnim.interpolate({
                    inputRange: groups.map((_, i) => i),
                    outputRange: groups.map((_, i) => i * tabWidth),
                  }),
                },
              ],
              shadowColor: "#c71c4b",
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: 0.25,
              shadowRadius: 8,
              elevation: 4,
            }}
          />
        )}

        {groups.map((group) => {
          const isActive = group.key === activeKey;
          return (
            <Pressable
              key={group.key}
              className="flex-1 py-3.5 items-center flex-row justify-center z-10"
              onPress={() => onSelect(group.key)}
            >
              <Text
                className={`font-semibold text-sm ${
                  isActive ? "text-white" : "text-light-matte-black"
                }`}
              >
                {group.label}
              </Text>
              <Text
                className={`text-xs ml-1.5 ${
                  isActive ? "text-white/70" : "text-light-matte-black/50"
                }`}
              >
                {group.variants.length}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
});
