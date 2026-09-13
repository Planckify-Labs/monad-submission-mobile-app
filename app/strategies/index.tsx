import { Stack, useRouter } from "expo-router";
import {
  ArrowLeft,
  ChevronRight,
  PauseCircle,
  Settings2,
  Sparkles,
  TrendingUp,
  Wallet,
} from "lucide-react-native";
import React from "react";
import {
  Pressable,
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
import type { TPortfolioPositionStatus } from "@/api/types/portfolio";
import type { TOpportunity, TStrategyPosition } from "@/api/types/strategy";
import SingleLoadingSekeleton from "@/components/common/SingleLoadingSekeleton";
import { useBlockchains } from "@/hooks/queries/useBlockchains";
import {
  type PortfolioPositionGroup,
  usePortfolioPositions,
} from "@/hooks/queries/usePortfolioPositions";
import {
  useStrategyOpportunities,
  useStrategyPositions,
  useUserStrategy,
} from "@/hooks/queries/useStrategy";
import { useWallet } from "@/hooks/useWallet";
import { decimalsForSymbol } from "@/services/defi/assetDecimals";

const tierLabel: Record<string, string> = {
  conservative: "Conservative",
  balanced: "Balanced",
  aggressive: "Aggressive",
};

const tierAccent: Record<string, { bg: string; text: string; dot: string }> = {
  conservative: {
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    dot: "bg-emerald-500",
  },
  balanced: {
    bg: "bg-amber-50",
    text: "text-amber-700",
    dot: "bg-amber-500",
  },
  aggressive: {
    bg: "bg-rose-50",
    text: "text-rose-700",
    dot: "bg-rose-500",
  },
};

const CARD_SHADOW = {
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.04,
  shadowRadius: 6,
  elevation: 1,
} as const;

function TierBadge({ tier }: { tier: string }) {
  const accent = tierAccent[tier] ?? {
    bg: "bg-light-matte-black/5",
    text: "text-light-matte-black",
    dot: "bg-light-matte-black/40",
  };
  return (
    <View
      className={`flex-row items-center px-2.5 py-1 rounded-full ${accent.bg}`}
    >
      <View className={`w-1.5 h-1.5 rounded-full mr-1.5 ${accent.dot}`} />
      <Text className={`text-[11px] font-semibold ${accent.text}`}>
        {tierLabel[tier] ?? tier}
      </Text>
    </View>
  );
}

function PositionRow({
  position,
  showDivider,
  onPress,
}: {
  position: TStrategyPosition;
  showDivider: boolean;
  onPress: () => void;
}) {
  const currentUsd = position.currentAmountUsd
    ? Number(position.currentAmountUsd)
    : Number(position.amountAtDepositUsd);
  const entryUsd = Number(position.amountAtDepositUsd);
  const pnl = currentUsd - entryUsd;
  const pnlPct = entryUsd > 0 ? (pnl / entryUsd) * 100 : 0;
  const pnlPositive = pnl >= 0;
  const rawAmount = position.currentAmountRaw ?? position.amountAtDeposit;
  const tokenAmount = rawAmount
    ? Number(rawAmount) / 10 ** decimalsForSymbol(position.assetSymbol)
    : null;

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      className={`px-4 py-3.5 flex-row items-center ${showDivider ? "border-t border-light-matte-black/5" : ""}`}
    >
      <View className="w-9 h-9 rounded-xl bg-light-primary-red/10 items-center justify-center mr-3">
        <Wallet size={16} color="#c71c4b" />
      </View>
      <View className="flex-1 pr-2">
        <Text
          className="text-light-matte-black font-semibold"
          numberOfLines={1}
        >
          {position.protocolSlug}
        </Text>
        <Text className="text-light-matte-black/50 text-xs mt-0.5">
          {position.assetSymbol} · {position.chainName}
        </Text>
        {Number.isFinite(position.currentApy) &&
        position.currentApy !== null ? (
          <Text className="text-emerald-600 text-[11px] font-semibold mt-0.5">
            Earning {Number(position.currentApy).toFixed(2)}% APY
          </Text>
        ) : null}
      </View>
      <View className="items-end">
        {tokenAmount !== null ? (
          <Text className="text-light-matte-black font-bold">
            {tokenAmount.toLocaleString(undefined, {
              maximumFractionDigits: 6,
            })}{" "}
            {position.assetSymbol}
          </Text>
        ) : null}
        <Text className="text-light-matte-black/60 text-xs mt-0.5">
          ${currentUsd.toFixed(2)}
        </Text>
        <Text
          className={`text-[11px] font-semibold mt-0.5 ${pnlPositive ? "text-emerald-600" : "text-rose-600"}`}
        >
          {pnlPositive ? "+" : ""}
          {pnlPct.toFixed(2)}%
        </Text>
      </View>
      <ChevronRight size={16} color="#c71c4b" style={{ marginLeft: 8 }} />
    </TouchableOpacity>
  );
}

