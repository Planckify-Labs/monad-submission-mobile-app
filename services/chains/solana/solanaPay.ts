/**
 * Solana Pay — pure parsers and validators (spec §2.2.1, §6.2).
 *
 * Source: `anza-xyz/solana-pay` `spec/SPEC.md`. Every rule below quotes
 * the spec's wording in its comment so a reviewer can check it without
 * the document open. No network, no keystore, no React: node-testable.
 */

import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import type { DeepLinkRejectCode } from "@/services/deeplinks/types";
import { hostnameOfHttps, safeDecodeComponent } from "@/services/deeplinks/uri";

export const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Solana Pay caps a versioned transaction at the packet MTU. */
export const MAX_TX_BYTES = 1232;
/** SPL Memo v2 payload cap. */
export const MAX_MEMO_BYTES = 566;
/** Display cap for attacker-supplied free text (S-11). */
export const MAX_DISPLAY_TEXT = 256;

export interface SolanaPayTransfer {
  kind: "transfer";
  recipient: string;
  /** Human units as spelled in the URI; `undefined` → "the wallet must prompt". */
  amount?: string;
  splToken?: string;
  references: string[];
  label?: string;
  message?: string;
  memo?: string;
  /** Wallet-side extension (not in the spec); defaults to mainnet-beta. */
  cluster: "mainnet-beta" | "devnet";
}

export interface SolanaPayTransactionRequest {
  kind: "transaction-request";
  /** Absolute https URL. */
  link: string;
  host: string;
  cluster: "mainnet-beta" | "devnet";
}

export type SolanaPayParse =
  | SolanaPayTransfer
  | SolanaPayTransactionRequest
  | { kind: "reject"; code: DeepLinkRejectCode };

/**
 * "`amount` is a non-negative integer or decimal number of user units …
 * decimals < 1 must have a leading 0 … scientific notation is prohibited
 * … `0` is a valid value … too many decimals → malformed."
 */
export function validateAmount(
  raw: string,
  maxDecimals: number,
): "ok" | "malformed" {
  if (!/^\d+(\.\d+)?$/.test(raw)) return "malformed";
  const frac = raw.split(".")[1] ?? "";
  if (frac.length > maxDecimals) return "malformed";
  return "ok";
}

/** Human decimal string → base units with `decimals`. Caller validated shape. */
export function amountToBaseUnits(raw: string, decimals: number): bigint {
  const [int, frac = ""] = raw.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return (
    BigInt(int) * 10n ** BigInt(decimals) + BigInt(padded === "" ? "0" : padded)
  );
}

function decodeBase58(s: string): Uint8Array | null {
  try {
    return bs58.decode(s);
  } catch {
    return null;
  }
}

function capText(s: string | null): string | undefined {
  if (s === null || s === "") return undefined;
  return s.length > MAX_DISPLAY_TEXT ? `${s.slice(0, MAX_DISPLAY_TEXT)}…` : s;
}

/**
 * Parse the scheme-specific part + query of a `solana:` URI. The
 * transaction-request form is detected first: "link … is a conditionally
 * URL-encoded absolute HTTPS URL. If the value is not an absolute HTTPS
 * URL, the wallet must reject it as malformed."
 */
export function parseSolanaPay(
  ssp: string,
  query: URLSearchParams,
  rawQuery: string,
): SolanaPayParse {
  const decodedSsp = safeDecodeComponent(ssp);
  if (decodedSsp === null) return { kind: "reject", code: "malformed" };
  const cluster = query.get("cluster") === "devnet" ? "devnet" : "mainnet-beta";

  if (/^https?:/i.test(decodedSsp) || /^https?%3a/i.test(ssp)) {
    // Transaction request. The raw query (if the link was not encoded)
    // belongs to the link itself.
    const link = decodedSsp.startsWith("http")
      ? decodedSsp + (rawQuery ? `?${rawQuery}` : "")
      : decodedSsp;
    const host = hostnameOfHttps(link);
    if (!host) {
      return {
        kind: "reject",
        code: /^http:/i.test(link) ? "not_https" : "malformed",
      };
    }
    return { kind: "transaction-request", link, host, cluster };
  }

  // Transfer request. "`recipient` must be the base58-encoded public key
  // of a native SOL account."
  const recipient = decodedSsp;
  if (!SOLANA_PUBKEY_RE.test(recipient))
    return { kind: "reject", code: "malformed" };
  const rb = decodeBase58(recipient);
  if (!rb || rb.length !== 32) return { kind: "reject", code: "malformed" };

  const splToken = query.get("spl-token") ?? undefined;
  if (splToken !== undefined) {
    const mb = SOLANA_PUBKEY_RE.test(splToken) ? decodeBase58(splToken) : null;
    if (!mb || mb.length !== 32) return { kind: "reject", code: "malformed" };
  }

  const amountRaw = query.get("amount");
  let amount: string | undefined;
  if (amountRaw !== null && amountRaw !== "") {
    // SOL has 9 decimals; SPL decimals are checked in build() after the
    // mint is fetched, so only the universal rules apply here.
    if (validateAmount(amountRaw, splToken ? 30 : 9) !== "ok") {
      return { kind: "reject", code: "malformed" };
    }
    amount = amountRaw;
  }

  // "`reference` … must be base58-encoded 32 byte arrays … in the order
  // provided."
  const references: string[] = [];
  for (const ref of query.getAll("reference")) {
    const b = SOLANA_PUBKEY_RE.test(ref) ? decodeBase58(ref) : null;
    if (!b || b.length !== 32) return { kind: "reject", code: "malformed" };
    references.push(ref);
  }

  const memoRaw = query.get("memo");
  if (
    memoRaw !== null &&
    new TextEncoder().encode(memoRaw).length > MAX_MEMO_BYTES
  ) {
    return { kind: "reject", code: "malformed" };
  }

  return {
    kind: "transfer",
    recipient,
    amount,
    splToken,
    references,
    label: capText(query.get("label")),
    message: capText(query.get("message")),
    memo: memoRaw === null || memoRaw === "" ? undefined : memoRaw,
    cluster,
  };
}

