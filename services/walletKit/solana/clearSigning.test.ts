/**
 * Unit tests for the Solana clear-signing capability — task 65
 * (TWV-2026-066) Phases B + C.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types --import ./services/walletKit/evm/_test-resolver.mjs services/walletKit/solana/clearSigning.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { zlibSync } from "fflate";

import {
  type AnchorIdl,
  computeSolanaSigningDigest,
  deriveIdlAddress,
  extractMessageBytes,
  parseIdlAccountData,
  resolveSolanaClearSigningDescriptor,
  resolveSolanaDescriptorFromIdl,
} from "./clearSigning.ts";

const PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const RECIPIENT_KEY = "11111111111111111111111111111112";

/** Build the on-chain IDL account byte layout around `idl`. */
function buildIdlAccountData(idl: AnchorIdl): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(idl));
  const compressed = zlibSync(json);
  const out = new Uint8Array(44 + compressed.length);
  // 8-byte account discriminator + 32-byte authority: arbitrary here.
  out.set([24, 70, 98, 191, 58, 144, 26, 11], 0);
  out.set(compressed.length ? compressed : [], 44);
  const len = compressed.length;
  out[40] = len & 0xff;
  out[41] = (len >> 8) & 0xff;
  out[42] = (len >> 16) & 0xff;
  out[43] = (len >> 24) & 0xff;
  return out;
}

/** sha256("global:<snake>")[0..8] — the legacy Anchor sighash. */
function sighash(snakeName: string): number[] {
  return [
    ...createHash("sha256")
      .update(`global:${snakeName}`)
      .digest()
      .subarray(0, 8),
  ];
}

const DEPOSIT_IDL: AnchorIdl = {
  metadata: { name: "vault" },
  instructions: [
    {
      name: "deposit",
      discriminator: sighash("deposit"),
      args: [
        { name: "amount", type: "u64" },
        { name: "recipient", type: "pubkey" },
      ],
    },
    { name: "withdraw", discriminator: sighash("withdraw"), args: [] },
  ],
};

function depositData(amount: bigint): Uint8Array {
  const data = new Uint8Array(8 + 8 + 32);
  data.set(sighash("deposit"), 0);
  for (let i = 0; i < 8; i++) {
    data[8 + i] = Number((amount >> BigInt(i * 8)) & 0xffn);
  }
  data.set(new PublicKey(RECIPIENT_KEY).toBytes(), 16);
  return data;
}

describe("resolveSolanaDescriptorFromIdl", () => {
  it("known-descriptor hit: discriminator match + roundtrip-verified args", () => {
    const d = resolveSolanaDescriptorFromIdl(
      DEPOSIT_IDL,
      PROGRAM_ID,
      depositData(5_000_000n),
    );
    assert.ok(d);
    assert.equal(d.intent, "Deposit");
    assert.equal(d.source, "onchain-idl");
    assert.equal(d.functionName, "deposit");
    assert.equal(d.fields[0]?.value, "vault");
    assert.equal(d.fields[1]?.label, "Amount");
    assert.equal(d.fields[1]?.value, "5000000");
    assert.equal(d.fields[2]?.value, RECIPIENT_KEY);
  });

  it("trailing bytes break the roundtrip → intent-only descriptor, no fields", () => {
    const padded = new Uint8Array([...depositData(1n), 0xff]);
    const d = resolveSolanaDescriptorFromIdl(DEPOSIT_IDL, PROGRAM_ID, padded);
    assert.ok(d);
    assert.equal(d.intent, "Deposit");
    assert.equal(d.fields.length, 0);
  });

  it("unknown discriminator → null", () => {
    const junk = new Uint8Array(16).fill(9);
    assert.equal(
      resolveSolanaDescriptorFromIdl(DEPOSIT_IDL, PROGRAM_ID, junk),
      null,
    );
  });

  it("legacy IDLs without explicit discriminators match via sighash(global:snake_case)", () => {
    const legacyIdl: AnchorIdl = {
      name: "vault",
      instructions: [
        { name: "depositTokens", args: [{ name: "amount", type: "u64" }] },
      ],
    };
    const data = new Uint8Array(16);
    data.set(sighash("deposit_tokens"), 0);
    data[8] = 42;
    const d = resolveSolanaDescriptorFromIdl(legacyIdl, PROGRAM_ID, data);
    assert.ok(d);
    assert.equal(d.functionName, "depositTokens");
    assert.equal(d.fields[1]?.value, "42");
  });
});

