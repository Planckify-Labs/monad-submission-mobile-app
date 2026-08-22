/**
 * Tier 4 fork tests — ERC-7540 async vaults (spec §7).
 *
 * Two things this family needs that no earlier one did, both found while
 * writing this file rather than assumed:
 *
 * **The default `FORK_BLOCKS` pin is too old for this protocol.** The first
 * attempt against `FORK_BLOCKS[1]` (23,000,000) had `requestDeposit` "succeed"
 * at 23,530 gas with zero events and no balance change — the signature of an
 * uninitialized proxy silently no-opping, not a real call. Centrifuge's V3
 * `root` deployed at block 22,924,235 (per `centrifuge/protocol`'s own
 * `env/ethereum.json`), close enough to the old pin that this vault's
 * implementation was not yet live behind it. `FORK_BLOCKS_RECENT` is
 * mandatory here, not a nice-to-have.
 *
 * **Ordinary addresses cannot deposit — by design, not by bug.** Once tested
 * against a recent block, a funded, ordinary wallet's `requestDeposit`
 * reverts with `TransferNotAllowed()` (`0x8cd22d19`, confirmed against
 * `AsyncRequestManager.sol`'s `_canTransfer` check). Janus Henderson Treasury
 * Fund is a real-world-asset security: Centrifuge enforces investor
 * eligibility ON CHAIN, and no fork cheat code can fake a real KYC decision.
 * This is exactly what a fork test SHOULD show for a compliance-gated
 * product, and it is why runbook §12.3 requirement 9 (a human running the
 * full journey with real funds) needs a wallet Centrifuge has actually
 * allowlisted for this specific pool before the family can go live — an
 * automated test can prove the calldata is correct and can prove the gate is
 * real, but it cannot stand in for that human.
 *
 * The claim side is separately not fork-testable at all: fulfilment happens
 * off-chain, on Centrifuge's own schedule, which is exactly why the durable
 * tracker (`async-claim-watcher.processor.ts`) and its notification exist —
 * the app has to survive that gap being real wall-clock time, not a fork
 * block. What IS proven here on the claim side: `buildClaimDeposit` encodes
 * the right call shape, and `AsyncVaultAdapter`'s synchronous entry points
 * refuse outright rather than routing an async vault through the one-shot
 * path (§7's core invariant).
 */

import type { Address } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { AsyncVaultAdapter } from "../adapters/asyncVault";
import { approvalsOf, type DepositTarget } from "../types";
import {
  canFork,
  dealErc20,
  dealNative,
  erc20Balance,
  executeCall,
  FORK_BLOCKS_RECENT,
  type ForkContext,
  startFork,
} from "./harness";

const ETHEREUM = 1;

/**
 * Ethereum "Janus Henderson Treasury Fund" (USDS entry), the largest pool
 * this family unlocks (~$873M). Verified on chain 2026-08-22:
 * `supportsInterface(0x2f0a18c5)` (ERC-7540) → true,
 * `VaultRegistry.isLinked` → true (the current, non-superseded vault for
 * this pool/share-class/asset — see `centrifuge.resolver.ts`).
 */
const USDS = "0xdC035D45d973E3EC169d2276DDab16f1e407384F" as Address;
const CENTRIFUGE_JTRSY_USDS_VAULT =
  "0x381f4f3b43c30b78c1f7777553236e57bb8ae9ff" as Address;
const ONE_THOUSAND_USDS = 1_000n * 10n ** 18n; // 18 dp

const describeEth = canFork(ETHEREUM) ? describe : describe.skip;

