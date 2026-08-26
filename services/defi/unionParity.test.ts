/**
 * `DepositTarget` union parity between the two repos (spec §8.7).
 *
 * The union lives in TWO files that both carry a "keep in sync" comment:
 *   - api/src/strategies/targets/types.ts      (backend, writes the target)
 *   - mobile-app/services/defi/types.ts        (mobile, executes it)
 *
 * A comment is not enforcement. When they drift, the failure is silent and
 * expensive: the backend resolves a target shape the mobile adapter does not
 * understand, and the pool badges "Deposit in-app" for a call that cannot be
 * built. This test is what turns the comment into a rule.
 *
 * It compares the union STRUCTURALLY — member text with comments and
 * whitespace stripped — so a doc-comment reword on one side is fine and an
 * added or renamed field is not.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MOBILE_TYPES = path.resolve(__dirname, "types.ts");
const BACKEND_TYPES = path.resolve(
  __dirname,
  "../../../api/src/strategies/targets/types.ts",
);

/** Pull `export type DepositTarget = ...;` out of a source file. */
function extractUnion(source: string): string {
  const start = source.indexOf("export type DepositTarget =");
  if (start < 0) throw new Error("DepositTarget union not found");
  // The union ends at the first line that closes it with a bare `;` — every
  // member line starts with `|` or is inside a braced member.
  const rest = source.slice(start);
  const end = rest.indexOf("\nexport type DepositTargetKind");
  if (end < 0) throw new Error("end of DepositTarget union not found");
  return rest.slice(0, end);
}

/** Strip comments and collapse whitespace so only the shape remains. */
function normalize(union: string): string {
  return union
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, "")
    .trim();
}

/** The `kind` literals, in declaration order. */
function kinds(union: string): string[] {
  return [...union.matchAll(/kind:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]);
}

describe("DepositTarget union parity (spec §8.7)", () => {
  const mobileSource = readFileSync(MOBILE_TYPES, "utf8");
  const backendSource = readFileSync(BACKEND_TYPES, "utf8");
  const mobileUnion = extractUnion(mobileSource);
  const backendUnion = extractUnion(backendSource);

  it("declares the same kinds in the same order", () => {
    expect(kinds(mobileUnion)).toEqual(kinds(backendUnion));
  });

  it("declares structurally identical members", () => {
    expect(normalize(mobileUnion)).toEqual(normalize(backendUnion));
  });

  it("keeps MorphoMarketParams identical on both sides", () => {
    const grab = (src: string) => {
      const start = src.indexOf("export interface MorphoMarketParams");
      const end = src.indexOf("}", start);
      return normalize(src.slice(start, end + 1));
    };
    expect(grab(mobileSource)).toEqual(grab(backendSource));
  });

  it("lists the same EVM kinds on both sides", () => {
    const grab = (src: string) => {
      const start = src.indexOf("export const EVM_TARGET_KINDS");
      const end = src.indexOf("] as const", start);
      return [...src.slice(start, end).matchAll(/"([a-z0-9-]+)"/g)].map(
        (m) => m[1],
      );
    };
    expect(grab(mobileSource)).toEqual(grab(backendSource));
  });

  it("covers every EVM kind that the union declares", () => {
    // A new EVM kind that forgets to join EVM_TARGET_KINDS would skip the
    // "explicit validator required" rule in §8.1 — the one thing that rule
    // exists to prevent.
    const nonEvm = new Set([
      "scallop-market",
      "ember-vault",
      "navi-pool",
      "suilend-market",
      "sui-lst",
      "kai-vault",
      "current-market",
      "cetus-clmm-pool",
      "turbos-clmm-pool",
      "bluefin-spot-pool",
      "solana-reserve",
      "solana-lst-stake",
      "jupiter-lend-vault",
      "kamino-kvault",
      "raydium-cpmm-pool",
      "raydium-amm-v4-pool",
      "raydium-stable-pool",
      "kamino-liquidity-strategy",
    ]);
    const declared = kinds(mobileUnion).filter((k) => !nonEvm.has(k));
    const evmListed = [
      ...mobileSource
        .slice(
          mobileSource.indexOf("export const EVM_TARGET_KINDS"),
          mobileSource.indexOf("] as const satisfies"),
        )
        .matchAll(/"([a-z0-9-]+)"/g),
    ].map((m) => m[1]);
    expect([...declared].sort()).toEqual([...evmListed].sort());
  });
});
