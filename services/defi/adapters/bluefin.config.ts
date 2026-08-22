/**
 * Bluefin Spot CLMM config — NO SDK, and (like Cetus) NO dynamic "config not
 * constants" fetch: Bluefin's `@firefly-exchange/library-sui` SDK takes its
 * deployment config as a caller-supplied JSON file (their own README:
 * "GET THE LATEST deployment.json file"), not something served from a public
 * HTTPS endpoint the SDK fetches itself — unlike Turbos's hosted
 * `contract.json`. No Sui Move Registry entry either (checked 2026-08-22).
 *
 * `CURRENT_PACKAGE` was found and verified the SAME way Cetus's had to be,
 * after the SDK's own type-origin package (the pool object's own on-chain
 * `type` field, `0x3492c874c…`) aborted `verify_version` (code 1001) on a
 * live devInspect: `suix_queryTransactionBlocks` filtered by `InputObject`
 * on a real, active pool (NOT `MoveFunction` on a guessed package — that
 * only tells you a package was CALLED, not that the call succeeded) found
 * real transactions from the last minute calling `pool::open_position` +
 * `gateway::provide_liquidity_with_fixed_amount` on
 * `0xd075338d105482f1527cbfd363d6413558f184dec36d9138a70261e87f486e9c`, both
 * with `effects.status === "success"`.
 *
 * **This WILL go stale on Bluefin's next package upgrade** — there is no
 * live fetch behind it to catch that automatically. A future
 * `verify_version`-shaped abort means: repeat the `InputObject`-filtered
 * query on a real pool object above, confirm via `effects.status` on a call
 * from the last few minutes before trusting whatever package it names.
 */

/** `pool::open_position` / `pool::swap` / `gateway::provide_liquidity_with_
 *  fixed_amount` moveCall target. Confirmed 2026-08-22 via two real,
 *  successful, <2-minute-old mainnet transactions (see header). */
export const BLUEFIN_CURRENT_PACKAGE =
  "0xd075338d105482f1527cbfd363d6413558f184dec36d9138a70261e87f486e9c";

/** `&GlobalConfig` shared object every `pool`/`gateway` call needs. From the
 *  same two real transactions (identical object id in both). */
export const BLUEFIN_GLOBAL_CONFIG =
  "0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352";
