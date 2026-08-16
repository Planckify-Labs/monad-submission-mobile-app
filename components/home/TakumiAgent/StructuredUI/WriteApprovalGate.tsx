/**
 * WriteApprovalGate — the single live-approval surface for every agent
 * write card (deny-layer spec §6.5).
 *
 * Replaces the per-card, decision-blind auto-confirm countdowns that
 * caused D1/D2 (a run-down shown for an unauthorized call; two countdowns
 * racing). The dispatcher computes ONE authorization decision and threads
 * it here, so the surface is chosen AFTER authorization:
 *
 *   - `authorized` → the run-down `<PreviewCard>` (6 s veto). Inaction at
 *     0 executes — correct ONLY because the call is already authorized
 *     (INV-1). Confirm → approve, Cancel → reject.
 *   - `ask` (or absent, fail-closed) → a static proposal card with
 *     Approve / Reject and **no timer**. Approve opens the approval sheet
 *     via `onRequestApproval` (it does NOT execute, §4.1); Reject rejects
 *     the proposed tool.
 *
 * A `deny` decision never reaches this gate — the dispatcher rejects it
 * before painting an interactive card.
 */

import { ShieldAlert } from "lucide-react-native";
import type React from "react";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useAgentConnection } from "@/hooks/useAgentConnection";
import PreviewCard from "../PreviewCard/PreviewCard";
import type { ToolDecision } from "./types";

const BRAND_RED = "#c71c4b";

export interface WriteApprovalGateProps {
  decision?: ToolDecision;
  summary: string;
  /** Run-down confirm (authorized) — execute. */
  onApprove: () => void;
  /** Reject the proposed tool — `user_declined`. */
  onReject: () => void;
  /** `ask` Approve — open the approval sheet (does NOT execute). */
  onRequestApproval?: () => void;
}

/**
 * Static two-button proposal card (no countdown) for the `ask` decision.
 */
function ProposalCard({
  summary,
  onApprove,
  onReject,
}: {
  summary: string;
  onApprove: () => void;
  onReject: () => void;
}) {
  const [pending, setPending] = useState(false);
  return (
    <View className="my-1.5 rounded-2xl border border-light-primary-red/30 bg-light-primary-red/5 px-3.5 py-3">
      <View className="flex-row items-center gap-2">
        <ShieldAlert size={16} color={BRAND_RED} />
        <Text className="text-xs font-bold uppercase tracking-wide text-light-primary-red">
          Approval required
        </Text>
      </View>
      <Text className="text-sm text-light-matte-black mt-1.5" numberOfLines={0}>
        {summary}
      </Text>
      <View className="flex-row gap-2 mt-3">
        <Pressable
          onPress={() => {
            if (pending) return;
            setPending(true);
            onReject();
          }}
          disabled={pending}
          accessibilityRole="button"
          accessibilityLabel="Reject"
          className="flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 active:opacity-70"
        >
          <Text className="text-xs font-semibold text-light-matte-black text-center">
            Reject
          </Text>
        </Pressable>
        <Pressable
          onPress={() => {
            if (pending) return;
            // Disable both buttons: Approve transitions to the approval
            // sheet, so the inline proposal is spent either way.
            setPending(true);
            onApprove();
          }}
          disabled={pending}
          accessibilityRole="button"
          accessibilityLabel="Approve"
          className="flex-1 rounded-xl bg-light-primary-red px-3 py-2 active:opacity-80"
        >
          <Text className="text-xs font-semibold text-white text-center">
            Approve
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const WriteApprovalGate: React.FC<WriteApprovalGateProps> = ({
  decision,
  summary,
  onApprove,
  onReject,
  onRequestApproval,
}) => {
  // Global SSE connection state (published by AgentMode.tsx from the
  // session's onReconnecting/onReconnected bindings). Read directly
  // rather than prop-drilled through MessageContent → the tool-card
  // registry → here, per the avoid-props-drilling convention.
  const { isReconnecting } = useAgentConnection();

  // INV-1: the auto-execute run-down is wired ONLY for `authorized`.
  if (decision === "authorized") {
    return (
      <PreviewCard
        summary={summary}
        onConfirm={onApprove}
        onDismiss={onReject}
        isReconnecting={isReconnecting}
      />
    );
  }

  // `ask` — and, fail-closed, any unknown/absent decision — renders the
  // static proposal card. Approve opens the sheet; nothing auto-resolves.
  return (
    <ProposalCard
      summary={summary}
      onApprove={() => onRequestApproval?.()}
      onReject={onReject}
    />
  );
};

export default WriteApprovalGate;
