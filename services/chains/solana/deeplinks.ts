/**
 * Solana deep-link handlers — spec §6.2 / §8.
 *
 *   - `solana-pay-transfer`    (priority 10, Class A) `solana:<pubkey>?…`
 *   - `solana-pay-transaction` (priority 20, Class B) `solana:<https link>`
 *   - `mwa-associate`          (Class C, android)    `solana-wallet:/v1/associate/local?…`
 *
 * `parse()` is pure. Building happens after the interstitial's Continue:
 * the transfer through `SolanaWalletKit.buildPaymentRequest`
 * (`services/walletKit/solana/paymentRequest.ts`), the transaction
 * request through `buildSolanaPayTransactionRequest` in the same module.
 */

import type { TWallet } from "@/constants/types/walletTypes";
import type { DeepLinkSchemeHandler } from "@/services/deeplinks/schemeRegistry";
import type {
  BuildContext,
  DeepLinkIntent,
  ExternalApprovalDraft,
  Provenance,
  SigningSummary,
} from "@/services/deeplinks/types";
import type { PaymentIntent } from "@/services/paymentIntent/types";
import { buildSolanaPayTransactionRequest } from "@/services/walletKit/solana/paymentRequest";
import { parseSolanaPay, type SolanaPayTransfer } from "./solanaPay";

export const SOLANA_PAY_PROTOCOL_ID = "solana-pay";

function provenanceFor(envelope: { source: Provenance["source"] }): Provenance {
  return {
    verification: { kind: "none" },
    firstSeen: false,
    transport: "os-link",
    source: envelope.source,
  };
}

function transferSummary(t: SolanaPayTransfer): SigningSummary {
  const lines: SigningSummary["lines"] = [{ label: "To", value: t.recipient }];
  lines.push({
    label: "Amount",
    value:
      t.amount === undefined
        ? "You will enter the amount"
        : `${t.amount} ${t.splToken ? "tokens" : "SOL"}`,
  });
  if (t.splToken) lines.push({ label: "Token mint", value: t.splToken });
  if (t.references.length > 0) {
    lines.push({ label: "References", value: String(t.references.length) });
  }
  if (t.cluster !== "mainnet-beta")
    lines.push({ label: "Cluster", value: t.cluster });
  const linkText =
    [t.label, t.message].filter(Boolean).join(" · ") || undefined;
  return { title: "Payment request", chainLabel: "Solana", lines, linkText };
}

export function transferToPaymentIntent(
  t: SolanaPayTransfer,
  raw: string,
): PaymentIntent {
  return {
    source: "deeplink",
    rawScan: raw,
    channel: {
      kind: "wallet",
      namespace: "solana",
      address: t.recipient,
      target: { namespace: "solana", cluster: t.cluster },
      token: t.splToken,
      amountDecimal: t.amount,
      assetLabel: t.splToken ? undefined : "SOL",
      protocol: {
        id: SOLANA_PAY_PROTOCOL_ID,
        params: {
          references: t.references,
          label: t.label,
          message: t.message,
          memo: t.memo,
        },
      },
    },
  };
}

export const solanaPayTransferHandler: DeepLinkSchemeHandler = {
  id: "solana-pay-transfer",
  namespace: "solana",
  schemes: ["solana"],
  priority: 10,
  parse(split, envelope): DeepLinkIntent | null {
    const parsed = parseSolanaPay(split.ssp, split.query, split.rawQuery);
    if (parsed.kind === "transaction-request") return null; // next handler
    if (parsed.kind === "reject") return { kind: "reject", code: parsed.code };
    return {
      kind: "payment",
      namespace: "solana",
      intent: transferToPaymentIntent(parsed, envelope.raw),
      provenance: provenanceFor(envelope),
      summary: transferSummary(parsed),
    };
  },
};

export const solanaPayTransactionHandler: DeepLinkSchemeHandler = {
  id: "solana-pay-transaction",
  namespace: "solana",
  schemes: ["solana"],
  priority: 20,
  parse(split, envelope): DeepLinkIntent | null {
    const parsed = parseSolanaPay(split.ssp, split.query, split.rawQuery);
    if (parsed.kind === "reject") return { kind: "reject", code: parsed.code };
    if (parsed.kind !== "transaction-request") return null;
    const provenance: Provenance = {
      ...provenanceFor(envelope),
      claimedOrigin: parsed.host,
    };
    const { link, host, cluster } = parsed;
    return {
      kind: "signing",
      namespace: "solana",
      summary: {
        title: "Signing request",
        chainLabel: "Solana",
        lines: [
          { label: "From", value: host },
          ...(cluster !== "mainnet-beta"
            ? [{ label: "Cluster", value: cluster }]
            : []),
        ],
      },
      returnChannel: { kind: "broadcast" },
      provenance,
      build: (
        wallet: TWallet,
        ctx: BuildContext,
      ): Promise<ExternalApprovalDraft> =>
        buildSolanaPayTransactionRequest({
          wallet,
          link,
          host,
          cluster,
          provenance,
          ctx,
        }),
    };
  },
};

/**
 * MWA association arriving in the main app. The dedicated host activity
 * (`plugins/withSolanaMobileWalletAdapter`) normally receives
 * `solana-wallet:` directly; this handler exists so the kernel has a
 * typed answer if the OS routes it here (iOS never does — no handler on
 * that platform, so it is `unsupported_scheme`).
 */
export const mwaAssociateHandler: DeepLinkSchemeHandler = {
  id: "mwa-associate",
  namespace: "solana",
  schemes: ["solana-wallet"],
  platforms: ["android"],
  // The dedicated MWA activity must receive the association intent; an
  // in-app WebView navigating here hands it to the OS, not the kernel.
  osOwned: true,
  priority: 10,
  parse(split, envelope): DeepLinkIntent {
    const path = split.ssp.replace(/^\/+/, "");
    if (path !== "v1/associate/local")
      return { kind: "reject", code: "unsupported_operation" };
    const association = split.query.get("association");
    const port = Number(split.query.get("port"));
    if (
      !association ||
      !Number.isInteger(port) ||
      port < 49152 ||
      port > 65535
    ) {
      return { kind: "reject", code: "malformed" };
    }
    return {
      kind: "associate",
      transport: "mwa",
      uri: envelope.raw,
      provenance: { ...provenanceFor(envelope), transport: "mwa" },
    };
  },
};

export const solanaDeepLinkHandlers: readonly DeepLinkSchemeHandler[] = [
  solanaPayTransferHandler,
  solanaPayTransactionHandler,
  mwaAssociateHandler,
];
