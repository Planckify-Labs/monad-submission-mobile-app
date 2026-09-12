/**
 * SEP-0007 "URI Scheme to facilitate delegated signing" — pure parsers
 * and verifiers (deep-link spec §2.4 / §6.4). Every rule quotes the SEP
 * (v2.1.0, fetched 2026-09-11) in its comment.
 *
 * No network, no keystore, no React: node-testable. The `stellar.toml`
 * fetch and the key pin live in the handler / kit.
 */

import { ed25519 } from "@noble/curves/ed25519";
import { StrKey } from "@stellar/stellar-base";
import type { DeepLinkRejectCode } from "@/services/deeplinks/types";
import { hostnameOfHttps, safeDecodeComponent } from "@/services/deeplinks/uri";
import { base64ToBytes } from "./base64";

export const SEP7_SIGNING_PREFIX = "stellar.sep.7 - URI Scheme";
export const SEP7_MAX_MSG = 300;
export const SEP7_MAX_CHAIN_DEPTH = 7;

/** RFC-ish FQDN: labels of [a-z0-9-], at least one dot, ASCII only. */
export const FQDN_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/i;

export type Sep7MemoType =
  | "MEMO_TEXT"
  | "MEMO_ID"
  | "MEMO_HASH"
  | "MEMO_RETURN";

export interface Sep7Common {
  /** `msg`, URL-decoded and truncated to 300 chars for display. */
  msg?: string;
  networkPassphrase?: string;
  originDomain?: string;
  /** Raw (still URL-encoded) signature parameter, as it appeared. */
  signature?: string;
  /** `url:`-prefixed callback, already validated as https. */
  callbackUrl?: string;
}

export interface Sep7Tx extends Sep7Common {
  op: "tx";
  /** Base64 envelope, URL-decoded. */
  xdr: string;
  replace?: Sep7Replace;
  pubkey?: string;
}

export interface Sep7Pay extends Sep7Common {
  op: "pay";
  destination: string;
  amount?: string;
  assetCode?: string;
  assetIssuer?: string;
  memo?: string;
  memoType?: Sep7MemoType;
}

export interface Sep7Replace {
  /** field → reference identifier, in order. */
  fields: Array<{ field: string; ref: string }>;
  /** reference identifier → hint. */
  hints: Record<string, string>;
}

export type Sep7Parse =
  | { ok: true; request: Sep7Tx | Sep7Pay }
  | { ok: false; code: DeepLinkRejectCode; domain?: string };

/** Txrep field names v1 can fill in (spec §6.4 step 3). */
export const SUPPORTED_REPLACE_FIELD_RE =
  /^(sourceAccount|operations\[(\d+)\]\.sourceAccount)$/;

/**
 * "`replace` … considered invalid unless the `reference_identifier`s
 * are balanced on both sides of the separating semicolon."
 */
export function parseReplace(raw: string): Sep7Replace | null {
  const semi = raw.indexOf(";");
  const left = semi === -1 ? raw : raw.slice(0, semi);
  const right = semi === -1 ? "" : raw.slice(semi + 1);
  const fields: Sep7Replace["fields"] = [];
  const leftRefs = new Set<string>();
  for (const pair of left.split(",")) {
    if (!pair) continue;
    const idx = pair.indexOf(":");
    if (idx <= 0) return null;
    const field = pair.slice(0, idx);
    const ref = pair.slice(idx + 1);
    if (!field || !ref) return null;
    fields.push({ field, ref });
    leftRefs.add(ref);
  }
  const hints: Record<string, string> = {};
  const rightRefs = new Set<string>();
  for (const pair of right.split(",")) {
    if (!pair) continue;
    const idx = pair.indexOf(":");
    if (idx <= 0) return null;
    const ref = pair.slice(0, idx);
    hints[ref] = pair.slice(idx + 1);
    rightRefs.add(ref);
  }
  if (fields.length === 0) return null;
  if (leftRefs.size !== rightRefs.size) return null;
  for (const r of leftRefs) if (!rightRefs.has(r)) return null;
  return { fields, hints };
}

/** Count nested `chain=` levels; > 7 is refused (spec anti-explosion). */
export function chainDepth(rawQuery: string): number {
  let depth = 0;
  let cur: string | null = rawQuery;
  while (cur !== null && depth <= SEP7_MAX_CHAIN_DEPTH + 1) {
    const params: URLSearchParams = new URLSearchParams(cur);
    const chain: string | null = params.get("chain");
    if (!chain) break;
    depth += 1;
    const q: number = chain.indexOf("?");
    cur = q === -1 ? null : chain.slice(q + 1);
  }
  return depth;
}

