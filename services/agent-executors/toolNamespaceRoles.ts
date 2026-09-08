/**
 * Every agent tool's relationship to a blockchain namespace.
 *
 * WHY THIS EXISTS. The app supports four namespaces, but a private-key
 * import only ever covers ONE, so any tool that can point at a chain the
 * user holds no key on has to answer "what happens then?". Before this
 * table, 85 tools answered it 85 times, inconsistently: exactly one site
 * in the whole executor tree scanned the user's wallets
 * (`defi/bridge.ts`), everything else compared against the ACTIVE wallet
 * only — which is right for signing and wrong for a destination. The
 * visible results were a cross-chain deposit that rejected seed-phrase
 * users who owned the destination wallet, and a family of failures that
 * told users a chain was "not available on this network" when the chain
 * was fine and they simply needed a wallet.
 *
 * WHAT IT ENFORCES. `registryParity.test.ts` asserts this table's keys
 * equal `EXPECTED_MOBILE_TOOLS` exactly, so a new tool cannot be added
 * without declaring a role. That is the guarantee: the question becomes
 * impossible to skip. It does NOT claim to gate execution at runtime —
 * `authorizeToolCall` is a PERMISSION gate, and routing a missing wallet
 * through its deny path would render "permission denied", reintroducing
 * the wrong-copy bug this work exists to remove. Enforcement of the
 * access rule itself lives where the tool can fail with accurate,
 * actionable copy: the executor, via
 * `services/walletPresence/resolveNamespaceAccess`.
 *
 * ZERO RUNTIME IMPORTS, deliberately — same constraint as
 * `expectedMobileTools.ts`, which the parity test loads without pulling
 * the RN-heavy executor graph (mmkv, secure-store, viem). The
 * `counterparty` role therefore names the INPUT KEY holding the CAIP-2
 * chain rather than carrying a parser; callers parse it.
 */

import type { Namespace } from "@/services/chains/types";
import type { NamespaceRole } from "@/services/walletPresence";

export type ToolNamespaceSpec =
  | { role: Exclude<NamespaceRole, "counterparty"> }
  /**
   * Acts on a chain that may differ from the active wallet's, where the
   * caller names it: `chainArg` is the input key holding the CAIP-2 id.
   */
  | { role: "counterparty"; chainArg: string }
  /**
   * Same, but the chain is fixed by the tool itself rather than supplied
   * as an argument (a Sui-only planner is always Sui).
   */
  | { role: "counterparty"; namespace: Namespace };

const ACTIVE: ToolNamespaceSpec = { role: "active" };
const AGNOSTIC: ToolNamespaceSpec = { role: "agnostic" };
const DISCOVERY: ToolNamespaceSpec = { role: "discovery" };

