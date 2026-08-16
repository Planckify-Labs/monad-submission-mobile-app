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
        // Same shape of problem, action-appropriate label — "requires a
        // larger minimum deposit" reads wrong on a withdraw's approval card,
        // and no existing withdraw code fits "zero or negative" specifically
        // enough to reuse, so this falls back to the same honest "unknown"
        // the non-bigint branch above uses rather than a misleading one.
        return {
          ok: false,
          fail: ctx.action === "withdraw" ? "unknown" : "below_min_deposit",
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

/**
 * Withdraw hint/position provenance (§11 Layer 0, withdraw-only). Unlike
 * deposit's `protocol_slug`/`chain_id`/`asset_symbol` — which ARE the
 * routing target — `defi_withdraw` routes by `position_id` alone, resolved
 * ownership-scoped server-side; these same-named fields on a withdraw call
 * are OPTIONAL DISPLAY HINTS the model copies from `defi_list_positions` so
 * the approval card can show what's being withdrawn instead of a bare
 * "Transaction".
 *
 * But because they ARE shown to the user before they approve, a hint that
 * disagrees with the position it's attached to is the exact prompt-injection
 * shape this layer exists to catch: the model, steered by something it read
 * earlier in the turn, could describe position A's withdrawal using
 * position B's protocol/asset, and the user would approve a lie even though
 * the on-chain call itself (routed purely by `position_id`) is correct.
 */
export const WithdrawHintMatchCheck: SafetyCheck = {
  id: "withdraw-hint-match",
  layer: 0,
  appliesTo: { actions: ["withdraw"], stages: ["presign"] },
  run: async (ctx) => {
    const input = ctx.toolInput;
    if (!input) return { ok: true };
    const hintedSlug =
      typeof input.protocol_slug === "string" ? input.protocol_slug : undefined;
    const hintedChainId =
      typeof input.chain_id === "number" ? input.chain_id : undefined;
    const hintedSymbol =
      typeof input.asset_symbol === "string" ? input.asset_symbol : undefined;

    if (
      hintedSlug &&
      ctx.protocolSlug &&
      hintedSlug.toLowerCase() !== ctx.protocolSlug.toLowerCase()
    ) {
      return {
        ok: false,
        fail: "decoded_intent_mismatch",
        detail:
          "protocol_slug hint does not match the position being withdrawn",
      };
    }
    if (
      hintedChainId !== undefined &&
      typeof ctx.chainId === "number" &&
      hintedChainId !== ctx.chainId
    ) {
      return {
        ok: false,
        fail: "decoded_intent_mismatch",
        detail: "chain_id hint does not match the position being withdrawn",
      };
    }
    if (
      hintedSymbol &&
      ctx.assetSymbol &&
      hintedSymbol.toUpperCase() !== ctx.assetSymbol.toUpperCase()
    ) {
      return {
        ok: false,
        fail: "decoded_intent_mismatch",
        detail: "asset_symbol hint does not match the position being withdrawn",
      };
    }
    return { ok: true };
  },
};

/**
 * Withdraw amount vs. live balance (§11 Layer 0, withdraw-only). A non-MAX
 * amount larger than the position's live on-chain balance would otherwise
 * just revert on-chain — burning gas — instead of failing cleanly before a
 * signature is even requested. Runs at `submit` because the live balance
 * read needs a resolved wallet client, which isn't available yet at
 * `presign` — see the withdraw executor.
 */
export const WithdrawBalanceCheck: SafetyCheck = {
  id: "withdraw-balance",
  layer: 0,
  appliesTo: { actions: ["withdraw"], stages: ["submit"] },
  run: async (ctx) => {
    if (ctx.requestedAmount === "MAX") return { ok: true };
    // No live read available (e.g. the RPC call failed) — non-fatal, same
    // posture as the executor's own preflight: "we don't know" doesn't
    // block, only a POSITIVELY confirmed over-request does.
    if (typeof ctx.positionBalance !== "bigint") return { ok: true };
    if (ctx.requestedAmount > ctx.positionBalance) {
      return {
        ok: false,
        fail: "withdraw_exceeds_balance",
        detail: "requested amount exceeds the position's live on-chain balance",
      };
    }
    return { ok: true };
  },
};

export const LAYER0_CHECKS: readonly SafetyCheck[] = [
  NoLlmSuppliedAddressCheck,
  StrictInputSchemaCheck,
  WithdrawHintMatchCheck,
  WithdrawBalanceCheck,
];
