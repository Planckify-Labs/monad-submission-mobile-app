import { useFocusEffect } from "@react-navigation/native";
import { FlashList } from "@shopify/flash-list";
import { BlurView } from "expo-blur";
import { useRouter } from "expo-router";
import { ArrowLeft, Sparkles, TrendingUp } from "lucide-react-native";
import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import type { TRedemptionHistoryItem } from "@/api/types/redeem";
import type { TTransaction } from "@/api/types/transaction";
import ActivityHeader from "@/components/activities/ActivityHeader";
import {
  PaymentsEmptyArt,
  RedemptionsEmptyArt,
  TransfersEmptyArt,
} from "@/components/activities/EmptyStateArt";
import PaymentCard from "@/components/activities/PaymentCard";
import PaymentCardSkeleton from "@/components/activities/PaymentCardSkeleton";
import PurchaseCard from "@/components/activities/PurchaseCard";
import PurchaseCardSkeleton from "@/components/activities/PurchaseCardSkeleton";
import TransferCard from "@/components/activities/TransferCard";
import TransferCardSkeleton from "@/components/activities/TransferCardSkeleton";
import LoadinngSpinnerPopup from "@/components/common/LoadinngSpinnerPopup";
import { useIsAuthenticated } from "@/hooks/queries/useAuth";
import { useRedemptionHistory } from "@/hooks/queries/useRedeem";
import { useTransactionHistory } from "@/hooks/queries/useTransactions";
import { useWallet } from "@/hooks/useWallet";
import { getChainFamilyLabel } from "@/services/walletKit/chainInfo";

type RedemptionListItem = TRedemptionHistoryItem | { id: string };
type TransferListItem = TTransaction | { id: string };
type PaymentListItem = TTransaction | { id: string };
type ActivityTab = "transfers" | "payments" | "redemptions";

const TAB_INDEX: Record<ActivityTab, number> = {
  transfers: 0,
  payments: 1,
  redemptions: 2,
};

const TAB_BY_INDEX: ActivityTab[] = ["transfers", "payments", "redemptions"];

const SKELETON_DATA = Array.from({ length: 5 }).map((_, index) => ({
  id: `skeleton-${index}`,
}));

const CONTENT_CONTAINER_STYLE = {
  paddingHorizontal: 16,
  paddingVertical: 70,
};

const ItemSeparator = React.memo(() => <View className="h-4" />);
ItemSeparator.displayName = "ItemSeparator";

const SkeletonSeparator = React.memo(() => <View className="h-4" />);
SkeletonSeparator.displayName = "SkeletonSeparator";

const { width } = Dimensions.get("window");

const EMPTY_TITLE: Record<ActivityTab, string> = {
  redemptions: "No redemptions yet",
  transfers: "No transfers yet",
  payments: "No payments yet",
};

const EMPTY_COPY: Record<ActivityTab, string> = {
  redemptions: "Redeemed products will appear here",
  transfers: "Sent crypto will show up here",
  payments: "Scan a merchant QR to make your first payment",
};

const EMPTY_ART: Record<ActivityTab, React.ComponentType<{ size?: number }>> = {
  redemptions: RedemptionsEmptyArt,
  transfers: TransfersEmptyArt,
  payments: PaymentsEmptyArt,
};

const EmptyState = React.memo(({ type }: { type: ActivityTab }) => {
  const Art = EMPTY_ART[type];
  return (
    <View className="flex-1 items-center justify-center px-6">
      <Art size={170} />
      <Text className="text-light-matte-black/70 text-lg text-center font-semibold mt-2 mb-1">
        {EMPTY_TITLE[type]}
      </Text>
      <Text className="text-light-matte-black/40 text-center">
        {EMPTY_COPY[type]}
      </Text>
    </View>
  );
});
EmptyState.displayName = "EmptyState";

const EmptyStateView = React.memo(
  ({
    type,
    refreshing,
    onRefresh,
  }: {
    type: ActivityTab;
    refreshing: boolean;
    onRefresh: () => void;
  }) => (
    <ScrollView
      contentContainerStyle={{ flex: 1 }}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor="#c71c4b"
          colors={["#c71c4b"]}
        />
      }
    >
      <EmptyState type={type} />
    </ScrollView>
  ),
);
EmptyStateView.displayName = "EmptyStateView";

