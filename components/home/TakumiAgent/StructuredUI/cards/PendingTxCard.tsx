/**
 * PendingTxCard — unified registry component for write tools.
 *
 * Handles the full lifecycle of a write tool call:
 *
 *   state             | live                              | historical
 *   ------------------|-----------------------------------|---------------------------
 *   input-available   | <PreviewCard> (countdown+actions) | "Pending" / "Interrupted" frozen
 *   output-available  | live PendingTxCard subscribed     | "✓ Confirmed" frozen receipt
 *   output-error      | live PendingTxCard subscribed     | "✗ Failed" frozen receipt
 *
 * Historical branch is effect-free and pure-derives from input + output.
 */

import * as Linking from "expo-linking";
import { router } from "expo-router";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileText,
  XCircle,
} from "lucide-react-native";
import type React from "react";
import { useEffect, useState } from "react";
import { Pressable, Text, TouchableOpacity, View } from "react-native";
import { recordExitConsent } from "@/services/defi/safety/exitConsent";
import { exitDelaySeconds } from "@/services/defi/safety/types";
import {
  exitTermsNotice,
  useExitTerms,
} from "@/services/defi/safety/useExitTerms";
import {
  type PendingTxRecord,
  pendingTxStore,
} from "@/services/pendingTxStore";
import { buildExplorerUrl } from "../../PendingTxCard/explorerUrl";
import PendingTxCardLegacy from "../../PendingTxCard/PendingTxCard";
import { agentErrorCopy, agentErrorTitle } from "../agentErrorCopy";
import {
  approvalSummaryFromToolInput,
  factsFirstSummary,
} from "../approvalSummary";
import type { ToolComponentProps, ToolDecision } from "../types";
import WriteApprovalGate from "../WriteApprovalGate";
import { AddWalletErrorAction } from "./AddWalletErrorAction";

type WriteToolOutput = {
  status?: "success" | "failed" | string;
  tx_hash?: string;
  tx_confirmed?: boolean;
  transaction_id?: string;
  block_number?: number;
  data?: { chain_id?: number; [k: string]: unknown };
  error?: string;
  reason?: string;
  user_decision?: "approved" | "rejected";
};

type WriteToolInput = {
  chain_id?: number;
  human_summary?: string;
  description?: string;
  to?: string;
  [k: string]: unknown;
};

const SUCCESS_GREEN = "#10b981";
const BRAND_RED = "#c71c4b";
const MUTED_GRAY = "#6b7280";