export const TOOL_NAMESPACE_ROLES: Readonly<Record<string, ToolNamespaceSpec>> =
  {
    // ── Chain-agnostic capability facade ───────────────────────────────
    // These dispatch on the ACTIVE wallet's own namespace and expose no
    // chain argument, so they cannot be aimed at a chain the user lacks.
    get_native_balance: ACTIVE,
    get_wallet_assets: ACTIVE,
    get_wallet_nfts: ACTIVE,
    send_native: ACTIVE,
    send_token: ACTIVE,

    // ── EVM ────────────────────────────────────────────────────────────
    get_balance: ACTIVE,
    get_wallet_balance: ACTIVE,
    read_contract: ACTIVE,
    get_transaction: ACTIVE,
    get_wallet_tokens: ACTIVE,
    estimate_gas: ACTIVE,
    send_native_token: ACTIVE,
    transfer_erc20: ACTIVE,
    write_contract: ACTIVE,
    approve_erc20: ACTIVE,

    // ── Namespace-agnostic wallet reads ────────────────────────────────
    get_wallet_address: ACTIVE,
    // Reports every configured chain across all namespaces, which is
    // exactly why the model can propose one the user can't act on. Kept as
    // discovery: the list itself is legitimate, ownership is the caller's
    // to convey.
    get_supported_chains: DISCOVERY,

    // ── Solana ─────────────────────────────────────────────────────────
    get_wallet_sol_balance: ACTIVE,
    get_sol_balance: ACTIVE,
    send_sol: ACTIVE,
    get_wallet_spl_tokens: ACTIVE,
    send_spl_token: ACTIVE,
    execute_booking_sol: ACTIVE,
    deposit_points_sol: ACTIVE,

    // ── Sui ────────────────────────────────────────────────────────────
    get_wallet_sui_balance: ACTIVE,
    get_sui_balance: ACTIVE,
    send_sui: ACTIVE,
    get_wallet_sui_coins: ACTIVE,
    send_sui_coin: ACTIVE,

    // ── Stellar ────────────────────────────────────────────────────────
    get_wallet_xlm_balance: ACTIVE,
    get_xlm_balance: ACTIVE,
    send_xlm: ACTIVE,
    get_wallet_stellar_assets: ACTIVE,
    send_stellar_asset: ACTIVE,
    establish_stellar_trustline: ACTIVE,

    // ── DeFi ───────────────────────────────────────────────────────────
    // Lists pools across every chain (`namespace: "all"` is a sanctioned
    // escape hatch), so absence of a wallet must NOT hide a row — the card
    // marks it instead. See `OpportunityListCard`'s third row state.
    defi_list_opportunities: DISCOVERY,
    defi_list_positions: DISCOVERY,
    defi_get_config: AGNOSTIC,
    defi_simulate_deposit: ACTIVE,
    defi_deposit: ACTIVE,
    defi_withdraw: ACTIVE,
    defi_claim: ACTIVE,
    defi_rebalance: ACTIVE,
    defi_compound: ACTIVE,
    // A plan PINS the wallet that will eventually sign, so the wallet on
    // screen must be the wallet recorded — `active`, never the laxer
    // `counterparty` (quick-invest spec §12.1a rule 4).
    defi_set_recurring_invest: ACTIVE,
    // Reading your own plans is wallet-scoped server-side by the JWT and
    // needs no chain at all.
    defi_list_recurring_invest: AGNOSTIC,
    // The one DeFi tool that bridges before depositing: its destination is
    // a chain it names, and the wallet there never signs the source-side
    // transaction.
    defi_cross_chain_deposit: { role: "counterparty", chainArg: "to_chain" },

    // ── Sui Intent Engine ──────────────────────────────────────────────
    // Preview only compiles and dry-runs, so it resolves an OWNED Sui
    // wallet rather than demanding Sui be active; execute signs and so
    // stays bound to the active wallet.
    defi_intent_preview: { role: "counterparty", namespace: "sui" },
    defi_intent_execute: ACTIVE,

    // ── Bridge ─────────────────────────────────────────────────────────
    bridge_get_support: AGNOSTIC,
    bridge_quote: { role: "counterparty", chainArg: "to_chain" },
    bridge_execute: { role: "counterparty", chainArg: "to_chain" },
    // Pure status lookup against a submitted transfer; touches no wallet.
    bridge_status: AGNOSTIC,

    // ── x402 ───────────────────────────────────────────────────────────
    // Settles from the active wallet within a pre-signed allowance.
    x402_fetch: ACTIVE,

    // ── Points / catalog / address book ────────────────────────────────
    // Off-chain services keyed by the user's account, with no chain
    // dimension at all.
    get_redemption_catalog: AGNOSTIC,
    search_redemption_catalog: AGNOSTIC,
    get_product_details: AGNOSTIC,
    get_product_input_fields: AGNOSTIC,
    get_points_price: AGNOSTIC,
    get_redemption_categories: AGNOSTIC,
    get_points_balance: AGNOSTIC,
    get_points_history: AGNOSTIC,
    get_redemption_status: AGNOSTIC,
    get_redemption_history: AGNOSTIC,
    deposit_points: ACTIVE,
    execute_redemption: AGNOSTIC,
    request_authentication: ACTIVE,
    get_address_book: AGNOSTIC,
    get_address_book_entry: AGNOSTIC,
    search_address_book: AGNOSTIC,
  };
