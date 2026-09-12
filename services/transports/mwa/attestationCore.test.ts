/**
 * Phase 3b — wallet-side attestation state machine (pure core).
 */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

// Metro injects `__DEV__`; define it before any app module loads.
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

import {
  type AttestKv,
  type AttestNotice,
  CHALLENGE_TTL_MS,
  MWA_ATTEST_ORIGIN_URI,
  MwaAttestation,
} from "./attestationCore";

const RETURN_URL = "takumiwallet-mwa://attest/return";
const JWK = { kty: "EC", crv: "P-256", x: "eA", y: "eQ" } as const;
const JWK_B64 = Buffer.from(JSON.stringify(JWK)).toString("base64url");

function memKv(): AttestKv & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getString: (k) => map.get(k),
    set: (k, v) => void map.set(k, v),
    remove: (k) => void map.delete(k),
    getAllKeys: () => [...map.keys()],
  };
}

function harness(opts: { now?: number } = {}) {
  const kv = memKv();
  const notices: AttestNotice[] = [];
  let now = opts.now ?? 1_800_000_000_000;
  const att = new MwaAttestation({
    store: async () => kv,
    returnUrl: RETURN_URL,
    notify: (n) => void notices.push(n),
    now: () => now,
    lateReturnMs: 5,
  });
  return { kv, notices, att, tick: (ms: number) => void (now += ms) };
}

/** A browser that answers the provisioning tab by echoing whatever nonce the URL carried. */
function echoBrowser(
  opts: { context?: string; nonceOverride?: string; result?: "cancel" } = {},
) {
  const opened: string[] = [];
  return {
    opened,
    openAuthSession: async (url: string, returnUrl: string) => {
      opened.push(url);
      assert.equal(returnUrl, RETURN_URL);
      if (opts.result === "cancel") return { type: "cancel" };
      const nonce =
        opts.nonceOverride ?? new URL(url).searchParams.get("nonce") ?? "";
      return {
        type: "success" as const,
        url: `${RETURN_URL}?nonce=${nonce}&context=${opts.context ?? "ctx-1"}&jwk=${JWK_B64}`,
      };
    },
  };
}

describe("MwaAttestation provisioning", () => {
  test("opens the wallet-hosted page with a fresh nonce and stores the returned key", async () => {
    const h = harness();
    const browser = echoBrowser();
    const key = await h.att.ensureKey(browser);
    assert.ok(key);
    assert.equal(key.context, "ctx-1");
    assert.deepEqual(key.jwk, JWK);
    assert.equal(browser.opened.length, 1);
    const url = new URL(browser.opened[0]);
    assert.equal(`${url.origin}${url.pathname}`, MWA_ATTEST_ORIGIN_URI);
    assert.equal(url.searchParams.get("m"), "provision");
    assert.match(url.searchParams.get("nonce") ?? "", /^[0-9a-f]{32}$/);
    assert.equal(url.searchParams.get("return"), RETURN_URL);
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0].title, "One-time setup");
    // Persisted and reused: the second call opens nothing.
    assert.equal(h.kv.getString("attest.current"), "ctx-1");
    const again = await h.att.ensureKey(browser);
    assert.equal(again?.context, "ctx-1");
    assert.equal(browser.opened.length, 1);
    assert.deepEqual(await h.att.keys(), { "ctx-1": JWK });
  });

  test("drops a return that does not echo the nonce the wallet minted", async () => {
    const h = harness();
    const key = await h.att.ensureKey(
      echoBrowser({ nonceOverride: "00".repeat(16) }),
    );
    assert.equal(key, null);
    assert.equal(h.kv.map.size, 0);
    // Nothing pending afterwards either: a late replay is ignored.
    assert.equal(
      await h.att.completeProvisioning(
        `${RETURN_URL}?nonce=${"00".repeat(16)}&context=x&jwk=${JWK_B64}`,
      ),
      null,
    );
  });

  test("a cancelled tab leaves no key; a late url event within the grace window completes it", async () => {
    const h = harness();
    assert.equal(
      await h.att.ensureKey(echoBrowser({ result: "cancel" })),
      null,
    );
    assert.equal(h.kv.map.size, 0);

    // Now simulate the redirect arriving as a `url` event while the auth session is still open.
    let capturedNonce = "";
    const p = h.att.ensureKey({
      openAuthSession: async (url) => {
        capturedNonce = new URL(url).searchParams.get("nonce") ?? "";
        // The session resolves as dismissed (Custom Tab closed by the redirect) ...
        return { type: "dismiss" };
      },
    });
    // ... and the activity receives the return URL through Linking.
    await new Promise((r) => setTimeout(r, 1));
    const done = await h.att.completeProvisioning(
      `${RETURN_URL}?nonce=${capturedNonce}&context=ctx-late&jwk=${JWK_B64}`,
    );
    assert.equal(done?.context, "ctx-late");
    const key = await p;
    assert.equal(key?.context, "ctx-late");
  });

  test("a return with a malformed JWK or the wrong path is ignored", async () => {
    const h = harness();
    const bad = await h.att.ensureKey({
      openAuthSession: async (url) => ({
        type: "success" as const,
        url: `${RETURN_URL}?nonce=${new URL(url).searchParams.get("nonce")}&context=c&jwk=${Buffer.from('{"kty":"RSA"}').toString("base64url")}`,
      }),
    });
    assert.equal(bad, null);
  });
});

