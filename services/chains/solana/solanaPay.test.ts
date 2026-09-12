/**
 * Solana Pay — amount decimal rules (`0` ok, `.5` / `1e9` / 10 decimals
 * rejected), `reference` length, transaction-request detection, and the
 * untrusted-transaction validation matrix (empty vs present signatures;
 * foreign signer → malicious). Spec §14.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";

import { splitUri } from "@/services/deeplinks/uri";
import {
  amountToBaseUnits,
  type DecodedTx,
  parseSolanaPay,
  parseTxRequestMetadata,
  validateAmount,
  validateTxRequest,
} from "./solanaPay.ts";

const RECIPIENT = "mvines9iiHiQTysrwkJjGsqPkCPmEvyxAFdU1BkNK4E";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const REF = "82ZJ7nbGpixjeDCmEhUcmwXYfvurzAgGdtSMuHnUgyny";

function parse(raw: string) {
  const s = splitUri(raw);
  assert.ok(s);
  return parseSolanaPay(s.ssp, s.query, s.rawQuery);
}

describe("Solana Pay amount rules", () => {
  it("accepts 0, integers and up to 9 decimals for SOL", () => {
    assert.equal(validateAmount("0", 9), "ok");
    assert.equal(validateAmount("1", 9), "ok");
    assert.equal(validateAmount("0.000000001", 9), "ok");
  });
  it("rejects missing leading 0, exponents and too many decimals", () => {
    assert.equal(validateAmount(".5", 9), "malformed");
    assert.equal(validateAmount("1e9", 9), "malformed");
    assert.equal(validateAmount("0.0000000001", 9), "malformed");
    assert.equal(validateAmount("-1", 9), "malformed");
  });
  it("converts human units to base units", () => {
    assert.equal(amountToBaseUnits("1.5", 9), 1500000000n);
    assert.equal(amountToBaseUnits("0.000001", 6), 1n);
    assert.equal(amountToBaseUnits("7", 0), 7n);
  });
});

describe("parseSolanaPay — transfer", () => {
  it("parses the spec example with label/message/memo", () => {
    const r = parse(
      `solana:${RECIPIENT}?amount=1&label=Michael&message=Thanks%20for%20all%20the%20fish&memo=OrderId12345`,
    );
    assert.equal(r.kind, "transfer");
    if (r.kind === "transfer") {
      assert.equal(r.recipient, RECIPIENT);
      assert.equal(r.amount, "1");
      assert.equal(r.label, "Michael");
      assert.equal(r.message, "Thanks for all the fish");
      assert.equal(r.memo, "OrderId12345");
      assert.equal(r.cluster, "mainnet-beta");
    }
  });
  it("parses spl-token + repeated reference in order", () => {
    const r = parse(
      `solana:${RECIPIENT}?amount=0.01&spl-token=${MINT}&reference=${REF}&reference=${RECIPIENT}`,
    );
    assert.equal(r.kind, "transfer");
    if (r.kind === "transfer") {
      assert.equal(r.splToken, MINT);
      assert.deepEqual(r.references, [REF, RECIPIENT]);
    }
  });
  it("missing amount is allowed (wallet prompts)", () => {
    const r = parse(`solana:${RECIPIENT}?label=Donate`);
    assert.ok(r.kind === "transfer" && r.amount === undefined);
  });
  it("rejects bad recipient, bad reference, bad amount, oversized memo", () => {
    assert.equal(parse("solana:notbase58!!").kind, "reject");
    assert.equal(parse(`solana:${RECIPIENT}?reference=short`).kind, "reject");
    assert.equal(parse(`solana:${RECIPIENT}?amount=1e3`).kind, "reject");
    assert.equal(
      parse(`solana:${RECIPIENT}?amount=1.0000000001`).kind,
      "reject",
    );
    assert.equal(
      parse(`solana:${RECIPIENT}?memo=${"m".repeat(600)}`).kind,
      "reject",
    );
  });
  it("accepts the cluster extension", () => {
    const r = parse(`solana:${RECIPIENT}?cluster=devnet`);
    assert.ok(r.kind === "transfer" && r.cluster === "devnet");
  });
});

describe("parseSolanaPay — transaction request", () => {
  it("detects an encoded and an unencoded https link", () => {
    const a = parse(
      "solana:https%3A%2F%2Fexample.com%2Fsolana-pay%3Forder%3D12345",
    );
    assert.equal(a.kind, "transaction-request");
    if (a.kind === "transaction-request") {
      assert.equal(a.link, "https://example.com/solana-pay?order=12345");
      assert.equal(a.host, "example.com");
    }
    const b = parse("solana:https://example.com/solana-pay?order=12345");
    assert.ok(
      b.kind === "transaction-request" &&
        b.link === "https://example.com/solana-pay?order=12345",
    );
  });
  it("rejects http links", () => {
    assert.deepEqual(parse("solana:http%3A%2F%2Fexample.com%2Fpay"), {
      kind: "reject",
      code: "not_https",
    });
  });
  it("validates GET metadata: icon must be svg/png/webp", () => {
    assert.deepEqual(
      parseTxRequestMetadata(
        '{"label":"Shop","icon":"https://x.y/i.png"}',
        null,
      ),
      { label: "Shop", icon: "https://x.y/i.png" },
    );
    assert.deepEqual(
      parseTxRequestMetadata(
        '{"label":"Shop","icon":"https://x.y/i.gif"}',
        null,
      ),
      { reject: "malformed" },
    );
    assert.equal(parseTxRequestMetadata("not json", null), null);
  });
});

describe("validateTxRequest", () => {
  const account = ed25519.utils.randomPrivateKey();
  const accountPub = bs58.encode(ed25519.getPublicKey(account));
  const other = ed25519.utils.randomPrivateKey();
  const otherPub = bs58.encode(ed25519.getPublicKey(other));
  const message = new TextEncoder().encode("message-bytes");
  const zero = new Uint8Array(64);
  const tx = (over: Partial<DecodedTx>): DecodedTx => ({
    bytes: new Uint8Array(100),
    messageBytes: message,
    signatures: [zero],
    requiredSigners: [accountPub],
    version: "legacy",
    ...over,
  });

  it("empty signatures → wallet sets fee payer + blockhash", () => {
    assert.deepEqual(validateTxRequest(tx({}), accountPub), {
      ok: true,
      needsFeePayerAndBlockhash: true,
    });
    // Fee payer slot is overwritten, so a foreign fee payer is fine…
    assert.equal(
      validateTxRequest(
        tx({ requiredSigners: [otherPub], signatures: [zero] }),
        accountPub,
      ).ok,
      true,
    );
    // …but a foreign signer in any other slot is malicious.
    assert.deepEqual(
      validateTxRequest(
        tx({
          requiredSigners: [accountPub, otherPub],
          signatures: [zero, zero],
        }),
        accountPub,
      ),
      {
        ok: false,
        code: "malicious",
      },
    );
  });
  it("present signatures are verified; invalid → malformed", () => {
    const good = ed25519.sign(message, other);
    const ok = validateTxRequest(
      tx({ requiredSigners: [otherPub, accountPub], signatures: [good, zero] }),
      accountPub,
    );
    assert.deepEqual(ok, { ok: true, needsFeePayerAndBlockhash: false });
    const bad = new Uint8Array(good);
    bad[0] ^= 1;
    assert.deepEqual(
      validateTxRequest(
        tx({
          requiredSigners: [otherPub, accountPub],
          signatures: [bad, zero],
        }),
        accountPub,
      ),
      {
        ok: false,
        code: "malformed",
      },
    );
  });
  it("an unsigned foreign signer next to a signed one → malicious; nothing for us → wrong_account", () => {
    const good = ed25519.sign(message, other);
    const third = bs58.encode(
      ed25519.getPublicKey(ed25519.utils.randomPrivateKey()),
    );
    assert.deepEqual(
      validateTxRequest(
        tx({ requiredSigners: [otherPub, third], signatures: [good, zero] }),
        accountPub,
      ),
      {
        ok: false,
        code: "malicious",
      },
    );
    assert.deepEqual(
      validateTxRequest(
        tx({ requiredSigners: [otherPub], signatures: [good] }),
        accountPub,
      ),
      {
        ok: false,
        code: "wrong_account",
      },
    );
  });
  it("oversized transaction → malformed", () => {
    assert.deepEqual(
      validateTxRequest(tx({ bytes: new Uint8Array(1233) }), accountPub),
      { ok: false, code: "malformed" },
    );
  });
});
