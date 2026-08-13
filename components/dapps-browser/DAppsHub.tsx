import { FlashList } from "@shopify/flash-list";
import { useQueryClient } from "@tanstack/react-query";
import React, { memo, useCallback, useMemo, useState } from "react";
import { RefreshControl, Text, View } from "react-native";
import { useDappDirectory } from "@/hooks/dapps-browser/useDappDirectory";
import {
  ALL_CATEGORY_ID,
  buildDirectory,
  type DirectoryEntry,
} from "@/services/dappsBrowser/directory";
import CategoryTabs from "./CategoryTabs";
import DappsErrorMessage from "./DappsErrorMessage";
import DirectoryRow, { DirectoryRowSkeleton } from "./DirectoryRow";
import FeaturedCarousel from "./FeaturedCarousel";
import JumpBackInRow from "./JumpBackInRow";

type DAppsHubProps = {
  onNavigateToDapp: (url: string) => void;
};

const SKELETON_ROWS = [0, 1, 2, 3, 4, 5];

/**
 * The dApps hub.
 *
 * Three things stacked, in the order the user needs them: the sponsored
 * hero, one strip of the apps they already use, and a ranked directory of
 * everything else behind a tab bar. The title block that used to occupy
 * the first 140px is gone; tapping the tab already told the user where
 * they are.
 *
 * Everything below the hero scans vertically. The old hub was five nested
 * horizontal rails (favourites, popular, and one per category), which
 * showed roughly five apps on a full screen; this shows six under a
 * full-size banner.
 */
const DAppsHub = memo<DAppsHubProps>(function DAppsHub({ onNavigateToDapp }) {
  const queryClient = useQueryClient();
  const [selectedCategoryId, setSelectedCategoryId] =
    useState<string>(ALL_CATEGORY_ID);
  const [refreshing, setRefreshing] = useState(false);

  const {
    categories,
    entries,
    chips,
    isLoading,
    isError,
    refetchCategories,
    toggleFavorite,
  } = useDappDirectory();

  const rows = useMemo(
    () => buildDirectory({ entries, categoryId: selectedCategoryId }),
    [entries, selectedCategoryId],
  );

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: ["dapps"] }),
        queryClient.invalidateQueries({ queryKey: ["dapp-categories"] }),
        queryClient.invalidateQueries({ queryKey: ["dapp-promotions"] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [queryClient]);

  const renderItem = useCallback(
    ({ item, index }: { item: DirectoryEntry; index: number }) => (
      <DirectoryRow
        entry={item}
        index={index}
        onOpen={onNavigateToDapp}
        onToggleFavorite={toggleFavorite}
      />
    ),
    [onNavigateToDapp, toggleFavorite],
  );

  const keyExtractor = useCallback((item: DirectoryEntry) => item.id, []);

  // Lets a promotion that links a dApp by id inherit that dApp's site.
  const urlByDappId = useMemo(() => {
    const byId = new Map<string, string>();
    for (const entry of entries) byId.set(entry.id, entry.websiteUrl);
    return byId;
  }, [entries]);

  const resolveDappUrl = useCallback(
    (dappId: string) => urlByDappId.get(dappId),
    [urlByDappId],
  );

  // Cards, so the list breathes instead of butting up against itself.
  const Separator = useCallback(() => <View className="h-2" />, []);

  const header = (
    <View className="pt-3">
      <FeaturedCarousel
        onNavigateToDapp={onNavigateToDapp}
        resolveDappUrl={resolveDappUrl}
      />
      <JumpBackInRow chips={chips} onOpen={onNavigateToDapp} />
      <CategoryTabs
        categories={categories}
        selectedId={selectedCategoryId}
        onSelect={setSelectedCategoryId}
      />
      {/* Same gap the separators use, so the first card sits off the tab
          bar's rule by exactly as much as the cards sit off each other. */}
      <View className="h-3" />
    </View>
  );

  const empty = isError ? (
    <View className="py-6">
      <DappsErrorMessage
        onRetry={refetchCategories}
        message="Can't load apps right now"
      />
    </View>
  ) : isLoading ? (
    <View className="gap-2">
      {SKELETON_ROWS.map((i) => (
        <DirectoryRowSkeleton key={i} />
      ))}
    </View>
  ) : (
    <View className="px-5 py-10 items-center">
      <Text className="text-sm font-semibold text-light-matte-black">
        Nothing here yet
      </Text>
      <Text className="text-xs text-light-matte-black/50 mt-1 text-center">
        Try another category, or search for an app in the bar above.
      </Text>
    </View>
  );

  return (
    // Canvas all the way down, so the white rows read as separate cards
    // rather than as bands of one sheet. The colour lives on this wrapper
    // rather than on the list so it holds under the empty state too.
    <View className="flex-1 bg-light-main-container">
      <FlashList
        data={rows}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        ListHeaderComponent={header}
        ItemSeparatorComponent={Separator}
        ListEmptyComponent={empty}
        contentContainerStyle={{ paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor="#c71c4b"
            colors={["#c71c4b"]}
          />
        }
      />
    </View>
  );
});

export default DAppsHub;
