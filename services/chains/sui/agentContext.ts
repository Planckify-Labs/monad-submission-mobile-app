/**
 * Agent context builder — the stable, JSON-safe view a future Takumi-AI
 * on-demand inspector reads off a Sui `ApprovalIntent`.
 *
 * Spec reference: `docs/sui-dapp-bridge-spec.md` §11.5.2.
 *
 * Contract goals:
 *   - JSON-safe. No `bigint`, no `Uint8Array`, no functions. Sui
 *     payloads carry several `bigint` fields (`gasBudget`, `gasPrice`,
 *     simulation `gasUsed`, `balanceChanges.amount`); they are
 *     coerced to strings here so the agent API serialiser can stringify
 *     the payload without dropping fields.
 *   - Secret-free. Never carries signature bytes or seed material. The
 *     decoded UTF-8 of a personal message is truncated to a 16-char
 *     preview (parity with Solana / `redact.ts`).
 *   - Pre-decoded. `intent.payload.decoded` (PTB commands) and
 *     `intent.payload.simulation` are authoritative; the raw base64 BCS
 *     is preserved for an agent that wants its own decode but is NOT
 *     the source of truth.
 *
 * The MoveCall summary line is the highest-leverage signal — it surfaces
 * `0x<package>::<module>::<function> argc=<n> typeArgs=<m>` so an agent
 * can heuristically flag unknown packages, suspicious entry functions,
 * or upgrade-cap movements without re-decoding the BCS itself.
 */

import type { ApprovalIntent } from "@/services/bridge/approval";
import type {
  SuiApprovalPayload,
  SuiConnectPayload,
  SuiDecodedCommand,
  SuiNetwork,
  SuiSignInPayload,
  SuiSignPersonalMessagePayload,
  SuiSignTxPayload,
  SuiSimulationWarning,
  SuiSwitchNetworkPayload,
  SuiTxOptions,
} from "./payloads";

