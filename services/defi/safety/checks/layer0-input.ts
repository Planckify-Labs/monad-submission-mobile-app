/**
 * Layer 0 — input provenance, at the tool boundary (spec §11 Layer 0).
 *
 * The cheapest layer and the one that decides what the rest of the pipeline is
 * even reasoning about: if the model can name a destination, every downstream
 * check is validating an address the model chose.
 *
 * Fully chain-agnostic — it operates on tool metadata only, so it is one
 * implementation for every chain, forever.
 */

import type { SafetyCheck } from "../types";

/**
 * Address-shaped fields the model must never supply. `asset_contract` is
 * deliberately absent: that is the user's own token, and it is validated
 * against the resolved target inside the adapter rather than trusted.
 *
 * Mirrors `FORBIDDEN_TARGET_KEYS` in the deposit executor — the executor
 * rejects them before anything runs, and this check is the same rule expressed
 * where the audit trail can record it.
 */
const FORBIDDEN_TARGET_KEYS = [
  "deposit_target",
  "depositTarget",
  "target",
  "vault",
  "vault_address",
  "market",
  "market_address",
  "comet",
  "reserve",
  "program",
  "pool_address",
  "router",
  "spender",
  "to",
] as const;

/** A UUID-ish pool id. DeFiLlama's ids are UUIDs; be strict, not clever. */
const POOL_ID_SHAPE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,63}$/;

export const NoLlmSuppliedAddressCheck: SafetyCheck = {
  id: "no-llm-supplied-address",
  layer: 0,
  appliesTo: { stages: ["presign"] },
  run: async (ctx) => {
    const input = ctx.toolInput;
    if (!input) return { ok: true };
    for (const key of FORBIDDEN_TARGET_KEYS) {
      const value = input[key];
      if (value !== undefined && value !== null && value !== "") {
        return {
          ok: false,
          fail: "target_not_allowlisted",
          detail: `model supplied address-shaped field "${key}"`,
        };
      }
    }
    return { ok: true };
  },
};

/**
 * Strict input schema (§11 Layer 0, `[N]`): `amount` is a positive integer in
 * raw units and `pool_id` matches a known shape. Rejecting rather than
 * ignoring a malformed field is the point — a silently-coerced amount is how a
 * deposit ends up for the wrong number.
 */
export const StrictInputSchemaCheck: SafetyCheck = {
  id: "strict-input-schema",
  layer: 0,
  appliesTo: { stages: ["presign"] },
  run: async (ctx) => {
    if (ctx.requestedAmount !== "MAX") {
      if (typeof ctx.requestedAmount !== "bigint") {
        return {
          ok: false,
          fail: "unknown",
          detail: "amount is not a raw-unit integer",
        };
      }
      if (ctx.requestedAmount <= 0n) {
        return {
          ok: false,
          fail: "below_min_deposit",
          detail: "amount must be positive",
        };
      }
    }
    if (ctx.poolId !== undefined && !POOL_ID_SHAPE.test(ctx.poolId)) {
      return {
        ok: false,
        fail: "unknown",
        detail: "pool_id does not match the expected shape",
      };
    }
    return { ok: true };
  },
};

export const LAYER0_CHECKS: readonly SafetyCheck[] = [
  NoLlmSuppliedAddressCheck,
  StrictInputSchemaCheck,
];