describe("parseIdlAccountData", () => {
  it("round-trips the on-chain account layout (discriminator ‖ authority ‖ len ‖ zlib)", () => {
    const parsed = parseIdlAccountData(buildIdlAccountData(DEPOSIT_IDL));
    assert.ok(parsed);
    assert.equal(parsed.metadata?.name, "vault");
    assert.equal(parsed.instructions?.length, 2);
  });

  it("rejects truncated / garbage account data", () => {
    assert.equal(parseIdlAccountData(new Uint8Array(10)), null);
    assert.equal(parseIdlAccountData(new Uint8Array(64).fill(7)), null);
  });
});

describe("resolveSolanaClearSigningDescriptor", () => {
  it("well-known-program leg: Stage-1 decoded instruction → bespoke descriptor", async () => {
    const d = await resolveSolanaClearSigningDescriptor(
      {
        call: {
          program: "system",
          kind: "transfer",
          data: { lamports: 1000n, to: RECIPIENT_KEY },
        },
      },
      async () => null,
    );
    assert.ok(d);
    assert.equal(d.source, "bespoke");
    assert.equal(d.intent, "Transfer");
    assert.equal(d.target, "System Program");
  });

  it("IDL leg: fetches the derived IDL address and resolves (known hit)", async () => {
    let fetchedAddress: string | null = null;
    const d = await resolveSolanaClearSigningDescriptor(
      {
        call: { programId: PROGRAM_ID, data: depositData(7n), accounts: [] },
      },
      async (address) => {
        fetchedAddress = address;
        return buildIdlAccountData(DEPOSIT_IDL);
      },
    );
    assert.equal(fetchedAddress, await deriveIdlAddress(PROGRAM_ID));
    assert.ok(d);
    assert.equal(d.source, "onchain-idl");
    assert.equal(d.target, PROGRAM_ID);
  });

  it("no IDL account → null (raw fallback), fetch errors swallowed", async () => {
    assert.equal(
      await resolveSolanaClearSigningDescriptor(
        { call: { programId: PROGRAM_ID, data: depositData(7n) } },
        async () => null,
      ),
      null,
    );
    assert.equal(
      await resolveSolanaClearSigningDescriptor(
        { call: { programId: PROGRAM_ID, data: depositData(7n) } },
        async () => {
          throw new Error("rpc down");
        },
      ),
      null,
    );
  });
});

describe("computeSolanaSigningDigest", () => {
  it("digests the message bytes (signatures stripped) with SHA-256", async () => {
    // Minimal wire tx: shortvec(1 signature) + 64 zero bytes + message.
    const message = new TextEncoder().encode("solana-message-payload");
    const wire = new Uint8Array(1 + 64 + message.length);
    wire[0] = 1;
    wire.set(message, 65);
    const b64 = Buffer.from(wire).toString("base64");

    const extracted = extractMessageBytes(b64);
    assert.ok(extracted);
    assert.deepEqual([...extracted], [...message]);

    const digest = await computeSolanaSigningDigest({
      kind: "transaction",
      transaction: b64,
    });
    const expected = `0x${createHash("sha256").update(message).digest("hex")}`;
    assert.equal(digest?.scheme, "solana-message-sha256");
    assert.equal(digest?.values[0]?.value, expected);
  });

  it("personal message digest is SHA-256 of the raw bytes", async () => {
    const msg = new TextEncoder().encode("hello solana");
    const digest = await computeSolanaSigningDigest({
      kind: "personalMessage",
      messageBase64: Buffer.from(msg).toString("base64"),
    });
    const expected = `0x${createHash("sha256").update(msg).digest("hex")}`;
    assert.equal(digest?.values[0]?.value, expected);
  });

  it("returns null for shapes the scheme defines nothing for", async () => {
    assert.equal(
      await computeSolanaSigningDigest({
        kind: "calldata",
        calldata: "0xdeadbeef",
      }),
      null,
    );
  });
});
