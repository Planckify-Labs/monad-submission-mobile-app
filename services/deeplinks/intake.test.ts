/**
 * Intake pipeline — spec §14: S-8 (SEP-7 `signature=` passes, `#seed=`
 * blocked), S-11 caps, S-12 push, S-13 signing mode, S-10 ledger, S-2
 * (no file route is ever returned for an external URL), pass-through
 * list, and F2 (`/send?recipientAddress=` via URL lands in the inbox).
 */

// Metro injects `__DEV__`; define it before any app module loads.
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import "./boot.ts";
import { linkInbox } from "./inbox.ts";
import {
  INBOX_ROUTE,
  type IntakeDeps,
  intake,
  MAX_LINK_BYTES,
} from "./intake.ts";
import { registeredSchemes } from "./schemeRegistry.ts";
import type { DeepLinkEnvelope } from "./types.ts";

const SENSITIVE = [
  "/send",
  "/payment",
  "/pay-merchant",
  "/pay-x402",
  "/withdraw",
  "/deposit",
  "/approvals",
  "/agent-permissions",
  "/gas-settings",
];

function env(
  raw: string,
  over: Partial<DeepLinkEnvelope> = {},
): DeepLinkEnvelope {
  return {
    raw,
    source: "warm",
    initial: false,
    receivedAt: Date.now(),
    platform: "android",
    ...over,
  };
}

function deps(
  over: Partial<IntakeDeps> = {},
): IntakeDeps & { consumed: Set<string>; events: string[] } {
  const consumed = new Set<string>();
  const events: string[] = [];
  return {
    consumed,
    events,
    chainRows: () => null,
    signingModeOn: () => false,
    ledger: {
      wasConsumed: (raw) => consumed.has(raw),
      markConsumed: (raw) => {
        consumed.add(raw);
      },
    },
    onEvent: (e) =>
      events.push(
        e.name === "deeplink_rejected"
          ? `rejected:${e.code}`
          : `received:${e.class}`,
      ),
    ...over,
  };
}

const SEP7_SIGNED =
  "web+stellar:pay?destination=GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO&amount=120.1234567&memo=skdjfasf&memo_type=MEMO_TEXT&msg=pay%20me%20with%20lumens&origin_domain=someDomain.com&signature=tbsLtlK%2FfouvRWk2UWFP47yHYeI1g1NEC%2FfEQvuXG6V8P%2BbeLxplYbOVtTk1g94Wp97cHZ3pVJy%2FtZNYobl3Cw%3D%3D";

describe("intake — pass-through", () => {
  beforeEach(() => linkInbox.__resetForTest());
  it("returns dev-client, OAuth and plain-open URLs unchanged with no ledger entry", () => {
    const d = deps();
    for (const raw of [
      "takumiwallet:///",
      "takumiwallet://",
      "takumiwallet-dev://expo-development-client/?url=http%3A%2F%2F10.0.0.1%3A8081",
      "exp+takumiwallet-dev://expo-development-client/?url=x",
      "expo-development-client://foo",
      "com.googleusercontent.apps.744419386674-851aigcjotu3nakge5l3drbk9dpij9ah:/oauth2redirect?code=1",
      "https://takumipay.xyz/",
      "https://takumipay.xyz",
    ]) {
      const r = intake(env(raw), d);
      assert.equal(r.kind, "passthrough", raw);
      if (r.kind === "passthrough") assert.equal(r.path, raw);
    }
    assert.equal(d.consumed.size, 0);
    assert.equal(d.events.length, 0);
    assert.equal(linkInbox.snapshot().length, 0);
  });

  it("treats a WalletConnect request redirect as a wake, never an error", () => {
    const T = "d".repeat(64);
    for (const raw of [
      `takumiwallet://wc?requestId=1&sessionTopic=${T}`,
      `https://takumipay.xyz/wc/wc?requestId=2&sessionTopic=${T}`,
      // What RainbowKit-style dApps send (preview build showed this as
      // "Not supported yet"): the raw pairing URI head plus the redirect.
      `wc:${T}@2/wc?requestId=3&sessionTopic=${T}`,
      `takumiwallet://wc?uri=wc%3A${T}%402%3Frelay-protocol%3Dirn%26symKey%3Dab/wc?requestId=4&sessionTopic=${T}`,
    ]) {
      const d = deps();
      const wakes: Array<{ topic: string; requestId: string }> = [];
      const r = intake(env(raw), { ...d, onWake: (w) => wakes.push(w) });
      assert.equal(r.kind, "ignore", raw);
      assert.deepEqual(
        wakes.map((w) => w.topic),
        [T],
      );
      assert.deepEqual(d.events, ["received:wake"]);
      assert.equal(d.consumed.size, 0, "a wake is never ledgered");
      assert.equal(linkInbox.snapshot().length, 0);
    }
    // Not on our scheme or host: no wake.
    const d = deps();
    const r = intake(
      env(`https://evil.example/wc?requestId=1&sessionTopic=${T}`),
      d,
    );
    assert.notEqual(r.kind, "ignore");
  });

  it("ignores the MWA attestation return scheme (Phase 3b)", () => {
    const d = deps();
    for (const raw of [
      "takumiwallet-mwa://attest/return?nonce=ab&context=k1&jwk=e30",
      "takumiwallet-dev-mwa://attest/return?nonce=ab&context=k1&jwk=e30",
      "TAKUMIWALLET-PREVIEW-MWA://attest/return",
    ]) {
      const r = intake(env(raw), d);
      assert.equal(r.kind, "ignore", raw);
    }
    // Not our scheme family: a look-alike still goes through the registry.
    const r = intake(env("evil-mwa://attest/return"), d);
    assert.notEqual(r.kind, "ignore");
    assert.equal(d.events.length, 1);
    assert.equal(linkInbox.snapshot().length, 1);
  });
  it("every scheme in app.config.ts is either ours, registered, or passed through", () => {
    const schemes = registeredSchemes();
    for (const s of ["ethereum", "solana", "sui", "web+stellar", "wc"]) {
      assert.ok(schemes.includes(s), `scheme ${s} has no handler`);
    }
  });
});