// ── Transaction request validation (spec "Transaction Request" §) ──────

export interface TxRequestMetadata {
  label?: string;
  icon?: string;
}

/** Validate the GET response body. `null` when unusable (non-fatal). */
export function parseTxRequestMetadata(
  text: string,
  contentType: string | null,
): TxRequestMetadata | { reject: "malformed" } | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const o = json as { label?: unknown; icon?: unknown };
  const label = typeof o.label === "string" ? capText(o.label) : undefined;
  let icon: string | undefined;
  if (typeof o.icon === "string") {
    // "icon must be an absolute HTTP or HTTPS URL of an SVG, PNG, or
    // WebP image, or the wallet must reject it as malformed."
    const okScheme = /^https?:\/\//i.test(o.icon);
    const okExt = /\.(svg|png|webp)(\?.*)?$/i.test(o.icon);
    const okType = /image\/(svg\+xml|png|webp)/i.test(contentType ?? "");
    if (!okScheme || !(okExt || okType)) return { reject: "malformed" };
    icon = o.icon;
  }
  return { label, icon };
}

export interface ValidatedTxRequest {
  /** Base64 wire transaction ready for the signing sheet. */
  transaction: string;
  version: 0 | "legacy";
  message?: string;
}

/** Deserialized view the validator needs, independent of the SDK used. */
export interface DecodedTx {
  bytes: Uint8Array;
  /** Serialized message bytes (what signatures cover). */
  messageBytes: Uint8Array;
  /** Signatures in order, each 64 bytes; all-zero = unsigned slot. */
  signatures: Uint8Array[];
  /** Required signer pubkeys (base58), in message order. */
  requiredSigners: string[];
  version: 0 | "legacy";
}

export type TxRequestVerdict =
  | { ok: true; needsFeePayerAndBlockhash: boolean }
  | { ok: false; code: "malformed" | "malicious" | "wrong_account" };

function isZero(b: Uint8Array): boolean {
  for (const x of b) if (x !== 0) return false;
  return true;
}

/**
 * Apply the spec's untrusted-transaction rules to a decoded transaction:
 *  - size ≤ 1232 bytes,
 *  - "If `signatures` is empty … set the feePayer to the account and
 *    the recentBlockhash to the latest"; else "the wallet must verify the
 *    signatures, and if any are invalid … reject as malformed",
 *  - "If any signature except a signature for the `account` … is
 *    expected, the wallet must reject the transaction as malicious."
 */
export function validateTxRequest(
  tx: DecodedTx,
  account: string,
): TxRequestVerdict {
  if (tx.bytes.length > MAX_TX_BYTES) return { ok: false, code: "malformed" };
  if (tx.requiredSigners.length === 0) return { ok: false, code: "malformed" };
  if (tx.signatures.length !== tx.requiredSigners.length) {
    return { ok: false, code: "malformed" };
  }
  const present = tx.signatures.map((s) => !isZero(s));
  const anySigned = present.some(Boolean);

  if (!anySigned) {
    // The wallet overwrites the fee payer (signer slot 0) with the
    // account; every other required signer must already be the account.
    const foreign = tx.requiredSigners.slice(1).filter((s) => s !== account);
    if (foreign.length > 0) return { ok: false, code: "malicious" };
    return { ok: true, needsFeePayerAndBlockhash: true };
  }

  // Verify every present signature against its signer.
  for (let i = 0; i < tx.requiredSigners.length; i++) {
    if (!present[i]) continue;
    const pub = decodeBase58(tx.requiredSigners[i]);
    if (!pub || pub.length !== 32) return { ok: false, code: "malformed" };
    let valid = false;
    try {
      valid = ed25519.verify(tx.signatures[i], tx.messageBytes, pub);
    } catch {
      valid = false;
    }
    if (!valid) return { ok: false, code: "malformed" };
  }
  // Every still-unsigned required signer must be the account.
  let ours = 0;
  for (let i = 0; i < tx.requiredSigners.length; i++) {
    if (present[i]) continue;
    if (tx.requiredSigners[i] !== account)
      return { ok: false, code: "malicious" };
    ours += 1;
  }
  if (ours === 0) return { ok: false, code: "wrong_account" };
  return { ok: true, needsFeePayerAndBlockhash: false };
}
