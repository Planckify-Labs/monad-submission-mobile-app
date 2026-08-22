/**
 * Sui liquid-staking (LST) venue config — NO SDK.
 *
 * Each venue turns a `Coin<SUI>` into a liquid-staking receipt coin (haSUI /
 * vSUI / sSUI / afSUI) via one public Move call. Unlike NAVI (which
 * version-gates its shared `Storage`, so the package is fetched), these staking
 * entry points are STABLE public functions on immutable shared objects, so the
 * package id + object ids are pinned here ("config not constants": this is the
 * immutable protocol identity, verified on-chain, not a mutable pointer).
 *
 * Every id below was decoded from a REAL recent mainnet stake transaction
 * (verified 2026-07-04) — never hand-guessed. The deposit legs are all
 * ORACLE-FREE (params are only `SuiSystemState` + the venue's pool objects +
 * `Coin<SUI>`; no Pyth `PriceInfoObject`), which lets these badge "Deposit
 * in-app" without a package-refresh dependency at all. (Suilend's deposit
 * turned out to be oracle-free too, once its own stale-package bug was fixed
 * 2026-08-22 — see `suilendSui.ts` — so "unlike Suilend" no longer applies;
 * these venues are simply pinned rather than fetched, for a different reason:
 * their entry points are immutable, not upgradeable.)
 *
 * The mobile `SuiLstAdapter` routes here by `DepositTarget.venue`; the backend
 * `SuiLstResolver` emits `{ kind: "sui-lst", venue, lstType }` and the LST
 * opportunity source synthesizes the pool rows.
 */

export type SuiLstVenue = "haedal" | "volo" | "springsui" | "aftermath";

/**
 * How the venue's stake call is shaped. The `SuiLstAdapter` switches on this to
 * assemble the exact move-call — kept as data so a new LST that reuses a shape
 * needs only a config row, not adapter code.
 *   - "returns-coin-validator" → fn(SuiSystemState, pool, Coin<SUI>, validator) -> Coin<LST>   (Haedal)
 *   - "entry-pool-metadata"    → entry fn(pool, metadata, SuiSystemState, Coin<SUI>)            (Volo; mints to sender)
 *   - "mint-generic"           → fn<LST>(pool, SuiSystemState, Coin<SUI>) -> Coin<LST>          (SpringSui)
 *   - "aftermath-vault"        → fn(vault, safe, SuiSystemState, refVault, Coin<SUI>, validator) -> Coin<LST> (Aftermath)
 */
export type SuiLstStakeShape =
  | "returns-coin-validator"
  | "entry-pool-metadata"
  | "mint-generic"
  | "aftermath-vault";

/**
 * How the venue's UNSTAKE (exit) call is shaped — all consume the LST receipt
 * coin and are ORACLE-FREE (verified on-chain 2026-07-04):
 *   - "redeem-generic"    → fn<LST>(pool, Coin<LST>, SuiSystemState) -> Coin<SUI>   (SpringSui; instant)
 *   - "volo-unstake"      → entry fn(pool, metadata, SuiSystemState, Coin<LST>)     (Volo; instant, SUI→sender)
 *   - "haedal-instant"    → fn(pool, Coin<LST>)                                     (Haedal; instant, SUI→sender)
 *   - "aftermath-unstake" → fn(vault, safe, Coin<LST>)                              (Aftermath; DELAYED, SUI after epoch)
 * "redeem-generic" returns the `Coin<SUI>` (transferred to sender); the others
 * deliver SUI to the sender internally. All are FULL-EXIT (redeem the whole
 * LST balance) for now.
 */
export type SuiLstWithdrawShape =
  | "redeem-generic"
  | "volo-unstake"
  | "haedal-instant"
  | "aftermath-unstake";

