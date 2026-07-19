/**
 * StrategyConfigCard — small read card for `defi_get_config` (spec §7.4).
 *
 * Shows the safety envelope the guardian reasons against (risk tier,
 * whitelist, liquidity preference) so the user can see *why* an intent
 * might be flagged. A `null` strategy renders a friendly "no strategy set
 * yet" line. Presentational only — no namespace branch, no chain reads.
 */

import { Settings2, ShieldCheck } from "lucide-react-native";
import type React from "react";
import { Text, View } from "react-native";
import type { ToolComponentProps } from "../types";

type Strategy = {
  tier?: string;
  liquidity_pref?: string;
  protocol_whitelist?: string[];
  allow_all_in_tier?: boolean;
  paused_at?: string | null;
};

type StrategyConfigOutput = {
  status?: string;
  data?: { strategy?: Strategy | null };
};

const BRAND_RED = "#c71c4b";
const MUTED_GRAY = "#6b7280";

function titleCase(s: string | undefined): string {
  if (!s) return "—";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="mt-1 flex-row items-center justify-between">
      <Text className="text-xs text-gray-500">{label}</Text>
      <Text className="text-xs font-semibold text-light-matte-black">
        {value}
      </Text>
    </View>
  );
}

const StrategyConfigCard: React.FC<
  ToolComponentProps<unknown, StrategyConfigOutput>
> = ({ output }) => {
  const strategy = output?.data?.strategy;

  if (!strategy) {
    return (
      <View className="my-1.5 rounded-2xl border border-gray-200 bg-gray-50 px-3.5 py-3">
        <View className="flex-row items-center gap-2">
          <Settings2 size={16} color={MUTED_GRAY} />
          <Text className="text-sm text-gray-600">
            {"No strategy set yet. I'll use safe defaults."}
          </Text>
        </View>
      </View>
    );
  }

  const whitelist = Array.isArray(strategy.protocol_whitelist)
    ? strategy.protocol_whitelist
    : [];
  const whitelistLabel = strategy.allow_all_in_tier
    ? "All in tier"
    : whitelist.length > 0
      ? `${whitelist.length} protocol${whitelist.length === 1 ? "" : "s"}`
      : "None";

  return (
    <View className="my-1.5 rounded-2xl border border-gray-200 bg-white px-3.5 py-3">
      <View className="flex-row items-center gap-2">
        <ShieldCheck size={16} color={BRAND_RED} />
        <Text className="text-sm font-semibold text-light-matte-black">
          Your safety envelope
        </Text>
        {strategy.paused_at ? (
          <Text className="ml-auto text-[11px] font-semibold text-amber-700">
            Paused
          </Text>
        ) : null}
      </View>
      <View className="mt-1.5">
        <Row label="Risk tier" value={titleCase(strategy.tier)} />
        <Row label="Liquidity" value={titleCase(strategy.liquidity_pref)} />
        <Row label="Whitelist" value={whitelistLabel} />
      </View>
    </View>
  );
};

export default StrategyConfigCard;
