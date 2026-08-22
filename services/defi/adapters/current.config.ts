/**
 * Current Finance config — NO SDK, and (unlike every other Sui venue here)
 * NO dynamic "config not constants" fetch either.
 *
 * Current is closed-source: no public GitHub repo, no Sui Move Registry
 * entry (`@current/*` — checked 2026-08-22, not found), no address/config API
 * endpoint (`api.current.finance` only serves market/reward DATA, not
 * contract addresses — checked every plausible path). The type-defining
 * package (`0xfe1d8929…`, what the `Market<M>` object's own on-chain `type`
 * reports) is ALREADY stale — calling through it aborts `ensure_version_
 * matches`, the same package-upgrade trap every other Sui protocol here hit.
 *
 * The CURRENT callable package below was recovered the only way available:
 * reading a real, recent mainnet transaction's `deposit::deposit` /
 * `withdraw::withdraw` MoveCall (`suix_queryTransactionBlocks` filtered on
 * `app::ProtocolApp` as an input object, most-recent first) and taking the
 * package it actually called successfully. That is NOT something to run at
 * request time on a device (transaction-history scanning is slow, and
 * "most recent tx" is a heuristic, not an authoritative source the way an
 * `UpgradeCap` read or an MVR name is) — so this is PINNED, verified
 * 2026-08-22, with no refresh path.
 *
 * **This WILL go stale on Current's next package upgrade**, and unlike every
 * other pinned fallback in this codebase, there is no live fetch behind it to
 * catch that automatically — a future `ensure_version_matches` abort on this
 * adapter means: re-run the same transaction-history recovery (or check
 * whether Current has since shipped an MVR entry / address API, and use that
 * instead — check first, this workaround was a last resort).
 */

export const CURRENT_PACKAGE =
  "0x45bae0425e9098ce5cba3d3fa2836220ad24c9f88aa0dffffb5a52b49319fc70";
