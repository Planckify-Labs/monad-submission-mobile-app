/**
 * Unit tests for the AI plain-English summary layer — task 65
 * (TWV-2026-066) Phase D. The hard requirement under test: every
 * failure mode returns `null` (the sheet renders exactly as if
 * Phase D were absent) and no raw error text ever escapes.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types --import ./services/walletKit/evm/_test-resolver.mjs services/decoders/summarize.test.ts
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { ClearSigningDescriptor } from "../walletKit/types.ts";
import { summarizeClearSigningDescriptor } from "./summarize.ts";

const DESCRIPTOR: ClearSigningDescriptor = {
  intent: "Transfer",
  source: "erc7730",
  functionName: "transfer",
  fields: [{ label: "To", value: "0xabc" }],
};

const realFetch = globalThis.fetch;
const realEnv = {
  url: process.env.EXPO_PUBLIC_AI_API_URL,
  key: process.env.EXPO_PUBLIC_SECRET_AI_KEY,
};

describe("summarizeClearSigningDescriptor", () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_AI_API_URL = "https://ai.test.local";
    process.env.EXPO_PUBLIC_SECRET_AI_KEY = "test-key";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    process.env.EXPO_PUBLIC_AI_API_URL = realEnv.url;
    process.env.EXPO_PUBLIC_SECRET_AI_KEY = realEnv.key;
  });

  it("returns the summary sentence on success and posts ONLY the descriptor", async () => {
    let requestBody: string | undefined;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      assert.match(String(url), /\/summarize\/clear-signing\?/);
      requestBody = init?.body as string;
      return new Response(
        JSON.stringify({ summary: "Sends tokens to 0xabc." }),
        { status: 200 },
      );
    }) as typeof fetch;
    const s = await summarizeClearSigningDescriptor(DESCRIPTOR);
    assert.equal(s, "Sends tokens to 0xabc.");
    // The AI never sees raw bytes — only the normalized descriptor.
    assert.deepEqual(JSON.parse(requestBody ?? "{}"), {
      descriptor: DESCRIPTOR,
    });
  });

  it("HTTP error → null, no throw (fail-silent rule)", async () => {
    globalThis.fetch = (async () =>
      new Response('{"code":"boom","message":"SECRET DETAIL"}', {
        status: 500,
      })) as typeof fetch;
    assert.equal(await summarizeClearSigningDescriptor(DESCRIPTOR), null);
  });

  it("network failure → null, no throw", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED raw detail");
    }) as typeof fetch;
    assert.equal(await summarizeClearSigningDescriptor(DESCRIPTOR), null);
  });

  it("malformed / oversized payloads → null", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ summary: 42 }), {
        status: 200,
      })) as typeof fetch;
    assert.equal(await summarizeClearSigningDescriptor(DESCRIPTOR), null);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ summary: "x".repeat(500) }), {
        status: 200,
      })) as typeof fetch;
    assert.equal(await summarizeClearSigningDescriptor(DESCRIPTOR), null);
  });

  it("unconfigured environment → null without a network call", async () => {
    process.env.EXPO_PUBLIC_AI_API_URL = "";
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    assert.equal(await summarizeClearSigningDescriptor(DESCRIPTOR), null);
    assert.equal(called, false);
  });
});
