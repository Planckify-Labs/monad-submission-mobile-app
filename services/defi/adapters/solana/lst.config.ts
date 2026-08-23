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

export type SolanaLstVenue = "jito" | "jupsol" | "dsol" | "marinade";

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
};

export const SOLANA_LST_VENUES = Object.keys(
  SOLANA_LST_CONFIGS,
) as SolanaLstVenue[];

export const SOLANA_LST_SLUGS: string[] = SOLANA_LST_VENUES.map(
  (v) => SOLANA_LST_CONFIGS[v].defillamaSlug,
);

export function isSolanaLstVenue(v: string): v is SolanaLstVenue {
  return v === "jito" || v === "jupsol" || v === "dsol" || v === "marinade";
}

export function getSolanaLstConfig(venue: SolanaLstVenue): SolanaLstConfig {
  return SOLANA_LST_CONFIGS[venue];
}
