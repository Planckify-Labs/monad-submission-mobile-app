/**
 * Gas Settings screen — choose the default token used to pay network gas.
 *
 * Two options:
 *   - USDC (gas abstraction): transfers route through the 1Shot relayer
 *     and gas is charged in USDC. Only applies on supported EVM chains;
 *     elsewhere the app silently uses native gas.
 *   - Native token: classic path — gas paid in ETH / MATIC / BNB / …
 *
 * The preference is persisted in MMKV via `usePreferredGasToken` and read
 * by `resolveGasPayment` for every onchain write (send screen + agent).
 */

import { router } from "expo-router";
import { ArrowLeft, Check, Coins, Fuel, Zap } from "lucide-react-native";
import { Pressable, ScrollView, Text, View } from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { usePreferredGasToken } from "@/hooks/usePreferredGasToken";
import type { GasFeeTokenPreference } from "@/services/gasAbstraction/types";

const cardShadow = {
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.04,
  shadowRadius: 6,
  elevation: 1,
};

export default function GasSettingsScreen() {
  const { bottom } = useSafeAreaInsets();
  const { preferredGasToken, setPreferredGasToken } = usePreferredGasToken();

  return (
    <>
      <SystemBars style="dark" />
      <SafeAreaView
        className="flex-1 bg-light-main-container"
        edges={["top"]}
        style={{ paddingBottom: bottom > 0 ? bottom : 0 }}
      >
        {/* Header */}
        <View className="px-4 pt-2 pb-4">
          <View className="flex-row items-center gap-3">
            <Pressable
              onPress={() => router.back()}
              hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
              className="w-9 h-9 rounded-xl bg-light items-center justify-center shadow-sm"
              accessibilityRole="button"
              accessibilityLabel="Back"
            >
              <ArrowLeft size={18} color="#c71c4b" />
            </Pressable>
            <View className="flex-1">
              <Text className="text-light-matte-black text-2xl font-bold tracking-tight">
                Gas Settings
              </Text>
              <Text className="text-light-matte-black/50 text-xs mt-0.5">
                Choose which token pays your transaction fees.
              </Text>
            </View>
          </View>
        </View>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingBottom: 48 }}
          showsVerticalScrollIndicator={false}
        >
          <View className="mx-4 mb-4">
            <Text className="text-light-matte-black/50 text-xs uppercase tracking-wide mb-2 ml-1">
              Default gas token
            </Text>
            <View
              className="bg-light rounded-2xl overflow-hidden"
              style={cardShadow}
            >
              <GasTokenOption
                icon={Coins}
                label="USDC"
                hint="Pay gas in USDC — no ETH needed. Used on supported networks."
                value="usdc"
                selected={preferredGasToken === "usdc"}
                onSelect={setPreferredGasToken}
              />
              <View className="h-px bg-light-matte-black/5" />
              <GasTokenOption
                icon={Zap}
                label="Native token"
                hint="Pay gas in the chain's native coin (ETH, MATIC, BNB, …)."
                value="native"
                selected={preferredGasToken === "native"}
                onSelect={setPreferredGasToken}
              />
            </View>
          </View>

          {/* Explainer */}
          <View className="mx-4 mt-2">
            <View className="bg-light-primary-red/5 rounded-2xl p-4">
              <View className="flex-row items-center mb-2">
                <Fuel size={16} color="#c71c4b" />
                <Text className="text-light-matte-black font-semibold text-sm ml-2">
                  How USDC gas works
                </Text>
              </View>
              <Text className="text-light-matte-black/70 text-xs leading-5">
                When USDC is selected, eligible transfers are relayed and the
                network fee is charged in USDC instead of the native coin — so
                you can transact with no ETH in your wallet.
              </Text>
              <Text className="text-light-matte-black/70 text-xs leading-5 mt-2">
                If a network doesn&apos;t support USDC gas, or your USDC
                can&apos;t cover the transfer plus the fee, we&apos;ll let you
                know rather than quietly spending your native balance.
              </Text>
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

function GasTokenOption({
  icon: Icon,
  label,
  hint,
  value,
  selected,
  onSelect,
}: {
  icon: typeof Coins;
  label: string;
  hint: string;
  value: GasFeeTokenPreference;
  selected: boolean;
  onSelect: (value: GasFeeTokenPreference) => void;
}) {
  return (
    <Pressable
      onPress={() => onSelect(value)}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      className="px-4 py-3 flex-row items-center"
    >
      <View className="w-9 h-9 rounded-xl bg-light-primary-red/10 items-center justify-center mr-3">
        <Icon size={18} color="#c71c4b" />
      </View>
      <View className="flex-1 pr-3">
        <Text className="text-light-matte-black font-semibold">{label}</Text>
        <Text className="text-light-matte-black/50 text-xs mt-0.5">{hint}</Text>
      </View>
      <View
        className={`w-6 h-6 rounded-full border-2 items-center justify-center ${
          selected
            ? "border-light-primary-red bg-light-primary-red"
            : "border-light-matte-black/30"
        }`}
      >
        {selected && <Check size={14} color="white" />}
      </View>
    </Pressable>
  );
}
