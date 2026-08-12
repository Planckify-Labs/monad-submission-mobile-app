/**
 * Phase A regression coverage — EIP-5792 atomicity semantics and the
 * capability dock.
 *
 * The behaviour worth pinning is the three-way atomic status. The
 * withdrawn draft expressed atomicity as a boolean, and collapsing
 * `ready` into either side of that boolean is a real defect in both
 * directions: collapsing it to `true` tells a dApp a plain EOA will
 * execute atomically, and collapsing it to `false` hides that a
 * 7702-capable wallet is one approval away from doing so.
 */

import { describe, expect, it } from "vitest";
import type { TWallet } from "@/constants/types/walletTypes";
import {
  atomicStatus,
  canExecuteAtomically,
  registerCapabilityProvider,
  resolveCapabilities,
} from "./walletCapabilities";

const ADDRESS = "0x1111111111111111111111111111111111111111" as const;

function wallet(partial: Partial<TWallet>): TWallet {
  return {
    id: "w1",
    name: "test",
    address: ADDRESS,
    namespace: "eip155",
    source: "Created",
    type: "SeedPhrase",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    account: null as any,
    ...partial,
  } as TWallet;
}

describe("atomicStatus", () => {
  it("reports a 4337 smart account as supported", () => {
    expect(atomicStatus(wallet({ type: "Smart4337" }), 1)).toBe("supported");
  });

  it("reports a delegated 7702 wallet as supported on that chain only", () => {
    const w = wallet({
      type: "Smart7702",
      smart7702: {
        signerWalletId: "w0",
        delegator: "0x2222222222222222222222222222222222222222",
        authorizationByChain: {
          1: { expiresAt: 0, nonce: 0 },
        },
      },
    });
    expect(atomicStatus(w, 1)).toBe("supported");
    // Delegation is per-chain. Reporting chain 1's authorization for
    // chain 10 would be the 7702 scoping bug in a different costume.
    expect(atomicStatus(w, 10)).toBe("ready");
  });

  it("reports an undelegated 7702 wallet as ready, not unsupported", () => {
    expect(
      atomicStatus(
        wallet({
          type: "Smart7702",
          smart7702: {
            signerWalletId: "w0",
            delegator: "0x2222222222222222222222222222222222222222",
          },
        }),
        1,
      ),
    ).toBe("ready");
  });

  it("reports a plain EOA and a missing wallet as unsupported", () => {
    expect(atomicStatus(wallet({}), 1)).toBe("unsupported");
    expect(atomicStatus(null, 1)).toBe("unsupported");
    expect(atomicStatus(undefined, 1)).toBe("unsupported");
  });
});

describe("canExecuteAtomically", () => {
  it("treats `ready` as NOT atomic", () => {
    // This is the safety-critical line. `atomicRequired: true` on a
    // wallet that could become atomic but has not yet must be rejected:
    // falling through to the sequential path can leave an approve mined
    // with its swap reverted, i.e. a live allowance the dApp believes
    // was never granted.
    const w = wallet({
      type: "Smart7702",
      smart7702: {
        signerWalletId: "w0",
        delegator: "0x2222222222222222222222222222222222222222",
      },
    });
    expect(atomicStatus(w, 1)).toBe("ready");
    expect(canExecuteAtomically(w, 1)).toBe(false);
  });

  it("allows a genuinely atomic wallet", () => {
    expect(canExecuteAtomically(wallet({ type: "Smart4337" }), 1)).toBe(true);
  });
});

describe("capability dock", () => {
  it("emits the finalized `atomic` key, not the draft `atomicBatch`", () => {
    const caps = resolveCapabilities({
      address: ADDRESS,
      chainId: 1,
      wallet: wallet({ type: "Smart4337" }),
    });
    expect(caps.atomic).toEqual({ status: "supported" });
    expect(caps).not.toHaveProperty("atomicBatch");
  });

  it("answers honestly for an address we do not hold", () => {
    const caps = resolveCapabilities({
      address: ADDRESS,
      chainId: 1,
      wallet: null,
    });
    expect(caps.atomic).toEqual({ status: "unsupported" });
  });

  it("does not leak our paymaster URL to the dApp", () => {
    // Under ERC-7677 the dApp supplies the paymaster URL, so advertising
    // ours hands every origin an infrastructure endpoint it never needs.
    const caps = resolveCapabilities({
      address: ADDRESS,
      chainId: 1,
      wallet: wallet({ type: "Smart4337" }),
    });
    expect(caps.paymasterService).not.toHaveProperty("url");
  });

  it("lets a new capability dock without touching the adapter", () => {
    registerCapabilityProvider({
      key: "__testCapability",
      resolve: (ctx) => ({ chain: ctx.chainId }),
    });
    const caps = resolveCapabilities({
      address: ADDRESS,
      chainId: 42,
      wallet: null,
    });
    expect(caps.__testCapability).toEqual({ chain: 42 });
  });

  it("skips a provider that throws rather than failing discovery", () => {
    registerCapabilityProvider({
      key: "__brokenCapability",
      resolve: () => {
        throw new Error("boom");
      },
    });
    const caps = resolveCapabilities({
      address: ADDRESS,
      chainId: 1,
      wallet: null,
    });
    expect(caps).not.toHaveProperty("__brokenCapability");
    expect(caps.atomic).toBeDefined();
  });
});
