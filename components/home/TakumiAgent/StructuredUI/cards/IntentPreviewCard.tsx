/**
 * IntentPreviewCard — the hero read-result card for `defi_intent_preview`
 * (Sui Intent Engine, spec §7.2).
 *
 * Purely presentational: it reads `risk_flags` / `decoded` / `human_summary`
 * from the tool result, computes no on-chain state, and branches on no
 * namespace (Appendix B). Top to bottom:
 *   1. Plain-language summary (+ APY highlight).
 *   2. "What it does on-chain" — the decoded PTB commands (auditable).
 *   3. Guardian verdict chip (green / amber / red).
 *   4. Risk rows, coloured by severity, all copy hand-written upstream.
 *   5. Footer affordance via `onUserPrompt` (NOT a result gate — preview is
 *      a read; the real signing gate is the approval sheet on the write
 *      tool `defi_intent_execute`).
 *
 * No raw error strings ever render here (CLAUDE.md user-facing-errors) —
 * every string is `human_summary` / hand-written guardian copy / our own
 * labels.
 */

import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Coins,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from "lucide-react-native";
import type React from "react";
import { Pressable, Text, View } from "react-native";
import { agentErrorCopy } from "../agentErrorCopy";
import type { ToolComponentProps } from "../types";
import { AddWalletErrorAction } from "./AddWalletErrorAction";

type Severity = "info" | "warn" | "block";

type RiskFlag = {
  code?: string;
  severity?: Severity | string;
  title?: string;
  detail?: string;
};

type DecodedCommand = {
  kind?: string;
  module?: string;
  function?: string;
};

type IntentPreviewData = {
  intent_id?: string;
  human_summary?: string;
  apy?: string;
  decoded?: DecodedCommand[];
  risk_flags?: RiskFlag[];
  blocked?: boolean;
  /** Live on-chain reads the guardian performed this run (real, not canned). */
  inspected?: string[];
};

type IntentPreviewOutput = {
  status?: string;
  data?: IntentPreviewData;
  error?: string;
  reason?: string;
};

const SUCCESS_GREEN = "#10b981";
const WARN_AMBER = "#d97706";
const BRAND_RED = "#c71c4b";
const MUTED_GRAY = "#6b7280";

function describeCommand(c: DecodedCommand): string {
  switch (c.kind) {
    case "MoveCall":
      return c.module && c.function
        ? `Move call · ${c.module}::${c.function}`
        : "Move call";
    case "SplitCoins":
      return "Split coins";
    case "MergeCoins":
      return "Merge coins";
    case "TransferObjects":
      return "Transfer to you";
    case "MakeMoveVec":
      return "Build coin vector";
    case "Publish":
      return "Publish module";
    case "Upgrade":
      return "Upgrade module";
    default:
      return "On-chain step";
  }
}

function severityStyle(severity: string | undefined): {
  border: string;
  bg: string;
  text: string;
  color: string;
} {
  if (severity === "block") {
    return {
      border: "border-light-primary-red/30",
      bg: "bg-light-primary-red/5",
      text: "text-light-primary-red",
      color: BRAND_RED,
    };
  }
  if (severity === "warn") {
    return {
      border: "border-amber-200",
      bg: "bg-amber-50/70",
      text: "text-amber-700",
      color: WARN_AMBER,
    };
  }
  return {
    border: "border-gray-200",
    bg: "bg-gray-50",
    text: "text-gray-600",
    color: MUTED_GRAY,
  };
}

function Verdict({ blocked, hasWarn }: { blocked: boolean; hasWarn: boolean }) {
  if (blocked) {
    return (
      <View className="flex-row items-center gap-1.5">
        <ShieldAlert size={15} color={BRAND_RED} />
        <Text className="text-xs font-bold uppercase tracking-wide text-light-primary-red">
          Not recommended
        </Text>
      </View>
    );
  }
  if (hasWarn) {
    return (
      <View className="flex-row items-center gap-1.5">
        <AlertTriangle size={15} color={WARN_AMBER} />
        <Text className="text-xs font-bold uppercase tracking-wide text-amber-700">
          Heads up
        </Text>
      </View>
    );
  }
  return (
    <View className="flex-row items-center gap-1.5">
      <CheckCircle2 size={15} color={SUCCESS_GREEN} />
      <Text className="text-xs font-bold uppercase tracking-wide text-green-700">
        Looks safe
      </Text>
    </View>
  );
}

const IntentPreviewCard: React.FC<
  ToolComponentProps<unknown, IntentPreviewOutput>
