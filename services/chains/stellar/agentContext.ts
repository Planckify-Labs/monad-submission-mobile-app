/**
 * Agent context builder — the stable, JSON-safe view a future Takumi-AI
 * on-demand inspector reads off a Stellar `ApprovalIntent`.
 *
 * Spec reference: `docs/stellar-dapp-bridge-spec.md` §11.5.1. Mirrors
 * `services/chains/sui/agentContext.ts`'s contract.
 *
 * Contract goals:
 *   - JSON-safe. No `bigint`/`Uint8Array`/functions — every
 *     `StellarDecodedOperation` field is already a plain string (stroop
 *     amounts included), so unlike Sui's `agentContext.ts` there's no
 *     bigint-to-string coercion step needed here at all.
 *   - Secret-free. Never carries signature bytes or seed material. The
 *     raw XDR is preserved only as a structural `xdrLength`, never the
 *     full string (parity with `redact.ts`'s `SUBMIT_TRANSACTION`
 *     branch). Message text is truncated to a 16-char preview (parity
 *     with Solana/Sui/`redact.ts`).
 *   - Pre-decoded. `intent.payload.decoded`/`.preflight` are
 *     authoritative; the raw XDR length is preserved only for an agent
 *     that wants to reason about size, never re-decode from it.
 */

import type { ApprovalIntent } from "@/services/bridge/approval";
import type {
  StellarApprovalPayload,
  StellarConnectPayload,
  StellarDecodedOperation,
  StellarNetwork,
  StellarSignMessagePayload,
  StellarSignTransactionPayload,
} from "./payloads";

export interface AgentIntentContext {
  namespace: "stellar";
  kind: ApprovalIntent["kind"];
  id: string;
  origin: {
    url: string;
    host?: string;
    title?: string;
    via?: "webview" | "agent" | "deeplink" | "walletconnect" | "mwa";
  };
  /** Annotations attached by the auto-pipeline (XDR decoder, preflight). */
  annotations: Array<{
    code: string;
    severity: "info" | "warn" | "danger";
    title: string;
    detail?: string;
    source: string;
  }>;
  intent: IntentShape;
}

export type IntentShape =
  | ConnectShape
  | SignMessageShape
  | SignTransactionShape
  | { kind: "unknown" };

export interface ConnectShape {
  kind: "connect";
  network: StellarNetwork;
}

export interface SignMessageShape {
  kind: "signMessage";
  address: string;
  messageLength: number;
  /** First 16 chars — cap matches `redact.ts`/Sui's `agentContext.ts`. */
  messagePreview: string;
}

export interface SignTransactionShape {
  kind: "signTransaction";
  networkPassphrase: string;
  /** Structural only, never the full XDR string. */
  xdrLength: number;
  sourceAccount?: string;
  feeStroops?: string;
  sequence?: string;
  operationCount: number;
  decoded: StellarDecodedOperation[];
  preflight?: {
    destinationExists?: boolean;
    destinationHasTrustline?: boolean;
  };
  /** Populated only when the dApp asked for sign-and-submit (§1.8). */
  submit?: boolean;
}

function originHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function buildSignTxShape(
  p: StellarSignTransactionPayload,
): SignTransactionShape {
  return {
    kind: "signTransaction",
    networkPassphrase: p.networkPassphrase,
    xdrLength: p.xdr.length,
    sourceAccount: p.sourceAccount,
    feeStroops: p.fee,
    sequence: p.sequence,
    operationCount: p.decoded?.length ?? 0,
    decoded: p.decoded ?? [],
    preflight: p.preflight,
    submit: p.submit,
  };
}

/**
 * Build the agent-facing view of a Stellar approval intent. Safe to
 * serialise with `JSON.stringify` directly — no bigint fields anywhere
 * in the Stellar payload shapes.
 */
export function buildAgentContext(
  intent: ApprovalIntent<StellarApprovalPayload>,
): AgentIntentContext {
  const base: AgentIntentContext = {
    namespace: "stellar",
    kind: intent.kind,
    id: intent.id,
    origin: {
      url: intent.origin.url,
      host: originHost(intent.origin.url),
      title: intent.origin.title,
      via: intent.origin.via,
    },
    annotations: intent.annotations.map((a) => ({
      code: a.code,
      severity: a.severity,
      title: a.title,
      detail: a.detail,
      source: a.source,
    })),
    intent: { kind: "unknown" },
  };

  const payload = intent.payload;
  switch (intent.kind) {
    case "connect": {
      const p = payload as StellarConnectPayload;
      base.intent = { kind: "connect", network: p.network };
      break;
    }
    case "signMessage": {
      const p = payload as StellarSignMessagePayload;
      base.intent = {
        kind: "signMessage",
        address: p.address,
        messageLength: p.message.length,
        messagePreview: p.message.slice(0, 16),
      };
      break;
    }
    case "signTransaction": {
      base.intent = buildSignTxShape(payload as StellarSignTransactionPayload);
      break;
    }
    default:
      break;
  }
  return base;
}
