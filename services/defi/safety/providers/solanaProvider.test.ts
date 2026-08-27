/**
 * The `solana` ChainSafetyProvider's PURE surface (spec §11.0b, §11.3).
 *
 * Everything here runs offline. That is the point: the two defects this file
 * was written after were both invisible to every network-backed test and both
 * shipped a family that could never execute.
 *
 *   1. `readExitTerms` was absent, so `ExitTermsConsentCheck` refused EVERY
 *      Solana deposit with `exit_terms_unknown` — a provider-shaped outage
 *      that looks, from the outside, exactly like a chain that "isn't wired
 *      up yet".
 *   2. `jupiter-lend-vault` had no entry in `destinationOf`, so Layer 1
 *      answered `target_not_a_contract` for the whole family.
 *
 * Both are the same failure mode: a kind the registry knows about and the
 * provider does not. So the ratchet here is per-kind coverage — a new Solana
 * family that forgets its provider entries fails this file rather than
 * silently degrading to a pool nobody can deposit into.
 */

import { describe, expect, it } from "vitest";
import type { DepositTarget, DepositTargetKind } from "../../types";
import { ExitTermsConsentCheck } from "../checks/layer3-policy";
import { registerChainSafetyProvider, resetSafetyRegistry } from "../registry";
import type { SafetyContext } from "../types";
import { protocolProgramFor, SolanaSafetyProvider } from "./solana";

/** A real-looking base58 account; never dereferenced (no RPC in this file). */
const ACC = "11111111111111111111111111111111";
const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/**
 * Every Solana `DepositTarget` kind the app can resolve today, with a minimal
 * instance of each. Hand-maintained ON PURPOSE: the union in `types.ts` is
 * namespace-less, so there is nothing to derive this from, and the entire
 * value of the list is that adding a Solana kind forces a deliberate edit
 * here (which is where the "did you give it exit terms?" question gets
 * asked).
 */
const SOLANA_TARGETS: readonly DepositTarget[] = [
  { kind: "solana-reserve", program: ACC, reserve: ACC, mint: ACC },
  { kind: "solana-lst-stake", venue: "jito", poolMint: ACC },
  { kind: "jupiter-lend-vault", asset: ACC },
  { kind: "kamino-kvault", vault: ACC, mint: ACC },
  { kind: "raydium-cpmm-pool", pool: ACC, mintA: ACC, mintB: ACC },
  { kind: "raydium-amm-v4-pool", pool: ACC, mintA: ACC, mintB: ACC },
  { kind: "raydium-stable-pool", pool: ACC, mintA: ACC, mintB: ACC },
  {
    kind: "kamino-liquidity-strategy",
    strategy: ACC,
    globalConfig: ACC,
    tokenAMint: ACC,
    tokenBMint: ACC,
    sharesMint: ACC,
    tokenAVault: ACC,
    tokenBVault: ACC,
    baseVaultAuthority: ACC,
    poolProgram: ACC,
    pool: ACC,
    sharesMintAuthority: ACC,
  } as unknown as DepositTarget,
  { kind: "jito-vault-deposit", vault: ACC, mint: ACC },
];

function ctxFor(target: DepositTarget): SafetyContext {
  return {
    namespace: "solana",
    action: "deposit",
    target,
    chainId: "mainnet",
    wallet: WALLET,
    requestedAmount: 1_000_000n,
    underlyingExpected: ACC,
    previewOut: null,
    tvlUsdSnapshot: null,
    sim: null,
    feeEstimate: null,
    stage: "presign",
  };
}

