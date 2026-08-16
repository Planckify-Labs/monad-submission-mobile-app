/**
 * Address parity between the two repos.
 *
 * The same contract addresses are pinned twice — once in the backend book
 * (`api/src/strategies/targets/address-book/`) and once on the device
 * (`services/defi/constants/`). That duplication is deliberate: §11.1 wants two
 * INDEPENDENT trust anchors, and a device that checked a router against a list
 * the server sent it would not be checking anything.
 *
 * Independent does not mean allowed to disagree. If the two copies drift, the
 * failure is nasty in both directions:
 *
 *   - device stricter → the backend resolves a target, the card badges "Deposit
 *     in-app", and the adapter refuses at signing time.
 *   - device looser  → the device would accept a `to` the backend never pinned,
 *     which is the exact hole the allowlist exists to close.
 *
 * So: two copies, one value, enforced here. Same pattern as `unionParity.test.ts`
 * — the backend file is read as TEXT rather than imported, because importing it
 * would drag Nest/viem server deps into the mobile test runtime.
 *
 * This test is the one that catches a mistyped or stale address between repos.
 * It was written after `AAVE_V3.base.pool` was found to disagree with the
 * backend's Base Pool.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AAVE_V3 } from "./constants/addresses";
import {
  MORPHO_BLUE_SINGLETONS,
  PENDLE_ROUTER,
  UNISWAP_V3_POSITION_MANAGERS,
  UNISWAP_V4_POSITION_MANAGERS,
} from "./constants/evmAddressBook";

const BACKEND_BOOK = path.resolve(
  __dirname,
  "../../../api/src/strategies/targets/address-book",
);

function backendSource(file: string): string {
  return readFileSync(path.join(BACKEND_BOOK, `${file}.ts`), "utf8");
}

/**
 * Slice `export const NAME ... };` out of a source file. Text extraction keeps
 * this test free of the backend's imports; the shapes involved are flat maps,
 * so a regex is enough and a malformed extraction fails loudly below.
 */
function extractDeclaration(source: string, name: string): string {
  const start = source.indexOf(`export const ${name}`);
  if (start < 0) throw new Error(`${name} not found in backend address book`);
  const rest = source.slice(start);
  const end = rest.indexOf("\n};");
  // A single-line constant (`export const PENDLE_ROUTER = "0x..." as Address;`)
  // has no closing brace — fall back to the statement terminator.
  if (end < 0) {
    const semi = rest.indexOf(";");
    if (semi < 0) throw new Error(`${name} declaration is unterminated`);
    return rest.slice(0, semi);
  }
  return rest.slice(0, end);
}

/** `{ 1: "0xabc", 8453: "0xdef" }` → Map(chainId → address). */
function chainIdToAddress(declaration: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const m of declaration.matchAll(/(\d+)\s*:\s*"(0x[0-9a-fA-F]{40})"/g)) {
    out.set(Number(m[1]), m[2].toLowerCase());
  }
  return out;
}

/** The single address in a one-line constant. */
function soleAddress(declaration: string): string {
  const m = declaration.match(/"(0x[0-9a-fA-F]{40})"/);
  if (!m) throw new Error(`no address in: ${declaration.slice(0, 80)}`);
  return m[1].toLowerCase();
}

function lower(record: Readonly<Record<number, string>>): Map<number, string> {
  return new Map(
    Object.entries(record).map(([k, v]) => [Number(k), v.toLowerCase()]),
  );
}

/**
 * Every chain BOTH sides pin must agree. A chain only one side knows about is
 * not drift — the device ships a subset (it only needs the singletons it cannot
 * read off a resolved target), and the backend may pin a chain the app has not
 * enabled yet.
 */
function assertOverlapAgrees(
  backend: Map<number, string>,
  mobile: Map<number, string>,
  label: string,
): void {
  const mismatches: string[] = [];
  for (const [chainId, mobileAddr] of mobile) {
    const backendAddr = backend.get(chainId);
    if (!backendAddr) continue;
    if (backendAddr !== mobileAddr) {
      mismatches.push(
        `${label} chain=${chainId}: backend ${backendAddr} vs mobile ${mobileAddr}`,
      );
    }
  }
  expect(mismatches).toEqual([]);
}

describe("address-book parity between mobile and backend", () => {
  const lending = backendSource("lending");
  const dex = backendSource("dex");

  it("extracts the backend declarations it is about to compare", () => {
    // Guards the parser: a rename on the backend side would otherwise make
    // every comparison below pass against an empty map.
    expect(
      chainIdToAddress(extractDeclaration(lending, "AAVE_V3_POOLS")).size,
    ).toBeGreaterThan(3);
    expect(
      chainIdToAddress(extractDeclaration(lending, "MORPHO_BLUE_SINGLETONS"))
        .size,
    ).toBeGreaterThan(0);
    expect(
      chainIdToAddress(extractDeclaration(dex, "UNISWAP_V3_POSITION_MANAGERS"))
        .size,
    ).toBeGreaterThan(0);
  });

  it("pins the same Morpho Blue singleton on both sides", () => {
    assertOverlapAgrees(
      chainIdToAddress(extractDeclaration(lending, "MORPHO_BLUE_SINGLETONS")),
      lower(MORPHO_BLUE_SINGLETONS),
      "morpho-blue",
    );
  });

  it("pins the same Pendle router on both sides", () => {
    // The router allowlist is the device's independent check on a quote's `to`
    // (§6 guardrail 2). A drift here silently disarms it.
    expect(soleAddress(extractDeclaration(dex, "PENDLE_ROUTER"))).toBe(
      PENDLE_ROUTER.toLowerCase(),
    );
  });

  it("pins the same Uniswap position managers on both sides", () => {
    assertOverlapAgrees(
      chainIdToAddress(extractDeclaration(dex, "UNISWAP_V3_POSITION_MANAGERS")),
      lower(UNISWAP_V3_POSITION_MANAGERS),
      "uniswap-v3",
    );
    assertOverlapAgrees(
      chainIdToAddress(extractDeclaration(dex, "UNISWAP_V4_POSITION_MANAGERS")),
      lower(UNISWAP_V4_POSITION_MANAGERS),
      "uniswap-v4",
    );
  });

  it("pins the same Aave v3 Pool on both sides", () => {
    // `constants/addresses.ts` keys by chain NAME with the id inside, so this
    // projects it onto the backend's chainId-keyed book before comparing.
    const mobile = new Map<number, string>();
    for (const entry of Object.values(AAVE_V3)) {
      mobile.set(entry.chainId, entry.pool.toLowerCase());
    }
    assertOverlapAgrees(
      chainIdToAddress(extractDeclaration(lending, "AAVE_V3_POOLS")),
      mobile,
      "aave-v3 Pool",
    );
  });
});
