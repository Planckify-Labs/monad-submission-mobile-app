/**
 * RebalancePreviewCard — preview step for `defi_rebalance`.
 *
 * Spec: docs/defi-strategies-spec.md §14.5.4.
 *
 * Live mode: shows the from→to diff, APY delta, fees, and Approve /
 * Reject buttons. Approve calls `addToolResult({ status: "ok",
 * user_decision: "approved" })`; the executor then fires the two writes
 * sequentially, each rendering its own PendingTxCard underneath.
 *
 * Historical mode: frozen badge showing the approved/declined state and
 * timestamp. Tx hashes of the executed legs are surfaced by the
 * trailing PendingTxCard entries, not duplicated here.
 */

import { ArrowRight, CheckCircle2, XCircle } from "lucide-react-native";
import { Text, TouchableOpacity, View } from "react-native";
import type { ToolComponentProps } from "../types";
import { resolveRebalanceCardStatus } from "./rebalanceCardStatus";

const BRAND_RED = "#c71c4b";

export type RebalancePreviewInput = {
  from?: {
    protocol_slug?: string;
    chain_id?: number | string;
    asset_symbol?: string;
    amount_raw?: string;
    apy?: number;
    display_name?: string;
  };
  to?: {
    protocol_slug?: string;
    chain_id?: number | string;
    asset_symbol?: string;
    min_amount_raw?: string;
    apy?: number;
    display_name?: string;
  };
  reason?: "yield_improvement" | "depeg_emergency" | "user_initiated" | string;
  estimated?: {
    apy_delta_bps?: number;
    total_fee_usd?: number;
    route_steps?: number;
  };
  // Flat fields as actually emitted by the `defi_rebalance` tool call
  // (the server sends these; the nested `from`/`to`/`estimated` above is
  // the richer proposal shape that isn't wired yet). Read as a fallback
  // so the card isn't blank.
  from_position_id?: string;
  to_protocol_slug?: string;
  to_asset_symbol?: string;
  to_asset_contract?: string;
  to_amount_raw?: string;
  expected_apy?: number;
};

export type RebalancePreviewOutput = {
  status?: "ok" | "rejected" | "error" | "success" | "failed" | string;
  user_decision?: "approved" | "rejected";
  error?: string;
};

