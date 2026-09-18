/**
 * Mera passkey derivation (docs/monad-metropolis-2026-spec.md §3.2).
 *
 * Pins the two properties the "no seed phrase" claim rests on:
 *   - determinism: the same PRF output always yields the same address,
 *   - the row shape: EVM-only, `type: "Passkey"`, private key only —
 *     never a `seedPhrase` (which would trigger the multi-chain
 *     backfill in `useWallet`).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MeraError } from "@category-labs/mera";
import { privateKeyToAccount } from "viem/accounts";
import { derivePasskeyWallet, PASSKEY_RP_ID } from "./derive.ts";
import { classifyPasskeyError } from "./errors.ts";

const PRF = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
const PASSKEY = { credentialId: "Y3JlZC1pZA", rpId: PASSKEY_RP_ID };

describe("derivePasskeyWallet", () => {
  it("is deterministic for the same PRF output", () => {
    const a = derivePasskeyWallet({ prfOutput: PRF, passkey: PASSKEY });
    const b = derivePasskeyWallet({
      prfOutput: new Uint8Array(PRF),
      passkey: PASSKEY,
    });
    assert.equal(a.address, b.address);
    assert.equal(a.privateKey, b.privateKey);
  });

  it("produces an EVM-only Passkey row with a private key and no seed", () => {
    const w = derivePasskeyWallet({
      prfOutput: PRF,
      passkey: PASSKEY,
      name: "Demo",
    });
    assert.equal(w.type, "Passkey");
    assert.equal(w.namespace, "eip155");
    assert.equal(w.name, "Demo");
    assert.equal(w.seedPhrase, undefined);
    assert.match(w.privateKey ?? "", /^0x[0-9a-f]{64}$/);
    assert.deepEqual(w.passkey, PASSKEY);
    // The row's address must be the one the stored key signs for —
    // that is the contract `getAccountForWallet` relies on.
    assert.equal(
      privateKeyToAccount(w.privateKey as `0x${string}`).address,
      w.address,
    );
  });

  it("changes address when the PRF output changes", () => {
    const other = new Uint8Array(PRF);
    other[0] ^= 1;
    const a = derivePasskeyWallet({ prfOutput: PRF, passkey: PASSKEY });
    const b = derivePasskeyWallet({ prfOutput: other, passkey: PASSKEY });
    assert.notEqual(a.address, b.address);
  });

  it("rejects a PRF output that is not 32 bytes", () => {
    assert.throws(() =>
      derivePasskeyWallet({ prfOutput: new Uint8Array(31), passkey: PASSKEY }),
    );
  });
});

describe("classifyPasskeyError", () => {
  it("maps PRF_UNAVAILABLE to the unsupported-provider copy", () => {
    const c = classifyPasskeyError(new MeraError("PRF_UNAVAILABLE", "x"));
    assert.equal(c.kind, "prf-unavailable");
  });

  it("detects a cancelled ceremony through the wrapped cause", () => {
    const native = Object.assign(new Error("User cancelled the request"), {
      code: "UserCancelled",
    });
    const c = classifyPasskeyError(
      new MeraError("PASSKEY_OPERATION_FAILED", "Passkey creation failed", {
        cause: native,
      }),
    );
    assert.equal(c.kind, "cancelled");
  });

  it("never echoes the raw message", () => {
    const c = classifyPasskeyError(new Error('500 {"code":"boom"}'));
    assert.equal(c.kind, "failed");
    assert.doesNotMatch(c.message, /boom/);
  });
});
