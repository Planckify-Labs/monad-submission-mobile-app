/**
 * Unit tests for the Stellar clear-signing capability — task 65
 * (TWV-2026-066) Phases B + C.
 *
 * The Soroban leg builds a synthetic WASM binary whose
 * `contractspecv0` custom section carries real `ScSpecEntry` XDR
 * frames (built with stellar-base itself), so the parser is exercised
 * against genuine spec bytes. The tx-hash leg cross-checks
 * `tx.hash()` against an independent `node:crypto` SHA-256 of the
 * signature-base preimage.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types --import ./services/walletKit/evm/_test-resolver.mjs services/walletKit/stellar/clearSigning.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-base";

import {
  computeStellarSigningDigest,
  extractWasmCustomSection,
  formatScSpecType,
  resolveStellarClearSigningDescriptor,
  resolveStellarDescriptorFromWasm,
  stellarTransactionHash,
} from "./clearSigning.ts";

// Well-formed testnet contract ID (StrKey "C..." — any 32-byte value).
const CONTRACT_ID = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";

/** ULEB128 encode (for the synthetic WASM section framing). */
function uleb(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return out;
}

/** Wraps `payload` in a minimal WASM binary as custom section `name`. */
function buildWasmWithCustomSection(
  name: string,
  payload: Uint8Array,
): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const body = [...uleb(nameBytes.length), ...nameBytes, ...payload];
  return Uint8Array.from([
    0x00,
    0x61,
    0x73,
    0x6d, // \0asm
    0x01,
    0x00,
    0x00,
    0x00, // version 1
    0x00, // custom section id
    ...uleb(body.length),
    ...body,
  ]);
}

function buildSpecSection(): Uint8Array {
  const depositFn = new xdr.ScSpecFunctionV0({
    doc: "",
    name: "deposit",
    inputs: [
      new xdr.ScSpecFunctionInputV0({
        doc: "",
        name: "from",
        type: xdr.ScSpecTypeDef.scSpecTypeAddress(),
      }),
      new xdr.ScSpecFunctionInputV0({
        doc: "",
        name: "amount",
        type: xdr.ScSpecTypeDef.scSpecTypeI128(),
      }),
    ],
    outputs: [],
  });
  const otherFn = new xdr.ScSpecFunctionV0({
    doc: "",
    name: "withdraw",
    inputs: [],
    outputs: [],
  });
  const e1 = xdr.ScSpecEntry.scSpecEntryFunctionV0(depositFn).toXDR();
  const e2 = xdr.ScSpecEntry.scSpecEntryFunctionV0(otherFn).toXDR();
  const out = new Uint8Array(e1.length + e2.length);
  out.set(new Uint8Array(e1), 0);
  out.set(new Uint8Array(e2), e1.length);
  return out;
}

function depositArgsXdr(): string[] {
  const fromVal = new Address(Keypair.random().publicKey()).toScVal();
  const amountVal = xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: new xdr.Int64(0),
      lo: new xdr.Uint64(5_000_000n),
    }),
  );
  return [fromVal.toXDR("base64"), amountVal.toXDR("base64")];
}

const SPEC_WASM = buildWasmWithCustomSection(
  "contractspecv0",
  buildSpecSection(),
);

describe("extractWasmCustomSection", () => {
  it("finds the contractspecv0 section and skips others", () => {
    const section = extractWasmCustomSection(SPEC_WASM, "contractspecv0");
    assert.ok(section);
    assert.deepEqual([...section], [...buildSpecSection()]);
    assert.equal(extractWasmCustomSection(SPEC_WASM, "nope"), null);
  });

  it("rejects non-WASM bytes", () => {
    assert.equal(
      extractWasmCustomSection(new Uint8Array([1, 2, 3, 4]), "x"),
      null,
    );
  });
});

