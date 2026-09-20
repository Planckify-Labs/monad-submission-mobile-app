import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeGasTokenPreference } from "./preference";

describe("normalizeGasTokenPreference", () => {
  it("defaults to native for missing / blank values", () => {
    assert.equal(normalizeGasTokenPreference(undefined), "native");
    assert.equal(normalizeGasTokenPreference(null), "native");
    assert.equal(normalizeGasTokenPreference("   "), "native");
    assert.equal(normalizeGasTokenPreference("Native"), "native");
  });

  it("migrates the legacy lowercase 'usdc' literal to the USDC symbol", () => {
    assert.equal(normalizeGasTokenPreference("usdc"), "USDC");
  });

  it("keeps relayer symbols exactly as tagged", () => {
    assert.equal(normalizeGasTokenPreference("USDT0"), "USDT0");
    assert.equal(normalizeGasTokenPreference(" mUSD "), "mUSD");
  });
});