describe("intake — S-2 sensitive routes never reachable by URL (F2)", () => {
  beforeEach(() => linkInbox.__resetForTest());
  it("routes every sensitive path on the verified host and our scheme into the inbox", () => {
    const d = deps();
    for (const path of SENSITIVE) {
      for (const raw of [
        `https://takumipay.xyz${path}?recipientAddress=0x1111111111111111111111111111111111111111&namespace=eip155`,
        `takumiwallet://${path.slice(1)}?recipientAddress=0x1111111111111111111111111111111111111111`,
      ]) {
        const r = intake(env(raw), d);
        assert.equal(r.kind, "inbox", raw);
        assert.equal((r as { href: string }).href, INBOX_ROUTE);
      }
    }
    const held = linkInbox.snapshot();
    assert.ok(held.length > 0);
    // Only the last three are held (cap), and none of them is a payment.
    for (const item of held) assert.equal(item.intent.kind, "reject");
  });
  it("only allowlisted read-only hrefs route directly", () => {
    const d = deps();
    const ok = intake(env("https://takumipay.xyz/link/about"), d);
    assert.deepEqual(ok, { kind: "route", href: "/about" });
    const own = intake(env("takumiwallet://link/dapp-permissions"), d);
    assert.deepEqual(own, { kind: "route", href: "/dapp-permissions" });
    const bad = intake(env("https://takumipay.xyz/link/send"), d);
    assert.equal(bad.kind, "inbox");
    assert.equal(linkInbox.peek()?.intent.kind, "reject");
  });
  it("third-party https opens the in-app browser, never a screen", () => {
    const r = intake(env("https://app.uniswap.org/swap"), deps());
    assert.deepEqual(r, {
      kind: "route",
      href: `/dapps-browser?url=${encodeURIComponent("https://app.uniswap.org/swap")}`,
    });
  });
});

describe("intake — S-8 fragment / query denylist (F4)", () => {
  beforeEach(() => linkInbox.__resetForTest());
  it("a signed SEP-0007 request passes intake", () => {
    const r = intake(env(SEP7_SIGNED), deps());
    assert.equal(r.kind, "inbox");
    const held = linkInbox.peek();
    assert.equal(held?.intent.kind, "signing");
  });
  it("blocks seed material on a fragment for every scheme", () => {
    for (const raw of [
      "ethereum:0x1111111111111111111111111111111111111111#mnemonic=a",
      `${SEP7_SIGNED}#seed=abandon`,
    ]) {
      intake(env(raw), deps());
      assert.equal(linkInbox.peek()?.intent.kind, "reject");
      assert.equal(
        (linkInbox.peek()?.intent as { code: string }).code,
        "fragment_blocked",
      );
      linkInbox.__resetForTest();
    }
  });
  it("blocks seed-shaped query keys only on our own routes", () => {
    intake(env("https://takumipay.xyz/pay?seed=abandon"), deps());
    assert.equal(
      (linkInbox.peek()?.intent as { code: string }).code,
      "fragment_blocked",
    );
    linkInbox.__resetForTest();
    intake(env("takumiwallet://pay?privateKey=abc"), deps());
    assert.equal(
      (linkInbox.peek()?.intent as { code: string }).code,
      "fragment_blocked",
    );
  });
});

