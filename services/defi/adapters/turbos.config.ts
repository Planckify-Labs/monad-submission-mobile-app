/**
 * Turbos Finance config resolution — NO SDK.
 *
 * `position_manager::mint`/`swap_router::swap_*_with_return_` need three
 * MUTABLE coordinates (moveCall package + two shared config objects) that
 * move on upgrade — same "config not constants" story as every other Sui
 * protocol here (spec §3.1). Unlike Cetus (no address API at all) Turbos
 * publishes its own live config as a plain HTTPS JSON document — the exact
 * source their own `turbos-clmm-sdk` npm package reads
 * (`src/lib/contract.ts`'s `fetchJSON`):
 *
 *   https://s3.amazonaws.com/app.turbos.finance/sdk/contract.json
 *   → { mainnet: { contract: { PackageId, Positions, Versioned, … } }, … }
 *
 * FETCHED here, MMKV-cached with a TTL + pinned fallbacks (mirrors
 * `getKaiPackage`/`getSuilendPackage`). Pinned values are the live
 * `mainnet.contract` fields read 2026-08-22 — `PackageId` is the CURRENT
 * callable package (NOT `PackageIdOriginal`, the pool object's own on-chain
 * `type` address — the same type-origin-vs-callable distinction that bit
 * Suilend/Current; a live mainnet Pool object's `type` field was
 * cross-checked and does read `PackageIdOriginal` here, confirming the two
 * really do diverge for this protocol too).
 */

const CONFIG_URL =
  "https://s3.amazonaws.com/app.turbos.finance/sdk/contract.json";
const CACHE_KEY = "turbos_config_v1";
const TS_KEY = "turbos_config_ts_v1";
const STALE_MS = 30 * 60 * 1000;

export interface TurbosContractConfig {
  packageId: string;
  positions: string;
  versioned: string;
}

/** Pinned fallback — mainnet `contract` fields read 2026-08-22. */
const FALLBACK_CONFIG: TurbosContractConfig = {
  packageId:
    "0xa5a0c25c79e428eba04fb98b3fb2a34db45ab26d4c8faf0d7e39d66a63891e64",
  positions:
    "0xf5762ae5ae19a2016bb233c72d9a4b2cba5a302237a82724af66292ae43ae52d",
  versioned:
    "0xf1cf0e81048df168ebeb1b8030fad24b3e0b53ae827c25053fff0779c1445b6f",
};

interface TurbosConfigPayload {
  mainnet?: {
    contract?: {
      PackageId?: string;
      Positions?: string;
      Versioned?: string;
    };
  };
}

function isHexId(v: unknown): v is string {
  return typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v);
}

let inflight: Promise<TurbosContractConfig> | undefined;

async function fetchConfig(): Promise<TurbosContractConfig> {
  const res = await fetch(CONFIG_URL);
  const json = (await res.json()) as TurbosConfigPayload;
  const c = json?.mainnet?.contract;
  if (
    !c ||
    !isHexId(c.PackageId) ||
    !isHexId(c.Positions) ||
    !isHexId(c.Versioned)
  ) {
    return FALLBACK_CONFIG;
  }
  return {
    packageId: c.PackageId,
    positions: c.Positions,
    versioned: c.Versioned,
  };
}

/**
 * Resolve Turbos's current moveCall config (MMKV-cached, fetched from their
 * hosted `contract.json`, pinned fallback). Never breaks a deposit on a
 * config read. Mirrors `getKaiPackage`/`getSuilendPackage`.
 */
export async function getTurbosConfig(): Promise<TurbosContractConfig> {
  const { storage } = await import("@/lib/storage/mmkv");
  const cached = storage.getString(CACHE_KEY);
  const ts = Number.parseInt(storage.getString(TS_KEY) ?? "0", 10) || 0;
  if (cached && Date.now() - ts < STALE_MS) {
    try {
      const parsed = JSON.parse(cached) as TurbosContractConfig;
      if (
        isHexId(parsed.packageId) &&
        isHexId(parsed.positions) &&
        isHexId(parsed.versioned)
      ) {
        return parsed;
      }
    } catch {
      // fall through to a fresh fetch
    }
  }
  if (inflight) return inflight;

  const task = (async (): Promise<TurbosContractConfig> => {
    try {
      const config = await fetchConfig();
      storage.set(CACHE_KEY, JSON.stringify(config));
      storage.set(TS_KEY, Date.now().toString());
      return config;
    } catch {
      if (cached) {
        try {
          return JSON.parse(cached) as TurbosContractConfig;
        } catch {
          // fall through to the pinned fallback
        }
      }
      return FALLBACK_CONFIG;
    } finally {
      inflight = undefined;
    }
  })();
  inflight = task;
  return task;
}
