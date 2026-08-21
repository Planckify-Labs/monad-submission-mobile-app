/**
 * RouterCallAdapter — Pendle (and, once its LP UX exists, Uniswap v3/v4)
 * (docs/defi-evm-protocol-expansion-spec.md §6, §3.4).
 *
 * These protocols have **no stable on-chain deposit ABI we encode**: their
 * hosted API returns the calldata, priced with slippage at request time. So
 * this adapter does not build a transaction — it asks our backend proxy for one
 * and then refuses to pass it on unless it survives every check below.
 *
 * The trust model is the point (§11.1). The backend has already enforced the
 * slippage ceiling and checked the returned `to` against the pinned router
 * allowlist. This adapter checks it AGAIN against the device's own pinned copy,
 * and asserts the quote priced the token and amount we asked for. A compromised
 * backend cannot get a call signed that the device would not independently
 * accept; a compromised device cannot obtain a quote the backend would not
 * independently issue.
 *
 * Mandatory guardrails, in order (§6):
 *  1. Slippage is capped server-side, and the request carries the policy's bps.
 *  2. `to` must be an allowlisted router — checked here as well as there.
 *  3. Simulate before signing — the executor's dry-run is non-negotiable for
 *     calldata we did not author.
 *  4. The quote's `tokenIn`/`amountIn` must match this deposit.
 * Plus a freshness rule (§12 Q8): a quote past `expiresAt` is re-fetched, never
 * signed, because stale calldata is sandwichable calldata.
 */

import { strategiesApi } from "@/api/endpoints/strategies";
import type { TRouterQuote } from "@/api/types/strategy";
import { assertEvmChain } from "@/constants/configs/chainConfig";
import { isRouterAllowlisted } from "../constants/evmAddressBook";
import { DefiError } from "../errors/defiErrors";
import { slippageBpsFor } from "../slippage";
import type {
  BuildDepositArgs,
  BuildWithdrawArgs,
  DefiPosition,
  DefiProtocolAdapter,
  DepositTarget,
  UnsignedCall,
} from "../types";

/**
 * A quote must have this much life left when we hand it on, otherwise it can
 * expire between build and signature. Cheaper to re-fetch than to sign stale.
 */
const MIN_QUOTE_LIFETIME_SEC = 15;

type RouterTarget = Extract<DepositTarget, { kind: "router-call" }>;

function requireRouterTarget(target: DepositTarget | undefined): RouterTarget {
  if (!target || target.kind !== "router-call") {
    throw new DefiError(
      "protocol_not_found",
      "router-call adapter requires a resolved { kind: 'router-call' } depositTarget",
    );
  }
  return target;
}

/**
 * Run every device-side check on a proxy quote. Anything that fails throws a
 * typed code — the raw quote is never shown to the user or handed on.
 */
function verifyQuote(
  quote: TRouterQuote,
  target: RouterTarget,
  amount: bigint,
  chainId: number,
): void {
  if (quote.chainId !== chainId || target.chainId !== chainId) {
    throw new DefiError(
      "unsupported_chain",
      "router-call: quote is for a different chain than the deposit",
    );
  }
  // Guardrail 2, device side. The whole family's safety rests on this line.
  if (!isRouterAllowlisted(target.protocol, chainId, quote.to)) {
    throw new DefiError(
      "target_not_allowlisted",
      "router-call: quote destination is not a pinned router",
    );
  }
  // Guardrail 4 — it must have priced OUR asset and OUR amount.
  if (quote.tokenIn.toLowerCase() !== target.tokenIn.toLowerCase()) {
    throw new DefiError(
      "decoded_intent_mismatch",
      "router-call: quote priced a different token",
    );
  }
  if (quote.amountIn !== amount.toString()) {
    throw new DefiError(
      "decoded_intent_mismatch",
      "router-call: quote priced a different amount",
    );
  }
  if (!/^0x[0-9a-fA-F]*$/.test(quote.data) || quote.data.length < 10) {
    throw new DefiError(
      "decoded_intent_mismatch",
      "router-call: quote returned no calldata",
    );
  }
  // §12 Q8 — freshness.
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isFinite(quote.expiresAt) ||
    quote.expiresAt - now < MIN_QUOTE_LIFETIME_SEC
  ) {
    throw new DefiError(
      "quote_expired",
      "router-call: quote has expired or is about to",
    );
  }
}

async function buildFromQuote(
  args: {
    poolId?: string;
    amount: bigint;
    target?: DepositTarget;
    chain: Parameters<typeof assertEvmChain>[0];
    tier?: BuildDepositArgs["tier"];
  },
  action: "deposit" | "withdraw",
): Promise<UnsignedCall> {
  const t = requireRouterTarget(args.target);
  const evm = assertEvmChain(args.chain);
  if (!args.poolId) {
    // Without the pool id the backend cannot re-resolve the target, and we are
    // NOT going to send it one from the device (§8).
    throw new DefiError(
      "protocol_not_found",
      "router-call: pool_id is required to fetch a verified quote",
    );
  }

  // Guardrail 1 — the policy's budget, capped again server-side.
  const slippageBps = slippageBpsFor({ tier: args.tier, stable: false });

  let quote: TRouterQuote;
  try {
    quote = await strategiesApi.getRouterQuote({
      poolId: args.poolId,
      amountRaw: args.amount.toString(),
      slippageBps,
      action,
    });
  } catch (err) {
    if (__DEV__) {
      console.warn("[router-call] quote fetch failed", err);
    }
    // The proxy answers with a curated `defi_<code>`; anything else is a
    // transport problem. Never surface the raw body.
    throw new DefiError("network_error", "router-call: quote unavailable");
  }

  verifyQuote(quote, t, args.amount, evm.chain.id);

  return {
    kind: "evm-call",
    to: quote.to as `0x${string}`,
    data: quote.data as `0x${string}`,
    value: BigInt(quote.value || "0"),
    // The router pulls `tokenIn`, so it is the spender — and the approval is
    // scoped to exactly this amount, never infinite (§8.4).
    needsApproval: {
      token: t.tokenIn,
      spender: quote.to as `0x${string}`,
      amount: args.amount,
    },
  } satisfies UnsignedCall;
}

export const RouterCallAdapter: DefiProtocolAdapter = {
  slug: "router-call",
  namespace: "eip155",
  kind: "yield_vault",
  chainId: 0, // nominal — routed by DepositTarget.kind
  displayName: "Pendle Market",
  targetKinds: ["router-call"],
  // Throws without a resolved target — see `requiresTarget` in types.ts.
  requiresTarget: true,
  externalSlugs: ["pendle"],
  // Calldata we did not author, priced by a third party: deliberately the
  // lowest static score of the EVM families.
  staticSafetyScore: 55,

  buildDeposit(args: BuildDepositArgs): Promise<UnsignedCall> {
    return buildFromQuote(args, "deposit");
  },

  buildWithdraw(args: BuildWithdrawArgs): Promise<UnsignedCall> {
    if (args.amount === "MAX") {
      // The proxy prices an exact amount; "everything" would have to be read
      // from the LP position first, which the withdraw executor does not
      // currently thread through. Refuse rather than send a guessed number to
      // a pricing API.
      throw new DefiError(
        "withdraw_failed",
        "router-call: MAX exit needs an explicit LP amount",
      );
    }
    return buildFromQuote(
      { ...args, amount: args.amount as bigint },
      "withdraw",
    );
  },

  readPosition(): Promise<DefiPosition | null> {
    // An LP position's value is protocol-specific and only the protocol's own
    // API can price it; the DB snapshot is the source of truth here.
    return Promise.resolve(null);
  },
};