function parseCallback(
  raw: string | null,
): { ok: true; url?: string } | { ok: false } {
  if (raw === null) return { ok: true };
  if (!raw.startsWith("url:")) return { ok: false };
  const url = raw.slice(4);
  if (!hostnameOfHttps(url)) return { ok: false };
  return { ok: true, url };
}

function common(
  query: URLSearchParams,
  rawQuery: string,
):
  | { ok: true; value: Sep7Common }
  | { ok: false; code: DeepLinkRejectCode; domain?: string } {
  const out: Sep7Common = {};
  const msg = query.get("msg");
  if (msg !== null && msg !== "")
    out.msg = msg.length > SEP7_MAX_MSG ? msg.slice(0, SEP7_MAX_MSG) : msg;
  const np = query.get("network_passphrase");
  if (np) out.networkPassphrase = np;
  const originDomain = query.get("origin_domain");
  const signature = query.get("signature");
  if (originDomain !== null) {
    if (!FQDN_RE.test(originDomain)) {
      // Rule 3: not an FQDN → not a valid request. Non-ASCII → the same
      // refusal (IDN homographs never get a headline).
      return { ok: false, code: "malformed" };
    }
    if (signature === null || signature === "") {
      // Rule 2: "If the `signature` field is missing then do not allow
      // the user to sign … This is not a valid URI request."
      return {
        ok: false,
        code: "signature_missing",
        domain: originDomain.toLowerCase(),
      };
    }
    out.originDomain = originDomain.toLowerCase();
    // Keep the still-encoded value: verification decodes it itself and
    // `URLSearchParams` would have turned `+` into a space.
    out.signature = rawSignatureParam(rawQuery) ?? signature;
  }
  const cb = parseCallback(query.get("callback"));
  if (!cb.ok) return { ok: false, code: "malformed" };
  if (cb.url) out.callbackUrl = cb.url;
  return { ok: true, value: out };
}

/**
 * Parse `web+stellar:<op>?<params>`. `ssp` is `<op>`; the query is
 * already split by the kernel.
 */
export function parseSep7(
  ssp: string,
  query: URLSearchParams,
  rawQuery: string,
): Sep7Parse {
  const op = ssp.replace(/^\/+/, "");
  if (op !== "tx" && op !== "pay")
    return { ok: false, code: "unsupported_operation" };
  if (chainDepth(rawQuery) > SEP7_MAX_CHAIN_DEPTH)
    return { ok: false, code: "malformed" };
  const c = common(query, rawQuery);
  if (!c.ok) return c;

  if (op === "tx") {
    const xdr = query.get("xdr");
    if (!xdr) return { ok: false, code: "malformed" };
    let replace: Sep7Replace | undefined;
    const replaceRaw = query.get("replace");
    if (replaceRaw !== null && replaceRaw !== "") {
      const parsed = parseReplace(replaceRaw);
      if (!parsed) return { ok: false, code: "malformed" };
      for (const f of parsed.fields) {
        if (!SUPPORTED_REPLACE_FIELD_RE.test(f.field)) {
          return { ok: false, code: "unsupported_operation" };
        }
      }
      replace = parsed;
    }
    const pubkey = query.get("pubkey") ?? undefined;
    if (pubkey !== undefined && !StrKey.isValidEd25519PublicKey(pubkey)) {
      return { ok: false, code: "malformed" };
    }
    return {
      ok: true,
      request: { op: "tx", xdr, replace, pubkey, ...c.value },
    };
  }

  const destination = query.get("destination");
  if (!destination) return { ok: false, code: "malformed" };
  // Federated `name*domain` and `M…` muxed accounts are out of scope
  // (stellar-chain-support-spec §0 non-goals).
  if (!StrKey.isValidEd25519PublicKey(destination)) {
    return { ok: false, code: "unsupported_operation" };
  }
  const amount = query.get("amount") ?? undefined;
  if (amount !== undefined && !/^\d+(\.\d{1,7})?$/.test(amount)) {
    return { ok: false, code: "malformed" };
  }
  const assetCode = query.get("asset_code") ?? undefined;
  const assetIssuer = query.get("asset_issuer") ?? undefined;
  if ((assetCode === undefined) !== (assetIssuer === undefined)) {
    return { ok: false, code: "malformed" };
  }
  if (assetCode !== undefined && !/^[A-Za-z0-9]{1,12}$/.test(assetCode)) {
    return { ok: false, code: "malformed" };
  }
  if (
    assetIssuer !== undefined &&
    !StrKey.isValidEd25519PublicKey(assetIssuer)
  ) {
    return { ok: false, code: "malformed" };
  }
  const memoTypeRaw = query.get("memo_type");
  const memoType =
    memoTypeRaw === "MEMO_TEXT" ||
    memoTypeRaw === "MEMO_ID" ||
    memoTypeRaw === "MEMO_HASH" ||
    memoTypeRaw === "MEMO_RETURN"
      ? memoTypeRaw
      : memoTypeRaw === null
        ? undefined
        : null;
  if (memoType === null) return { ok: false, code: "malformed" };
  const memo = query.get("memo") ?? undefined;
  return {
    ok: true,
    request: {
      op: "pay",
      destination,
      amount,
      assetCode,
      assetIssuer,
      memo,
      memoType: memoType ?? (memo !== undefined ? "MEMO_TEXT" : undefined),
      ...c.value,
    },
  };
}

