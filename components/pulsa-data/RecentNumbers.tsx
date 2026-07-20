import { Smartphone } from "lucide-react-native";
import React, { memo, useCallback } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import OptimizedImage from "@/components/common/OptimizedImage";
import { formatPhoneNumber } from "@/constants/ISP-list";
import { useRecentNumbers } from "@/hooks/pulsa-data/useRecentNumbers";
import type { RecentNumber } from "@/services/ppob/recentNumbers";

const MAX_SHOWN = 10;

interface RecentNumberChipProps {
  item: RecentNumber;
  onSelect: (number: string) => void;
  onRemove: (key: string) => void;
}

const RecentNumberChip = memo(function RecentNumberChip({
  item,
  onSelect,
  onRemove,
}: RecentNumberChipProps) {
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={() => onSelect(item.number)}
      onLongPress={() => onRemove(item.key)}
      className="flex-row items-center bg-light rounded-2xl border border-light-matte-black/10 pl-2 pr-3 py-2 mr-2"
    >
      <View className="w-8 h-8 rounded-full overflow-hidden bg-light-main-container items-center justify-center">
        {item.logoUrl ? (
          <OptimizedImage
            source={{ uri: item.logoUrl }}
            style={{ width: 32, height: 32 }}
            contentFit="contain"
          />
        ) : (
          <Smartphone size={16} color="#c71c4b" />
        )}
      </View>
      {/* Cap the text column so a long contact name ellipsizes instead of
          stretching the chip across the row. */}
      <View className="ml-2 max-w-[140px]">
        {item.label ? (
          <>
            <Text
              className="text-light-matte-black font-semibold text-xs"
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {item.label}
            </Text>
            <Text
              className="text-light-matte-black/50 text-[11px]"
              numberOfLines={1}
            >
              {formatPhoneNumber(item.number)}
            </Text>
          </>
        ) : (
          <Text
            className="text-light-matte-black font-medium text-xs"
            numberOfLines={1}
          >
            {formatPhoneNumber(item.number)}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
});

interface RecentNumbersProps {
  onSelect: (number: string) => void;
}

/**
 * "Frequently used" number chips under the phone input — a single
 * horizontally-scrollable row. Reads from the MMKV-backed store; tapping
 * a chip prefills the input, long-press removes it. Renders nothing when
 * there's no history.
 */
export const RecentNumbers = memo(function RecentNumbers({
  onSelect,
}: RecentNumbersProps) {
  const { recentNumbers, remove } = useRecentNumbers();

  const handleRemove = useCallback((key: string) => remove(key), [remove]);

  if (recentNumbers.length === 0) return null;

  return (
    <View className="mt-4">
      <Text className="text-light-matte-black font-bold text-sm mb-2 px-1">
        Frequently used
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingRight: 8 }}
      >
        {recentNumbers.slice(0, MAX_SHOWN).map((item) => (
          <RecentNumberChip
            key={item.key}
            item={item}
            onSelect={onSelect}
            onRemove={handleRemove}
          />
        ))}
      </ScrollView>
    </View>
  );
});
