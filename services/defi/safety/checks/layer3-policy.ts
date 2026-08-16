/**
 * Layer 3 — policy / authorisation (spec §11 Layer 3, §11.6 #2, #6).
 *
 * Everything here is chain-agnostic by nature: it reasons about the USER and
 * about OPS config, not about a chain. One implementation, every chain, forever.
 *
 * Two of these are hard gates rather than scores. The kill-switch has to work
 * during an incident, when nobody has time to ship a release; the sanctions
 * screen is a regulatory line for a payments product, so it fails closed and is
 * audit-logged rather than weighed against anything.
 */

import type { RiskTier } from "../../types";
import type { SafetyCheck } from "../types";

const TIER_RANK: Record<RiskTier, number> = {
  conservative: 0,
  balanced: 1,
  aggressive: 2,
};

/**
 * Per-family global kill-switch (§11 Layer 3, `[N]`).
 *
 * Ops must be able to disable an entire family the moment an exploit is
 * disclosed, independent of any user's state and without a redeploy. Backed by
 * a hot config the resolver and the executor both read; the env fallback keeps
 * it usable in a build where remote config is unreachable, which is exactly
 * when an incident is worst.
 */
let killedFamilies = new Set<string>();

/** Ops entry point — also called on remote-config refresh. */
export function setKilledFamilies(families: readonly string[]): void {
  killedFamilies = new Set(families.map((f) => f.toLowerCase()));
}

