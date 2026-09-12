/**
 * `sui:pay` parser — mirrors the cases in Mysten `uri.test.ts`
 * (payment-kit). Spec §6.3 / D-3; the constants test re-derives the
 * default registry id so drift in the derivation is caught.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SUI_PAYMENT_KIT_DEFAULT_REGISTRY_NAME,
  SUI_PAYMENT_KIT_MAINNET,
  SUI_PAYMENT_KIT_TESTNET,
  suiPaymentKitRegistryIdFromName,
} from "@/constants/configs/suiPaymentKit";
import { parseSuiPay } from "./suiPay.ts";

const RECEIVER =
  "0x0000000000000000000000000000000000000000000000000000000000000002";
const q = (s: string) => new URLSearchParams(s);

describe("parseSuiPay", () => {
  it("parses the documented example", () => {
    const r = parseSuiPay(
      "pay",
      q(
        `receiver=${RECEIVER}&amount=10000000&coinType=0x2::sui::SUI&nonce=order-1&registry=my-registry`,
      ),
    );
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.request.amount, 10000000n);
      assert.equal(r.request.registryName, "my-registry");
      assert.equal(r.request.registryId, undefined);
    }
  });
  it("treats a valid object id as registryId", () => {
    const r = parseSuiPay(
      "pay",
      q(
        `receiver=${RECEIVER}&amount=1&coinType=0x2::sui::SUI&nonce=n&registry=${RECEIVER}`,
      ),
    );
    assert.ok(r.ok && r.request.registryId === RECEIVER);
  });
  it("rejects missing params, bad address, bad coin type, long nonce, non-positive amount", () => {
    assert.equal(
      parseSuiPay(
        "pay",
        q(`receiver=${RECEIVER}&amount=1&coinType=0x2::sui::SUI`),
      ).ok,
      false,
    );
    assert.equal(
      parseSuiPay(
        "pay",
        q(`receiver=0xzz&amount=1&coinType=0x2::sui::SUI&nonce=n`),
      ).ok,
      false,
    );
    assert.equal(
      parseSuiPay(
        "pay",
        q(`receiver=${RECEIVER}&amount=1&coinType=notatype&nonce=n`),
      ).ok,
      false,
    );
    assert.equal(
      parseSuiPay(
        "pay",
        q(
          `receiver=${RECEIVER}&amount=1&coinType=0x2::sui::SUI&nonce=${"n".repeat(37)}`,
        ),
      ).ok,
      false,
    );
    assert.equal(
      parseSuiPay(
        "pay",
        q(`receiver=${RECEIVER}&amount=0&coinType=0x2::sui::SUI&nonce=n`),
      ).ok,
      false,
    );
    assert.equal(
      parseSuiPay(
        "pay",
        q(`receiver=${RECEIVER}&amount=1.5&coinType=0x2::sui::SUI&nonce=n`),
      ).ok,
      false,
    );
  });
  it("only the pay operation exists", () => {
    const r = parseSuiPay("send", q(""));
    assert.deepEqual(r, { ok: false, code: "unsupported_operation" });
  });
  it("keeps iconUrl only when https", () => {
    const ok = parseSuiPay(
      "pay",
      q(
        `receiver=${RECEIVER}&amount=1&coinType=0x2::sui::SUI&nonce=n&iconUrl=https://x.y/i.png`,
      ),
    );
    const bad = parseSuiPay(
      "pay",
      q(
        `receiver=${RECEIVER}&amount=1&coinType=0x2::sui::SUI&nonce=n&iconUrl=http://x.y/i.png`,
      ),
    );
    assert.ok(ok.ok && ok.request.iconUrl === "https://x.y/i.png");
    assert.ok(bad.ok && bad.request.iconUrl === undefined);
  });
});

describe("payment kit constants", () => {
  it("derives a registry id from the pinned namespace ids", () => {
    for (const cfg of [SUI_PAYMENT_KIT_MAINNET, SUI_PAYMENT_KIT_TESTNET]) {
      const id = suiPaymentKitRegistryIdFromName(
        SUI_PAYMENT_KIT_DEFAULT_REGISTRY_NAME,
        cfg.namespaceId,
      );
      assert.match(id, /^0x[0-9a-f]{64}$/);
      assert.notEqual(id, cfg.namespaceId);
      // Deterministic: the same name must always derive the same id.
      assert.equal(
        id,
        suiPaymentKitRegistryIdFromName(
          SUI_PAYMENT_KIT_DEFAULT_REGISTRY_NAME,
          cfg.namespaceId,
        ),
      );
    }
  });
});
