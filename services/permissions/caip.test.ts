/**
 * Unit tests for CAIP / origin normalization helpers.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types services/permissions/caip.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { caip2, caip10, hashOrigin, originHost, originKey } from "./caip.ts";

describe("originKey", () => {
  it("lowercases host, preserves protocol", () => {
    assert.equal(originKey("https://Foo.Xyz/a/b"), "https://foo.xyz");
  });
  it("strips trailing dot from host", () => {
    assert.equal(originKey("https://foo.xyz./path"), "https://foo.xyz");
  });
  it("preserves non-default port", () => {
    assert.equal(originKey("http://localhost:3000/"), "http://localhost:3000");
  });
  it("treats http and https as distinct origins", () => {
    assert.notEqual(originKey("http://foo.xyz"), originKey("https://foo.xyz"));
  });
  it("falls back to lowercased input on invalid URL", () => {
    assert.equal(originKey("not a url"), "not a url");
  });
});

describe("originHost", () => {
  it("returns lowercased hostname only", () => {
    assert.equal(originHost("https://Foo.Xyz:8080/bar"), "foo.xyz");
  });
});

describe("hashOrigin", () => {
  it("is deterministic — same input yields same hash", () => {
    assert.equal(hashOrigin("https://foo.xyz"), hashOrigin("https://foo.xyz"));
  });
  it("differs by case-distinct path (via url normalization)", () => {
    // case-in-hostname → normalized to same key → same hash
    assert.equal(hashOrigin("https://FOO.XYZ"), hashOrigin("https://foo.xyz"));
  });
  it("differs across distinct origins", () => {
    assert.notEqual(
      hashOrigin("https://foo.xyz"),
      hashOrigin("https://bar.xyz"),
    );
  });
});

describe("caip2 / caip10", () => {
  it("caip2 concatenates namespace and reference with a colon", () => {
    assert.equal(caip2("eip155", 1), "eip155:1");
    assert.equal(caip2("solana", "mainnet-beta"), "solana:mainnet-beta");
  });
  it("caip10 adds address", () => {
    assert.equal(caip10("eip155", 1, "0xabc"), "eip155:1:0xabc");
  });
});

describe("originKey — transport-prefixed keys (deep-link spec §4.9)", () => {
  it("returns WalletConnect / MWA / ul / sep7 keys verbatim", () => {
    for (const k of [
      "wc+https://abc123.app.uniswap.org",
      "wc+unverified://abc123",
      "mwa+https://dapp.example#com.example.dapp",
      "mwa+unverified://deadbeef",
      "ul+unverified://Gspcn…",
      "sep7+https://shop.example",
    ]) {
      assert.equal(originKey(k), k);
    }
  });
  it("never collides a transport key with the page origin it names", () => {
    assert.notEqual(
      originKey("wc+https://abc.app.uniswap.org"),
      originKey("https://app.uniswap.org"),
    );
  });
  it("gives non-http schemes a real host (RN URL shim regression)", () => {
    assert.equal(originKey("link://solana-pay"), "link://solana-pay");
    assert.equal(originHost("link://solana-pay"), "solana-pay");
  });
});