function envKilledFamilies(): Set<string> {
  const raw = process.env.EXPO_PUBLIC_DEFI_FAMILY_KILL_SWITCH?.trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isFamilyKilled(familyOrKind: string): boolean {
  const needle = familyOrKind.toLowerCase();
  return killedFamilies.has(needle) || envKilledFamilies().has(needle);
}

export const FamilyKillSwitchCheck: SafetyCheck = {
  id: "family-kill-switch",
  layer: 3,
  run: async (ctx) => {
    const keys = [ctx.target.kind, ctx.family, ctx.protocolSlug].filter(
      (k): k is string => typeof k === "string" && k.length > 0,
    );
    for (const key of keys) {
      if (isFamilyKilled(key)) {
        return {
          ok: false,
          fail: "family_disabled",
          detail: `ops disabled "${key}"`,
        };
      }
    }
    return { ok: true };
  },
};

/** Tier ceiling + protocol whitelist + the user's own pause (§11 Layer 3, `[E]`). */
export const UserPolicyCheck: SafetyCheck = {
  id: "user-policy",
  layer: 3,
  appliesTo: { stages: ["presign"] },
  run: async (ctx) => {
    const policy = ctx.policy;
    if (!policy) return { ok: true };
    if (policy.paused) {
      return {
        ok: false,
        fail: "strategy_paused",
        detail: "strategy is paused",
      };
    }
    const whitelist = policy.protocolWhitelist ?? [];
    if (
      !policy.allowAllInTier &&
      whitelist.length > 0 &&
      ctx.protocolSlug &&
      !whitelist.includes(ctx.protocolSlug)
    ) {
      return {
        ok: false,
        fail: "protocol_not_in_whitelist",
        detail: "protocol is not on the user's whitelist",
      };
    }
    return { ok: true };
  },
};

/**
 * Cumulative-exposure cap (§11 Layer 3, `[N]`). Concentration is its own risk:
 * a user with everything in one protocol is one exploit away from zero, no
 * matter how safe each individual deposit looked.
 */
export const ExposureCapCheck: SafetyCheck = {
  id: "exposure-cap",
  layer: 3,
  appliesTo: { stages: ["presign"] },
  run: async (ctx) => {
    const policy = ctx.policy;
    if (
      !policy ||
      typeof policy.currentExposurePct !== "number" ||
      typeof policy.maxExposurePct !== "number"
    ) {
      return { ok: true };
    }
    return policy.currentExposurePct >= policy.maxExposurePct
      ? {
          ok: false,
          fail: "exposure_cap_exceeded",
          detail: "too much of the user's funds already in this protocol",
        }
      : { ok: true };
  },
};

/**
 * Per-user velocity cap (§11.6 #6a). Bounds the blast radius of a compromised
 * session or a runaway agent loop: even if every individual deposit passes,
 * forty of them in an hour is not a person making decisions.
 */
export const VelocityCapCheck: SafetyCheck = {
  id: "velocity-cap",
  layer: 3,
  appliesTo: { stages: ["presign"] },
  run: async (ctx) => {
    const policy = ctx.policy;
    if (
      !policy ||
      typeof policy.recentDepositCount !== "number" ||
      typeof policy.maxDepositsPerWindow !== "number"
    ) {
      return { ok: true };
    }
    return policy.recentDepositCount >= policy.maxDepositsPerWindow
      ? {
          ok: false,
          fail: "velocity_exceeded",
          detail: "deposit limit for the rolling window reached",
        }
      : { ok: true };
  },
};

/**
 * §11.6 #2 — compliance / sanctions screening. **Must-have (regulatory).**
 *
 * Takumi is a payments product, so the normalised destination and recipient are
 * screened against a deny list before the build. A hit is a hard fail,
 * audit-logged, never a score that something else can outweigh.
 *
 * The list is ops config, hot-swappable like the kill-switch. Universal over
 * `DecodedIntent`, so it works on any chain's normalised addresses.
 */
let denyList = new Set<string>();

export function setCounterpartyDenyList(addresses: readonly string[]): void {
  denyList = new Set(addresses.map((a) => a.toLowerCase()));
}

export function isCounterpartyDenied(address: string | null): boolean {
  return !!address && denyList.has(address.toLowerCase());
}

export const SanctionsScreenCheck: SafetyCheck = {
  id: "sanctions-screen",
  layer: 3,
  run: async (ctx) => {
    if (denyList.size === 0) return { ok: true };
    const candidates: (string | null)[] = [ctx.wallet];
    // Every kind's destination, read off the target rather than a decode, so
    // the screen runs even before a call exists.
    const t = ctx.target;
    if ("vault" in t) candidates.push(t.vault as string);
    if ("pool" in t) candidates.push(t.pool as string);
    if ("comet" in t) candidates.push(t.comet as string);
    if ("cToken" in t) candidates.push(t.cToken as string);
    if ("router" in t) candidates.push(t.router as string);
    if ("market" in t) candidates.push(t.market as string);

    for (const candidate of candidates) {
      if (isCounterpartyDenied(candidate)) {
        return {
          ok: false,
          fail: "counterparty_blocked",
          detail: "counterparty is on the deny list",
        };
      }
    }
    return { ok: true };
  },
};

/**
 * Per-chain enablement, separate from "supported" (§11 Layer 3, `[N]`). A chain
 * can be live for balances and transfers while DeFi routing on it stays off —
 * usually because its provider is only partially implemented (§11.3).
 */
let defiEnabledChains: Set<string> | null = null;

export function setDefiEnabledChains(
  chains: readonly (number | string)[] | null,
): void {
  defiEnabledChains = chains === null ? null : new Set(chains.map(String));
}

export const ChainEnabledCheck: SafetyCheck = {
  id: "chain-enabled-for-defi",
  layer: 3,
  run: async (ctx) => {
    if (defiEnabledChains === null) return { ok: true };
    return defiEnabledChains.has(String(ctx.chainId))
      ? { ok: true }
      : {
          ok: false,
          fail: "family_disabled",
          detail: "DeFi routing is disabled on this chain",
        };
  },
};

/** Tier ceiling helper shared with callers that pre-filter opportunities. */
export function tierAllows(userTier: RiskTier, poolTier: RiskTier): boolean {
  return TIER_RANK[poolTier] <= TIER_RANK[userTier];
}

export const LAYER3_CHECKS: readonly SafetyCheck[] = [
  FamilyKillSwitchCheck,
  ChainEnabledCheck,
  UserPolicyCheck,
  ExposureCapCheck,
  VelocityCapCheck,
  SanctionsScreenCheck,
];