function truncateHash(hash: string): string {
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

// Facts-first (prompt-injection defense): the real `to` arg wins over the
// model-authored `human_summary` — see ../approvalSummary.ts.
//
// This card serves every EVM write, including the DeFi ones, whose facts are a
// pool and an asset rather than a recipient. `approvalSummaryFromToolInput`
// knows both shapes, so defer to it whenever there is no plain `to`: a deposit
// card that says "Deposit 100 USDC into Aave V3 on Base" is the difference
// between a user who knows what they approved and one who saw "Transaction".
function describe(input: WriteToolInput): string {
  if (typeof input.to === "string" && input.to.trim().length > 0) {
    return factsFirstSummary(
      { action: "Transaction", to: input.to },
      input,
      "Transaction",
    );
  }
  return approvalSummaryFromToolInput(
    input as Record<string, unknown>,
    typeof input.human_summary === "string" ? input.human_summary : undefined,
    "Transaction",
  );
}

// Named exports (in addition to the default) so tool-specific cards — e.g.
// DefiWithdrawCard, which needs a bespoke pre-approval proposal but the same
// post-approval receipt/live-subscribed behavior every other write gets —
// can reuse this lifecycle instead of re-deriving explorer links, the
// failed/confirmed copy, and the pendingTxStore subscription.
export function HistoricalReceipt({
  input,
  output,
  state,
}: {
  input: WriteToolInput;
  output: WriteToolOutput | undefined;
  state: ToolComponentProps<WriteToolInput, WriteToolOutput>["state"];
}) {
  const description = describe(input);

  if (state === "input-streaming" || state === "input-available" || !output) {
    return (
      <View className="my-1.5 rounded-2xl border border-gray-200 bg-gray-50 px-3.5 py-3">
        <View className="flex-row items-center gap-2">
          <AlertTriangle size={16} color={MUTED_GRAY} />
          <Text className="text-xs font-bold uppercase tracking-wide text-gray-500">
            Interrupted
          </Text>
        </View>
        <Text className="text-sm text-gray-700 mt-1.5">{description}</Text>
      </View>
    );
  }

  const txHash =
    typeof output.tx_hash === "string" ? output.tx_hash : undefined;
  const chainId =
    typeof output.data?.chain_id === "number"
      ? output.data.chain_id
      : typeof input.chain_id === "number"
        ? input.chain_id
        : undefined;
  const explorerUrl =
    txHash && chainId
      ? buildExplorerUrl(chainId, txHash as `0x${string}`)
      : undefined;
  const canOpen = typeof explorerUrl === "string";

  const onPress = () => {
    if (!canOpen || !explorerUrl) return;
    Linking.openURL(explorerUrl).catch(() => {});
  };

  const isFailed = state === "output-error" || output.status === "failed";
  const transactionId =
    typeof output.transaction_id === "string"
      ? output.transaction_id
      : undefined;
  const onViewDetails = () => {
    if (!transactionId) return;
    router.push(`/activity-detail?transferId=${transactionId}`);
  };

  if (isFailed) {
    // Raw codes are for DEV diagnostics ONLY — never the user (CLAUDE.md
    // user-facing-errors). The card shows hand-written `agentErrorCopy`.
    if (
      typeof __DEV__ !== "undefined" &&
      __DEV__ &&
      (output.error || output.reason)
    ) {
      console.warn(
        `[PendingTxCard] write failed: error=${output.error ?? "?"} reason=${output.reason ?? "-"}`,
      );
    }
    return (
      <Pressable
        accessible
        accessibilityRole={canOpen ? "button" : "text"}
        disabled={!canOpen}
        onPress={onPress}
        className="my-1.5 rounded-2xl border border-light-primary-red/30 bg-light-primary-red/5 px-3.5 py-3"
      >
        <View className="flex-row items-center gap-2">
          <XCircle size={16} color={BRAND_RED} />
          <Text className="text-xs font-bold uppercase tracking-wide text-light-primary-red">
            Failed
          </Text>
        </View>
        {/* Name the problem, not the machinery: "Not enough balance" tells the
            user what happened; "Transaction" tells them nothing. Falls back to
            the action description when the failure has no headline of its own. */}
        <Text className="text-sm text-light-matte-black/80 mt-1.5">
          {agentErrorTitle(output.reason) ?? description}
        </Text>
        {/* Friendly copy only — the raw code went to the dev log above. */}
        <Text
          className="text-[13px] text-light-matte-black/70 mt-1"
          numberOfLines={3}
        >
          {agentErrorCopy(output.error, output.reason)}
        </Text>
        <AddWalletErrorAction error={output.error} reason={output.reason} />
        {txHash ? (
          <View className="flex-row items-center gap-2 mt-2">
            <Text
              className="text-[11px] text-gray-500 flex-1"
              numberOfLines={1}
            >
              {truncateHash(txHash)}
            </Text>
            {canOpen ? <ExternalLink size={12} color={MUTED_GRAY} /> : null}
          </View>
        ) : null}
        {transactionId ? (
          <TouchableOpacity
            onPress={onViewDetails}
            accessibilityRole="button"
            accessibilityLabel="View transaction details"
            className="flex-row items-center gap-1.5 mt-2 self-start"
          >
            <FileText size={12} color={BRAND_RED} />
            <Text className="text-xs font-medium text-light-primary-red">
              View details
            </Text>
          </TouchableOpacity>
        ) : null}
      </Pressable>
    );
  }

  const blockLabel =
    typeof output.block_number === "number"
      ? `Confirmed in block ${output.block_number}`
      : "Confirmed";

  return (
    <Pressable
      accessible
      accessibilityRole={canOpen ? "button" : "text"}
      disabled={!canOpen}
      onPress={onPress}
      className="my-1.5 rounded-2xl border border-green-200 bg-green-50/60 px-3.5 py-3"
    >
      <View className="flex-row items-center gap-2">
        <CheckCircle2 size={16} color={SUCCESS_GREEN} />
        <Text className="text-xs font-bold uppercase tracking-wide text-green-700">
          {blockLabel}
        </Text>
      </View>
      <Text className="text-sm text-light-matte-black/80 mt-1.5">
        {description}
      </Text>
      {txHash ? (
        <View className="flex-row items-center gap-2 mt-2">
          <Text className="text-[11px] text-gray-500 flex-1" numberOfLines={1}>
            {truncateHash(txHash)}
          </Text>
          {canOpen ? <ExternalLink size={12} color={MUTED_GRAY} /> : null}
        </View>
      ) : null}
      {transactionId ? (
        <TouchableOpacity
          onPress={onViewDetails}
          accessibilityRole="button"
          accessibilityLabel="View transaction details"
          className="flex-row items-center gap-1.5 mt-2 self-start"
        >
          <FileText size={12} color={SUCCESS_GREEN} />
          <Text className="text-xs font-medium text-green-700">
            View details
          </Text>
        </TouchableOpacity>
      ) : null}
    </Pressable>
  );
}

function useLiveRecord(
  txHash: string | undefined,
): PendingTxRecord | undefined {
  const [record, setRecord] = useState<PendingTxRecord | undefined>(() => {
    if (!txHash) return undefined;
    const target = txHash.toLowerCase();
    return pendingTxStore
      .list()
      .find((r) => r.tx_hash.toLowerCase() === target);
  });

  useEffect(() => {
    if (!txHash) return;
    const target = txHash.toLowerCase();
    return pendingTxStore.subscribe((records) => {
      const found = records.find((r) => r.tx_hash.toLowerCase() === target);
      setRecord(found);
    });
  }, [txHash]);

  return record;
}

/**
 * The approval surface for a write, with the deposit lockup folded in.
 *
 * Split into its own component purely so the exit-terms probe can be a hook:
 * `PendingTxCard` returns early for historical/live states, and calling a hook
 * after those branches would break the rules-of-hooks ordering.
 *
 * Two things happen here that the plain gate cannot do:
 *  1. the lockup is READ from the resolved target and shown before approval;
 *  2. tapping Approve RECORDS that the user saw it (§12 Q2a), which is what
 *     the Layer-3 check reads. Consent never travels through the model.
 */
function DepositApprovalGate({
  input,
  decision,
  addToolResult,
  onRequestApproval,
}: {
  input: WriteToolInput;
  decision?: ToolDecision;
  addToolResult: (result: Record<string, unknown>) => void;
  onRequestApproval?: () => void;
}) {
  const poolId = typeof input.pool_id === "string" ? input.pool_id : undefined;
  // A withdraw carries `position_id`; its exit terms are not a precondition of
  // leaving, and warning there would only discourage an exit already in motion.
  const isDeposit = !!poolId && !input.position_id;
  const { data: terms } = useExitTerms(isDeposit ? poolId : undefined);
  const notice = isDeposit ? exitTermsNotice(terms) : null;

  const approve = () => {
    // Record BEFORE handing the turn back, so the executor's Layer-3 read
    // cannot race the tap.
    if (isDeposit && poolId && terms) {
      recordExitConsent(poolId, exitDelaySeconds(terms));
    }
    addToolResult({ status: "success", user_decision: "approved" });
  };

  return (
    <WriteApprovalGate
      decision={decision}
      summary={describe(input)}
      notice={notice}
      onApprove={approve}
      onReject={() =>
        addToolResult({ status: "failed", user_decision: "rejected" })
      }
      onRequestApproval={onRequestApproval}
    />
  );
}

const PendingTxCard: React.FC<
  ToolComponentProps<WriteToolInput, WriteToolOutput>
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
    return <HistoricalReceipt input={input} output={output} state={state} />;
  }

  // Live: input-available → decision-gated approval surface (run-down for
  // `authorized`, static proposal for `ask`). INV-1 lives in the gate.
  if (state === "input-streaming" || state === "input-available") {
    if (!addToolResult) {
      return <HistoricalReceipt input={input} output={output} state={state} />;
    }
    return (
      <DepositApprovalGate
        input={input}
        decision={decision}
        addToolResult={addToolResult}
        onRequestApproval={onRequestApproval}
      />
    );
  }

  // Live: output-available / error → subscribed live card.
  return (
    <LivePendingTxView
      txHash={typeof output?.tx_hash === "string" ? output.tx_hash : undefined}
      input={input}
      output={output}
      state={state}
    />
  );
};

export function LivePendingTxView({
  txHash,
  input,
  output,
  state,
}: {
  txHash: string | undefined;
  input: WriteToolInput;
  output: WriteToolOutput | undefined;
  state: ToolComponentProps<WriteToolInput, WriteToolOutput>["state"];
}) {
  const record = useLiveRecord(txHash);
  if (record) return <PendingTxCardLegacy record={record} />;
  return <HistoricalReceipt input={input} output={output} state={state} />;
}

export default PendingTxCard;
