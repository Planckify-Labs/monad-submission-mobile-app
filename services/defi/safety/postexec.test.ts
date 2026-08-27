/**
 * Post-execution verification (§11 Layer 5).
 *
 * `postexec` had two checks written against it and no caller, so nothing here
 * had ever executed. Three properties matter, and each one is a bug the
 * previous shape of this code would have shipped:
 *
 *  1. **It is a DELTA.** Reading the balance after execution and asking "is it
 *     positive" passes for free for anyone who already had a position, which
 *     is exactly the case that hides a deposit that landed nowhere.
 *  2. **Direction follows the action.** A deposit-shaped assertion applied to
 *     a withdraw flags every correct withdrawal for doing its job.
 *  3. **It never throws.** The money has already moved; a refusal here is a
 *     reconciliation alert, and turning it into an error would tell users a
 *     landed deposit failed and invite them to retry it.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { DepositTarget } from "../types";
import { LAYER5_CHECKS } from "./checks/layer5-state";
import { snapshotPositionBefore, verifyPostExecution } from "./postexec";
import {
  registerChainSafetyProvider,
  registerSafetyCheck,
  resetSafetyRegistry,
} from "./registry";
import type { ChainSafetyProvider, SafetyContext } from "./types";

const VAULT = "0x2222222222222222222222222222222222222222";
const ASSET = "0x1111111111111111111111111111111111111111";
const WALLET = "0x3333333333333333333333333333333333333333";

const target: DepositTarget = { kind: "erc4626", vault: VAULT, asset: ASSET };

function provider(
  overrides: Partial<ChainSafetyProvider> = {},
): ChainSafetyProvider {
  return {
    namespace: "eip155",
    targetExists: async () => true,
    readUnderlying: async () => ASSET,
    isAllowlisted: async () => true,
    assertChainBinding: () => true,
    decodeIntent: async () => null,
    simulate: async () => ({ ok: true }),
    isProtocolHalted: async () => false,
    readPositionBalance: async () => 0n,
    ...overrides,
  };
}

function ctx(overrides: Partial<SafetyContext> = {}): SafetyContext {
  return {
    namespace: "eip155",
    action: "deposit",
    target,
    chainId: 1,
    wallet: WALLET,
    requestedAmount: 1000n,
    underlyingExpected: ASSET,
    previewOut: null,
    tvlUsdSnapshot: null,
    sim: null,
    feeEstimate: null,
    stage: "presign",
    ...overrides,
  };
}

beforeEach(() => {
  resetSafetyRegistry();
  for (const check of LAYER5_CHECKS) registerSafetyCheck(check);
});

describe("verifyPostExecution — deposit", () => {
  it("verifies when the position grew", async () => {
    registerChainSafetyProvider(
      provider({ readPositionBalance: async () => 1500n }),
    );
    const verdict = await verifyPostExecution(ctx(), {
      positionBefore: 500n,
    });
    expect(verdict.status).toBe("verified");
    expect(verdict.ran).toContain("position-delta");
  });

  it("reports a mismatch when a successful tx left the position unchanged", async () => {
    registerChainSafetyProvider(
      provider({ readPositionBalance: async () => 500n }),
    );
    const verdict = await verifyPostExecution(ctx(), {
      positionBefore: 500n,
    });
    expect(verdict.status).toBe("mismatch");
    expect(verdict.fail).toBe("submission_unconfirmed");
  });

  /**
   * The regression the old single-reading form could not catch. The user
   * already held 500; the deposit did nothing; the balance is still a healthy
   * positive number. "Balance > 0" calls that a success.
   */
  it("catches a deposit that landed nowhere for a wallet that already had a position", async () => {
    registerChainSafetyProvider(
      provider({ readPositionBalance: async () => 500n }),
    );
    const verdict = await verifyPostExecution(ctx(), { positionBefore: 500n });
    expect(verdict.status).toBe("mismatch");
  });
});

describe("verifyPostExecution — withdraw", () => {
  it("verifies when the position shrank", async () => {
    registerChainSafetyProvider(
      provider({ readPositionBalance: async () => 200n }),
    );
    const verdict = await verifyPostExecution(ctx({ action: "withdraw" }), {
      positionBefore: 1000n,
    });
    expect(verdict.status).toBe("verified");
  });

  /**
   * Direction is read from `ctx.action`. Without that the deposit-shaped
   * assertion ("must have grown") fires on every correct withdrawal.
   */
  it("does not flag a correct withdrawal as a failure", async () => {
    registerChainSafetyProvider(
      provider({ readPositionBalance: async () => 0n }),
    );
    const verdict = await verifyPostExecution(ctx({ action: "withdraw" }), {
      positionBefore: 1000n,
    });
    expect(verdict.status).not.toBe("mismatch");
  });

  it("reports a mismatch when the funds did not leave", async () => {
    registerChainSafetyProvider(
      provider({ readPositionBalance: async () => 1000n }),
    );
    const verdict = await verifyPostExecution(ctx({ action: "withdraw" }), {
      positionBefore: 1000n,
    });
    expect(verdict.status).toBe("mismatch");
  });
});