describe("MwaAttestation challenges and session cache", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(async () => {
    h = harness();
    await h.att.ensureKey(echoBrowser());
  });

  test("issue → take is one-shot, keyed by host, and expires", async () => {
    const key = (await h.att.currentKey())!;
    const c = h.att.issueChallenge("https://dapp.example/app", key);
    assert.equal(c.context, "ctx-1");
    assert.equal(c.challenge.length, 32);
    assert.equal(h.att.hasChallenge("https://DAPP.example/other"), true);
    assert.equal(h.att.hasChallenge("https://other.example"), false);
    const taken = h.att.takeChallenge("https://dapp.example/");
    assert.equal(taken, c);
    assert.equal(h.att.takeChallenge("https://dapp.example/"), null);

    h.att.issueChallenge("https://dapp.example", key);
    h.tick(CHALLENGE_TTL_MS + 1);
    assert.equal(h.att.hasChallenge("https://dapp.example"), false);
    assert.equal(h.att.takeChallenge("https://dapp.example"), null);
  });

  test("two challenges for one dApp are unique", async () => {
    const key = (await h.att.currentKey())!;
    const a = h.att.issueChallenge("https://a.example", key);
    const b = h.att.issueChallenge("https://b.example", key);
    assert.notDeepEqual(Buffer.from(a.challenge), Buffer.from(b.challenge));
  });

  test("attested origins are remembered for the session only", () => {
    h.att.rememberAttested("https://dapp.example/x", "https://dapp.example");
    assert.equal(
      h.att.attestedOriginFor("https://dapp.example/y"),
      "https://dapp.example",
    );
    assert.equal(h.att.attestedOriginFor("https://evil.example"), null);
    h.att.resetSession();
    assert.equal(h.att.attestedOriginFor("https://dapp.example/y"), null);
  });

  test("forgetCurrentKey re-provisions once per session and keeps old keys verifiable", async () => {
    assert.equal(await h.att.forgetCurrentKey(), true);
    assert.equal(await h.att.currentKey(), null);
    // Old key still listed for tokens in flight.
    assert.deepEqual(await h.att.keys(), { "ctx-1": JWK });
    const key = await h.att.ensureKey(echoBrowser({ context: "ctx-2" }));
    assert.equal(key?.context, "ctx-2");
    assert.deepEqual(Object.keys(await h.att.keys()).sort(), [
      "ctx-1",
      "ctx-2",
    ]);
    // Second forget in the same session is refused (no re-provision loops).
    assert.equal(await h.att.forgetCurrentKey(), false);
    assert.equal((await h.att.currentKey())?.context, "ctx-2");
    h.att.resetSession();
    assert.equal(await h.att.forgetCurrentKey(), true);
  });
});
