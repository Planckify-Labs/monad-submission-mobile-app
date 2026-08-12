/**
 * Unit tests for `services/chains/solana/transferService.ts`.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types services/chains/solana/transferService.test.ts
 *
 * Node-only — no react / react-native / viem imports. No network. We mock
 * `rpc.getLatestBlockhash` and `rpc.sendTransaction` with hand-rolled
 * async objects matching the shape `@solana/kit` consumes
 * (`builder(...).send()` → `Promise<TResponse>`).
 *
 * What we cover:
 *   - `getSolanaBalance` coerces to `bigint`.
 *   - `getSolanaRentExemption` coerces to `bigint`.
 *   - `buildAndSendSolTransfer`:
 *       * fee payer equals signer address,
 *       * signature map has exactly one signer keyed by that address,
 *       * signature bytes are 64 long,
 *       * the appended instruction's decoded `amount` matches `lamports`,
 *       * the returned value equals `getSignatureFromTransaction(signed)`,
 *       * the public-RPC-friendly fallback calls `sendTransaction` (not
 *         `sendAndConfirmTransactionFactory`) when `rpcSubs` is omitted.
 *
 * The `sendAndConfirm` path is intentionally not exercised here — it
 * requires a real WebSocket subscription endpoint, which is out of scope
 * for a unit test. We do, however, verify that the fallback path does
 * NOT touch `sendAndConfirmTransactionFactory` (by never providing
 * `rpcSubs`).
 */

import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { describe, it } from "node:test";

// `@solana/kit` touches `globalThis.crypto` at import time on some code
// paths (key generation, signing). Node 22's `webcrypto` is a drop-in for
// our uses here. Installed before any kit import that might need it.
if (!globalThis.crypto) {
  (globalThis as { crypto: typeof webcrypto }).crypto = webcrypto;
}

import {
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
} from "@solana/kit";
import { getTransferSolInstructionDataDecoder } from "@solana-program/system";
// We import the module under test with a `.ts` extension so the
// `--experimental-strip-types` runner can pick it up.
import {
  buildAndSendSolTransfer,
  getSolanaBalance,
  getSolanaRentExemption,
} from "./transferService.ts";

/**
 * 32 zero bytes encoded as base58 — the System Program address. We can
 * reuse it as a blockhash fixture (it's just 32 bytes under the hood) but
 * NOT as a transfer destination: Solana rejects transactions that mark a
 * program address as writable, which happens implicitly when a program
 * appears as a transfer destination. For the destination we derive a
 * fresh keypair in-test.
 */
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/**
 * Fixed blockhash fixture. The exact value doesn't matter — what matters
 * is that we feed the SAME value into the mock and compare against the
 * compiled message's `lifetimeToken`.
 */
const MOCK_BLOCKHASH = SYSTEM_PROGRAM; // base58 of 32 zero bytes
const MOCK_LAST_VALID_BLOCK_HEIGHT = 100n;

/**
 * Build a minimal `SolanaRpc`-shaped mock. We only implement the methods
 * the service actually calls (`getLatestBlockhash`, `sendTransaction`,
 * `getBalance`, `getMinimumBalanceForRentExemption`) — everything else
 * is a `throw` so we'd notice immediately if the implementation started
 * touching additional RPC surface.
 */
function createMockRpc(opts: {
  balance?: bigint | number;
  rentExemption?: bigint | number;
  onSendTransaction?: (wire: string) => void;
}) {
  let sendTransactionCalls = 0;
  return {
    calls: {
      get sendTransaction() {
        return sendTransactionCalls;
      },
    },
    rpc: {
      getBalance(_address: unknown) {
        return {
          async send() {
            return { context: { slot: 0n }, value: opts.balance ?? 0n };
          },
        };
      },
      getMinimumBalanceForRentExemption(_size: bigint) {
        return {
          async send() {
            return opts.rentExemption ?? 0n;
          },
        };
      },
      getLatestBlockhash() {
        return {
          async send() {
            return {
              context: { slot: 0n },
              value: {
                blockhash: MOCK_BLOCKHASH,
                lastValidBlockHeight: MOCK_LAST_VALID_BLOCK_HEIGHT,
              },
            };
          },
        };
      },
      sendTransaction(wire: string, _config?: unknown) {
        return {
          async send() {
            sendTransactionCalls += 1;
            opts.onSendTransaction?.(wire);
            // The real API returns a base58 `Signature`. The service
            // ignores it (returns `getSignatureFromTransaction(signed)`
            // instead), so any string is fine here.
            return "mock-rpc-returned-sig";
          },
        };
      },
    },
  };
}

describe("getSolanaBalance", () => {
  it("coerces a numeric value to bigint", async () => {
    const { rpc } = createMockRpc({ balance: 12345 });
    // `rpc` is intentionally typed-lightly in the mock; cast at the
    // boundary since we're not exercising TS generics here.
    const balance = await getSolanaBalance(rpc as never, SYSTEM_PROGRAM);
    assert.equal(typeof balance, "bigint");
    assert.equal(balance, 12345n);
  });

  it("passes through a bigint value unchanged", async () => {
    const { rpc } = createMockRpc({ balance: 987_654_321n });
    const balance = await getSolanaBalance(rpc as never, SYSTEM_PROGRAM);
    assert.equal(balance, 987_654_321n);
  });
});

