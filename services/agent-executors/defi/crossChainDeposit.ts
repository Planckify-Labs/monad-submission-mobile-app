/**
 * `defi_cross_chain_deposit` — bridge into a DeFi opportunity.
 *
 * Spec: docs/bridge-capability-spec.md §8.3, §4.2, §4.3;
 *       docs/defi-strategies-spec.md §11.
 *
 * REFACTORED, NOT REPLACED. The tool keeps its name and its input
 * contract; what changed is that it now COMPOSES the general bridge
 * primitives (`/bridge/quote` + the `BridgeRouteAdapter` execution path)
 * instead of carrying its own EVM-only LI.FI plumbing.
 *
 * That composition is what closes three of the five §4 blockers:
 *
 *   §4.2  the hard `adapter.namespace !== "eip155"` reject is GONE.
 *         The destination is whatever chain hosts the chosen adapter,
 *         expressed as CAIP-2, so a Solana or Sui opportunity is
 *         reachable the moment a route exists.
 *   §4.3  the native-asset check no longer fires only for the literal
 *         string `"ETH"`. It compares against the chain's OWN native
 *         symbol via the wallet kit, so SOL, SUI, XLM, POL, and BNB all
 *         work without a new branch.
 *   §4.1  amounts and assets travel as CAIP-19, so a Solana mint or a Sui
 *         coin type is expressible at all.
 *
 * Scope is unchanged: this submits the BRIDGE LEG only. The
 * destination-chain deposit is a follow-up `defi_deposit` once funds
 * arrive, which is why the result reports `phase: "bridging"` exactly as
 * before and creates no position row.
 */

import { bridgeApi } from "@/api/endpoints/bridge";
import type { TBridgeQuoteResult } from "@/api/types/bridge";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import { buildChainConfigFromBlockchain } from "@/hooks/useWallet.helpers";
import { assetToCaip19, chainToCaip2 } from "@/services/bridgeRoutes/caip";
import { checkBridgeDestinationReadiness } from "@/services/bridgeRoutes/execute";
import { adapterForQuote } from "@/services/bridgeRoutes/registry";
import { DefiError } from "@/services/defi/errors/defiErrors";
import { getDefiAdapter, listDefiAdapters } from "@/services/defi/registry";
import { getDefaultTokens } from "@/services/tokens/tokenList";
import { walletKitRegistry } from "@/services/walletKit/registry";
import {
  type ExecutorContext,
  ExecutorError,
  ExecutorErrorCode,
  type MobileToolExecutor,
  optionalString,
  requireBigInt,
  requireString,
  safeExecute,
  type ToolInput,
} from "../types";
import { resolveAndGuard, toTierKey } from "./writes";

/**
 * Resolve a token contract by symbol on an EVM chain.
 *
 * Kept from the previous implementation, including the "prefer canonical
 * over .e" intent: USDC and USDC.e on Arbitrum are DIFFERENT assets and a
 * silent mispick lands the user in the wrong one (§7.1).
 */
function lookupTokenContract(
  chainId: number,
  symbol: string,
): `0x${string}` | null {
  const upper = symbol.toUpperCase();
  const candidates = getDefaultTokens(chainId).filter(
    (t) => t.symbol.toUpperCase() === upper,
  );
  if (candidates.length === 0) return null;
  const exact = candidates.find(
    (t) => t.symbol.toUpperCase() === upper && !t.symbol.includes("."),
  );
  const chosen = exact ?? candidates[0];
  return chosen.contractAddress as `0x${string}`;
}

/** All chains this session knows, as `ChainConfig`s. */
function chainConfigsFrom(context: ExecutorContext): ChainConfig[] {
  return context.blockchains.map(buildChainConfigFromBlockchain);
}

/**
 * Find the `ChainConfig` a DeFi adapter is deployed on.
 *
 * Matches on `(namespace, chainId)` through the wallet kit's own
 * `getChainId`, so a Sui adapter keyed by `"mainnet"` and an EVM adapter
 * keyed by `8453` both resolve without this function knowing either
 * convention.
 */
function findChainForAdapter(
  chains: ChainConfig[],
  namespace: string,
  chainId: number | string,
): ChainConfig | null {
  for (const chain of chains) {
    if (chain.namespace !== namespace) continue;
    if (!walletKitRegistry.has(chain.namespace)) continue;
    const kit = walletKitRegistry.get(chain.namespace);
    const id = kit.getChainId?.(chain);
    if (id === undefined || id === null) continue;
    if (String(id) === String(chainId)) return chain;
  }
  return null;
}

/**
 * Is `symbol` this chain's native asset?
 *
 * The generic replacement for `fromAssetSymbol.toUpperCase() === "ETH"`
 * (§4.3). `nativeSymbol` is a wallet-kit capability, so adding a chain
 * needs no edit here.
 */
function isNativeSymbol(chain: ChainConfig, symbol: string): boolean {
  if (!walletKitRegistry.has(chain.namespace)) return false;
  const native = walletKitRegistry.get(chain.namespace).nativeSymbol?.(chain);
  return Boolean(native && native.toUpperCase() === symbol.toUpperCase());
}

