/**
 * DeFi write executors — deposit / withdraw / claim / rebalance.
 *
 * Spec: docs/defi-strategies-spec.md §11, §15, §25.3.
 *
 * Each write enforces the spec's safety envelope before touching the
 * chain:
 *   • Tier-ceiling check (§15.7): `OpportunityCache.tier` ≤ user's
 *     `UserStrategy.tier`.
 *   • Whitelist check (§15.8): `protocol_slug` ∈ user's whitelist
 *     (or curated default when `allowAllInTier=false`).
 *   • APY-drift check (§15.6): `expected_apy` from the LLM must be
 *     within ±5% of `OpportunityCache.apy`.
 *   • Strategy-paused kill-switch (§15.9).
 *
 * Failures throw `DefiError(code, …)`; `safeExecute` maps `code` to
 * `ToolResult.error` so the agent never sees raw text.
 */

import { type Address, erc20Abi, formatUnits, parseAbi } from "viem";
import { exchangeRateApi } from "@/api/endpoints/exchange-rates";
import { strategiesApi } from "@/api/endpoints/strategies";
import type { TOpportunity, TUserStrategy } from "@/api/types/strategy";
import { buildChainConfigFromBlockchain } from "@/hooks/useWallet.helpers";
import { toChainTag } from "@/services/analytics/chainTag";
import { track } from "@/services/analytics/posthog";
import {
  classifyDefiError,
  DefiError,
} from "@/services/defi/errors/defiErrors";
import { readPosition } from "@/services/defi/positions/reader";
import {
  getDefiAdapter,
  getDefiAdapterForTarget,
  listDefiAdapters,
} from "@/services/defi/registry";
import type { DepositTarget } from "@/services/defi/types";
import { getDefaultTokens } from "@/services/tokens/tokenList";
import { resolveChainClients } from "../chainRouter";
import {
  ExecutorError,
  ExecutorErrorCode,
  type MobileToolExecutor,
  requireBigInt,
  requireString,
  resolveChainId,
  safeExecute,
  type ToolInput,
} from "../types";
import { submitEvmCall } from "./submitTx";

const APY_DRIFT_TOLERANCE_PCT = 5;

const TIER_RANK = {
  conservative: 0,
  balanced: 1,
  aggressive: 2,
} as const;

type TierKey = keyof typeof TIER_RANK;

export function toTierKey(tier: string | undefined): TierKey {
  if (tier === "balanced" || tier === "aggressive") return tier;
  return "conservative";
}

function decimalsForSymbol(symbol: string): number {
  // Minimal decimal map — matches what the token registry would
  // resolve. The executor uses this as a fallback; production
  // deposits already carry `asset_contract` and the adapter's own
  // decimals discovery if it needs more precision.
  switch (symbol.toUpperCase()) {
    case "USDC":
    case "USDT":
    case "USDC.E":
      return 6;
    case "WBTC":
      return 8;
    default:
      return 18;
  }
}

// Address-bearing DepositTarget fields the LLM must NEVER supply (spec §8:
// "No LLM-supplied addresses"). The executor re-fetches the authoritative
// target server-side by `pool_id`; a call carrying any of these is rejected.
// `asset_contract` (the deposited asset) is intentionally NOT here — it's the
// user's token, validated against the resolved target inside the adapter.
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
] as const;

function assertNoLlmSuppliedTarget(input: ToolInput): void {
  for (const key of FORBIDDEN_TARGET_KEYS) {
    const value = input[key];
    if (value !== undefined && value !== null && value !== "") {
      if (__DEV__) {
        console.warn("[defi/deposit] REJECT llm-supplied target field", {
          key,
        });
      }
      // Fail closed. The server owns target resolution (§6); the model only
      // passes pool_id. Friendly copy via classifyDefiError → deposit_failed.
      throw new DefiError(
        "deposit_failed",
        `address-shaped field "${key}" is not accepted from the model; the target is resolved server-side by pool_id`,
      );
    }
  }
}

/**
 * Resolve user strategy + opportunity in parallel and apply the spec
 * §15 guards. Returns the validated opportunity for downstream code.
 */