describe("intake — S-11 caps, S-12 push, S-13 signing mode, S-10 ledger", () => {
  beforeEach(() => linkInbox.__resetForTest());
  it("rejects a link over 256 KB as too_large", () => {
    const d = deps();
    intake(
      env(`ethereum:0x${"1".repeat(40)}?memo=${"x".repeat(MAX_LINK_BYTES)}`),
      d,
    );
    assert.equal(
      (linkInbox.peek()?.intent as { code: string }).code,
      "too_large",
    );
    assert.ok(d.events.includes("rejected:too_large"));
  });
  it("holds at most three intents, dropping the oldest", () => {
    const d = deps();
    for (let i = 0; i < 5; i++)
      intake(env(`ethereum:0x${String(i).repeat(40)}?value=${i}`), d);
    assert.equal(linkInbox.snapshot().length, 3);
  });
  it("a push may only navigate", () => {
    const d = deps();
    const nav = intake(
      env("takumiwallet://link/wallet", { source: "push" }),
      d,
    );
    assert.deepEqual(nav, { kind: "route", href: "/wallet" });
    intake(env(`ethereum:0x${"2".repeat(40)}`, { source: "push" }), d);
    assert.equal(
      (linkInbox.peek()?.intent as { code: string }).code,
      "route_not_allowed",
    );
  });
  it("signing mode drops every class that carries intent, and the browser", () => {
    const d = deps({ signingModeOn: () => true });
    intake(env(`ethereum:0x${"3".repeat(40)}`), d);
    assert.equal(
      (linkInbox.peek()?.intent as { code: string }).code,
      "signing_mode",
    );
    linkInbox.__resetForTest();
    intake(env("https://app.uniswap.org/"), d);
    assert.equal(
      (linkInbox.peek()?.intent as { code: string }).code,
      "signing_mode",
    );
    linkInbox.__resetForTest();
    assert.deepEqual(intake(env("takumiwallet://link/about"), d), {
      kind: "route",
      href: "/about",
    });
  });
  it("cold-start replay is dropped, warm re-taps are not", () => {
    const raw = `ethereum:0x${"4".repeat(40)}?value=1`;
    const d = deps();
    d.consumed.add(raw);
    intake(env(raw, { source: "cold", initial: true }), d);
    assert.equal(
      (linkInbox.peek()?.intent as { code: string }).code,
      "replayed",
    );
    linkInbox.__resetForTest();
    intake(env(raw, { source: "warm", initial: false }), d);
    assert.equal(linkInbox.peek()?.intent.kind, "payment");
  });
  it("legacy takumiwallet://send becomes an EVM payment through the inbox", () => {
    const d = deps();
    const r = intake(
      env(`takumiwallet://send?to=0x${"5".repeat(40)}&amount=1000&chain=1`),
      d,
    );
    assert.equal(r.kind, "inbox");
    const held = linkInbox.peek();
    assert.equal(held?.intent.kind, "payment");
    assert.ok(d.events.includes("received:payment"));
  });
  it("/pay?uri= carries the inner chain URI with universal-link provenance", () => {
    intake(
      env(
        `https://takumipay.xyz/pay?uri=${encodeURIComponent(`ethereum:0x${"6".repeat(40)}?value=1e18`)}`,
      ),
      deps(),
    );
    const held = linkInbox.peek();
    assert.equal(held?.intent.kind, "payment");
    if (held?.intent.kind === "payment") {
      assert.equal(held.intent.provenance.verification.kind, "universal-link");
      const ch = held.intent.intent.channel;
      assert.equal(ch.kind === "wallet" && ch.amount, 1000000000000000000n);
    }
  });
  it("/wc?wc_ev= (Link Mode envelope) is a pair intent flagged linkMode", () => {
    intake(
      env(
        "https://takumipay.xyz/wc?wc_ev=ZW52ZWxvcGU&topic=7f6e504bfad60b485450578e05678ed3e8e8c4751d3c6160be17160d63ec90f9",
      ),
      deps(),
    );
    const held = linkInbox.peek();
    assert.equal(held?.intent.kind, "pair");
    if (held?.intent.kind === "pair") {
      assert.equal(held.intent.linkMode, true);
      assert.ok(held.intent.uri.startsWith("https://takumipay.xyz/wc?wc_ev="));
      assert.equal(held.intent.provenance.verification.kind, "universal-link");
    }
  });
  it("/wc?uri= yields a pair intent; /ul/v1/connect an encrypted-link intent", () => {
    const wc =
      "wc:7f6e504bfad60b485450578e05678ed3e8e8c4751d3c6160be17160d63ec90f9@2?relay-protocol=irn&symKey=587d5484ce2a2a6ee3ba1962fdd7e8588e06200c46823bd18fbd67def96ad303";
    intake(
      env(`https://takumipay.xyz/wc?uri=${encodeURIComponent(wc)}`),
      deps(),
    );
    assert.equal(linkInbox.peek()?.intent.kind, "pair");
    linkInbox.__resetForTest();
    intake(
      env(
        "https://takumipay.xyz/ul/v1/connect?app_url=https%3A%2F%2Fdapp.example&dapp_encryption_public_key=abc&redirect_link=dapp%3A%2F%2Fback",
      ),
      deps(),
    );
    assert.equal(linkInbox.peek()?.intent.kind, "encrypted-link");
  });
});