function OpportunityRow({
  opportunity,
  showDivider,
  onPress,
}: {
  opportunity: TOpportunity;
  showDivider: boolean;
  onPress: () => void;
}) {
  const apy = Number(opportunity.apy);
  // Backend stores APY in percent units (e.g. 5.2 == 5.2%) — render directly.
  const apyLabel = Number.isFinite(apy) ? `${apy.toFixed(2)}%` : "—";

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      className={`px-4 py-3.5 flex-row items-center ${showDivider ? "border-t border-light-matte-black/5" : ""}`}
    >
      <View className="w-9 h-9 rounded-xl bg-emerald-50 items-center justify-center mr-3">
        <TrendingUp size={16} color="#059669" />
      </View>
      <View className="flex-1 pr-2">
        <View className="flex-row items-center">
          <Text
            className="text-light-matte-black font-semibold flex-shrink"
            numberOfLines={1}
          >
            {opportunity.protocolSlug}
          </Text>
          <View className="ml-2">
            <TierBadge tier={opportunity.tier} />
          </View>
        </View>
        <Text className="text-light-matte-black/50 text-xs mt-0.5">
          {opportunity.assetSymbol} · {opportunity.chainName}
        </Text>
      </View>
      <View className="items-end">
        <Text className="text-emerald-600 font-bold">{apyLabel}</Text>
        <Text className="text-light-matte-black/50 text-[11px] mt-0.5">
          APY
        </Text>
      </View>
      <ChevronRight size={16} color="#c71c4b" style={{ marginLeft: 8 }} />
    </TouchableOpacity>
  );
}

const SKELETON_BG = "#E5E7EB";
const SKELETON_BG_STRONG = "#E0E0E0";

