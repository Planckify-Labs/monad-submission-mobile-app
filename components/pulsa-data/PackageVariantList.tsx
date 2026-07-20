import { FlashList } from "@shopify/flash-list";
import { router } from "expo-router";
import { SlidersHorizontal, X } from "lucide-react-native";
import React, { memo, useCallback, useMemo, useState } from "react";
import {
  Platform,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { TProductVariant } from "@/api/types/product";
import SingleLoadingSekeleton from "@/components/common/SingleLoadingSekeleton";
import {
  useContactLabel,
  usePackageFilter,
  usePhoneNumber,
  useVariantCategories,
} from "@/hooks/pulsa-data";
import { useRecentNumbers } from "@/hooks/pulsa-data/useRecentNumbers";
import { facetKindOf, toggleFacetOption } from "@/services/ppob";
import { normalizeNumberKey } from "@/services/ppob/recentNumbers";
import { CategoryTabs } from "./CategoryTabs";
import { FilterSheet } from "./FilterSheet";
import { PackageVariantItem } from "./PackageVariantItem";

const SKELETON_COUNT = 4;
const SKELETON_HEIGHT = 72;
const SKELETON_BORDER_RADIUS = 12;

function LoadingSkeleton() {
  return (
    <View className="mt-4">
      {Array.from({ length: SKELETON_COUNT }, (_, i) => (
        <View key={i} className="mb-3">
          <SingleLoadingSekeleton
            width="100%"
            height={SKELETON_HEIGHT}
            borderRadius={SKELETON_BORDER_RADIUS}
          />
        </View>
      ))}
    </View>
  );
}

function EmptyStateMessage({ message }: { message: string }) {
  return (
    <View className="items-center py-8">
      <Text className="text-light-matte-black/60 text-center">{message}</Text>
    </View>
  );
}

export const PackageVariantList = memo(function PackageVariantList() {
  const { bottom: bottomInset } = useSafeAreaInsets();
  const bottomOffset =
    Platform.OS === "ios" ? 0 : bottomInset > 0 ? bottomInset : 0;

  const {
    phoneNumber,
    productDetail,
    providerInfo,
    isLoading,
    isValidPhoneNumber,
    detectedProvider,
    phoneNumberFieldKey,
  } = usePhoneNumber();

  const { showTabs, groups, activeKey, setActiveKey, activeVariants } =
    useVariantCategories(productDetail?.variants);

  const {
    sections,
    selection,
    setSelection,
    filtered,
    activeCount,
    hasFilters,
  } = usePackageFilter(
    activeVariants,
    `${productDetail?.id ?? ""}:${activeKey}`,
  );
  const [filterOpen, setFilterOpen] = useState(false);

  // Flatten the committed selection into removable chips (label from the
  // current sections; ids that no longer exist are simply skipped).
  const activeChips = useMemo(() => {
    const labelById = new Map<string, string>();
    for (const s of sections) {
      for (const o of s.options) labelById.set(o.id, o.label);
    }
    const chips: { id: string; label: string }[] = [];
    for (const ids of Object.values(selection)) {
      for (const id of ids) {
        const label = labelById.get(id);
        if (label) chips.push({ id, label });
      }
    }
    return chips;
  }, [sections, selection]);

  const removeChip = useCallback(
    (id: string) =>
      setSelection(toggleFacetOption(selection, facetKindOf(id), id)),
    [selection, setSelection],
  );

  const { record } = useRecentNumbers();
  const { contactLabel } = useContactLabel();

  const handleVariantPress = useCallback(
    (variant: TProductVariant) => {
      if (isValidPhoneNumber && phoneNumberFieldKey) {
        // Remember this number as frequently used (with its operator logo
        // + optional contact name) before leaving for the payment screen.
        const label =
          contactLabel && contactLabel.key === normalizeNumberKey(phoneNumber)
            ? contactLabel.name
            : undefined;
        record({
          number: phoneNumber,
          label,
          providerKey: detectedProvider ?? undefined,
          providerName: providerInfo?.name,
          logoUrl: productDetail?.imageUrl,
        });

        router.push({
          pathname: "/payment",
          params: {
            variantId: variant.id,
            customerInfo: JSON.stringify([
              { key: phoneNumberFieldKey, value: phoneNumber },
            ]),
          },
        });
      }
    },
    [
      phoneNumber,
      isValidPhoneNumber,
      phoneNumberFieldKey,
      record,
      contactLabel,
      detectedProvider,
      providerInfo?.name,
      productDetail?.imageUrl,
    ],
  );

  // Phone-credit / pulsa renders as a 2-up grid of compact cards; data
  // renders as full-width structured cards.
  const isGrid = !!groups && activeKey === "phone_credit";

  const renderItem = useCallback(
    ({ item }: { item: TProductVariant }) => (
      <PackageVariantItem
        variant={item}
        disabled={!isValidPhoneNumber || !phoneNumberFieldKey}
        onPress={handleVariantPress}
        grid={isGrid}
      />
    ),
    [isValidPhoneNumber, handleVariantPress, phoneNumberFieldKey, isGrid],
  );

  const keyExtractor = useCallback((item: TProductVariant) => item.id, []);

  if (isLoading) {
    return <LoadingSkeleton />;
  }

  const variants = productDetail?.variants;

  if (variants && variants.length > 0) {
    return (
      <View className="flex-1">
        {showTabs && groups && (
          <CategoryTabs
            groups={groups}
            activeKey={activeKey}
            onSelect={setActiveKey}
          />
        )}

        {hasFilters && (
          <View className="flex-row items-center mb-2 mt-1">
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => setFilterOpen(true)}
              className="flex-row items-center bg-light rounded-full px-3 py-2 border border-light-matte-black/10 mr-2"
            >
              <SlidersHorizontal size={16} color="#20222c" />
              <Text className="ml-1.5 font-semibold text-sm text-light-matte-black">
                Filter
              </Text>
              {activeCount > 0 && (
                <View className="ml-1.5 bg-light-primary-red rounded-full min-w-[18px] h-[18px] px-1 items-center justify-center">
                  <Text className="text-white text-[10px] font-bold">
                    {activeCount}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              className="flex-1"
            >
              {activeChips.map((chip) => (
                <TouchableOpacity
                  key={chip.id}
                  activeOpacity={0.7}
                  onPress={() => removeChip(chip.id)}
                  className="flex-row items-center bg-light-primary-red/10 rounded-full pl-3 pr-2 py-1.5 mr-2"
                >
                  <Text className="text-light-primary-red text-xs font-medium mr-1">
                    {chip.label}
                  </Text>
                  <X size={12} color="#c71c4b" />
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        <FlashList
          // Remount when the tab (and thus column count) changes so the
          // grid layout resets cleanly and scroll returns to the top.
          key={`${activeKey}-${isGrid ? 2 : 1}`}
          data={filtered}
          renderItem={renderItem}
          numColumns={isGrid ? 2 : 1}
          keyExtractor={keyExtractor}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingTop: 10,
            paddingBottom: bottomOffset,
          }}
          ListEmptyComponent={
            <EmptyStateMessage message="No packages match your filters." />
          }
        />

        <FilterSheet
          visible={filterOpen}
          onClose={() => setFilterOpen(false)}
          sections={sections}
          variants={activeVariants}
          selection={selection}
          onApply={setSelection}
        />
      </View>
    );
  }

  if (detectedProvider && !variants) {
    return (
      <EmptyStateMessage
        message={`No packages available for ${providerInfo?.name}`}
      />
    );
  }

  return (
    <EmptyStateMessage message="Enter your phone number to see available packages" />
  );
});