export interface SuiLstConfig {
  venue: SuiLstVenue;
  /** Human label for the deposit/preview card. */
  displayName: string;
  /** Receipt-coin symbol (haSUI / vSUI / sSUI / afSUI). */
  lstSymbol: string;
  /** Fully-qualified receipt coin type. */
  lstType: string;
  /** Staking package (the move-call target package). */
  packageId: string;
  /** `${module}::${function}` of the stake call. */
  stakeFn: string;
  stakeShape: SuiLstStakeShape;
  /** `${module}::${function}` of the unstake/redeem (exit) call. */
  unstakeFn: string;
  withdrawShape: SuiLstWithdrawShape;
  /** True when the exit settles after an epoch (SUI arrives later) — Aftermath. */
  withdrawDelayed?: boolean;
  /** Primary shared pool object (Staking / NativePool / LiquidStakingInfo / StakedSuiVault). */
  poolObject: string;
  /** Volo `Metadata<CERT>` shared object. */
  metadataObject?: string;
  /** Aftermath `Safe<TreasuryCap<AFSUI>>` shared object. */
  safeObject?: string;
  /** Aftermath `ReferralVault` shared object. */
  referralVault?: string;
  /** Validator address the venue stakes to (Haedal / Aftermath take it explicitly). */
  validator?: string;
  /**
   * DeFiLlama protocol slug — matches the synthesized opportunity `project` and
   * the backend resolver alias, and is the TVL source for the LST opportunity
   * row.
   */
  defillamaSlug: string;
  /** Whether the deposit executes in-app (all four do). Twin of backend `inAppDeposit`. */
  inAppDeposit: boolean;
  /**
   * Haedal + Volo hard version-gate their shared objects (`assert_version`): the
   * intent-preview dry-run (`dryRun`/`devInspect`) ABORTS with an `assert_version`
   * MoveAbort even though REAL execution succeeds (verified — 12/12 recent mainnet
   * stakes use these exact packages; the fullnode simulator just can't resolve
   * their version gate). Since a reverting dry-run is normally treated as
   * `blocked`, these need the scoped bypass in `intentExecutors`: an
   * `assert_version` abort on a `simulationUnreliable` venue is downgraded from a
   * hard block to a non-block (any OTHER abort — bad balance, slippage — still
   * blocks; the on-chain execution is the final gate). Also forces an explicit
   * gas budget in the adapter so `tx.build`'s gas-estimation dry-run doesn't
   * throw. SpringSui + Aftermath simulate cleanly and don't set this.
   */
  simulationUnreliable?: boolean;
  /**
   * The pool's on-chain `version` content field that the PINNED package
   * satisfies (i.e. what its `assert_version` compares against). The executor's
   * dry-run exemption is GATED on a live read of this matching — it replicates
   * the on-chain `assert_version` off-chain, so the exemption engages ONLY when
   * the gate would genuinely pass in real execution. If the venue upgrades and
   * bumps this, the read mismatches → no exemption → the dry-run block stands
   * (and this pin + `packageId` must be updated). Set only for
   * `simulationUnreliable` venues.
   */
  expectedPoolVersion?: number;
}

const HASUI =
  "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI";
const VSUI =
  "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT";
const SSUI =
  "0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI";
const AFSUI =
  "0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI";

