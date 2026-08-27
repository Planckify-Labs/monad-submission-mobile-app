/**
 * `defi_set_recurring_invest` / `defi_list_recurring_invest` — DCA v1
 * (docs/defi-quick-invest-spec.md §12.5).
 *
 * A recurring plan is a REMINDER. The server nudges on each cycle, the
 * user taps once, and the user's own key signs through the existing
 * `defi_deposit` approval flow. **Nothing here creates, delegates, or
 * stores signing authority**, which is why this executor performs no
 * chain work at all: no RPC, no signer, no address handling. §13's
 * unattended variant is out of scope and needs its own security review.
 *
 * Two things the MODEL must never supply, and does not:
 *
 *  - **The wallet.** Sourced from the JWT server-side. No request in this
 *    feature carries a wallet address, on either side of the wire.
 *  - **The chain.** Taken from `context.activeChainCaip2`, i.e. the chain
 *    the user is actually looking at, resolved through the walletKit
 *    registry rather than a namespace comparison. A plan pins the wallet
 *    that will eventually sign, so the wallet on screen must be the wallet
 *    recorded — that is exactly the `active` role in the presence layer's
 *    vocabulary, and `toolNamespaceRoles` declares it (§12.1a rule 4).
 *    `counterparty` would be the wrong, laxer rule here.
 */

import { strategiesApi } from "@/api/endpoints/strategies";
import {
  classifyDefiError,
  DefiError,
} from "@/services/defi/errors/defiErrors";
import {
  ExecutorError,
  ExecutorErrorCode,
  type MobileToolExecutor,
  safeExecute,
} from "../types";

/** Weekly or monthly only at launch (§12.6) — mirrors the backend DTO. */
const CADENCE_DAYS: Record<string, number> = { weekly: 7, monthly: 30 };
const TIERS = new Set(["conservative", "balanced", "aggressive"]);

function requireNumber(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ExecutorError(
      ExecutorErrorCode.InvalidInput,
      `${key} must be a positive number`,
    );
  }
  return n;
}

export const setRecurringInvest: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    try {
      const amountUsd = requireNumber(input, "amount_usd");

      const rawTier = String(input.tier ?? "").toLowerCase();
      if (!TIERS.has(rawTier)) {
        throw new ExecutorError(
          ExecutorErrorCode.InvalidInput,
          "tier must be conservative, balanced, or aggressive",
        );
      }

      const rawCadence = String(input.cadence ?? "").toLowerCase();
      const cadenceDays = CADENCE_DAYS[rawCadence];
      if (!cadenceDays) {
        throw new ExecutorError(
          ExecutorErrorCode.InvalidInput,
          "cadence must be weekly or monthly",
        );
      }

      // The chain is the device's, never the model's. Absent means we could
      // not name the active chain in a form that survives leaving EVM —
      // refuse rather than pin a plan to a chain we guessed.
      const caip2Id = context.activeChainCaip2;
      if (!caip2Id) {
        throw new DefiError(
          "unsupported_chain",
          "active chain has no CAIP-2 id",
        );
      }

      // Asset: what the user named, else the active chain's own stablecoin
      // convention is NOT assumed — we ask for it rather than inventing a
      // symbol the wallet may not hold.
      const assetSymbol = String(input.asset_symbol ?? "")
        .trim()
        .toUpperCase();
      if (!assetSymbol) {
        throw new ExecutorError(
          ExecutorErrorCode.InvalidInput,
          "asset_symbol is required",
        );
      }

      if (__DEV__) {
        console.warn("[defi/setRecurringInvest] ENTER", {
          caip2Id,
          assetSymbol,
          amountUsd,
          tier: rawTier,
          cadenceDays,
        });
      }

      const plan = await strategiesApi.createRecurringInvestPlan({
        caip2Id,
        assetSymbol,
        amountUsd,
        tier: rawTier,
        cadenceDays,
      });

      return {
        status: "success" as const,
        data: {
          plan_id: plan.id,
          amount_usd: plan.amountUsd,
          asset_symbol: plan.assetSymbol,
          tier: plan.tier,
          effective_tier: plan.effectiveTier,
          tier_overridden: plan.tierOverridden,
          cadence_days: plan.cadenceDays,
          chain_name: plan.chainName,
          caip2_id: plan.caip2Id,
          next_due_at: plan.nextDueAt,
          status: plan.status,
          replaced: plan.replaced === true,
          // Stated in the payload so the model cannot describe this as
          // automatic investing even if its prompt drifts.
          execution_mode: plan.executionMode,
          moves_funds_now: false,
        },
      };
    } catch (err) {
      if (err instanceof ExecutorError) throw err;
      const code = classifyDefiError(err);
      throw new DefiError(code, "set recurring invest failed");
    }
  });

export const listRecurringInvest: MobileToolExecutor = () =>
  safeExecute(async () => {
    try {
      const plans = await strategiesApi.listRecurringInvestPlans();
      return {
        status: "success" as const,
        data: {
          plans: plans.map((p) => ({
            plan_id: p.id,
            amount_usd: p.amountUsd,
            asset_symbol: p.assetSymbol,
            tier: p.tier,
            effective_tier: p.effectiveTier,
            tier_overridden: p.tierOverridden,
            cadence_days: p.cadenceDays,
            chain_name: p.chainName,
            caip2_id: p.caip2Id,
            next_due_at: p.nextDueAt,
            status: p.status,
            execution_mode: p.executionMode,
          })),
          count: plans.length,
        },
      };
    } catch (err) {
      const code = classifyDefiError(err);
      throw new DefiError(code, "list recurring invest failed");
    }
  });
