/**
 * The gate that makes end-to-end rehearsal a rule instead of a runbook step.
 *
 * ## Why a test and not a checklist item
 *
 * Runbook §12.3 requirement 9 — "a human ran it end to end" — is prose, and
 * prose is what gets skipped when a family looks obviously fine. Every other
 * invariant in this system that mattered was eventually converted into
 * something that fails a build: `unionParity.test.ts` for the two
 * `DepositTarget` declarations, `addressBookParity.test.ts` for the two address
 * books, `registryParity.test.ts` for the tool registries. This is the same
 * move for execution coverage.
 *
 * ## What it asserts
 *
 *   1. Every chain a user can actually reach DeFi on has a pinned fork block,
 *      and the three pin tables agree with each other.
 *   2. Every EVM execution shape is either proven end to end through the real
 *      executors (`EXECUTOR_FORK_CASES`) or explicitly listed as backlog with
 *      a reason (`GATE4_BACKLOG`).
 *   3. Every Gate-4 case is internally coherent and points at a pinned chain.
 *
 * ## Why (2) is a ratchet rather than a demand for full coverage
 *
 * Requiring a Gate-4 case for all twelve EVM kinds on day one would make this
 * permanently red, and the runbook is explicit that a permanently-red check is
 * a disabled check (§11.5, "trains people to ignore red"). So the backlog
 * starts full and the gate fails only on DRIFT — a new execution shape landing
 * with nobody having decided about it. That is the actual failure mode: not
 * "we know this is untested", but "nobody noticed it was".
 *
 * This file runs with no anvil, no fork RPC and no network, so it runs on every
 * build.
 */

import { describe, expect, it } from "vitest";
import { EVM_TARGET_KINDS } from "../types";
import { EXECUTOR_FORK_CASES, GATE4_BACKLOG } from "./executorCases";
import {
  DEFI_LIVE_CHAINS,
  FORK_BLOCKS,
  FORK_BLOCKS_RECENT,
  PIN_STALE_AFTER_BLOCKS,
} from "./harness";

describe("fork coverage — chains", () => {
  it("pins a fork block for every chain DeFi is live on", () => {
    const missing = DEFI_LIVE_CHAINS.filter((id) => !FORK_BLOCKS[id]);
    expect(
      missing,
      `No FORK_BLOCKS pin for chain(s) ${missing.join(", ")}. A chain the API ` +
        "seeds is a chain users can deposit on, so an unpinned one means no " +
        "case has ever executed there. Read the head from the chain and add a " +
        "pin — do not invent a block number.",
    ).toEqual([]);
  });

  it("pins a near-head block for every chain DeFi is live on", () => {
    const missing = DEFI_LIVE_CHAINS.filter((id) => !FORK_BLOCKS_RECENT[id]);
    expect(
      missing,
      `No FORK_BLOCKS_RECENT pin for chain(s) ${missing.join(", ")}. Without ` +
        "one, a protocol that did not exist at the older pin cannot be fork-" +
        "tested at all (harness.ts explains the two-pin scheme).",
    ).toEqual([]);
  });

  it("declares a staleness budget for every pinned chain", () => {
    // Per-chain because block times differ by an order of magnitude. A shared
    // limit would call an Arbitrum pin stale eight times too early, which
    // reads as a broken harness rather than as an aged pin.
    const pinned = Object.keys(FORK_BLOCKS).map(Number);
    const missing = pinned.filter((id) => !PIN_STALE_AFTER_BLOCKS[id]);
    expect(
      missing,
      `No PIN_STALE_AFTER_BLOCKS entry for chain(s) ${missing.join(", ")}. ` +
        "Without it the harness cannot tell you the fork is testing history.",
    ).toEqual([]);
  });

  it("keeps the near-head pin ahead of the stable pin", () => {
    for (const [id, recent] of Object.entries(FORK_BLOCKS_RECENT)) {
      const stable = FORK_BLOCKS[Number(id)];
      if (!stable) continue;
      expect(
        recent > stable,
        `chain ${id}: FORK_BLOCKS_RECENT (${recent}) must be AHEAD of ` +
          `FORK_BLOCKS (${stable}) — the whole point of the second pin is to ` +
          "reach protocols that did not exist at the first.",
      ).toBe(true);
    }
  });
});