describe("verifyPostExecution — what it refuses to claim", () => {
  it("is unverified, not verified, when no snapshot was taken", async () => {
    registerChainSafetyProvider(
      provider({ readPositionBalance: async () => 9999n }),
    );
    const verdict = await verifyPostExecution(ctx(), { positionBefore: null });
    expect(verdict.status).toBe("unverified");
    expect(verdict.reason).toBe("no_snapshot");
  });

  /**
   * An unreadable position is the one case where asserting a delta would
   * raise an alarm about money that moved perfectly well.
   */
  it("is unverified, not a mismatch, when the post-execution read fails", async () => {
    registerChainSafetyProvider(
      provider({ readPositionBalance: async () => null }),
    );
    const verdict = await verifyPostExecution(ctx(), { positionBefore: 500n });
    expect(verdict.status).not.toBe("mismatch");
  });

  it("is unverified when no target was ever resolved", async () => {
    registerChainSafetyProvider(provider());
    const verdict = await verifyPostExecution(ctx({ target: undefined }), {
      positionBefore: 0n,
    });
    expect(verdict.status).toBe("unverified");
    expect(verdict.reason).toBe("no_target");
  });

  /**
   * A pipeline that selected nothing is not a verification. Without this, a
   * check that silently stopped applying would be indistinguishable from one
   * that passed.
   */
  it("is unverified when no check actually ran", async () => {
    resetSafetyRegistry();
    registerChainSafetyProvider(provider());
    const verdict = await verifyPostExecution(ctx(), { positionBefore: 0n });
    expect(verdict.status).toBe("unverified");
    expect(verdict.reason).toBe("checks_skipped");
  });

  it("never throws, even when the provider does", async () => {
    registerChainSafetyProvider(
      provider({
        readPositionBalance: async () => {
          throw new Error("rpc down");
        },
      }),
    );
    const verdict = await verifyPostExecution(ctx(), { positionBefore: 500n });
    // The runner converts a throwing check into a failure, so this surfaces
    // as a mismatch rather than an exception. What must never happen is the
    // throw escaping into the caller, where it would fail a landed deposit.
    expect(["mismatch", "unverified"]).toContain(verdict.status);
  });
});

describe("snapshotPositionBefore", () => {
  it("returns null rather than zero when the position cannot be read", async () => {
    registerChainSafetyProvider(
      provider({ readPositionBalance: async () => null }),
    );
    expect(await snapshotPositionBefore(ctx())).toBeNull();
  });

  /**
   * A wallet with no position yet reads a real zero, and a first deposit has
   * to be measurable against it. Collapsing "no position" into "unreadable"
   * would make the most valuable case the one that never gets verified.
   */
  it("returns 0n for a wallet that has not deposited here yet", async () => {
    registerChainSafetyProvider(
      provider({ readPositionBalance: async () => 0n }),
    );
    expect(await snapshotPositionBefore(ctx())).toBe(0n);
  });

  it("returns null when the provider throws", async () => {
    registerChainSafetyProvider(
      provider({
        readPositionBalance: async () => {
          throw new Error("rpc down");
        },
      }),
    );
    expect(await snapshotPositionBefore(ctx())).toBeNull();
  });

  it("returns null when there is no target to read", async () => {
    registerChainSafetyProvider(provider());
    expect(await snapshotPositionBefore(ctx({ target: undefined }))).toBeNull();
  });
});

describe("stage scoping around postexec", () => {
  /**
   * `ProtocolHaltedCheck` used to carry no stage scope, so wiring `postexec`
   * would have started asking "is this protocol paused?" about a deposit that
   * had already settled — an extra RPC read per transaction, and a flag on a
   * pause that began AFTER the user's funds were already in.
   */
  it("does not run the protocol-pause check after execution", async () => {
    registerChainSafetyProvider(
      provider({
        isProtocolHalted: async () => true,
        readPositionBalance: async () => 1500n,
      }),
    );
    const verdict = await verifyPostExecution(ctx(), { positionBefore: 500n });
    expect(verdict.ran).not.toContain("protocol-halted");
    expect(verdict.status).toBe("verified");
  });
});
