/**
 * `isKernelLink`: which WebView navigations the dApps browser keeps
 * in-app (deep-link spec §4.2) versus hands to the OS.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

import "@/services/deeplinks/boot";
import { bootWalletKits } from "@/services/walletKit/boot";
import { isKernelLink } from "./kernelLink";

bootWalletKits();

describe("isKernelLink", () => {
  it("keeps kernel schemes, our scheme and our deep-link paths in-app", () => {
    for (const url of [
      `wc:${"a".repeat(64)}@2?relay-protocol=irn&symKey=${"b".repeat(64)}`,
      "ethereum:0x55DEA8ddF4C5b4Ec6D3E6b4c42aFe0F0d7a2ca08@1",
      "solana:mvines9iiHiQTysrwkJjGsqPkCPmEvyxAFdU1BkNK4E?amount=1",
      "takumiwallet://wc?uri=wc%3Aabc",
      "TAKUMIWALLET://pay?uri=x",
      "https://takumipay.xyz/wc?uri=wc%3Aabc",
      "https://takumipay.xyz/pay?uri=x",
      "https://takumipay.xyz/ul/v1/connect?x=1",
      "https://takumipay.xyz/mobilewalletadapter/v1/associate/local?association=x&port=50000",
      `wc:${"a".repeat(64)}@2/wc?requestId=1&sessionTopic=${"a".repeat(64)}`,
    ]) {
      assert.equal(isKernelLink(url), true, url);
    }
  });
  it("lets ordinary pages, other apps' schemes and MWA associations go through", () => {
    for (const url of [
      "https://blur.io/collection/x",
      "https://takumipay.xyz/",
      "https://takumipay.xyz/privacy-policy",
      "metamask://wc?uri=wc%3Aabc",
      "rainbow://wc?uri=wc%3Aabc",
      "mailto:hi@example.com",
      "intent://wc?uri=x#Intent;scheme=wc;end",
      // Owned by the MWA host activity on Android: must reach the OS.
      "solana-wallet:/v1/associate/local?association=x&port=50000",
      "not a url",
    ]) {
      assert.equal(isKernelLink(url), false, url);
    }
  });
});
