import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import {
  ArrowLeft,
  ArrowUpRight,
  Droplets,
  Info,
  Layers,
  ShieldAlert,
  TrendingUp,
} from "lucide-react-native";
import React, { useMemo } from "react";
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
import type { TOpportunity } from "@/api/types/strategy";
import {
  useStrategyOpportunities,
  useUserStrategy,
} from "@/hooks/queries/useStrategy";

const tierLabel: Record<string, string> = {
  conservative: "Low risk",
  balanced: "Moderate risk",
  aggressive: "High risk",
};

const tierAccent: Record<string, { bg: string; text: string; dot: string }> = {
  conservative: {
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    dot: "bg-emerald-500",
  },
  balanced: { bg: "bg-amber-50", text: "text-amber-700", dot: "bg-amber-500" },
  aggressive: { bg: "bg-rose-50", text: "text-rose-700", dot: "bg-rose-500" },
};

const CARD_SHADOW = {
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.04,
  shadowRadius: 6,
  elevation: 1,
} as const;

function formatPct(value: string | number | null | undefined): string {
  const num = Number(value);
  // Backend stores APY/stddev in percent units (e.g. 5.2 == 5.2%) — render directly.
  return Number.isFinite(num) ? `${num.toFixed(2)}%` : "—";
}

function formatUsd(value: string | number | null | undefined): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  if (num >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(2)}K`;
  return `$${num.toFixed(2)}`;
}

function MetricRow({
  label,
  value,
  tone = "default",
  showDivider,
}: {
  label: string;
  value: string;
  tone?: "default" | "positive" | "warning";
  showDivider?: boolean;
}) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-600"
      : tone === "warning"
        ? "text-amber-600"
        : "text-light-matte-black";
  return (
    <View
      className={`flex-row items-center justify-between py-3 px-4 ${showDivider ? "border-t border-light-matte-black/5" : ""}`}
    >
      <Text className="text-sm text-light-matte-black/60">{label}</Text>
      <Text className={`text-sm font-semibold ${toneClass}`}>{value}</Text>
    </View>
  );
}

export default function OpportunityDetail() {
  const router = useRouter();
  const { bottom } = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { data: strategy } = useUserStrategy();
  const { data: opportunities } = useStrategyOpportunities(
    strategy ? { tier: strategy.tier } : {},
    !!strategy,
  );

  const opportunity = useMemo<TOpportunity | undefined>(() => {
    if (!opportunities || !id) return undefined;
    return opportunities.find((o) => o.protocolSlug === id);
  }, [opportunities, id]);

  const accent = opportunity
    ? (tierAccent[opportunity.tier] ?? tierAccent.balanced)
    : tierAccent.balanced;

  const apyLabel = opportunity ? formatPct(opportunity.apy) : "—";
  const apy7d = opportunity ? formatPct(opportunity.apy7dAvg) : "—";
  const tvl = opportunity ? formatUsd(opportunity.tvlUsd) : "—";
  const tvlDelta = opportunity ? Number(opportunity.tvl7dDelta) : Number.NaN;
  const tvlDeltaLabel = Number.isFinite(tvlDelta)
    ? `${tvlDelta >= 0 ? "+" : ""}${(tvlDelta * 100).toFixed(2)}%`
    : "—";

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
                Opportunity
              </Text>
              <Text className="text-light-matte-black/50 text-xs mt-0.5">
                Review before allocating.
              </Text>
            </View>
          </View>
        </View>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingBottom: 120 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Hero APY card */}
          <View className="mx-4 mb-5">
            <View className="bg-light rounded-2xl p-5" style={CARD_SHADOW}>
              <View className="flex-row items-center justify-between mb-4">
                <View
                  className={`flex-row items-center px-2.5 py-1 rounded-full ${accent.bg}`}
                >
                  <View
                    className={`w-1.5 h-1.5 rounded-full mr-1.5 ${accent.dot}`}
                  />
                  <Text className={`text-[11px] font-semibold ${accent.text}`}>
                    {tierLabel[opportunity?.tier ?? ""] ?? "—"}
                  </Text>
                </View>
                {opportunity?.ilExposure ? (
                  <View className="flex-row items-center px-2.5 py-1 rounded-full bg-amber-50">
                    <ShieldAlert size={12} color="#b45309" />
                    <Text className="text-amber-700 text-[11px] font-semibold ml-1">
                      IL risk
                    </Text>
                  </View>
                ) : null}
              </View>

              <View className="flex-row items-center mb-1">
                <View className="w-11 h-11 rounded-2xl bg-emerald-50 items-center justify-center mr-3">
                  <TrendingUp size={20} color="#059669" />
                </View>
                <View className="flex-1">
                  <Text
                    className="text-light-matte-black font-bold text-lg"
                    numberOfLines={1}
                  >
                    {opportunity?.protocolSlug ?? id ?? "Unknown protocol"}
                  </Text>
                  <Text className="text-light-matte-black/50 text-xs">
                    {opportunity
                      ? `${opportunity.assetSymbol} · ${opportunity.chainName}`
                      : "Loading details…"}
                  </Text>
                </View>
              </View>

              <View className="mt-5 pt-5 border-t border-light-matte-black/5 flex-row">
                <View className="flex-1">
                  <Text className="text-light-matte-black/50 text-[11px] uppercase tracking-wide">
                    Current APY
                  </Text>
                  <Text className="text-emerald-600 text-2xl font-bold tracking-tight mt-1">
                    {apyLabel}
                  </Text>
                </View>
                <View className="flex-1">
                  <Text className="text-light-matte-black/50 text-[11px] uppercase tracking-wide">
                    7d avg
                  </Text>
                  <Text className="text-light-matte-black text-2xl font-bold tracking-tight mt-1">
                    {apy7d}
                  </Text>
                </View>
              </View>
            </View>
          </View>

          {/* Pool metrics */}
          <View className="mx-4 mb-5">
            <View className="flex-row items-center mb-2 ml-1">
              <Droplets size={14} color="#c71c4b" />
              <Text className="text-light-matte-black/50 text-xs uppercase tracking-wide ml-1.5">
                Pool metrics
              </Text>
            </View>
            <View
              className="bg-light rounded-2xl overflow-hidden"
              style={CARD_SHADOW}
            >
              <MetricRow label="TVL" value={tvl} />
              <MetricRow
                label="TVL 7d delta"
                value={tvlDeltaLabel}
                tone={
                  Number.isFinite(tvlDelta) && tvlDelta >= 0
                    ? "positive"
                    : "warning"
                }
                showDivider
              />
              <MetricRow
                label="APY stddev (30d)"
                value={opportunity ? formatPct(opportunity.apyStddev30d) : "—"}
                showDivider
              />
              <MetricRow
                label="Risk score (0–100, higher is safer)"
                value={opportunity ? `${Math.round(opportunity.score)}` : "—"}
                showDivider
              />
            </View>
          </View>

          {/* Details */}
          <View className="mx-4 mb-5">
            <View className="flex-row items-center mb-2 ml-1">
              <Layers size={14} color="#c71c4b" />
              <Text className="text-light-matte-black/50 text-xs uppercase tracking-wide ml-1.5">
                Details
              </Text>
            </View>
            <View
              className="bg-light rounded-2xl overflow-hidden"
              style={CARD_SHADOW}
            >
              <MetricRow
                label="Protocol"
                value={opportunity?.protocolSlug ?? "—"}
              />
              <MetricRow
                label="Asset"
                value={opportunity?.assetSymbol ?? "—"}
                showDivider
              />
              <MetricRow
                label="Chain"
                value={opportunity?.chainName ?? "—"}
                showDivider
              />
              <MetricRow
                label="IL exposure"
                value={opportunity?.ilExposure ? "Yes" : "No"}
                tone={opportunity?.ilExposure ? "warning" : "positive"}
                showDivider
              />
            </View>
          </View>

          {/* Risk note */}
          <View className="mx-4 mb-4">
            <View className="flex-row items-start bg-light-primary-red/10 rounded-2xl p-4">
              <Info size={16} color="#c71c4b" />
              <Text className="text-light-matte-black/70 text-xs ml-2.5 flex-1 leading-4">
                APYs vary with market conditions. The agent will sign on-device
                and stay within your tier and allocation cap.
              </Text>
            </View>
          </View>
        </ScrollView>

        {/* Sticky CTA */}
        <View
          className="absolute left-0 right-0 bottom-0 px-4 pt-3 bg-light-main-container/95"
          style={{ paddingBottom: Math.max(bottom, 16) }}
        >
          <TouchableOpacity
            activeOpacity={0.85}
            disabled={!opportunity}
            onPress={() => router.back()}
            className={`rounded-full py-4 flex-row items-center justify-center ${opportunity ? "bg-light-primary-red" : "bg-light-matte-black/20"}`}
            style={
              opportunity
                ? {
                    shadowColor: "#c71c4b",
                    shadowOffset: { width: 0, height: 4 },
                    shadowOpacity: 0.25,
                    shadowRadius: 12,
                    elevation: 8,
                  }
                : undefined
            }
          >
            <Text className="text-white font-bold text-base mr-2">
              Allocate via agent
            </Text>
            <ArrowUpRight size={18} color="#ffffff" strokeWidth={2.5} />
          </TouchableOpacity>
          <Text className="text-light-matte-black/50 text-[11px] text-center mt-2">
            You&apos;ll review and sign the deposit on-device.
          </Text>
        </View>
      </SafeAreaView>
    </>
  );
}
