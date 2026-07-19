/**
 * Tests for `walletAddressStellarDetector` — see
 * `docs/stellar-chain-support-spec.md` §1.2 / §3.2.
 *
 * Run from the mobile-app root with:
 *
 *     node --test --experimental-strip-types \
 *          services/paymentIntent/detectors/walletAddress.stellar.test.ts
 *
 * Mirrors `walletAddress.test.ts` / `walletAddress.sui.test.ts`. The
 * detector delegates checksum validation to `isValidStellarAddress`, so
 * the negative cases here cover shape-valid-but-checksum-invalid input in
 * addition to the obvious garbage.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { __resetForTest } from "../detectorRegistry.ts";
import { walletAddressStellarDetector } from "./walletAddress.stellar.ts";

// Real StrKey G… ed25519 public key (valid CRC16 checksum).
const VALID_G = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

describe("walletAddressStellarDetector", () => {
  beforeEach(() => {
    __resetForTest();
  });

  it("detects a valid Stellar G… address", () => {
    const hit = walletAddressStellarDetector.detect(VALID_G);
    assert.deepEqual(hit, {
      source: "qr",
      channel: {
        kind: "wallet",
        namespace: "stellar",
        address: VALID_G,
        target: undefined,
      },
      rawScan: VALID_G,
    });
  });

  it("handles leading/trailing whitespace on a valid address", () => {
    const hit = walletAddressStellarDetector.detect(`  ${VALID_G}\n`);
    assert.ok(hit);
    if (hit?.channel.kind === "wallet") {
      assert.equal(hit.channel.namespace, "stellar");
      assert.equal(hit.channel.address, VALID_G);
      assert.equal(hit.channel.target, undefined);
    }
  });

  it("rejects a G… string that fails the StrKey checksum", () => {
    // Same length + alphabet, last chars mangled → checksum mismatch.
    const bad = `${VALID_G.slice(0, -4)}AAAA`;
    assert.equal(walletAddressStellarDetector.detect(bad), null);
  });

  it("rejects a truncated G… string", () => {
    assert.equal(
      walletAddressStellarDetector.detect(VALID_G.slice(0, 40)),
      null,
    );
  });

  it("does not match EVM / Solana / Sui shapes", () => {
    assert.equal(
      walletAddressStellarDetector.detect(
        "0xabcdef0123456789abcdef0123456789abcdef01",
      ),
      null,
    );
    assert.equal(
      walletAddressStellarDetector.detect(
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      ),
      null,
    );
  });

  it("rejects empty and whitespace-only input", () => {
    assert.equal(walletAddressStellarDetector.detect(""), null);
    assert.equal(walletAddressStellarDetector.detect("   "), null);
  });

  it("declares priority 50 (peer to the other bare-address detectors)", () => {
    assert.equal(walletAddressStellarDetector.priority, 50);
    assert.equal(walletAddressStellarDetector.name, "walletAddressStellar");
  });
});
