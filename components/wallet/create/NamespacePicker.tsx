/**
 * `NamespacePicker` — reusable single/multi chain-family picker driven by
 * `walletKitRegistry.getAll()` (spec §14.5, §14.6).
 *
 * Consumed by `CreateWalletSheet`, `ImportSeedPhraseSheet`, and
 * `ImportPrivateKeySheet`. Rendering order follows registry insertion order
 * (EVM first, Solana second) — adding Sui later is a registry change; this
 * file needs zero edits.
 *
 * Rules (non-negotiable — per task 21 spec):
 *   - Never hard-code `["eip155", "solana"]`. Iteration always through
 *     `getAll()`, with the caller's optional `filter` predicate applied.
 *   - Tap target ≥ 44pt (iOS HIG / Material minimum).
 *   - Accessible: `checkbox` / `radio` role with `accessibilityState`
 *     reflecting selection, readable `accessibilityLabel`.
 *
 * Caller contract — `mode === "multi"` with "all checked by default":
 *   The component does NOT auto-seed `selected` on mount — that would hide
 *   the caller's intent from reducers and break controlled-component
 *   semantics. Callers render with
 *     `<NamespacePicker mode="multi" selected={namespaces} ... />`
 *   where `namespaces` is pre-populated with the full registered list
 *   (usually `walletKitRegistry.getAll().map(k => k.namespace)`).
 */

import { Check } from "lucide-react-native";
import type React from "react";
import { memo, useCallback } from "react";
import { Image, Pressable, Text, View } from "react-native";
import type { Namespace } from "@/services/chains/types";
import { getSupportedWalletKits } from "@/services/walletKit/chainSupport";
import type { WalletKitAdapter } from "@/services/walletKit/types";
import { computeNextSelection } from "./computeNextSelection";

type Props = {
  mode: "single" | "multi";
  selected: Namespace[];
  onChange: (v: Namespace[]) => void;
  filter?: (kit: WalletKitAdapter) => boolean;
};

const NamespacePicker: React.FC<Props> = memo(function NamespacePicker({
  mode,
  selected,
  onChange,
  filter,
}) {
  // Chain lockdown first, then the caller's own filter: a locked-down
  // build never offers a hidden chain family, whoever is asking.
  const supported = getSupportedWalletKits();
  const kits = filter ? supported.filter(filter) : supported;

  const handleTap = useCallback(
    (ns: Namespace) => {
      onChange(computeNextSelection(selected, ns, mode));
    },
    [onChange, selected, mode],
  );

  return (
    <View className="gap-2">
      {kits.map((kit) => {
        const ns = kit.namespace;
        const isSelected = selected.includes(ns);
        const label = kit.displayName ?? ns;
        const iconUrl = kit.iconUrl ?? null;
        const fallbackGlyph =
          (kit.displayName ?? kit.namespace).trim().charAt(0).toUpperCase() ||
          "?";

        const role: "checkbox" | "radio" =
          mode === "multi" ? "checkbox" : "radio";
        const stateKey = mode === "multi" ? "checked" : "selected";

        return (
          <Pressable
            key={ns}
            onPress={() => handleTap(ns)}
            accessibilityRole={role}
            accessibilityState={{ [stateKey]: isSelected }}
            accessibilityLabel={`${label}, ${
              isSelected ? "selected" : "not selected"
            }`}
            className={`flex-row items-center p-3 rounded-xl min-h-[44px] ${
              isSelected
                ? "bg-light-primary-red/10 border border-light-primary-red"
                : "bg-light-main-container border border-light-matte-black/10"
            }`}
            style={{ minHeight: 44 }}
          >
            {/* Selection indicator (checkbox or radio depending on mode) */}
            {mode === "multi" ? (
              <View
                className={`w-5 h-5 rounded border-2 mr-3 items-center justify-center ${
                  isSelected
                    ? "border-light-primary-red bg-light-primary-red"
                    : "border-light-matte-black/30"
                }`}
              >
                {isSelected ? <Check size={14} color="#ffffff" /> : null}
              </View>
            ) : (
              <View
                className={`w-5 h-5 rounded-full border-2 mr-3 items-center justify-center ${
                  isSelected
                    ? "border-light-primary-red"
                    : "border-light-matte-black/30"
                }`}
              >
                {isSelected ? (
                  <View className="w-2.5 h-2.5 rounded-full bg-light-primary-red" />
                ) : null}
              </View>
            )}

            {/* Kit icon / avatar fallback */}
            <View className="w-9 h-9 rounded-full bg-light-matte-black/5 items-center justify-center mr-3 overflow-hidden">
              {iconUrl ? (
                <Image
                  source={{ uri: iconUrl }}
                  style={{ width: 36, height: 36 }}
                  accessibilityIgnoresInvertColors
                />
              ) : (
                <Text className="text-light-matte-black font-bold">
                  {fallbackGlyph}
                </Text>
              )}
            </View>

            {/* Label */}
            <View className="flex-1">
              <Text className="text-light-matte-black font-semibold">
                {label}
              </Text>
              <Text className="text-light-matte-black/60 text-xs mt-0.5">
                {ns}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
});

export default NamespacePicker;
export { NamespacePicker };
export type { Props as NamespacePickerProps };
