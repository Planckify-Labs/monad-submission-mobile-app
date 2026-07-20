// TWV-2026-066 — Emoji-hash fingerprint for signing-digest verification.
//
// Comparing 64 hex characters across two devices is something humans do
// badly: the eye skims, and an attacker who flips a few bytes in the
// middle is rarely caught. An emoji fingerprint (Argent-style) turns the
// digest into a short grid of distinct pictograms a person can actually
// compare at a glance. The UI then highlights one row at random so the
// check becomes an active spot-check instead of a passive skim.
//
// The mapping is a PURE, DETERMINISTIC function of the digest string, so
// two devices running this code render the same grid for the same
// digest. It is a display aid layered on top of the hex — never a gate,
// and never a replacement for the full hex comparison when it matters.

/**
 * Curated palette of visually distinct, single-scalar emojis. Size is a
 * power of two (64 => 6 bits per cell) so a byte maps cleanly. Chosen to
 * avoid near-duplicates (no 😀/😃/😄 look-alikes), skin-tone modifiers,
 * ZWJ sequences and flags — anything that renders ambiguously at small
 * size or inconsistently across platforms.
 */
export const EMOJI_PALETTE: readonly string[] = [
  "🐶",
  "🐱",
  "🐭",
  "🐹",
  "🐰",
  "🦊",
  "🐻",
  "🐼",
  "🐨",
  "🐯",
  "🦁",
  "🐮",
  "🐷",
  "🐸",
  "🐵",
  "🐔",
  "🐧",
  "🐦",
  "🐤",
  "🦄",
  "🐝",
  "🐛",
  "🦋",
  "🐌",
  "🐞",
  "🐢",
  "🐍",
  "🐙",
  "🦑",
  "🦀",
  "🐡",
  "🐠",
  "🍎",
  "🍊",
  "🍋",
  "🍌",
  "🍉",
  "🍇",
  "🍓",
  "🍒",
  "🍑",
  "🍍",
  "🥝",
  "🥑",
  "🍅",
  "🍆",
  "🌽",
  "🥕",
  "🍄",
  "🥔",
  "🍞",
  "🧀",
  "🍔",
  "🍟",
  "🍕",
  "🌮",
  "🍿",
  "🍩",
  "🍪",
  "🎂",
  "🍰",
  "🍫",
  "🍬",
  "🍭",
];

/** Number of emoji cells in a standard fingerprint grid. */
export const EMOJI_HASH_COUNT = 16;
/** Columns per grid row (16 cells => 4 rows of 4). */
export const EMOJI_HASH_COLUMNS = 4;
/** Number of rows in a standard fingerprint grid. */
export const EMOJI_HASH_ROWS = Math.ceil(EMOJI_HASH_COUNT / EMOJI_HASH_COLUMNS);

/**
 * Turn a digest string into raw bytes. Hex (with or without the `0x`
 * prefix) is parsed byte-for-byte so the emoji grid tracks the actual
 * digest bytes. Non-hex encodings (e.g. a base58 Sui digest) fall back
 * to their code units — still deterministic across devices, which is all
 * the fingerprint needs.
 */
function bytesFromDigest(value: string): Uint8Array {
  const stripped = value.startsWith("0x") ? value.slice(2) : value;
  const isHex =
    stripped.length > 0 &&
    stripped.length % 2 === 0 &&
    /^[0-9a-fA-F]+$/.test(stripped);

  if (isHex) {
    const out = new Uint8Array(stripped.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = Number.parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    out[i] = value.charCodeAt(i) & 0xff;
  }
  return out;
}

/**
 * Fold a byte array down to `count` emoji cells. Every input byte is
 * mixed into exactly one cell (position included, so transposing bytes
 * changes the grid), guaranteeing that a change anywhere in the digest
 * moves at least one cell with high probability. Pure — the unit seam.
 */
export function emojiHashFromBytes(bytes: Uint8Array, count: number): string[] {
  const paletteSize = EMOJI_PALETTE.length;
  if (count <= 0) return [];

  // Degenerate input: return a fixed, non-empty grid rather than throwing
  // so the UI never crashes on an unexpected digest shape.
  if (bytes.length === 0) {
    return Array.from(
      { length: count },
      (_, i) => EMOJI_PALETTE[i % paletteSize],
    );
  }

  const acc = new Uint8Array(count);
  for (let i = 0; i < bytes.length; i++) {
    const slot = i % count;
    // Mix the position (odd multiplier) in before folding so byte order
    // matters; XOR keeps every byte's contribution visible.
    acc[slot] = (acc[slot] ^ ((bytes[i] + i * 31) & 0xff)) & 0xff;
  }
  return Array.from(acc, (a) => EMOJI_PALETTE[a % paletteSize]);
}

/**
 * Deterministic emoji fingerprint of a digest string. `count` defaults to
 * a 16-cell grid.
 */
export function emojiHash(value: string, count = EMOJI_HASH_COUNT): string[] {
  return emojiHashFromBytes(bytesFromDigest(value), count);
}

/** Chunk a flat emoji list into rows of `columns` for grid rendering. */
export function toEmojiGrid(emojis: string[], columns: number): string[][] {
  if (columns <= 0) return [emojis];
  const rows: string[][] = [];
  for (let i = 0; i < emojis.length; i += columns) {
    rows.push(emojis.slice(i, i + columns));
  }
  return rows;
}
