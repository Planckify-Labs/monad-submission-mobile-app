import BalancesCard from "./cards/BalancesCard";
import BridgeProgressCard from "./cards/BridgeProgressCard";
import BridgeQuoteCard from "./cards/BridgeQuoteCard";
import IntentPreviewCard from "./cards/IntentPreviewCard";
import OpportunityListCard from "./cards/OpportunityListCard";
import PendingTxCard from "./cards/PendingTxCard";
import PositionListCard from "./cards/PositionListCard";
import ProductDetailCard from "./cards/ProductDetailCard";
import RebalancePreviewCard from "./cards/RebalancePreviewCard";
import RedemptionCatalogCard from "./cards/RedemptionCatalogCard";
import SolanaPendingTxCard from "./cards/SolanaPendingTxCard";
import SpendingApprovalCard from "./cards/SpendingApprovalCard";
import StellarPendingTxCard from "./cards/StellarPendingTxCard";
import StrategyConfigCard from "./cards/StrategyConfigCard";
import SuiPendingTxCard from "./cards/SuiPendingTxCard";
import SwapQuoteCard from "./cards/SwapQuoteCard";
import UnifiedPendingTxCard from "./cards/UnifiedPendingTxCard";
import X402FetchCard from "./cards/X402FetchCard";
import type { ToolComponent } from "./types";

/**
 * Tool names whose results render through `BalancesCard`. Exported so
 * `MessageContent` can dedupe back-to-back balance reads in the same
 * assistant turn — the LLM will sometimes call both a list-balances
 * tool and a single-native-balance tool to "double-check" itself, and
 * since both now feed the same card, the user sees two identical
 * cards. Dedupe is content-addressed (see `MessageContent.tsx`), not
 * tool-name based, so legitimately distinct calls (different chain,
 * different address) still render separately.
 */
export const BALANCE_TOOL_NAMES = new Set([
  // chain-agnostic capability tools (the model-facing surface)
  "get_native_balance",
  "get_wallet_assets",
  "get_wallet_tokens",
  "get_wallet_spl_tokens",
  "get_wallet_sui_coins",
  "get_balance",
  "get_wallet_balance",
  "get_sol_balance",
  "get_wallet_sol_balance",
  "get_sui_balance",
  "get_wallet_sui_balance",
  "get_wallet_stellar_assets",
  "get_xlm_balance",
  "get_wallet_xlm_balance",
]);

// biome-ignore lint/suspicious/noExplicitAny: registry is intentionally open-typed
export const toolComponents: Record<string, ToolComponent<any, any>> = {
  // Chain-agnostic capability sends → one dispatcher card that reuses the
  // per-namespace receipt cards (the model-facing surface).
  send_native: UnifiedPendingTxCard,
  send_token: UnifiedPendingTxCard,
  send_native_token: PendingTxCard,
  transfer_erc20: PendingTxCard,
  write_contract: PendingTxCard,
  approve_spending: SpendingApprovalCard,
  approveSpending: SpendingApprovalCard,
  swap_quote: SwapQuoteCard,
  // Single card for every namespace's balance read — list-tokens AND
  // single-native-balance lookups. New per-namespace executors plug in
  // by emitting `WalletBalancesPayload` and being added to this map —
  // no UI work needed. The chain-agnostic capability tools
  // (`get_native_balance` / `get_wallet_assets`) are the model-facing
  // surface; the per-namespace entries below stay for history replay.
  get_native_balance: BalancesCard,
  get_wallet_assets: BalancesCard,
  get_wallet_tokens: BalancesCard,
  get_wallet_spl_tokens: BalancesCard,
  get_wallet_sui_coins: BalancesCard,
  get_balance: BalancesCard,
  get_wallet_balance: BalancesCard,
  get_sol_balance: BalancesCard,
  get_wallet_sol_balance: BalancesCard,
  get_sui_balance: BalancesCard,
  get_wallet_sui_balance: BalancesCard,
  get_wallet_stellar_assets: BalancesCard,
  get_xlm_balance: BalancesCard,
  get_wallet_xlm_balance: BalancesCard,
  get_redemption_catalog: RedemptionCatalogCard,
  search_redemption_catalog: RedemptionCatalogCard,
  get_product_details: ProductDetailCard,
  send_sol: SolanaPendingTxCard,
  send_spl_token: SolanaPendingTxCard,
  send_sui: SuiPendingTxCard,
  send_sui_coin: SuiPendingTxCard,
  send_xlm: StellarPendingTxCard,
  send_stellar_asset: StellarPendingTxCard,
  establish_stellar_trustline: StellarPendingTxCard,
  defi_list_opportunities: OpportunityListCard,
  defi_list_positions: PositionListCard,
  defi_deposit: PendingTxCard,
  defi_withdraw: PendingTxCard,
  defi_claim: PendingTxCard,
  defi_rebalance: RebalancePreviewCard,
  // Sui Intent Engine (spec §7.1): preview is an informational read card;
  // execute reuses the Sui pending-tx receipt + approval gate.
  defi_intent_preview: IntentPreviewCard,
  defi_intent_execute: SuiPendingTxCard,
  defi_get_config: StrategyConfigCard,
  // Bridge (docs/bridge-capability-spec.md §7). The quote card is the
  // full disclosure surface; the progress card owns the post-submit half
  // of the UX, which `bridge_execute` and `bridge_status` both feed.
  bridge_quote: BridgeQuoteCard,
  bridge_execute: BridgeProgressCard,
  bridge_status: BridgeProgressCard,
  x402_fetch: X402FetchCard,
};

/**
 * Tools whose cards embed the "set up your DeFi strategy" CTA.
 *
 * A single turn can render several of them (e.g. one opportunity list per
 * asset), and the CTA is identical every time. `MessageContent` uses this set
 * to grant the CTA to the first such card in a message and withhold it from
 * the rest, so the prompt appears once per turn instead of once per card.
 */
export const SETUP_CTA_TOOLS: ReadonlySet<string> = new Set([
  "defi_list_opportunities",
  "defi_list_positions",
]);