export async function resolveAndGuard({
  protocolSlug,
  poolId,
  expectedApy,
  expectedTier,
}: {
  protocolSlug: string;
  /**
   * When present, guards + the returned `depositTarget` are read from the
   * EXACT DeFiLlama pool (spec §6/§8: "APY-drift already per-row — fetch by
   * poolId, not slug"). Falls back to the protocol-slug row otherwise.
   */
  poolId?: string;
  expectedApy?: number;
  expectedTier?: TierKey;
}): Promise<{
  opportunity: TOpportunity | null;
  strategy: TUserStrategy | null;
}> {
  const opportunityFetch = poolId
    ? strategiesApi.getPool(poolId).catch(() => null)
    : strategiesApi.getOpportunity(protocolSlug).catch(() => null);
  const [strategyResult, opportunityResult] = await Promise.allSettled([
    strategiesApi.getStrategy(),
    opportunityFetch,
  ]);

  const strategy =
    strategyResult.status === "fulfilled" ? strategyResult.value : null;
  const opportunity =
    opportunityResult.status === "fulfilled" ? opportunityResult.value : null;

  if (__DEV__) {
    if (strategyResult.status === "rejected") {
      console.warn("[defi/guard] getStrategy rejected", strategyResult.reason);
    }
    if (opportunityResult.status === "rejected") {
      console.warn(
        "[defi/guard] getOpportunity rejected",
        opportunityResult.reason,
      );
    }
    console.warn("[defi/guard] resolved", {
      protocolSlug,
      hasStrategy: !!strategy,
      strategyTier: strategy?.tier,
      strategyPaused: !!strategy?.pausedAt,
      allowAllInTier: !!strategy?.allowAllInTier,
      whitelistLen: strategy?.protocolWhitelist?.length ?? 0,
      hasOpportunity: !!opportunity,
      opportunityTier: opportunity?.tier,
      opportunityApy: opportunity?.apy,
      expectedApy,
      expectedTier,
    });
  }

  // Strategy-paused kill-switch.
  if (strategy?.pausedAt) {
    if (__DEV__) {
      console.warn("[defi/guard] REJECT strategy_paused", {
        pausedAt: strategy.pausedAt,
      });
    }
    throw new DefiError("strategy_paused");
  }

  if (opportunity) {
    // Tier ceiling — opportunity.tier ≤ user.tier.
    if (strategy) {
      const userTier = toTierKey(strategy.tier);
      const oppTier = toTierKey(opportunity.tier);
      if (TIER_RANK[oppTier] > TIER_RANK[userTier]) {
        if (__DEV__) {
          console.warn("[defi/guard] REJECT tier_exceeds_user_policy", {
            userTier,
            oppTier,
            userTierRank: TIER_RANK[userTier],
            oppTierRank: TIER_RANK[oppTier],
          });
        }
        throw new DefiError(
          "tier_exceeds_user_policy",
          `opportunity tier ${oppTier} exceeds user tier ${userTier}`,
        );
      }

      // Whitelist enforcement.
      const list = strategy.protocolWhitelist ?? [];
      const allowAll = !!strategy.allowAllInTier;
      if (!allowAll && list.length > 0 && !list.includes(protocolSlug)) {
        if (__DEV__) {
          console.warn("[defi/guard] REJECT protocol_not_in_whitelist", {
            protocolSlug,
            allowAll,
            whitelist: list,
          });
        }
        throw new DefiError("protocol_not_in_whitelist", protocolSlug);
      }
    }

    // APY drift — compare expected_apy against backend cache (±5%).
    if (typeof expectedApy === "number" && Number.isFinite(expectedApy)) {
      const cached = parseFloat(opportunity.apy);
      if (Number.isFinite(cached) && cached > 0) {
        const driftPct = Math.abs((cached - expectedApy) / cached) * 100;
        if (driftPct > APY_DRIFT_TOLERANCE_PCT) {
          if (__DEV__) {
            console.warn("[defi/guard] REJECT apy_drift_too_high", {
              expectedApy,
              cachedApy: cached,
              driftPct,
              tolerancePct: APY_DRIFT_TOLERANCE_PCT,
            });
          }
          throw new DefiError(
            "apy_drift_too_high",
            `expected ${expectedApy}% vs cached ${cached}%`,
          );
        }
      }
    }

    // Optional sanity: expected_tier matches cached tier.
    if (expectedTier && expectedTier !== toTierKey(opportunity.tier)) {
      // Soft — pass through but log in dev. The tier-ceiling check
      // above is the binding rule.
      if (__DEV__) {
        console.warn(
          `[defi/guard] SOFT expected_tier mismatch: expected=${expectedTier} cached=${opportunity.tier}`,
        );
      }
    }
  } else if (__DEV__) {
    console.warn(
      "[defi/guard] no cached opportunity row — APY/tier guards skipped",
      { protocolSlug },
    );
  }

  return { opportunity, strategy };
}

/**
 * `defi_deposit` — execute a single-step deposit into a DeFi protocol.
 */
