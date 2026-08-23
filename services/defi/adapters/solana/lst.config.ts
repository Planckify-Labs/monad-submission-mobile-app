/**
 * Solana liquid-staking (LST) venue config — NO SDK, mirrors the Sui
 * equivalent (`adapters/sui/lst.config.ts`): one `DepositTarget.kind`
 * (`"solana-lst-stake"`), dispatched by `venue`, config-driven so a new venue
 * that reuses a `shape` needs only a row here, not adapter code.
 *
 * Two shapes exist today:
 *
 *   - `"spl-stake-pool"` — the standard SPL Stake Pool program's
 *     `DepositSol`(14) / `WithdrawSol`(16) instructions. Jito runs the
 *     canonical `solana-program/stake-pool` deployment; JupSOL and dSOL run
 *     Sanctum's own deployments (`igneous-labs/sanctum-spl-stake-pool`,
 *     branch `sanctum-spl-pool-deploy`) under different program ids —
 *     diffed byte-for-byte against upstream `deposit_sol`/`withdraw_sol`
 *     2026-08-22, identical account list and discriminators, so ONE builder
 *     serves all three, parameterized by `program`/`stakePool`. `poolMint`,
 *     `reserveStake` and `managerFeeAccount` are read live from the
 *     `StakePool` account (not pinned) — they're each pool's own arbitrary
 *     accounts set at creation, not derivable from a fixed seed.
 *
 *     **12 more venues added 2026-08-23** (phantom/dfdv/hylo/bonk/helius/
 *     bybit/thevault/doublezero/blazestake/jpool/binance/jagpool) — all real
 *     `solana-program/stake-pool` deployments (either the canonical `"Spl"`
 *     program or one of the two already-pinned Sanctum forks), not new
 *     programs. Each `(program, stakePool)` pair was cross-checked two ways
 *     before pinning: (1) `igneous-labs/sanctum-lst-list`'s published
 *     `sanctum-lst-list.toml` names the pool + its `Spl`/`SanctumSpl`/
 *     `SanctumSplMulti` program tag per mint — verified self-consistent
 *     because it reproduces the ALREADY-shipped Jito/JupSOL/dSOL rows
 *     byte-for-byte; (2) a live `getAccountInfo` on every new `stakePool`
 *     confirmed the account's `owner` matches the claimed program AND its
 *     on-chain `pool_mint` field (offset 162, same as the read path below)
 *     matches the mint the venue is supposed to be. Every one of the 12
 *     matched on both counts, and each pool's live `total_lamports` lines up
 *     with the TVL the DeFiLlama listing reports for that same venue — no
 *     mismatches, no ambiguity, no manual disambiguation needed.
 *
 *     **13th venue, `solstrategies` (stkeSOL), added 2026-08-23** — absent
 *     from the Sanctum list, so verified independently: its DeFiLlama
 *     `yield-server` adaptor (`src/adaptors/stkesol-by-sol-strategies/
 *     index.js`) names the stake pool
 *     `StKeDUdSu7jMSnPJ1MPqDnk3RdEwD2QbJaisHMebGhw`, and a live
 *     `getAccountInfo` confirmed its `owner` is this same canonical `Spl`
 *     program and its on-chain `pool_mint` (offset 162) matches the
 *     adaptor's own `STKESOL_MINT` constant exactly.
 *
 *   - `"marinade"` — Marinade's bespoke Anchor program (NOT a Stake Pool
 *     fork). `state`/`msolMint` are pinned from
 *     docs.marinade.finance/developers/contract-addresses; every other
 *     deposit/withdraw account is a PDA or `createWithSeed` derivation off
 *     `state`, verified 2026-08-22 by cross-checking the derived
 *     `reserve_pda` against that same docs page (exact match) and reading
 *     `msol_mint`/`treasury_msol_account` off live mainnet `State` account
 *     data at the byte offsets computed from
 *     `marinade-finance/liquid-staking-program`'s `state/mod.rs` (both
 *     matched exactly). The full `State` layout through `LiqPool` (StakeSystem
 *     + ValidatorSystem + LiqPool, all fixed-size — no embedded Vecs) was then
 *     independently confirmed by decoding `stake_system.stake_list.account`,
 *     `validator_system.validator_list.account` and `liq_pool.msol_leg`
 *     field-by-field and checking each against its own `createWithSeed`
 *     derivation — all three matched exactly, which pins every offset up to
 *     `msol_price`. The exchange rate itself (`msol_price`, offset 512, u64)
 *     first read as an implausible 6.02 SOL/mSOL: the OFFSET was right, but
 *     the SCALE was wrong — Marinade denominates it by `State::
 *     PRICE_DENOMINATOR = 0x1_0000_0000` (2^32), not the 1e9 every other
 *     amount in this codebase uses. Rescaled: 1.4019 SOL/mSOL, corroborated
 *     independently by `total_active_balance / msol_supply` (≈1.388, close —
 *     the small gap is `total_virtual_staked_lamports()`'s reserve/ticket
 *     adjustments, which `msol_price` already bakes in). Marinade's own
 *     source comments this field "For FE" (display), which is exactly
 *     `readPosition`'s use here — deposit/withdraw never touch it.
 *
 * Deposit/withdraw is always native SOL in, LST out — `targetUnderlying()`
 * falls through to `null` for this kind, same as `sui-lst` (no on-chain
 * "mint" identity for native SOL).
 */

