/**
 * "View allocation" — the collapsed per-protocol breakdown from mockup
 * concept #11. Read-only by design: the split is computed (§5), so this
 * answers "where did it go", it is not a picker. Picking pool by pool is
 * the browse list's job and stays one tap away.
 *
 * APY here is the SAME 7-day basis the headline projection is built from
 * (§11.5) — showing current APY next to a 7d-derived headline would let a
 * user who checks the arithmetic find a discrepancy, which is exactly the
 * kind of thing that costs trust in a projected number.
 */

import { ChevronDown, ChevronUp } from "lucide-react-native";
import { Text, TouchableOpacity, View } from "react-native";
import { prettyProtocol } from "@/services/defi/opportunityDisplay";
import { chainLabel } from "@/services/defi/opportunityLabels";
import type { Allocation, QuickInvestRow } from "@/services/defi/quickInvest";
import { formatUsd } from "@/services/defi/quickInvest";
import { tapFeedback } from "@/utils/hapticsUtils";

const BRAND_RED = "#c71c4b";
/** Positional accents, mirroring the mockup's three-dot legend. */
const DOTS = ["#c71c4b", "#f0a33e", "#3e8ef0"];

export default function AllocationBreakdown({
  allocation,
  expanded,
  onToggle,
}: {
  allocation: Allocation<QuickInvestRow>;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (allocation.legs.length === 0) return null;

  return (
    <View>
      <TouchableOpacity
        onPress={() => {
          tapFeedback();
          onToggle();
        }}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        className="mt-3 flex-row items-center justify-between"
      >
        <Text className="text-xs font-semibold text-light-primary-red">
          {expanded ? "Hide allocation" : "View allocation"}
        </Text>
        {expanded ? (
          <ChevronUp size={14} color={BRAND_RED} />
        ) : (
          <ChevronDown size={14} color={BRAND_RED} />
        )}
      </TouchableOpacity>

      {expanded ? (
        <View className="mt-1.5">
          {allocation.legs.map((leg, idx) => {
            const chain = chainLabel(
              leg.row.chain_name,
              leg.row.chain_id,
              leg.row.namespace,
            );
            const meta = [leg.row.asset_symbol, chain]
              .filter(Boolean)
              .join(" · ");
            return (
              <View
                key={leg.row.pool_id ?? `${leg.row.protocol_slug}-${idx}`}
                className={`flex-row items-center gap-2.5 py-2.5 ${
                  idx > 0 ? "border-t border-light-matte-black/[0.07]" : ""
                }`}
              >
                <View
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: DOTS[idx % DOTS.length] }}
                />
                <View className="flex-1 min-w-0">
                  <Text
                    className="text-xs font-semibold text-light-matte-black"
                    numberOfLines={1}
                  >
                    {prettyProtocol(leg.row.protocol_slug)}
                  </Text>
                  {leg.row.pool_meta ? (
                    <Text
                      className="text-[10px] text-gray-400"
                      numberOfLines={1}
                    >
                      {leg.row.pool_meta}
                    </Text>
                  ) : null}
                  {meta ? (
                    <Text
                      className="text-[10px] text-gray-400"
                      numberOfLines={1}
                    >
                      {meta}
                    </Text>
                  ) : null}
                </View>
                <View className="items-end">
                  <Text className="text-xs font-bold text-light-matte-black">
                    {formatUsd(leg.amountUsd)}
                    <Text className="text-[11px] font-semibold text-gray-400">
                      {`  ${Math.round(leg.weight * 100)}%`}
                    </Text>
                  </Text>
                  <Text className="text-[10px] font-semibold text-emerald-600 mt-0.5">
                    {`${leg.apy.toFixed(2)}% APY`}
                  </Text>
                </View>
              </View>
            );
          })}
          <Text className="text-[10px] text-gray-400 mt-1">
            Rates shown are 7-day averages, not a guarantee.
          </Text>
        </View>
      ) : null}
    </View>
  );
}