export const deposit: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    try {
      // Reject any LLM-supplied address BEFORE anything else (spec §8).
      assertNoLlmSuppliedTarget(input);

      const chainId = resolveChainId(input, context);
      const protocolSlug = requireString(input, "protocol_slug");
      const assetSymbol = requireString(input, "asset_symbol");
      const amountRaw = requireBigInt(input, "amount_raw");
      const assetContract = input.asset_contract as string | undefined;
      // The exact DeFiLlama pool the user picked (spec §6). Optional →
      // backward compatible: without it we route by slug to the canonical
      // market (legacy behaviour).
      const poolId =
        typeof input.pool_id === "string" && input.pool_id
          ? input.pool_id
          : undefined;
      const expectedApy =
        typeof input.expected_apy === "number" ? input.expected_apy : undefined;
      const expectedTier =
        typeof input.expected_tier === "string"
          ? toTierKey(input.expected_tier)
          : undefined;
      const goal = input.goal as string | undefined;
      const targetDate = input.target_date as string | undefined;

      if (__DEV__) {
        console.warn("[defi/deposit] ENTER", {
          chainId,
          protocolSlug,
          poolId,
          assetSymbol,
          assetContract,
          amountRaw: amountRaw.toString(),
          expectedApy,
          expectedTier,
          goal,
          targetDate,
          walletAddress: context.wallet.address,
        });
      }

      // Guards must run BEFORE we resolve the adapter / clients — they're the
      // cheapest rejections. When `poolId` is present this ALSO re-fetches the
      // authoritative `depositTarget` from the exact pool row server-side
      // (§6): the model never handed us an address.
      const { opportunity } = await resolveAndGuard({
        protocolSlug,
        poolId,
        expectedApy,
        expectedTier,
      });
      const depositTarget: DepositTarget | undefined =
        opportunity?.depositTarget ?? undefined;

      if (__DEV__) {
        console.warn("[defi/deposit] resolved depositTarget", {
          poolId,
          kind: depositTarget?.kind ?? "none (manual/legacy slug route)",
        });
      }

      // Route by the resolved target's `kind` when present (the generic
      // family adapter — Erc4626/Aave/Scallop), else by slug (canonical
      // market). Never a namespace/slug branch here — the registry owns it.
      const adapter = getDefiAdapterForTarget(protocolSlug, depositTarget);
      if (!adapter) {
        if (__DEV__) {
          console.warn("[defi/deposit] protocol_not_found", {
            protocolSlug,
            registered: listDefiAdapters().map((a) => a.slug),
          });
        }
        throw new DefiError("protocol_not_found", protocolSlug);
      }

      // EVM-only deposit executor. Sui/Solana venues deposit through their own
      // path (the Sui Intent Engine's defi_intent_preview/execute), so fail
      // closed with a curated reason instead of handing a non-EVM adapter an EVM
      // chain config (which throws a raw "requires sui namespace"). The agent's
      // recovery is to route the Sui pool through defi_intent_preview.
      if (adapter.namespace !== "eip155") {
        if (__DEV__) {
          console.warn("[defi/deposit] non-EVM venue routed to EVM executor", {
            protocolSlug,
            namespace: adapter.namespace,
          });
        }
        throw new DefiError(
          "unsupported_chain",
          `${protocolSlug}: non-EVM venue — deposit via the Sui Intent Engine (defi_intent_preview)`,
        );
      }

      const blockchain = context.blockchains.find((b) => b.chainId === chainId);
      if (!blockchain) {
        if (__DEV__) {
          console.warn(
            "[defi/deposit] unsupported_chain — no blockchain row in context",
            {
              chainId,
              available: context.blockchains.map((b) => b.chainId),
            },
          );
        }
        throw new DefiError("unsupported_chain", `chainId=${chainId}`);
      }
      const chainConfig = buildChainConfigFromBlockchain(blockchain);
      const decimals = decimalsForSymbol(assetSymbol);

      let unsignedCall;
      try {
        unsignedCall = await adapter.buildDeposit({
          wallet: context.wallet,
          chain: chainConfig,
          asset: { symbol: assetSymbol, contract: assetContract, decimals },
          amount: amountRaw,
          target: depositTarget,
        });
      } catch (buildErr) {
        if (__DEV__) {
          console.error("[defi/deposit] adapter.buildDeposit threw", {
            protocolSlug,
            assetSymbol,
            assetContract,
            error: buildErr,
          });
        }
        throw buildErr;
      }

      if (__DEV__) {
        console.warn("[defi/deposit] unsignedCall built", {
          kind: unsignedCall.kind,
          to: (unsignedCall as { to?: string }).to,
          dataLen: (unsignedCall as { data?: string }).data?.length,
          value: (unsignedCall as { value?: bigint }).value?.toString(),
          needsApproval:
            unsignedCall.kind === "evm-call" && unsignedCall.needsApproval
              ? {
                  token: unsignedCall.needsApproval.token,
                  spender: unsignedCall.needsApproval.spender,
                  amount: unsignedCall.needsApproval.amount.toString(),
                }
              : false,
        });
      }

      if (unsignedCall.kind !== "evm-call") {
        // Solana / Sui submission goes through the wallet kit's
        // namespace-specific path; the agent-executor pipeline is
        // EVM-first for v1.
        if (__DEV__) {
          console.warn(
            "[defi/deposit] unsupported_chain — non-EVM unsigned call",
            { kind: unsignedCall.kind },
          );
        }
        throw new DefiError(
          "unsupported_chain",
          `unsigned call kind "${unsignedCall.kind}" not yet supported by the EVM executor pipeline`,
        );
      }

      const { walletClient, publicClient } = resolveChainClients(
        chainId,
        context,
      );
      if (!walletClient || !walletClient.account) {
        if (__DEV__) {
          console.warn("[defi/deposit] wallet_cannot_execute", {
            hasWalletClient: !!walletClient,
            hasAccount: !!walletClient?.account,
            chainId,
          });
        }
        throw new DefiError("wallet_cannot_execute");
      }

      // 1. Approval preamble.
      if (unsignedCall.needsApproval) {
        try {
          if (__DEV__) {
            console.warn("[defi/deposit] reading allowance", {
              token: unsignedCall.needsApproval.token,
              owner: walletClient.account.address,
              spender: unsignedCall.needsApproval.spender,
            });
          }
          const allowance = await publicClient.readContract({
            address: unsignedCall.needsApproval.token,
            abi: erc20Abi,
            functionName: "allowance",
            args: [
              walletClient.account.address as Address,
              unsignedCall.needsApproval.spender,
            ],
          });
          if (__DEV__) {
            console.warn("[defi/deposit] allowance read OK", {
              allowance: allowance.toString(),
              required: unsignedCall.needsApproval.amount.toString(),
              sufficient: allowance >= unsignedCall.needsApproval.amount,
            });
          }
          if (allowance < unsignedCall.needsApproval.amount) {
            if (__DEV__) {
              console.warn("[defi/deposit] submitting approve tx", {
                token: unsignedCall.needsApproval.token,
                spender: unsignedCall.needsApproval.spender,
                amount: unsignedCall.needsApproval.amount.toString(),
              });
            }
            const approveHash = await walletClient.writeContract({
              address: unsignedCall.needsApproval.token,
              abi: erc20Abi,
              functionName: "approve",
              args: [
                unsignedCall.needsApproval.spender,
                unsignedCall.needsApproval.amount,
              ],
              account: walletClient.account,
              chain: walletClient.chain,
            });
            if (__DEV__) {
              console.warn("[defi/deposit] approve tx submitted", {
                approveHash,
              });
            }
            await publicClient.waitForTransactionReceipt({ hash: approveHash });
            if (__DEV__) {
              console.warn("[defi/deposit] approve tx confirmed", {
                approveHash,
              });
            }
          }
        } catch (err) {
          if (__DEV__) {
            console.error("[defi/deposit] approval_failed", {
              token: unsignedCall.needsApproval.token,
              spender: unsignedCall.needsApproval.spender,
              required: unsignedCall.needsApproval.amount.toString(),
              error: err,
            });
          }
          throw new DefiError("approval_failed");
        }
      }

      // 2. Submit the protocol call (phantom-failure-safe — see
      //    submitTx.ts). A broadcast error is never silently treated as
      //    "didn't happen": funds could have moved.
      if (__DEV__) {
        console.warn("[defi/deposit] submitting protocol tx", {
          to: unsignedCall.to,
          dataLen: unsignedCall.data?.length,
          value: (unsignedCall.value ?? 0n).toString(),
          account: walletClient.account.address,
          chainId: walletClient.chain?.id,
        });
      }
      const submit = await submitEvmCall(walletClient, publicClient, {
        to: unsignedCall.to,
        data: unsignedCall.data,
        value: unsignedCall.value ?? 0n,
      });

      if (submit.kind === "not_broadcast") {
        if (__DEV__) {
          console.warn("[defi/deposit] not broadcast — no deposit made", {
            to: unsignedCall.to,
          });
        }
        throw new DefiError("deposit_failed");
      }
      if (submit.kind === "mined" && !submit.success) {
        if (__DEV__) {
          console.warn("[defi/deposit] reverted on-chain", {
            hash: submit.hash,
          });
        }
        throw new DefiError("deposit_failed");
      }
      if (submit.kind === "unconfirmed") {
        // May have landed — don't record a position we can't verify, and
        // don't claim success. Surface the hash for reconciliation.
        if (__DEV__) {
          console.warn("[defi/deposit] submission_unconfirmed", {
            hash: submit.hash,
          });
        }
        return {
          status: "failed" as const,
          tx_hash: submit.hash,
          error: "submission_unconfirmed",
          data: {
            protocol_slug: protocolSlug,
            chain_id: chainId,
            amount_raw: amountRaw.toString(),
          },
        };
      }

      const hash = submit.hash;
      if (__DEV__) {
        console.warn("[defi/deposit] protocol tx submitted", { hash });
      }

      // 3. USD value snapshot for `StrategyPosition.amountAtDepositUsd`.
      let amountAtDepositUsd = 0;
      try {
        const rate = await exchangeRateApi.getLatestExchangeRate({
          fromCurrency: assetSymbol,
          toCurrency: "USD",
        });
        const humanAmount = parseFloat(formatUnits(amountRaw, decimals));
        const computed = humanAmount * (rate?.rate ?? 0);
        amountAtDepositUsd = Number.isFinite(computed) ? computed : 0;
      } catch (rateErr) {
        if (__DEV__) {
          console.warn(
            "[defi/deposit] exchange rate fetch failed (best-effort)",
            {
              assetSymbol,
              error: rateErr,
            },
          );
        }
      }

      // 4. Record the position on the backend.
      try {
        await strategiesApi.createPosition({
          protocolSlug,
          chainId,
          namespace: adapter.namespace,
          assetSymbol,
          assetContract,
          poolId,
          amountAtDeposit: amountRaw.toString(),
          amountAtDepositUsd,
          openTxHash: hash,
          goal,
          targetDate,
        });
        if (__DEV__) {
          console.warn("[defi/deposit] position row created", {
            hash,
            protocolSlug,
            chainId,
          });
        }
      } catch (err) {
        if (__DEV__) {
          console.error("[defi/deposit] createPosition api failed", {
            protocolSlug,
            chainId,
            hash,
            error: err,
          });
        }
      }

      track("defi_deposit_completed", {
        chain: toChainTag(adapter.namespace),
        protocol_slug: protocolSlug,
        chain_id: chainId,
        asset_symbol: assetSymbol,
        amount: parseFloat(formatUnits(amountRaw, decimals)),
        amount_usd: amountAtDepositUsd,
      });

      return {
        status: "success" as const,
        tx_hash: hash,
        tx_confirmed: false,
        data: {
          protocol_slug: protocolSlug,
          chain_id: chainId,
          amount_raw: amountRaw.toString(),
        },
      };
    } catch (err) {
      const code = classifyDefiError(err);
      if (__DEV__) {
        console.warn("[defi/deposit] EXIT failed", { code, error: err });
      }
      throw new ExecutorError(ExecutorErrorCode.InvalidInput, code);
    }
  });

