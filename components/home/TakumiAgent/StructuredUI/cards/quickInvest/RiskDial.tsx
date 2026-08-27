/**
 * The risk dial from mockup concept #11 — Safe / Balanced / Aggressive as
 * three tappable words under the amount track.
 *
 * Unlike the amount slider this is NOT a client-side recompute
 * (docs/defi-quick-invest-spec.md §3.1): `tier` is a hard Prisma filter
 * server-side, so a payload fetched as "balanced" contains only balanced
 * rows and there is nothing conservative to fall back to. The card
 * re-fetches on change; this component only reports the choice and shows
 * that a fetch is in flight.
 */

import { Pressable, Text, View } from "react-native";
import { tapFeedback } from "@/utils/hapticsUtils";

export type RiskTier = "conservative" | "balanced" | "aggressive";

export const RISK_TIERS: { key: RiskTier; label: string; color: string }[] = [
  { key: "conservative", label: "Safe", color: "#15803d" },
  { key: "balanced", label: "Balanced", color: "#b45309" },
  { key: "aggressive", label: "Aggressive", color: "#be123c" },
];

export default function RiskDial({
  value,
  onChange,
  loading = false,
  disabled = false,
}: {
  value: RiskTier;
  onChange: (next: RiskTier) => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  return (
    <View className={`flex-row items-center ${disabled ? "opacity-40" : ""}`}>
      {RISK_TIERS.map((tier) => {
        const active = tier.key === value;
        return (
          <Pressable
            key={tier.key}
            disabled={disabled}
            onPress={() => {
              if (active) return;
              tapFeedback();
              onChange(tier.key);
            }}
            hitSlop={8}
            className="flex-1 items-center py-1"
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`${tier.label} risk`}
          >
            <Text
              className="text-[11px] font-bold"
              style={{ color: active ? tier.color : "#9ca3af" }}
            >
              {tier.label}
            </Text>
            <View
              className="mt-1 h-0.5 w-6 rounded-full"
              style={{
                backgroundColor: active ? tier.color : "transparent",
                opacity: active && loading ? 0.35 : 1,
              }}
            />
          </Pressable>
        );
      })}
    </View>
  );
}
