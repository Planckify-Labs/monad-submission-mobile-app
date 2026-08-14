/**
 * Tests for the scam-domain feed predicate — TWV-2026-051.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types \
 *     services/security/scamDomainFeed.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isFlaggedHost,
  SIGNATURE_PRODUCING_METHODS,
  setFlaggedHosts,
} from "./scamDomainFeed.ts";

describe("isFlaggedHost — fallback list", () => {
  it("flags a host on the embedded fallback list", () => {
    assert.equal(isFlaggedHost("https://uniswap-claim.io/promo"), true);
  });

  it("flags subdomains of a fallback host", () => {
    assert.equal(isFlaggedHost("https://drop.uniswap-claim.io/"), true);
  });

  it("does NOT flag a legitimate host", () => {
    assert.equal(isFlaggedHost("https://app.uniswap.org/"), false);
  });

  it("returns false for malformed URLs", () => {
    assert.equal(isFlaggedHost("not-a-url"), false);
    assert.equal(isFlaggedHost(""), false);
    assert.equal(isFlaggedHost("   "), false);
    assert.equal(isFlaggedHost("/just/a/path"), false);
  });

  it("flags a bare host, not just a full URL", () => {
    // Callers pass permission-store origin keys and history rows, which
    // are hosts rather than URLs. The old `new URL(host)` lookup returned
    // an empty hostname for these, so the blocklist silently missed them.
    assert.equal(isFlaggedHost("uniswap-claim.io"), true);
    assert.equal(isFlaggedHost("drop.uniswap-claim.io"), true);
  });

  it("is case-insensitive on the host", () => {
    assert.equal(isFlaggedHost("https://UNISWAP-CLAIM.IO/promo"), true);
    assert.equal(isFlaggedHost("Uniswap-Claim.io"), true);
  });

  it("does not flag a host that merely contains a flagged one", () => {
    // Suffix matching has to be label-aware: `notuniswap-claim.io` is a
    // different registrable domain, and flagging it would be a false
    // positive that trains people to tap through the interstitial.
    assert.equal(isFlaggedHost("https://notuniswap-claim.io/"), false);
    assert.equal(isFlaggedHost("https://uniswap-claim.io.evil.test/"), false);
  });
});

describe("isFlaggedHost — live feed", () => {
  it("uses live feed when present + fresh", () => {
    setFlaggedHosts(["bad.example", "very.bad.example"]);
    assert.equal(isFlaggedHost("https://bad.example/"), true);
    assert.equal(isFlaggedHost("https://sub.bad.example/"), true);
  });
});

describe("SIGNATURE_PRODUCING_METHODS", () => {
  it("includes the well-known signing methods", () => {
    assert.equal(SIGNATURE_PRODUCING_METHODS.has("personal_sign"), true);
    assert.equal(SIGNATURE_PRODUCING_METHODS.has("eth_signTypedData_v4"), true);
    assert.equal(SIGNATURE_PRODUCING_METHODS.has("eth_sendTransaction"), true);
  });

  it("does NOT include read methods", () => {
    assert.equal(SIGNATURE_PRODUCING_METHODS.has("eth_chainId"), false);
    assert.equal(SIGNATURE_PRODUCING_METHODS.has("eth_call"), false);
  });
});
