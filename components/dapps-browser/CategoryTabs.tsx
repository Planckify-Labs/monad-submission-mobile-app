import React, { memo, useCallback } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { TDappCategory } from "@/api/types/dapp";
import { ALL_CATEGORY_ID } from "@/services/dappsBrowser/directory";
import { tapFeedback } from "@/utils/hapticsUtils";

type CategoryTabsProps = {
  categories: TDappCategory[];
  selectedId: string;
  onSelect: (categoryId: string) => void;
};

const Tab = memo(function Tab({
  id,
  label,
  isSelected,
  onSelect,
}: {
  id: string;
  label: string;
  isSelected: boolean;
  onSelect: (categoryId: string) => void;
}) {
  const handlePress = useCallback(() => {
    tapFeedback();
    onSelect(id);
  }, [id, onSelect]);

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="tab"
      accessibilityState={{ selected: isSelected }}
      className="items-center active:opacity-60"
    >
      <Text
        className={`text-[13px] pb-2 ${
          isSelected
            ? "font-bold text-light-primary-red"
            : "text-light-matte-black/50"
        }`}
        numberOfLines={1}
      >
        {label}
      </Text>
      {/* The underline is the whole selection treatment: no pill, no
          border, no icon. It sits inside the tab so it always tracks the
          label's width without a measurement pass. */}
      <View
        className={`h-[3px] w-full rounded-full ${
          isSelected ? "bg-light-primary-red" : "bg-transparent"
        }`}
      />
    </Pressable>
  );
});

/**
 * Categories as one underline tab bar.
 *
 * This replaces three nested levels of the same idea: the pill row, the
 * per-category header card ("DEX / Trade tokens directly from your
 * wallet"), and the horizontal rail underneath it. The tab already says
 * "DEX", so the card that repeated it is gone and the rail with it.
 */
const CategoryTabs = memo<CategoryTabsProps>(function CategoryTabs({
  categories,
  selectedId,
  onSelect,
}) {
  return (
    <View className="border-b border-light-matte-black/10">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 20, gap: 20 }}
      >
        <Tab
          id={ALL_CATEGORY_ID}
          label="All"
          isSelected={selectedId === ALL_CATEGORY_ID}
          onSelect={onSelect}
        />
        {categories.map((category) => (
          <Tab
            key={category.id}
            id={category.id}
            label={category.name ?? ""}
            isSelected={selectedId === category.id}
            onSelect={onSelect}
          />
        ))}
      </ScrollView>
    </View>
  );
});

export default CategoryTabs;
