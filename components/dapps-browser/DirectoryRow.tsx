import { Image } from "expo-image";
import { ExternalLink, Star } from "lucide-react-native";
import React, { memo, useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import SingleLoadingSekeleton from "@/components/common/SingleLoadingSekeleton";
import { COLORS, DIRECTORY_ROW_HEIGHT } from "@/constants/dapps-browser";
import {
  type DirectoryEntry,
  metaLine,
  rankLabel,
} from "@/services/dappsBrowser/directory";
import { resolveAppearance } from "@/utils/dappAppearance";
import { tapFeedback } from "@/utils/hapticsUtils";

type DirectoryRowProps = {
  entry: DirectoryEntry;
  index: number;
  onOpen: (url: string) => void;
  onToggleFavorite: (entry: DirectoryEntry) => void;
};

/**
 * One app in the dense directory: rank, logo, name, a description that
 * fits on one line, and a metadata line. Six of these are visible under a
 * full-size hero, where the old card rails showed about two and a half.
 *
 * There is no star button. Favouriting is a low-frequency action that used
 * to hold permanent real estate on every card; it moved to a long press,
 * and a favourited row is marked next to its name. The favourites
 * themselves surface one strip up, in "Jump back in".
 */
const DirectoryRow = memo<DirectoryRowProps>(function DirectoryRow({
  entry,
  index,
  onOpen,
  onToggleFavorite,
}) {
  const appearance = useMemo(
    () => resolveAppearance(entry.appearance),
    [entry.appearance],
  );

  const handlePress = useCallback(() => {
    tapFeedback();
    onOpen(entry.websiteUrl);
  }, [entry.websiteUrl, onOpen]);

  const handleLongPress = useCallback(() => {
    tapFeedback();
    onToggleFavorite(entry);
  }, [entry, onToggleFavorite]);

  const meta = metaLine(entry);

  return (
    <Pressable
      onPress={handlePress}
      onLongPress={handleLongPress}
      accessibilityRole="button"
      accessibilityLabel={`${entry.name}. ${entry.description}`}
      accessibilityHint="Opens the app. Long press to save it."
      className="flex-row items-center mx-4 px-3.5 rounded-2xl bg-white border border-light-matte-black/10 active:opacity-70"
      style={{ height: DIRECTORY_ROW_HEIGHT }}
    >
      <Text className="w-[22px] text-[11.5px] font-extrabold text-light-matte-black/20">
        {rankLabel(index)}
      </Text>

      <View
        className="w-[42px] h-[42px] rounded-[13px] items-center justify-center overflow-hidden ml-1"
        style={{ backgroundColor: appearance.logoBackground }}
      >
        {entry.logoUrl ? (
          <Image
            source={{ uri: entry.logoUrl }}
            style={{ width: 30, height: 30 }}
            contentFit="contain"
            transition={150}
          />
        ) : (
          <Text className="text-[15px] font-extrabold text-light-primary-red">
            {entry.name.trim().slice(0, 1).toUpperCase() || "?"}
          </Text>
        )}
      </View>

      <View className="flex-1 ml-3">
        <View className="flex-row items-center gap-1.5">
          <Text
            className="text-[14.5px] font-bold text-light-matte-black flex-shrink"
            numberOfLines={1}
          >
            {entry.name}
          </Text>
          {entry.isFavorite && (
            <Star
              size={11}
              color={COLORS.PRIMARY_RED}
              fill={COLORS.PRIMARY_RED}
              strokeWidth={0}
            />
          )}
          {/* Answers "am I already in here?" without opening the site.
              Emerald is the app's connected colour, shared with the chips
              and the address bar's connection button. */}
          {entry.isConnected && (
            <View className="w-1.5 h-1.5 rounded-full bg-emerald-700" />
          )}
        </View>
        {entry.description ? (
          <Text
            className="text-[11.5px] text-light-matte-black/55 mt-0.5"
            numberOfLines={1}
          >
            {entry.description}
          </Text>
        ) : null}
        {meta ? (
          <Text
            className="text-[10.5px] text-light-matte-black/40 mt-0.5"
            numberOfLines={1}
          >
            {meta}
          </Text>
        ) : null}
      </View>

      {/* Same tile the connection manager puts on a connected site
          (`ConnectedAppsList`): brand-red `ExternalLink` on a tinted disc.
          "Leave the app for this site" already looks like this elsewhere in
          the browser, so it should not look like something else here. */}
      <View className="ml-3 w-8 h-8 rounded-full bg-light-primary-red/10 items-center justify-center">
        <ExternalLink size={15} color={COLORS.PRIMARY_RED} strokeWidth={2} />
      </View>
    </Pressable>
  );
});

/**
 * Traces the row: same card, same 42px logo tile, a bar per text line, and
 * the arrow's slot held open. Matching the real metrics is the point, so
 * the list does not reflow when the data lands.
 */
export const DirectoryRowSkeleton = memo(function DirectoryRowSkeleton() {
  return (
    <View
      className="flex-row items-center mx-4 px-3.5 rounded-2xl bg-white border border-light-matte-black/10"
      style={{ height: DIRECTORY_ROW_HEIGHT }}
    >
      <View className="w-[26px]" />
      <SingleLoadingSekeleton width={42} height={42} borderRadius={13} />
      <View className="flex-1 ml-3">
        <SingleLoadingSekeleton width={104} height={13} borderRadius={4} />
        <View className="h-1.5" />
        <SingleLoadingSekeleton width={168} height={10} borderRadius={4} />
        <View className="h-1" />
        <SingleLoadingSekeleton width={92} height={9} borderRadius={4} />
      </View>
      <View className="ml-3">
        <SingleLoadingSekeleton width={32} height={32} borderRadius={16} />
      </View>
    </View>
  );
});

export default DirectoryRow;
