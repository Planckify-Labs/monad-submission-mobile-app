/**
 * Redirect rules for the Phantom-compatible transport (spec §9):
 * `redirect_link` must be a custom scheme or an https URL on the same
 * origin as `app_url`.
 */

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UL_ERRORS, ulErrorForRpc } from "./methods.ts";
import { validateRedirect } from "./redirect.ts";

describe("validateRedirect", () => {
  it("custom scheme → custom; same-origin https → https; anything else → null", () => {
    assert.equal(
      validateRedirect("mydapp://onconnect", "https://dapp.example"),
      "custom",
    );
    assert.equal(
      validateRedirect("https://dapp.example/return", "https://dapp.example"),
      "https",
    );
    assert.equal(
      validateRedirect("https://evil.example/return", "https://dapp.example"),
      null,
    );
    assert.equal(
      validateRedirect("http://dapp.example/return", "https://dapp.example"),
      null,
    );
  });
});

describe("Phantom error codes", () => {
  it("maps JSON-RPC codes onto Phantom's verbatim codes", () => {
    assert.equal(ulErrorForRpc(4001), UL_ERRORS.userRejected);
    assert.equal(ulErrorForRpc(4100), UL_ERRORS.unauthorized);
    assert.equal(ulErrorForRpc(-32002), UL_ERRORS.resourceUnavailable);
    assert.equal(ulErrorForRpc(-32601), UL_ERRORS.methodNotFound);
    assert.equal(ulErrorForRpc(1234), UL_ERRORS.internal);
  });
});
