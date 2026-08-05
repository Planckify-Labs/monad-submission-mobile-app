/**
 * BridgeProgressCard — §7.7, "post-submit: half the UX".
 *
 * Spec: docs/bridge-capability-spec.md §7.7, §7.7.1.
 *
 * A bridge is NOT done when the source tx confirms. CCTP's lifecycle is
 * FOUR steps and Circle's own SDK surfaces them individually, so the card
 * is modelled on that rather than a coarser three-state guess:
 *
 *   1. approve            ERC-20 allowance (EVM only, PRESENCE-CHECKED —
 *                         there is no analogue on Solana/Sui/Stellar)
 *   2. burn               destroy on source
 *   3. fetchAttestation   wait for the burn proof  ← the long one
 *   4. mint               create on destination
 *
 * Step 3 is where the ~15 to 19 minutes of a standard transfer goes. It is
 * the step users will stare at, so it gets honest "waiting" copy and an
 * expected-time range rather than a bare spinner.
 *
 * Non-CCTP LI.FI routes map onto the same shape via a provider-supplied
 * step list, so this card stays provider-agnostic.
 *
 * §7.7.1 is the load-bearing rule: `DONE` does NOT mean success. The
 * terminal state is a FOUR-value enum, and `partial` / `refunded` are
 * OUTCOMES rather than errors, so they get their own plain copy and never
 * route through `agentErrorCopy`.
 */

import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  CircleDashed,
  Clock,
  Info,
} from "lucide-react-native";
import type React from "react";
import { Linking, Pressable, Text, View } from "react-native";
import type {
  TBridgeOutcome,
  TBridgePhase,
  TBridgeRouteStep,
  TBridgeToken,
} from "@/api/types/bridge";
import { tapFeedback } from "@/utils/hapticsUtils";
import { agentErrorCopy } from "../agentErrorCopy";
import type { ToolComponentProps } from "../types";
import {
  chainLabel,
  formatTokenValue,
  outcomeCopy,
  phaseCopy,
  truncateAddress,
} from "./bridgeFormat";

const BRAND_RED = "#c71c4b";
const MUTED = "#6b7280";
const SUCCESS_GREEN = "#059669";
const WARN_AMBER = "#b45309";

type BridgeProgressInput = {
  from_chain?: string;
  to_chain?: string;
  source_tx_hash?: string;
};

type BridgeProgressData = {
  outcome?: TBridgeOutcome | null;
  phase?: TBridgePhase;
  current_step_key?: string;
  source_tx_hash?: string;
  destination_tx_hash?: string;
  received_token?: TBridgeToken;
  received_amount_raw?: string;
  refund_chain?: string;
  explorer_url?: string;
  from_chain?: string;
  to_chain?: string;
  /** Backend-resolved display names, so the card never derives one. */
  from_chain_name?: string;
  to_chain_name?: string;
  /** Present when this payload came from `bridge_execute`. */
  steps?: TBridgeRouteStep[];
  duration_range_seconds?: [number, number];
  to?: { token?: TBridgeToken; amountRaw?: string; chain?: string };
};

type BridgeProgressOutput = {
  status?: "success" | "failed" | string;
  error?: string;
  reason?: string;
  data?: BridgeProgressData;
};

/**
 * The canonical lifecycle. `approve` is PRESENCE-CHECKED against the
 * quote's own step list rather than assumed (§7.7, §10.4): only EVM
 * ERC-20 sources have one.
 */
const PHASE_ORDER: TBridgePhase[] = [
  "pending_source",
  "pending_attestation",
  "pending_destination",
  "settled",
];

function phaseIndex(phase: TBridgePhase | undefined): number {
  const idx = PHASE_ORDER.indexOf(phase ?? "pending_source");
  return idx === -1 ? 0 : idx;
}

type DisplayStep = {
  key: string;
  label: string;
  /** Phase at which this step is considered complete. */
  completeAtPhase: number;
  /** Longer-running steps get an expected-time hint. */
  hint?: string;
};

