/**
 * Expected mobile tool list — the mobile mirror of every `executor: "mobile"`
 * tool in the server `TOOL_REGISTRY`.
 *
 * Hardcoded because the server lives in a sibling package we don't import at
 * build time. This module deliberately has ZERO imports (it's a plain string
 * array) so `registryParity.test.ts` can load it under vitest WITHOUT pulling
 * the RN-heavy executor graph via `./index` — that graph (mmkv, secure-store,
 * viem clients) is unloadable outside the app runtime, which is why the parity
 * test used to be excluded from vitest. Keeping the list here makes the
 * cross-repo parity check actually runnable + enforced.
 *
 * KEEP IN SYNC with server `agent-api/src/tools/registry.ts` (the
 * `registryParity` vitest test + `pnpm check:agents` both enforce it).
 */
export const EXPECTED_MOBILE_TOOLS: ReadonlyArray<string> = [
  // chain-agnostic capability tools (model-facing balance/asset/send surface)
  "get_native_balance",
  "get_wallet_assets",
  "send_native",
  "send_token",
  // blockchain reads
  "get_balance",
  "get_wallet_balance",
  "read_contract",
  "get_transaction",
  "get_wallet_address",
  "get_supported_chains",
  "get_wallet_tokens",
  // simulate
  "estimate_gas",
  // blockchain writes
  "send_native_token",
  "transfer_erc20",
  "write_contract",
  "approve_erc20",
  // points reads — public (no JWT)
  "get_redemption_catalog",
  "search_redemption_catalog",
  "get_product_details",
  "get_product_input_fields",
  "get_points_price",
  // points reads — auth required
  "get_redemption_categories",
  "get_points_balance",
  "get_points_history",
  "get_redemption_status",
  "get_redemption_history",
  // points writes
  "deposit_points",
  "execute_redemption",
  // points simulate — SIWE login flow
  "request_authentication",
  // address book reads
  "get_address_book",
  "get_address_book_entry",
  "search_address_book",
  // solana native
  "get_wallet_sol_balance",
  "get_sol_balance",
  "send_sol",
  "get_wallet_spl_tokens",
  "send_spl_token",
  // solana takumipay
  "execute_booking_sol",
  "deposit_points_sol",
  // sui native
  "get_wallet_sui_balance",
  "get_sui_balance",
  "send_sui",
  "get_wallet_sui_coins",
  "send_sui_coin",
  // stellar native (docs/stellar-chain-support-spec.md §7.2)
  "get_wallet_xlm_balance",
  "get_xlm_balance",
  "send_xlm",
  "get_wallet_stellar_assets",
  "send_stellar_asset",
  "establish_stellar_trustline",
  // defi (spec §11 — full canonical set)
  "defi_list_opportunities",
  "defi_list_positions",
  "defi_get_config",
  "defi_simulate_deposit",
  "defi_deposit",
  "defi_withdraw",
  "defi_claim",
  "defi_rebalance",
  "defi_cross_chain_deposit",
  "defi_compound",
  // defi Sui Intent Engine (spec §7.1) — onchain reads/writes, executor: mobile
  "defi_intent_preview",
  "defi_intent_execute",
  // general-purpose bridge (docs/bridge-capability-spec.md §8.3) — owned by
  // the DeFi agent via the `bridge_` prefix on its manifest entry
  "bridge_get_support",
  "bridge_quote",
  "bridge_execute",
  "bridge_status",
  // agent-initiated x402 micropayments (spec Phase 5 §5.5)
  "x402_fetch",
];

/**
 * Authoritative mobile-side set of every tool the server registry declares
 * `capability: "write"` (i.e. it can move value or change on-chain / points
 * state). This is the mobile app's OWN notion of which tools are writes —
 * deliberately independent of the `meta.capability` label that arrives on the
 * wire.
 *
 * WHY THIS EXISTS (fund-safety, defense-in-depth): `authorizeToolCall` is the
 * single gate that decides whether an agent tool runs silently or must show an
 * approval card, and it keys that decision off `payload.meta.capability`. That
 * label is produced by the server and travels over the network. If a
 * compromised, buggy, or MITM'd stream ever labels a real write (say
 * `send_token`) as `"read"`, the gate would run it with NO approval card and
 * NO user in the loop — the exact "the agent moved my funds without asking"
 * failure class. By cross-checking the tool NAME against this local set,
 * `authorizeToolCall` treats any known write AT LEAST as restrictively as a
 * write regardless of what the wire claims, so a mislabeled write can never
 * execute silently.
 *
 * We only harden the dangerous direction (write mislabeled read). A read
 * mislabeled write is not a fund-safety hole (it only adds friction) and is
 * left to the wire so a real server change isn't masked here.
 *
 * KEEP IN SYNC with the server registry: `registryParity.test.ts` asserts this
 * set equals exactly the `capability: "write"` mobile tools in
 * `agent-api/src/tools/registry.ts`, so a new write tool that isn't added here
 * fails CI rather than silently losing its cross-check.
 */
export const MOBILE_WRITE_TOOLS: ReadonlySet<string> = new Set<string>([
  // chain-agnostic capability writes
  "send_native",
  "send_token",
  // evm writes
  "send_native_token",
  "transfer_erc20",
  "write_contract",
  "approve_erc20",
  // points writes
  "deposit_points",
  "execute_redemption",
  // solana takumipay writes
  "execute_booking_sol",
  "deposit_points_sol",
  // solana native writes
  "send_sol",
  "send_spl_token",
  // sui native writes
  "send_sui",
  "send_sui_coin",
  // stellar native writes
  "send_xlm",
  "send_stellar_asset",
  "establish_stellar_trustline",
  // defi writes
  "defi_deposit",
  "defi_withdraw",
  "defi_claim",
  "defi_rebalance",
  "defi_cross_chain_deposit",
  "defi_compound",
  // sui intent engine write
  "defi_intent_execute",
  // bridge write — moves value cross-chain, irreversible mid-flight
  "bridge_execute",
  // agent-initiated x402 micropayment (spends within a pre-signed allowance)
  "x402_fetch",
]);
