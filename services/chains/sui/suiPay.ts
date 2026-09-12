/**
 * `sui:pay` — pure parser mirroring Mysten `parsePaymentTransactionUri`
 * (`packages/payment-kit/src/uri.ts`, fetched 2026-09-11). Deep-link
 * spec §2.3 / §6.3.
 *
 * Rules, in the SDK's order: URI must start with `sui:pay?`; `receiver`,
 * `amount`, `coinType`, `nonce` required; receiver a valid Sui address;
 * coinType a valid named type; nonce ≤ 36 chars; amount a positive
 * integer in the coin's smallest unit; optional `registry` is an object
 * id or a registry name; `label`, `message`, `iconUrl` optional
 * (`iconUrl` kept only when https).
 */

import {
  isValidNamedType,
  isValidSuiAddress,
  isValidSuiObjectId,
} from "@mysten/sui/utils";
import type { DeepLinkRejectCode } from "@/services/deeplinks/types";
import { hostnameOfHttps } from "@/services/deeplinks/uri";

export const SUI_PAY_PROTOCOL_ID = "sui-pay";
export const MAX_NONCE_LENGTH = 36;
const MAX_DISPLAY_TEXT = 256;

export interface SuiPayRequest {
  receiver: string;
  /** Smallest unit, positive. */
  amount: bigint;
  coinType: string;
  nonce: string;
  registryId?: string;
  registryName?: string;
  label?: string;
  message?: string;
  iconUrl?: string;
}

export type SuiPayParse =
  | { ok: true; request: SuiPayRequest }
  | { ok: false; code: DeepLinkRejectCode };

function cap(s: string | null): string | undefined {
  if (s === null || s === "") return undefined;
  return s.length > MAX_DISPLAY_TEXT ? `${s.slice(0, MAX_DISPLAY_TEXT)}…` : s;
}

export function parseSuiPay(ssp: string, query: URLSearchParams): SuiPayParse {
  if (ssp !== "pay") return { ok: false, code: "unsupported_operation" };
  const receiver = query.get("receiver");
  const amountRaw = query.get("amount");
  const coinType = query.get("coinType");
  const nonce = query.get("nonce");
  if (!receiver || !amountRaw || !coinType || !nonce)
    return { ok: false, code: "malformed" };
  if (!isValidSuiAddress(receiver)) return { ok: false, code: "malformed" };
  if (!isValidNamedType(coinType)) return { ok: false, code: "malformed" };
  if (nonce.length > MAX_NONCE_LENGTH) return { ok: false, code: "malformed" };
  if (!/^\d+$/.test(amountRaw)) return { ok: false, code: "malformed" };
  const amount = BigInt(amountRaw);
  if (amount <= 0n) return { ok: false, code: "malformed" };

  const registry = query.get("registry") ?? undefined;
  let registryId: string | undefined;
  let registryName: string | undefined;
  if (registry) {
    if (isValidSuiObjectId(registry)) registryId = registry;
    else registryName = registry;
  }

  const iconRaw = query.get("iconUrl");
  const iconUrl = iconRaw && hostnameOfHttps(iconRaw) ? iconRaw : undefined;

  return {
    ok: true,
    request: {
      receiver,
      amount,
      coinType,
      nonce,
      registryId,
      registryName,
      label: cap(query.get("label")),
      message: cap(query.get("message")),
      iconUrl,
    },
  };
}