export const SUI_LST_CONFIGS: Record<SuiLstVenue, SuiLstConfig> = {
  haedal: {
    venue: "haedal",
    displayName: "Haedal",
    lstSymbol: "haSUI",
    lstType: HASUI,
    // Coin package == staking package; `staking::request_stake_coin` is the
    // composable (non-entry) sibling of the `interface::request_stake` entry fn
    // — it RETURNS the Coin<HASUI> so the adapter transfers it to the sender.
    packageId:
      "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d",
    stakeFn: "staking::request_stake_coin",
    stakeShape: "returns-coin-validator",
    // Instant unstake from Haedal's buffer → SUI to sender (returns ()).
    unstakeFn: "staking::request_unstake_instant",
    withdrawShape: "haedal-instant",
    poolObject:
      "0x47b224762220393057ebf4f70501b6e657c3e56684737568439a04f80849b2ca",
    validator:
      "0x6b8060b9cf708d03b45a812098bb177711f7ba7471c1da513e15ce88ae6af8f2",
    defillamaSlug: "haedal-protocol",
    inAppDeposit: true,
    simulationUnreliable: true, // dry-run aborts assert_version; real exec works
    expectedPoolVersion: 5, // Staking.version — gate passes iff on-chain == this
  },
  volo: {
    venue: "volo",
    displayName: "Volo",
    lstSymbol: "vSUI",
    lstType: VSUI,
    packageId:
      "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55",
    // Entry fn: mints vSUI straight to the sender; pool picks the validator.
    stakeFn: "native_pool::stake",
    stakeShape: "entry-pool-metadata",
    // Instant unstake (entry) → SUI to sender; charges Volo's unstake fee.
    unstakeFn: "native_pool::unstake",
    withdrawShape: "volo-unstake",
    poolObject:
      "0x7fa2faa111b8c65bea48a23049bfd81ca8f971a262d981dcd9a17c3825cb5baf",
    metadataObject:
      "0x680cd26af32b2bde8d3361e804c53ec1d1cfe24c7f039eb7f549e8dfde389a60",
    defillamaSlug: "volo-lst",
    inAppDeposit: true,
    simulationUnreliable: true, // dry-run aborts assert_version; real exec works
    expectedPoolVersion: 2, // NativePool.version — gate passes iff on-chain == this
  },
  springsui: {
    venue: "springsui",
    displayName: "SpringSui",
    lstSymbol: "sSUI",
    lstType: SSUI,
    // Suilend's generic SpringSui framework: `liquid_staking::mint<P>` returns
    // Coin<P>; `redeem<P>` is instant back to SUI (future in-app withdraw).
    packageId:
      "0xb0575765166030556a6eafd3b1b970eba8183ff748860680245b9edd41c716e7",
    stakeFn: "liquid_staking::mint",
    stakeShape: "mint-generic",
    // Instant redeem<P>(LSI, Coin<P>, SuiSystemState) -> Coin<SUI> (same-epoch
    // principal withdrawal from validators — the most reliable LST exit).
    unstakeFn: "liquid_staking::redeem",
    withdrawShape: "redeem-generic",
    poolObject:
      "0x15eda7330c8f99c30e430b4d82fd7ab2af3ead4ae17046fcb224aa9bad394f6b",
    defillamaSlug: "springsui",
    inAppDeposit: true,
  },
  aftermath: {
    venue: "aftermath",
    displayName: "Aftermath",
    lstSymbol: "afSUI",
    lstType: AFSUI,
    packageId:
      "0x7f6ce7ade63857c4fd16ef7783fed2dfc4d7fb7e40615abdb653030b76aef0c6",
    stakeFn: "staked_sui_vault::request_stake",
    stakeShape: "aftermath-vault",
    // Delayed unstake: registers the request; SUI is delivered after the epoch.
    unstakeFn: "staked_sui_vault::request_unstake",
    withdrawShape: "aftermath-unstake",
    withdrawDelayed: true,
    poolObject:
      "0x2f8f6d5da7f13ea37daa397724280483ed062769813b6f31e9788e59cc88994d",
    safeObject:
      "0xeb685899830dd5837b47007809c76d91a098d52aabbf61e8ac467c59e5cc4610",
    referralVault:
      "0x4ce9a19b594599536c53edb25d22532f82f18038dc8ef618afd00fbbfb9845ef",
    validator:
      "0x00ae78d3e5ba5d6b8de32455474f52811b95617cbad39ebf4f9e2daf67187407",
    defillamaSlug: "aftermath-afsui",
    inAppDeposit: true,
  },
};

export const SUI_LST_VENUES = Object.keys(SUI_LST_CONFIGS) as SuiLstVenue[];

/** DeFiLlama slugs the adapter fulfills in-app (`externalSlugs`) — all four venues. */
export const SUI_LST_SLUGS: string[] = SUI_LST_VENUES.map(
  (v) => SUI_LST_CONFIGS[v],
)
  .filter((cfg) => cfg.inAppDeposit)
  .map((cfg) => cfg.defillamaSlug);

export function isSuiLstVenue(v: string): v is SuiLstVenue {
  return (
    v === "haedal" || v === "volo" || v === "springsui" || v === "aftermath"
  );
}

export function getLstConfig(venue: SuiLstVenue): SuiLstConfig {
  return SUI_LST_CONFIGS[venue];
}

/** Match a resolved LST receipt coin type back to its venue config. */
export function getLstConfigByType(lstType: string): SuiLstConfig | undefined {
  const norm = lstType.toLowerCase();
  return SUI_LST_VENUES.map((v) => SUI_LST_CONFIGS[v]).find(
    (cfg) => cfg.lstType.toLowerCase() === norm,
  );
}