export default function ActivitiesScreen() {
  const router = useRouter();
  const { isAuthenticated, isLoading: isAuthLoading } = useIsAuthenticated();
  const { activeWallet } = useWallet();
  const chainFamily = getChainFamilyLabel(activeWallet?.namespace);
  const [activeActivity, setActiveActivity] = useState<ActivityTab>("payments");
  const horizontalScrollRef = useRef<FlatList>(null);

  // Inline sign-in CTA navigation. Yield 100 ms for the spinner state
  // to commit + paint before mounting `/auth` (same trick the home
  // ActivitySection + address-book CTAs use). Reset on focus so a
  // cancelled sign-in doesn't leave the button stuck on "Opening
  // sign-in…".
  const [navigatingToAuth, setNavigatingToAuth] = useState(false);
  const goToAuth = useCallback(async () => {
    if (navigatingToAuth) return;
    setNavigatingToAuth(true);
    await new Promise((r) => setTimeout(r, 100));
    router.push("/auth");
  }, [navigatingToAuth, router]);
  useFocusEffect(
    useCallback(() => {
      setNavigatingToAuth(false);
    }, []),
  );

  const {
    data: transfersData,
    isLoading: isTransfersLoading,
    refetch: refetchTransfers,
  } = useTransactionHistory({ type: "TRANSFER" });

  const {
    data: paymentsData,
    isLoading: isPaymentsLoading,
    refetch: refetchPayments,
  } = useTransactionHistory({ type: "PAYMENT" });

  const {
    data: redemptionsData,
    isLoading: isRedemptionsLoading,
    refetch: refetchRedemptions,
    fetchNextPage: fetchMoreRedemptions,
    hasNextPage: hasMoreRedemptions,
    isFetchingNextPage: isFetchingMoreRedemptions,
  } = useRedemptionHistory(undefined, { enabled: isAuthenticated === true });

  const flatRedemptions = useMemo(
    () => redemptionsData?.pages.flatMap((page) => page.data) ?? [],
    [redemptionsData],
  );

  const tabIndicatorPosition = useRef(
    new Animated.Value(TAB_INDEX[activeActivity]),
  ).current;

  const horizontalScrollX = useRef(
    new Animated.Value(TAB_INDEX[activeActivity] * width),
  ).current;

  const currentTabIndex = useRef(TAB_INDEX[activeActivity]);

  const [tabRowWidth, setTabRowWidth] = useState(0);
  const tabSegmentWidth = tabRowWidth / TAB_BY_INDEX.length;

  const renderPurchaseItem = useCallback(
    ({ item }: { item: RedemptionListItem }) => {
      if (isRedemptionsLoading) return <PurchaseCardSkeleton />;
      if (!("pointsSpent" in item)) return null;
      return <PurchaseCard item={item} />;
    },
    [isRedemptionsLoading],
  );

  const renderTransferItem = useCallback(
    ({ item }: { item: TransferListItem }) => {
      if (isTransfersLoading) return <TransferCardSkeleton />;
      if (!("type" in item)) return null;
      return <TransferCard transaction={item} />;
    },
    [isTransfersLoading],
  );

  const renderPaymentItem = useCallback(
    ({ item }: { item: PaymentListItem }) => {
      if (isPaymentsLoading) return <PaymentCardSkeleton />;
      if (!("type" in item)) return null;
      return <PaymentCard transaction={item} />;
    },
    [isPaymentsLoading],
  );

  const keyExtractor = useCallback(
    (item: RedemptionListItem | TransferListItem | PaymentListItem) => {
      return item.id;
    },
    [],
  );

  const searchPlaceholder = useMemo(
    () => `search ${activeActivity}...`,
    [activeActivity],
  );

  const handleTabChange = useCallback(
    (newTab: ActivityTab) => {
      if (newTab !== activeActivity) {
        setActiveActivity(newTab);

        Animated.spring(tabIndicatorPosition, {
          toValue: TAB_INDEX[newTab],
          tension: 70,
          friction: 10,
          useNativeDriver: true,
        }).start();

        horizontalScrollRef.current?.scrollToIndex({
          index: TAB_INDEX[newTab],
          animated: true,
        });
      }
    },
    [activeActivity, tabIndicatorPosition],
  );

  const scrollY = useRef(new Animated.Value(0)).current;

  const searchBarOpacity = scrollY.interpolate({
    inputRange: [50, 150],
    outputRange: [1, 0.2],
    extrapolate: "clamp",
  });

  const redemptionShouldShowEmpty = useMemo(
    () => !isRedemptionsLoading && flatRedemptions.length === 0,
    [isRedemptionsLoading, flatRedemptions.length],
  );

  const transferShouldShowEmpty = useMemo(
    () => !isTransfersLoading && (!transfersData || transfersData.length === 0),
    [isTransfersLoading, transfersData],
  );

  const paymentShouldShowEmpty = useMemo(
    () => !isPaymentsLoading && (!paymentsData || paymentsData.length === 0),
    [isPaymentsLoading, paymentsData],
  );

  const handleLoadMoreRedemptions = useCallback(() => {
    if (hasMoreRedemptions && !isFetchingMoreRedemptions) {
      fetchMoreRedemptions();
    }
  }, [hasMoreRedemptions, isFetchingMoreRedemptions, fetchMoreRedemptions]);

  const PurchaseList = useMemo(() => {
    if (redemptionShouldShowEmpty) {
      return (
        <EmptyStateView
          type="redemptions"
          refreshing={isRedemptionsLoading}
          onRefresh={refetchRedemptions}
        />
      );
    }

    const data: RedemptionListItem[] = isRedemptionsLoading
      ? SKELETON_DATA
      : flatRedemptions;
    const SeparatorComponent = isRedemptionsLoading
      ? SkeletonSeparator
      : ItemSeparator;

    return (
      <FlashList<RedemptionListItem>
        data={data}
        keyExtractor={keyExtractor}
        renderItem={renderPurchaseItem}
        ItemSeparatorComponent={SeparatorComponent}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={CONTENT_CONTAINER_STYLE}
        removeClippedSubviews={true}
        onEndReached={handleLoadMoreRedemptions}
        onEndReachedThreshold={0.3}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: false },
        )}
        refreshControl={
          <RefreshControl
            refreshing={isRedemptionsLoading}
            onRefresh={refetchRedemptions}
            tintColor="#c71c4b"
            colors={["#c71c4b"]}
          />
        }
      />
    );
  }, [
    isRedemptionsLoading,
    flatRedemptions,
    keyExtractor,
    renderPurchaseItem,
    redemptionShouldShowEmpty,
    refetchRedemptions,
    scrollY,
    handleLoadMoreRedemptions,
  ]);

  const TransferList = useMemo(() => {
    if (transferShouldShowEmpty) {
      return (
        <EmptyStateView
          type="transfers"
          refreshing={isTransfersLoading}
          onRefresh={refetchTransfers}
        />
      );
    }

    const data: TransferListItem[] = isTransfersLoading
      ? SKELETON_DATA
      : (transfersData ?? []);
    const SeparatorComponent = isTransfersLoading
      ? SkeletonSeparator
      : ItemSeparator;

    return (
      <FlashList<TransferListItem>
        data={data}
        keyExtractor={keyExtractor}
        renderItem={renderTransferItem}
        ItemSeparatorComponent={SeparatorComponent}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={CONTENT_CONTAINER_STYLE}
        removeClippedSubviews={true}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: false },
        )}
        refreshControl={
          <RefreshControl
            refreshing={isTransfersLoading}
            onRefresh={refetchTransfers}
            tintColor="#c71c4b"
            colors={["#c71c4b"]}
          />
        }
      />
    );
  }, [
    isTransfersLoading,
    transfersData,
    keyExtractor,
    renderTransferItem,
    transferShouldShowEmpty,
    refetchTransfers,
    scrollY,
  ]);

  const PaymentList = useMemo(() => {
    if (paymentShouldShowEmpty) {
      return (
        <EmptyStateView
          type="payments"
          refreshing={isPaymentsLoading}
          onRefresh={refetchPayments}
        />
      );
    }

    const data: PaymentListItem[] = isPaymentsLoading
      ? SKELETON_DATA
      : (paymentsData ?? []);
    const SeparatorComponent = isPaymentsLoading
      ? SkeletonSeparator
      : ItemSeparator;

    return (
      <FlashList<PaymentListItem>
        data={data}
        keyExtractor={keyExtractor}
        renderItem={renderPaymentItem}
        ItemSeparatorComponent={SeparatorComponent}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={CONTENT_CONTAINER_STYLE}
        removeClippedSubviews={true}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: false },
        )}
        refreshControl={
          <RefreshControl
            refreshing={isPaymentsLoading}
            onRefresh={refetchPayments}
            tintColor="#c71c4b"
            colors={["#c71c4b"]}
          />
        }
      />
    );
  }, [
    isPaymentsLoading,
    paymentsData,
    keyExtractor,
    renderPaymentItem,
    paymentShouldShowEmpty,
    refetchPayments,
    scrollY,
  ]);

  const renderTabContent = useCallback(
    ({ index }: { index: number }) => {
      return (
        <View style={{ width }}>
          {index === 0
            ? TransferList
            : index === 1
              ? PaymentList
              : PurchaseList}
        </View>
      );
    },
    [TransferList, PaymentList, PurchaseList],
  );

  const handleHorizontalScroll = useCallback(
    (event: any) => {
      const contentOffsetX = event.nativeEvent.contentOffset.x;
      const newIndex = Math.round(contentOffsetX / width);

      if (currentTabIndex.current !== newIndex) {
        currentTabIndex.current = newIndex;
        const nextTab = TAB_BY_INDEX[newIndex];
        if (nextTab) {
          setActiveActivity(nextTab);
        }

        Animated.spring(tabIndicatorPosition, {
          toValue: newIndex,
          tension: 70,
          friction: 10,
          useNativeDriver: true,
        }).start();
      }
    },
    [tabIndicatorPosition],
  );

  const handleScroll = Animated.event(
    [{ nativeEvent: { contentOffset: { x: horizontalScrollX } } }],
    { useNativeDriver: false },
  );

  const { bottom } = useSafeAreaInsets();
  const bottomOffset = bottom > 0 ? bottom + 8 : 8;

  const TabButtons = () => (
    <View
      style={{ paddingBottom: bottomOffset }}
      className="bottom-0 absolute left-0 right-0"
    >
      <BlurView
        intensity={30}
        experimentalBlurMethod="dimezisBlurView"
        className="overflow-hidden rounded-full mx-4 border-4 border-light-main-container/80"
      >
        <View
          className="bg-mainborder-light-main-container/10 w-full flex-row items-center justify-evenly relative"
          onLayout={(e) => setTabRowWidth(e.nativeEvent.layout.width)}
        >
          <TouchableOpacity
            onPress={() => handleTabChange("transfers")}
            activeOpacity={0.7}
            className="px-2 py-2 items-center justify-center flex-1"
          >
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.8}
              className={`${activeActivity === "transfers" ? "text-light-primary-red/75" : "text-light-matte-black/50"} text-center font-bold`}
            >
              Transfers
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => handleTabChange("payments")}
            activeOpacity={0.7}
            className="px-2 py-2 items-center justify-center flex-1"
          >
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.8}
              className={`${activeActivity === "payments" ? "text-light-primary-red/75" : "text-light-matte-black/50"} text-center font-bold`}
            >
              Payments
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => handleTabChange("redemptions")}
            activeOpacity={0.7}
            className="px-2 py-2 items-center justify-center flex-1"
          >
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.8}
              className={`${activeActivity === "redemptions" ? "text-light-primary-red/75" : "text-light-matte-black/50"} text-center font-bold`}
            >
              Redemptions
            </Text>
          </TouchableOpacity>

          <Animated.View
            className="absolute bottom-0 h-1 bg-light-primary-red/75 left-0 rounded-t-md"
            style={{
              width: tabSegmentWidth,
              transform: [
                {
                  translateX: horizontalScrollX.interpolate({
                    inputRange: [0, width, 2 * width],
                    outputRange: [0, tabSegmentWidth, 2 * tabSegmentWidth],
                    extrapolate: "clamp",
                  }),
                },
              ],
            }}
          />
        </View>
      </BlurView>
    </View>
  );

  // Three render branches:
  //   1. Auth probe in flight (cold boot, no cached state) -> spinner.
  //   2. Probe finished, no session -> inline sign-in CTA. Replaces the
  //      old auto-redirect to `/auth` that fired whenever the JWT
  //      expired mid-screen — that redirect was the source of the
  //      "GO_BACK was not handled" warning and the jarring screen swap.
  //   3. Authenticated -> real activity tabs.
  return (
    <>
      <SystemBars style="dark" />
      {isAuthLoading || isAuthenticated === null ? (
        <LoadinngSpinnerPopup
          visible={true}
          title="Authentication"
          message="Checking authentication..."
        />
      ) : !isAuthenticated ? (
        <SafeAreaView
          edges={["top"]}
          className="flex-1 bg-light-main-container"
        >
          <View className="px-4 pt-2 pb-4">
            <View className="flex-row items-center gap-3">
              <Pressable
                onPress={() => router.back()}
                hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                className="w-9 h-9 rounded-xl bg-light items-center justify-center shadow-sm"
              >
                <ArrowLeft size={18} color="#c71c4b" />
              </Pressable>
              <Text className="text-light-matte-black text-2xl font-bold tracking-tight flex-1">
                Activities
              </Text>
            </View>
          </View>

          <View className="flex-1 items-center justify-center px-10">
            <View className="items-center max-w-[280px] mb-8">
              <Text className="text-light-matte-black font-bold text-2xl mb-3 text-center">
                Sign in to view your activity
              </Text>
              <Text className="text-light-matte-black/45 text-center text-sm leading-6">
                Track all your on-chain transactions, payments, and redemptions.
                Sign in with {chainFamily} to get started.
              </Text>
            </View>

            <TouchableOpacity
              activeOpacity={0.8}
              onPress={goToAuth}
              disabled={navigatingToAuth}
              className={`py-4 px-8 rounded-2xl flex-row items-center gap-3 mb-6 ${
                navigatingToAuth
                  ? "bg-light-primary-red/80"
                  : "bg-light-primary-red"
              }`}
              style={{
                shadowColor: "#c71c4b",
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.2,
                shadowRadius: 12,
                elevation: 8,
              }}
            >
              {navigatingToAuth && (
                <ActivityIndicator size="small" color="#ffffff" />
              )}
              <Text className="text-white font-bold text-base">
                {navigatingToAuth
                  ? "Opening sign-in…"
                  : `Sign In With ${chainFamily}`}
              </Text>
            </TouchableOpacity>

            <View className="gap-2.5 w-full">
              <View className="flex-row items-center gap-3 px-3 py-2.5 rounded-xl bg-light">
                <View className="bg-light-primary-red/10 p-1.5 rounded-lg">
                  <Sparkles color="#c71c4b" size={14} strokeWidth={2.5} />
                </View>
                <Text className="text-light-matte-black/55 text-xs flex-1 font-medium">
                  Secure & gasless authentication
                </Text>
              </View>
              <View className="flex-row items-center gap-3 px-3 py-2.5 rounded-xl bg-light">
                <View className="bg-light-primary-red/10 p-1.5 rounded-lg">
                  <TrendingUp color="#c71c4b" size={14} strokeWidth={2.5} />
                </View>
                <Text className="text-light-matte-black/55 text-xs flex-1 font-medium">
                  Track all your on-chain activity
                </Text>
              </View>
            </View>
          </View>
        </SafeAreaView>
      ) : (
        <SafeAreaView
          className="flex-1 bg-light-main-container relative"
          edges={["top"]}
          style={{ paddingBottom: bottomOffset }}
        >
          <View className="flex-1 relative">
            <ActivityHeader
              placeholder={searchPlaceholder}
              searchBarOpacity={searchBarOpacity}
            />
            <FlatList
              ref={horizontalScrollRef}
              data={[
                { id: "transfers" },
                { id: "payments" },
                { id: "redemptions" },
              ]}
              renderItem={renderTabContent}
              keyExtractor={(item) => item.id}
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              initialScrollIndex={TAB_INDEX[activeActivity]}
              getItemLayout={(_, index) => ({
                length: width,
                offset: width * index,
                index,
              })}
              onMomentumScrollEnd={handleHorizontalScroll}
              onScroll={handleScroll}
              scrollEventThrottle={16}
            />
          </View>
          <TabButtons />
        </SafeAreaView>
      )}
    </>
  );
}
