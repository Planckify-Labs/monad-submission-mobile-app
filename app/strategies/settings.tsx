import { Stack, useRouter } from "expo-router";
import {
  ArrowLeft,
  Bell,
  Check,
  Coins,
  Layers,
  PauseCircle,
  Percent,
  RefreshCw,
  Repeat2,
  ShieldCheck,
  Timer,
} from "lucide-react-native";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import type { TCreateStrategyPayload } from "@/api/endpoints/strategies";
import type { AssetPreference, RiskTier } from "@/api/types/strategy";
import { useBlockchains } from "@/hooks/queries/useBlockchains";
import {
  useStrategyProtocols,
  useUpdateStrategyMutation,
  useUserStrategy,
} from "@/hooks/queries/useStrategy";

type LiqPref = TCreateStrategyPayload["liquidityPref"];
type NotifLevel = TCreateStrategyPayload["notificationLevel"];
type RebalanceTrigger = TCreateStrategyPayload["rebalanceTrigger"];

const TIER_OPTIONS: { value: RiskTier; label: string }[] = [
  { value: "conservative", label: "Conservative" },
  { value: "balanced", label: "Balanced" },
  { value: "aggressive", label: "Aggressive" },
];

const ASSET_OPTIONS: {
  value: AssetPreference;
  label: string;
  hint: string;
}[] = [
  { value: "stable", label: "Stablecoins", hint: "USDC, USDT, DAI" },
  { value: "eth_lst", label: "ETH + LSTs", hint: "ETH, stETH, rETH" },
  { value: "multi", label: "Multi-asset", hint: "Mixed pools and LPs" },
];

const LIQUIDITY_OPTIONS: { value: LiqPref; label: string }[] = [
  { value: "instant", label: "Instant" },
  { value: "7d", label: "Up to 7 days" },
  { value: "30d", label: "30+ days" },
];

const ALLOCATION_OPTIONS = [10, 25, 50] as const;

const REBALANCE_OPTIONS: {
  value: RebalanceTrigger;
  label: string;
  hint: string;
}[] = [
  {
    value: { kind: "interval", value: "weekly" },
    label: "Weekly check-in",
    hint: "Re-check opportunities every 7 days",
  },
  {
    value: { kind: "interval", value: "monthly" },
    label: "Monthly check-in",
    hint: "Re-check opportunities every 30 days",
  },
  {
    value: { kind: "yield_drop", thresholdPct: 20 },
    label: "Only when APY drops > 20%",
    hint: "Move only on sharp yield drops",
  },
];

const NOTIF_OPTIONS: { value: NotifLevel; label: string }[] = [
  { value: "every", label: "Every action" },
  { value: "daily", label: "Daily digest" },
  { value: "alerts", label: "Alerts only" },
];

const CARD_SHADOW = {
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.04,
  shadowRadius: 6,
  elevation: 1,
} as const;

function Section({
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ComponentType<{ size?: number; color?: string }>;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <View className="mx-4 mb-5">
      <View className="flex-row items-center mb-2 ml-1">
        <Icon size={14} color="#c71c4b" />
        <Text className="text-light-matte-black/50 text-xs uppercase tracking-wide ml-1.5">
          {title}
        </Text>
      </View>
      <View
        className="bg-light rounded-2xl overflow-hidden"
        style={CARD_SHADOW}
      >
        {subtitle ? (
          <Text className="text-light-matte-black/50 text-xs px-4 pt-4 leading-4">
            {subtitle}
          </Text>
        ) : null}
        <View className={subtitle ? "p-4" : "p-4"}>{children}</View>
      </View>
    </View>
  );
}

