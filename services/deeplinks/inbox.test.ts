/**
 * Inbox (max 3, FIFO, 5-minute TTL) and the consumed-link ledger (24 h,
 * hash only) — S-10 / S-11.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { INBOX_MAX, INBOX_TTL_MS, linkInbox } from "./inbox.ts";
import {
  __resetLedgerForTest,
  hashLink,
  markConsumed,
  wasConsumed,
} from "./ledger.ts";
import type { DeepLinkEnvelope, DeepLinkIntent } from "./types.ts";

const env = (raw: string): DeepLinkEnvelope => ({
  raw,
  source: "warm",
  initial: false,
  receivedAt: 0,
  platform: "ios",
});
const nav: DeepLinkIntent = { kind: "navigate", href: "/about" };

describe("linkInbox", () => {
  beforeEach(() => linkInbox.__resetForTest());
  it("holds FIFO up to the cap and drops the oldest", () => {
    for (let i = 0; i < INBOX_MAX + 2; i++)
      linkInbox.hold(env(`x:${i}`), nav, 1000 + i);
    const snap = linkInbox.snapshot(2000);
    assert.equal(snap.length, INBOX_MAX);
    assert.equal(snap[0].envelope.raw, "x:2");
  });
  it("expires after the TTL and consumes by id", () => {
    const item = linkInbox.hold(env("x:1"), nav, 0);
    assert.equal(linkInbox.peek(INBOX_TTL_MS - 1)?.id, item.id);
    assert.equal(linkInbox.peek(INBOX_TTL_MS + 1), null);
    const again = linkInbox.hold(env("x:2"), nav, Date.now());
    assert.equal(linkInbox.consume(again.id)?.id, again.id);
    assert.equal(linkInbox.consume(again.id), null);
  });
  it("notifies subscribers with the current snapshot", () => {
    const seen: number[] = [];
    const unsub = linkInbox.subscribe((items) => seen.push(items.length));
    linkInbox.hold(env("x:1"), nav, Date.now());
    unsub();
    linkInbox.hold(env("x:2"), nav, Date.now());
    assert.deepEqual(seen, [0, 1]);
  });
});

describe("ledger", () => {
  beforeEach(() => __resetLedgerForTest());
  it("stores only a hash and forgets after 24 h", () => {
    const raw = "ethereum:0x1?value=1";
    assert.equal(wasConsumed(raw, 1000), false);
    markConsumed(raw, 1000);
    assert.equal(wasConsumed(raw, 2000), true);
    assert.equal(wasConsumed(raw, 1000 + 24 * 60 * 60 * 1000 + 1), false);
    assert.match(hashLink(raw), /^[0-9a-f]{64}$/);
    assert.notEqual(hashLink(raw), hashLink(`${raw}0`));
  });
});