export interface AgentIntentContext {
  namespace: "sui";
  kind: ApprovalIntent["kind"];
  id: string;
  origin: {
    url: string;
    host?: string;
    title?: string;
    via?: "webview" | "agent" | "deeplink" | "walletconnect" | "mwa";
  };
  /** Annotations attached by the auto-pipeline (PTB decoder, simulation, SIWS). */
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
  | SignInShape
  | SignMessageShape
  | SignTransactionShape
  | SwitchNetworkShape
  | { kind: "unknown" };

export interface ConnectShape {
  kind: "connect";
  network: SuiNetwork;
  onlyIfTrusted: boolean;
}

export interface SignInShape {
  kind: "signIn";
  domain: string;
  address?: string;
  statement?: string;
  uri?: string;
  chainId?: SuiNetwork;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
  resources?: string[];
  /** Canonical SIWS message (patched by SuiSiwsInspector). */
  canonicalMessage?: string;
}

export interface SignMessageShape {
  kind: "signMessage";
  address: string;
  display: "utf8" | "base64";
  messageLength: number;
  /** First 16 chars — utf8 mode only. Cap matches `redact.ts`. */
  messagePreview?: string;
}

export interface SignTransactionShape {
  kind: "signTransaction";
  mode: "sign-only" | "sign-and-execute";
  network: SuiNetwork;
  /** Base64 BCS — agent may decode for its own analysis. */
  transactionB64: string;
  sender?: string;
  /** ≠ sender ⇒ sponsored. */
  gasOwner?: string;
  /** Derived: gasOwner !== sender. False when sender is unknown. */
  sponsored: boolean;
  gasBudgetMist?: string;
  gasPriceMist?: string;
  inputArgumentCount?: number;
  decoded: Array<{
    kind: SuiDecodedCommand["kind"];
    summary?: string;
    data?: Record<string, string | number | string[]>;
  }>;
  simulation?: {
    status: "success" | string;
    /** Sum of computation+storage−rebate, as string. */
    gasUsedTotalMist?: string;
    balanceChangeCount: number;
    objectChangeCount: number;
    warnings: SuiSimulationWarning[];
  };
  options?: SuiTxOptions;
}

export interface SwitchNetworkShape {
  kind: "switchNetwork";
  from: SuiNetwork;
  to: SuiNetwork;
}

function originHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function bigintToString(b?: bigint): string | undefined {
  return typeof b === "bigint" ? b.toString() : undefined;
}

/**
 * Human-readable summary line per command kind. Surfaces the
 * `0x<package>::<module>::<function> argc=N typeArgs=M` shape for
 * MoveCall — the highest-signal line for an LLM scanning the intent.
 */
function commandSummary(c: SuiDecodedCommand): string {
  switch (c.kind) {
    case "MoveCall":
      return `MoveCall ${c.package}::${c.module}::${c.function} argc=${c.argumentCount} typeArgs=${c.typeArgumentCount}`;
    case "TransferObjects":
      return `TransferObjects → arg#${c.recipientArgIndex}, ${c.objectArgCount} objects`;
    case "SplitCoins":
      return `SplitCoins from arg#${c.sourceArgIndex} → ${c.amountCount} amounts`;
    case "MergeCoins":
      return `MergeCoins into arg#${c.targetArgIndex}, ${c.sourceArgCount} sources`;
    case "Publish":
      return `Publish ${c.modules} modules, ${c.dependencies} deps`;
    case "Upgrade":
      return `Upgrade ${c.modules} modules, ${c.dependencies} deps`;
    case "MakeMoveVec":
      return `MakeMoveVec ${c.elements} elements${c.type ? ` of ${c.type}` : ""}`;
  }
}

function commandData(
  c: SuiDecodedCommand,
): Record<string, string | number | string[]> {
  switch (c.kind) {
    case "MoveCall":
      return {
        package: c.package,
        module: c.module,
        function: c.function,
        argumentCount: c.argumentCount,
        typeArgumentCount: c.typeArgumentCount,
      };
    case "TransferObjects":
      return {
        recipientArgIndex: c.recipientArgIndex,
        objectArgCount: c.objectArgCount,
      };
    case "SplitCoins":
      return {
        sourceArgIndex: c.sourceArgIndex,
        amountCount: c.amountCount,
      };
    case "MergeCoins":
      return {
        targetArgIndex: c.targetArgIndex,
        sourceArgCount: c.sourceArgCount,
      };
    case "Publish":
    case "Upgrade":
      return {
        modules: c.modules,
        dependencies: c.dependencies,
      };
    case "MakeMoveVec":
      return c.type
        ? { type: c.type, elements: c.elements }
        : { elements: c.elements };
  }
}

function buildSignTxShape(p: SuiSignTxPayload): SignTransactionShape {
  const decoded = p.decoded ?? [];
  const sponsored = !!(p.gasOwner && p.sender && p.gasOwner !== p.sender);
  const gasUsed = p.simulation?.gasUsed;
  const gasUsedTotal = gasUsed
    ? gasUsed.computation + gasUsed.storage - gasUsed.storageRebate
    : undefined;
  return {
    kind: "signTransaction",
    mode: p.mode,
    network: p.network,
    transactionB64: p.transaction,
    sender: p.sender,
    gasOwner: p.gasOwner,
    sponsored,
    gasBudgetMist: bigintToString(p.gasBudget),
    gasPriceMist: bigintToString(p.gasPrice),
    inputArgumentCount: p.inputArgumentCount,
    decoded: decoded.map((c) => ({
      kind: c.kind,
      summary: commandSummary(c),
      data: commandData(c),
    })),
    simulation: p.simulation
      ? {
          status: p.simulation.status,
          gasUsedTotalMist: bigintToString(gasUsedTotal),
          balanceChangeCount: p.simulation.balanceChanges.length,
          objectChangeCount: p.simulation.objectChanges.length,
          warnings: p.simulation.warnings,
        }
      : undefined,
    options: p.options,
  };
}

/**
 * Build the agent-facing view of a Sui approval intent. Safe to
 * serialise with `JSON.stringify` — bigint fields are coerced to
 * strings (and simulation warnings are forwarded with their bigint
 * fields intact at the type level; the agent-API serialiser is what
 * stringifies them at HTTP boundary).
 */
export function buildAgentContext(
  intent: ApprovalIntent<SuiApprovalPayload>,
): AgentIntentContext {
  const base: AgentIntentContext = {
    namespace: "sui",
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
      const p = payload as SuiConnectPayload;
      base.intent = {
        kind: "connect",
        network: p.network,
        onlyIfTrusted: p.onlyIfTrusted,
      };
      break;
    }
    case "signIn": {
      const p = payload as SuiSignInPayload & { message?: string };
      base.intent = {
        kind: "signIn",
        domain: p.domain,
        address: p.address,
        statement: p.statement,
        uri: p.uri,
        chainId: p.chainId,
        nonce: p.nonce,
        issuedAt: p.issuedAt,
        expirationTime: p.expirationTime,
        resources: p.resources,
        canonicalMessage: p.message,
      };
      break;
    }
    case "signMessage": {
      const p = payload as SuiSignPersonalMessagePayload;
      base.intent = {
        kind: "signMessage",
        address: p.address,
        display: p.display,
        messageLength: p.message.length,
        messagePreview:
          p.display === "utf8" && typeof p.message === "string"
            ? p.message.slice(0, 16)
            : undefined,
      };
      break;
    }
    case "signTransaction": {
      base.intent = buildSignTxShape(payload as SuiSignTxPayload);
      break;
    }
    case "switchNetwork": {
      const p = payload as SuiSwitchNetworkPayload;
      base.intent = { kind: "switchNetwork", from: p.from, to: p.to };
      break;
    }
  }
  return base;
}
