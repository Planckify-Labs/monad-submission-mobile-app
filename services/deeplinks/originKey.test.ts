/**
 * Origin keys per transport — spec §4.9 / S-17: every external key
 * carries a transport prefix, verified and unverified keys for the same
 * peer differ, and none can equal a WebView origin.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { originKey } from "@/services/permissions/caip";
import {
  isExternalOriginKey,
  originKeyFor,
  transportOfOriginKey,
} from "./originKey.ts";

describe("originKeyFor", () => {
  it("WalletConnect: VALID → host + topic; otherwise unverified + topic", () => {
    const v = originKeyFor({
      transport: "walletconnect",
      pairingTopic: "t1",
      verifiedOrigin: "https://app.uniswap.org",
    });
    const u = originKeyFor({
      transport: "walletconnect",
      pairingTopic: "t1",
      verifiedOrigin: null,
    });
    assert.equal(v, "wc+https://app.uniswap.org#t1");
    assert.equal(u, "wc+unverified://t1");
    assert.notEqual(v, u);
    assert.equal(
      originKeyFor({
        transport: "walletconnect",
        pairingTopic: "t1",
        verifiedOrigin: "app.uniswap.org",
      }),
      v,
    );
  });
  it("MWA: DAL-verified package vs unverified hash", () => {
    const v = originKeyFor({
      transport: "mwa",
      identityUri: "https://dapp.example/",
      verifiedPackage: "com.example.dapp",
    });
    const u = originKeyFor({
      transport: "mwa",
      identityUri: "https://dapp.example/",
      verifiedPackage: null,
    });
    assert.equal(v, "mwa+https://dapp.example#com.example.dapp");
    assert.match(u, /^mwa\+unverified:\/\/[0-9a-f]{32}$/);
  });
  it("MWA: browser-attested web origin gets its own verified bucket (Phase 3b)", () => {
    const a = originKeyFor({
      transport: "mwa",
      identityUri: "https://dapp.example/app",
      verifiedPackage: null,
      attestedOrigin: "https://dapp.example",
    });
    assert.equal(a, "mwa+https://dapp.example#web");
    // A DAL-verified native caller still wins over a web attestation.
    const both = originKeyFor({
      transport: "mwa",
      identityUri: "https://dapp.example/app",
      verifiedPackage: "com.example.dapp",
      attestedOrigin: "https://dapp.example",
    });
    assert.equal(both, "mwa+https://dapp.example#com.example.dapp");
    // Attested origins never share a key with an unverified claim of the same host.
    const u = originKeyFor({
      transport: "mwa",
      identityUri: "https://dapp.example/app",
      verifiedPackage: null,
    });
    assert.notEqual(u, a);
  });
  it("encrypted link and sep7", () => {
    assert.equal(
      originKeyFor({ transport: "encrypted-link", dappPublicKey: "PUB" }),
      "ul+unverified://PUB",
    );
    assert.equal(
      originKeyFor({ transport: "sep7", domain: "Shop.Example" }),
      "sep7+https://shop.example",
    );
  });
  it("never collides with a WebView origin and survives originKey() verbatim", () => {
    for (const k of [
      originKeyFor({
        transport: "walletconnect",
        pairingTopic: "t",
        verifiedOrigin: "https://app.uniswap.org",
      }),
      originKeyFor({
        transport: "mwa",
        identityUri: "https://app.uniswap.org",
        verifiedPackage: "p",
      }),
    ]) {
      assert.ok(isExternalOriginKey(k));
      assert.notEqual(originKey(k), originKey("https://app.uniswap.org"));
      assert.equal(originKey(k), k);
    }
    assert.equal(isExternalOriginKey("https://app.uniswap.org"), false);
    assert.equal(transportOfOriginKey("ul+unverified://x"), "encrypted-link");
  });
});
