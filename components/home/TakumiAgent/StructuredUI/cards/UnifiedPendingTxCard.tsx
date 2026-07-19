/**
 * UnifiedPendingTxCard — the receipt card for the chain-agnostic capability
 * send tools (`send_native`, `send_token`).
 *
 * These tools delegate on the device to the existing per-namespace send
 * executors, so their RESULT shape is whatever that namespace produces (EVM
 * `tx_hash`, Solana `data.signature`, Sui `data.digest`, Stellar `data.hash`
 * + `data.network`). Rather than re-implement four receipt renderers, this is
 * a thin dispatcher: it picks the matching per-namespace card and forwards the
 * props (the user's chosen "delegate + adapt" approach).
 *
 * Dispatch signal: the capability executor stamps `data.namespace` on the
 * result (see services/agent-executors/wallet/capabilities.ts). We read that
 * first and fall back to shape-sniffing for older/edge results.
 *
 * The `input-available` approval gate is namespace-agnostic (just a summary +
 * approve/reject), so we render it directly here — the namespace isn't known
 * until the result comes back anyway. We synthesize the summary from the tool
 * input ({ to, amount } / { to, symbol, amount }) and thread it into the
 * delegate card as `human_summary` so both the gate and the receipt read the
 * same friendly line.
 */

import type React from "react";
import { factsFirstSummary } from "../approvalSummary";
import type { ToolComponent, ToolComponentProps } from "../types";
import WriteApprovalGate from "../WriteApprovalGate";
import PendingTxCard from "./PendingTxCard";
import SolanaPendingTxCard from "./SolanaPendingTxCard";
import StellarPendingTxCard from "./StellarPendingTxCard";
import SuiPendingTxCard from "./SuiPendingTxCard";

type SendInput = {
  human_summary?: string;
  description?: string;
  to?: string;
  symbol?: string;
  amount?: string;
  [k: string]: unknown;
};

type SendOutput = {
  status?: "success" | "failed" | string;
  tx_hash?: string;
  data?: Record<string, unknown>;
  [k: string]: unknown;
};

// biome-ignore lint/suspicious/noExplicitAny: forwarding to loosely-typed sibling cards
const CARD_BY_NAMESPACE: Record<string, ToolComponent<any, any>> = {
  eip155: PendingTxCard,
  evm: PendingTxCard,
  solana: SolanaPendingTxCard,
  sui: SuiPendingTxCard,
  stellar: StellarPendingTxCard,
};

/**
 * Resolve which per-namespace card to render. Prefers the stamped
 * `data.namespace`; falls back to the distinctive result fields each chain
 * uses for its transaction identifier.
 */
function resolveCard(
  output: SendOutput | undefined,
  // biome-ignore lint/suspicious/noExplicitAny: sibling cards are open-typed
): ToolComponent<any, any> {
  const data = output?.data ?? {};
  const stamped = typeof data.namespace === "string" ? data.namespace : "";
  if (CARD_BY_NAMESPACE[stamped]) return CARD_BY_NAMESPACE[stamped];

  if (typeof data.digest === "string") return SuiPendingTxCard;
  if (typeof data.signature === "string") return SolanaPendingTxCard;
  if (typeof data.network === "string" || typeof data.hash === "string") {
    return StellarPendingTxCard;
  }
  // EVM (or unknown) — the plain PendingTxCard also renders the generic
  // "Failed"/rejected states safely.
  return PendingTxCard;
}

/**
 * Friendly one-liner for the gate + receipt. Facts-first: the actual
 * to/amount/symbol args always win over the model's `human_summary` so an
 * injected prompt can't relabel what the user is approving.
 */
function summarize(input: SendInput): string {
  return factsFirstSummary(
    {
      amount: typeof input.amount === "string" ? input.amount : undefined,
      asset: typeof input.symbol === "string" ? input.symbol : undefined,
      to: typeof input.to === "string" ? input.to : undefined,
    },
    input,
    "Send transaction",
  );
}

const UnifiedPendingTxCard: React.FC<
  ToolComponentProps<SendInput, SendOutput>
> = (props) => {
  const { state, input, mode, addToolResult, decision, onRequestApproval } =
    props;
  const summary = summarize(input);

  // Live approval — namespace not yet known, but the gate is identical across
  // namespaces, so render it directly.
  if (
    mode === "live" &&
    (state === "input-available" || state === "input-streaming") &&
    addToolResult
  ) {
    return (
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
    );
  }

  // Result / historical — dispatch to the namespace-specific receipt card,
  // threading the synthesized summary so its own describe() reads the same line.
  const DelegateCard = resolveCard(props.output);
  return (
    <DelegateCard {...props} input={{ ...input, human_summary: summary }} />
  );
};

export default UnifiedPendingTxCard;
