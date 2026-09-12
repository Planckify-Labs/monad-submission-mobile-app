/**
 * Copy rules — every reject code has copy, placeholders are substituted,
 * and no user-facing string contains an em-dash
 * (`feedback_no_emdash_in_ui_copy`).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { __ALL_COPY_STRINGS, rejectCopy } from "./copy.ts";
import type { DeepLinkRejectCode } from "./types.ts";

const CODES: DeepLinkRejectCode[] = [
  "too_large",
  "fragment_blocked",
  "malformed",
  "unsupported_scheme",
  "unsupported_chain",
  "unsupported_operation",
  "not_https",
  "signature_missing",
  "signature_invalid",
  "signing_key_changed",
  "network_mismatch",
  "wrong_account",
  "replayed",
  "signing_mode",
  "expired",
  "no_wallet_for_namespace",
  "route_not_allowed",
  "not_enabled",
  "malicious",
  "recipient_invalid",
  "insufficient_asset",
];

describe("rejectCopy", () => {
  it("has copy for every code and substitutes placeholders", () => {
    for (const code of CODES) {
      const c = rejectCopy(code, {
        domain: "shop.example",
        chain: "Stellar",
        asset: "USDC",
      });
      assert.ok(c.title.length > 0 && c.body.length > 0, code);
      assert.ok(!/\{(domain|Chain|asset)\}/.test(c.body), code);
    }
    assert.match(
      rejectCopy("signature_missing", { domain: "shop.example" }).body,
      /shop\.example/,
    );
    assert.match(
      rejectCopy("no_wallet_for_namespace", { chain: "Sui" }).title,
      /Sui/,
    );
  });
  it("never renders an em-dash or a raw placeholder", () => {
    for (const s of __ALL_COPY_STRINGS) assert.ok(!s.includes("—"), s);
    assert.ok(!rejectCopy("malformed").body.includes("{"));
  });
});
