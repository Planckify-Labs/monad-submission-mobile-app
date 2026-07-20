/**
 * Tests for the signing-digest emoji fingerprint — TWV-2026-066.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types \
 *     services/security/emojiHash.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EMOJI_HASH_COLUMNS,
  EMOJI_HASH_COUNT,
  EMOJI_PALETTE,
  emojiHash,
  emojiHashFromBytes,
  toEmojiGrid,
} from "./emojiHash.ts";

const DIGEST_A =
  "0x3f1b8c2d5e6a7b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c";
const DIGEST_B =
  "0x3f1b8c2d5e6a7b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3d";

describe("emojiHash", () => {
  it("is deterministic for the same input", () => {
    assert.deepEqual(emojiHash(DIGEST_A), emojiHash(DIGEST_A));
  });

  it("produces exactly EMOJI_HASH_COUNT cells by default", () => {
    assert.equal(emojiHash(DIGEST_A).length, EMOJI_HASH_COUNT);
  });

  it("honours a custom cell count", () => {
    assert.equal(emojiHash(DIGEST_A, 8).length, 8);
  });

  it("only ever emits palette members", () => {
    const palette = new Set(EMOJI_PALETTE);
    for (const e of emojiHash(DIGEST_A)) {
      assert.ok(palette.has(e), `${e} is not in the palette`);
    }
  });

  it("ignores the 0x prefix (same bytes => same grid)", () => {
    assert.deepEqual(emojiHash(DIGEST_A), emojiHash(DIGEST_A.slice(2)));
  });

  it("moves at least one cell when a single digest byte flips", () => {
    // DIGEST_A and DIGEST_B differ only in the final nibble.
    assert.notDeepEqual(emojiHash(DIGEST_A), emojiHash(DIGEST_B));
  });

  it("distinguishes transposed bytes (order matters)", () => {
    // Same byte multiset, different order.
    const a = emojiHashFromBytes(
      new Uint8Array([1, 2, 3, 4]),
      EMOJI_HASH_COUNT,
    );
    const b = emojiHashFromBytes(
      new Uint8Array([4, 3, 2, 1]),
      EMOJI_HASH_COUNT,
    );
    assert.notDeepEqual(a, b);
  });

  it("handles non-hex (base58-style) input without throwing", () => {
    const grid = emojiHash("Hxk9dW3rTq7ZbN2pLmVsA1");
    assert.equal(grid.length, EMOJI_HASH_COUNT);
    const palette = new Set(EMOJI_PALETTE);
    for (const e of grid) assert.ok(palette.has(e));
  });

  it("returns a fixed non-empty grid for empty input", () => {
    const grid = emojiHashFromBytes(new Uint8Array([]), EMOJI_HASH_COUNT);
    assert.equal(grid.length, EMOJI_HASH_COUNT);
  });
});

describe("toEmojiGrid", () => {
  it("chunks a flat list into rows of the given width", () => {
    const rows = toEmojiGrid(emojiHash(DIGEST_A), EMOJI_HASH_COLUMNS);
    assert.equal(rows.length, EMOJI_HASH_COUNT / EMOJI_HASH_COLUMNS);
    for (const row of rows) assert.equal(row.length, EMOJI_HASH_COLUMNS);
  });
});
