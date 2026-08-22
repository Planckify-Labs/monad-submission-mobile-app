/**
 * Kai Finance config & package resolution — NO SDK.
 *
 * Kai's Single Asset Vaults (`vault::deposit`/`vault::withdraw`/
 * `vault::redeem_withdraw_ticket`) are public Move calls on a package that
 * moves on upgrade, same as every other Sui protocol here ("config not
 * constants", spec §3.1). Kai has no HTTPS address API of its own (unlike
 * Scallop/Ember/NAVI) and no on-chain factory/registry to enumerate — but it
 * IS registered on the Sui Move Registry (MVR, `@kai/sav`), which is exactly
 * the primitive Sui itself provides for "resolve a package name to its
 * current address" and needs no third-party infra:
 *
 *   https://mainnet.mvr.mystenlabs.com/v1/names/@kai/sav
 *   → { "package_address": "0x…", "version": N, … }
 *
 * FETCHED here, MMKV-cached with a TTL + a pinned fallback (mirrors
 * `getEmberCore`/`getNaviCore`). Confirmed 2026-08-22: calling `vault::deposit`
 * against the vault object's OWN on-chain type-package (not the MVR-current
 * one) aborts `assert_version` — the exact package-staleness bug Suilend had —
 * so this fetch is load-bearing, not a defensive extra.
 */

const MVR_URL = "https://mainnet.mvr.mystenlabs.com/v1/names/@kai/sav";
const CACHE_KEY = "kai_package_v1";
const TS_KEY = "kai_package_ts_v1";
const STALE_MS = 30 * 60 * 1000;

/** Pinned fallback — `@kai/sav` version 15 (kai-v15), verified 2026-08-22. */
const FALLBACK_PACKAGE =
  "0x909ad5f8badc34b49507dbd0cb9fb88cc816b531323659e3aefb992d4ab58474";

interface MvrPayload {
  package_address?: string;
}

let inflight: Promise<string> | undefined;

async function fetchPackageId(): Promise<string> {
  const res = await fetch(MVR_URL);
  const json = (await res.json()) as MvrPayload;
  const pkg = json?.package_address;
  return pkg && /^0x[0-9a-fA-F]+$/.test(pkg) ? pkg : FALLBACK_PACKAGE;
}

/**
 * Resolve Kai's current moveCall package (MMKV-cached, fetched from MVR,
 * pinned fallback). Never breaks a deposit on a config read. Mirrors
 * `getEmberCore`/`getNaviCore`/`getSuilendPackage`.
 */
export async function getKaiPackage(): Promise<string> {
  const { storage } = await import("@/lib/storage/mmkv");
  const cached = storage.getString(CACHE_KEY);
  const ts = Number.parseInt(storage.getString(TS_KEY) ?? "0", 10) || 0;
  if (cached && Date.now() - ts < STALE_MS) return cached;
  if (inflight) return inflight;

  const task = (async (): Promise<string> => {
    try {
      const pkg = await fetchPackageId();
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