function HeroSkeleton() {
  return (
    <View className="mx-4 mb-6">
      <View className="bg-light rounded-2xl p-5" style={CARD_SHADOW}>
        <View className="flex-row items-center justify-between mb-3">
          <SingleLoadingSekeleton
            width={90}
            height={22}
            borderRadius={999}
            style={{ backgroundColor: SKELETON_BG }}
          />
          <SingleLoadingSekeleton
            width={70}
            height={22}
            borderRadius={999}
            style={{ backgroundColor: SKELETON_BG }}
          />
        </View>
        <SingleLoadingSekeleton
          width={80}
          height={12}
          borderRadius={4}
          style={{ backgroundColor: SKELETON_BG }}
        />
        <View className="mt-2">
          <SingleLoadingSekeleton
            width={160}
            height={32}
            borderRadius={6}
            style={{ backgroundColor: SKELETON_BG_STRONG }}
          />
        </View>
        <View className="flex-row mt-4 pt-4 border-t border-light-matte-black/5">
          {[0, 1, 2].map((i) => (
            <View key={i} className="flex-1">
              <SingleLoadingSekeleton
                width={60}
                height={10}
                borderRadius={4}
                style={{
                  backgroundColor: SKELETON_BG,
                  marginBottom: 6,
                }}
              />
              <SingleLoadingSekeleton
                width={50}
                height={18}
                borderRadius={4}
                style={{ backgroundColor: SKELETON_BG_STRONG }}
              />
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

function RowSkeleton({ showDivider }: { showDivider: boolean }) {
  return (
    <View
      className={`px-4 py-3.5 flex-row items-center ${showDivider ? "border-t border-light-matte-black/5" : ""}`}
    >
      <SingleLoadingSekeleton
        width={36}
        height={36}
        borderRadius={12}
        style={{ backgroundColor: SKELETON_BG_STRONG, marginRight: 12 }}
      />
      <View className="flex-1">
        <SingleLoadingSekeleton
          width={120}
          height={14}
          borderRadius={4}
          style={{ backgroundColor: SKELETON_BG_STRONG, marginBottom: 6 }}
        />
        <SingleLoadingSekeleton
          width={80}
          height={10}
          borderRadius={4}
          style={{ backgroundColor: SKELETON_BG }}
        />
      </View>
      <View className="items-end">
        <SingleLoadingSekeleton
          width={60}
          height={14}
          borderRadius={4}
          style={{ backgroundColor: SKELETON_BG_STRONG, marginBottom: 6 }}
        />
        <SingleLoadingSekeleton
          width={36}
          height={10}
          borderRadius={4}
          style={{ backgroundColor: SKELETON_BG }}
        />
      </View>
    </View>
  );
}

function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <View className="bg-light rounded-2xl overflow-hidden" style={CARD_SHADOW}>
      {Array.from({ length: rows }).map((_, i) => (
        <RowSkeleton key={i} showDivider={i > 0} />
      ))}
    </View>
  );
}

function SectionLabel({
  label,
  action,
  onAction,
}: {
  label: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <View className="flex-row items-center justify-between mb-2 ml-1">
      <Text className="text-light-matte-black/50 text-xs uppercase tracking-wide">
        {label}
      </Text>
      {action ? (
        <TouchableOpacity onPress={onAction} activeOpacity={0.6}>
          <Text className="text-light-primary-red text-xs font-semibold">
            {action}
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

/**
 * A protocol position we discovered rather than opened.
 *
 * These are tracked, not managed: there is no in-app withdraw path, and the
 * value is the data provider's estimate rather than an on-chain read, so the
 * row says so instead of implying the same confidence as a managed position.
 */
function TrackedPositionGroup({
  group,
  showDivider,
}: {
  group: PortfolioPositionGroup;
  showDivider: boolean;
}) {
  return (
    <View
      className={`px-4 py-3.5 ${showDivider ? "border-t border-light-matte-black/5" : ""}`}
    >
      <View className="flex-row items-center justify-between">
        <View className="flex-1 pr-3">
          <Text
            className="text-light-matte-black font-semibold"
            numberOfLines={1}
          >
            {group.protocolName}
          </Text>
          <Text className="text-light-matte-black/50 text-xs mt-0.5">
            {group.positions.length}{" "}
            {group.positions.length === 1 ? "position" : "positions"}
          </Text>
        </View>
        <View className="items-end">
          <Text className="text-light-matte-black font-semibold">
            ${group.totalValueUsd.toFixed(2)}
          </Text>
          <Text className="text-light-matte-black/40 text-[10px] mt-0.5">
            Estimated
          </Text>
        </View>
      </View>

      <View className="mt-2">
        {group.positions.map((position) => (
          <View
            key={`${position.zerionChainId}-${position.assetContract ?? position.assetSymbol}-${position.status}`}
            className="flex-row items-center justify-between py-1"
          >
            <Text className="text-light-matte-black/60 text-xs">
              {position.assetSymbol}
              {"  "}
              <Text className="text-light-matte-black/40">
                {trackedStatusLabel[position.status]}
              </Text>
            </Text>
            <Text className="text-light-matte-black/60 text-xs">
              {position.valueUsd === null
                ? "N/A"
                : `$${position.valueUsd.toFixed(2)}`}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** Plain-language labels. "deposit" and "borrowed" are jargon on their own. */
const trackedStatusLabel: Record<TPortfolioPositionStatus, string> = {
  deposit: "Supplied",
  staked: "Staked",
  locked: "Locked",
  reward: "Claimable",
  borrowed: "Borrowed",
};

export default function StrategiesIndex() {
  const router = useRouter();
  const { bottom } = useSafeAreaInsets();
  const { data: strategy, isLoading: strategyLoading } = useUserStrategy();
  const hasStrategy = !!strategy;
  const { activeWallet } = useWallet();
  const { data: blockchains } = useBlockchains();

  // Note: no useFocusEffect refetch here on purpose. React Query's
  // staleTime + refetchOnMount already handle background freshness, and
  // the create/update mutations write through to the cache + MMKV, so
  // returning from /strategies/onboarding or /strategies/settings shows
  // the new state without another round-trip.

  const { data: positions } = useStrategyPositions(
    hasStrategy,
    activeWallet?.address,
    blockchains,
  );
  const { data: opportunities } = useStrategyOpportunities(
    strategy ? { tier: strategy.tier } : {},
    hasStrategy,
  );

  // Positions held outside this app, discovered from the wallet rather than
  // recorded when we opened them.
  const { groups: trackedGroups } = usePortfolioPositions({
    enabled: Boolean(activeWallet?.address),
  });

  if (strategyLoading) {
    return (
      <>
        <SystemBars style="dark" />
        <SafeAreaView
          className="flex-1 bg-light-main-container"
          edges={["top"]}
          style={{ paddingBottom: bottom > 0 ? bottom : 0 }}
        >
          <Stack.Screen options={{ headerShown: false }} />

          <View className="px-4 pt-2 pb-4">
            <View className="flex-row items-center gap-3">
              <Pressable
                onPress={() => router.back()}
                hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                className="w-9 h-9 rounded-xl bg-light items-center justify-center"
                style={CARD_SHADOW}
              >
                <ArrowLeft size={18} color="#c71c4b" />
              </Pressable>
              <View className="flex-1">
                <Text className="text-light-matte-black text-2xl font-bold tracking-tight">
                  Strategies
                </Text>
                <Text className="text-light-matte-black/50 text-xs mt-0.5">
                  Curated yield, agent-managed.
                </Text>
              </View>
            </View>
          </View>

          <ScrollView
            className="flex-1"
            contentContainerStyle={{ paddingBottom: 32 }}
            showsVerticalScrollIndicator={false}
            scrollEnabled={false}
          >
            <HeroSkeleton />

            <View className="mx-4 mb-6">
              <SectionLabel label="Your positions" />
              <ListSkeleton rows={2} />
            </View>

            <View className="mx-4 mb-4">
              <SectionLabel label="Recommended for you" />
              <ListSkeleton rows={3} />
            </View>
          </ScrollView>
        </SafeAreaView>
      </>
    );
  }

  if (!hasStrategy) {
    return (
      <>
        <SystemBars style="dark" />
        <SafeAreaView
          className="flex-1 bg-light-main-container"
          edges={["top"]}
          style={{ paddingBottom: bottom > 0 ? bottom : 0 }}
        >
          <Stack.Screen options={{ headerShown: false }} />
          <View className="px-4 pt-2 pb-4">
            <View className="flex-row items-center gap-3">
              <Pressable
                onPress={() => router.back()}
                hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                className="w-9 h-9 rounded-xl bg-light items-center justify-center"
                style={CARD_SHADOW}
              >
                <ArrowLeft size={18} color="#c71c4b" />
              </Pressable>
              <View className="flex-1">
                <Text className="text-light-matte-black text-2xl font-bold tracking-tight">
                  DeFi Strategies
                </Text>
                <Text className="text-light-matte-black/50 text-xs mt-0.5">
                  Put idle balances to work.
                </Text>
              </View>
            </View>
          </View>

          <View className="flex-1 items-center justify-center px-8">
            <View className="w-20 h-20 rounded-3xl bg-light-primary-red/10 items-center justify-center mb-5">
              <Sparkles size={32} color="#c71c4b" />
            </View>
            <Text className="text-light-matte-black text-xl font-bold text-center">
              Earn yield, your way
            </Text>
            <Text className="text-light-matte-black/50 text-sm text-center mt-2 mb-8 max-w-[280px] leading-5">
              Set your risk tier and let the agent allocate idle balances to
              curated opportunities.
            </Text>
            <TouchableOpacity
              onPress={() => router.push("/strategies/onboarding")}
              activeOpacity={0.85}
              className="bg-light-primary-red rounded-full px-8 py-3.5"
              style={{
                shadowColor: "#c71c4b",
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.25,
                shadowRadius: 12,
                elevation: 8,
              }}
            >
              <Text className="text-white font-bold text-[15px]">
                Get started
              </Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </>
    );
  }

  const isPaused = !!strategy.pausedAt;
  const positionCount = positions?.length ?? 0;
  const totalValueUsd = (positions ?? []).reduce((sum, p) => {
    const v = p.currentAmountUsd
      ? Number(p.currentAmountUsd)
      : Number(p.amountAtDepositUsd);
    return sum + (Number.isFinite(v) ? v : 0);
  }, 0);

  return (
    <>
      <SystemBars style="dark" />
      <SafeAreaView
        className="flex-1 bg-light-main-container"
        edges={["top"]}
        style={{ paddingBottom: bottom > 0 ? bottom : 0 }}
      >
        <Stack.Screen options={{ headerShown: false }} />

        <View className="px-4 pt-2 pb-4">
          <View className="flex-row items-center gap-3">
            <Pressable
              onPress={() => router.back()}
              hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
              className="w-9 h-9 rounded-xl bg-light items-center justify-center"
              style={CARD_SHADOW}
            >
              <ArrowLeft size={18} color="#c71c4b" />
            </Pressable>
            <View className="flex-1">
              <Text className="text-light-matte-black text-2xl font-bold tracking-tight">
                Strategies
              </Text>
              <Text className="text-light-matte-black/50 text-xs mt-0.5">
                Curated yield, agent-managed.
              </Text>
            </View>
            <Pressable
              onPress={() => router.push("/strategies/settings")}
              hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
              className="w-9 h-9 rounded-xl bg-light items-center justify-center"
              style={CARD_SHADOW}
              accessibilityLabel="Strategy settings"
            >
              <Settings2 size={18} color="#c71c4b" />
            </Pressable>
          </View>
        </View>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingBottom: 32 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Summary hero */}
          <View className="mx-4 mb-6">
            <View className="bg-light rounded-2xl p-5" style={CARD_SHADOW}>
              <View className="flex-row items-center justify-between mb-3">
                <TierBadge tier={strategy.tier} />
                {isPaused ? (
                  <View className="flex-row items-center px-2.5 py-1 rounded-full bg-light-matte-black/5">
                    <PauseCircle size={12} color="#20222c" />
                    <Text className="text-light-matte-black text-[11px] font-semibold ml-1">
                      Paused
                    </Text>
                  </View>
                ) : (
                  <View className="flex-row items-center px-2.5 py-1 rounded-full bg-emerald-50">
                    <View className="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5" />
                    <Text className="text-emerald-700 text-[11px] font-semibold">
                      Active
                    </Text>
                  </View>
                )}
              </View>
              <Text className="text-light-matte-black/50 text-xs">
                Total value
              </Text>
              <Text className="text-light-matte-black text-3xl font-bold tracking-tight mt-1">
                ${totalValueUsd.toFixed(2)}
              </Text>
              <View className="flex-row mt-4 pt-4 border-t border-light-matte-black/5">
                <View className="flex-1">
                  <Text className="text-light-matte-black/50 text-[11px] uppercase tracking-wide">
                    Allocation
                  </Text>
                  <Text className="text-light-matte-black font-bold text-base mt-1">
                    {strategy.allocationPct}%
                  </Text>
                </View>
                <View className="flex-1">
                  <Text className="text-light-matte-black/50 text-[11px] uppercase tracking-wide">
                    Positions
                  </Text>
                  <Text className="text-light-matte-black font-bold text-base mt-1">
                    {positionCount}
                  </Text>
                </View>
                <View className="flex-1">
                  <Text className="text-light-matte-black/50 text-[11px] uppercase tracking-wide">
                    Tier
                  </Text>
                  <Text className="text-light-matte-black font-bold text-base mt-1">
                    {tierLabel[strategy.tier] ?? strategy.tier}
                  </Text>
                </View>
              </View>
            </View>
          </View>

          {/* Positions */}
          <View className="mx-4 mb-6">
            <SectionLabel label="Your positions" />
            <View
              className="bg-light rounded-2xl overflow-hidden"
              style={CARD_SHADOW}
            >
              {positions && positions.length > 0 ? (
                positions.map((p, idx) => (
                  <PositionRow
                    key={p.id}
                    position={p}
                    showDivider={idx > 0}
                    onPress={() =>
                      router.push({
                        pathname: "/strategies/position-detail",
                        params: { id: p.id },
                      })
                    }
                  />
                ))
              ) : (
                <View className="px-4 py-8 items-center">
                  <Wallet size={26} color="#c71c4b" />
                  <Text className="text-light-matte-black font-semibold mt-3">
                    No active positions
                  </Text>
                  <Text className="text-light-matte-black/50 text-xs text-center mt-1 max-w-[260px]">
                    Pick an opportunity below to put your idle balance to work.
                  </Text>
                </View>
              )}
            </View>
          </View>

          {/* Tracked elsewhere: discovered positions we don't manage */}
          {trackedGroups.length > 0 && (
            <View className="mx-4 mb-6">
              <SectionLabel label="Tracked elsewhere" />
              <View
                className="bg-light rounded-2xl overflow-hidden"
                style={CARD_SHADOW}
              >
                {trackedGroups.map((group, idx) => (
                  <TrackedPositionGroup
                    key={group.dappId}
                    group={group}
                    showDivider={idx > 0}
                  />
                ))}
              </View>
              <Text className="text-light-matte-black/40 text-[11px] mt-2 ml-1">
                Found in your wallet, opened outside this app. You can view
                these here, but withdrawals happen in the app you used.
              </Text>
            </View>
          )}

          {/* Opportunities */}
          <View className="mx-4 mb-4">
            <SectionLabel label="Recommended for you" />
            <View
              className="bg-light rounded-2xl overflow-hidden"
              style={CARD_SHADOW}
            >
              {opportunities && opportunities.length > 0 ? (
                opportunities.map((o, idx) => (
                  <OpportunityRow
                    key={o.id}
                    opportunity={o}
                    showDivider={idx > 0}
                    onPress={() =>
                      router.push({
                        pathname: "/strategies/opportunity-detail",
                        params: { id: o.protocolSlug },
                      })
                    }
                  />
                ))
              ) : (
                <View className="px-4 py-8 items-center">
                  <TrendingUp size={26} color="#c71c4b" />
                  <Text className="text-light-matte-black font-semibold mt-3">
                    No opportunities right now
                  </Text>
                  <Text className="text-light-matte-black/50 text-xs text-center mt-1 max-w-[260px]">
                    We&apos;ll surface new ones as they pass our scoring filter.
                  </Text>
                </View>
              )}
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    </>
  );
}