describe("fork coverage — execution shapes", () => {
  const provenKinds = new Set(EXECUTOR_FORK_CASES.map((c) => c.target.kind));

  it("accounts for every EVM execution shape", () => {
    const unaccounted = EVM_TARGET_KINDS.filter(
      (kind) => !provenKinds.has(kind) && !GATE4_BACKLOG[kind],
    );
    expect(
      unaccounted,
      `EVM execution shape(s) ${unaccounted.join(", ")} have no Gate-4 case ` +
        "and no stated backlog reason.\n\n" +
        "A new kind means a new calling convention for user funds. Either add " +
        "a row to EXECUTOR_FORK_CASES proving a deposit and a MAX withdraw " +
        "through the real executors, or add a GATE4_BACKLOG entry saying why " +
        "not. Do not delete the kind from EVM_TARGET_KINDS to make this pass.",
    ).toEqual([]);
  });

  it("does not leave a proven shape sitting in the backlog", () => {
    // The backlog must shrink honestly: a kind leaves it by being proven, and
    // a stale entry would understate coverage and keep a real case invisible.
    const stale = Object.keys(GATE4_BACKLOG).filter((kind) =>
      provenKinds.has(kind),
    );
    expect(
      stale,
      `${stale.join(", ")} now has a Gate-4 case — remove the GATE4_BACKLOG ` +
        "entry so the list reflects what is actually still uncovered.",
    ).toEqual([]);
  });

  it("only lists real EVM kinds as backlog", () => {
    const unknown = Object.keys(GATE4_BACKLOG).filter(
      (kind) => !(EVM_TARGET_KINDS as readonly string[]).includes(kind),
    );
    expect(
      unknown,
      `GATE4_BACKLOG names ${unknown.join(", ")}, which is not an EVM target ` +
        "kind. A renamed kind must be renamed here too, or its coverage gap " +
        "silently stops being tracked.",
    ).toEqual([]);
  });

  it("states a reason for every backlog entry", () => {
    for (const [kind, reason] of Object.entries(GATE4_BACKLOG)) {
      expect(
        reason.trim().length,
        `GATE4_BACKLOG["${kind}"] has no reason. "Why is this acceptable" is ` +
          "the only thing that makes an exemption reviewable.",
      ).toBeGreaterThan(20);
    }
  });
});

describe("fork coverage — case hygiene", () => {
  it("targets a pinned chain in every case", () => {
    for (const c of EXECUTOR_FORK_CASES) {
      expect(
        FORK_BLOCKS[c.chainId],
        `case "${c.name}" runs on chain ${c.chainId}, which has no fork pin.`,
      ).toBeDefined();
    }
  });

  it("declares a distinct pool id per case", () => {
    // The fake backend keys its pool rows by id, so a duplicate would make one
    // case silently deposit against another's target.
    const ids = EXECUTOR_FORK_CASES.map((c) => c.poolId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("funds a non-zero amount and tolerates only sub-unit dust", () => {
    for (const c of EXECUTOR_FORK_CASES) {
      expect(c.amount, `case "${c.name}" deposits nothing`).toBeGreaterThan(0n);
      expect(
        c.maxDust < c.amount / 1_000n,
        `case "${c.name}" tolerates ${c.maxDust} dust against a ${c.amount} ` +
          "deposit — that is loose enough to pass a withdraw that left real " +
          "money behind.",
      ).toBe(true);
    }
  });

  it("registers an adapter that can actually serve the case", () => {
    // Either route is legitimate and BOTH occur in production:
    //   by slug — bespoke single-market venues (compound-v3, lido);
    //   by kind — generic family adapters, where `protocol_slug` is the
    //             DeFiLlama project slug no adapter claims (erc4626 serving
    //             Sky/Morpho/Yearn/Euler). `getDefiAdapterForTarget` prefers
    //             the kind, so a case may legitimately have neither slug in
    //             its adapter list.
    for (const c of EXECUTOR_FORK_CASES) {
      const bySlug = c.adapters.some((a) => a.slug === c.protocolSlug);
      const byKind = c.adapters.some((a) =>
        (a.targetKinds ?? []).includes(c.target.kind),
      );
      expect(
        bySlug || byKind,
        `case "${c.name}" routes protocol_slug "${c.protocolSlug}" with a ` +
          `"${c.target.kind}" target, but registers ` +
          `${c.adapters.map((a) => a.slug).join(", ")} — neither claims the ` +
          "slug nor declares the kind, so nothing can build the deposit.",
      ).toBe(true);
    }
  });
});
