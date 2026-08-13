import React, { memo, useCallback, useMemo, useState } from "react";
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  View,
} from "react-native";
import type { TDapp, TDappPromotion } from "@/api/types/dapp";
import {
  HERO_GUTTER,
  HERO_HEIGHT,
  HERO_PEEK,
  HERO_SPACING,
  HERO_WIDTH,
} from "@/constants/dapps-browser";
import { usePromotions, useSponsoredDapps } from "@/hooks/queries/useDapps";
import FeaturedBanner, { FeaturedBannerSkeleton } from "./FeaturedBanner";

type FeaturedCarouselProps = {
  onNavigateToDapp: (url: string) => void;
  /**
   * Looks up a catalogue dApp's site by id. A promotion may carry only a
   * `dappId` and leave `targetUrl` null, which is the documented "falls
   * back to the linked dapp's site" case.
   */
  resolveDappUrl?: (dappId: string) => string | undefined;
};

const SNAP_INTERVAL = HERO_WIDTH + HERO_SPACING;

/**
 * How many dots sit beside the active pill. A nine-dot row advertises
 * eight more ads and reads as work; the cap says "there is more" without
 * saying how much. The swipe behaviour is untouched, only the indicator is
 * honest about being an indicator.
 */
const MAX_DOTS = 4;

/** Size and opacity decay with distance from the active slide. */
const DOT_DECAY = [
  { size: 6, opacity: 0.2 },
  { size: 6, opacity: 0.18 },
  { size: 5, opacity: 0.12 },
  { size: 4, opacity: 0.08 },
];

// Until the editorial promotions table is populated, derive banners from
// sponsored dapps so the carousel is never empty.
const promotionFromDapp = (d: TDapp): TDappPromotion => ({
  id: `sponsor-${d.id}`,
  title: d.name,
  subtitle: d.category?.name ?? "Featured",
  description: d.description,
  imageUrl: d.logoUrl,
  appearance: d.appearance,
  targetUrl: d.websiteUrl,
  dappId: d.id,
  isSponsored: true,
  isActive: true,
  sortOrder: d.sortOrder ?? 0,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});

/**
 * The window of indicator slots to draw. It slides with the active slide
 * so the pill stays roughly centred once the user is past the first pages,
 * and never grows beyond `MAX_DOTS + 1` however many banners ship.
 */
function indicatorWindow(count: number, activeIndex: number): number[] {
  const size = Math.min(count, MAX_DOTS + 1);
  const start = Math.min(
    Math.max(0, activeIndex - Math.floor((size - 1) / 2)),
    Math.max(0, count - size),
  );
  return Array.from({ length: size }, (_, i) => start + i);
}

const PageControl = memo(function PageControl({
  count,
  activeIndex,
}: {
  count: number;
  activeIndex: number;
}) {
  const slots = useMemo(
    () => indicatorWindow(count, activeIndex),
    [count, activeIndex],
  );

  return (
    <View className="flex-row items-center justify-center mt-3.5 gap-1.5">
      {slots.map((index) => {
        if (index === activeIndex) {
          return (
            <View
              key={index}
              className="h-1.5 w-[18px] rounded-full bg-light-primary-red"
            />
          );
        }
        const decay =
          DOT_DECAY[Math.min(Math.abs(index - activeIndex), MAX_DOTS) - 1];
        return (
          <View
            key={index}
            className="rounded-full bg-light-matte-black"
            style={{
              width: decay.size,
              height: decay.size,
              opacity: decay.opacity,
            }}
          />
        );
      })}
    </View>
  );
});

const FeaturedCarousel = memo<FeaturedCarouselProps>(function FeaturedCarousel({
  onNavigateToDapp,
  resolveDappUrl,
}) {
  const [activeIndex, setActiveIndex] = useState(0);

  const { data: promotions, isPending: promotionsPending } = usePromotions();
  const { data: sponsored, isPending: sponsoredPending } = useSponsoredDapps();

  const banners = useMemo<TDappPromotion[]>(() => {
    if (promotions && promotions.length > 0) {
      // Resolve the destination here, once, so the banner never has to
      // decide where it goes. An editorial promotion often links a dApp
      // rather than typing its URL again, and without this fallback the
      // card silently swallowed every tap.
      return promotions.map((promotion) =>
        promotion.targetUrl || !promotion.dappId
          ? promotion
          : {
              ...promotion,
              targetUrl: resolveDappUrl?.(promotion.dappId) ?? null,
            },
      );
    }
    return (sponsored ?? []).map(promotionFromDapp);
  }, [promotions, sponsored, resolveDappUrl]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const x = event.nativeEvent.contentOffset.x;
      setActiveIndex(Math.max(0, Math.round(x / SNAP_INTERVAL)));
    },
    [],
  );

  if (banners.length === 0) {
    // Still fetching: hold the hero's exact footprint, including the page
    // control, so the directory does not jump down 200px when the banner
    // lands. Once both feeds have settled with nothing to show, the hero
    // is genuinely absent and the page starts at "Jump back in".
    if (promotionsPending || sponsoredPending) {
      return (
        <View className="mb-5">
          <View style={{ paddingLeft: HERO_GUTTER }}>
            <FeaturedBannerSkeleton />
          </View>
          <View className="flex-row items-center justify-center mt-3.5 gap-1.5">
            <View className="h-1.5 w-[18px] rounded-full bg-light-matte-black/10" />
            <View className="h-1.5 w-1.5 rounded-full bg-light-matte-black/10" />
            <View className="h-1.5 w-1.5 rounded-full bg-light-matte-black/[0.06]" />
          </View>
        </View>
      );
    }
    return null;
  }

  return (
    <View className="mb-5">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        decelerationRate="fast"
        snapToInterval={SNAP_INTERVAL}
        snapToAlignment="start"
        contentContainerStyle={{
          paddingLeft: HERO_GUTTER,
          // Lets the last banner snap flush to the left gutter instead of
          // stopping short by the width of the peek.
          paddingRight: HERO_PEEK,
          gap: HERO_SPACING,
        }}
        style={{ height: HERO_HEIGHT }}
        onScroll={handleScroll}
        scrollEventThrottle={16}
      >
        {banners.map((item) => (
          <FeaturedBanner
            key={item.id}
            item={item}
            onPress={onNavigateToDapp}
            width={HERO_WIDTH}
          />
        ))}
      </ScrollView>

      {banners.length > 1 && (
        <PageControl count={banners.length} activeIndex={activeIndex} />
      )}
    </View>
  );
});

export default FeaturedCarousel;