describeEth("Tier 4 — Centrifuge async vault on Ethereum", () => {
  let ctx: ForkContext;

  beforeAll(async () => {
    // Centrifuge's V3 vaults were deployed 2026 (verified via
    // `centrifuge/protocol`'s own `env/ethereum.json` — `root` at block
    // 22,924,235). The default `FORK_BLOCKS[1]` pin (23,000,000) predates
    // this vault's actual implementation being live behind its proxy: the
    // first run against it accepted `requestDeposit` (no revert, matching
    // selector) but moved no funds and emitted no event — 23,530 gas, the
    // signature of an uninitialized/old-implementation proxy silently
    // no-opping, not a real failure. `FORK_BLOCKS_RECENT` is required here.
    ctx = await startFork(ETHEREUM, { block: FORK_BLOCKS_RECENT[ETHEREUM] });
    await dealNative(ctx, ctx.account.address, 10n ** 20n);
    return async () => {
      await ctx.stop();
    };
  }, 180_000);

  it("buildRequestDeposit encodes a real call the vault evaluates — and correctly refuses a non-whitelisted address", async () => {
    // This is the honest version of "the request executes": for a
    // compliance-gated RWA fund, the CORRECT outcome for an ordinary wallet
    // is a revert, and asserting anything else would mean the test passed by
    // exercising a broken proxy (see the file header) rather than the real
    // contract. `TransferNotAllowed` is Centrifuge's OWN error, confirmed
    // against `AsyncRequestManager.sol`'s `_canTransfer` gate — reaching it
    // proves our calldata cleared `InvalidOwner`/`InsufficientBalance` and
    // is being evaluated by real business logic, not bounced by a signature
    // mismatch or an empty proxy.
    const holder = ctx.account.address;
    await dealErc20(ctx, USDS, holder, ONE_THOUSAND_USDS * 2n);
    const usdsBefore = await erc20Balance(ctx, USDS, holder);

    const target: DepositTarget = {
      kind: "async-vault",
      vault: CENTRIFUGE_JTRSY_USDS_VAULT,
      asset: USDS,
      flavor: "7540-both",
    };

    const request = await AsyncVaultAdapter.buildRequestDeposit!({
      wallet: ctx.wallet,
      chain: ctx.chain,
      asset: { symbol: "USDS", contract: USDS, decimals: 18 },
      amount: ONE_THOUSAND_USDS,
      target,
    } as never);

    // Single approval, scoped to the exact amount — never infinite. Checked
    // regardless of what the vault does with it: this is OUR code's
    // contract, not Centrifuge's.
    const approvals = approvalsOf(request);
    expect(approvals).toHaveLength(1);
    expect(approvals[0].spender.toLowerCase()).toBe(
      CENTRIFUGE_JTRSY_USDS_VAULT.toLowerCase(),
    );
    expect(approvals[0].amount).toBe(ONE_THOUSAND_USDS);

    expect(request.to.toLowerCase()).toBe(
      CENTRIFUGE_JTRSY_USDS_VAULT.toLowerCase(),
    );
    // requestDeposit(uint256,address,address) selector — confirmed against
    // `cast sig`, not assumed.
    expect((request.data as string).slice(0, 10)).toBe("0x85b77f45");

    await expect(
      executeCall(ctx, request),
      "expected TransferNotAllowed (0x8cd22d19) — a non-whitelisted " +
        "address must not be able to deposit into a compliance-gated fund",
    ).rejects.toThrow(/0x8cd22d19/);

    // The approval went through (it is an ordinary ERC-20 approve, not
    // compliance-gated), but the vault call reverted, so nothing was pulled.
    expect(await erc20Balance(ctx, USDS, holder)).toBe(usdsBefore);
  }, 240_000);

  it("buildClaimDeposit encodes deposit(assets, receiver) with no approval", async () => {
    // Proves the SHAPE the claim executor will send once the watcher marks a
    // position claimable — not that it succeeds here, which needs a REAL
    // fulfilled request (see the file header). A claim against an
    // unfulfilled request reverting is correct chain behaviour, not a test
    // failure to work around.
    const target: DepositTarget = {
      kind: "async-vault",
      vault: CENTRIFUGE_JTRSY_USDS_VAULT,
      asset: USDS,
      flavor: "7540-both",
    };
    const claimCall = await AsyncVaultAdapter.buildClaimDeposit!({
      wallet: ctx.wallet,
      chain: ctx.chain,
      asset: { symbol: "USDS", contract: USDS, decimals: 18 },
      amount: ONE_THOUSAND_USDS,
      target,
    } as never);
    expect(claimCall.kind).toBe("evm-call");
    expect((claimCall as { to: Address }).to.toLowerCase()).toBe(
      CENTRIFUGE_JTRSY_USDS_VAULT.toLowerCase(),
    );
    // deposit(uint256,address) selector.
    expect((claimCall as { data: string }).data.slice(0, 10)).toBe(
      "0x6e553f65",
    );
    expect(approvalsOf(claimCall)).toEqual([]);
  }, 60_000);

  it("refuses the synchronous entry points instead of routing an async vault through them", () => {
    // `buildDeposit`/`buildWithdraw` throw SYNCHRONOUSLY (they are typed to
    // return a Promise but are not `async` functions) — `.rejects` needs a
    // promise to unwrap, so calling them inside `expect(() => ...)` rather
    // than awaiting them directly is what actually catches the throw here.
    // In production this distinction is invisible: every real caller
    // (`agent-executors/defi/writes.ts`) invokes these inside a try/catch,
    // where a synchronous throw during argument evaluation is caught exactly
    // the same as an async rejection would be.
    const target: DepositTarget = {
      kind: "async-vault",
      vault: CENTRIFUGE_JTRSY_USDS_VAULT,
      asset: USDS,
      flavor: "7540-both",
    };
    expect(() =>
      AsyncVaultAdapter.buildDeposit({
        wallet: ctx.wallet,
        chain: ctx.chain,
        asset: { symbol: "USDS", contract: USDS, decimals: 18 },
        amount: ONE_THOUSAND_USDS,
        target,
      } as never),
    ).toThrow();
    expect(() =>
      AsyncVaultAdapter.buildWithdraw({
        wallet: ctx.wallet,
        chain: ctx.chain,
        asset: { symbol: "USDS", contract: USDS, decimals: 18 },
        amount: "MAX",
        target,
      } as never),
    ).toThrow();
  }, 60_000);
});

describe("Tier 4 fork gate", () => {
  it("is skipped unless FORK_TESTS=1 and an RPC is configured", () => {
    expect(canFork(ETHEREUM)).toBe(
      process.env.FORK_TESTS?.trim() === "1" &&
        !!process.env.FORK_RPC_URL_1?.trim(),
    );
  });
});
