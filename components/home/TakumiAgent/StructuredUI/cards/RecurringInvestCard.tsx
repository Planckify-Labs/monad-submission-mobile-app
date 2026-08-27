/**
 * RecurringInvestCard — the write surface for `defi_set_recurring_invest`
 * (docs/defi-quick-invest-spec.md §12.5).
 *
 * **This card renders `WriteApprovalGate` itself.** Tagging the tool
 * `capability: "write"` server-side does NOT, on its own, put a
 * confirmation in front of the user — that gap is exactly what shipped
 * `bridge_execute` without a gate once
 * (`feedback_write_card_approval_gate_required`). Setting up a standing
 * plan is a write even though no funds move at setup time.
 *
 * The approval line is built from the tool's OWN arguments
 * (`project_facts_first_approval_summary`), never from the model's prose:
 * the user is confirming an amount and a cadence, and those two facts must
 * come from the thing that will actually be created.
 *
 * Honesty is the other half of the design. Every state says, in fixed
 * hand-written copy, that this is a reminder and that nothing moves today.
 * A user who believed otherwise would think money was being invested while
 * nothing happened — and the app deliberately holds no authority to invest
 * on their behalf (§13 is unbuilt).
 */

import {
  AlertTriangle,
  BellRing,
  CalendarClock,
  Check,
} from "lucide-react-native";
import type React from "react";
import { Text, View } from "react-native";
import { formatUsd } from "@/services/defi/quickInvest";
import { factsFirstSummary } from "../approvalSummary";
import type { ToolComponentProps } from "../types";
import WriteApprovalGate from "../WriteApprovalGate";

const BRAND_RED = "#c71c4b";

type RecurringInvestInput = {
  amount_usd?: number;
  tier?: string;
  cadence?: string;
  asset_symbol?: string;
  human_summary?: string;
  description?: string;
  [k: string]: unknown;
};

type RecurringInvestOutput = {
  status?: "success" | "failed" | string;
  error?: string;
  reason?: string;
  user_decision?: "approved" | "rejected";
  data?: {
    plan_id?: string;
    amount_usd?: number;
    asset_symbol?: string;
    tier?: string;
    effective_tier?: string;
    tier_overridden?: boolean;
    cadence_days?: number;
    chain_name?: string | null;
    next_due_at?: string;
    replaced?: boolean;
  };
};

const TIER_LABEL: Record<string, string> = {
  conservative: "Low risk",
  balanced: "Moderate risk",
  aggressive: "High risk",
};

function cadenceLabel(value: string | undefined): string | null {
  const key = (value ?? "").toLowerCase();
  if (key === "weekly") return "every week";
  if (key === "monthly") return "every month";
  return null;
}

function cadenceLabelFromDays(days: number | undefined): string {
  if (days === 7) return "every week";
  if (days === 30) return "every month";
  return days ? `every ${days} days` : "on a schedule";
}

function amountOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/** Fixed, hand-written date copy. Never a raw ISO string. */
function friendlyDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** The line the whole feature depends on the user reading correctly. */
function ReminderNotice() {
  return (
    <View className="mt-2.5 flex-row gap-2 rounded-xl border border-light-matte-black/10 bg-light-main-container px-3 py-2">
      <BellRing size={13} color={BRAND_RED} style={{ marginTop: 1 }} />
      <Text className="flex-1 text-[11px] leading-4 text-light-matte-black/70">
        This sets a reminder. Nothing is invested today, and each time it comes
        round you approve and sign the deposit yourself.
      </Text>
    </View>
  );
}

function Proposal({
  input,
  decision,
  addToolResult,
  onRequestApproval,
}: {
  input: RecurringInvestInput;
  decision: ToolComponentProps<
    RecurringInvestInput,
    RecurringInvestOutput
  >["decision"];
  addToolResult: (output: RecurringInvestOutput) => void;
  onRequestApproval?: () => void;
}) {
  const amount = amountOf(input.amount_usd);
  const cadence = cadenceLabel(input.cadence);
  const tierKey = String(input.tier ?? "").toLowerCase();
  const tier = TIER_LABEL[tierKey] ?? null;
  const asset =
    typeof input.asset_symbol === "string" ? input.asset_symbol : null;

  // Facts from the tool's own args. The action word is "Remind me to
  // invest", not "Invest": the user is approving a schedule, and an
  // approval line that says otherwise would misdescribe what they agreed
  // to at the exact moment they agree to it.
  const summary = factsFirstSummary(
    {
      action: "Set a reminder to invest",
      amount: amount !== null ? formatUsd(amount, { cents: false }) : undefined,
      asset: asset ?? undefined,
      suffix: [cadence, tier ? `into a ${tier.toLowerCase()} mix` : null]
        .filter(Boolean)
        .join(" "),
    },
    {},
    "Set up a recurring investing reminder",
  );

  return (
    <View className="mb-1.5">
      <View className="bg-light rounded-3xl p-5 border border-light-matte-black/5">
        <View className="flex-row items-center gap-2">
          <CalendarClock size={14} color={BRAND_RED} />
          <Text className="text-light-matte-black/60 text-xs uppercase tracking-wide">
            Recurring plan
          </Text>
        </View>
        <Text className="text-light-matte-black font-bold text-lg mt-1">
          {amount !== null
            ? `${formatUsd(amount, { cents: false })}${asset ? ` of ${asset}` : ""} ${cadence ?? ""}`.trim()
            : "Recurring investing"}
        </Text>

        <View className="flex-row items-center mt-3 gap-3">
          <View className="flex-1 bg-light-main-container rounded-xl p-3">
            <Text className="text-light-matte-black/60 text-xs">Each time</Text>
            <Text
              className="text-light-matte-black font-semibold mt-1"
              numberOfLines={1}
            >
              {amount !== null ? formatUsd(amount, { cents: false }) : "—"}
            </Text>
          </View>
          <View className="flex-1 bg-light-main-container rounded-xl p-3">
            <Text className="text-light-matte-black/60 text-xs">
              Risk level
            </Text>
            <Text
              className="text-light-matte-black font-semibold mt-1"
              numberOfLines={1}
            >
              {tier ?? "—"}
            </Text>
          </View>
        </View>

        <ReminderNotice />
      </View>

      <WriteApprovalGate
        decision={decision}
        summary={summary}
        onApprove={() =>
          addToolResult({ status: "success", user_decision: "approved" })
        }
        onReject={() =>
          addToolResult({ status: "failed", user_decision: "rejected" })
        }
        onRequestApproval={onRequestApproval}
      />
    </View>
  );
}

