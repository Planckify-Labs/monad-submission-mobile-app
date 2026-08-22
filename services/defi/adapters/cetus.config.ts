/**
 * Cetus CLMM config — NO SDK, and (like Current Finance) NO dynamic
 * "config not constants" fetch: Cetus has no Sui Move Registry entry for its
 * core package (checked 2026-08-22, `@cetus/*` names not found) and no
 * address-config HTTPS endpoint (their public API only serves pool/stats
 * DATA — `cetus.resolver.ts` already uses it for discovery, it carries no
 * package address).
 *
 * **A real methodology failure happened while pinning `CETUS_CLMM_PACKAGE`,
 * worth recording so it isn't repeated.** The first pin
 * (`0x1eabed72c53…`, the SDK's `clmm_pool.package_id` — itself the wrong
 * field, see below) was "confirmed" by finding real transactions in history
 * that called it — but `suix_queryTransactionBlocks` returns a transaction
 * regardless of whether it SUCCEEDED, and every one of those "confirming"
 * transactions had `effects.status === "failure"`, aborting on the exact
 * same `checked_package_version` mismatch this file exists to avoid — one
 * was 46 days old. Checking that a call merely APPEARS in history is not
 * verification; `effects.status` has to be checked, and recency has to be
 * real recency (minutes, not "found via a filtered query"), not assumed.
 * The correct package was ultimately found in Cetus's own developer docs
 * (`cetus-1.gitbook.io/cetus-developer-docs/developer/via-clmm-contract`,
 * "Latest Published CLMM Contract") and confirmed by finding transactions
 * from within the last 10 minutes that both called it AND succeeded.
 *
 * Separately: the SDK's `clmm_pool.package_id` field is the wrong one to use
 * as a moveCall target even when current — it's the TYPE-defining/original
 * publish address (what `Pool<A,B>`'s own on-chain `type` reports), not the
 * current callable package; `published_at` is the one to prefer, and even
 * that goes stale on the next upgrade (this SDK's `published_at`, v1.49.0,
 * was already one version behind the v1.50.0 the docs page names as latest
 * at time of writing — the pin below is the address from the docs page
 * instead, not from the SDK).
 *
 * **This WILL go stale on Cetus's next package upgrade** — there is no live
 * fetch behind it to catch that automatically. A future
 * `checked_package_version`-shaped abort means: check the docs page above
 * first (it was the authoritative source this time), and whatever address it
 * gives, CONFIRM via `effects.status` on a call from the last few minutes
 * before trusting it — don't repeat the transaction-history mistake.
 */

/** `pool::open_position` / `add_liquidity_fix_coin` / `current_sqrt_price` /
 *  `add_liquidity_pay_amount` / `repay_add_liquidity` moveCall target.
 *  Cetus's own developer docs, "Latest Published CLMM Contract" (mainnet-
 *  v0.0.14) — confirmed 2026-08-22 via `sui_devInspectTransactionBlock`
 *  succeeding on a real `open_position` call, after the version-gate abort
 *  that ruled out the SDK-derived address. */
export const CETUS_CLMM_PACKAGE =
  "0x25ebb9a7c50eb17b3fa9c5a30fb8b5ad8f97caaf4928943acbcff7153dfee5e3";

/** `router::swap` moveCall target (a separate, "integrate"-layer package —
 *  Cetus's core `pool` module has no direct user-facing swap entry point).
 *  Confirmed 2026-08-22 via real transactions from the last 10 minutes that
 *  both called `router::swap` on this exact package AND succeeded (not just
 *  appeared in history — see the file header for why that distinction
 *  matters). */
export const CETUS_INTEGRATE_PACKAGE =
  "0xb2db7142fa83210a7d78d9c12ac49c043b3cbbd482224fea6e3da00aa5a5ae2d";

/** `&GlobalConfig` shared object every `pool`/`router` call needs. From
 *  Cetus's own SDK config (`SDKConfig.clmmConfig.global_config_id`) — an
 *  identity object, not a moveCall target, so the "config not constants"
 *  staleness risk above doesn't apply to it the same way. Cross-checked
 *  directly against the object's own `package_version` field on-chain. */
export const CETUS_GLOBAL_CONFIG =
  "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f";