function buildSteps(data: BridgeProgressData): DisplayStep[] {
  const hasApprove = (data.steps ?? []).some((s) => s.kind === "approve");
  const steps: DisplayStep[] = [];

  if (hasApprove) {
    steps.push({
      key: "approve",
      label: "Approved the bridge to move your token",
      completeAtPhase: 0,
    });
  }

  steps.push({
    key: "burn",
    label: `Sent from ${data.from_chain_name ?? chainLabel(data.from_chain)}`,
    completeAtPhase: 1,
  });

  const range = data.duration_range_seconds;
  steps.push({
    key: "attestation",
    label: "Waiting for the transfer to be confirmed",
    completeAtPhase: 2,
    hint: range
      ? `Usually ${Math.round(range[0] / 60)} to ${Math.round(range[1] / 60)} minutes`
      : "This is the slowest step and can take several minutes",
  });

  steps.push({
    key: "mint",
    label: `Delivered on ${data.to_chain_name ?? chainLabel(data.to_chain)}`,
    completeAtPhase: 3,
  });

  return steps;
}

function StepRow({
  step,
  current,
  settled,
}: {
  step: DisplayStep;
  current: number;
  settled: boolean;
}) {
  const done = settled || current > step.completeAtPhase;
  const active = !done && current === step.completeAtPhase;

  return (
    <View className="flex-row items-start gap-2 py-1">
      <View className="pt-0.5">
        {done ? (
          <Check size={14} color={SUCCESS_GREEN} />
        ) : active ? (
          <Clock size={14} color={BRAND_RED} />
        ) : (
          <CircleDashed size={14} color="#d1d5db" />
        )}
      </View>
      <View className="flex-1">
        <Text
          className={`text-xs ${
            done
              ? "text-light-matte-black/60"
              : active
                ? "font-semibold text-light-matte-black"
                : "text-gray-400"
          }`}
        >
          {step.label}
        </Text>
        {active && step.hint ? (
          <Text className="text-[10px] text-gray-400 mt-0.5">{step.hint}</Text>
        ) : null}
      </View>
    </View>
  );
}

function TxLink({
  label,
  hash,
  url,
}: {
  label: string;
  hash: string | undefined;
  url?: string;
}) {
  if (!hash) return null;
  const openable = Boolean(url);
  return (
    <Pressable
      disabled={!openable}
      onPress={() => {
        if (!url) return;
        tapFeedback();
        void Linking.openURL(url);
      }}
      accessibilityRole={openable ? "link" : "text"}
      accessibilityLabel={`${label} ${hash}`}
      className="flex-row items-center justify-between py-1 active:opacity-70"
    >
      <Text className="text-[11px] text-gray-500">{label}</Text>
      <View className="flex-row items-center gap-1">
        <Text className="text-[11px] font-semibold text-light-matte-black">
          {truncateAddress(hash)}
        </Text>
        {openable ? <ArrowUpRight size={11} color={MUTED} /> : null}
      </View>
    </Pressable>
  );
}

const BridgeProgressCard: React.FC<
  ToolComponentProps<BridgeProgressInput, BridgeProgressOutput>
