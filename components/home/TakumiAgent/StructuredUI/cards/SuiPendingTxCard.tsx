/**
 * SuiPendingTxCard — registry component for Sui write tools
 * (`send_sui`, `send_sui_coin`).
 *
 * Sui counterpart to SolanaPendingTxCard. Diverges in the same two ways
 * Solana does:
 *
 *   1. The transaction identifier is `data.digest` (base58) — Sui executors
 *      deliberately do NOT populate `tx_hash` because the server schema
 *      validates that field as 0x-hex (see the comment in
 *      services/agent-executors/sui.ts::sendSui).
 *   2. There is no live subscription. `pendingTxStore` is keyed on
 *      `tx_hash`, so Sui writes are never inserted there. The card
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

type SuiWriteData = {
  digest?: string;
  network?: "mainnet" | "testnet" | "devnet" | string;
  to?: string;
  coin_type?: string;
  amount_sui?: string;
  token_amount?: string;
  [k: string]: unknown;
};

type SuiWriteOutput = {
  status?: "success" | "failed" | string;
  tx_confirmed?: boolean;
  data?: SuiWriteData;
  error?: string;
  reason?: string;
  user_decision?: "approved" | "rejected";
};

type SuiWriteInput = {
  human_summary?: string;
  description?: string;
  to?: string;
  amount_sui?: string;
  token_amount?: string;
  coin_type?: string;
  [k: string]: unknown;
};

const SUCCESS_GREEN = "#10b981";
const BRAND_RED = "#c71c4b";
const MUTED_GRAY = "#6b7280";

function truncateDigest(digest: string): string {
  if (digest.length <= 14) return digest;
  return `${digest.slice(0, 8)}…${digest.slice(-6)}`;
}

// Facts-first (prompt-injection defense): real to/amount args win over the
// model-authored `human_summary` — see ../approvalSummary.ts.
function describe(input: SuiWriteInput): string {
  const isNative = typeof input.amount_sui === "string";
  const amount = isNative
    ? input.amount_sui
    : typeof input.token_amount === "string"
      ? input.token_amount
      : undefined;
  // The coin type's trailing segment is the on-chain asset actually being
  // moved — derived from args, not model prose.
  const coinTail =
    typeof input.coin_type === "string"
      ? input.coin_type.split("::").pop()
      : undefined;
  return factsFirstSummary(
    {
      amount,
      asset: isNative ? "SUI" : coinTail,
      to: typeof input.to === "string" ? input.to : undefined,
    },
    input,
    "Sui transaction",
  );
}

/**
 * SuiVision explorer URL with subdomain-prefixed hosts for non-mainnet
 * networks. Mirrors `SuiWalletKit.buildTxExplorerUrl` (the kit owns the
 * canonical mapping; we duplicate it here only because the agent card
 * doesn't have access to a `ChainConfig` at render time).
 */
function buildSuiExplorerUrl(
  digest: string,
  network: string | undefined,
): string | undefined {
  if (!digest) return undefined;
  if (network === "testnet") {
    return `https://testnet.suivision.xyz/txblock/${digest}`;
  }
  if (network === "devnet") {
    return `https://devnet.suivision.xyz/txblock/${digest}`;
  }
  return `https://suivision.xyz/txblock/${digest}`;
}

/**
 * Network chip label, or `null` when the network is unknown. A failed result
 * carries no `data.network`, so we must NOT default to "Mainnet" — that
 * wrongly implied a mainnet execution on a testnet swap. Render nothing
 * instead; successful results always carry the real network.
 */
function networkLabel(network: string | undefined): string | null {
  if (network === "mainnet") return "Mainnet";
  if (network === "devnet") return "Devnet";
  if (network === "testnet") return "Testnet";
  return null;
}

function ResultCard({
  input,
  output,
  state,
}: {
  input: SuiWriteInput;
  output: SuiWriteOutput | undefined;
  state: ToolComponentProps<SuiWriteInput, SuiWriteOutput>["state"];
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

  const data: SuiWriteData = output.data ?? {};
  const digest = typeof data.digest === "string" ? data.digest : undefined;
  const network = typeof data.network === "string" ? data.network : undefined;
  const netLabel = networkLabel(network);
  const explorerUrl = digest ? buildSuiExplorerUrl(digest, network) : undefined;
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
        <AddWalletErrorAction error={output.error} reason={output.reason} />
        {digest ? (
          <View className="flex-row items-center gap-2 mt-2">
            <Text
              className="text-[11px] text-gray-500 flex-1"
              numberOfLines={1}
            >
              {truncateDigest(digest)}
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
      {digest ? (
        <View className="flex-row items-center gap-2 mt-2">
          <Text className="text-[11px] text-gray-500 flex-1" numberOfLines={1}>
            {truncateDigest(digest)}
          </Text>
          {canOpen ? <ExternalLink size={12} color={MUTED_GRAY} /> : null}
        </View>
      ) : null}
    </Pressable>
  );
}

const SuiPendingTxCard: React.FC<
  ToolComponentProps<SuiWriteInput, SuiWriteOutput>
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

export default SuiPendingTxCard;