function Receipt({ output }: { output?: RecurringInvestOutput }) {
  if (!output || output.status === "failed") {
    // Curated codes only reach the logs; the user gets fixed friendly copy.
    if (__DEV__ && output?.error) {
      console.warn("[RecurringInvestCard] failed", output.error, output.reason);
    }
    const rejected = output?.user_decision === "rejected";
    return (
      <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-3">
        <View className="flex-row items-center gap-2">
          <AlertTriangle size={14} color={BRAND_RED} />
          <Text className="text-xs font-bold uppercase tracking-wide text-light-matte-black">
            {rejected ? "Plan not set up" : "Couldn't set up the plan"}
          </Text>
        </View>
        <Text className="text-sm text-light-matte-black/80 mt-1.5">
          {rejected
            ? "No recurring plan was created. You can set one up any time."
            : "We couldn't set up your recurring plan right now. Please try again in a moment."}
        </Text>
      </View>
    );
  }

  const data = output.data ?? {};
  const amount = amountOf(data.amount_usd);
  const cadence = cadenceLabelFromDays(data.cadence_days);
  const nextDue = friendlyDate(data.next_due_at);
  const tier = TIER_LABEL[String(data.tier ?? "").toLowerCase()] ?? null;
  const overriddenTier = data.tier_overridden
    ? (TIER_LABEL[String(data.effective_tier ?? "").toLowerCase()] ?? null)
    : null;

  return (
    <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-3.5">
      <View className="flex-row items-center gap-2">
        <View className="w-6 h-6 rounded-full bg-emerald-50 items-center justify-center">
          <Check size={13} color="#059669" strokeWidth={3} />
        </View>
        <Text className="text-xs font-bold uppercase tracking-wide text-light-matte-black">
          {data.replaced ? "Plan updated" : "Reminder set"}
        </Text>
      </View>

      <Text className="text-light-matte-black font-bold text-lg mt-2">
        {amount !== null
          ? `${formatUsd(amount, { cents: false })}${data.asset_symbol ? ` of ${data.asset_symbol}` : ""} ${cadence}`
          : `Recurring plan ${cadence}`}
      </Text>
      <Text className="text-[11.5px] text-gray-500 mt-0.5">
        {[
          tier ? `${tier} mix` : null,
          data.chain_name ? `on ${data.chain_name}` : null,
          nextDue ? `first reminder ${nextDue}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </Text>

      {overriddenTier ? (
        // §12.6: a saved risk profile outranking the plan's tier is correct
        // as a ceiling, but it must never happen silently. The user was
        // promised one thing; say plainly that another applies.
        <View className="mt-2.5 rounded-xl border border-amber-300/70 bg-amber-50 px-3 py-2">
          <Text className="text-[11px] leading-4 text-amber-900">
            {`Your saved risk profile is set to ${overriddenTier.toLowerCase()}, so that is what will be used instead of this plan's. Update your strategy if you want the plan's level to apply.`}
          </Text>
        </View>
      ) : null}

      <ReminderNotice />
    </View>
  );
}

const RecurringInvestCard: React.FC<
  ToolComponentProps<RecurringInvestInput, RecurringInvestOutput>
> = ({
  state,
  input,
  output,
  mode,
  addToolResult,
  decision,
  onRequestApproval,
}) => {
  if (mode === "historical") return <Receipt output={output} />;

  if (state === "input-streaming" || state === "input-available") {
    if (!addToolResult) return <Receipt output={output} />;
    return (
      <Proposal
        input={input}
        decision={decision}
        addToolResult={addToolResult}
        onRequestApproval={onRequestApproval}
      />
    );
  }

  return <Receipt output={output} />;
};

export default RecurringInvestCard;