/**
 * `defi_withdraw` — withdraw from a position. Accepts `amount_raw =
 * "MAX"` for full exit.
 */
export const withdraw: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    try {
      const positionId = requireString(input, "position_id");
      const amountRawInput = input.amount_raw;
      const amountRaw: bigint | "MAX" =
        amountRawInput === "MAX" ? "MAX" : requireBigInt(input, "amount_raw");

      if (__DEV__) {
        console.warn("[defi/withdraw] ENTER", {
          positionId,
          amountRaw:
            typeof amountRaw === "string" ? amountRaw : amountRaw.toString(),
          walletAddress: context.wallet.address,
        });
      }

      const position = await strategiesApi
        .getPosition(positionId)
        .catch((err) => {
          if (__DEV__) {
            console.warn("[defi/withdraw] getPosition rejected", {
              positionId,
              error: err,
            });
          }
          return null;
        });
      if (!position) {
        if (__DEV__) {
          console.warn("[defi/withdraw] position_not_found", { positionId });
        }
        throw new DefiError("position_not_found", positionId);
      }

      const { protocolSlug, chainId, assetSymbol, assetContract, namespace } =
        position;

      // Pool-level positions (spec §4.2, §7): re-fetch the authoritative
      // depositTarget by the pinned poolId so the withdraw routes to the SAME
      // vault the deposit used (the generic family adapter), not the protocol's
      // canonical market. Legacy positions (no poolId) route by slug as before.
      let withdrawTarget: DepositTarget | undefined;
      if (position.poolId) {
        const opp = await strategiesApi
          .getPool(position.poolId)
          .catch(() => null);
        withdrawTarget = opp?.depositTarget ?? undefined;
      }

      if (__DEV__) {
        console.warn("[defi/withdraw] position resolved", {
          positionId,
          protocolSlug,
          poolId: position.poolId,
          targetKind: withdrawTarget?.kind ?? "none (slug route)",
          chainId,
          assetSymbol,
          assetContract,
          namespace,
          status: position.status,
        });
      }

      const adapter = getDefiAdapterForTarget(protocolSlug, withdrawTarget);
      if (!adapter) {
        if (__DEV__) {
          console.warn("[defi/withdraw] protocol_not_found", {
            protocolSlug,
            registered: listDefiAdapters().map((a) => a.slug),
          });
        }
        throw new DefiError("protocol_not_found", protocolSlug);
      }

      // Strategy-paused still allows withdraw (kill-switch lets users exit).
      const strategy = await strategiesApi.getStrategy().catch(() => null);
      void strategy; // intentionally not gating withdraw

      const blockchain = context.blockchains.find((b) => b.chainId === chainId);
      if (!blockchain) {
        if (__DEV__) {
          console.warn(
            "[defi/withdraw] unsupported_chain — no blockchain row in context",
            {
              chainId,
              available: context.blockchains.map((b) => b.chainId),
            },
          );
        }
        throw new DefiError("unsupported_chain", `chainId=${chainId}`);
      }
      const chainConfig = buildChainConfigFromBlockchain(blockchain);
      const decimals = decimalsForSymbol(assetSymbol);

      let unsignedCall;
      try {
        unsignedCall = await adapter.buildWithdraw({
          wallet: context.wallet,
          chain: chainConfig,
          asset: {
            symbol: assetSymbol,
            contract: assetContract ?? undefined,
            decimals,
          },
          amount: amountRaw,
          target: withdrawTarget,
        });
      } catch (buildErr) {
        if (__DEV__) {
          console.error("[defi/withdraw] adapter.buildWithdraw threw", {
            protocolSlug,
            assetSymbol,
            error: buildErr,
          });
        }
        throw buildErr;
      }

      if (__DEV__) {
        console.warn("[defi/withdraw] unsignedCall built", {
          kind: unsignedCall.kind,
          to: (unsignedCall as { to?: string }).to,
          dataLen: (unsignedCall as { data?: string }).data?.length,
          needsApproval:
            unsignedCall.kind === "evm-call" && unsignedCall.needsApproval
              ? {
                  token: unsignedCall.needsApproval.token,
                  spender: unsignedCall.needsApproval.spender,
                  amount: unsignedCall.needsApproval.amount.toString(),
                }
              : false,
        });
      }

      if (unsignedCall.kind !== "evm-call") {
        if (__DEV__) {
          console.warn(
            "[defi/withdraw] unsupported_chain — non-EVM unsigned call",
            {
              kind: unsignedCall.kind,
            },
          );
        }
        throw new DefiError(
          "unsupported_chain",
          `unsigned call kind "${unsignedCall.kind}"`,
        );
      }

      const { walletClient, publicClient } = resolveChainClients(
        chainId,
        context,
      );
      if (!walletClient || !walletClient.account) {
        if (__DEV__) {
          console.warn("[defi/withdraw] wallet_cannot_execute", {
            hasWalletClient: !!walletClient,
            hasAccount: !!walletClient?.account,
            chainId,
          });
        }
        throw new DefiError("wallet_cannot_execute");
      }

      // Pre-flight the on-chain balance. A MAX withdraw against a
      // position with no live balance (stale DB row, deposit that never
      // settled on-chain, wrong address) reverts with an opaque error.
      // Read the live position first so we can fail with a clear,
      // typed reason instead of submitting a doomed transaction. Only a
      // positively-confirmed zero balance blocks — a read failure is
      // non-fatal and falls through to the normal path.
      try {
        const live = await readPosition({
          protocolSlug,
          chainId,
          walletAddress: walletClient.account.address,
          assetSymbol,
          assetContract: assetContract ?? undefined,
        });
        if (live && live.currentAmount <= 0n) {
          if (__DEV__) {
            console.warn("[defi/withdraw] no_onchain_balance — preflight", {
              positionId,
              protocolSlug,
              chainId,
            });
          }
          throw new DefiError("no_onchain_balance", positionId);
        }
      } catch (preflightErr) {
        if (preflightErr instanceof DefiError) throw preflightErr;
        if (__DEV__) {
          console.warn(
            "[defi/withdraw] balance preflight read failed (non-fatal)",
            { positionId, error: preflightErr },
          );
        }
      }

      // Some withdrawals (Lido, Ethena cooldown) require an approval
      // to the queue/redemption manager — handle the preamble the
      // same as deposit.
      if (unsignedCall.needsApproval) {
        try {
          if (__DEV__) {
            console.warn("[defi/withdraw] reading allowance", {
              token: unsignedCall.needsApproval.token,
              owner: walletClient.account.address,
              spender: unsignedCall.needsApproval.spender,
            });
          }
          const allowance = await publicClient.readContract({
            address: unsignedCall.needsApproval.token,
            abi: erc20Abi,
            functionName: "allowance",
            args: [
              walletClient.account.address as Address,
              unsignedCall.needsApproval.spender,
            ],
          });
          if (__DEV__) {
            console.warn("[defi/withdraw] allowance read OK", {
              allowance: allowance.toString(),
              required: unsignedCall.needsApproval.amount.toString(),
            });
          }
          if (allowance < unsignedCall.needsApproval.amount) {
            const approveHash = await walletClient.writeContract({
              address: unsignedCall.needsApproval.token,
              abi: erc20Abi,
              functionName: "approve",
              args: [
                unsignedCall.needsApproval.spender,
                unsignedCall.needsApproval.amount,
              ],
              account: walletClient.account,
              chain: walletClient.chain,
            });
            if (__DEV__) {
              console.warn("[defi/withdraw] approve tx submitted", {
                approveHash,
              });
            }
            await publicClient.waitForTransactionReceipt({ hash: approveHash });
            if (__DEV__) {
              console.warn("[defi/withdraw] approve tx confirmed", {
                approveHash,
              });
            }
          }
        } catch (err) {
          if (__DEV__) {
            console.error("[defi/withdraw] approval_failed", {
              token: unsignedCall.needsApproval.token,
              spender: unsignedCall.needsApproval.spender,
              error: err,
            });
          }
          throw new DefiError("approval_failed");
        }
      }

      if (__DEV__) {
        console.warn("[defi/withdraw] submitting protocol tx", {
          to: unsignedCall.to,
          dataLen: unsignedCall.data?.length,
          account: walletClient.account.address,
          chainId: walletClient.chain?.id,
        });
      }
      // Phantom-failure-safe submission: sign locally, then broadcast,
      // so a broadcast-RPC error never gets mislabelled as "nothing
      // happened" while the tx actually moved funds (the reported bug).
      const submit = await submitEvmCall(walletClient, publicClient, {
        to: unsignedCall.to,
        data: unsignedCall.data,
        value: unsignedCall.value ?? 0n,
      });

      if (submit.kind === "not_broadcast") {
        // Pre-broadcast failure (gas estimate revert, bad nonce, …):
        // chain state is genuinely unchanged.
        if (__DEV__) {
          console.warn("[defi/withdraw] not broadcast — position unchanged", {
            to: unsignedCall.to,
          });
        }
        throw new DefiError("withdraw_failed");
      }
      if (submit.kind === "mined" && !submit.success) {
        // Broadcast then reverted on-chain — funds unchanged.
        if (__DEV__) {
          console.warn("[defi/withdraw] reverted on-chain", {
            hash: submit.hash,
          });
        }
        throw new DefiError("withdraw_failed");
      }
      if (submit.kind === "unconfirmed") {
        // The signed tx may have landed — DO NOT claim unchanged, DO NOT
        // retry. Surface the hash so the activity feed can reconcile it.
        if (__DEV__) {
          console.warn("[defi/withdraw] submission_unconfirmed", {
            hash: submit.hash,
          });
        }
        return {
          status: "failed" as const,
          tx_hash: submit.hash,
          error: "submission_unconfirmed",
          data: {
            position_id: positionId,
            protocol_slug: protocolSlug,
            chain_id: chainId,
          },
        };
      }

      // "submitted" or "mined" + success.
      const hash = submit.hash;
      if (__DEV__) {
        console.warn("[defi/withdraw] protocol tx submitted", { hash });
      }

      return {
        status: "success" as const,
        tx_hash: hash,
        tx_confirmed: submit.kind === "mined",
        data: {
          position_id: positionId,
          protocol_slug: protocolSlug,
          chain_id: chainId,
          amount_raw:
            typeof amountRaw === "string" ? amountRaw : amountRaw.toString(),
        },
      };
    } catch (err) {
      const code = classifyDefiError(err);
      if (__DEV__) {
        console.warn("[defi/withdraw] EXIT failed", { code, error: err });
      }
      throw new ExecutorError(ExecutorErrorCode.InvalidInput, code);
    }
  });

