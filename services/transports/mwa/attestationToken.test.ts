/**
 * Phase 3b — origin-attestation token verification (pure).
 *
 * The signing side mirrors what `landing-page/public/mwa/attest.html`
 * does with WebCrypto: ES256 over `base64url(header).base64url(payload)`
 * with a raw `r‖s` signature. noble stands in for WebCrypto here.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha2";
import {
  ATTEST_TOKEN_MAX_AGE_S,
  ATTEST_TOKEN_TYP,
  type AttestJwk,
  jwkToPublicKey,
  normalizeOrigin,
  parseAttestToken,
  parseProvisionReturn,
  verifyAttestToken,
} from "./attestationToken";

function b64url(bytes: Uint8Array | string): string {
  const b =
    typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  return b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function keypair(): { priv: Uint8Array; jwk: AttestJwk } {
  const priv = p256.utils.randomPrivateKey();
  const pub = p256.getPublicKey(priv, false);
  return {
    priv,
    jwk: {
      kty: "EC",
      crv: "P-256",
      x: b64url(pub.slice(1, 33)),
      y: b64url(pub.slice(33, 65)),
    },
  };
}

function sign(
  priv: Uint8Array,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "ES256", kid: "ctx-1" },
): string {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = p256
    .sign(sha256(new TextEncoder().encode(`${h}.${p}`)), priv)
    .toCompactRawBytes();
  return `${h}.${p}.${b64url(sig)}`;
}

const NOW = 1_800_000_000_000;
const BINDING = "c29tZS1iaW5kaW5n";

function goodPayload(over: Partial<Record<string, unknown>> = {}) {
  return {
    typ: ATTEST_TOKEN_TYP,
    origin: "https://dapp.example",
    h: BINDING,
    context: "ctx-1",
    iat: Math.floor(NOW / 1000),
    ...over,
  };
}

describe("verifyAttestToken", () => {
  test("accepts a well-formed ES256 token bound to the issued challenge", () => {
    const { priv, jwk } = keypair();
    const token = sign(priv, goodPayload());
    const v = verifyAttestToken({
      token,
      keys: { "ctx-1": jwk },
      expectedContext: "ctx-1",
      expectedBinding: BINDING,
      identityUri: "https://dapp.example/app/index.html",
      now: NOW,
    });
    assert.deepEqual(v, { ok: true, origin: "https://dapp.example" });
  });

  test("accepts a high-S signature (WebCrypto does not normalise S)", () => {
    const { priv, jwk } = keypair();
    const h = b64url(JSON.stringify({ alg: "ES256", kid: "ctx-1" }));
    const p = b64url(JSON.stringify(goodPayload()));
    const sig = p256.sign(sha256(new TextEncoder().encode(`${h}.${p}`)), priv, {
      lowS: false,
    });
    // Force the malleable form: s' = n - s.
    const s2 = p256.CURVE.n - sig.s;
    const raw = new p256.Signature(sig.r, s2).toCompactRawBytes();
    const v = verifyAttestToken({
      token: `${h}.${p}.${b64url(raw)}`,
      keys: { "ctx-1": jwk },
      expectedContext: "ctx-1",
      expectedBinding: BINDING,
      identityUri: "https://dapp.example",
      now: NOW,
    });
    assert.equal(v.ok, true);
  });

  test("rejects a token signed by a key the wallet never provisioned", () => {
    const { priv } = keypair();
    const { jwk: otherJwk } = keypair();
    const token = sign(priv, goodPayload());
    const base = {
      expectedContext: "ctx-1",
      expectedBinding: BINDING,
      identityUri: "https://dapp.example",
      now: NOW,
    };
    assert.deepEqual(verifyAttestToken({ token, keys: {}, ...base }), {
      ok: false,
      reason: "unknown_key",
    });
    assert.deepEqual(
      verifyAttestToken({ token, keys: { "ctx-1": otherJwk }, ...base }),
      {
        ok: false,
        reason: "bad_signature",
      },
    );
  });

  test("rejects tampered payloads, wrong binding, wrong context, stale iat, other origin", () => {
    const { priv, jwk } = keypair();
    const base = {
      keys: { "ctx-1": jwk },
      expectedContext: "ctx-1",
      expectedBinding: BINDING,
      identityUri: "https://dapp.example",
      now: NOW,
    };
    const good = sign(priv, goodPayload());
    const [h, , s] = good.split(".");
    const tampered = `${h}.${b64url(JSON.stringify(goodPayload({ origin: "https://evil.example" })))}.${s}`;
    assert.deepEqual(verifyAttestToken({ token: tampered, ...base }), {
      ok: false,
      reason: "bad_signature",
    });

    assert.deepEqual(
      verifyAttestToken({
        token: sign(priv, goodPayload({ h: "other" })),
        ...base,
      }),
      {
        ok: false,
        reason: "binding_mismatch",
      },
    );
    assert.deepEqual(
      verifyAttestToken({
        token: sign(priv, goodPayload({ context: "ctx-2" }), {
          alg: "ES256",
          kid: "ctx-1",
        }),
        ...base,
      }),
      { ok: false, reason: "context_mismatch" },
    );
    assert.deepEqual(
      verifyAttestToken({
        token: sign(
          priv,
          goodPayload({
            iat: Math.floor(NOW / 1000) - ATTEST_TOKEN_MAX_AGE_S - 1,
          }),
        ),
        ...base,
      }),
      { ok: false, reason: "expired" },
    );
    assert.deepEqual(
      verifyAttestToken({
        token: sign(priv, goodPayload({ origin: "https://evil.example" })),
        ...base,
      }),
      { ok: false, reason: "origin_mismatch" },
    );
    // Same host, different scheme/port is a different origin.
    assert.deepEqual(
      verifyAttestToken({
        token: sign(priv, goodPayload({ origin: "http://dapp.example" })),
        ...base,
      }),
      { ok: false, reason: "origin_mismatch" },
    );
    assert.deepEqual(
      verifyAttestToken({
        token: sign(priv, goodPayload({ origin: "https://dapp.example:8443" })),
        ...base,
      }),
      { ok: false, reason: "origin_mismatch" },
    );
  });

  test("rejects non-ES256 headers and malformed tokens", () => {
    const { priv, jwk } = keypair();
    const base = {
      keys: { "ctx-1": jwk },
      expectedContext: "ctx-1",
      expectedBinding: BINDING,
      identityUri: "https://dapp.example",
      now: NOW,
    };
    for (const token of [
      "",
      "a.b",
      "a.b.c.d",
      sign(priv, goodPayload(), { alg: "none", kid: "ctx-1" }),
      sign(priv, goodPayload(), { alg: "HS256", kid: "ctx-1" }),
      sign(priv, { ...goodPayload(), typ: "jwt" }),
      `${b64url("{")}.${b64url("{}")}.${b64url(new Uint8Array(64))}`,
    ]) {
      const v = verifyAttestToken({ token, ...base });
      assert.equal(v.ok, false, token);
      if (!v.ok) assert.equal(v.reason, "malformed", token);
    }
  });

  test("kid falls back to the payload context", () => {
    const { priv, jwk } = keypair();
    const token = sign(priv, goodPayload(), { alg: "ES256" });
    const v = verifyAttestToken({
      token,
      keys: { "ctx-1": jwk },
      expectedContext: "ctx-1",
      expectedBinding: BINDING,
      identityUri: "https://dapp.example",
      now: NOW,
    });
    assert.equal(v.ok, true);
  });
});

describe("WebCrypto interop (what landing-page/public/mwa/attest.html produces)", () => {
  test("an ES256 JWS signed with WebCrypto verifies, and its JWK round-trips through the return URL", async () => {
    const subtle = globalThis.crypto.subtle;
    const pair = await subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const jwkFull = await subtle.exportKey("jwk", pair.publicKey);
    const pub = {
      kty: "EC",
      crv: "P-256",
      x: jwkFull.x,
      y: jwkFull.y,
    } as AttestJwk;
    // Provisioning return, exactly as the page builds it.
    const ret = parseProvisionReturn(
      `takumiwallet-mwa://attest/return?nonce=00ff&context=ctx-web&jwk=${b64url(JSON.stringify(pub))}`,
    );
    assert.ok(ret);
    // Attestation token, exactly as the page builds it (header carries typ JWT + kid).
    const header = { alg: "ES256", typ: "JWT", kid: "ctx-web" };
    const payload = {
      typ: ATTEST_TOKEN_TYP,
      origin: "https://dapp.example",
      h: BINDING,
      context: "ctx-web",
      iat: Math.floor(NOW / 1000),
    };
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const sig = await subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      new TextEncoder().encode(input),
    );
    const token = `${input}.${b64url(new Uint8Array(sig))}`;
    const v = verifyAttestToken({
      token,
      keys: { [ret.context]: ret.jwk },
      expectedContext: "ctx-web",
      expectedBinding: BINDING,
      identityUri: "https://dapp.example/play",
      now: NOW,
    });
    assert.deepEqual(v, { ok: true, origin: "https://dapp.example" });
  });
});

describe("helpers", () => {
  test("jwkToPublicKey builds an uncompressed SEC1 point and refuses other curves", () => {
    const { priv, jwk } = keypair();
    const pub = jwkToPublicKey(jwk);
    assert.ok(pub);
    assert.deepEqual(
      Buffer.from(pub),
      Buffer.from(p256.getPublicKey(priv, false)),
    );
    assert.equal(jwkToPublicKey({ ...jwk, crv: "P-384" as "P-256" }), null);
    assert.equal(jwkToPublicKey({ ...jwk, x: "AAAA" }), null);
  });

  test("normalizeOrigin keeps scheme + host + explicit port, lower-cases, drops path", () => {
    assert.equal(
      normalizeOrigin("HTTPS://DApp.Example/path?x#y"),
      "https://dapp.example",
    );
    assert.equal(
      normalizeOrigin("https://dapp.example:8443/x"),
      "https://dapp.example:8443",
    );
    assert.equal(normalizeOrigin("solana-wallet://x"), null);
    assert.equal(normalizeOrigin(""), null);
  });

  test("parseAttestToken exposes the signing input verbatim", () => {
    const { priv } = keypair();
    const token = sign(priv, goodPayload());
    const parsed = parseAttestToken(token);
    assert.ok(parsed);
    assert.equal(
      new TextDecoder().decode(parsed.signingInput),
      token.split(".").slice(0, 2).join("."),
    );
    assert.equal(parsed.payload.origin, "https://dapp.example");
  });

  test("parseProvisionReturn accepts only the return path with nonce, context and a P-256 JWK", () => {
    const { jwk } = keypair();
    const jwkB64 = b64url(
      JSON.stringify({ ...jwk, ext: true, key_ops: ["verify"] }),
    );
    const ok = parseProvisionReturn(
      `takumiwallet-mwa://attest/return?nonce=0011&context=ctx-9&jwk=${jwkB64}`,
    );
    assert.ok(ok);
    assert.equal(ok.nonce, "0011");
    assert.equal(ok.context, "ctx-9");
    assert.deepEqual(ok.jwk, jwk);

    assert.equal(
      parseProvisionReturn(
        "takumiwallet-mwa://attest/other?nonce=1&context=c&jwk=e30",
      ),
      null,
    );
    assert.equal(
      parseProvisionReturn(
        "takumiwallet-mwa://attest/return?context=c&jwk=e30",
      ),
      null,
    );
    assert.equal(
      parseProvisionReturn(
        "takumiwallet-mwa://attest/return?nonce=1&context=c&jwk=!!",
      ),
      null,
    );
    const rsa = b64url(JSON.stringify({ kty: "RSA", n: "x", e: "AQAB" }));
    assert.equal(
      parseProvisionReturn(
        `takumiwallet-mwa://attest/return?nonce=1&context=c&jwk=${rsa}`,
      ),
      null,
    );
    assert.equal(parseProvisionReturn("not a url"), null);
  });
});