export const crossChainDeposit: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    try {
      const protocolSlug = requireString(input, "protocol_slug");
      const fromAssetSymbol = requireString(input, "from_asset_symbol");
      const amountRaw = requireBigInt(input, "amount_raw");
      const expectedApy =
        typeof input.expected_apy === "number" ? input.expected_apy : undefined;
      const expectedTier =
        typeof input.expected_tier === "string"
          ? toTierKey(input.expected_tier)
          : undefined;

      const { opportunity } = await resolveAndGuard({
        protocolSlug,
        expectedApy,
        expectedTier,
      });

      const adapter = getDefiAdapter(protocolSlug);
      if (!adapter) {
        if (__DEV__) {
          console.warn("[defi/crossChainDeposit] protocol_not_found", {
            protocolSlug,
            registered: listDefiAdapters().map((a) => a.slug),
          });
        }
        throw new DefiError("protocol_not_found", protocolSlug);
      }

      const chains = chainConfigsFrom(context);

      // ── destination ───────────────────────────────────────────────
      // No namespace reject (§4.2). The destination is simply whichever
      // chain hosts the adapter; whether a route EXISTS is the bridge
      // registry's question, and a "no" there is a capability boundary
      // rather than a hardcoded refusal.
      const toChainConfig = findChainForAdapter(
        chains,
        adapter.namespace,
        adapter.chainId,
      );
      if (!toChainConfig) {
        throw new DefiError(
          "unsupported_chain",
          `destination chain for ${protocolSlug} is not configured`,
        );
      }
      const toChain = chainToCaip2(toChainConfig);
      if (!toChain) {
        throw new DefiError(
          "unsupported_chain",
          "destination chain has no CAIP-2 id",
        );
      }

      // ── source ────────────────────────────────────────────────────
      // Accept a CAIP-2 `from_chain` (the new, namespace-agnostic form)
      // and keep the legacy integer `from_chain_id` working so existing
      // callers are unaffected.
      const fromChainConfig = resolveSourceChain(input, context, chains);
      const fromChain = chainToCaip2(fromChainConfig);
      if (!fromChain) {
        throw new DefiError(
          "unsupported_chain",
          "source chain has no CAIP-2 id",
        );
      }

      if (fromChain === toChain) {
        throw new DefiError(
          "unsupported_chain",
          "from and to chain must differ, use defi_deposit for same-chain flows",
        );
      }

      const fromAsset = resolveSourceAsset(
        input,
        fromChainConfig,
        fromAssetSymbol,
      );
      const toAsset = resolveDestinationAsset(
        input,
        toChainConfig,
        opportunity?.assetContract,
      );

      // Cross-namespace destinations land at a DIFFERENT address derived
      // from the same mnemonic (§7.4), and this executor's context holds
      // only the paying wallet. Require it explicitly rather than
      // guessing, which is the failure mode that loses funds.
      const toAddress =
        optionalString(input, "to_address") ??
        (context.wallet.namespace === toChainConfig.namespace
          ? context.wallet.address
          : null);
      if (!toAddress) {
        throw new DefiError(
          "unsupported_chain",
          "cross-namespace destination requires an explicit to_address",
        );
      }

      if (__DEV__) {
        console.warn("[defi/crossChainDeposit] ENTER", {
          protocolSlug,
          fromChain,
          toChain,
          fromAsset,
          toAsset,
          amountRaw: amountRaw.toString(),
        });
      }

      // ── quote ─────────────────────────────────────────────────────
      let result: TBridgeQuoteResult;
      try {
        result = await bridgeApi.getQuote({
          fromChain,
          toChain,
          fromAsset,
          toAsset,
          amountRaw: amountRaw.toString(),
          fromAddress: context.wallet.address,
          toAddress,
        });
      } catch (err) {
        if (__DEV__) {
          console.warn("[defi/crossChainDeposit] quote request failed", err);
        }
        throw new DefiError("network_error");
      }

      if (!result.routable) {
        if (__DEV__) {
          console.warn("[defi/crossChainDeposit] no route", result.reason);
        }
        throw new DefiError(
          result.reason === "asset_not_supported"
            ? "unsupported_asset"
            : "unsupported_chain",
        );
      }
      const quote = result.quote;

      // Bridging into a chain the user cannot receive on, or cannot move
      // funds on afterwards, strands them (§7.5). Refuse rather than
      // deliver into a dead end.
      const blockers = await checkBridgeDestinationReadiness({
        toChain: quote.to.chain,
        toAsset: quote.to.token.caip19,
        address: quote.to.address,
        chains,
      });
      const blocking = blockers.find((b) => b.severity === "blocking");
      if (blocking) {
        if (__DEV__) {
          console.warn(
            "[defi/crossChainDeposit] destination not ready",
            blocking,
          );
        }
        throw new DefiError("unsupported_asset", blocking.code);
      }

      // ── execute ───────────────────────────────────────────────────
      const bridgeAdapter = adapterForQuote(
        quote.provider,
        quote.from.chain,
        quote.to.chain,
      );
      if (!bridgeAdapter) {
        throw new DefiError("unsupported_chain", "no bridge adapter");
      }

      const submission = await bridgeAdapter.execute(quote, {
        // The wallet bound to THIS call. No home-screen fallback
        // (`feedback_dapp_bridge_isolation`).
        wallet: context.wallet,
        chain: fromChainConfig,
      });

      // No `createPosition` here — the deposit on the destination chain
      // hasn't happened yet. The agent follows up with `defi_deposit`
      // once `bridge_status` reports a `completed` outcome.
      return {
        status: "success" as const,
        tx_confirmed: false,
        data: {
          phase: "bridging" as const,
          protocol_slug: protocolSlug,
          from_chain: fromChain,
          to_chain: toChain,
          from_asset: fromAsset,
          to_asset: toAsset,
          from_asset_symbol: fromAssetSymbol,
          amount_raw: amountRaw.toString(),
          expected_to_amount_raw: quote.to.amountRaw,
          to_amount_min_raw: quote.toAmountMinRaw,
          estimated_duration_seconds: quote.durationSeconds,
          bridge_tool: quote.bridge.key,
          bridge_tool_name: quote.bridge.name,
          provider: quote.provider,
          source_tx_hash: submission.sourceTxHash,
          blockers,
          // Terminal state is a four-value outcome, never a boolean, and
          // it is not known yet (§7.7.1).
          outcome: null,
          steps: quote.steps,
        },
      };
    } catch (err) {
      const code = classifyCrossChainError(err);
      if (__DEV__) {
        console.warn("[defi/crossChainDeposit] EXIT failed", {
          code,
          error: err,
        });
      }
      throw new ExecutorError(ExecutorErrorCode.InvalidInput, code);
    }
  });

