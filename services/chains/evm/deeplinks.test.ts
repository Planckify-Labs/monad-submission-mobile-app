/**
 * ERC-681 / ERC-831 deltas the deep-link handler adds on top of the
 * QR parser (spec §6.1): `pay-` prefix, scientific notation, ENS refusal,
 * unknown-function refusal, chain-row check.
 */

// Metro injects `__DEV__`; define it before any app module loads.
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseDeepLink,
  registerSchemeHandler,
} from "@/services/deeplinks/schemeRegistry";
import type { DeepLinkEnvelope } from "@/services/deeplinks/types";
import { bootWalletKits } from "@/services/walletKit/boot";
import {
  eip681Handler,
  expandScientific,
  normalizeErc681,
} from "./deeplinks.ts";

// Chain-row checks resolve ids through the kit registry.
bootWalletKits();
registerSchemeHandler(eip681Handler);

const ADDR = "0xfb6916095ca1df60bb79Ce92ce3ea74c37c5d359";
const env = (raw: string): DeepLinkEnvelope => ({
  raw,
  source: "warm",
  initial: false,
  receivedAt: 0,
  platform: "ios",
});
const rows = (ids: number[]) =>
  ids.map((id) => ({
    id: String(id),
    name: `chain-${id}`,
    chainId: id,
    rpcUrl: "https://rpc.example",
    blockExplorer: "",
    isEVM: true,
    isActive: true,
    isTestnet: false,
    updatedAt: "",
  }));

describe("expandScientific", () => {
  it("expands the ERC-681 example and integers", () => {
    assert.equal(expandScientific("2.014e18"), "2014000000000000000");
    assert.equal(expandScientific("1e18"), "1000000000000000000");
    assert.equal(expandScientific("5"), "5");
    assert.equal(expandScientific("0"), "0");
    assert.equal(expandScientific("1.5e1"), "15");
  });
  it("refuses fractional wei and negatives", () => {
    assert.equal(expandScientific("1.5"), null);
    assert.equal(expandScientific("2.0145e3"), null);
    assert.equal(expandScientific("-1"), null);
    assert.equal(expandScientific("abc"), null);
  });
});

describe("normalizeErc681", () => {
  it("strips the ERC-831 pay- prefix", () => {
    const r = normalizeErc681(`ethereum:pay-${ADDR}?value=1`);
    assert.deepEqual(r, { uri: `ethereum:${ADDR}?value=1` });
  });
  it("refuses other prefixes, ENS names and unknown functions", () => {
    assert.deepEqual(normalizeErc681(`ethereum:foo-${ADDR}`), {
      reject: "unsupported_operation",
    });
    assert.deepEqual(normalizeErc681("ethereum:vitalik.eth?value=1"), {
      reject: "unsupported_operation",
    });
    assert.deepEqual(
      normalizeErc681(`ethereum:${ADDR}/approve?address=${ADDR}`),
      { reject: "unsupported_operation" },
    );
    assert.deepEqual(normalizeErc681("ethereum:notanaddress"), {
      reject: "malformed",
    });
  });
  it("drops gas hints and expands value", () => {
    const r = normalizeErc681(
      `ethereum:${ADDR}?value=2.014e18&gas=21000&gasPrice=1`,
    );
    assert.deepEqual(r, { uri: `ethereum:${ADDR}?value=2014000000000000000` });
  });
});

describe("eip681Handler", () => {
  it("emits a payment intent with wei amount and chain hint", () => {
    const out = parseDeepLink(env(`ethereum:${ADDR}@137?value=1e18`), {
      chainRows: () => rows([1, 137]),
    });
    assert.equal(out.kind, "payment");
    if (out.kind === "payment") {
      const ch = out.intent.channel;
      assert.equal(ch.kind, "wallet");
      if (ch.kind === "wallet") {
        assert.equal(ch.amount, 1000000000000000000n);
        assert.deepEqual(ch.target, { namespace: "eip155", chainId: 137 });
      }
      assert.equal(out.intent.source, "deeplink");
      assert.equal(out.provenance.verification.kind, "none");
    }
  });
  it("rejects a chain the feed does not offer, defers when the feed is unknown", () => {
    assert.deepEqual(
      parseDeepLink(env(`ethereum:${ADDR}@99999?value=1`), {
        chainRows: () => rows([1]),
      }),
      {
        kind: "reject",
        code: "unsupported_chain",
      },
    );
    assert.equal(
      parseDeepLink(env(`ethereum:${ADDR}@99999?value=1`), {
        chainRows: () => null,
      }).kind,
      "payment",
    );
  });
  it("keeps the ERC-20 /transfer path", () => {
    const token = "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7";
    const out = parseDeepLink(
      env(`ethereum:${token}/transfer?address=${ADDR}&uint256=1e6`),
      { chainRows: () => null },
    );
    assert.equal(out.kind, "payment");
    if (out.kind === "payment" && out.intent.channel.kind === "wallet") {
      assert.equal(out.intent.channel.token, token);
      assert.equal(out.intent.channel.address, ADDR);
      assert.equal(out.intent.channel.amount, 1000000n);
    }
  });
});
