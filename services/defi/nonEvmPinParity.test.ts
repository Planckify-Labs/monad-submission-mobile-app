/**
 * Solana program-id and Sui package/venue parity between the two repos.
 *
 * `addressBookParity.test.ts` does this for EVM and says why: the same address
 * is pinned twice on purpose (§11.1 wants two INDEPENDENT trust anchors), and
 * independent does not mean allowed to disagree. Everything that file argues
 * applies here — it just stopped at the EVM boundary, so the Solana program
 * ids and Sui venue tables added since were pinned in two, sometimes three
 * places with nothing comparing them.
 *
 * The stakes are the same in both directions:
 *   - device stricter → the backend resolves a target, the card badges
 *     "Deposit in-app", and Layer 1 refuses it at signing time.
 *   - device looser  → the device would accept a destination the backend
 *     never pinned, which is the hole the allowlist exists to close.
 *
 * Worth remembering while reading: the FIRST time the EVM sign-off was run
 * properly it found three wrong addresses out of 125. These pins have never
 * had an equivalent pass.
 *
 * Backend files are read as TEXT rather than imported — importing them would
 * drag Nest/viem server deps into the mobile test runtime (same technique as
 * `addressBookParity.test.ts` / `unionParity.test.ts`).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SOLANA_LST_VENUES } from "./adapters/solana/lst.config";
import { getLstConfig, SUI_LST_VENUES } from "./adapters/sui/lst.config";
import { protocolProgramFor } from "./safety/providers/solana";
import type { DepositTarget } from "./types";

const BACKEND_TARGETS = path.resolve(
  __dirname,
  "../../../api/src/strategies/targets",
);

function backendSource(file: string): string {
  return readFileSync(path.join(BACKEND_TARGETS, file), "utf8");
}

/**
 * Pull `export const NAME =\n  "value";` out of a backend source file. Written
 * against the shape those constants actually have (the formatter wraps the
 * value onto its own line), and asserts a hit rather than returning null — a
 * renamed constant must fail loudly, not silently compare nothing.
 */
function backendConst(file: string, name: string): string {
  const source = backendSource(file);
  const match = source.match(
    new RegExp(`export const ${name}\\s*=\\s*\\n?\\s*"([^"]+)"`),
  );
  expect(match, `${name} not found in api/${file}`).toBeTruthy();
  return (match as RegExpMatchArray)[1];
}

/** The device's pin for a kind, read through the map the checks actually use. */
function devicePin(target: DepositTarget): string | null {
  return protocolProgramFor(target);
}

const ACC = "11111111111111111111111111111111";

describe("Solana program ids agree across repos", () => {
  const cases: {
    label: string;
    target: DepositTarget;
    file: string;
    constant: string;
  }[] = [
    {
      label: "Kamino Lend (klend)",
      target: { kind: "solana-reserve", program: ACC, reserve: ACC, mint: ACC },
      file: "kamino-lend.resolver.ts",
      constant: "KAMINO_LEND_PROGRAM_ID",
    },
    {
      label: "Kamino kliquidity",
      target: {
        kind: "kamino-liquidity-strategy",
        strategy: ACC,
      } as unknown as DepositTarget,
      file: "kamino-liquidity.resolver.ts",
      constant: "KAMINO_LIQUIDITY_PROGRAM_ID",
    },
    {
      label: "Raydium CPMM",
      target: {
        kind: "raydium-cpmm-pool",
        pool: ACC,
        mintA: ACC,
        mintB: ACC,
      },
      file: "raydium-cpmm.resolver.ts",
      constant: "RAYDIUM_CPMM_PROGRAM_ID",
    },
    {
      label: "Raydium AMM v4",
      target: {
        kind: "raydium-amm-v4-pool",
        pool: ACC,
        mintA: ACC,
        mintB: ACC,
      },
      file: "raydium-amm-v4.resolver.ts",
      constant: "RAYDIUM_AMM_V4_PROGRAM_ID",
    },
    {
      label: "Raydium Stable Swap (v5)",
      target: {
        kind: "raydium-stable-pool",
        pool: ACC,
        mintA: ACC,
        mintB: ACC,
      },
      file: "raydium-stable.resolver.ts",
      constant: "RAYDIUM_STABLE_PROGRAM_ID",
    },
  ];

  for (const { label, target, file, constant } of cases) {
    it(`${label}: device pin === backend pin`, () => {
      expect(devicePin(target)).toBe(backendConst(file, constant));
    });
  }
});

describe("LST venue tables agree across repos", () => {
  it("Solana: the same venues exist on both sides", () => {
    // A venue only the backend knows resolves a target no adapter can build
    // (the pool badges "Deposit in-app" and fails); a venue only the device
    // knows is dead config. Mints are NOT compared: the backend pins
    // `poolMint` while the device reads `StakePool.pool_mint` live, which is
    // a deliberate difference rather than drift.
    const backend = backendSource("solana-lst.config.ts");
    const declared = [...backend.matchAll(/venue:\s*"([a-z0-9-]+)"/g)].map(
      (m) => m[1],
    );
    expect(declared.length).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...SOLANA_LST_VENUES].sort());
  });

  it("Sui: the same venues exist on both sides, with the same receipt coin type", () => {
    const backend = backendSource("sui-lst.config.ts");
    const rows = [
      ...backend.matchAll(
        /venue:\s*"([a-z0-9-]+)"[\s\S]*?lstType:\s*\n?\s*"([^"]+)"/g,
      ),
    ];
    const backendByVenue = new Map(rows.map((m) => [m[1], m[2]]));
    expect([...backendByVenue.keys()].sort()).toEqual(
      [...SUI_LST_VENUES].sort(),
    );
    for (const venue of SUI_LST_VENUES) {
      expect(getLstConfig(venue).lstType, `${venue} lstType`).toBe(
        backendByVenue.get(venue),
      );
    }
  });
});
