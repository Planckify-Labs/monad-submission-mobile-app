/**
 * Gas Settings screen — choose the default token used to pay network gas.
 *
 * Options:
 *   - Native token: classic path — gas paid in ETH / MON / BNB / …
 *   - One row per stablecoin the gas-abstraction provider accepts on ANY
 *     of the networks this build surfaces (mainnet and testnet alike),
 *     read live via `useGasFeeTokenOptions` — never a hardcoded list.
 *     Each row says which of the user's networks it pays gas on; on a
 *     network where the chosen token isn't accepted the app uses native
 *     gas.
 *
 * The preference is persisted in MMKV via `usePreferredGasToken` and read
 * by `resolveGasPayment` for every onchain write (send screen + agent).
 */

import { router } from "expo-router";
import { ArrowLeft, Check, Coins, Fuel, Zap } from "lucide-react-native";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { useGasFeeTokenOptions } from "@/hooks/useGasFeeTokenOptions";
import { usePreferredGasToken } from "@/hooks/usePreferredGasToken";
import type {
  GasFeeTokenChain,
  GasFeeTokenOption,
} from "@/services/gasAbstraction/feeTokenOptions";
import {
  feeTokenSymbolMatches,
  type GasFeeTokenPreference,
  isNativeGasPreference,
  NATIVE_GAS_TOKEN,
} from "@/services/gasAbstraction/types";

const cardShadow = {
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.04,
  shadowRadius: 6,
  elevation: 1,
};

/**
 * "Monad, Base Sepolia (testnet)" — the networks a token pays gas on.
 * Testnets are labelled so a mainnet-only reading is never mistaken.
 */
function describeChains(chains: readonly GasFeeTokenChain[]): string {
  return chains
    .map((c) => (c.isTestnet ? `${c.name} (testnet)` : c.name))
    .join(", ");
}

export default function GasSettingsScreen() {
  const { bottom } = useSafeAreaInsets();
  const { preferredGasToken, setPreferredGasToken } = usePreferredGasToken();
  const { options, probedChainCount, isLoading } = useGasFeeTokenOptions();

  // A stored symbol no surfaced network accepts (e.g. picked on another
  // build) still gets a row, so the selection is visible and switchable
  // instead of silently showing nothing selected. Decided only once the
  // live lists are in, so a valid choice never flashes as an orphan.
  const orphanSelection =
    !isLoading &&
    !isNativeGasPreference(preferredGasToken) &&
    !options.some((o) => feeTokenSymbolMatches(o.symbol, preferredGasToken))
      ? preferredGasToken
      : null;

  const noStablecoinOptions =
    !isLoading && options.length === 0 && orphanSelection === null;

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
                icon={Zap}
                label="Native token"
                hint="Pay gas in the chain's native coin (ETH, MON, BNB, and so on)."
                value={NATIVE_GAS_TOKEN}
                selected={isNativeGasPreference(preferredGasToken)}
                onSelect={setPreferredGasToken}
              />
              {options.map((option) => (
                <StablecoinOption
                  key={option.symbol}
                  option={option}
                  selected={feeTokenSymbolMatches(
                    option.symbol,
                    preferredGasToken,
                  )}
                  onSelect={setPreferredGasToken}
                />
              ))}
              {orphanSelection !== null && (
                <>
                  <View className="h-px bg-light-matte-black/5" />
                  <GasTokenOption
                    icon={Coins}
                    label={orphanSelection}
                    hint="Not accepted for gas on any of your current networks. Gas is paid in the native token until you pick another option."
                    value={orphanSelection}
                    selected
                    onSelect={setPreferredGasToken}
                  />
                </>
              )}
              {isLoading && (
                <>
                  <View className="h-px bg-light-matte-black/5" />
                  <View className="px-4 py-3 flex-row items-center">
                    <ActivityIndicator size="small" color="#c71c4b" />
                    <Text className="text-light-matte-black/50 text-xs ml-3">
                      Checking which stablecoins your networks accept for gas
                    </Text>
                  </View>
                </>
              )}
              {noStablecoinOptions && (
                <>
                  <View className="h-px bg-light-matte-black/5" />
                  <View className="px-4 py-3">
                    <Text className="text-light-matte-black/50 text-xs leading-5">
                      {probedChainCount === 0
                        ? "None of your current networks support paying gas in a stablecoin yet."
                        : "We couldn't find any stablecoin gas options for your current networks right now. Please try again later."}
                    </Text>
                  </View>
                </>
              )}
            </View>
          </View>

          {/* Explainer */}
          <View className="mx-4 mt-2">
            <View className="bg-light-primary-red/5 rounded-2xl p-4">
              <View className="flex-row items-center mb-2">
                <Fuel size={16} color="#c71c4b" />
                <Text className="text-light-matte-black font-semibold text-sm ml-2">
                  How stablecoin gas works
                </Text>
              </View>
              <Text className="text-light-matte-black/70 text-xs leading-5">
                When a stablecoin is selected, eligible transfers are relayed
                and the network fee is charged in that token instead of the
                native coin, so you can transact with none of the native coin in
                your wallet. The relayer charges the fee in the token you pick;
                nothing is sponsored.
              </Text>
              <Text className="text-light-matte-black/70 text-xs leading-5 mt-2">
                Each option lists the networks it works on. On any other network
                the native coin pays gas as usual. If your stablecoin can&apos;t
                cover the transfer plus the fee, we&apos;ll let you know rather
                than quietly spending your native balance.
              </Text>
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

/** One live stablecoin row: symbol + the networks it pays gas on. */
function StablecoinOption({
  option,
  selected,
  onSelect,
}: {
  option: GasFeeTokenOption;
  selected: boolean;
  onSelect: (value: GasFeeTokenPreference) => void;
}) {
  return (
    <>
      <View className="h-px bg-light-matte-black/5" />
      <GasTokenOption
        icon={Coins}
        label={option.symbol}
        hint={`Pay gas in ${option.symbol} on ${describeChains(option.chains)}.`}
        value={option.symbol}
        selected={selected}
        onSelect={onSelect}
      />
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
