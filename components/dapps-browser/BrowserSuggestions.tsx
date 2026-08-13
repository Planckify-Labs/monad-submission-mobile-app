import { FlashList } from "@shopify/flash-list";
import { Image } from "expo-image";
import {
  CornerDownLeft,
  ExternalLink,
  Globe,
  Search,
  Star,
} from "lucide-react-native";
import React, { memo, useCallback, useMemo } from "react";
import { Keyboard, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import type {
  Suggestion,
  SuggestionListItem,
} from "@/services/dappsBrowser/suggest";
import { resolveAppearance } from "@/utils/dappAppearance";
import { tapFeedback } from "@/utils/hapticsUtils";
import { COLORS } from "../../constants/dapps-browser";

const BRAND_RED = COLORS.PRIMARY_RED;

/**
 * The trailing glyph, on the same tinted disc `DirectoryRow` uses.
 *
 * Two meanings, not four. A dApp or a visited site leaves the app for a
 * website, which is `ExternalLink` wherever this app offers it. A typed
 * URL or a web search commits what is in the field, so both get the return
 * key, which is also literally the other way to fire them.
 */
const ACTION_ICON: Record<Suggestion["kind"], typeof ExternalLink> = {
  navigate: CornerDownLeft,
  search: CornerDownLeft,
  dapp: ExternalLink,
  history: ExternalLink,
};

/** Kept for the accessibility label, now that the word is not on screen. */
const ACTION_LABEL: Record<Suggestion["kind"], string> = {
  navigate: "Go",
  search: "Search",
  dapp: "Open",
  history: "Open",
};

/**
 * Leading tile, built to the hub's metrics. A catalogue-backed row shows
 * the dApp's logo on its own `appearance.logoBackground`, so a suggestion
 * and its directory row are recognisably the same object; a row without a
 * logo falls back to its initial, and the two synthetic rows to a glyph.
 */
const SuggestionIcon = memo(function SuggestionIcon({
  suggestion,
}: {
  suggestion: Suggestion;
}) {
  const appearance = useMemo(
    () => resolveAppearance(suggestion.appearance),
    [suggestion.appearance],
  );

  const synthetic =
    suggestion.kind === "navigate" || suggestion.kind === "search";
  const Glyph = suggestion.kind === "search" ? Search : Globe;

  return (
    <View
      className="w-[42px] h-[42px] rounded-[13px] items-center justify-center overflow-hidden"
      style={{ backgroundColor: appearance.logoBackground }}
    >
      {suggestion.logoUrl ? (
        <Image
          source={{ uri: suggestion.logoUrl }}
          style={{ width: 30, height: 30 }}
          contentFit="contain"
          transition={150}
        />
      ) : synthetic ? (
        <Glyph size={18} color={BRAND_RED} strokeWidth={2.25} />
      ) : (
        <Text className="text-[15px] font-extrabold text-light-primary-red">
          {suggestion.title.trim().slice(0, 1).toUpperCase() || "?"}
        </Text>
      )}
    </View>
  );
});

const SuggestionRow = memo(function SuggestionRow({
  suggestion,
  onSelect,
  onRemove,
}: {
  suggestion: Suggestion;
  onSelect: (suggestion: Suggestion) => void;
  onRemove?: (host: string) => void;
}) {
  const removableHost = suggestion.historyHost;
  const removable = Boolean(removableHost && onRemove);

  const handlePress = useCallback(() => {
    tapFeedback();
    onSelect(suggestion);
  }, [onSelect, suggestion]);

  /**
   * Long press forgets this one site. The row is the only place the entry
   * is ever visible, so it is the only honest place to delete it, and a
   * mistyped host or a link the user regrets is a one-entry problem, not a
   * reason to wipe everything.
   *
   * The confirmation lives in the handler the screen passes down, not
   * here, so the copy sits with the rest of the browser's user-facing
   * strings. This only reports the gesture.
   */
  const handleLongPress = useCallback(() => {
    if (!removableHost) return;
    tapFeedback();
    onRemove?.(removableHost);
  }, [removableHost, onRemove]);

  // Category, then where a tap goes: the same metadata line the directory
  // rows use, rather than a coloured chip.
  const meta = [suggestion.badge, suggestion.subtitle]
    .filter(Boolean)
    .join("  ·  ");

  const ActionIcon = ACTION_ICON[suggestion.kind];

  return (
    <Pressable
      onPress={handlePress}
      onLongPress={removable ? handleLongPress : undefined}
      accessibilityRole="button"
      // The verb moved to a glyph, so it has to stay in the label: a
      // screen reader should still hear "Open Jupiter", not just the name.
      accessibilityLabel={`${ACTION_LABEL[suggestion.kind]} ${suggestion.title}. ${meta}`}
      accessibilityHint={
        removable
          ? "Long press to remove this site from suggestions"
          : undefined
      }
      // Same material as a directory row on the hub: a white card with a
      // hairline border, floating on the canvas. Every row gets the same
      // treatment; tinting the primary one turned a typed URL into two
      // stacked red blocks, so position and the trailing label carry the
      // hierarchy instead.
      className="flex-row items-center mx-4 mb-2 px-3.5 py-3 rounded-2xl bg-white border border-light-matte-black/10 active:opacity-70"
    >
      <SuggestionIcon suggestion={suggestion} />

      <View className="flex-1 ml-3">
        <View className="flex-row items-center gap-1.5">
          <Text
            className="text-[14.5px] font-bold text-light-matte-black flex-shrink"
            numberOfLines={1}
          >
            {suggestion.title}
          </Text>
          {suggestion.isFavorite && (
            <Star
              size={11}
              color={BRAND_RED}
              fill={BRAND_RED}
              strokeWidth={0}
            />
          )}
        </View>
        {meta ? (
          <Text
            className="text-[11.5px] text-light-matte-black/55 mt-0.5"
            numberOfLines={1}
          >
            {meta}
          </Text>
        ) : null}
      </View>

      <View className="ml-3 w-8 h-8 rounded-full bg-light-primary-red/10 items-center justify-center">
        <ActionIcon size={15} color={BRAND_RED} strokeWidth={2} />
      </View>
    </Pressable>
  );
});

/** Matches "JUMP BACK IN" on the hub: muted, tracked, and no icon. */
const SectionHeader = memo(function SectionHeader({
  label,
}: {
  label: string;
}) {
  return (
    <Text className="px-5 pt-4 pb-1.5 text-[10.5px] font-bold tracking-[0.9px] text-light-matte-black/40">
      {label.toUpperCase()}
    </Text>
  );
});

type BrowserSuggestionsProps = {
  items: SuggestionListItem[];
  onSelect: (suggestion: Suggestion) => void;
  /** Forgets one visited site. Omit to make the rows non-removable. */
  onRemove?: (host: string) => void;
};

/**
 * The list that replaces the page while the address bar is being edited.
 *
 * Rendered as an absolute overlay rather than swapped in for the WebView,
 * so the open dApp keeps its JS context, scroll position and bridge
 * session while the user types. `elevation` is what keeps it above the
 * Android WebView, which paints outside the normal RN view order.
 */
const BrowserSuggestions = memo<BrowserSuggestionsProps>(
  function BrowserSuggestions({ items, onSelect, onRemove }) {
    const renderItem = useCallback(
      ({ item }: { item: SuggestionListItem }) =>
        item.type === "header" ? (
          <SectionHeader label={item.label} />
        ) : (
          <SuggestionRow
            suggestion={item.suggestion}
            onSelect={onSelect}
            onRemove={onRemove}
          />
        ),
      [onSelect, onRemove],
    );

    const keyExtractor = useCallback((item: SuggestionListItem) => item.id, []);

    // Headers and rows are different shapes; without this FlashList
    // recycles one as the other and the section labels flicker.
    const getItemType = useCallback(
      (item: SuggestionListItem) => item.type,
      [],
    );

    return (
      <Animated.View
        entering={FadeIn.duration(160)}
        exiting={FadeOut.duration(120)}
        style={[
          StyleSheet.absoluteFillObject,
          {
            zIndex: 10,
            // Elevation is only here to win paint order against the Android
            // WebView, which draws outside the normal RN view order. It also
            // casts a drop shadow by default, which on a full-bleed sheet
            // just dirties its edges: a transparent outline shadow colour
            // keeps the ordering and removes the shadow.
            elevation: 24,
            shadowColor: "transparent",
          },
        ]}
        // The canvas colour, not white: the white belongs to the rows, so
        // each one reads as a card sitting on the surface the rest of the
        // app uses.
        className="bg-light-main-container"
      >
        <FlashList
          data={items}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          getItemType={getItemType}
          // The row must fire on the first tap; without this the tap is
          // swallowed by the keyboard dismissal.
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          onScrollBeginDrag={Keyboard.dismiss}
          // The first row used to sit right against the address bar, since
          // the bar only contributes its own 8px of bottom padding. This
          // gives the list its own breathing room at both ends.
          contentContainerStyle={{ paddingTop: 12, paddingBottom: 28 }}
          showsVerticalScrollIndicator={false}
        />
      </Animated.View>
    );
  },
);

export default BrowserSuggestions;
