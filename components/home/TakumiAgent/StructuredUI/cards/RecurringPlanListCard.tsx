/**
 * RecurringPlanListCard — renders `defi_list_recurring_invest`
 * (docs/defi-quick-invest-spec.md §12.5).
 *
 * Also the plan-management surface. §12.5 scopes management as "a settings
 * toggle is enough for v1, doesn't need its own agent tool" — pause/resume
 * and cancel live here as direct API calls rather than a second write tool,
 * so ending a standing order never requires a conversation with the model.
 *
 * Cancel is confirmed in two taps and is terminal, matching the backend.
 * A one-tap cancel on a card that scrolls past in a chat is too easy to hit
 * by accident for something the user set up deliberately.
 *
 * Every row states its next reminder date and, when they differ, that the
 * user's saved risk profile will be applied instead of the plan's (§12.6).
 */

import { useMutation } from "@tanstack/react-query";
import { BellRing, CalendarClock, Pause, Play, X } from "lucide-react-native";
import type React from "react";
import { useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { strategiesApi } from "@/api/endpoints/strategies";
import { formatUsd } from "@/services/defi/quickInvest";
import { tapFeedback } from "@/utils/hapticsUtils";
import type { ToolComponentProps } from "../types";

const BRAND_RED = "#c71c4b";

type PlanRow = {
  plan_id?: string;
  amount_usd?: number;
  asset_symbol?: string;
  tier?: string;
  effective_tier?: string;
  tier_overridden?: boolean;
  cadence_days?: number;
  chain_name?: string | null;
  next_due_at?: string;
  status?: string;
};

type PlanListOutput = {
  status?: "success" | "failed" | string;
  error?: string;
  data?: { plans?: PlanRow[]; count?: number };
};

const TIER_LABEL: Record<string, string> = {
  conservative: "Low risk",
  balanced: "Moderate risk",
  aggressive: "High risk",
};

function cadenceLabel(days: number | undefined): string {
  if (days === 7) return "Weekly";
  if (days === 30) return "Monthly";
  return days ? `Every ${days} days` : "Scheduled";
}

function friendlyDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function PlanCard({ plan, live }: { plan: PlanRow; live: boolean }) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [status, setStatus] = useState(plan.status ?? "active");

  const mutation = useMutation({
    mutationFn: (next: "active" | "paused" | "cancelled") =>
      strategiesApi.updateRecurringInvestPlan(plan.plan_id as string, next),
    onSuccess: (updated) => {
      // The row owns its own status: this card is rendered from a frozen
      // tool result, not from a query, so there is no cache to invalidate.
      setStatus(updated.status);
      setConfirmingCancel(false);
    },
    onError: (err) => {
      // Curated detail to the logs only; the row reverts and the user sees
      // fixed friendly copy rather than a status line or a response body.
      if (__DEV__) console.warn("[RecurringPlanListCard] update failed", err);
      setConfirmingCancel(false);
    },
  });

  const amount =
    typeof plan.amount_usd === "number" && Number.isFinite(plan.amount_usd)
      ? plan.amount_usd
      : null;
  const tier = TIER_LABEL[String(plan.tier ?? "").toLowerCase()] ?? null;
  const overridden = plan.tier_overridden
    ? (TIER_LABEL[String(plan.effective_tier ?? "").toLowerCase()] ?? null)
    : null;
  const nextDue = friendlyDate(plan.next_due_at);
  const cancelled = status === "cancelled";
  const paused = status === "paused";
  const canAct = live && !!plan.plan_id && !cancelled && !mutation.isPending;

  return (
    <View
      className={`mb-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-3 ${
        cancelled ? "opacity-50" : ""
      }`}
    >
      <View className="flex-row items-center gap-2">
        <CalendarClock size={13} color={BRAND_RED} />
        <Text className="text-[11px] font-bold uppercase tracking-wide text-light-matte-black">
          {cadenceLabel(plan.cadence_days)}
        </Text>
        {paused ? (
          <View className="rounded-full bg-gray-100 px-2 py-0.5">
            <Text className="text-[9px] font-bold text-gray-500">Paused</Text>
          </View>
        ) : null}
        {cancelled ? (
          <View className="rounded-full bg-gray-100 px-2 py-0.5">
            <Text className="text-[9px] font-bold text-gray-500">
              Cancelled
            </Text>
          </View>
        ) : null}
      </View>

      <Text className="text-light-matte-black font-bold text-base mt-1">
        {amount !== null
          ? `${formatUsd(amount, { cents: false })}${plan.asset_symbol ? ` of ${plan.asset_symbol}` : ""}`
          : "Recurring plan"}
      </Text>
      <Text className="text-[11px] text-gray-500 mt-0.5">
        {[
          tier ? `${tier} mix` : null,
          plan.chain_name ? plan.chain_name : null,
          !cancelled && !paused && nextDue ? `next ${nextDue}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </Text>

      {overridden && !cancelled ? (
        <View className="mt-2 rounded-xl border border-amber-300/70 bg-amber-50 px-3 py-2">
          <Text className="text-[11px] leading-4 text-amber-900">
            {`Your saved risk profile is set to ${overridden.toLowerCase()}, so that is what will be used instead of this plan's.`}
          </Text>
        </View>
      ) : null}

      {canAct ? (
        confirmingCancel ? (
          <View className="mt-2.5 flex-row gap-2">
            <TouchableOpacity
              onPress={() => {
                tapFeedback();
                mutation.mutate("cancelled");
              }}
              activeOpacity={0.85}
              className="flex-1 items-center rounded-xl bg-light-primary-red px-3 py-2.5"
            >
              <Text className="text-xs font-bold text-white">
                Yes, cancel it
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setConfirmingCancel(false)}
              activeOpacity={0.85}
              className="flex-1 items-center rounded-xl border border-light-matte-black/10 px-3 py-2.5"
            >
              <Text className="text-xs font-semibold text-light-matte-black">
                Keep it
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View className="mt-2.5 flex-row gap-2">
            <TouchableOpacity
              onPress={() => {
                tapFeedback();
                mutation.mutate(paused ? "active" : "paused");
              }}
              activeOpacity={0.85}
              className="flex-1 flex-row items-center justify-center gap-1.5 rounded-xl border border-light-matte-black/10 px-3 py-2.5"
            >
              {paused ? (
                <Play size={12} color="#20222c" />
              ) : (
                <Pause size={12} color="#20222c" />
              )}
              <Text className="text-xs font-semibold text-light-matte-black">
                {paused ? "Resume" : "Pause"}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                tapFeedback();
                setConfirmingCancel(true);
              }}
              activeOpacity={0.85}
              className="flex-1 flex-row items-center justify-center gap-1.5 rounded-xl border border-light-primary-red/30 px-3 py-2.5"
            >
              <X size={12} color={BRAND_RED} />
              <Text className="text-xs font-semibold text-light-primary-red">
                Cancel plan
              </Text>
            </TouchableOpacity>
          </View>
        )
      ) : null}
    </View>
  );
}

