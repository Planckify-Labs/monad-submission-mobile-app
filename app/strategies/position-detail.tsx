import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import {
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpRight,
  CalendarClock,
  ExternalLink,
  Hash,
  Info,
  TrendingDown,
  TrendingUp,
  Wallet,
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
import type { TStrategyPosition } from "@/api/types/strategy";
import { useStrategyPositions } from "@/hooks/queries/useStrategy";

const CARD_SHADOW = {
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.04,
  shadowRadius: 6,
  elevation: 1,
} as const;

const statusAccent: Record<string, { bg: string; text: string; dot: string }> =
  {
    active: {
      bg: "bg-emerald-50",
      text: "text-emerald-700",
      dot: "bg-emerald-500",
    },
    withdrawn: {
      bg: "bg-light-matte-black/5",
      text: "text-light-matte-black",
      dot: "bg-light-matte-black/40",
    },
    failed: { bg: "bg-rose-50", text: "text-rose-700", dot: "bg-rose-500" },
  };

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function shortHash(hash: string | null | undefined): string {
  if (!hash) return "—";
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

function MetricRow({
  label,
  value,
  tone = "default",
  showDivider,
  trailing,
}: {
  label: string;
  value: string;
  tone?: "default" | "positive" | "negative";
  showDivider?: boolean;
  trailing?: React.ReactNode;
}) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-600"
      : tone === "negative"
        ? "text-rose-600"
        : "text-light-matte-black";
  return (
    <View
      className={`flex-row items-center justify-between py-3 px-4 ${showDivider ? "border-t border-light-matte-black/5" : ""}`}
    >
      <Text className="text-sm text-light-matte-black/60">{label}</Text>
      <View className="flex-row items-center">
        <Text className={`text-sm font-semibold ${toneClass}`}>{value}</Text>
        {trailing}
      </View>
    </View>
  );
}

export default function PositionDetail() {
  const router = useRouter();
  const { bottom } = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { data: positions } = useStrategyPositions(true);

  const position = useMemo<TStrategyPosition | undefined>(() => {
    if (!positions || !id) return undefined;
    return positions.find((p) => p.id === id);
  }, [positions, id]);

  const currentUsd = position?.currentAmountUsd
    ? Number(position.currentAmountUsd)
    : position
      ? Number(position.amountAtDepositUsd)
      : Number.NaN;
  const entryUsd = position ? Number(position.amountAtDepositUsd) : Number.NaN;
  const pnl =
    Number.isFinite(currentUsd) && Number.isFinite(entryUsd)
      ? currentUsd - entryUsd
      : Number.NaN;
  const pnlPct =
    Number.isFinite(pnl) && entryUsd > 0 ? (pnl / entryUsd) * 100 : 0;
  const pnlPositive = Number.isFinite(pnl) ? pnl >= 0 : true;

  const accent = position
    ? (statusAccent[position.status] ?? statusAccent.active)
    : statusAccent.active;

  const openTx = position?.openTxHash ?? null;

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
                Position
              </Text>
              <Text className="text-light-matte-black/50 text-xs mt-0.5">
                Live performance and history.
              </Text>
            </View>
          </View>
        </View>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingBottom: 120 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Hero value card */}
          <View className="mx-4 mb-5">
            <View className="bg-light rounded-2xl p-5" style={CARD_SHADOW}>
              <View className="flex-row items-center justify-between mb-4">
                <View className="flex-row items-center">
                  <View className="w-11 h-11 rounded-2xl bg-light-primary-red/10 items-center justify-center mr-3">
                    <Wallet size={20} color="#c71c4b" />
                  </View>
                  <View>
                    <Text
                      className="text-light-matte-black font-bold text-base"
                      numberOfLines={1}
                    >
                      {position?.protocolSlug ?? "Loading…"}
                    </Text>
                    <Text className="text-light-matte-black/50 text-xs">
                      {position
                        ? `${position.assetSymbol} · ${position.chainName}`
                        : "Fetching position…"}
                    </Text>
                  </View>
                </View>
                <View
                  className={`flex-row items-center px-2.5 py-1 rounded-full ${accent.bg}`}
                >
                  <View
                    className={`w-1.5 h-1.5 rounded-full mr-1.5 ${accent.dot}`}
                  />
                  <Text
                    className={`text-[11px] font-semibold capitalize ${accent.text}`}
                  >
                    {position?.status ?? "—"}
                  </Text>
                </View>
              </View>

              <Text className="text-light-matte-black/50 text-xs">
                Current value
              </Text>
              <Text className="text-light-matte-black text-3xl font-bold tracking-tight mt-1">
                {Number.isFinite(currentUsd)
                  ? `$${currentUsd.toFixed(2)}`
                  : "—"}
              </Text>
              <View className="flex-row items-center mt-2">
                {pnlPositive ? (
                  <TrendingUp size={14} color="#059669" />
                ) : (
                  <TrendingDown size={14} color="#dc2626" />
                )}
                <Text
                  className={`text-sm font-semibold ml-1 ${pnlPositive ? "text-emerald-600" : "text-rose-600"}`}
                >
                  {Number.isFinite(pnl)
                    ? `${pnlPositive ? "+" : ""}$${Math.abs(pnl).toFixed(2)}`
                    : "—"}
                </Text>
                <Text
                  className={`text-xs ml-1.5 ${pnlPositive ? "text-emerald-600/80" : "text-rose-600/80"}`}
                >
                  ({pnlPositive ? "+" : ""}
                  {pnlPct.toFixed(2)}%)
                </Text>
              </View>

              <View className="flex-row mt-5 pt-5 border-t border-light-matte-black/5">
                <View className="flex-1">
                  <Text className="text-light-matte-black/50 text-[11px] uppercase tracking-wide">
                    Entry
                  </Text>
                  <Text className="text-light-matte-black font-bold text-base mt-1">
                    {Number.isFinite(entryUsd)
                      ? `$${entryUsd.toFixed(2)}`
                      : "—"}
                  </Text>
                </View>
                <View className="flex-1">
                  <Text className="text-light-matte-black/50 text-[11px] uppercase tracking-wide">
                    Opened
                  </Text>
                  <Text className="text-light-matte-black font-bold text-base mt-1">
                    {formatDate(position?.openedAt)}
                  </Text>
                </View>
              </View>
            </View>
          </View>

          {/* Details */}
          <View className="mx-4 mb-5">
            <View className="flex-row items-center mb-2 ml-1">
              <CalendarClock size={14} color="#c71c4b" />
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
                value={position?.protocolSlug ?? "—"}
              />
              <MetricRow
                label="Asset"
                value={position?.assetSymbol ?? "—"}
                showDivider
              />
              <MetricRow
                label="Chain"
                value={position?.chainName ?? "—"}
                showDivider
              />
              {position?.goal ? (
                <MetricRow label="Goal" value={position.goal} showDivider />
              ) : null}
              {position?.targetDate ? (
                <MetricRow
                  label="Target date"
                  value={formatDate(position.targetDate)}
                  showDivider
                />
              ) : null}
              {position?.closedAt ? (
                <MetricRow
                  label="Closed"
                  value={formatDate(position.closedAt)}
                  showDivider
                />
              ) : null}
            </View>
          </View>

          {/* Transactions */}
          <View className="mx-4 mb-5">
            <View className="flex-row items-center mb-2 ml-1">
              <Hash size={14} color="#c71c4b" />
              <Text className="text-light-matte-black/50 text-xs uppercase tracking-wide ml-1.5">
                Transactions
              </Text>
            </View>
            <View
              className="bg-light rounded-2xl overflow-hidden"
              style={CARD_SHADOW}
            >
              <MetricRow
                label="Deposit"
                value={shortHash(openTx)}
                trailing={
                  openTx ? (
                    <ExternalLink
                      size={14}
                      color="#c71c4b"
                      style={{ marginLeft: 6 }}
                    />
                  ) : null
                }
              />
              {position?.closeTxHash ? (
                <MetricRow
                  label="Withdraw"
                  value={shortHash(position.closeTxHash)}
                  showDivider
                  trailing={
                    <ExternalLink
                      size={14}
                      color="#c71c4b"
                      style={{ marginLeft: 6 }}
                    />
                  }
                />
              ) : null}
            </View>
          </View>

          {/* Note */}
          <View className="mx-4 mb-4">
            <View className="flex-row items-start bg-light-primary-red/10 rounded-2xl p-4">
              <Info size={16} color="#c71c4b" />
              <Text className="text-light-matte-black/70 text-xs ml-2.5 flex-1 leading-4">
                Values update as protocols report new balances. Withdraws are
                signed on-device.
              </Text>
            </View>
          </View>
        </ScrollView>

        {/* Sticky action bar */}
        <View
          className="absolute left-0 right-0 bottom-0 px-4 pt-3 bg-light-main-container/95"
          style={{ paddingBottom: Math.max(bottom, 16) }}
        >
          <View className="flex-row gap-3">
            <TouchableOpacity
              activeOpacity={0.85}
              disabled={!position}
              onPress={() => router.back()}
              className={`flex-1 rounded-full py-4 flex-row items-center justify-center ${position ? "bg-light" : "bg-light-matte-black/10"}`}
              style={CARD_SHADOW}
            >
              <ArrowDownLeft size={16} color="#c71c4b" />
              <Text className="text-light-primary-red font-bold text-base ml-2">
                Top up
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              activeOpacity={0.85}
              disabled={!position}
              onPress={() => router.back()}
              className={`flex-1 rounded-full py-4 flex-row items-center justify-center ${position ? "bg-light-primary-red" : "bg-light-matte-black/20"}`}
              style={
                position
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
                Withdraw
              </Text>
              <ArrowUpRight size={16} color="#ffffff" strokeWidth={2.5} />
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    </>
  );
}
