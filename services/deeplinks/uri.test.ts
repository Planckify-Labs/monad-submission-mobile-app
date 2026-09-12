/**
 * `splitUri` on every example URI from spec §2, verbatim — the F5 fix
 * must handle each ecosystem's own shape without `new URL`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  hostnameOfHttps,
  isAbsoluteHttpsUrl,
  safeDecodeComponent,
  splitHttpsUrl,
  splitUri,
} from "./uri.ts";

describe("splitUri — ERC-681 / ERC-831", () => {
  it("splits a plain ethereum: payment", () => {
    const s = splitUri(
      "ethereum:0xfb6916095ca1df60bb79Ce92ce3ea74c37c5d359?value=2.014e18",
    );
    assert.ok(s);
    assert.equal(s.scheme, "ethereum");
    assert.equal(s.ssp, "0xfb6916095ca1df60bb79Ce92ce3ea74c37c5d359");
    assert.equal(s.query.get("value"), "2.014e18");
    assert.equal(s.fragment, null);
  });
  it("keeps @chainId and /transfer inside the ssp", () => {
    const s = splitUri(
      "ethereum:0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7@137/transfer?address=0x8e23ee67d1332ad560396262c48ffbb01f93d052&uint256=1",
    );
    assert.ok(s);
    assert.equal(
      s.ssp,
      "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7@137/transfer",
    );
    assert.equal(s.query.get("uint256"), "1");
  });
  it("lower-cases the scheme", () => {
    assert.equal(splitUri("ETHEREUM:0x00")?.scheme, "ethereum");
  });
});

describe("splitUri — Solana Pay", () => {
  it("transfer request", () => {
    const s = splitUri(
      "solana:mvines9iiHiQTysrwkJjGsqPkCPmEvyxAFdU1BkNK4E?amount=1&label=Michael&message=Thanks%20for%20all%20the%20fish&memo=OrderId12345",
    );
    assert.ok(s);
    assert.equal(s.ssp, "mvines9iiHiQTysrwkJjGsqPkCPmEvyxAFdU1BkNK4E");
    assert.equal(s.query.get("message"), "Thanks for all the fish");
  });
  it("transaction request keeps the encoded link opaque", () => {
    const s = splitUri(
      "solana:https%3A%2F%2Fexample.com%2Fsolana-pay%3Forder%3D12345",
    );
    assert.ok(s);
    assert.equal(
      safeDecodeComponent(s.ssp),
      "https://example.com/solana-pay?order=12345",
    );
    assert.equal(s.rawQuery, "");
  });
  it("transaction request with an unencoded link keeps its query as the raw query", () => {
    const s = splitUri("solana:https://example.com/solana-pay?order=12345");
    assert.ok(s);
    assert.equal(s.ssp, "https://example.com/solana-pay");
    assert.equal(s.rawQuery, "order=12345");
  });
});

describe("splitUri — SEP-0007", () => {
  it("tx with callback and pubkey (example 1)", () => {
    const s = splitUri(
      "web+stellar:tx?xdr=AAAAAP%2Byw%2BZEuNg533pUmwlYxfrq6%2FBoMJqiJ8vuQhf6rHWmAAAAZAB8NHAAAAABAAAAAAAAAAAAAAABAAAAAAAAAAYAAAABSFVHAAAAAABAH0wIyY3BJBS2qHdRPAV80M8hF7NBpxRjXyjuT9kEbH%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FAAAAAAAAAAA%3D&callback=url%3Ahttps%3A%2F%2FsomeSigningService.com%2Fa8f7asdfkjha&pubkey=GAU2ZSYYEYO5S5ZQSMMUENJ2TANY4FPXYGGIMU6GMGKTNVDG5QYFW6JS&msg=order%20number%2024",
    );
    assert.ok(s);
    assert.equal(s.scheme, "web+stellar");
    assert.equal(s.ssp, "tx");
    assert.equal(
      s.query.get("callback"),
      "url:https://someSigningService.com/a8f7asdfkjha",
    );
    assert.equal(s.query.get("msg"), "order number 24");
  });
  it("signed pay example keeps the raw query byte-for-byte", () => {
    const raw =
      "web+stellar:pay?destination=GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO&amount=120.1234567&memo=skdjfasf&memo_type=MEMO_TEXT&msg=pay%20me%20with%20lumens&origin_domain=someDomain.com&signature=tbsLtlK%2FfouvRWk2UWFP47yHYeI1g1NEC%2FfEQvuXG6V8P%2BbeLxplYbOVtTk1g94Wp97cHZ3pVJy%2FtZNYobl3Cw%3D%3D";
    const s = splitUri(raw);
    assert.ok(s);
    assert.equal(s.ssp, "pay");
    assert.ok(
      s.rawQuery.endsWith(
        "&signature=tbsLtlK%2FfouvRWk2UWFP47yHYeI1g1NEC%2FfEQvuXG6V8P%2BbeLxplYbOVtTk1g94Wp97cHZ3pVJy%2FtZNYobl3Cw%3D%3D",
      ),
    );
    assert.equal(s.query.get("origin_domain"), "someDomain.com");
  });
});

describe("splitUri — sui:pay and wc:", () => {
  it("Mysten payment kit URI", () => {
    const s = splitUri(
      "sui:pay?receiver=0x0000000000000000000000000000000000000000000000000000000000000002&amount=10000000&coinType=0x2::sui::SUI&nonce=abc",
    );
    assert.ok(s);
    assert.equal(s.ssp, "pay");
    assert.equal(s.query.get("coinType"), "0x2::sui::SUI");
  });
  it("WalletConnect pairing URI", () => {
    const s = splitUri(
      "wc:7f6e504bfad60b485450578e05678ed3e8e8c4751d3c6160be17160d63ec90f9@2?relay-protocol=irn&symKey=587d5484ce2a2a6ee3ba1962fdd7e8588e06200c46823bd18fbd67def96ad303&expiryTimestamp=1700000000",
    );
    assert.ok(s);
    assert.equal(s.scheme, "wc");
    assert.equal(
      s.ssp,
      "7f6e504bfad60b485450578e05678ed3e8e8c4751d3c6160be17160d63ec90f9@2",
    );
    assert.equal(s.query.get("relay-protocol"), "irn");
  });
  it("returns null with no scheme", () => {
    assert.equal(splitUri("0xabc"), null);
    assert.equal(splitUri(""), null);
  });
  it("splits the fragment off before the query", () => {
    const s = splitUri("takumiwallet://send?to=0x1#seed=abc");
    assert.equal(s?.fragment, "seed=abc");
    assert.equal(s?.query.get("to"), "0x1");
  });
});

describe("https helpers", () => {
  it("hostnameOfHttps is ASCII-only, lowercase, no userinfo", () => {
    assert.equal(
      hostnameOfHttps("https://Shop.Example/pay?x=1"),
      "shop.example",
    );
    assert.equal(hostnameOfHttps("https://user@evil.example/"), null);
    assert.equal(
      hostnameOfHttps("https://xn--80ak6aa92e.com/"),
      "xn--80ak6aa92e.com",
    );
    assert.equal(hostnameOfHttps("https://пример.рф/"), null);
    assert.equal(hostnameOfHttps("http://shop.example/"), null);
    assert.equal(isAbsoluteHttpsUrl("https://a.b"), true);
    assert.equal(isAbsoluteHttpsUrl("ftp://a.b"), false);
  });
  it("splitHttpsUrl gives pathname + query for our own host", () => {
    const s = splitHttpsUrl("https://takumipay.xyz/pay?uri=ethereum%3A0x00");
    assert.equal(s?.host, "takumipay.xyz");
    assert.equal(s?.pathname, "/pay");
    assert.equal(s?.query.get("uri"), "ethereum:0x00");
  });
  it("safeDecodeComponent never throws", () => {
    assert.equal(safeDecodeComponent("%E0%A4%A"), null);
    assert.equal(safeDecodeComponent("a%20b"), "a b");
  });
});
