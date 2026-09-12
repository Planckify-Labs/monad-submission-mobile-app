/**
 * Sui deep-link handler — Mysten Payment Kit `sui:pay` (spec §6.3).
 * Class A only: Sui has no signing or session URI standard; sessions go
 * through WalletConnect (`sui` namespace, §7).
 */

import type { DeepLinkSchemeHandler } from "@/services/deeplinks/schemeRegistry";
import type {
  DeepLinkIntent,
  Provenance,
  SigningSummary,
} from "@/services/deeplinks/types";
import type { PaymentIntent } from "@/services/paymentIntent/types";
import { parseSuiPay, SUI_PAY_PROTOCOL_ID, type SuiPayRequest } from "./suiPay";

function coinLabel(coinType: string): string {
  const tail = coinType.split("::").pop() ?? coinType;
  return tail.length > 16 ? `${tail.slice(0, 16)}…` : tail;
}

function summaryFor(r: SuiPayRequest): SigningSummary {
  const lines: SigningSummary["lines"] = [
    { label: "To", value: r.receiver },
    {
      label: "Amount (smallest unit)",
      value: `${r.amount.toString()} ${coinLabel(r.coinType)}`,
    },
    { label: "Nonce", value: r.nonce },
  ];
  if (r.registryId) lines.push({ label: "Registry", value: r.registryId });
  else if (r.registryName)
    lines.push({ label: "Registry", value: r.registryName });
  const linkText =
    [r.label, r.message].filter(Boolean).join(" · ") || undefined;
  return { title: "Payment request", chainLabel: "Sui", lines, linkText };
}

export function suiPayToPaymentIntent(
  r: SuiPayRequest,
  raw: string,
): PaymentIntent {
  return {
    source: "deeplink",
    rawScan: raw,
    channel: {
      kind: "wallet",
      namespace: "sui",
      address: r.receiver,
      amount: r.amount,
      token: r.coinType,
      assetLabel: coinLabel(r.coinType),
      protocol: {
        id: SUI_PAY_PROTOCOL_ID,
        params: {
          coinType: r.coinType,
          nonce: r.nonce,
          registryId: r.registryId,
          registryName: r.registryName,
          label: r.label,
          message: r.message,
          iconUrl: r.iconUrl,
        },
      },
    },
  };
}

export const suiPayHandler: DeepLinkSchemeHandler = {
  id: "sui-pay",
  namespace: "sui",
  schemes: ["sui"],
  priority: 10,
  parse(split, envelope): DeepLinkIntent {
    const parsed = parseSuiPay(split.ssp, split.query);
    if (!parsed.ok) return { kind: "reject", code: parsed.code };
    const provenance: Provenance = {
      verification: { kind: "none" },
      firstSeen: false,
      transport: "os-link",
      source: envelope.source,
    };
    return {
      kind: "payment",
      namespace: "sui",
      intent: suiPayToPaymentIntent(parsed.request, envelope.raw),
      provenance,
      summary: summaryFor(parsed.request),
    };
  },
};

export const suiDeepLinkHandlers: readonly DeepLinkSchemeHandler[] = [
  suiPayHandler,
];