describe("getSolanaRentExemption", () => {
  it("coerces a numeric rent-exemption value to bigint", async () => {
    const { rpc } = createMockRpc({ rentExemption: 890_880 });
    const rent = await getSolanaRentExemption(rpc as never, 0);
    assert.equal(typeof rent, "bigint");
    assert.equal(rent, 890_880n);
  });
});

describe("buildAndSendSolTransfer (fallback / no-subscriptions path)", () => {
  it("signs with the provided signer, emits a correct transfer instruction, and returns the local signature", async () => {
    // Real signer so `signTransactionMessageWithSigners` can actually
    // produce a valid ed25519 signature — the service doesn't know
    // about keypairs directly, but it does resolve every signer
    // referenced by the message, so we need something capable of
    // signing. `generateKeyPairSigner` uses webcrypto under the hood
    // (already polyfilled above). No `Math.random`.
    const signer = await generateKeyPairSigner();
    // Use a fresh keypair for the destination too — any 32-byte ed25519
    // public key works as a Solana address, and unlike the System
    // Program address, it can legally be a writable transfer target.
    const recipient = await generateKeyPairSigner();

    const lamports = 2_500_000n;

    let capturedWire: string | undefined;
    const { rpc, calls } = createMockRpc({
      onSendTransaction: (wire) => {
        capturedWire = wire;
      },
    });

    const sig = await buildAndSendSolTransfer({
      rpc: rpc as never,
      // Intentionally NO rpcSubs → exercises the public-RPC-friendly
      // fallback that submits via `rpc.sendTransaction(...).send()`.
      signer,
      to: recipient.address,
      lamports,
    });

    // 1. The fallback path must have hit `sendTransaction` exactly once.
    assert.equal(calls.sendTransaction, 1);
    assert.ok(
      typeof capturedWire === "string" && capturedWire.length > 0,
      "sendTransaction should receive a non-empty base64 wire payload",
    );

    // 2. The returned value is a base58 string.
    assert.equal(typeof sig, "string");
    assert.ok(sig.length > 0);

    // 3. Re-derive the signed transaction from the wire payload so we
    //    can inspect the compiled message structurally. We use a Node
    //    `Buffer` purely to decode base64 → bytes for fixture parsing;
    //    the production path never touches `Buffer`.
    const wireBytes = new Uint8Array(
      Buffer.from(capturedWire as string, "base64"),
    );

    // The wire format is: compact-u16 signature count || signatures ||
    // compiled-message. We just need the compiled-message half.
    // Signature count is a compact-u16 — for a single-signer tx it's
    // a single byte `1`, and each signature is 64 bytes.
    assert.equal(wireBytes[0], 1, "expected exactly 1 signature");
    const SIG_LEN = 64;
    const messageStart = 1 + SIG_LEN;
    const signatureBytes = wireBytes.slice(1, messageStart);
    assert.equal(
      signatureBytes.length,
      64,
      "ed25519 signature must be 64 bytes",
    );
    // The signature must not be all zeros — proves the signer actually
    // signed something.
    assert.ok(
      signatureBytes.some((b) => b !== 0),
      "signature must not be all zero bytes",
    );

    const messageBytes = wireBytes.slice(messageStart);
    const compiled =
      getCompiledTransactionMessageDecoder().decode(messageBytes);

    // 4. Fee payer is the first static account and must equal the
    //    signer's address.
    const feePayerAddress = compiled.staticAccounts[0];
    assert.equal(feePayerAddress, signer.address);

    // 5. Spec phase J — the message now carries two compute-budget
    //    instructions ahead of the transfer. Before this, every
    //    first-party send went out at the 200k default limit with no
    //    priority fee, so under congestion it could be deprioritised
    //    and never land, which surfaces to the user as a send that
    //    silently did nothing.
    assert.equal(compiled.instructions.length, 3);

    // Compute budget must come FIRST: the runtime reads these before
    // the instructions they govern.
    const budgetProgram = compiled.staticAccounts.indexOf(
      "ComputeBudget111111111111111111111111111111" as never,
    );
    assert.ok(budgetProgram >= 0, "ComputeBudget program must be referenced");
    assert.equal(compiled.instructions[0].programAddressIndex, budgetProgram);
    assert.equal(compiled.instructions[1].programAddressIndex, budgetProgram);
    // Discriminators: 2 = SetComputeUnitLimit, 3 = SetComputeUnitPrice.
    assert.equal((compiled.instructions[0].data as Uint8Array)[0], 2);
    assert.equal((compiled.instructions[1].data as Uint8Array)[0], 3);

    const instr = compiled.instructions[2];
    assert.ok(instr.data, "transfer instruction must have data bytes");

    // 6. Decode the instruction data and verify lamports round-trip.
    const decoded = getTransferSolInstructionDataDecoder().decode(
      instr.data as Uint8Array,
    );
    assert.equal(decoded.amount, lamports);

    // 7. The returned signature must equal the locally-computed one —
    //    the service explicitly does NOT trust the RPC's response
    //    ("mock-rpc-returned-sig" above) as the source of truth.
    //    Reconstruct the Transaction object from the wire and run
    //    `getSignatureFromTransaction` against it.
    const localSig = getSignatureFromTransaction({
      messageBytes: messageBytes as never,
      signatures: {
        [feePayerAddress]: signatureBytes as never,
      } as never,
    } as never);
    assert.equal(sig, localSig);
  });
});