describe("resolveStellarDescriptorFromWasm", () => {
  it("known-descriptor hit: spec function match + typed, labelled args", () => {
    const argsXdr = depositArgsXdr();
    const d = resolveStellarDescriptorFromWasm(SPEC_WASM, {
      kind: "invokeHostFunction",
      contractId: CONTRACT_ID,
      function: "deposit",
      argsXdr,
    });
    assert.ok(d);
    assert.equal(d.intent, "Deposit");
    assert.equal(d.source, "soroban-spec");
    assert.equal(d.target, CONTRACT_ID);
    assert.equal(d.fields.length, 2);
    assert.equal(d.fields[0]?.label, "From (address)");
    assert.equal(d.fields[1]?.label, "Amount (i128)");
    assert.equal(d.fields[1]?.value, "5000000");
  });

  it("arg-count mismatch → intent-only descriptor (no mislabelled values)", () => {
    const d = resolveStellarDescriptorFromWasm(SPEC_WASM, {
      kind: "invokeHostFunction",
      contractId: CONTRACT_ID,
      function: "deposit",
      argsXdr: [], // spec says 2
    });
    assert.ok(d);
    assert.equal(d.fields.length, 0);
  });

  it("unknown function → null", () => {
    const d = resolveStellarDescriptorFromWasm(SPEC_WASM, {
      kind: "invokeHostFunction",
      contractId: CONTRACT_ID,
      function: "not_there",
      argsXdr: [],
    });
    assert.equal(d, null);
  });
});

describe("resolveStellarClearSigningDescriptor", () => {
  it("resolves through the wasm fetch seam", async () => {
    let fetched: string | null = null;
    const d = await resolveStellarClearSigningDescriptor(
      {
        call: {
          kind: "invokeHostFunction",
          contractId: CONTRACT_ID,
          function: "withdraw",
          argsXdr: [],
        },
      },
      async (contractId) => {
        fetched = contractId;
        return SPEC_WASM;
      },
    );
    assert.equal(fetched, CONTRACT_ID);
    assert.ok(d);
    assert.equal(d.intent, "Withdraw");
  });

  it("classic (non-Soroban) operations → null; fetch failures swallowed", async () => {
    assert.equal(
      await resolveStellarClearSigningDescriptor(
        {
          call: {
            kind: "payment",
            destination: "G...",
            asset: "native",
            amount: "1",
          },
        },
        async () => SPEC_WASM,
      ),
      null,
    );
    assert.equal(
      await resolveStellarClearSigningDescriptor(
        {
          call: {
            kind: "invokeHostFunction",
            contractId: CONTRACT_ID,
            function: "withdraw",
          },
        },
        async () => {
          throw new Error("rpc down");
        },
      ),
      null,
    );
  });
});

describe("formatScSpecType", () => {
  it("formats compound types", () => {
    assert.equal(
      formatScSpecType(
        xdr.ScSpecTypeDef.scSpecTypeVec(
          new xdr.ScSpecTypeVec({
            elementType: xdr.ScSpecTypeDef.scSpecTypeU32(),
          }),
        ),
      ),
      "vec<u32>",
    );
    assert.equal(
      formatScSpecType(xdr.ScSpecTypeDef.scSpecTypeAddress()),
      "address",
    );
  });
});

describe("computeStellarSigningDigest", () => {
  it("tx hash equals SHA-256 of the signature-base preimage (independent check)", async () => {
    const kp = Keypair.random();
    const account = new Account(kp.publicKey(), "1");
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: kp.publicKey(),
          asset: Asset.native(),
          amount: "1",
        }),
      )
      .setTimeout(180)
      .build();
    const envelope = tx.toEnvelope().toXDR("base64");
    const expected = `0x${createHash("sha256")
      .update(tx.signatureBase())
      .digest("hex")}`;

    assert.equal(stellarTransactionHash(envelope, Networks.TESTNET), expected);

    const digest = await computeStellarSigningDigest({
      kind: "transaction",
      transaction: envelope,
      networkPassphrase: Networks.TESTNET,
    });
    assert.equal(digest?.scheme, "stellar-tx-hash");
    assert.equal(digest?.values[0]?.value, expected);
  });

  it("returns null without a passphrase or for message signing (no SEP-defined digest)", async () => {
    assert.equal(
      await computeStellarSigningDigest({
        kind: "transaction",
        transaction: "AAAA",
      }),
      null,
    );
    assert.equal(
      await computeStellarSigningDigest({
        kind: "personalMessage",
        messageBase64: "aGVsbG8=",
      }),
      null,
    );
  });
});
