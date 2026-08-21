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
import { LST_VENUE_CONFIGS } from "./adapters/lst.config";
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

/**
 * LST venue parity.
 *
 * The venue book is duplicated the same way the singleton addresses are —
 * `api/.../address-book/lst.ts` for resolution and validation, this repo's
 * `adapters/lst.config.ts` for the call shape — and until now nothing checked
 * that the two agreed. Morpho, Pendle, Uniswap and Aave all had a guard; the
 * venues, which are the rows that decide where a native-coin STAKE is sent,
 * did not.
 *
 * A drift here fails the same two ways as any other: a wrong `entry` sends the
 * stake to the wrong contract, and a wrong `shape` encodes a call the contract
 * does not have. Both are silent until someone stakes.
 *
 * Only the fields both sides carry are compared. `exit` lives on the backend
 * alone by design — it is stamped onto the resolved target and read from there
 * (`safety/providers/eip155.ts`), so the device never keeps its own copy.
 */
describe("LST venue parity between mobile and backend", () => {
  const source = backendSource("lst");

  /**
   * Slice an `export const NAME ... ];` ARRAY out of the backend source.
   *
   * `extractDeclaration` above is written for object literals: it looks for
   * `\n};` and, failing that, falls back to the first `;`. Neither terminator
   * is right for an array, and the fallback is actively wrong — the first
   * semicolon in `LST_VENUES` sits inside a prose comment, so it silently
   * returned the first four venues and the comparison passed vacuously on the
   * rest. Hence a separate, array-aware helper.
   */
  function extractArray(src: string, name: string): string {
    const start = src.indexOf(`export const ${name}`);
    if (start < 0) throw new Error(`${name} not found in backend book`);
    const rest = src.slice(start);
    // Both terminators occur in the book: `] as const;` for the frozen
    // deferred list, plain `];` for the typed venue array.
    const end = [rest.indexOf("\n] as const;"), rest.indexOf("\n];")]
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0];
    if (end === undefined) throw new Error(`${name} array is unterminated`);
    return rest.slice(0, end);
  }

  /** One `{ … }` object literal per venue, sliced out of the backend array. */
  function backendVenues(): Map<string, Record<string, string>> {
    const decl = extractArray(source, "LST_VENUES");
    const out = new Map<string, Record<string, string>>();
    for (const m of decl.matchAll(/key:\s*"([^"]+)"/g)) {
      const key = m[1];
      // Fields are read from the slice that starts at this venue's `key:` and
      // runs to the next one, so a neighbour's value cannot bleed in.
      const from = m.index ?? 0;
      const nextKey = decl.slice(from + 1).search(/\n\s*key:\s*"/);
      const slice =
        nextKey < 0 ? decl.slice(from) : decl.slice(from, from + 1 + nextKey);
      const field = (name: string): string => {
        const hit = slice.match(new RegExp(`${name}:\\s*"([^"]+)"`));
        return hit ? hit[1] : "";
      };
      out.set(key, {
        entry: field("entry").toLowerCase(),
        receipt: field("receipt").toLowerCase(),
        shape: field("shape"),
        previewView: field("previewView"),
      });
    }
    return out;
  }

  const backend = backendVenues();

  it("extracts the backend venues it is about to compare", () => {
    // Guards the regex itself: a refactor that renamed the array or reshaped
    // the rows would otherwise make every assertion below vacuously pass.
    expect(backend.size).toBeGreaterThanOrEqual(LST_VENUE_CONFIGS.length);
    for (const [key, v] of backend) {
      expect(v.entry, `${key} entry`).toMatch(/^0x[0-9a-f]{40}$/);
      expect(v.receipt, `${key} receipt`).toMatch(/^0x[0-9a-f]{40}$/);
      expect(v.shape, `${key} shape`).not.toEqual("");
    }
  });

  it("pins the same entry, receipt and shape for every shared venue", () => {
    const mismatches: string[] = [];
    for (const venue of LST_VENUE_CONFIGS) {
      const b = backend.get(venue.key);
      if (!b) {
        mismatches.push(`${venue.key}: on device but not in the backend book`);
        continue;
      }
      if (b.entry !== venue.entry.toLowerCase())
        mismatches.push(
          `${venue.key} entry: backend ${b.entry} vs mobile ${venue.entry.toLowerCase()}`,
        );
      if (b.receipt !== venue.receipt.toLowerCase())
        mismatches.push(
          `${venue.key} receipt: backend ${b.receipt} vs mobile ${venue.receipt.toLowerCase()}`,
        );
      if (b.shape !== venue.shape)
        mismatches.push(
          `${venue.key} shape: backend ${b.shape} vs mobile ${venue.shape}`,
        );
    }
    expect(mismatches).toEqual([]);
  });

  it("agrees on the preview view wherever the shape carries slippage", () => {
    // A min-out shape with no quote could only ship a zero floor, which §12 Q4
    // forbids outright — so the two sides must name the same view, not merely
    // both have one.
    const mismatches: string[] = [];
    for (const venue of LST_VENUE_CONFIGS) {
      const b = backend.get(venue.key);
      if (!b) continue;
      if ((b.previewView || "") !== (venue.previewView || ""))
        mismatches.push(
          `${venue.key} previewView: backend "${b.previewView}" vs mobile "${venue.previewView ?? ""}"`,
        );
    }
    expect(mismatches).toEqual([]);
  });

  it("never ships a venue the backend defers", () => {
    // `LST_VENUES_DEFERRED` is the list of venues withheld for a stated reason
    // (no permissionless mint, KYC-gated, an unverified shape). A device
    // config for one of those would build a call the backend will never
    // resolve a target for — or worse, would if someone wired it locally.
    const deferred = extractArray(source, "LST_VENUES_DEFERRED");
    const withheld = new Set(
      [...deferred.matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    );
    const shipped = LST_VENUE_CONFIGS.filter((v) => withheld.has(v.key)).map(
      (v) => v.key,
    );
    expect(shipped).toEqual([]);
  });
});