> = ({ output, mode, onUserPrompt }) => {
  const data: IntentPreviewData = output?.data ?? {};

  // Read executor runs silently; show a light placeholder while it streams.
  if (!output) {
    return (
      <View className="my-1.5 rounded-2xl border border-gray-200 bg-gray-50 px-3.5 py-3">
        <View className="flex-row items-center gap-2">
          <Sparkles size={16} color={MUTED_GRAY} />
          <Text className="text-sm text-gray-600">Preparing your plan…</Text>
        </View>
      </View>
    );
  }

  // Compile / guardian / quote failed. Map the curated reason CODE (never a
  // raw error string — CLAUDE.md user-facing-errors) to specific, friendly
  // copy so the user knows what to change. Deterministic here, so it's clear
  // even if the agent's chat prose drifts. Unknown codes fall back to generic.
  if (output.status !== "success") {
    const msg = agentErrorCopy(output.error, output.reason);
    return (
      <View className="my-1.5 rounded-2xl border border-amber-200 bg-amber-50/70 px-3.5 py-3">
        <View className="flex-row items-center gap-2">
          <AlertTriangle size={16} color={WARN_AMBER} />
          <Text className="flex-1 text-sm text-amber-800">{msg}</Text>
        </View>
        <AddWalletErrorAction error={output.error} reason={output.reason} />
      </View>
    );
  }

  const flags = Array.isArray(data.risk_flags) ? data.risk_flags : [];
  const decoded = Array.isArray(data.decoded) ? data.decoded : [];
  const inspected = Array.isArray(data.inspected) ? data.inspected : [];
  const blocked =
    data.blocked === true || flags.some((f) => f.severity === "block");
  const hasWarn = flags.some((f) => f.severity === "warn");
  const canAct = mode !== "historical" && typeof onUserPrompt === "function";

  return (
    <View className="my-1.5 rounded-2xl border border-gray-200 bg-white px-3.5 py-3">
      {/* 1. Summary + verdict */}
      <View className="flex-row items-start justify-between gap-2">
        <Text className="flex-1 text-sm font-semibold text-light-matte-black">
          {data.human_summary ?? "Prepared transaction"}
        </Text>
        <Verdict blocked={blocked} hasWarn={hasWarn} />
      </View>
      {data.apy ? (
        <View className="mt-1 flex-row items-center gap-1">
          <Sparkles size={12} color={SUCCESS_GREEN} />
          <Text className="text-xs font-semibold text-green-700">
            ~{data.apy}% APY
          </Text>
        </View>
      ) : null}

      {/* 2. What it does on-chain */}
      {decoded.length > 0 ? (
        <View className="mt-2.5 rounded-xl bg-gray-50 px-3 py-2">
          <Text className="text-[11px] font-bold uppercase tracking-wide text-gray-400">
            What it does on-chain
          </Text>
          {decoded.map((c, i) => (
            <View
              key={`${c.kind}-${i}`}
              className="mt-1 flex-row items-center gap-1.5"
            >
              <Coins size={12} color={MUTED_GRAY} />
              <Text className="text-xs text-gray-700">
                {describeCommand(c)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* 3 + 4. Risk rows */}
      {flags.length > 0 ? (
        <View className="mt-2.5 gap-1.5">
          {flags.map((f, i) => {
            const s = severityStyle(f.severity);
            const Icon =
              f.severity === "block"
                ? ShieldAlert
                : f.severity === "warn"
                  ? AlertTriangle
                  : CheckCircle2;
            return (
              <View
                key={`${f.code}-${i}`}
                className={`rounded-xl border px-3 py-2 ${s.border} ${s.bg}`}
              >
                <View className="flex-row items-center gap-1.5">
                  <Icon size={13} color={s.color} />
                  <Text className={`text-xs font-semibold ${s.text}`}>
                    {f.title ?? "Risk"}
                  </Text>
                </View>
                {f.detail ? (
                  <Text className="mt-0.5 text-xs text-gray-600">
                    {f.detail}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}

      {/* 4b. What the guardian read on-chain this run (real state, not canned).
            This is the "why Sui" proof: it dry-ran the exact PTB and inspected
            live pool/balance state before signing. */}
      {inspected.length > 0 ? (
        <View className="mt-2.5 rounded-xl bg-gray-50 px-3 py-2">
          <View className="flex-row items-center gap-1.5">
            <ShieldCheck size={12} color={SUCCESS_GREEN} />
            <Text className="text-[11px] font-bold uppercase tracking-wide text-gray-400">
              Checked against live Sui state
            </Text>
          </View>
          {inspected.map((line, i) => (
            <View
              key={`${line}-${i}`}
              className="mt-1 flex-row items-center gap-1.5"
            >
              <CheckCircle2 size={11} color={SUCCESS_GREEN} />
              <Text className="text-xs text-gray-600">{line}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* 5. Footer affordance (onUserPrompt — not a result gate) */}
      {canAct ? (
        <View className="mt-3">
          {blocked ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => onUserPrompt?.("Can you make that safer?")}
              className="flex-row items-center justify-center gap-1.5 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2"
            >
              <Text className="text-sm font-semibold text-gray-700">
                Try a safer size
              </Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                onUserPrompt?.(
                  `Yes, execute that — intent ${data.intent_id ?? ""}`.trim(),
                )
              }
              className="flex-row items-center justify-center gap-1.5 rounded-xl bg-light-primary-red px-3 py-2"
            >
              <Text className="text-sm font-semibold text-white">Go ahead</Text>
              <ArrowRight size={15} color="#ffffff" />
            </Pressable>
          )}
        </View>
      ) : null}
    </View>
  );
};

export default IntentPreviewCard;
