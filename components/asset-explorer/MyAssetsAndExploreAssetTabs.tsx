import { Coins, Compass, Images } from "lucide-react-native";
import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  LayoutChangeEvent,
  Pressable,
  Text,
  View,
} from "react-native";
import type { TAssetTabType } from "@/constants/types/assetTypes";
import { TAssetCategoryTabsProps } from "@/constants/types/assetTypes";

const PADDING = 6; // p-1.5 = 6px

/**
 * Collectibles is built (Zerion-backed NFT read path, `CollectiblesList`,
 * the indexer provider) but not something we want live yet. Flip this to
 * bring the tab back — the screen wiring in `app/asset-explorer.tsx` reads
 * the same flag to skip the NFT query entirely while hidden, so no quota is
 * spent on a tab nobody can open.
 */
export const COLLECTIBLES_TAB_ENABLED = false;

/** Tab order is the slide order, so the indicator maths follows the array. */
const ALL_TABS: {
  key: TAssetTabType;
  label: string;
  icon: typeof Coins;
  activeColor: string;
}[] = [
  { key: "my-assets", label: "My Assets", icon: Coins, activeColor: "#c71c4b" },
  {
    key: "explore-assets",
    label: "Explore",
    icon: Compass,
    activeColor: "#20222c",
  },
  {
    key: "collectibles",
    label: "Collectibles",
    icon: Images,
    activeColor: "#20222c",
  },
];

const TABS = COLLECTIBLES_TAB_ENABLED
  ? ALL_TABS
  : ALL_TABS.filter((t) => t.key !== "collectibles");

const MyAssetsAndExploreAssetTabs = ({
  activeTab,
  setActiveTab,
  selectionMode,
}: TAssetCategoryTabsProps) => {
  const slideAnim = useRef(new Animated.Value(0)).current;
  const [containerWidth, setContainerWidth] = useState(0);

  const tabWidth =
    containerWidth > 0 ? (containerWidth - PADDING * 2) / TABS.length : 0;
  const activeIndex = Math.max(
    TABS.findIndex((t) => t.key === activeTab),
    0,
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
    const { width } = event.nativeEvent.layout;
    setContainerWidth(width);
  };

  if (selectionMode) return null;

  const activeColor = TABS[activeIndex].activeColor;

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
              backgroundColor: activeColor,
              transform: [
                {
                  translateX: slideAnim.interpolate({
                    inputRange: TABS.map((_, i) => i),
                    outputRange: TABS.map((_, i) => i * tabWidth),
                  }),
                },
              ],
              shadowColor: activeColor,
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: 0.25,
              shadowRadius: 8,
              elevation: 4,
            }}
          />
        )}

        {TABS.map(({ key, label, icon: Icon }) => {
          const isActive = key === activeTab;
          return (
            <Pressable
              key={key}
              className="flex-1 py-3.5 items-center flex-row justify-center z-10"
              onPress={() => setActiveTab(key)}
            >
              <Icon
                size={16}
                color={isActive ? "#fff" : "#20222c"}
                style={{ marginRight: 6 }}
              />
              <Text
                className={`font-semibold text-xs ${
                  isActive ? "text-white" : "text-light-matte-black"
                }`}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
};

export default MyAssetsAndExploreAssetTabs;
