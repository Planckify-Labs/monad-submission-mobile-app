/**
 * Agent context builder — the stable shape the Takumi AI on-demand
 * inspector (and any future "scan with AI" / "fraud detection" button)
 * reads off a Solana `ApprovalIntent`.
 *
 * Contract goals:
 *   - JSON-safe (no bigints, no Uint8Array, no functions) — the agent
 *     API HTTP serialiser drops anything it can't stringify.
 *   - Secret-free — never carry private material (signature bytes,
 *     seeds, decoded utf-8 messages the user might not want logged).
 *     Matches `services/bridge/redact.ts` Solana branch.
 *   - Pre-decoded — raw base64 tx is offered for agent's own decoders
 *     but the structured `decoded` / `simulation` fields are authoritative.
 *
 * This is the parity layer with how EVM intents go to the agent. If
 * the agent inspector ships without namespace filtering, this module
 * is what it calls with a Solana intent.
 */

import type { ApprovalIntent } from "@/services/bridge/approval";
import type {
  SolanaApprovalPayload,
  SolanaDecodedInstruction,
  SolanaSignAllTransactionsPayload,
  SolanaSignInPayload,
  SolanaSignMessagePayload,
  SolanaSignTxPayload,
  SolanaSimulationSummary,
  SolanaSwitchClusterPayload,
  SolanaWatchTokenPayload,
} from "./payloads";

export interface AgentIntentContext {
  namespace: "solana";
  kind: ApprovalIntent["kind"];
  id: string;
  origin: {
    url: string;
    host?: string;
    title?: string;
    via?: "webview" | "agent" | "deeplink" | "walletconnect" | "mwa";
  };
  /** Annotations attached by the auto-pipeline (SIWS, simulation, decoder). */
  annotations: Array<{
    code: string;
    severity: "info" | "warn" | "danger";
    title: string;
    detail?: string;
    source: string;
  }>;
  /** Intent-specific data. */
  intent: IntentShape;
}

type IntentShape =
  | ConnectShape
  | SignInShape
  | SignMessageShape
  | SignTransactionShape
  | SignAllShape
  | SwitchClusterShape
  | WatchTokenShape
  | { kind: "unknown" };

interface ConnectShape {
  kind: "connect";
  cluster: string;
  onlyIfTrusted: boolean;
}

interface SignInShape {
  kind: "signIn";
  domain: string;
  address?: string;
  statement?: string;
  uri?: string;
  chainId?: string;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
  resources?: string[];
  /** Canonical SIWS message (patched by the SIWS inspector). Agent
   *  reads this to verify the exact bytes the signer would sign. */
  canonicalMessage?: string;
}

interface SignMessageShape {
  kind: "signMessage";
  address: string;
  cluster?: string;
  display: "utf8" | "base64";
  messageLength: number;
  /** First 16 chars — agent can sanity-check text intent without
   *  the full body landing in agent-API logs. */
  messagePreview?: string;
}

interface SignTransactionShape {
  kind: "signTransaction";
  mode: "sign-only" | "sign-and-send";
  cluster: string;
  version: 0 | "legacy";
  /** Raw base64 wire — agent may decode for its own analysis. */
  transactionB64: string;
  feePayer?: string;
  signerAddresses?: string[];
  writableAddresses?: string[];
  /** Structural account-key list from the wire (static + pre-ALT-resolution). */
  accountKeys?: string[];
  altReferences?: Array<{
    tableAddress: string;
    writableIndexCount: number;
    readonlyIndexCount: number;
  }>;
  durableNonce?: {
    isDurableNonce: boolean;
    nonceAccount?: string;
    authority?: string;
  };
  decoded: Array<{
    program: string;
    programName?: string;
    kind: string;
    /** Human-readable summary — never raw secret material. */
    summary?: string;
  }>;
  simulation?: {
    unitsConsumed?: number;
    balanceChangeCount: number;
    tokenChangeCount: number;
    warnings: SolanaSimulationSummary["warnings"];
    logLineCount: number;
  };
  computeBudget?: {
    unitLimit?: number;
    unitPriceMicroLamports?: number;
    priorityFeeLamportsEst?: number;
  };
  options?: SolanaSignTxPayload["options"];
}

interface SignAllShape {
  kind: "signAllTransactions";
  cluster: string;
  transactions: SignTransactionShape[];
}

interface SwitchClusterShape {
  kind: "switchCluster";
  from: string;
  to: string;
}

interface WatchTokenShape {
  kind: "watchAsset";
  mint: string;
  claimed: {
    symbol?: string;
    name?: string;
    decimals?: number;
    tokenStandard?: string;
  };
  verified?: {
    mintOwner: "spl-token" | "token-2022";
    extensions?: string[];
  };
}

function originHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function instructionSummary(ix: SolanaDecodedInstruction): string {
  if (ix.program === "system" && "kind" in ix) {
    const d = (
      ix as { data?: { from?: string; to?: string; lamports?: bigint } }
    ).data;
    if (ix.kind === "transfer" && d) {
      return `System.transfer ${d.lamports ?? "?"} lamports → ${d.to ?? "?"}`;
    }
    return `System.${ix.kind}`;
  }
  if (
    (ix.program === "spl-token" || ix.program === "token-2022") &&
    "kind" in ix
  ) {
    return `${ix.program}.${ix.kind}`;
  }
  if (ix.program === "compute-budget" && "value" in ix) {
    return `compute-budget.${ix.kind}=${ix.value}`;
  }
  if (ix.program === "memo" && "data" in ix) {
    return `memo: ${String((ix as { data: string }).data).slice(0, 64)}`;
  }
  const kind = "kind" in ix ? (ix as { kind: string }).kind : "unknown";
  return `${ix.program}.${kind}`;
}

function computeBudgetFrom(
  decoded: SolanaDecodedInstruction[],
): SignTransactionShape["computeBudget"] {
  let unitLimit: number | undefined;
  let unitPrice: number | undefined;
  for (const ix of decoded) {
    if (ix.program !== "compute-budget") continue;
    if ("value" in ix && ix.kind === "setComputeUnitLimit") {
      unitLimit = Number(ix.value);
    }
    if ("value" in ix && ix.kind === "setComputeUnitPrice") {
      unitPrice = Number(ix.value);
    }
  }
  if (unitLimit === undefined && unitPrice === undefined) return undefined;
  return {
    unitLimit,
    unitPriceMicroLamports: unitPrice,
    priorityFeeLamportsEst:
      unitLimit !== undefined && unitPrice !== undefined
        ? Math.ceil((unitLimit * unitPrice) / 1_000_000)
        : undefined,
  };
}

function buildSignTxShape(p: SolanaSignTxPayload): SignTransactionShape {
  const decoded = p.decoded ?? [];
  return {
    kind: "signTransaction",
    mode: p.mode,
    cluster: p.cluster,
    version: p.version,
    transactionB64: p.transaction,
    feePayer: p.feePayer,
    signerAddresses: p.signerAddresses,
    writableAddresses: p.writableAddresses,
    accountKeys: p.accountKeys,
    altReferences: p.altReferences?.map((a) => ({
      tableAddress: a.tableAddress,
      writableIndexCount: a.writableIndexes.length,
      readonlyIndexCount: a.readonlyIndexes.length,
    })),
    durableNonce: p.durableNonce,
    decoded: decoded.map((ix) => ({
      program: ix.program,
      programName:
        "programName" in ix
          ? (ix as { programName?: string }).programName
          : undefined,
      kind: "kind" in ix ? (ix as { kind: string }).kind : "memo",
      summary: instructionSummary(ix),
    })),
    simulation: p.simulation
      ? {
          unitsConsumed: p.simulation.unitsConsumed,
          balanceChangeCount: p.simulation.balanceChanges.length,
          tokenChangeCount: p.simulation.tokenChanges.length,
          warnings: p.simulation.warnings,
          logLineCount: p.simulation.logs.length,
        }
      : undefined,
    computeBudget: computeBudgetFrom(decoded),
    options: p.options,
  };
}

/**
 * Build the agent-facing view of a Solana approval intent. Safe to
 * serialise with `JSON.stringify` — no bigints in the output shape
 * (simulation warnings contain string codes, not raw bigint deltas).
 * The raw base64 tx is preserved so an agent with its own parser can
 * verify — but no signatures or seed material ever lands here.
 */
export function buildAgentContext(
  intent: ApprovalIntent<SolanaApprovalPayload>,
): AgentIntentContext {
  const base: AgentIntentContext = {
    namespace: "solana",
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
      const p = payload as { cluster: string; onlyIfTrusted: boolean };
      base.intent = {
        kind: "connect",
        cluster: p.cluster,
        onlyIfTrusted: p.onlyIfTrusted,
      };
      break;
    }
    case "signIn": {
      const p = payload as SolanaSignInPayload & { message?: string };
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
      const p = payload as SolanaSignMessagePayload;
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
      base.intent = buildSignTxShape(payload as SolanaSignTxPayload);
      break;
    }
    case "signAllTransactions": {
      const p = payload as SolanaSignAllTransactionsPayload;
      base.intent = {
        kind: "signAllTransactions",
        cluster: p.cluster,
        transactions: p.transactions.map((t) =>
          buildSignTxShape({
            mode: "sign-only",
            address: p.address,
            cluster: p.cluster,
            version: t.version,
            transaction: t.transaction,
            simulation: t.simulation,
            decoded: t.decoded,
          } as SolanaSignTxPayload),
        ),
      };
      break;
    }
    case "switchCluster": {
      const p = payload as SolanaSwitchClusterPayload;
      base.intent = { kind: "switchCluster", from: p.from, to: p.to };
      break;
    }
    case "watchAsset": {
      const p = payload as SolanaWatchTokenPayload;
      base.intent = {
        kind: "watchAsset",
        mint: p.mint,
        claimed: {
          symbol: p.symbol,
          name: p.name,
          decimals: p.decimals,
          tokenStandard: p.tokenStandard,
        },
        verified: p.verified,
      };
      break;
    }
  }
  return base;
}
