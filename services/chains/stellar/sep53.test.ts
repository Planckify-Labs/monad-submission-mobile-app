/**
 * SEP-53 framing tests. Pins the exact digest construction against the
 * official SEP-53 test vector (external reference) and proves the round
 * trip our auth path relies on: a signature over `sep53Digest(message)`
 * verifies, while the pre-SEP-53 raw-UTF-8 signature does NOT — i.e. the
 * framing genuinely changes the signed bytes (domain separation).
 *
 * The server verifier (`api/src/auth/siws-stellar/sep53.ts`) is a
 * byte-for-byte mirror, so these vectors double as the interop contract.
 */

import { hash, Keypair } from "@stellar/stellar-base";
import { describe, expect, it } from "vitest";

import { SEP53_PREFIX, sep53Digest } from "./sep53.ts";

describe("sep53Digest", () => {
  it("produces a 32-byte SHA-256 digest", () => {
    expect(sep53Digest("anything").length).toBe(32);
  });

  it("applies the domain-separation prefix (differs from raw-message hash)", () => {
    expect(SEP53_PREFIX).toBe("Stellar Signed Message:\n");
    const framed = sep53Digest("Hello, World!");
    const bare = hash(Buffer.from("Hello, World!", "utf8"));
    // The prefix is part of the preimage, so the framed digest must not
    // equal a plain SHA-256 of the bare message.
    expect(Buffer.from(framed).equals(Buffer.from(bare))).toBe(false);
  });

  it("verifies the official SEP-53 ASCII test vector", () => {
    // https://stellar.org/protocol/sep-53 — account signs "Hello, World!"
    const pub = "GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L";
    const sig = Buffer.from(
      "fO5dbYhXUhBMhe6kId/cuVq/AfEnHRHEvsP8vXh03M1uLpi5e46yO2Q8rEBzu3feXQewcQE5GArp88u6ePK6BA==",
      "base64",
    );
    const kp = Keypair.fromPublicKey(pub);
    expect(kp.verify(sep53Digest("Hello, World!"), sig)).toBe(true);
  });

  it("round-trips a signature and rejects the pre-SEP-53 raw-UTF-8 form", () => {
    const kp = Keypair.random();
    const message = "takumipay.xyz wants you to sign in — 世界 nonce:abc123";

    const sep53Sig = kp.sign(sep53Digest(message));
    // Correct framing verifies.
    expect(kp.verify(sep53Digest(message), sep53Sig)).toBe(true);

    // The legacy raw-UTF-8 signature is a DIFFERENT signature: verifying it
    // against the SEP-53 digest must fail, proving the framing changed the
    // signed bytes.
    const legacySig = kp.sign(Buffer.from(message, "utf8"));
    expect(kp.verify(sep53Digest(message), legacySig)).toBe(false);
    expect(kp.verify(Buffer.from(message, "utf8"), sep53Sig)).toBe(false);
  });
});