/**
 * `defi_claim` — claim rewards / matured withdrawal. Routes through
 * the adapter's optional `buildClaim?` capability.
 */
export const claim: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    try {
      const positionId = requireString(input, "position_id");
      if (__DEV__) {
        console.warn("[defi/claim] ENTER", {
          positionId,
          walletAddress: context.wallet.address,
        });
      }
      const position = await strategiesApi
        .getPosition(positionId)
        .catch((err) => {
          if (__DEV__) {
            console.warn("[defi/claim] getPosition rejected", {
              positionId,
              error: err,
            });
          }
          return null;
        });
      if (!position) {
        if (__DEV__)
          console.warn("[defi/claim] position_not_found", { positionId });
        throw new DefiError("position_not_found", positionId);
      }

      const adapter = getDefiAdapter(position.protocolSlug);
      if (!adapter) {
        if (__DEV__) {
          console.warn("[defi/claim] protocol_not_found", {
            protocolSlug: position.protocolSlug,
            registered: listDefiAdapters().map((a) => a.slug),
          });
        }
        throw new DefiError("protocol_not_found", position.protocolSlug);
      }
      if (!adapter.buildClaim) {
        if (__DEV__) {
          console.warn(
            "[defi/claim] no_claimable_balance — adapter has no buildClaim primitive",
            {
              protocolSlug: position.protocolSlug,
            },
          );
        }
        throw new DefiError(
          "no_claimable_balance",
          `${position.protocolSlug}: no claim primitive`,
        );
      }

      const blockchain = context.blockchains.find(
        (b) => b.chainId === position.chainId,
      );
      if (!blockchain) {
        if (__DEV__) {
          console.warn(
            "[defi/claim] unsupported_chain — no blockchain row in context",
            {
              chainId: position.chainId,
              available: context.blockchains.map((b) => b.chainId),
            },
          );
        }
        throw new DefiError("unsupported_chain", `chainId=${position.chainId}`);
      }
      const chainConfig = buildChainConfigFromBlockchain(blockchain);
      const decimals = decimalsForSymbol(position.assetSymbol);

      let unsignedCall;
      try {
        unsignedCall = await adapter.buildClaim({
          wallet: context.wallet,
          chain: chainConfig,
          asset: {
            symbol: position.assetSymbol,
            contract: position.assetContract ?? undefined,
            decimals,
          },
          amount: 0n,
        });
      } catch (buildErr) {
        if (__DEV__) {
          console.error("[defi/claim] adapter.buildClaim threw", {
            protocolSlug: position.protocolSlug,
            error: buildErr,
          });
        }
        throw buildErr;
      }

      if (__DEV__) {
        console.warn("[defi/claim] unsignedCall built", {
          kind: unsignedCall.kind,
          to: (unsignedCall as { to?: string }).to,
          dataLen: (unsignedCall as { data?: string }).data?.length,
        });
      }

      if (unsignedCall.kind !== "evm-call") {
        if (__DEV__) {
          console.warn(
            "[defi/claim] unsupported_chain — non-EVM unsigned call",
            {
              kind: unsignedCall.kind,
            },
          );
        }
        throw new DefiError(
          "unsupported_chain",
          `unsigned call kind "${unsignedCall.kind}"`,
        );
      }

      const { walletClient } = resolveChainClients(position.chainId, context);
      if (!walletClient || !walletClient.account) {
        if (__DEV__) {
          console.warn("[defi/claim] wallet_cannot_execute", {
            hasWalletClient: !!walletClient,
            hasAccount: !!walletClient?.account,
            chainId: position.chainId,
          });
        }
        throw new DefiError("wallet_cannot_execute");
      }

      let hash: `0x${string}`;
      try {
        if (__DEV__) {
          console.warn("[defi/claim] submitting claim tx", {
            to: unsignedCall.to,
            dataLen: unsignedCall.data?.length,
          });
        }
        hash = await walletClient.sendTransaction({
          to: unsignedCall.to,
          data: unsignedCall.data,
          value: unsignedCall.value ?? 0n,
          account: walletClient.account,
          chain: walletClient.chain,
        });
        if (__DEV__) {
          console.warn("[defi/claim] claim tx submitted", { hash });
        }
      } catch (err) {
        const c = classifyDefiError(err);
        if (__DEV__) {
          console.error("[defi/claim] sendTransaction failed", {
            classified: c,
            to: unsignedCall.to,
            error: err,
          });
        }
        throw new DefiError(c === "unknown" ? "claim_failed" : c);
      }

      return {
        status: "success" as const,
        tx_hash: hash,
        tx_confirmed: false,
        data: {
          position_id: positionId,
          protocol_slug: position.protocolSlug,
          chain_id: position.chainId,
        },
      };
    } catch (err) {
      const code = classifyDefiError(err);
      if (__DEV__) {
        console.warn("[defi/claim] EXIT failed", { code, error: err });
      }
      throw new ExecutorError(ExecutorErrorCode.InvalidInput, code);
    }
  });