/**
 * The URI with the trailing `&signature=…` (or `?signature=…`) removed
 * byte-for-byte — "we first separate out the `signature` field and value
 * from the URI Request … and verify it against the `signature` value".
 * Returns `null` when `signature` is not the last parameter.
 */
export function stripSignature(raw: string): string | null {
  const m = /[?&]signature=[^&#]*$/.exec(raw);
  if (!m) return null;
  return raw.slice(0, m.index);
}

/**
 * "The first 35 bytes of the payload are all 0, the 36th byte is 4. Then
 * we concatenate the URI request with the prefix `stellar.sep.7 - URI
 * Scheme` (no delimiter) and convert that to bytes."
 */
export function sep7SigningPayload(uriWithoutSignature: string): Uint8Array {
  const text = new TextEncoder().encode(
    SEP7_SIGNING_PREFIX + uriWithoutSignature,
  );
  const out = new Uint8Array(36 + text.length);
  out[35] = 4;
  out.set(text, 36);
  return out;
}

export type Sep7VerifyResult = "ok" | "signature_invalid" | "malformed";

/**
 * Verify a SEP-0007 request signature. `signatureParam` is the raw query
 * value (still URL-encoded); `publicKey` is the toml's
 * `URI_REQUEST_SIGNING_KEY` (`G…`).
 */
export function verifySep7Signature(
  raw: string,
  signatureParam: string,
  publicKey: string,
): Sep7VerifyResult {
  const unsigned = stripSignature(raw);
  if (unsigned === null) return "malformed";
  if (!StrKey.isValidEd25519PublicKey(publicKey)) return "malformed";
  const b64 = safeDecodeComponent(signatureParam);
  if (b64 === null) return "malformed";
  let sig: Uint8Array;
  try {
    sig = base64ToBytes(b64);
  } catch {
    return "malformed";
  }
  if (sig.length !== 64) return "malformed";
  const pub = new Uint8Array(StrKey.decodeEd25519PublicKey(publicKey));
  try {
    return ed25519.verify(sig, sep7SigningPayload(unsigned), pub)
      ? "ok"
      : "signature_invalid";
  } catch {
    return "signature_invalid";
  }
}

/**
 * Extract `URI_REQUEST_SIGNING_KEY` from a `stellar.toml` body. Top-level
 * key only (before any `[section]`), quoted or bare. `null` when absent
 * or not a valid `G…` key.
 */
export function parseUriRequestSigningKey(toml: string): string | null {
  for (const line of toml.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("[")) break;
    const m =
      /^URI_REQUEST_SIGNING_KEY\s*=\s*"?([A-Z2-7]{56})"?\s*(#.*)?$/.exec(t);
    if (m) return StrKey.isValidEd25519PublicKey(m[1]) ? m[1] : null;
  }
  return null;
}

/** The raw (still percent-encoded) `signature` value when it is the last parameter. */
export function rawSignatureParam(rawQuery: string): string | null {
  const m = /(?:^|&)signature=([^&]*)$/.exec(rawQuery);
  return m ? m[1] : null;
}
