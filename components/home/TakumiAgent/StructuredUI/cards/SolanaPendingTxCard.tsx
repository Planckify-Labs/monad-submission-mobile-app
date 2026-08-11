/**
 * SolanaPendingTxCard — registry component for Solana write tools
 * (`send_sol`, `send_spl_token`).
 *
 * Solana counterpart to PendingTxCard. Diverges in two ways:
 *
 *   1. The transaction identifier is `data.signature` (base58) — Solana
 *      executors deliberately do NOT populate `tx_hash` because the
 *      server schema validates that field as 0x-hex (see the comment in
 *      services/agent-executors/solana.ts::sendSol).
 *   2. There is no live subscription. `pendingTxStore` is keyed on
 *      `tx_hash`, so Solana writes are never inserted there. The card
 *      renders a static result the moment the executor returns.
 *
 * Lifecycle:
 *   state             | live                              | historical
 *   ------------------|-----------------------------------|---------------------------
 *   input-available   | <PreviewCard> (countdown+actions) | "Pending" / "Interrupted" frozen
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
import { AddWalletErrorAction } from "./AddWalletErrorAction";

type SolanaWriteData = {
  signature?: string;
  cluster?: "mainnet-beta" | "devnet" | "testnet" | string;
  to?: string;
  mint_address?: string;
  amount_sol?: string;
  token_amount?: string;
  [k: string]: unknown;
};

type SolanaWriteOutput = {
  status?: "success" | "failed" | string;
  tx_confirmed?: boolean;
  data?: SolanaWriteData;
  error?: string;
  reason?: string;
  user_decision?: "approved" | "rejected";
};

type SolanaWriteInput = {
  human_summary?: string;
  description?: string;
  to?: string;
  amount_sol?: string;
  token_amount?: string;
  mint_address?: string;
  [k: string]: unknown;
};

const SUCCESS_GREEN = "#10b981";
const BRAND_RED = "#c71c4b";
const MUTED_GRAY = "#6b7280";

function truncateSignature(sig: string): string {
  if (sig.length <= 14) return sig;
  return `${sig.slice(0, 8)}…${sig.slice(-6)}`;
}

// Facts-first (prompt-injection defense): real to/amount args win over the
// model-authored `human_summary` — see ../approvalSummary.ts.
function describe(input: SolanaWriteInput): string {
  const amount =
    typeof input.amount_sol === "string"
      ? input.amount_sol
      : typeof input.token_amount === "string"
        ? input.token_amount
        : undefined;
  const asset =
    typeof input.amount_sol === "string"
      ? "SOL"
      : typeof input.token_amount === "string"
        ? "tokens"
        : undefined;
  return factsFirstSummary(
    {
      amount,
      asset,
      to: typeof input.to === "string" ? input.to : undefined,
    },
    input,
    "Solana transaction",
  );
}

/**
 * Solana explorer URL with cluster query param. The standard explorer at
 * https://explorer.solana.com accepts `?cluster=devnet|testnet`; mainnet-beta
 * is the implicit default and takes no query param.
 */
function buildSolanaExplorerUrl(
  signature: string,
  cluster: string | undefined,
): string | undefined {
  if (!signature) return undefined;
  const base = `https://explorer.solana.com/tx/${signature}`;
  if (cluster === "devnet" || cluster === "testnet") {
    return `${base}?cluster=${cluster}`;
  }
  return base;
}

function clusterLabel(cluster: string | undefined): string {
  if (cluster === "devnet") return "Devnet";
  if (cluster === "testnet") return "Testnet";
  return "Mainnet";
}

function ResultCard({
  input,
  output,
  state,
}: {
  input: SolanaWriteInput;
  output: SolanaWriteOutput | undefined;
  state: ToolComponentProps<SolanaWriteInput, SolanaWriteOutput>["state"];
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

  const data: SolanaWriteData = output.data ?? {};
  const signature =
    typeof data.signature === "string" ? data.signature : undefined;
  const cluster = typeof data.cluster === "string" ? data.cluster : undefined;
  const explorerUrl = signature
    ? buildSolanaExplorerUrl(signature, cluster)
    : undefined;
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
          <Text className="ml-auto text-[11px] text-gray-500">
            {clusterLabel(cluster)}
          </Text>
        </View>
        <Text className="text-sm text-light-matte-black/80 mt-1.5">
          {description}
        </Text>
        {/* Friendly copy only — never the raw `error` / `reason` code
            (CLAUDE.md user-facing-errors). */}
        <Text
          className="text-[13px] text-light-matte-black/70 mt-1"
          numberOfLines={3}
        >
          {agentErrorCopy(output.error, output.reason)}
        </Text>
        <AddWalletErrorAction error={output.error} reason={output.reason} />
        {signature ? (
          <View className="flex-row items-center gap-2 mt-2">
            <Text
              className="text-[11px] text-gray-500 flex-1"
              numberOfLines={1}
            >
              {truncateSignature(signature)}
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
        <Text className="ml-auto text-[11px] text-gray-500">
          {clusterLabel(cluster)}
        </Text>
      </View>
      <Text className="text-sm text-light-matte-black/80 mt-1.5">
        {description}
      </Text>
      {signature ? (
        <View className="flex-row items-center gap-2 mt-2">
          <Text className="text-[11px] text-gray-500 flex-1" numberOfLines={1}>
            {truncateSignature(signature)}
          </Text>
          {canOpen ? <ExternalLink size={12} color={MUTED_GRAY} /> : null}
        </View>
      ) : null}
    </Pressable>
  );
}

const SolanaPendingTxCard: React.FC<
  ToolComponentProps<SolanaWriteInput, SolanaWriteOutput>
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

export default SolanaPendingTxCard;