const RecurringPlanListCard: React.FC<
  ToolComponentProps<Record<string, unknown>, PlanListOutput>
> = ({ state, output, mode }) => {
  if (state === "input-streaming" || state === "input-available" || !output) {
    return (
      <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-3">
        <Text className="text-[11px] font-bold uppercase tracking-wide text-light-matte-black">
          Recurring plans
        </Text>
      </View>
    );
  }

  if (output.status === "failed") {
    if (__DEV__ && output.error) {
      console.warn("[RecurringPlanListCard] failed:", output.error);
    }
    return (
      <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-3">
        <Text className="text-sm text-light-matte-black/80">
          We couldn&apos;t load your recurring plans right now. Please try again
          in a moment.
        </Text>
      </View>
    );
  }

  const plans = output.data?.plans ?? [];

  if (plans.length === 0) {
    return (
      <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-3">
        <View className="flex-row items-center gap-2">
          <BellRing size={13} color={BRAND_RED} />
          <Text className="text-[11px] font-bold uppercase tracking-wide text-light-matte-black">
            Recurring plans
          </Text>
        </View>
        <Text className="text-sm text-light-matte-black/80 mt-1.5">
          You don&apos;t have any recurring investing reminders set up yet.
        </Text>
      </View>
    );
  }

  return (
    <View className="my-1.5">
      <View className="flex-row items-center gap-2 px-3.5 py-3 mb-1.5 rounded-2xl border border-light-matte-black/10 bg-white">
        <BellRing size={13} color={BRAND_RED} />
        <Text className="text-[11px] font-bold uppercase tracking-wide text-light-matte-black">
          Recurring plans
        </Text>
        <Text className="ml-auto text-[10px] text-gray-500">
          {plans.length} plan{plans.length === 1 ? "" : "s"}
        </Text>
      </View>
      {plans.map((plan, idx) => (
        <PlanCard
          key={plan.plan_id ?? `plan-${idx}`}
          plan={plan}
          // A frozen card from an old turn must not still be able to cancel
          // a live standing order.
          live={mode !== "historical"}
        />
      ))}
      <Text className="mt-1 px-1 text-[10px] text-gray-400">
        Each reminder asks you to approve and sign the deposit yourself. Nothing
        is invested automatically.
      </Text>
    </View>
  );
};

export default RecurringPlanListCard;