/**
 * `defi_rebalance` — sequential withdraw-from-A + deposit-into-B.
 *
 * Each leg gets its own threshold check and its own PendingTxCard
 * upstream. If the second leg fails after the first succeeded, we
 * report `rebalance_partial_failure` so the agent narrates the right
 * follow-up.
 */
export const rebalance: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    try {
      const fromPositionId = requireString(input, "from_position_id");
      const toProtocolSlug = requireString(input, "to_protocol_slug");
      const toAssetSymbol = requireString(input, "to_asset_symbol");
      const toAssetContract = input.to_asset_contract as string | undefined;

      if (__DEV__) {
        console.warn("[defi/rebalance] ENTER", {
          fromPositionId,
          toProtocolSlug,
          toAssetSymbol,
          toAssetContract,
          toAmountRaw: input.to_amount_raw,
          expectedApy: input.expected_apy,
        });
      }

      // 1. Withdraw the full from-position.
      if (__DEV__) {
        console.warn("[defi/rebalance] leg 1 — withdraw MAX", {
          fromPositionId,
        });
      }
      const withdrawResult = await withdraw(
        { position_id: fromPositionId, amount_raw: "MAX" },
        context,
      );
      if (withdrawResult.status !== "success" || !withdrawResult.tx_hash) {
        if (__DEV__) {
          console.warn(
            "[defi/rebalance] rebalance_failed — leg 1 (withdraw) did not succeed",
            {
              withdrawResult,
            },
          );
        }
        throw new DefiError("rebalance_failed", "first leg (withdraw) failed");
      }
      if (__DEV__) {
        console.warn("[defi/rebalance] leg 1 OK", {
          withdrawTxHash: withdrawResult.tx_hash,
        });
      }

      // 2. Resolve the from-position to find the chain we're operating on.
      const fromPosition = await strategiesApi
        .getPosition(fromPositionId)
        .catch((err) => {
          if (__DEV__) {
            console.warn("[defi/rebalance] getPosition rejected", {
              fromPositionId,
              error: err,
            });
          }
          return null;
        });
      if (!fromPosition) {
        if (__DEV__) {
          console.warn(
            "[defi/rebalance] rebalance_partial_failure — withdraw OK but from-position metadata missing",
            {
              fromPositionId,
              withdrawTxHash: withdrawResult.tx_hash,
            },
          );
        }
        throw new DefiError(
          "rebalance_partial_failure",
          "withdraw succeeded but couldn't load from-position metadata",
        );
      }
      const expectedApy =
        typeof input.expected_apy === "number" ? input.expected_apy : undefined;

      // 3. Deposit into B. We use the same chain and the asset
      // requested. If the executor's withdraw + deposit chains
      // mismatch, this would need LI.FI (deferred to Phase 2). For
      // same-chain rebalance, the user's wallet now holds the
      // underlying asset received from the withdraw.
      try {
        const amountRaw =
          typeof input.to_amount_raw === "string"
            ? input.to_amount_raw
            : fromPosition.currentAmountRaw || fromPosition.amountAtDeposit;

        if (__DEV__) {
          console.warn("[defi/rebalance] leg 2 — deposit", {
            toProtocolSlug,
            toAssetSymbol,
            toAssetContract,
            chainId: fromPosition.chainId,
            amountRaw,
          });
        }
        const depositResult = await deposit(
          {
            protocol_slug: toProtocolSlug,
            chain_id: fromPosition.chainId,
            asset_symbol: toAssetSymbol,
            asset_contract: toAssetContract,
            amount_raw: amountRaw,
            ...(expectedApy !== undefined ? { expected_apy: expectedApy } : {}),
          },
          context,
        );
        if (depositResult.status !== "success") {
          if (__DEV__) {
            console.warn(
              "[defi/rebalance] rebalance_partial_failure — leg 2 (deposit) did not succeed",
              {
                depositResult,
                withdrawTxHash: withdrawResult.tx_hash,
              },
            );
          }
          throw new DefiError("rebalance_partial_failure");
        }
        if (__DEV__) {
          console.warn("[defi/rebalance] leg 2 OK", {
            depositTxHash: depositResult.tx_hash,
          });
        }
        return {
          status: "success" as const,
          tx_hash: depositResult.tx_hash,
          tx_confirmed: false,
          data: {
            withdraw_tx_hash: withdrawResult.tx_hash,
            deposit_tx_hash: depositResult.tx_hash,
            to_protocol_slug: toProtocolSlug,
            chain_id: fromPosition.chainId,
          },
        };
      } catch (err) {
        if (__DEV__) {
          console.error(
            "[defi/rebalance] rebalance_partial_failure — leg 2 threw",
            {
              withdrawTxHash: withdrawResult.tx_hash,
              error: err,
            },
          );
        }
        throw new DefiError("rebalance_partial_failure");
      }
    } catch (err) {
      const code = classifyDefiError(err);
      if (__DEV__) {
        console.warn("[defi/rebalance] EXIT failed", { code, error: err });
      }
      throw new ExecutorError(ExecutorErrorCode.InvalidInput, code);
    }
  });

