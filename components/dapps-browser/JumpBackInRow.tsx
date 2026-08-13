import { Image } from "expo-image";
import React, { memo, useCallback, useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { JumpBackInChip } from "@/services/dappsBrowser/directory";
import { resolveAppearance } from "@/utils/dappAppearance";
import { tapFeedback } from "@/utils/hapticsUtils";

type JumpBackInRowProps = {
  chips: JumpBackInChip[];
  onOpen: (url: string) => void;
};

const Chip = memo(function Chip({
  chip,
  onOpen,
}: {
  chip: JumpBackInChip;
  onOpen: (url: string) => void;
}) {
  const appearance = useMemo(
    () => resolveAppearance(chip.appearance),
    [chip.appearance],
  );

  const handlePress = useCallback(() => {
    tapFeedback();
    onOpen(chip.url);
  }, [chip.url, onOpen]);

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={
        chip.isConnected ? `${chip.label}, connected` : chip.label
      }
      // Same hairline and fill on every chip, so the strip reads as one
      // object and a chip reads as the same material as a directory card.
      // The connected state is the dot's job alone: a coloured perimeter
      // on a shape this small is a lot of ink for a fact already stated,
      // and it breaks the row up on exactly the chips used most.
      className="h-[34px] flex-row items-center rounded-full border border-light-matte-black/10 bg-white pl-1.5 pr-3.5 active:opacity-70"
    >
      <View
        className="w-[22px] h-[22px] rounded-full items-center justify-center overflow-hidden"
        style={{ backgroundColor: appearance.logoBackground }}
      >
        {chip.logoUrl ? (
          <Image
            source={{ uri: chip.logoUrl }}
            style={{ width: 16, height: 16 }}
            contentFit="contain"
            transition={150}
          />
        ) : (
          <Text className="text-[11px] font-extrabold text-light-primary-red">
            {chip.initial}
          </Text>
        )}
      </View>

      <Text
        className="text-xs font-semibold text-light-matte-black ml-2 max-w-[140px]"
        numberOfLines={1}
      >
        {chip.label}
      </Text>

      {/* A wallet is connected to this site right now. The ring is the
          canvas colour so the dot reads as sitting on top of the chip. */}
      {chip.isConnected && (
        <View
          className="absolute -top-0.5 right-1.5 w-2.5 h-2.5 rounded-full bg-emerald-700 border-2"
          style={{ borderColor: "#f5f6f9" }}
        />
      )}
    </Pressable>
  );
});

/**
 * "Jump back in": favourites and recents compressed into a single 34px
 * strip, which is the row that gets tapped most and used to cost about
 * 270px of two stacked rails.
 *
 * This is the one horizontal scroller left besides the hero. Everything
 * else on the hub scans vertically, because one sideways gesture on a page
 * is a feature and five is a maze.
 */
const JumpBackInRow = memo<JumpBackInRowProps>(function JumpBackInRow({
  chips,
  onOpen,
}) {
  if (chips.length === 0) return null;

  return (
    <View className="mb-4">
      <Text className="px-5 mb-2.5 text-[10.5px] font-bold tracking-[0.9px] text-light-matte-black/40">
        JUMP BACK IN
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 16,
          // Clears the connected dot, which overhangs the chip's top edge.
          paddingTop: 4,
          gap: 8,
        }}
      >
        {chips.map((chip) => (
          <Chip key={chip.id} chip={chip} onOpen={onOpen} />
        ))}
      </ScrollView>
    </View>
  );
});

export default JumpBackInRow;
