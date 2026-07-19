/**
 * SpendingApprovalCard — inline human-in-the-loop approval card.
 *
 * Replaces the modal-based `SpendingApprovalModal` for spending decisions
 * so the outcome lives in the tool's `output` and survives reload as a
 * historical receipt (spec §2 principle 6, §4.2.2).
 */

import { CheckCircle2, XCircle } from "lucide-react-native";
import type React from "react";
import { Text, View } from "react-native";
import { factsFirstSummary } from "../approvalSummary";
import type { ToolComponentProps } from "../types";
import WriteApprovalGate from "../WriteApprovalGate";

type SpendingApprovalInput = {
  amount?: string;
  token?: string;
  token_symbol?: string;
  spender?: string;
  spender_name?: string;
  human_summary?: string;
};

type SpendingApprovalOutput = {
  // Display field kept for backward-compat with historical cached cards.
  decision?: "approved" | "rejected";
  unlimited?: boolean;
  // D3 fix (deny-layer spec §6.5): the canonical decision envelope is
  // `user_decision`, read fail-closed by `handleAddToolResult`. `status`
  // mirrors the executor result shape so the frozen receipt renders.
  user_decision?: "approved" | "rejected";
  status?: "success" | "failed" | string;
};

const SUCCESS_GREEN = "#10b981";
const BRAND_RED = "#c71c4b";
const MUTED_GRAY = "#6b7280";

// Facts-first (prompt-injection defense): the spender ADDRESS is the fact
// the user must see — `spender_name` and `human_summary` are model prose
// and only decorate, never replace, it. See ../approvalSummary.ts.
function summarize(input: SpendingApprovalInput): string {
  return factsFirstSummary(
    {
      action: "Approve",
      amount: input.amount,
      asset: input.token_symbol ?? input.token,
      to: input.spender,
      toLabel: input.spender_name,
    },
    input,
    "spending request",
  );
}

function FrozenReceipt({
  input,
  output,
}: {
  input: SpendingApprovalInput;
  output: SpendingApprovalOutput | undefined;
}) {
  const summary = summarize(input);
  const approved =
    output?.user_decision === "approved" ||
    output?.decision === "approved" ||
    output?.status === "success";
  return (
    <View
      className={`my-1.5 rounded-2xl border px-3.5 py-2.5 ${
        approved
          ? "bg-green-50/60 border-green-200"
          : "bg-gray-50 border-gray-200"
      }`}
    >
      <View className="flex-row items-center gap-2">
        {approved ? (
          <CheckCircle2 size={16} color={SUCCESS_GREEN} />
        ) : (
          <XCircle size={16} color={MUTED_GRAY} />
        )}
        <Text
          className={`text-xs font-bold uppercase tracking-wide ${
            approved ? "text-green-700" : "text-gray-500"
          }`}
        >
          {approved ? "Approved" : "Rejected"}
        </Text>
      </View>
      <Text className="text-sm text-light-matte-black/80 mt-1.5">
        {summary}
      </Text>
    </View>
  );
}

const SpendingApprovalCard: React.FC<
  ToolComponentProps<SpendingApprovalInput, SpendingApprovalOutput>
> = ({
  state,
  input,
  output,
  mode,
  addToolResult,
  decision,
  onRequestApproval,
}) => {
  if (mode === "historical") {
    return <FrozenReceipt input={input} output={output} />;
  }

  if (state === "output-available" && output) {
    return <FrozenReceipt input={input} output={output} />;
  }

  if (state === "output-error") {
    return (
      <View className="my-1.5 rounded-2xl border border-light-primary-red/30 bg-light-primary-red/5 px-3.5 py-3">
        <View className="flex-row items-center gap-2">
          <XCircle size={16} color={BRAND_RED} />
          <Text className="text-xs font-bold uppercase tracking-wide text-light-primary-red">
            Approval failed
          </Text>
        </View>
        <Text className="text-sm text-light-matte-black/80 mt-1.5">
          {summarize(input)}
        </Text>
      </View>
    );
  }

  // Live + input-available — decision-gated approval surface. Without a
  // live `addToolResult` (forward-compat) freeze it.
  if (!addToolResult) {
    return <FrozenReceipt input={input} output={output} />;
  }

  return (
    <WriteApprovalGate
      decision={decision}
      summary={summarize(input)}
      onApprove={() =>
        addToolResult({
          decision: "approved",
          user_decision: "approved",
          status: "success",
        })
      }
      onReject={() =>
        addToolResult({
          decision: "rejected",
          user_decision: "rejected",
          status: "failed",
        })
      }
      onRequestApproval={onRequestApproval}
    />
  );
};

export default SpendingApprovalCard;
