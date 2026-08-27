/**
 * Exit-terms consent gate (§11 Layer 3, §12 Q2).
 *
 * The property under test is that a lockup can never be entered silently. A
 * deposit the user cannot exit is a real loss even though nothing is stolen,
 * and the ERC-4626 interface cannot distinguish a liquid vault from one that
 * holds funds for 30 days, so every path that cannot PROVE a liquid exit has to
 * refuse. Most cases here are refusals for exactly that reason.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { DepositTarget } from "../types";
import { ExitTermsConsentCheck } from "./checks/layer3-policy";
import {
  peekExitConsent,
  recordExitConsent,
  resetExitConsent,
  takeExitConsent,
} from "./exitConsent";
import { exitTermsNotice, formatExitDelay } from "./exitCopy";
import { registerChainSafetyProvider, resetSafetyRegistry } from "./registry";
import type { ChainSafetyProvider, ExitTerms, SafetyContext } from "./types";
import { exitDelaySeconds, exitNeedsConsent } from "./types";

const VAULT = "0x2222222222222222222222222222222222222222";
const ASSET = "0x1111111111111111111111111111111111111111";
const WALLET = "0x3333333333333333333333333333333333333333";
const THIRTY_DAYS = 30 * 24 * 3600;

const target: DepositTarget = { kind: "erc4626", vault: VAULT, asset: ASSET };

function provider(
  readExitTerms?: ChainSafetyProvider["readExitTerms"],
): ChainSafetyProvider {
  return {
    namespace: "eip155",
    targetExists: async () => true,
    readUnderlying: async () => ASSET,
    isAllowlisted: async () => true,
    assertChainBinding: () => true,
    decodeIntent: async () => ({
      destination: VAULT,
      action: "deposit",
      assetIn: ASSET,
      amountIn: 1000n,
      recipient: WALLET,
      valueNative: 0n,
      spender: VAULT,
      approvalAmount: 1000n,
      minOut: null,
      deadline: null,
    }),
    simulate: async () => ({ ok: true }),
    isProtocolHalted: async () => false,
    readPositionBalance: async () => 1n,
    readDecimals: async () => 6,
    ...(readExitTerms ? { readExitTerms } : {}),
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
    tvlUsdSnapshot: 1_000_000,
    sim: null,
    feeEstimate: null,
    stage: "presign",
    ...overrides,
  };
}

const withTerms = (t: ExitTerms) =>
  registerChainSafetyProvider(provider(async () => t));

beforeEach(() => {
  resetSafetyRegistry();
});

describe("ExitTermsConsentCheck", () => {
  it("allows a proven-instant exit with no acknowledgement needed", async () => {
    withTerms({ kind: "instant" });
    await expect(ExitTermsConsentCheck.run(ctx())).resolves.toEqual({
      ok: true,
    });
  });

  it("refuses a lockup the user was never shown", async () => {
    // The headline case: usd-ai's "30d unlock" deposits fine and then cannot be
    // withdrawn for a month. Silence is not consent.
    withTerms({ kind: "delayed", seconds: THIRTY_DAYS, source: "onchain" });
    await expect(ExitTermsConsentCheck.run(ctx())).resolves.toMatchObject({
      ok: false,
      fail: "exit_delay_not_acknowledged",
    });
  });

  it("allows a lockup the user explicitly accepted", async () => {
    withTerms({ kind: "delayed", seconds: THIRTY_DAYS, source: "onchain" });
    await expect(
      ExitTermsConsentCheck.run(ctx({ exitDelayAcknowledgedSec: THIRTY_DAYS })),
    ).resolves.toEqual({ ok: true });
  });

  it("refuses when the protocol raised its cooldown after the user agreed", async () => {
    // `cooldownDuration()` is mutable (Ethena's own max is 90 days). The user
    // consented to what they were SHOWN, so a longer lock needs asking again.
    withTerms({ kind: "delayed", seconds: THIRTY_DAYS, source: "onchain" });
    await expect(
      ExitTermsConsentCheck.run(ctx({ exitDelayAcknowledgedSec: 86_400 })),
    ).resolves.toMatchObject({
      ok: false,
      fail: "exit_delay_not_acknowledged",
    });
  });

  it("refuses a queued exit with no acknowledgement, and allows it with one", async () => {
    withTerms({ kind: "queued", source: "onchain" });
    await expect(ExitTermsConsentCheck.run(ctx())).resolves.toMatchObject({
      ok: false,
      fail: "exit_delay_not_acknowledged",
    });
    await expect(
      ExitTermsConsentCheck.run(ctx({ exitDelayAcknowledgedSec: 0 })),
    ).resolves.toEqual({ ok: true });
  });

  it("lets a REVIEWED (declared) lockup through without per-deposit consent", async () => {
    // ether.fi and Rocket Pool are live and in-app today; their queue exit is
    // recorded in the venue book and enforced by the adapter (§12 Q2). Asking
    // again per deposit would break them and add nothing the review missed.
    withTerms({ kind: "queued", source: "declared" });
    await expect(ExitTermsConsentCheck.run(ctx())).resolves.toEqual({
      ok: true,
    });
    withTerms({ kind: "delayed", seconds: THIRTY_DAYS, source: "declared" });
    await expect(ExitTermsConsentCheck.run(ctx())).resolves.toEqual({
      ok: true,
    });
  });

  it("refuses when the exit terms cannot be characterised", async () => {
    withTerms({ kind: "unknown" });
    await expect(ExitTermsConsentCheck.run(ctx())).resolves.toMatchObject({
      ok: false,
      fail: "exit_terms_unknown",
    });
  });

  it("does not apply on a namespace with no provider (must not strand Sui/Solana)", async () => {
    // Only eip155 registers a provider today, and the pipeline runs for every
    // namespace. Blocking here would have broken every working Sui deposit
    // while their Layer-1/4/5 checks no-op anyway.
    await expect(
      ExitTermsConsentCheck.run(ctx({ namespace: "sui" })),
    ).resolves.toEqual({ ok: true });
  });

  it("refuses when the chain's provider has not docked the probe at all", async () => {
    // Space-docking: a provider without the capability is "we cannot check",
    // which must never read as "instant".
    registerChainSafetyProvider(provider());
    await expect(ExitTermsConsentCheck.run(ctx())).resolves.toMatchObject({
      ok: false,
      fail: "exit_terms_unknown",
    });
  });

  it("refuses when the probe itself throws", async () => {
    registerChainSafetyProvider(
      provider(async () => {
        throw new Error("rpc down");
      }),
    );
    await expect(ExitTermsConsentCheck.run(ctx())).resolves.toMatchObject({
      ok: false,
      fail: "exit_terms_unknown",
    });
  });

  it("is scoped to deposits so it can never trap a withdrawal", async () => {
    // Blocking a withdraw because the exit is slow would strand funds in the
    // very protocol the user is leaving.
    expect(ExitTermsConsentCheck.appliesTo?.actions).toEqual(["deposit"]);
    expect(ExitTermsConsentCheck.appliesTo?.stages).toEqual(["presign"]);
  });
});

describe("exit-terms helpers", () => {
  it("reports a delay only for timed lockups", () => {
    expect(exitDelaySeconds({ kind: "instant" })).toBe(0);
    expect(exitDelaySeconds({ kind: "queued", source: "declared" })).toBe(0);
    expect(
      exitDelaySeconds({ kind: "delayed", seconds: 600, source: "onchain" }),
    ).toBe(600);
  });

  it("treats everything except a proven instant exit as needing consent", () => {
    expect(exitNeedsConsent({ kind: "instant" })).toBe(false);
    expect(exitNeedsConsent({ kind: "unknown" })).toBe(true);
    expect(exitNeedsConsent({ kind: "queued", source: "onchain" })).toBe(true);
    expect(
      exitNeedsConsent({ kind: "delayed", seconds: 1, source: "onchain" }),
    ).toBe(true);
  });
});

describe("exit consent ledger", () => {
  beforeEach(() => resetExitConsent());

  it("returns undefined when the user was never asked", () => {
    // Undefined must not collapse to 0 anywhere: 0 reads as "accepted an
    // instant exit", which is the opposite of "nobody was asked".
    expect(takeExitConsent("pool-1")).toBeUndefined();
    expect(takeExitConsent(undefined)).toBeUndefined();
  });

  it("hands back exactly what the user was shown, once", () => {
    recordExitConsent("pool-1", 2_592_000);
    expect(peekExitConsent("pool-1")).toBe(2_592_000);
    expect(takeExitConsent("pool-1")).toBe(2_592_000);
    // Single use: one approval funds one deposit, never a standing permission.
    expect(takeExitConsent("pool-1")).toBeUndefined();
  });

  it("keeps consent scoped to the pool it was given for", () => {
    recordExitConsent("pool-1", 600);
    expect(takeExitConsent("pool-2")).toBeUndefined();
    expect(takeExitConsent("pool-1")).toBe(600);
  });
});

describe("exit-terms copy", () => {
  it("renders durations in units a person reads, not seconds", () => {
    expect(formatExitDelay(2_592_000)).toBe("about 30 days");
    expect(formatExitDelay(86_400)).toBe("about 1 day");
    expect(formatExitDelay(7_200)).toBe("about 2 hours");
    expect(formatExitDelay(0)).toBe("");
  });

  it("warns for every non-instant exit and stays silent for instant", () => {
    expect(exitTermsNotice({ kind: "instant" })).toBeNull();
    expect(
      exitTermsNotice({
        kind: "delayed",
        seconds: 2_592_000,
        source: "onchain",
      }),
    ).toContain("about 30 days");
    expect(exitTermsNotice({ kind: "queued", source: "onchain" })).toContain(
      "queue",
    );
    expect(exitTermsNotice({ kind: "unknown" })).toContain("couldn't confirm");
  });

  it("never uses an em-dash in user-facing copy", () => {
    // Hard house rule for UI strings.
    const strings = [
      exitTermsNotice({ kind: "delayed", seconds: 86_400, source: "onchain" }),
      exitTermsNotice({ kind: "queued", source: "onchain" }),
      exitTermsNotice({ kind: "unknown" }),
    ];
    for (const s of strings) expect(s ?? "").not.toContain("\u2014");
  });
});
