/**
 * Scheme registry — priority ordering, platform filtering, unknown
 * scheme, and the negative docking test: a fake namespace registered at
 * runtime is routed with zero kernel changes (spec §14).
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  __resetSchemeRegistryForTest,
  hasHandlerForScheme,
  parseDeepLink,
  registerSchemeHandler,
} from "./schemeRegistry.ts";
import type { DeepLinkEnvelope, DeepLinkParseContext } from "./types.ts";

const env = (
  raw: string,
  platform: "android" | "ios" = "android",
): DeepLinkEnvelope => ({
  raw,
  source: "warm",
  initial: false,
  receivedAt: 0,
  platform,
});
const ctx: DeepLinkParseContext = { chainRows: () => null };

describe("parseDeepLink", () => {
  beforeEach(() => __resetSchemeRegistryForTest());

  it("rejects an unregistered scheme as unsupported_scheme", () => {
    const out = parseDeepLink(env("bitcoin:1abc"), ctx);
    assert.deepEqual(out, { kind: "reject", code: "unsupported_scheme" });
  });

  it("rejects input without a scheme as malformed", () => {
    assert.deepEqual(parseDeepLink(env("no scheme here"), ctx), {
      kind: "reject",
      code: "malformed",
    });
  });

  it("runs handlers for a shared scheme in priority order and lets one decline", () => {
    const calls: string[] = [];
    registerSchemeHandler({
      id: "second",
      namespace: null,
      schemes: ["x"],
      priority: 20,
      parse: () => {
        calls.push("second");
        return { kind: "navigate", href: "/about" };
      },
    });
    registerSchemeHandler({
      id: "first",
      namespace: null,
      schemes: ["x"],
      priority: 10,
      parse: () => {
        calls.push("first");
        return null;
      },
    });
    const out = parseDeepLink(env("x:anything"), ctx);
    assert.deepEqual(calls, ["first", "second"]);
    assert.deepEqual(out, { kind: "navigate", href: "/about" });
  });

  it("filters by platform", () => {
    registerSchemeHandler({
      id: "android-only",
      namespace: null,
      schemes: ["only"],
      platforms: ["android"],
      priority: 1,
      parse: () => ({ kind: "navigate", href: "/wallet" }),
    });
    assert.equal(parseDeepLink(env("only:1", "android")).kind, "navigate");
    assert.deepEqual(parseDeepLink(env("only:1", "ios"), ctx), {
      kind: "reject",
      code: "unsupported_scheme",
    });
    assert.equal(hasHandlerForScheme("only", "ios"), false);
  });

  it("turns a throwing handler into malformed, never a crash", () => {
    registerSchemeHandler({
      id: "boom",
      namespace: null,
      schemes: ["boom"],
      priority: 1,
      parse: () => {
        throw new Error("attacker input");
      },
    });
    assert.deepEqual(parseDeepLink(env("boom:1"), ctx), {
      kind: "reject",
      code: "malformed",
    });
  });

  it("docks a brand-new namespace with zero kernel changes", () => {
    // A family that does not exist anywhere in the app: registering its
    // handler is the only step, and the kernel routes it.
    registerSchemeHandler({
      id: "moon-pay",
      namespace: "moon" as never,
      schemes: ["moon"],
      priority: 10,
      parse: (split, envelope) => ({
        kind: "payment",
        namespace: "moon" as never,
        intent: {
          source: "deeplink",
          rawScan: envelope.raw,
          channel: {
            kind: "wallet",
            namespace: "moon" as never,
            address: split.ssp,
          },
        },
        provenance: {
          verification: { kind: "none" },
          firstSeen: false,
          transport: "os-link",
        },
        summary: { title: "Payment request", chainLabel: "Moon", lines: [] },
      }),
    });
    const out = parseDeepLink(env("moon:MOON123?amount=1"), ctx);
    assert.equal(out.kind, "payment");
    if (out.kind === "payment")
      assert.equal(
        out.intent.channel.kind === "wallet" && out.intent.channel.address,
        "MOON123",
      );
  });
});
