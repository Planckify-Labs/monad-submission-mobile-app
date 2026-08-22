/**
 * Suilend config & package resolution — NO SDK.
 *
 * Found + fixed 2026-08-22: `suilendSui.ts` used to derive its moveCall
 * TARGET package from `marketType`'s prefix (`<pkg>::suilend::MAIN_POOL`) —
 * that address is the type's ORIGINAL/immutable publish address, not the
 * current one. Suilend has upgraded its package since (on-chain
 * `UpgradeCap.version` is 22 today; the published `@suilend/sdk@11.0.4`
 * itself only knows up to "PKG_V11", already behind), so a call built
 * against the stale address aborts `EIncorrectVersion` (code 1) — exactly
 * the "deposit AND withdraw both assert a fresh reserve price" abort
 * this codebase had misdiagnosed as a Pyth-oracle requirement (see
 * `suilendSui.ts` and `services/defi/bootstrap.ts`, corrected alongside
 * this file). Verified via `sui_devInspectTransactionBlock` against live
 * mainnet 2026-08-22: the type-origin package aborts `EIncorrectVersion`;
 * the CURRENT package (read live below) succeeds. Neither
 * `deposit_liquidity_and_mint_ctokens` nor
 * `redeem_ctokens_and_withdraw_liquidity_request` touch Pyth/price at all
 * (verified against `solendprotocol/suilend`'s `lending_market.move` —
 * their only asserts are version/amount/coin-type/rate-limiter).
 *
 * Split by mutability ("config not constants", spec §3.1):
 *   - The PACKAGE id is MUTABLE (upgradeable) — FETCHED here by reading the
 *     `sui::package::UpgradeCap.package` field on-chain, MMKV-cached with a
 *     TTL + a pinned fallback (mirrors `getNaviCore`/`getScallopCore`, just
 *     on-chain instead of an HTTPS endpoint — Suilend has no public address
 *     API; the UpgradeCap is the canonical, always-current source and needs
 *     no third party). `UPGRADE_CAP_ID` and `LENDING_MARKET_TYPE`'s package
 *     prefix are themselves immutable (pinned straight from `@suilend/sdk`'s
 *     `client.js` constants, cross-checked against the live `LendingMarket`
 *     object's own `type` field).
 *   - `LENDING_MARKET` / `MARKET_TYPE` are unaffected by this bug (they're
 *     object ids / type identity, not a moveCall target) and stay pinned in
 *     `suilend.resolver.ts` (api) as before.
 */

// `unknown` return, not the SDK's real `SuiObjectResponse`: that type is a
// discriminated union (`moveObject` | `package`) which TS won't structurally
// match against a narrow interface here — manual narrowing below instead.
type SuiObjectReader = {
  getObject(input: {
    id: string;
    options?: { showContent?: boolean };
  }): Promise<unknown>;
};

/** Suilend's mainnet `UpgradeCap` id (pinned, `@suilend/sdk`'s `client.js`). */
const UPGRADE_CAP_ID =
  "0x3d4ef1859c3ee9fc72858f588b56a09da5466e64f8cc4e90a7b3b909fba8a7ae";
const CACHE_KEY = "suilend_package_v1";
const TS_KEY = "suilend_package_ts_v1";
const STALE_MS = 30 * 60 * 1000;

/** Pinned fallback — the current package as of 2026-08-22 (UpgradeCap version 22). */
const FALLBACK_PACKAGE =
  "0x7c82c37d363c691254e6cd05cade2c58a02284165c9eb6dd699e4b6799108d60";

let inflight: Promise<string> | undefined;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

async function fetchPackageId(client: SuiObjectReader): Promise<string> {
  const obj = await client.getObject({
    id: UPGRADE_CAP_ID,
    options: { showContent: true },
  });
  const data = isRecord(obj) ? obj.data : undefined;
  const content = isRecord(data) ? data.content : undefined;
  const fields = isRecord(content) ? content.fields : undefined;
  const pkg = isRecord(fields) ? fields.package : undefined;
  return typeof pkg === "string" && /^0x[0-9a-fA-F]+$/.test(pkg)
    ? pkg
    : FALLBACK_PACKAGE;
}

/**
 * Resolve Suilend's current moveCall package (MMKV-cached, fetched from the
 * on-chain `UpgradeCap`, pinned fallback). Never breaks a deposit on a config
 * read. Mirrors `getNaviCore`/`getScallopCore`.
 */
export async function getSuilendPackage(
  client: SuiObjectReader,
): Promise<string> {
  const { storage } = await import("@/lib/storage/mmkv");
  const cached = storage.getString(CACHE_KEY);
  const ts = Number.parseInt(storage.getString(TS_KEY) ?? "0", 10) || 0;
  if (cached && Date.now() - ts < STALE_MS) return cached;
  if (inflight) return inflight;

  const task = (async (): Promise<string> => {
    try {
      const pkg = await fetchPackageId(client);
      storage.set(CACHE_KEY, pkg);
      storage.set(TS_KEY, Date.now().toString());
      return pkg;
    } catch {
      return cached || FALLBACK_PACKAGE;
    } finally {
      inflight = undefined;
    }
  })();
  inflight = task;
  return task;
}
