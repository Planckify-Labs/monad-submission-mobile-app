/**
 * Unit tests for the Sui clear-signing capability — task 65
 * (TWV-2026-066) Phases B + C.
 *
 * The digest tests cross-check against the pinned `@mysten/sui` SDK's
 * own primitives (`TransactionDataBuilder.getDigestFromBytes`,
 * `messageWithIntent`) — the same math the chain applies — rather than
 * re-deriving expectations from this module's implementation.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types --import ./services/walletKit/evm/_test-resolver.mjs services/walletKit/sui/clearSigning.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toBase58 } from "@mysten/bcs";
import { bcs } from "@mysten/sui/bcs";
import { messageWithIntent } from "@mysten/sui/cryptography";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { blake2b } from "@noble/hashes/blake2";

import {
  computeSuiSigningDigest,
  formatNormalizedType,
  resolveSuiClearSigningDescriptor,
  suiPersonalMessageDigest,
  suiTransactionDigest,
} from "./clearSigning.ts";

const MOVE_CALL = {
  kind: "MoveCall" as const,
  package: "0x2",
  module: "coin",
  function: "split_and_transfer",
  argumentCount: 3,
  typeArgumentCount: 1,
};

/** JSON-RPC shape `sui_getNormalizedMoveFunction` returns. */
const NORMALIZED_FN = {
  visibility: "Public",
  isEntry: true,
  typeParameters: [{ abilities: [] }],
  parameters: [
    {
      MutableReference: {
        Struct: {
          address: "0x2",
          module: "coin",
          name: "Coin",
          typeArguments: [{ TypeParameter: 0 }],
        },
      },
    },
    "U64",
    "Address",
    {
      MutableReference: {
        Struct: {
          address: "0x2",
          module: "tx_context",
          name: "TxContext",
          typeArguments: [],
        },
      },
    },
  ],
  return: [],
};

describe("resolveSuiClearSigningDescriptor", () => {
  it("known-descriptor hit: normalized move function → typed parameter fields", async () => {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const d = await resolveSuiClearSigningDescriptor(
      { call: MOVE_CALL },
      async (method, params) => {
        calls.push({ method, params });
        return NORMALIZED_FN;
      },
    );
    assert.equal(calls[0]?.method, "sui_getNormalizedMoveFunction");
    assert.deepEqual(calls[0]?.params, ["0x2", "coin", "split_and_transfer"]);
    assert.ok(d);
    assert.equal(d.source, "normalized-move");
    assert.equal(d.intent, "Split and transfer");
    assert.equal(d.functionName, "0x2::coin::split_and_transfer");
    // TxContext tail parameter is filtered; 3 user-facing params stay.
    assert.equal(d.fields.length, 3);
    assert.equal(d.fields[0]?.value, "&mut 0x2::coin::Coin<T0>");
    assert.equal(d.fields[1]?.value, "u64");
    assert.equal(d.fields[2]?.value, "address");
  });

  it("RPC failure → null (raw fallback, never a block)", async () => {
    const d = await resolveSuiClearSigningDescriptor(
      { call: MOVE_CALL },
      async () => {
        throw new Error("rpc down");
      },
    );
    assert.equal(d, null);
  });

  it("non-MoveCall commands → null (Stage-1 already legible)", async () => {
    const d = await resolveSuiClearSigningDescriptor(
      { call: { kind: "SplitCoins", sourceArgIndex: 0, amountCount: 1 } },
      async () => NORMALIZED_FN,
    );
    assert.equal(d, null);
  });
});

describe("formatNormalizedType", () => {
  it("formats nested vector/struct/reference shapes", () => {
    assert.equal(formatNormalizedType("Bool"), "bool");
    assert.equal(formatNormalizedType({ Vector: "U8" }), "vector<u8>");
    assert.equal(
      formatNormalizedType({
        Reference: {
          Struct: {
            address:
              "0x0000000000000000000000000000000000000000000000000000000000000002",
            module: "sui",
            name: "SUI",
            typeArguments: [],
          },
        },
      }),
      "&0x2::sui::SUI",
    );
  });
});

describe("computeSuiSigningDigest", () => {
  it("transaction digest byte-matches the SDK's getDigestFromBytes", async () => {
    // Arbitrary BCS payload — the digest formula must agree with the
    // SDK for any bytes, which is what explorers/nodes compute.
    const txBytes = Uint8Array.from({ length: 120 }, (_, i) => (i * 7) & 0xff);
    const expected = TransactionDataBuilder.getDigestFromBytes(txBytes);
    const b64 = Buffer.from(txBytes).toString("base64");
    assert.equal(suiTransactionDigest(b64), expected);

    const digest = await computeSuiSigningDigest({
      kind: "transaction",
      transaction: b64,
    });
    assert.equal(digest?.scheme, "sui-tx-digest");
    assert.equal(digest?.values[0]?.value, expected);
    assert.equal(digest?.values[0]?.encoding, "base58");
  });

  it("personal-message digest matches blake2b(messageWithIntent(PersonalMessage, bcs(vector<u8>)))", async () => {
    const message = new TextEncoder().encode("hello sui");
    const intentMessage = messageWithIntent(
      "PersonalMessage",
      bcs.vector(bcs.u8()).serialize(message).toBytes(),
    );
    const expected = toBase58(blake2b(intentMessage, { dkLen: 32 }));
    assert.equal(
      suiPersonalMessageDigest(Buffer.from(message).toString("base64")),
      expected,
    );
  });

  it("returns null for shapes the scheme defines nothing for", async () => {
    assert.equal(
      await computeSuiSigningDigest({ kind: "calldata", calldata: "0x00" }),
      null,
    );
  });
});
