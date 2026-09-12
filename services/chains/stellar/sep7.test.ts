/**
 * SEP-0007 — signature verification against the SEP's worked example
 * (private key `SBPOVR…`, signature `tbsLtlK…`), tamper → invalid,
 * missing signature with origin_domain → signature_missing, `replace`
 * balanced/unbalanced, network passphrase mapping, chain depth 8.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair } from "@stellar/stellar-base";

import { splitUri } from "@/services/deeplinks/uri";
import { bytesToBase64 } from "./base64.ts";
import {
  chainDepth,
  parseReplace,
  parseSep7,
  parseUriRequestSigningKey,
  sep7SigningPayload,
  stripSignature,
  verifySep7Signature,
} from "./sep7.ts";

const SECRET = "SBPOVRVKTTV7W3IOX2FJPSMPCJ5L2WU2YKTP3HCLYPXNI5MDIGREVNYC";
const UNSIGNED =
  "web+stellar:pay?destination=GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO&amount=120.1234567&memo=skdjfasf&memo_type=MEMO_TEXT&msg=pay%20me%20with%20lumens&origin_domain=someDomain.com";
const SIG_ENC =
  "tbsLtlK%2FfouvRWk2UWFP47yHYeI1g1NEC%2FfEQvuXG6V8P%2BbeLxplYbOVtTk1g94Wp97cHZ3pVJy%2FtZNYobl3Cw%3D%3D";
const SIGNED = `${UNSIGNED}&signature=${SIG_ENC}`;

function parse(raw: string) {
  const s = splitUri(raw);
  assert.ok(s);
  return parseSep7(s.ssp, s.query, s.rawQuery);
}

describe("SEP-0007 request signing", () => {
  const kp = Keypair.fromSecret(SECRET);
  it("verifies the SEP's worked example signature", () => {
    assert.equal(verifySep7Signature(SIGNED, SIG_ENC, kp.publicKey()), "ok");
  });
  it("re-signing the payload with the SEP's key reproduces the example", () => {
    const payload = sep7SigningPayload(UNSIGNED);
    const sig = kp.sign(Buffer.from(payload));
    assert.equal(
      bytesToBase64(new Uint8Array(sig)),
      decodeURIComponent(SIG_ENC),
    );
  });
  it("one tampered byte → signature_invalid", () => {
    const tampered = SIGNED.replace("amount=120.1234567", "amount=121.1234567");
    assert.equal(
      verifySep7Signature(tampered, SIG_ENC, kp.publicKey()),
      "signature_invalid",
    );
  });
  it("wrong key → signature_invalid; garbage → malformed", () => {
    assert.equal(
      verifySep7Signature(SIGNED, SIG_ENC, Keypair.random().publicKey()),
      "signature_invalid",
    );
    assert.equal(
      verifySep7Signature(SIGNED, "%%%", kp.publicKey()),
      "malformed",
    );
    assert.equal(
      verifySep7Signature(UNSIGNED, SIG_ENC, kp.publicKey()),
      "malformed",
    );
  });
  it("stripSignature removes only a trailing signature", () => {
    assert.equal(stripSignature(SIGNED), UNSIGNED);
    assert.equal(stripSignature(`${SIGNED}&msg=late`), null);
  });
  it("parses URI_REQUEST_SIGNING_KEY from a stellar.toml", () => {
    const pub = kp.publicKey();
    assert.equal(
      parseUriRequestSigningKey(
        `VERSION="2.0.0"\nURI_REQUEST_SIGNING_KEY="${pub}"\n[DOCUMENTATION]\nORG_NAME="x"`,
      ),
      pub,
    );
    assert.equal(
      parseUriRequestSigningKey(
        `[DOCUMENTATION]\nURI_REQUEST_SIGNING_KEY="${pub}"`,
      ),
      null,
    );
    assert.equal(
      parseUriRequestSigningKey(`URI_REQUEST_SIGNING_KEY="GNOTAKEY"`),
      null,
    );
  });
});

describe("parseSep7", () => {
  it("origin_domain without signature → signature_missing with the domain", () => {
    assert.deepEqual(parse(UNSIGNED), {
      ok: false,
      code: "signature_missing",
      domain: "somedomain.com",
    });
  });
  it("signed pay request parses with the raw signature param preserved", () => {
    const r = parse(SIGNED);
    assert.ok(r.ok);
    if (r.ok && r.request.op === "pay") {
      assert.equal(r.request.originDomain, "somedomain.com");
      assert.equal(r.request.signature, SIG_ENC);
      assert.equal(r.request.amount, "120.1234567");
      assert.equal(r.request.memoType, "MEMO_TEXT");
      assert.equal(r.request.msg, "pay me with lumens");
    }
  });
  it("unsigned request without origin_domain is allowed (extra confirmation on screen)", () => {
    const r = parse(
      "web+stellar:pay?destination=GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO&amount=1",
    );
    assert.ok(r.ok && r.request.originDomain === undefined);
  });
  it("non-FQDN origin_domain → malformed", () => {
    assert.equal(
      parse(
        "web+stellar:pay?destination=GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO&origin_domain=localhost&signature=x",
      ).ok,
      false,
    );
    assert.equal(
      parse(
        "web+stellar:pay?destination=GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO&origin_domain=xn--e1afmkfd.xn--p1ai&signature=x",
      ).ok,
      true,
    );
  });
  it("tx example 1 parses callback / pubkey / msg", () => {
    const r = parse(
      "web+stellar:tx?xdr=AAAAAP%2Byw%2BZEuNg533pUmwlYxfrq6%2FBoMJqiJ8vuQhf6rHWmAAAAZAB8NHAAAAABAAAAAAAAAAAAAAABAAAAAAAAAAYAAAABSFVHAAAAAABAH0wIyY3BJBS2qHdRPAV80M8hF7NBpxRjXyjuT9kEbH%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FAAAAAAAAAAA%3D&callback=url%3Ahttps%3A%2F%2FsomeSigningService.com%2Fa8f7asdfkjha&pubkey=GAU2ZSYYEYO5S5ZQSMMUENJ2TANY4FPXYGGIMU6GMGKTNVDG5QYFW6JS&msg=order%20number%2024",
    );
    assert.ok(r.ok);
    if (r.ok && r.request.op === "tx") {
      assert.equal(
        r.request.callbackUrl,
        "https://someSigningService.com/a8f7asdfkjha",
      );
      assert.equal(
        r.request.pubkey,
        "GAU2ZSYYEYO5S5ZQSMMUENJ2TANY4FPXYGGIMU6GMGKTNVDG5QYFW6JS",
      );
      assert.equal(r.request.msg, "order number 24");
    }
  });
  it("tx example 2 parses a balanced replace; unbalanced is malformed", () => {
    const r = parse(
      "web+stellar:tx?xdr=AAAA&replace=sourceAccount%3AX%3BX%3Aaccount%20on%20which%20to%20create%20the%20trustline",
    );
    assert.ok(r.ok);
    if (r.ok && r.request.op === "tx") {
      assert.deepEqual(r.request.replace?.fields, [
        { field: "sourceAccount", ref: "X" },
      ]);
      assert.equal(
        r.request.replace?.hints.X,
        "account on which to create the trustline",
      );
    }
    assert.equal(
      parse(
        "web+stellar:tx?xdr=AAAA&replace=sourceAccount%3AX%3BY%3AThe%20account",
      ).ok,
      false,
    );
    assert.equal(parseReplace("sourceAccount:X;Y:The account"), null);
    assert.ok(
      parseReplace(
        "sourceAccount:X,operations[0].sourceAccount:Y;X:fees,Y:trustline",
      ),
    );
  });
  it("replace of an unsupported field → unsupported_operation", () => {
    const r = parse(
      "web+stellar:tx?xdr=AAAA&replace=operations%5B1%5D.destination%3AY%3BY%3Adest",
    );
    assert.equal(r.ok, false);
    assert.equal((r as { code: string }).code, "unsupported_operation");
  });
  it("callback must be url: + https; msg is capped at 300", () => {
    assert.equal(
      parse("web+stellar:tx?xdr=AAAA&callback=url%3Ahttp%3A%2F%2Fx.y").ok,
      false,
    );
    assert.equal(
      parse("web+stellar:tx?xdr=AAAA&callback=mailto%3Aa%40b").ok,
      false,
    );
    const r = parse(`web+stellar:tx?xdr=AAAA&msg=${"m".repeat(400)}`);
    assert.ok(r.ok && r.request.msg?.length === 300);
  });
  it("chain depth > 7 → malformed", () => {
    let inner = "web+stellar:tx?xdr=AAAA";
    for (let i = 0; i < 8; i++)
      inner = `web+stellar:tx?xdr=AAAA&chain=${encodeURIComponent(inner)}`;
    const s = splitUri(inner);
    assert.ok(s);
    assert.ok(chainDepth(s.rawQuery) > 7);
    assert.deepEqual(parseSep7(s.ssp, s.query, s.rawQuery), {
      ok: false,
      code: "malformed",
    });
  });
  it("pay: muxed / federated destinations are unsupported, asset needs code + issuer", () => {
    assert.equal(
      (
        parse("web+stellar:pay?destination=alice*example.com") as {
          code: string;
        }
      ).code,
      "unsupported_operation",
    );
    assert.equal(
      parse(
        "web+stellar:pay?destination=GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO&asset_code=USD",
      ).ok,
      false,
    );
    assert.equal(
      parse(
        "web+stellar:pay?destination=GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO&amount=1.12345678",
      ).ok,
      false,
    );
  });
});
