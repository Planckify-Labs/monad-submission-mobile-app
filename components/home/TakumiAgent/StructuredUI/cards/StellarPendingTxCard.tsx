/**
 * StellarPendingTxCard — registry component for Stellar write tools
 * (`send_xlm`, `send_stellar_asset`, `establish_stellar_trustline`).
 *
 * Stellar counterpart to SuiPendingTxCard / SolanaPendingTxCard. Diverges
 * in the same two ways the other non-EVM cards do:
 *
 *   1. The transaction identifier is `data.hash` (Horizon hex hash) — Stellar
 *      executors deliberately do NOT populate the wire-typed `tx_hash` slot,
 *      which the server schema validates as 0x-hex (see the comment in
 *      services/agent-executors/wallet/stellar.ts).
 *   2. There is no live subscription. `pendingTxStore` is keyed on `tx_hash`,
 *      so Stellar writes are never inserted there. The card renders a static
 *      result the moment the executor returns.
 *
 * `establish_stellar_trustline` is a no-amount opt-in: a `changeTrust` op. If
 * the wallet already trusts the asset the executor returns
 * `already_trusted: true` with no `hash`; the card still renders "Confirmed"
 * (the trustline is in place) and simply omits the explorer row.
 *
 * Lifecycle:
 *   state             | live                              | historical
 *   ------------------|-----------------------------------|---------------------------
 *   input-available   | <WriteApprovalGate>               | "Interrupted" frozen
 *   output-available  | static "Confirmed" receipt        | identical
 *   output-error      | static "Failed" receipt           | identical
 */

import * as Linking from "expo-linking";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  XCircle,
} from "lucide-react-native";
import type React from "react";
import { Pressable, Text, View } from "react-native";
import { agentErrorCopy } from "../agentErrorCopy";
import { factsFirstSummary } from "../approvalSummary";
import type { ToolComponentProps } from "../types";
import WriteApprovalGate from "../WriteApprovalGate";

type StellarWriteData = {
  hash?: string;
  network?: "mainnet" | "testnet" | string;
  to?: string;
  code?: string;
  issuer?: string;
  amount_xlm?: string;
  amount?: string;
  already_trusted?: boolean;
  [k: string]: unknown;
};

type StellarWriteOutput = {
  status?: "success" | "failed" | string;
  tx_confirmed?: boolean;
  data?: StellarWriteData;
  error?: string;
  reason?: string;
  user_decision?: "approved" | "rejected";
};

type StellarWriteInput = {
  human_summary?: string;
  description?: string;
  to?: string;
  amount_xlm?: string;
  amount?: string;
  code?: string;
  issuer?: string;
  [k: string]: unknown;
};

const SUCCESS_GREEN = "#10b981";
const BRAND_RED = "#c71c4b";
const MUTED_GRAY = "#6b7280";

