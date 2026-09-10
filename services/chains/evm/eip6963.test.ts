/**
 * Tests for EIP-6963 identity invariants — TWV-2026-031.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types \
 *     services/chains/evm/eip6963.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const src = readFileSync(new URL("./eip6963.ts", import.meta.url), "utf-8");

describe("eip6963 — UUID v4 generation (TWV-2026-031)", () => {
  it("uses crypto.getRandomValues, not Math.random()", () => {
    assert.match(src, /globalThis\.crypto\.getRandomValues/);
    // The Math.random() call site must be gone (comments referencing
    // the deprecated pattern are fine).
    assert.doesNotMatch(src, /Math\.random\(/);
  });

  it("sets version-4 + variant-10 nibbles correctly", () => {
    assert.match(src, /buf\[6\]\s*=\s*\(buf\[6\]\s*&\s*0x0f\)\s*\|\s*0x40/);
    assert.match(src, /buf\[8\]\s*=\s*\(buf\[8\]\s*&\s*0x3f\)\s*\|\s*0x80/);
  });
});

describe("eip6963 — rdns invariant", () => {
  it("pins our rdns to com.planckify.takumiwallet (matches the bundle ID)", () => {
    assert.match(src, /OUR_RDNS\s*=\s*"com\.planckify\.takumiwallet"/);
  });

  it("exports an assertion helper", () => {
    assert.match(src, /export function assertOurRdns/);
  });
});