/**
 * `defi_compound` — claim accrued rewards and redeposit them into the
 * same position in a single, signed cycle. Spec §21.3.
 *
 * V1 scope: the executor measures the **balance delta of the position's
 * base asset** (claim before vs. after) and deposits that delta back.
 * Adapters whose `buildClaim` emits a different reward token (e.g. GMX
 * → WETH/esGMX, Aave → WMATIC bonuses) will land on zero delta and
 * fail with `no_claimable_balance`; the user can compound manually by
 * claiming, swapping in-app, and depositing.
 *
 * Adapters with rebasing yield (Lido stETH) accrue inline and do not
 * surface a `buildClaim` primitive — those get rejected at the
 * "no claim primitive" guard.
 */
export const compound: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    try {
      const positionId = requireString(input, "position_id");

      if (__DEV__) {
        console.warn("[defi/compound] ENTER", {
          positionId,
          walletAddress: context.wallet.address,
        });
      }

      const position = await strategiesApi
        .getPosition(positionId)
        .catch((err) => {
          if (__DEV__) {
            console.warn("[defi/compound] getPosition rejected", {
              positionId,
              error: err,
            });
          }
          return null;
        });
      if (!position) {
        throw new DefiError("position_not_found", positionId);
      }

      const { protocolSlug, chainId, assetSymbol, assetContract } = position;

      // Strategy-paused KEEPS users from compounding (compound = write
      // that grows the position; if they paused, respect it).
      const strategy = await strategiesApi.getStrategy().catch(() => null);
      if (strategy?.pausedAt) {
        throw new DefiError("strategy_paused");
      }

      const adapter = getDefiAdapter(protocolSlug);
      if (!adapter) {
        throw new DefiError("protocol_not_found", protocolSlug);
      }
      if (!adapter.buildClaim) {
        if (__DEV__) {
          console.warn(
            "[defi/compound] no_claimable_balance — adapter has no buildClaim",
            { protocolSlug },
          );
        }
        throw new DefiError(
          "no_claimable_balance",
          `${protocolSlug}: no claim primitive (nothing to compound)`,
        );
      }
      if (!adapter.buildDeposit) {
        // Should never happen — interface requires buildDeposit — but
        // guard anyway so a stub adapter can't brick the executor.
        throw new DefiError(
          "deposit_failed",
          `${protocolSlug}: missing buildDeposit`,
        );
      }

      const blockchain = context.blockchains.find((b) => b.chainId === chainId);
      if (!blockchain) {
        throw new DefiError("unsupported_chain", `chainId=${chainId}`);
      }
      const chainConfig = buildChainConfigFromBlockchain(blockchain);
      const decimals = decimalsForSymbol(assetSymbol);

      const { walletClient, publicClient } = resolveChainClients(
        chainId,
        context,
      );
      if (!walletClient || !walletClient.account) {
        throw new DefiError("wallet_cannot_execute");
      }

      const walletAddress = walletClient.account.address as Address;
      const baseAssetContract = assetContract
        ? (assetContract.toLowerCase() as Address)
        : null;

      // 1. Snapshot user's wallet balance of the position's base asset
      //    BEFORE the claim, so we can compute the claimed delta after.
      let balanceBefore: bigint;
      try {
        if (baseAssetContract) {
          balanceBefore = await publicClient.readContract({
            address: baseAssetContract,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [walletAddress],
          });
        } else {
          balanceBefore = await publicClient.getBalance({
            address: walletAddress,
          });
        }
      } catch (err) {
        if (__DEV__) {
          console.error("[defi/compound] balance-before read failed", { err });
        }
        throw new DefiError("network_error", "balance-before read failed");
      }
      if (__DEV__) {
        console.warn("[defi/compound] balance snapshot before claim", {
          asset: baseAssetContract ?? "native",
          balanceBefore: balanceBefore.toString(),
        });
      }

      // 2. Build + submit the claim.
      let claimCall;
      try {
        claimCall = await adapter.buildClaim({
          wallet: context.wallet,
          chain: chainConfig,
          asset: {
            symbol: assetSymbol,
            contract: assetContract ?? undefined,
            decimals,
          },
          amount: 0n,
        });
      } catch (err) {
        if (__DEV__) {
          console.error("[defi/compound] adapter.buildClaim threw", { err });
        }
        throw err;
      }
      if (claimCall.kind !== "evm-call") {
        throw new DefiError(
          "unsupported_chain",
          `compound: non-EVM claim kind "${claimCall.kind}"`,
        );
      }

      let claimHash: `0x${string}`;
      try {
        claimHash = await walletClient.sendTransaction({
          to: claimCall.to,
          data: claimCall.data,
          value: claimCall.value ?? 0n,
          account: walletClient.account,
          chain: walletClient.chain,
        });
        if (__DEV__) {
          console.warn("[defi/compound] claim tx submitted", { claimHash });
        }
        await publicClient.waitForTransactionReceipt({ hash: claimHash });
        if (__DEV__) {
          console.warn("[defi/compound] claim tx confirmed", { claimHash });
        }
      } catch (err) {
        const c = classifyDefiError(err);
        if (__DEV__) {
          console.error("[defi/compound] claim send/confirm failed", {
            classified: c,
            err,
          });
        }
        throw new DefiError(c === "unknown" ? "claim_failed" : c);
      }

      // 3. Snapshot AFTER and compute the delta. V1 only compounds
      //    deltas in the position's base asset; reward tokens that
      //    require a swap land on zero delta and fail-fast.
      let balanceAfter: bigint;
      try {
        if (baseAssetContract) {
          balanceAfter = await publicClient.readContract({
            address: baseAssetContract,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [walletAddress],
          });
        } else {
          balanceAfter = await publicClient.getBalance({
            address: walletAddress,
          });
        }
      } catch (err) {
        if (__DEV__) {
          console.error("[defi/compound] balance-after read failed", { err });
        }
        throw new DefiError("network_error", "balance-after read failed");
      }

      const delta = balanceAfter - balanceBefore;
      if (__DEV__) {
        console.warn("[defi/compound] balance snapshot after claim", {
          balanceAfter: balanceAfter.toString(),
          delta: delta.toString(),
        });
      }
      if (delta <= 0n) {
        if (__DEV__) {
          console.warn(
            "[defi/compound] no_claimable_balance — no delta in base asset (reward likely a different token)",
            { protocolSlug, assetSymbol },
          );
        }
        throw new DefiError(
          "no_claimable_balance",
          "claim produced no balance in the position's base asset (rewards may be in a different token — manual swap required)",
        );
      }

      // 4. Build + submit the deposit for the claimed delta.
      let depositCall;
      try {
        depositCall = await adapter.buildDeposit({
          wallet: context.wallet,
          chain: chainConfig,
          asset: {
            symbol: assetSymbol,
            contract: assetContract ?? undefined,
            decimals,
          },
          amount: delta,
        });
      } catch (err) {
        if (__DEV__) {
          console.error("[defi/compound] adapter.buildDeposit threw", { err });
        }
        throw err;
      }
      if (depositCall.kind !== "evm-call") {
        throw new DefiError(
          "unsupported_chain",
          `compound: non-EVM deposit kind "${depositCall.kind}"`,
        );
      }

      // 4a. Approval preamble for ERC20 deposits.
      if (depositCall.needsApproval) {
        try {
          const allowance = await publicClient.readContract({
            address: depositCall.needsApproval.token,
            abi: erc20Abi,
            functionName: "allowance",
            args: [walletAddress, depositCall.needsApproval.spender],
          });
          if (allowance < depositCall.needsApproval.amount) {
            const approveHash = await walletClient.writeContract({
              address: depositCall.needsApproval.token,
              abi: erc20Abi,
              functionName: "approve",
              args: [
                depositCall.needsApproval.spender,
                depositCall.needsApproval.amount,
              ],
              account: walletClient.account,
              chain: walletClient.chain,
            });
            await publicClient.waitForTransactionReceipt({ hash: approveHash });
          }
        } catch (err) {
          if (__DEV__) {
            console.error("[defi/compound] approval_failed", { err });
          }
          throw new DefiError("approval_failed");
        }
      }

      let depositHash: `0x${string}`;
      try {
        depositHash = await walletClient.sendTransaction({
          to: depositCall.to,
          data: depositCall.data,
          value: depositCall.value ?? 0n,
          account: walletClient.account,
          chain: walletClient.chain,
        });
        if (__DEV__) {
          console.warn("[defi/compound] redeposit tx submitted", {
            depositHash,
            amount: delta.toString(),
          });
        }
      } catch (err) {
        const c = classifyDefiError(err);
        if (__DEV__) {
          console.error("[defi/compound] redeposit failed", {
            classified: c,
            err,
          });
        }
        throw new DefiError(c === "unknown" ? "deposit_failed" : c);
      }

      return {
        status: "success" as const,
        tx_hash: depositHash,
        tx_confirmed: false,
        data: {
          position_id: positionId,
          protocol_slug: protocolSlug,
          chain_id: chainId,
          claim_tx_hash: claimHash,
          deposit_tx_hash: depositHash,
          compounded_amount_raw: delta.toString(),
        },
      };
    } catch (err) {
      const code = classifyDefiError(err);
      if (__DEV__) {
        console.warn("[defi/compound] EXIT failed", { code, error: err });
      }
      throw new ExecutorError(ExecutorErrorCode.InvalidInput, code);
    }
  });