/** Shorten an id/address for display: `cmpc4g1k…jf82d`. */
function shortenId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function fmtApy(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}%`;
}

function fmtUsd(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

function fmtDeltaBps(bps: number | undefined): {
  label: string;
  positive: boolean;
} {
  if (typeof bps !== "number" || !Number.isFinite(bps)) {
    return { label: "—", positive: true };
  }
  const sign = bps >= 0 ? "+" : "−";
  const abs = Math.abs(bps);
  return { label: `${sign}${(abs / 100).toFixed(2)}%`, positive: bps >= 0 };
}

function reasonLabel(reason?: string): string {
  switch (reason) {
    case "yield_improvement":
      return "Higher yield available";
    case "depeg_emergency":
      return "Stablecoin depeg: moving funds to safety";
    case "user_initiated":
      return "You asked to rebalance";
    default:
      return "Rebalance proposed";
  }
}

export function RebalancePreviewCard({
  input,
  output,
  state,
  error,
  mode,
  addToolResult,
  decision,
  onRequestApproval,
}: ToolComponentProps<RebalancePreviewInput, RebalancePreviewOutput>) {
  const from = input.from;
  const to = input.to;
  const delta = fmtDeltaBps(input.estimated?.apy_delta_bps);

  // Labels derived from the nested proposal shape OR the flat
  // `defi_rebalance` tool input (whichever is present), so the card
  // shows real content instead of "—".
  const fromLabel =
    from?.display_name ??
    from?.protocol_slug ??
    (input.from_position_id
      ? `Position ${shortenId(input.from_position_id)}`
      : undefined);
  const toLabel =
    to?.display_name ?? to?.protocol_slug ?? input.to_protocol_slug;
  const toAsset = to?.asset_symbol ?? input.to_asset_symbol;
  const fromApy = from?.apy;
  const toApy = to?.apy ?? input.expected_apy;

  // A finished card is "declined" ONLY when the user actually rejected
  // it — never just because the executor result lacks `user_decision`
  // (see rebalanceCardStatus.ts for the bug this guards).
  const terminalStatus = resolveRebalanceCardStatus({ state, error, output });

  // Historical / frozen render — once a terminal signal exists.
  if (mode === "historical" || terminalStatus !== null) {
    const headline =
      terminalStatus === "declined"
        ? "You declined this rebalance"
        : terminalStatus === "failed"
          ? "Rebalance didn't complete"
          : "Rebalance submitted";
    const good = terminalStatus === "executed";
    return (
      <View className="bg-light-main-container rounded-2xl p-4 border border-light-matte-black/10 mb-3">
        <View className="flex-row items-center mb-2">
          {good ? (
            <CheckCircle2 color="#16a34a" size={20} />
          ) : (
            <XCircle color={BRAND_RED} size={20} />
          )}
          <Text className="ml-2 font-semibold text-light-matte-black">
            {headline}
          </Text>
        </View>
        <View className="flex-row items-center mt-1">
          <Text
            className="text-light-matte-black/60 text-sm flex-1"
            numberOfLines={1}
          >
            {fromLabel ?? "From"}
          </Text>
          <ArrowRight color="#64748b" size={16} />
          <Text
            className="text-light-matte-black/80 text-sm flex-1 ml-2"
            numberOfLines={1}
          >
            {toLabel ?? "To"}
          </Text>
        </View>
      </View>
    );
  }

  // Live render — interactive approval.
  return (
    <View className="bg-light rounded-3xl p-5 shadow-md- mb-3 border border-light-matte-black/5">
      <View className="mb-3">
        <Text className="text-light-matte-black/60 text-xs uppercase tracking-wide">
          {reasonLabel(input.reason)}
        </Text>
        <Text className="text-light-matte-black font-bold text-lg mt-1">
          Rebalance suggested
        </Text>
      </View>

      <View className="flex-row items-center mb-4">
        <View className="flex-1 bg-light-main-container rounded-xl p-3">
          <Text className="text-light-matte-black/60 text-xs">From</Text>
          <Text
            className="text-light-matte-black font-semibold mt-1"
            numberOfLines={1}
          >
            {fromLabel ?? "—"}
          </Text>
          <Text className="text-light-matte-black/60 text-xs mt-1">
            {fmtApy(fromApy)} APY
          </Text>
        </View>
        <View className="px-2">
          <ArrowRight color="#475569" size={18} />
        </View>
        <View className="flex-1 bg-emerald-50 rounded-xl p-3 border border-emerald-100">
          <Text className="text-emerald-900/70 text-xs">To</Text>
          <Text
            className="text-emerald-950 font-semibold mt-1"
            numberOfLines={1}
          >
            {toLabel ?? "—"}
            {toAsset ? ` · ${toAsset}` : ""}
          </Text>
          <Text className="text-emerald-800 text-xs mt-1">
            {fmtApy(toApy)} APY
          </Text>
        </View>
      </View>

      <View className="flex-row items-center mb-4 gap-3">
        <View className="flex-1 bg-light-main-container rounded-xl p-3">
          <Text className="text-light-matte-black/60 text-xs">APY delta</Text>
          <Text
            className={`mt-1 font-semibold ${
              delta.positive ? "text-emerald-600" : "text-rose-600"
            }`}
          >
            {delta.label}
          </Text>
        </View>
        <View className="flex-1 bg-light-main-container rounded-xl p-3">
          <Text className="text-light-matte-black/60 text-xs">Est. fee</Text>
          <Text className="text-light-matte-black mt-1 font-semibold">
            {fmtUsd(input.estimated?.total_fee_usd)}
          </Text>
        </View>
        <View className="flex-1 bg-light-main-container rounded-xl p-3">
          <Text className="text-light-matte-black/60 text-xs">Steps</Text>
          <Text className="text-light-matte-black mt-1 font-semibold">
            {input.estimated?.route_steps ?? 2}
          </Text>
        </View>
      </View>

      {/*
        Decision-routed actions (deny-layer spec §6.5). The rich preview
        above IS the proposal surface — it never auto-executes (no
        countdown), so it's strictly safer than the run-down and satisfies
        INV-1. When `authorized`, Approve executes; when `ask` (or absent,
        fail-closed) Approve opens the approval sheet (§4.1 step 2) rather
        than executing. Reject always declines (`user_decision: rejected`).
      */}
      <View className="flex-row gap-3">
        <TouchableOpacity
          onPress={() =>
            addToolResult?.({ status: "rejected", user_decision: "rejected" })
          }
          className="flex-1 bg-light-main-container rounded-2xl py-3 items-center"
        >
          <Text className="text-light-matte-black font-semibold">Not now</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => {
            if (decision === "authorized") {
              addToolResult?.({ status: "ok", user_decision: "approved" });
            } else {
              onRequestApproval?.();
            }
          }}
          className="flex-1 bg-light-matte-black rounded-2xl py-3 items-center"
        >
          <Text className="text-light font-semibold">Approve rebalance</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default RebalancePreviewCard;