export type SolanaLstVenue =
  | "jito"
  | "jupsol"
  | "dsol"
  | "marinade"
  | "phantom"
  | "dfdv"
  | "hylo"
  | "bonk"
  | "helius"
  | "bybit"
  | "thevault"
  | "doublezero"
  | "blazestake"
  | "jpool"
  | "binance"
  | "jagpool"
  | "solstrategies";

export type SolanaLstShape = "spl-stake-pool" | "marinade";

interface SolanaLstConfigBase {
  venue: SolanaLstVenue;
  displayName: string;
  /** Receipt-token symbol (JitoSOL / JupSOL / dSOL / mSOL). */
  symbol: string;
  /** DeFiLlama project slug — the opportunity `project` and resolver alias. */
  defillamaSlug: string;
  /** Conservative UX floor, not an on-chain-enforced minimum unless noted. */
  minDepositLamports: bigint;
}

export interface SplStakePoolLstConfig extends SolanaLstConfigBase {
  shape: "spl-stake-pool";
  program: string;
  stakePool: string;
}

export interface MarinadeLstConfig extends SolanaLstConfigBase {
  shape: "marinade";
  program: string;
  state: string;
  msolMint: string;
}

export type SolanaLstConfig = SplStakePoolLstConfig | MarinadeLstConfig;

