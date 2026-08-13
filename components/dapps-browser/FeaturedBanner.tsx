import { Image } from "expo-image";
import { Star } from "lucide-react-native";
import React, { memo, useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { TDappPromotion } from "@/api/types/dapp";
import SingleLoadingSekeleton from "@/components/common/SingleLoadingSekeleton";
import { COLORS, HERO_HEIGHT, HERO_WIDTH } from "@/constants/dapps-browser";
import { resolveAppearance } from "@/utils/dappAppearance";
import { tapFeedback } from "@/utils/hapticsUtils";

type FeaturedBannerProps = {
  item: TDappPromotion;
  onPress: (url: string) => void;
  width: number;
};

/** House copy when a promotion carries no label of its own. */
const DEFAULT_CTA = "Open app";

/**
 * The hub's hero: one full-bleed sponsored card, the loudest object on the
 * screen and the first thing under the address bar.
 *
 * Two things it does that the old banner did not. It carries an explicit
 * call to action, so the user can tell that a tap opens the dApp rather
 * than expanding a description, and the sponsor gets a measurable click.
 * And it is a fixed height with a hard two-line cap on the description, so
 * a sponsor who writes an essay cannot push the directory off the screen.
 */
const FeaturedBanner = memo<FeaturedBannerProps>(function FeaturedBanner({
  item,
  onPress,
  width,
}) {
  // Banners want a colored surface, not the white card default.
  const appearance = useMemo(
    () =>
      resolveAppearance(item.appearance, {
        backgroundColor: COLORS.PRIMARY_RED,
        foreground: COLORS.WHITE,
      }),
    [item.appearance],
  );

  const handlePress = useCallback(() => {
    if (!item.targetUrl) {
      // A banner with nowhere to go is a content error, not a user error.
      // It used to fail silently, which read as "the card is dead".
      if (__DEV__) {
        console.warn(
          `[hub] promotion ${item.id} has no targetUrl and no resolvable dappId`,
        );
      }
      return;
    }
    tapFeedback();
    onPress(item.targetUrl);
  }, [item.id, item.targetUrl, onPress]);

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`${item.title ?? ""}. ${item.subtitle ?? ""}`}
      className="rounded-3xl overflow-hidden active:opacity-90"
      style={{
        width,
        height: HERO_HEIGHT,
        backgroundColor: appearance.backgroundColor,
        shadowColor: appearance.backgroundColor,
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.28,
        shadowRadius: 10,
        elevation: 6,
      }}
    >
      {/* Depth without an asset: two soft discs bleeding off the corners,
          clipped by the card's own overflow. */}
      <View
        pointerEvents="none"
        className="absolute rounded-full bg-white/[0.07]"
        style={{ width: 108, height: 108, right: -20, top: -36 }}
      />
      <View
        pointerEvents="none"
        className="absolute rounded-full bg-white/[0.05]"
        style={{ width: 76, height: 76, right: 44, bottom: -18 }}
      />

      <View className="flex-1 p-5">
        <View className="flex-row items-start">
          <View className="flex-1 pr-3">
            {item.isSponsored && (
              <View className="flex-row items-center mb-2.5">
                <Star
                  size={13}
                  color={appearance.foreground}
                  fill={appearance.foreground}
                  strokeWidth={0}
                />
                <Text
                  className="text-[10.5px] font-extrabold ml-1.5 tracking-[1.1px]"
                  style={{ color: appearance.foreground }}
                >
                  SPONSORED
                </Text>
              </View>
            )}
            <Text
              className="text-[23px] font-extrabold"
              style={{ color: appearance.foreground }}
              numberOfLines={1}
            >
              {item.title ?? ""}
            </Text>
            {item.subtitle ? (
              <Text
                className="text-xs font-semibold mt-1 opacity-[0.85]"
                style={{ color: appearance.foreground }}
                numberOfLines={1}
              >
                {item.subtitle}
              </Text>
            ) : null}
            {item.description ? (
              <Text
                className="text-[11.5px] leading-4 mt-2 opacity-[0.72]"
                style={{ color: appearance.foreground }}
                numberOfLines={2}
              >
                {item.description}
              </Text>
            ) : null}
          </View>

          {/* Translucent rather than tinted: the logo tile must read on
              whatever surface colour the sponsor ships. */}
          <View className="w-[78px] h-[78px] rounded-3xl items-center justify-center overflow-hidden bg-white/20">
            <Image
              source={{ uri: item.imageUrl }}
              style={{ width: 52, height: 52 }}
              contentFit="contain"
              transition={200}
            />
          </View>
        </View>

        <View className="flex-1 justify-end">
          <Pressable
            onPress={handlePress}
            accessibilityRole="button"
            className="h-8 rounded-full px-5 items-center justify-center self-start active:opacity-80"
            style={{ backgroundColor: appearance.foreground }}
          >
            <Text
              className="text-[12.5px] font-extrabold"
              style={{ color: appearance.accent }}
            >
              {item.ctaLabel || DEFAULT_CTA}
            </Text>
          </Pressable>
        </View>
      </View>
    </Pressable>
  );
});

/**
 * Placeholder in the hero's shape: same card, same 78px logo tile, bars
 * where the tag, title, subtitle, two description lines and the CTA go.
 *
 * It traces the real banner rather than filling a grey box because this is
 * the top of the page. Anything shorter or taller here moves the entire
 * directory when the banner lands. Neutral surface on purpose: the
 * sponsor's colour is exactly what we do not know yet.
 */
export const FeaturedBannerSkeleton = memo(function FeaturedBannerSkeleton() {
  return (
    <View
      className="rounded-3xl overflow-hidden bg-white p-5"
      style={{ width: HERO_WIDTH, height: HERO_HEIGHT }}
    >
      <View className="flex-row items-start">
        <View className="flex-1 pr-3">
          <SingleLoadingSekeleton width={92} height={11} borderRadius={4} />
          <View className="h-2.5" />
          <SingleLoadingSekeleton width={168} height={20} borderRadius={5} />
          <View className="h-1.5" />
          <SingleLoadingSekeleton width={104} height={12} borderRadius={4} />
          <View className="h-2.5" />
          <SingleLoadingSekeleton width="100%" height={10} borderRadius={4} />
          <View className="h-1.5" />
          <SingleLoadingSekeleton width="70%" height={10} borderRadius={4} />
        </View>
        <SingleLoadingSekeleton width={78} height={78} borderRadius={24} />
      </View>

      <View className="flex-1 justify-end">
        <SingleLoadingSekeleton width={112} height={32} borderRadius={16} />
      </View>
    </View>
  );
});

export default FeaturedBanner;
