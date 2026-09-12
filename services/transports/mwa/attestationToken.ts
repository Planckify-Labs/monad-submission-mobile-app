/**
 * MWA origin-attestation token — pure verification (Phase 3b).
 *
 * The wallet-hosted script (`landing-page/public/mwa/attest.html`) signs
 * a compact JWS with ES256 (WebCrypto ECDSA P-256 / SHA-256, raw `r‖s`
 * signature) whose payload is:
 *
 *   { typ: "mwa-origin-attest", origin: <browser-attested dApp origin>,
 *     h: <base64(SHA256("attest-origin" ‖ challenge ‖ session_secret))>,
 *     context: <key id>, iat: <seconds> }
 *
 * `origin` is `event.origin` of the dApp's `postMessage` — set by the
 * browser, not by the dApp — which is the whole point of the flow. The
 * wallet checks the signature against the public key it provisioned
 * under `context`, binds `h` to the challenge it issued (`h` is computed
 * natively because only the session holds the secret), and compares
 * `origin` with the `identity.uri` the dApp claimed.
 *
 * Pure module: node-testable.
 */

import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha2";
import { splitUri } from "@/services/deeplinks/uri";

export const ATTEST_TOKEN_TYP = "mwa-origin-attest";
/** Tokens older than this are refused (clock skew tolerated both ways). */
export const ATTEST_TOKEN_MAX_AGE_S = 5 * 60;

export interface AttestJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

export interface AttestPayload {
  typ: string;
  origin: string;
  h: string;
  context: string;
  iat: number;
}

export type AttestVerdict =
  | { ok: true; origin: string }
  | {
      ok: false;
      reason:
        | "malformed"
        | "unknown_key"
        | "bad_signature"
        | "binding_mismatch"
        | "context_mismatch"
        | "expired"
        | "origin_mismatch";
    };

function b64urlToBytes(s: string): Uint8Array | null {
  try {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
    const bin =
      typeof atob === "function"
        ? atob(b64)
        : Buffer.from(b64, "base64").toString("binary");
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** JWK (P-256) → uncompressed SEC1 point bytes (0x04 ‖ x ‖ y). */
export function jwkToPublicKey(jwk: AttestJwk): Uint8Array | null {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") return null;
  const x = b64urlToBytes(jwk.x);
  const y = b64urlToBytes(jwk.y);
  if (!x || !y || x.length !== 32 || y.length !== 32) return null;
  const out = new Uint8Array(65);
  out[0] = 4;
  out.set(x, 1);
  out.set(y, 33);
  return out;
}

/** Normalise an origin for comparison: scheme + lower-cased host (+ port). */
export function normalizeOrigin(url: string): string | null {
  const m = /^(https?):\/\/([^/?#:]+)(?::(\d+))?/i.exec(url.trim());
  if (!m) return null;
  return `${m[1].toLowerCase()}://${m[2].toLowerCase()}${m[3] ? `:${m[3]}` : ""}`;
}

export function parseAttestToken(token: string): {
  header: { alg?: string; kid?: string };
  payload: AttestPayload;
  signingInput: Uint8Array;
  signature: Uint8Array;
} | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const hb = b64urlToBytes(h);
  const pb = b64urlToBytes(p);
  const sig = b64urlToBytes(s);
  if (!hb || !pb || !sig) return null;
  let header: { alg?: string; kid?: string };
  let payload: AttestPayload;
  try {
    header = JSON.parse(new TextDecoder().decode(hb)) as typeof header;
    payload = JSON.parse(new TextDecoder().decode(pb)) as AttestPayload;
  } catch {
    return null;
  }
  if (
    !payload ||
    payload.typ !== ATTEST_TOKEN_TYP ||
    typeof payload.origin !== "string" ||
    typeof payload.h !== "string" ||
    typeof payload.context !== "string" ||
    typeof payload.iat !== "number"
  ) {
    return null;
  }
  return {
    header,
    payload,
    signingInput: new TextEncoder().encode(`${h}.${p}`),
    signature: sig,
  };
}

export function verifyAttestToken(args: {
  token: string;
  /** Public keys the wallet provisioned, by context (key id). */
  keys: Record<string, AttestJwk>;
  /** The challenge context the wallet issued for this identity. */
  expectedContext: string;
  /** `computeAttestOriginBinding(request, challenge)` from the native session. */
  expectedBinding: string;
  /** `identity.uri` the dApp claimed. */
  identityUri: string;
  now?: number;
}): AttestVerdict {
  const parsed = parseAttestToken(args.token);
  if (!parsed) return { ok: false, reason: "malformed" };
  const { header, payload, signingInput, signature } = parsed;
  if (header.alg !== "ES256" || signature.length !== 64)
    return { ok: false, reason: "malformed" };
  const kid = header.kid ?? payload.context;
  const jwk = args.keys[kid];
  if (!jwk) return { ok: false, reason: "unknown_key" };
  const pub = jwkToPublicKey(jwk);
  if (!pub) return { ok: false, reason: "unknown_key" };
  let valid = false;
  try {
    // WebCrypto produces raw r‖s and does not normalise S; accept high-S.
    valid = p256.verify(signature, sha256(signingInput), pub, { lowS: false });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad_signature" };
  if (payload.context !== args.expectedContext)
    return { ok: false, reason: "context_mismatch" };
  if (payload.h !== args.expectedBinding)
    return { ok: false, reason: "binding_mismatch" };
  const now = Math.floor((args.now ?? Date.now()) / 1000);
  if (Math.abs(now - payload.iat) > ATTEST_TOKEN_MAX_AGE_S)
    return { ok: false, reason: "expired" };
  const attested = normalizeOrigin(payload.origin);
  const claimed = normalizeOrigin(args.identityUri);
  if (!attested || !claimed || attested !== claimed)
    return { ok: false, reason: "origin_mismatch" };
  return { ok: true, origin: attested };
}

/**
 * Parse the provisioning page's return URL:
 * `<scheme>://attest/return?nonce=&context=&jwk=<base64url JSON>`.
 */
export function parseProvisionReturn(
  url: string,
): { nonce: string; context: string; jwk: AttestJwk } | null {
  const split = splitUri(url);
  if (!split) return null;
  const path = split.ssp.replace(/^\/\//, "").replace(/\/+$/, "");
  if (path !== "attest/return") return null;
  const nonce = split.query.get("nonce");
  const context = split.query.get("context");
  const jwkB64 = split.query.get("jwk");
  if (!nonce || !context || !jwkB64) return null;
  const raw = b64urlToBytes(jwkB64);
  if (!raw) return null;
  try {
    const jwk = JSON.parse(new TextDecoder().decode(raw)) as AttestJwk;
    if (
      jwk.kty !== "EC" ||
      jwk.crv !== "P-256" ||
      typeof jwk.x !== "string" ||
      typeof jwk.y !== "string"
    ) {
      return null;
    }
    return {
      nonce,
      context,
      jwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
    };
  } catch {
    return null;
  }
}