> = ({ state, input, output, onUserPrompt }) => {
  if (!output || state === "input-available" || state === "input-streaming") {
    return (
      <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-4 py-3.5">
        <Text className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
          Submitting transfer
        </Text>
        <Text className="text-sm text-gray-500 mt-1">
          Sending from {chainLabel(input.from_chain)}.
        </Text>
      </View>
    );
  }

  // A genuine tool failure (network, wallet). Curated copy only.
  if (state === "output-error" || output.status === "failed") {
    return (
      <View className="my-1.5 rounded-2xl border border-light-primary-red/30 bg-light-primary-red/5 px-4 py-3.5">
        <View className="flex-row items-center gap-2">
          <AlertTriangle size={15} color={BRAND_RED} />
          <Text className="text-xs font-bold uppercase tracking-wide text-light-primary-red">
            Transfer not sent
          </Text>
        </View>
        <Text className="text-sm text-light-matte-black/80 mt-1.5">
          {agentErrorCopy(output.error, output.reason)}
        </Text>
      </View>
    );
  }

  const data = output.data ?? {};
  const outcome = data.outcome ?? null;
  const settled = data.phase === "settled";
  const current = phaseIndex(data.phase);
  const steps = buildSteps(data);

  const copy = outcomeCopy(outcome, {
    receivedSymbol: data.received_token?.symbol,
    refundChainLabel: chainLabel(data.refund_chain),
  });

  const borderTone =
    outcome === "completed"
      ? "border-emerald-200 bg-emerald-50/60"
      : outcome === "failed"
        ? "border-light-primary-red/30 bg-light-primary-red/5"
        : outcome === "partial" || outcome === "refunded"
          ? "border-amber-300/50 bg-amber-50"
          : "border-light-matte-black/10 bg-white";

  const iconColor =
    outcome === "completed"
      ? SUCCESS_GREEN
      : outcome === "failed"
        ? BRAND_RED
        : outcome === "partial" || outcome === "refunded"
          ? WARN_AMBER
          : MUTED;

  return (
    <View className={`my-1.5 rounded-2xl border px-4 py-3.5 ${borderTone}`}>
      <View className="flex-row items-center gap-2">
        {outcome === "completed" ? (
          <Check size={15} color={iconColor} />
        ) : outcome === "failed" ? (
          <AlertTriangle size={15} color={iconColor} />
        ) : outcome ? (
          <Info size={15} color={iconColor} />
        ) : (
          <Clock size={15} color={iconColor} />
        )}
        <Text className="text-xs font-bold uppercase tracking-wide text-light-matte-black">
          {outcome ? copy.title : phaseCopy(data.phase)}
        </Text>
      </View>

      {/*
        §7.7.1 — `partial` and `refunded` are OUTCOMES, not errors. They
        get their own plain copy naming the token actually received or the
        chain the refund landed on, and never route through agentErrorCopy.
      */}
      {copy.body ? (
        <Text className="text-sm text-light-matte-black/80 mt-1.5">
          {copy.body}
        </Text>
      ) : null}

      {outcome === "partial" && data.received_amount_raw ? (
        <Text className="text-xs font-semibold text-light-matte-black mt-1">
          Received{" "}
          {formatTokenValue(data.received_amount_raw, data.received_token)}
        </Text>
      ) : null}

      {/* The four-step lifecycle. Only meaningful while in flight. */}
      {!outcome || outcome === "completed" ? (
        <View className="mt-2">
          {steps.map((step) => (
            <StepRow
              key={step.key}
              step={step}
              current={current}
              settled={settled && outcome === "completed"}
            />
          ))}
        </View>
      ) : null}

      {/* Both tx hashes surfaced (§7.7). */}
      <View className="mt-1.5 border-t border-light-matte-black/5 pt-1.5">
        <TxLink
          label={`Sent on ${data.from_chain_name ?? chainLabel(data.from_chain)}`}
          hash={data.source_tx_hash}
          url={data.explorer_url}
        />
        <TxLink
          label={`Received on ${data.to_chain_name ?? chainLabel(data.to_chain)}`}
          hash={data.destination_tx_hash}
        />
      </View>

      {/*
        A stalled leg needs a STATED RECOVERY PATH, never a spinner
        forever (§7.7). Once we are past the source confirmation and still
        unsettled, offer the user a way to act.
      */}
      {!outcome && current >= 1 && onUserPrompt ? (
        <Pressable
          onPress={() => {
            tapFeedback();
            onUserPrompt(
              `Check the status of my bridge transfer ${data.source_tx_hash ?? ""}`.trim(),
            );
          }}
          accessibilityRole="button"
          accessibilityLabel="Check transfer status"
          className="mt-2 self-start rounded-xl border-2 border-light-primary-red bg-light-primary-red/10 px-3 py-1.5 active:opacity-70"
        >
          <Text className="text-[11px] font-bold text-light-matte-black">
            Check status
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
};

export default BridgeProgressCard;