/**
 * Source chain, accepting both the CAIP-2 form and the legacy integer.
 *
 * Keeping `from_chain_id` working is deliberate: the tool's contract is
 * unchanged (§8.3), so an agent that has not learned the new field still
 * works exactly as before.
 */
function resolveSourceChain(
  input: ToolInput,
  context: ExecutorContext,
  chains: ChainConfig[],
): ChainConfig {
  const caip2 = optionalString(input, "from_chain");
  if (caip2) {
    const match = chains.find((c) => chainToCaip2(c) === caip2);
    if (match) return match;
    throw new DefiError("unsupported_chain", "unknown from_chain");
  }

  const legacyId = Number(input.from_chain_id ?? context.activeChainId);
  if (!Number.isFinite(legacyId) || legacyId <= 0) {
    throw new DefiError("unsupported_chain", "invalid from chain");
  }
  const match = findChainForAdapter(chains, "eip155", legacyId);
  if (!match) {
    throw new DefiError("unsupported_chain", `from chainId=${legacyId}`);
  }
  return match;
}

/**
 * Source asset as CAIP-19.
 *
 * Precedence: explicit contract > native (by the CHAIN'S OWN symbol,
 * §4.3) > token-list lookup by symbol.
 */
function resolveSourceAsset(
  input: ToolInput,
  chain: ChainConfig,
  symbol: string,
): string {
  const explicit = optionalString(input, "from_asset_contract");
  if (explicit) {
    const asset = assetToCaip19(chain, explicit);
    if (!asset) {
      throw new DefiError(
        "unsupported_asset",
        "unrecognised from_asset_contract",
      );
    }
    return asset;
  }

  if (isNativeSymbol(chain, symbol)) {
    const asset = assetToCaip19(chain, null);
    if (!asset) {
      throw new DefiError("unsupported_asset", "chain has no native asset id");
    }
    return asset;
  }

  if (chain.namespace === "eip155") {
    const looked = lookupTokenContract(chain.chain.id, symbol);
    if (looked) {
      const asset = assetToCaip19(chain, looked);
      if (asset) return asset;
    }
  }

  throw new DefiError(
    "unsupported_asset",
    `${symbol} on the source chain (pass from_asset_contract to override)`,
  );
}

/**
 * Destination asset as CAIP-19. Prefers the opportunity's own underlying
 * asset (canonical), then an explicit override, then the chain's native
 * asset for native-asset venues.
 */
function resolveDestinationAsset(
  input: ToolInput,
  chain: ChainConfig,
  opportunityContract: string | undefined | null,
): string {
  const contract =
    opportunityContract ?? optionalString(input, "to_asset_contract") ?? null;
  const asset = assetToCaip19(chain, contract);
  if (!asset) {
    throw new DefiError("unsupported_asset", "unrecognised destination asset");
  }
  return asset;
}

/**
 * Map a thrown error onto a curated DeFi code. Never returns raw text:
 * `ToolResult.error` is fed back into LLM context on the next turn and
 * rendered through `agentErrorCopy` (CLAUDE.md user-facing errors).
 */
function classifyCrossChainError(err: unknown): string {
  if (err instanceof DefiError) return err.code;
  const code = (err as { code?: string } | null)?.code;
  if (code === "quote_stale") return "stale_precondition";
  if (code === "unsupported_chain") return "unsupported_chain";
  if (code === "wallet_cannot_execute") return "wallet_cannot_execute";
  return "network_error";
}