function truncateHash(hash: string): string {
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

// Facts-first (prompt-injection defense): real to/amount args win over the
// model-authored `human_summary` — see ../approvalSummary.ts.
function describe(input: StellarWriteInput): string {
  const isNative = typeof input.amount_xlm === "string";
  const amount = isNative
    ? input.amount_xlm
    : typeof input.amount === "string"
      ? input.amount
      : undefined;
  const code = typeof input.code === "string" ? input.code : undefined;
  return factsFirstSummary(
    {
      amount,
      asset: isNative ? "XLM" : code,
      to: typeof input.to === "string" ? input.to : undefined,
    },
    input,
    "Stellar transaction",
  );
}

/**
 * StellarExpert explorer URL. Mirrors `StellarWalletKit.buildTxExplorerUrl`
 * (the kit owns the canonical mapping; we duplicate it here only because the
 * agent card doesn't have access to a `ChainConfig` at render time). Note
 * StellarExpert's mainnet path segment is `public`, not `mainnet`.
 */
function buildStellarExplorerUrl(
  hash: string,
  network: string | undefined,
): string | undefined {
  if (!hash) return undefined;
  const net = network === "testnet" ? "testnet" : "public";
  return `https://stellar.expert/explorer/${net}/tx/${hash}`;
}

/**
 * Network chip label, or `null` when the network is unknown. A failed result
 * carries no `data.network`, so we must NOT default to "Mainnet" — render
 * nothing instead; successful results always carry the real network.
 */
function networkLabel(network: string | undefined): string | null {
  if (network === "mainnet") return "Mainnet";
  if (network === "testnet") return "Testnet";
  return null;
}

function ResultCard({
  input,
  output,
  state,
}: {
  input: StellarWriteInput;
  output: StellarWriteOutput | undefined;
  state: ToolComponentProps<StellarWriteInput, StellarWriteOutput>["state"];
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

  const data: StellarWriteData = output.data ?? {};
  const hash = typeof data.hash === "string" ? data.hash : undefined;
  const network = typeof data.network === "string" ? data.network : undefined;
  const netLabel = networkLabel(network);
  const explorerUrl = hash ? buildStellarExplorerUrl(hash, network) : undefined;
  const canOpen = typeof explorerUrl === "string";

  const onPress = () => {
    if (!canOpen || !explorerUrl) return;
    Linking.openURL(explorerUrl).catch(() => {});
  };

  const isFailed = state === "output-error" || output.status === "failed";

  if (isFailed) {
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
          {netLabel ? (
            <Text className="ml-auto text-[11px] text-gray-500">
              {netLabel}
            </Text>
          ) : null}
        </View>
        <Text className="text-sm text-light-matte-black/80 mt-1.5">
          {description}
        </Text>
        {/* Friendly, specific copy — NEVER the raw `error` / `reason` code
            (CLAUDE.md user-facing-errors). `agentErrorCopy` maps the curated
            (error, reason) pair to hand-written wording. */}
        <Text
          className="text-[13px] text-light-matte-black/70 mt-1"
          numberOfLines={3}
        >
          {agentErrorCopy(output.error, output.reason)}
        </Text>
        {hash ? (
          <View className="flex-row items-center gap-2 mt-2">
            <Text
              className="text-[11px] text-gray-500 flex-1"
              numberOfLines={1}
            >
              {truncateHash(hash)}
            </Text>
            {canOpen ? <ExternalLink size={12} color={MUTED_GRAY} /> : null}
          </View>
        ) : null}
      </Pressable>
    );
  }

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
          Confirmed
        </Text>
        {netLabel ? (
          <Text className="ml-auto text-[11px] text-gray-500">{netLabel}</Text>
        ) : null}
      </View>
      <Text className="text-sm text-light-matte-black/80 mt-1.5">
        {description}
      </Text>
      {/* A no-op trustline (already trusted) has no hash — surface a subtle
          note so "Confirmed" with no explorer row isn't confusing. */}
      {!hash && data.already_trusted === true ? (
        <Text className="text-[12px] text-gray-500 mt-1">
          Trustline already in place.
        </Text>
      ) : null}
      {hash ? (
        <View className="flex-row items-center gap-2 mt-2">
          <Text className="text-[11px] text-gray-500 flex-1" numberOfLines={1}>
            {truncateHash(hash)}
          </Text>
          {canOpen ? <ExternalLink size={12} color={MUTED_GRAY} /> : null}
        </View>
      ) : null}
    </Pressable>
  );
}

const StellarPendingTxCard: React.FC<
  ToolComponentProps<StellarWriteInput, StellarWriteOutput>
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
    return <ResultCard input={input} output={output} state={state} />;
  }

  if (state === "input-streaming" || state === "input-available") {
    if (!addToolResult) {
      return <ResultCard input={input} output={output} state={state} />;
    }
    return (
      <WriteApprovalGate
        decision={decision}
        summary={describe(input)}
        onApprove={() =>
          addToolResult({ status: "success", user_decision: "approved" })
        }
        onReject={() =>
          addToolResult({ status: "failed", user_decision: "rejected" })
        }
        onRequestApproval={onRequestApproval}
      />
    );
  }

  return <ResultCard input={input} output={output} state={state} />;
};

export default StellarPendingTxCard;