describe("readExitTerms (§12 Q2)", () => {
  it("characterises every registered Solana kind — none falls through to unknown", async () => {
    for (const target of SOLANA_TARGETS) {
      const terms = await SolanaSafetyProvider.readExitTerms?.(
        target,
        "mainnet",
      );
      expect(terms, `${target.kind} has no exit terms`).toBeDefined();
      expect(terms?.kind, `${target.kind} exit terms`).not.toBe("unknown");
    }
  });

  it("reports the Jito restaking vault's epoch queue rather than an invented delay", async () => {
    const terms = await SolanaSafetyProvider.readExitTerms?.(
      { kind: "jito-vault-deposit", vault: ACC, mint: ACC },
      "mainnet",
    );
    expect(terms).toEqual({ kind: "queued", source: "declared" });
  });

  it("fails closed on a kind nobody has characterised", async () => {
    const terms = await SolanaSafetyProvider.readExitTerms?.(
      {
        kind: "erc4626",
        vault: "0x0",
        asset: "0x0",
      } as unknown as DepositTarget,
      "mainnet",
    );
    expect(terms).toEqual({ kind: "unknown" });
  });

  it("lets a Solana deposit clear the Layer-3 consent gate it used to fail", async () => {
    resetSafetyRegistry();
    registerChainSafetyProvider(SolanaSafetyProvider);
    const verdict = await ExitTermsConsentCheck.run(
      ctxFor({ kind: "solana-reserve", program: ACC, reserve: ACC, mint: ACC }),
    );
    expect(verdict).toEqual({ ok: true });
    resetSafetyRegistry();
  });
});

describe("isAllowedDestination (L4 call binding)", () => {
  const kaminoIx = (programId: string) => ({
    programId: { toBase58: () => programId },
    keys: [],
    data: Buffer.alloc(0),
  });
  const KLEND = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
  const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const FOREIGN = "MaLiCiOus1111111111111111111111111111111111";
  const target: DepositTarget = {
    kind: "solana-reserve",
    program: KLEND,
    reserve: ACC,
    mint: ACC,
  };

  it("accepts the kind's own program alongside account plumbing", async () => {
    const call = {
      kind: "solana-ix",
      instructions: [kaminoIx(TOKEN), kaminoIx(KLEND)],
    } as never;
    await expect(
      SolanaSafetyProvider.isAllowedDestination?.(
        target,
        KLEND,
        "mainnet",
        call,
      ),
    ).resolves.toBe(true);
  });

  it("refuses a call carrying an instruction to any other program", async () => {
    const call = {
      kind: "solana-ix",
      instructions: [kaminoIx(KLEND), kaminoIx(FOREIGN)],
    } as never;
    await expect(
      SolanaSafetyProvider.isAllowedDestination?.(
        target,
        KLEND,
        "mainnet",
        call,
      ),
    ).resolves.toBe(false);
  });

  it("refuses a kind with no pinned program rather than passing it", async () => {
    await expect(
      SolanaSafetyProvider.isAllowedDestination?.(
        {
          kind: "erc4626",
          vault: "0x0",
          asset: "0x0",
        } as unknown as DepositTarget,
        KLEND,
        "mainnet",
      ),
    ).resolves.toBe(false);
  });
});

describe("kind coverage", () => {
  it("pins a protocol program for every Solana kind", () => {
    const uncovered: DepositTargetKind[] = [];
    for (const target of SOLANA_TARGETS) {
      // Asserted against the map itself rather than through
      // `isAllowedDestination`: from outside, "no pin for this kind" and
      // "that is not the pinned destination" both come back as a plain
      // `false`, so a test written through the predicate cannot tell the bug
      // from the expected answer — and would have passed while
      // `jupiter-lend-vault` had no pin at all.
      if (protocolProgramFor(target) === null) uncovered.push(target.kind);
    }
    expect(uncovered).toEqual([]);
  });

  it("accepts a call whose only instruction is the pinned program", async () => {
    for (const target of SOLANA_TARGETS) {
      const program = protocolProgramFor(target);
      expect(program, `${target.kind} pin`).not.toBeNull();
      await expect(
        SolanaSafetyProvider.isAllowedDestination?.(
          target,
          program as string,
          "mainnet",
        ),
        `${target.kind} accepts its own program`,
      ).resolves.toBe(true);
    }
  });
});