export const SOLANA_LST_CONFIGS: Record<SolanaLstVenue, SolanaLstConfig> = {
  jito: {
    venue: "jito",
    shape: "spl-stake-pool",
    displayName: "Jito",
    symbol: "JitoSOL",
    // Canonical solana-program/stake-pool deployment (jito.network docs).
    program: "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy",
    stakePool: "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb",
    defillamaSlug: "jito-liquid-staking",
    // Per Jito docs: minimum deposit is 0.01 SOL.
    minDepositLamports: 10_000_000n,
  },
  jupsol: {
    venue: "jupsol",
    shape: "spl-stake-pool",
    displayName: "Jupiter Staked SOL",
    symbol: "JupSOL",
    // Sanctum "SPL Multi" deployment — verified owner of the JupSOL StakePool
    // account on-chain 2026-08-22 (getAccountInfo), instruction shape diffed
    // byte-identical to upstream stake-pool.
    program: "SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn",
    stakePool: "8VpRhuxa7sUUepdY3kQiTmX9rS5vx4WgaXiAnXq4KCtr",
    defillamaSlug: "jupiter-staked-sol",
    minDepositLamports: 10_000_000n,
  },
  dsol: {
    venue: "dsol",
    shape: "spl-stake-pool",
    displayName: "Drift Staked SOL",
    symbol: "dSOL",
    // Sanctum "SPL" (single-tenant) deployment — same verification as JupSOL.
    program: "SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY",
    stakePool: "9mhGNSPArRMHpLDMSmxAvuoizBqtBGqYdT8WGuqgxNdn",
    defillamaSlug: "drift-staked-sol",
    minDepositLamports: 10_000_000n,
  },
  marinade: {
    venue: "marinade",
    shape: "marinade",
    displayName: "Marinade",
    symbol: "mSOL",
    program: "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD",
    state: "8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC",
    msolMint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    defillamaSlug: "marinade-liquid-staking",
    // No documented minimum for the liquid (non-Native) deposit path; the
    // on-chain `state.min_deposit` check is the real gate.
    minDepositLamports: 0n,
  },
  // ── 12 more spl-stake-pool venues, added 2026-08-23 — see the header for
  // the two-way verification (Sanctum list + live getAccountInfo) each one
  // passed. Program id per pool's `program` tag in sanctum-lst-list.toml:
  //   "Spl"             -> SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy (Jito's)
  //   "SanctumSpl"      -> SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY (dSOL's)
  //   "SanctumSplMulti" -> SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn (JupSOL's)
  phantom: {
    venue: "phantom",
    shape: "spl-stake-pool",
    displayName: "Phantom Staked SOL",
    symbol: "PSOL",
    program: "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy",
    stakePool: "pSPcvR8GmG9aKDUbn9nbKYjkxt9hxMS7kF1qqKJaPqJ",
    defillamaSlug: "phantom-sol",
    minDepositLamports: 10_000_000n,
  },
  dfdv: {
    venue: "dfdv",
    shape: "spl-stake-pool",
    displayName: "DeFi Development Corp Staked SOL",
    symbol: "dfdvSOL",
    program: "SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY",
    stakePool: "pyZMBjpWsVjKANAYK5mpNbKiws2krjRPZ2N2UYCSnbP",
    defillamaSlug: "dfdv-staked-sol",
    minDepositLamports: 10_000_000n,
  },
  hylo: {
    venue: "hylo",
    shape: "spl-stake-pool",
    displayName: "Hylo Staked SOL",
    symbol: "hyloSOL",
    program: "SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn",
    stakePool: "hy1oDeVCVRDGkxS26qLVDvRhDpZGfWJ6w9AMvwMegwL",
    defillamaSlug: "hylo-lsts",
    minDepositLamports: 10_000_000n,
  },
  bonk: {
    venue: "bonk",
    shape: "spl-stake-pool",
    displayName: "bonkSOL",
    symbol: "bonkSOL",
    program: "SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY",
    stakePool: "ArAQfbzsdotoKB5jJcZa3ajQrrPcWr2YQoDAEAiFxJAC",
    defillamaSlug: "bonk-staked-sol",
    minDepositLamports: 10_000_000n,
  },
  helius: {
    venue: "helius",
    shape: "spl-stake-pool",
    displayName: "Helius Staked SOL",
    symbol: "hSOL",
    program: "SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY",
    stakePool: "3wK2g8ZdzAH8FJ7PKr2RcvGh7V9VYson5hrVsJM5Lmws",
    defillamaSlug: "helius-staked-sol",
    minDepositLamports: 10_000_000n,
  },
  bybit: {
    venue: "bybit",
    shape: "spl-stake-pool",
    displayName: "BybitSOL",
    symbol: "bbSOL",
    program: "SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY",
    stakePool: "2aMLkB5p5gVvCwKkdSo5eZAL1WwhZbxezQr1wxiynRhq",
    defillamaSlug: "bybit-staked-sol",
    minDepositLamports: 10_000_000n,
  },
  thevault: {
    venue: "thevault",
    shape: "spl-stake-pool",
    displayName: "The Vault",
    symbol: "vSOL",
    program: "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy",
    stakePool: "Fu9BYC6tWBo1KMKaP3CFoKfRhqv9akmy3DuYwnCyWiyC",
    defillamaSlug: "the-vault-liquid-staking",
    minDepositLamports: 10_000_000n,
  },
  doublezero: {
    venue: "doublezero",
    shape: "spl-stake-pool",
    displayName: "DoubleZero Staked SOL",
    symbol: "dzSOL",
    program: "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy",
    stakePool: "3fV1sdGeXaNEZj6EPDTpub82pYxcRXwt2oie6jkSzeWi",
    defillamaSlug: "doublezero-staked-sol",
    minDepositLamports: 10_000_000n,
  },
  blazestake: {
    venue: "blazestake",
    shape: "spl-stake-pool",
    displayName: "BlazeStake Staked SOL",
    symbol: "bSOL",
    program: "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy",
    stakePool: "stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi",
    defillamaSlug: "blazestake",
    minDepositLamports: 10_000_000n,
  },
  jpool: {
    venue: "jpool",
    shape: "spl-stake-pool",
    displayName: "JPool",
    symbol: "JSOL",
    program: "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy",
    stakePool: "CtMyWsrUtAwXWiGr9WjHT5fC3p3fgV8cyGpLTo2LJzG1",
    defillamaSlug: "jpool",
    minDepositLamports: 10_000_000n,
  },
  binance: {
    venue: "binance",
    shape: "spl-stake-pool",
    displayName: "Binance Staked SOL",
    symbol: "BNSOL",
    program: "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy",
    stakePool: "Hr9pzexrBge3vgmBNRR8u42CNQgBXdHm4UkUN2DH4a7r",
    defillamaSlug: "binance-staked-sol",
    minDepositLamports: 10_000_000n,
  },
  jagpool: {
    venue: "jagpool",
    shape: "spl-stake-pool",
    displayName: "JagPool Staked SOL",
    symbol: "jagSOL",
    program: "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy",
    stakePool: "jagEdDepWUgexiu4jxojcRWcVKKwFqgZBBuAoGu2BxM",
    defillamaSlug: "jagpool-staked-sol",
    minDepositLamports: 10_000_000n,
  },
  solstrategies: {
    venue: "solstrategies",
    shape: "spl-stake-pool",
    displayName: "SOL Strategies Staked SOL",
    symbol: "stkeSOL",
    program: "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy",
    stakePool: "StKeDUdSu7jMSnPJ1MPqDnk3RdEwD2QbJaisHMebGhw",
    defillamaSlug: "stkesol-by-sol-strategies",
    minDepositLamports: 10_000_000n,
  },
};

export const SOLANA_LST_VENUES = Object.keys(
  SOLANA_LST_CONFIGS,
) as SolanaLstVenue[];

export const SOLANA_LST_SLUGS: string[] = SOLANA_LST_VENUES.map(
  (v) => SOLANA_LST_CONFIGS[v].defillamaSlug,
);

export function isSolanaLstVenue(v: string): v is SolanaLstVenue {
  return (SOLANA_LST_VENUES as string[]).includes(v);
}

export function getSolanaLstConfig(venue: SolanaLstVenue): SolanaLstConfig {
  return SOLANA_LST_CONFIGS[venue];
}
