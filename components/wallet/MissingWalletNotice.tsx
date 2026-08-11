/**
 * `MissingWalletNotice` — the one rendering of "you don't hold a wallet
 * on this chain yet, here's how to fix it".
 *
 * Before this existed, each surface that hit the gap either said nothing
 * (dApp connect failed at the JSON-RPC layer with no Takumi UI at all),
 * said something wrong ("That isn't available on this network yet." for
 * a chain that is perfectly available), or said something right with no
 * way to act on it. This component is the shared answer, so a new
 * surface inherits correct wording and a working CTA instead of
 * reinventing all three.
 *
 * Pair it with `useAddWalletPrompt`, which owns the sheet:
 *
 *   const { promptFor, sheet } = useAddWalletPrompt();
 *   …
 *   <MissingWalletNotice namespace="sui" onPress={() => promptFor("sui")} />
 *   {sheet}
 */

import { Plus, WalletMinimal } from "lucide-react-native";
import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { missingWalletCopy } from "@/components/wallet/missingWalletCopy";
import type { Namespace } from "@/services/chains/types";

type Props = {
  namespace: Namespace;
  onPress: () => void;
  /**
   * `row` sits inside an existing list (chain switcher) and stays visually
   * subordinate to the real, selectable rows around it.
   * `block` owns an empty state (dApp connect sheet) and carries a full
   * button because there is nothing else on screen to act on.
   */
  variant?: "row" | "block";
};

const MissingWalletNotice = memo(function MissingWalletNotice({
  namespace,
  onPress,
  variant = "row",
}: Props) {
  const copy = missingWalletCopy(namespace);

  if (variant === "block") {
    return (
      <View className="p-4 rounded-2xl bg-light">
        <Text className="text-light-matte-black font-bold text-sm">
          {copy.title}
        </Text>
        <Text className="text-light-matte-black/60 text-xs mt-1">
          {copy.body}
        </Text>
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={copy.cta}
          className="flex-row items-center justify-center mt-3 py-3 rounded-full bg-light-primary-red active:opacity-80"
        >
          <Plus size={16} color="#ffffff" strokeWidth={2.5} />
          <Text className="text-light font-bold text-sm ml-1.5">
            {copy.cta}
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={copy.cta}
      android_ripple={{ color: "rgba(0,0,0,0.04)" }}
      className="flex-row items-center p-4 mb-2 rounded-xl bg-light active:opacity-70"
    >
      <View className="w-6 h-6 rounded-full bg-light-matte-black/5 items-center justify-center mr-3">
        <WalletMinimal size={14} color="#20222c80" />
      </View>
      <View className="flex-1">
        <Text className="text-light-matte-black/70 font-semibold text-sm">
          {copy.chainName}
        </Text>
        <Text className="text-light-matte-black/50 text-xs mt-0.5">
          {copy.title}
        </Text>
      </View>
      <View className="flex-row items-center">
        <Plus size={14} color="#c71c4b" strokeWidth={2.5} />
        <Text className="text-light-primary-red text-xs font-bold ml-1">
          Add
        </Text>
      </View>
    </Pressable>
  );
});

export default MissingWalletNotice;
export { MissingWalletNotice };