function ChipRow<T>({
  options,
  isSelected,
  onPress,
  labelOf,
  keyOf,
}: {
  options: T[];
  isSelected: (option: T) => boolean;
  onPress: (value: T) => void;
  labelOf: (option: T) => string;
  keyOf: (option: T) => string;
}) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {options.map((opt) => {
        const sel = isSelected(opt);
        return (
          <TouchableOpacity
            key={keyOf(opt)}
            onPress={() => onPress(opt)}
            activeOpacity={0.85}
            className={`px-4 py-2.5 rounded-full border ${
              sel
                ? "bg-light-primary-red border-light-primary-red"
                : "bg-light-main-container border-light-matte-black/10"
            }`}
          >
            <Text
              className={`text-sm font-semibold ${
                sel ? "text-white" : "text-light-matte-black"
              }`}
            >
              {labelOf(opt)}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function ToggleRow({
  label,
  hint,
  selected,
  showDivider,
  onPress,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  showDivider?: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      className={`flex-row items-center py-3 ${showDivider ? "border-t border-light-matte-black/5" : ""}`}
    >
      <View className="flex-1 pr-3">
        <Text
          className={`text-sm font-semibold ${
            selected ? "text-light-primary-red" : "text-light-matte-black"
          }`}
        >
          {label}
        </Text>
        {hint ? (
          <Text className="text-light-matte-black/50 text-xs mt-0.5">
            {hint}
          </Text>
        ) : null}
      </View>
      <View
        className={`w-5 h-5 rounded-md items-center justify-center ${
          selected
            ? "bg-light-primary-red"
            : "border border-light-matte-black/25"
        }`}
      >
        {selected ? <Check size={14} color="#ffffff" /> : null}
      </View>
    </TouchableOpacity>
  );
}

const sameRebalance = (a: RebalanceTrigger, b: RebalanceTrigger): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind === "interval" && b.kind === "interval")
    return a.value === b.value;
  if (a.kind === "yield_drop" && b.kind === "yield_drop")
    return a.thresholdPct === b.thresholdPct;
  return false;
};

export default function StrategiesSettings() {
  const router = useRouter();
  const { bottom } = useSafeAreaInsets();
  const { data: strategy, isLoading } = useUserStrategy();
  const update = useUpdateStrategyMutation();
  const { data: blockchains } = useBlockchains();

  // Lazy initializers seed the form from the cached strategy on frame
  // 0 (MMKV-backed `useUserStrategy` returns data synchronously for
  // returning users) so the form renders fully populated without a
  // double-render flash. The `hydratedRef` below covers the rare
  // true-cold-start case where the strategy arrives after mount.
  const [tier, setTier] = useState<RiskTier>(
    () => strategy?.tier ?? "conservative",
  );
  const [assetPreferences, setAssetPreferences] = useState<AssetPreference[]>(
    () => strategy?.assetPreferences ?? [],
  );
  const [liquidityPref, setLiquidityPref] = useState<LiqPref>(
    () => (strategy?.liquidityPref as LiqPref) ?? "instant",
  );
  const [chainPref, setChainPref] = useState<Array<number | "any">>(() =>
    Array.isArray(strategy?.chainPref)
      ? (strategy.chainPref as Array<number | "any">)
      : ["any"],
  );
  const [allocationPct, setAllocationPct] = useState<number>(
    () => strategy?.allocationPct ?? 10,
  );
  const [rebalanceTrigger, setRebalanceTrigger] = useState<RebalanceTrigger>(
    () =>
      strategy?.rebalanceTrigger &&
      typeof strategy.rebalanceTrigger === "object"
        ? (strategy.rebalanceTrigger as RebalanceTrigger)
        : REBALANCE_OPTIONS[0].value,
  );
  const [protocolWhitelist, setProtocolWhitelist] = useState<string[]>(
    () => strategy?.protocolWhitelist ?? [],
  );
  const [notificationLevel, setNotificationLevel] = useState<NotifLevel>(
    () => (strategy?.notificationLevel as NotifLevel) ?? "daily",
  );
  const [paused, setPaused] = useState<boolean>(() => !!strategy?.pausedAt);
  const [autoCompound, setAutoCompound] = useState<boolean>(
    () => !!strategy?.autoCompound,
  );

  const { data: tierProtocols } = useStrategyProtocols(tier);

  // Hydrate state only the FIRST time `strategy` becomes available
  // (true cold start). After that, subsequent background refetches
  // must not clobber user edits in progress.
  const hydratedRef = useRef<boolean>(!!strategy);
  useEffect(() => {
    if (hydratedRef.current || !strategy) return;
    hydratedRef.current = true;
    setTier(strategy.tier);
    setAssetPreferences(strategy.assetPreferences ?? []);
    setLiquidityPref(strategy.liquidityPref as LiqPref);
    setChainPref(
      Array.isArray(strategy.chainPref)
        ? (strategy.chainPref as Array<number | "any">)
        : ["any"],
    );
    setAllocationPct(strategy.allocationPct);
    if (
      strategy.rebalanceTrigger &&
      typeof strategy.rebalanceTrigger === "object"
    ) {
      setRebalanceTrigger(strategy.rebalanceTrigger as RebalanceTrigger);
    }
    setProtocolWhitelist(strategy.protocolWhitelist ?? []);
    setNotificationLevel(strategy.notificationLevel as NotifLevel);
    setPaused(!!strategy.pausedAt);
    setAutoCompound(!!strategy.autoCompound);
  }, [strategy]);

  const evmChains = useMemo(
    () =>
      (blockchains ?? []).filter(
        (b) => b.isActive && typeof b.chainId === "number",
      ),
    [blockchains],
  );

  const toggleAsset = (value: AssetPreference) => {
    setAssetPreferences((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  };

  const toggleChain = (id: number) => {
    setChainPref((prev) => {
      const withoutAny = prev.filter((v) => v !== "any") as number[];
      if (withoutAny.includes(id)) {
        const next = withoutAny.filter((v) => v !== id);
        return next.length === 0 ? ["any"] : next;
      }
      return [...withoutAny, id];
    });
  };

  const toggleWhitelist = (slug: string) => {
    setProtocolWhitelist((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
    );
  };

  const handleSave = () => {
    // Fire-and-forget: the mutation's `onMutate` optimistically writes
    // the new preferences to the React Query cache and MMKV, so the
    // strategies index renders the new state the moment we pop back.
    // `onError` rolls both back if the server rejects, and we surface
    // an Alert at that point.
    update.mutate(
      {
        tier,
        assetPreferences:
          assetPreferences.length > 0 ? assetPreferences : ["stable"],
        liquidityPref,
        chainPref,
        allocationPct,
        rebalanceTrigger,
        protocolWhitelist,
        allowAllInTier: false,
        autoCompound,
        notificationLevel,
      },
      {
        onError: (err) => {
          if (__DEV__) console.warn("[strategies-settings] save failed:", err);
          Alert.alert(
            "We couldn't save your changes",
            "Your previous settings were restored. Please try again in a moment.",
          );
        },
      },
    );
    router.back();
  };

  const renderHeader = (subtitle: string) => (
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
            Strategy settings
          </Text>
          <Text className="text-light-matte-black/50 text-xs mt-0.5">
            {subtitle}
          </Text>
        </View>
      </View>
    </View>
  );

  if (isLoading) {
    return (
      <>
        <SystemBars style="dark" />
        <SafeAreaView
          className="flex-1 bg-light-main-container"
          edges={["top"]}
        >
          <Stack.Screen options={{ headerShown: false }} />
          {renderHeader("Tune your DeFi preferences.")}
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="large" color="#c71c4b" />
          </View>
        </SafeAreaView>
      </>
    );
  }

  if (!strategy) {
    return (
      <>
        <SystemBars style="dark" />
        <SafeAreaView
          className="flex-1 bg-light-main-container"
          edges={["top"]}
        >
          <Stack.Screen options={{ headerShown: false }} />
          {renderHeader("Tune your DeFi preferences.")}
          <View className="flex-1 items-center justify-center p-8">
            <View className="w-16 h-16 rounded-2xl bg-light-primary-red/10 items-center justify-center mb-4">
              <ShieldCheck size={28} color="#c71c4b" />
            </View>
            <Text className="text-light-matte-black font-bold text-center mb-2">
              No strategy yet
            </Text>
            <Text className="text-light-matte-black/50 text-sm text-center mb-6 max-w-[260px]">
              Set your preferences first to start earning yield.
            </Text>
            <TouchableOpacity
              onPress={() => router.replace("/strategies/onboarding")}
              className="bg-light-primary-red rounded-full px-6 py-3"
            >
              <Text className="text-white font-bold">Set up now</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </>
    );
  }

  return (
    <>
      <SystemBars style="dark" />
      <SafeAreaView
        className="flex-1 bg-light-main-container"
        edges={["top"]}
        style={{ paddingBottom: bottom > 0 ? bottom : 0 }}
      >
        <Stack.Screen options={{ headerShown: false }} />
        {renderHeader("Tune your DeFi preferences.")}

        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingBottom: 120 }}
          showsVerticalScrollIndicator={false}
        >
          <Section
            icon={PauseCircle}
            title="Strategy state"
            subtitle="When paused, the agent will not propose any DeFi actions. Existing positions are unaffected."
          >
            <View className="flex-row items-center justify-between">
              <Text
                className={`text-sm font-semibold ${paused ? "text-light-matte-black/60" : "text-emerald-600"}`}
              >
                {paused ? "Paused" : "Active"}
              </Text>
              <Switch
                value={paused}
                onValueChange={setPaused}
                trackColor={{ false: "#E5E7EB", true: "#c71c4b" }}
                thumbColor="#fff"
              />
            </View>
          </Section>

          <Section
            icon={ShieldCheck}
            title="Risk tier"
            subtitle="Hard ceiling on what the agent can propose."
          >
            <ChipRow
              options={TIER_OPTIONS}
              onPress={(opt) => setTier(opt.value)}
              isSelected={(opt) => opt.value === tier}
              labelOf={(opt) => opt.label}
              keyOf={(opt) => opt.value}
            />
          </Section>

          <Section icon={Coins} title="Assets" subtitle="Pick one or more.">
            {ASSET_OPTIONS.map((opt, idx) => (
              <ToggleRow
                key={opt.value}
                label={opt.label}
                hint={opt.hint}
                selected={assetPreferences.includes(opt.value)}
                showDivider={idx > 0}
                onPress={() => toggleAsset(opt.value)}
              />
            ))}
          </Section>

          <Section icon={Timer} title="Liquidity preference">
            <ChipRow
              options={LIQUIDITY_OPTIONS}
              onPress={(opt) => setLiquidityPref(opt.value)}
              isSelected={(opt) => opt.value === liquidityPref}
              labelOf={(opt) => opt.label}
              keyOf={(opt) => opt.value}
            />
          </Section>

          <Section
            icon={Layers}
            title="Preferred chains"
            subtitle='Drawn from chains your wallet supports. "Any" lets the agent pick the best one for each deposit.'
          >
            <ToggleRow
              label="Any chain (recommended)"
              selected={chainPref.includes("any")}
              onPress={() => setChainPref(["any"])}
            />
            {evmChains.length > 0 ? (
              evmChains.map((c) => (
                <ToggleRow
                  key={c.id}
                  label={c.name}
                  hint={c.isTestnet ? "Testnet" : undefined}
                  selected={
                    !chainPref.includes("any") &&
                    chainPref.includes(c.chainId as number)
                  }
                  showDivider
                  onPress={() => toggleChain(c.chainId as number)}
                />
              ))
            ) : (
              <View className="py-4 items-center">
                <ActivityIndicator color="#c71c4b" />
              </View>
            )}
          </Section>

          <Section
            icon={Percent}
            title="Allocation cap"
            subtitle="The agent will never exceed this share of your idle balance across all DeFi positions."
          >
            <ChipRow
              options={ALLOCATION_OPTIONS as unknown as number[]}
              onPress={(opt) => setAllocationPct(opt)}
              isSelected={(opt) => opt === allocationPct}
              labelOf={(opt) => `${opt}%`}
              keyOf={(opt) => String(opt)}
            />
          </Section>

          <Section
            icon={RefreshCw}
            title="Rebalance"
            subtitle="How often we should propose moving funds. You'll always sign on-device."
          >
            {REBALANCE_OPTIONS.map((opt, idx) => (
              <ToggleRow
                key={idx}
                label={opt.label}
                hint={opt.hint}
                selected={sameRebalance(opt.value, rebalanceTrigger)}
                showDivider={idx > 0}
                onPress={() => setRebalanceTrigger(opt.value)}
              />
            ))}
          </Section>

          <Section
            icon={ShieldCheck}
            title="Protocols"
            subtitle="Empty = use the curated default for your tier. Pick specific protocols to restrict the agent."
          >
            {tierProtocols && tierProtocols.length > 0 ? (
              tierProtocols.map((p, idx) => (
                <ToggleRow
                  key={p.protocolSlug}
                  label={p.protocolSlug}
                  hint={`${p.assetSymbol} · ${p.chainName}`}
                  selected={protocolWhitelist.includes(p.protocolSlug)}
                  showDivider={idx > 0}
                  onPress={() => toggleWhitelist(p.protocolSlug)}
                />
              ))
            ) : (
              <Text className="text-sm text-light-matte-black/50 py-2">
                No curated protocols for this tier yet.
              </Text>
            )}
          </Section>

          <Section
            icon={Repeat2}
            title="Auto-compound"
            subtitle="When on, claimed rewards are automatically redeposited into the same position. You still sign each cycle — nothing happens without your tap."
          >
            <View className="flex-row items-center justify-between">
              <Text
                className={`text-sm font-semibold ${autoCompound ? "text-emerald-600" : "text-light-matte-black/60"}`}
              >
                {autoCompound ? "On" : "Off"}
              </Text>
              <Switch
                value={autoCompound}
                onValueChange={setAutoCompound}
                trackColor={{ false: "#E5E7EB", true: "#c71c4b" }}
                thumbColor="#fff"
              />
            </View>
          </Section>

          <Section icon={Bell} title="Notifications">
            <ChipRow
              options={NOTIF_OPTIONS}
              onPress={(opt) => setNotificationLevel(opt.value)}
              isSelected={(opt) => opt.value === notificationLevel}
              labelOf={(opt) => opt.label}
              keyOf={(opt) => opt.value}
            />
          </Section>
        </ScrollView>

        {/* Sticky save bar */}
        <View
          className="absolute left-0 right-0 bottom-0 px-4 pt-3 bg-light-main-container/95"
          style={{ paddingBottom: Math.max(bottom, 16) }}
        >
          <TouchableOpacity
            onPress={handleSave}
            disabled={update.isPending}
            activeOpacity={0.85}
            className="bg-light-primary-red rounded-full py-4 items-center"
            style={{
              shadowColor: "#c71c4b",
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: 0.25,
              shadowRadius: 12,
              elevation: 8,
            }}
          >
            {update.isPending ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text className="text-white font-bold text-base">
                Save changes
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </>
  );
}
