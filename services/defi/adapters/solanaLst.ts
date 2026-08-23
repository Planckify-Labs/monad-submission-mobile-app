/**
 * Solana liquid-staking adapter — ONE `DefiProtocolAdapter` covering Jito,
 * JupSOL, dSOL and Marinade, dispatched by `DepositTarget.kind ===
 * "solana-lst-stake"` and routed to the right venue by `target.venue`
 * (mirrors `SuiLstAdapter` — space-docking, never a slug branch in shared
 * code). Config: `adapters/solana/lst.config.ts`.
 *
 * Replaces the old single-venue `solanaJito.ts` — same hand-rolled SPL Stake
 * Pool instructions (no `@solana/spl-stake-pool` dependency), now
 * parameterized by `program`/`stakePool` instead of hardcoded Jito
 * constants, plus a second `"marinade"` shape for Marinade's bespoke Anchor
 * program. See `lst.config.ts`'s header for the verification story on both
 * shapes.
 */

import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_STAKE_HISTORY_PUBKEY,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { DefiError } from "../errors/defiErrors";
import type {
  BuildDepositArgs,
  BuildWithdrawArgs,
  DefiPosition,
  DefiProtocolAdapter,
  DepositTarget,
  PositionReadContext,
  UnsignedCall,
} from "../types";
import {
  getSolanaLstConfig,
  isSolanaLstVenue,
  type MarinadeLstConfig,
  SOLANA_LST_SLUGS,
  type SolanaLstConfig,
  type SplStakePoolLstConfig,
} from "./solana/lst.config";

const SLUG = "solana-lst";
const CLUSTER = "mainnet-beta" as const;

// Native Solana stake-program ID (hardcoded; not exported by web3.js).
const STAKE_PROGRAM_ID = new PublicKey(
  "Stake11111111111111111111111111111111111111",
);

function devWarn(scope: string, err: unknown): void {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn(`[solanaLst] ${scope}:`, err);
  }
}

function makeConnection(rpcUrl: string | undefined): Connection {
  return new Connection(
    rpcUrl || "https://api.mainnet-beta.solana.com",
    "confirmed",
  );
}

function requireLstConfig(target: DepositTarget | undefined): SolanaLstConfig {
  if (target?.kind !== "solana-lst-stake" || !isSolanaLstVenue(target.venue)) {
    throw new DefiError(
      "deposit_failed",
      "liquid staking: a resolved venue target is required",
    );
  }
  return getSolanaLstConfig(target.venue);
}

// ── SPL Stake Pool shape (Jito / JupSOL / dSOL) ─────────────────────────
// Instruction discriminators and StakePool account offsets shared by every
// deployment of `solana-program/stake-pool` (diffed byte-identical against
// the Sanctum forks — see lst.config.ts).
const IX_DEPOSIT_SOL = 14;
const IX_WITHDRAW_SOL = 16;
const RESERVE_STAKE_OFFSET = 130;
const POOL_MINT_OFFSET = 162;
const MANAGER_FEE_OFFSET = 194;
const TOTAL_LAMPORTS_OFFSET = 258;
const POOL_TOKEN_SUPPLY_OFFSET = 266;

interface SplStakePoolState {
  reserveStake: PublicKey;
  poolMint: PublicKey;
  managerFeeAccount: PublicKey;
  totalLamports: bigint;
  poolTokenSupply: bigint;
}

async function readSplStakePoolState(
  connection: Connection,
  stakePool: PublicKey,
): Promise<SplStakePoolState> {
  const accountInfo = await connection.getAccountInfo(stakePool);
  if (!accountInfo) {
    throw new DefiError("network_error", "liquid staking: pool not found");
  }
  const data = accountInfo.data;
  if (data.length < POOL_TOKEN_SUPPLY_OFFSET + 8) {
    throw new DefiError("network_error", "liquid staking: pool data too small");
  }
  return {
    reserveStake: new PublicKey(
      data.subarray(RESERVE_STAKE_OFFSET, RESERVE_STAKE_OFFSET + 32),
    ),
    poolMint: new PublicKey(
      data.subarray(POOL_MINT_OFFSET, POOL_MINT_OFFSET + 32),
    ),
    managerFeeAccount: new PublicKey(
      data.subarray(MANAGER_FEE_OFFSET, MANAGER_FEE_OFFSET + 32),
    ),
    totalLamports: data.readBigUInt64LE(TOTAL_LAMPORTS_OFFSET),
    poolTokenSupply: data.readBigUInt64LE(POOL_TOKEN_SUPPLY_OFFSET),
  };
}

function deriveSplWithdrawAuthority(
  program: PublicKey,
  stakePool: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [stakePool.toBuffer(), Buffer.from("withdraw")],
    program,
  );
  return pda;
}

function encodeU64LE(value: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(value, 0);
  return b;
}

async function buildSplStakePoolDeposit(
  cfg: SplStakePoolLstConfig,
  connection: Connection,
  fromPubkey: PublicKey,
  lamports: bigint,
): Promise<UnsignedCall> {
  const program = new PublicKey(cfg.program);
  const stakePool = new PublicKey(cfg.stakePool);
  const pool = await readSplStakePoolState(connection, stakePool);
  const withdrawAuthority = deriveSplWithdrawAuthority(program, stakePool);
  const destPoolAccount = getAssociatedTokenAddressSync(
    pool.poolMint,
    fromPubkey,
  );

  const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    fromPubkey,
    destPoolAccount,
    fromPubkey,
    pool.poolMint,
  );

  const data = Buffer.alloc(9);
  data.writeUInt8(IX_DEPOSIT_SOL, 0);
  encodeU64LE(lamports).copy(data, 1);

  const depositIx = new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: stakePool, isSigner: false, isWritable: true },
      { pubkey: withdrawAuthority, isSigner: false, isWritable: false },
      { pubkey: pool.reserveStake, isSigner: false, isWritable: true },
      { pubkey: fromPubkey, isSigner: true, isWritable: true },
      { pubkey: destPoolAccount, isSigner: false, isWritable: true },
      { pubkey: pool.managerFeeAccount, isSigner: false, isWritable: true },
      { pubkey: pool.managerFeeAccount, isSigner: false, isWritable: true }, // referrer (none)
      { pubkey: pool.poolMint, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });

  return { kind: "solana-ix", instructions: [createAtaIx, depositIx] };
}

async function buildSplStakePoolWithdraw(
  cfg: SplStakePoolLstConfig,
  connection: Connection,
  fromPubkey: PublicKey,
  amount: bigint | "MAX",
): Promise<UnsignedCall> {
  const program = new PublicKey(cfg.program);
  const stakePool = new PublicKey(cfg.stakePool);
  const pool = await readSplStakePoolState(connection, stakePool);
  const sourcePoolAccount = getAssociatedTokenAddressSync(
    pool.poolMint,
    fromPubkey,
  );

  const accountInfo = await connection
    .getTokenAccountBalance(sourcePoolAccount)
    .catch(() => null);
  const heldBalance = accountInfo ? BigInt(accountInfo.value.amount) : 0n;
  if (heldBalance === 0n) {
    throw new DefiError(
      "position_not_found",
      `${cfg.displayName}: no ${cfg.symbol} balance`,
    );
  }

  let poolTokens: bigint;
  if (amount === "MAX") {
    poolTokens = heldBalance;
  } else {
    // `amount` is SOL (the deposited asset, per the position's own units —
    // matches `readPosition`'s SOL-equivalent reporting). Convert to pool
    // tokens via the pool's own live rate, the inverse of the conversion
    // `readSplStakePoolPosition` uses. Floor-divide, like `suiToLst`'s
    // equivalent conversion — the realised SOL is approximate anyway once
    // the tx lands — and clamp to the held balance (a request for ≥ the
    // position is a full exit). Fail closed if the rate can't be computed:
    // since the receipt token is worth MORE than 1 SOL, treating `amount` as
    // already-pool-tokens would OVER-withdraw, not under — no safe guessed
    // direction, so refuse rather than risk it (mirrors the Marinade shape).
    if (pool.totalLamports <= 0n) {
      throw new DefiError(
        "network_error",
        `${cfg.displayName}: could not read the exchange rate`,
      );
    }
    const converted = (amount * pool.poolTokenSupply) / pool.totalLamports;
    poolTokens = converted >= heldBalance ? heldBalance : converted;
  }

  const withdrawAuthority = deriveSplWithdrawAuthority(program, stakePool);
  const data = Buffer.alloc(9);
  data.writeUInt8(IX_WITHDRAW_SOL, 0);
  encodeU64LE(poolTokens).copy(data, 1);

  const withdrawIx = new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: stakePool, isSigner: false, isWritable: true },
      { pubkey: withdrawAuthority, isSigner: false, isWritable: false },
      { pubkey: fromPubkey, isSigner: true, isWritable: false },
      { pubkey: sourcePoolAccount, isSigner: false, isWritable: true },
      { pubkey: pool.reserveStake, isSigner: false, isWritable: true },
      { pubkey: fromPubkey, isSigner: false, isWritable: true },
      { pubkey: pool.managerFeeAccount, isSigner: false, isWritable: true },
      { pubkey: pool.poolMint, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      {
        pubkey: SYSVAR_STAKE_HISTORY_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: STAKE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });

  return { kind: "solana-ix", instructions: [withdrawIx] };
}

async function readSplStakePoolPosition(
  cfg: SplStakePoolLstConfig,
  walletAddress: string,
): Promise<DefiPosition | null> {
  const connection = makeConnection(undefined);
  const owner = new PublicKey(walletAddress);
  const stakePool = new PublicKey(cfg.stakePool);
  const pool = await readSplStakePoolState(connection, stakePool);
  const ata = getAssociatedTokenAddressSync(pool.poolMint, owner);
  const tokenBalance = await connection
    .getTokenAccountBalance(ata)
    .catch(() => null);
  if (!tokenBalance || tokenBalance.value.amount === "0") return null;
  const lstAmount = BigInt(tokenBalance.value.amount);

  // SOL-equivalent via the pool's own exchange rate (total_lamports /
  // pool_token_supply) — the receipt appreciates against SOL, so reporting
  // the raw receipt count would underreport the position.
  let solEquivalent = lstAmount;
  if (pool.poolTokenSupply > 0n && pool.totalLamports > 0n) {
    solEquivalent = (lstAmount * pool.totalLamports) / pool.poolTokenSupply;
  }

  return {
    protocolSlug: SLUG,
    namespace: "solana",
    chainId: CLUSTER,
    assetSymbol: "SOL",
    amountAtDeposit: 0n,
    amountAtDepositUsd: 0,
    currentAmount: solEquivalent,
    currentAmountUsd: 0,
    pnlUsd: 0,
  };
}

// ── Marinade shape (mSOL) ────────────────────────────────────────────────
// Anchor global-instruction discriminators: sha256("global:<name>")[0..8].
const MARINADE_DEPOSIT_DISCRIMINATOR = Buffer.from("f223c68952e1f2b6", "hex");
const MARINADE_LIQUID_UNSTAKE_DISCRIMINATOR = Buffer.from(
  "1e1e77f0bfe30c10",
  "hex",
);
// State struct field offsets (Anchor 8-byte discriminator + Borsh field
// order from `marinade-finance/liquid-staking-program`'s `state/mod.rs`,
// verified against live mainnet state 2026-08-22 — see lst.config.ts).
const MARINADE_TREASURY_MSOL_ACCOUNT_OFFSET = 104;
// `msol_price`: the "for FE" display exchange rate (source comment) — offset
// verified field-by-field (stake_list/validator_list/msol_leg all matched
// their own `createWithSeed` derivation, pinning every offset up to here).
// Denominated by `State::PRICE_DENOMINATOR` (2^32), NOT 1e9 — see
// lst.config.ts's header for the mis-scale this codebase originally hit.
// DISPLAY ONLY (`readPosition`) — Marinade's own source comments this field
// "For FE. Don't use it for token amount calculation." The withdraw path
// below computes the rate the program itself uses instead (see the offsets
// after this one).
const MARINADE_MSOL_PRICE_OFFSET = 512;
const MARINADE_PRICE_DENOMINATOR = 4_294_967_296n; // 2^32
// Everything `total_virtual_staked_lamports() / msol_supply` needs — the
// precise formula `calc.rs`'s `msol_to_sol`/`calc_msol_from_lamports` use
// on-chain, per `state/mod.rs`. Offsets verified 2026-08-22 by decoding the
// full field chain from the `msol_leg` checkpoint (offset 452, itself
// independently re-derived via `createWithSeed`) through here, then
// confirming every intervening field decodes to a plausible value
// (`available_reserve_balance`/`msol_supply` at realistic multi-hundred-
// -thousand-SOL magnitudes, `min_deposit`/`min_withdraw` at ~0,
// `staking_sol_cap` at the uncapped `u64::MAX` sentinel,
// `emergency_cooling_down` at 0) AND cross-checking the resulting rate
// against `msol_price` (agreed to 7 significant figures — 1.4018662910 vs
// 1.4018662123 — confirming this decode independently of that field).
const MARINADE_STAKE_LIST_DELAYED_COOLING_DOWN_OFFSET = 226; // stake_system.delayed_unstake_cooling_down
const MARINADE_TOTAL_ACTIVE_BALANCE_OFFSET = 376; // validator_system.total_active_balance
const MARINADE_AVAILABLE_RESERVE_BALANCE_OFFSET = 496;
const MARINADE_MSOL_SUPPLY_OFFSET = 504;
const MARINADE_CIRCULATING_TICKET_BALANCE_OFFSET = 528;
const MARINADE_EMERGENCY_COOLING_DOWN_OFFSET = 568;

async function marinadePda(
  program: PublicKey,
  state: PublicKey,
  seed: string,
): Promise<PublicKey> {
  const [pda] = PublicKey.findProgramAddressSync(
    [state.toBuffer(), Buffer.from(seed)],
    program,
  );
  return pda;
}

async function readMarinadeTreasuryMsolAccount(
  connection: Connection,
  state: PublicKey,
): Promise<PublicKey> {
  const accountInfo = await connection.getAccountInfo(state);
  if (!accountInfo) {
    throw new DefiError("network_error", "marinade: state account not found");
  }
  const offset = MARINADE_TREASURY_MSOL_ACCOUNT_OFFSET;
  if (accountInfo.data.length < offset + 32) {
    throw new DefiError("network_error", "marinade: state data too small");
  }
  return new PublicKey(accountInfo.data.subarray(offset, offset + 32));
}

/**
 * The exact rate Marinade's own `msol_to_sol`/`calc_msol_from_lamports` use
 * (`total_virtual_staked_lamports() / msol_supply` — see `calc.rs` and
 * `state/mod.rs`), NOT the cached `msol_price` display field. Used for the
 * withdraw conversion (§ the offsets' header above explains why).
 */
async function readMarinadeExchangeRate(
  connection: Connection,
  state: PublicKey,
): Promise<{ totalVirtualStakedLamports: bigint; msolSupply: bigint } | null> {
  const accountInfo = await connection.getAccountInfo(state).catch(() => null);
  if (!accountInfo) return null;
  const data = accountInfo.data;
  if (data.length < MARINADE_EMERGENCY_COOLING_DOWN_OFFSET + 8) return null;

  const delayedUnstakeCoolingDown = data.readBigUInt64LE(
    MARINADE_STAKE_LIST_DELAYED_COOLING_DOWN_OFFSET,
  );
  const totalActiveBalance = data.readBigUInt64LE(
    MARINADE_TOTAL_ACTIVE_BALANCE_OFFSET,
  );
  const availableReserveBalance = data.readBigUInt64LE(
    MARINADE_AVAILABLE_RESERVE_BALANCE_OFFSET,
  );
  const msolSupply = data.readBigUInt64LE(MARINADE_MSOL_SUPPLY_OFFSET);
  const circulatingTicketBalance = data.readBigUInt64LE(
    MARINADE_CIRCULATING_TICKET_BALANCE_OFFSET,
  );
  const emergencyCoolingDown = data.readBigUInt64LE(
    MARINADE_EMERGENCY_COOLING_DOWN_OFFSET,
  );

  // total_lamports_under_control() = total_active_balance + total_cooling_down
  //   + available_reserve_balance; total_virtual_staked_lamports() subtracts
  //   circulating_ticket_balance. Mirrors state/mod.rs exactly.
  const totalCoolingDown = delayedUnstakeCoolingDown + emergencyCoolingDown;
  const totalLamportsUnderControl =
    totalActiveBalance + totalCoolingDown + availableReserveBalance;
  const totalVirtualStakedLamports =
    totalLamportsUnderControl - circulatingTicketBalance;
  return { totalVirtualStakedLamports, msolSupply };
}

async function buildMarinadeDeposit(
  cfg: MarinadeLstConfig,
  connection: Connection,
  fromPubkey: PublicKey,
  lamports: bigint,
): Promise<UnsignedCall> {
  const program = new PublicKey(cfg.program);
  const state = new PublicKey(cfg.state);
  const msolMint = new PublicKey(cfg.msolMint);
  const tokenProgramId = TOKEN_PROGRAM_ID;

  const [
    liqPoolSolLegPda,
    liqPoolMsolLegAuthority,
    reservePda,
    msolMintAuthority,
  ] = await Promise.all([
    marinadePda(program, state, "liq_sol"),
    marinadePda(program, state, "liq_st_sol_authority"),
    marinadePda(program, state, "reserve"),
    marinadePda(program, state, "st_mint"),
  ]);
  const liqPoolMsolLeg = await PublicKey.createWithSeed(
    state,
    "liq_st_sol",
    tokenProgramId,
  );
  const mintTo = getAssociatedTokenAddressSync(msolMint, fromPubkey);
  const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    fromPubkey,
    mintTo,
    fromPubkey,
    msolMint,
  );

  const data = Buffer.alloc(16);
  MARINADE_DEPOSIT_DISCRIMINATOR.copy(data, 0);
  encodeU64LE(lamports).copy(data, 8);

  const depositIx = new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: state, isSigner: false, isWritable: true },
      { pubkey: msolMint, isSigner: false, isWritable: true },
      { pubkey: liqPoolSolLegPda, isSigner: false, isWritable: true },
      { pubkey: liqPoolMsolLeg, isSigner: false, isWritable: true },
      { pubkey: liqPoolMsolLegAuthority, isSigner: false, isWritable: false },
      { pubkey: reservePda, isSigner: false, isWritable: true },
      { pubkey: fromPubkey, isSigner: true, isWritable: true },
      { pubkey: mintTo, isSigner: false, isWritable: true },
      { pubkey: msolMintAuthority, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    ],
    data,
  });

  return { kind: "solana-ix", instructions: [createAtaIx, depositIx] };
}

async function buildMarinadeWithdraw(
  cfg: MarinadeLstConfig,
  connection: Connection,
  fromPubkey: PublicKey,
  amount: bigint | "MAX",
): Promise<UnsignedCall> {
  const program = new PublicKey(cfg.program);
  const state = new PublicKey(cfg.state);
  const msolMint = new PublicKey(cfg.msolMint);

  const getMsolFrom = getAssociatedTokenAddressSync(msolMint, fromPubkey);
  const accountInfo = await connection
    .getTokenAccountBalance(getMsolFrom)
    .catch(() => null);
  const heldBalance = accountInfo ? BigInt(accountInfo.value.amount) : 0n;
  if (heldBalance === 0n) {
    throw new DefiError("position_not_found", "marinade: no mSOL balance");
  }

  let msolAmount: bigint;
  if (amount === "MAX") {
    msolAmount = heldBalance;
  } else {
    // `amount` is SOL (the deposited asset, per the position's own units).
    // Convert to mSOL via the program's OWN precise rate
    // (`total_virtual_staked_lamports() / msol_supply`) — NOT the cached
    // `msol_price` display field, which Marinade's own source explicitly
    // says not to use for "token amount calculation" (see the offset
    // constants' header) — and clamp to the held balance (a request for ≥
    // the position is a full exit). Fail closed rather than guess if the
    // rate can't be read: since 1 mSOL is worth MORE than 1 SOL, treating
    // the SOL amount as already-mSOL would OVER-withdraw (burn more mSOL
    // than requested), not under — there is no "safe" guessed direction
    // here, so a read failure refuses rather than risks it.
    const rate = await readMarinadeExchangeRate(connection, state);
    if (
      !rate ||
      rate.totalVirtualStakedLamports <= 0n ||
      rate.msolSupply <= 0n
    ) {
      throw new DefiError(
        "network_error",
        "marinade: could not read the exchange rate",
      );
    }
    const converted =
      (amount * rate.msolSupply) / rate.totalVirtualStakedLamports;
    msolAmount = converted >= heldBalance ? heldBalance : converted;
  }

  const [liqPoolSolLegPda, treasuryMsolAccount] = await Promise.all([
    marinadePda(program, state, "liq_sol"),
    readMarinadeTreasuryMsolAccount(connection, state),
  ]);
  const liqPoolMsolLeg = await PublicKey.createWithSeed(
    state,
    "liq_st_sol",
    TOKEN_PROGRAM_ID,
  );

  const data = Buffer.alloc(16);
  MARINADE_LIQUID_UNSTAKE_DISCRIMINATOR.copy(data, 0);
  encodeU64LE(msolAmount).copy(data, 8);

  const withdrawIx = new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: state, isSigner: false, isWritable: true },
      { pubkey: msolMint, isSigner: false, isWritable: true },
      { pubkey: liqPoolSolLegPda, isSigner: false, isWritable: true },
      { pubkey: liqPoolMsolLeg, isSigner: false, isWritable: true },
      { pubkey: treasuryMsolAccount, isSigner: false, isWritable: true },
      { pubkey: getMsolFrom, isSigner: false, isWritable: true },
      { pubkey: fromPubkey, isSigner: true, isWritable: false },
      { pubkey: fromPubkey, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });

  return { kind: "solana-ix", instructions: [withdrawIx] };
}

async function readMarinadeMsolPrice(
  connection: Connection,
  state: PublicKey,
): Promise<bigint | null> {
  const accountInfo = await connection.getAccountInfo(state).catch(() => null);
  if (!accountInfo) return null;
  const offset = MARINADE_MSOL_PRICE_OFFSET;
  if (accountInfo.data.length < offset + 8) return null;
  return accountInfo.data.readBigUInt64LE(offset);
}

async function readMarinadePosition(
  cfg: MarinadeLstConfig,
  walletAddress: string,
): Promise<DefiPosition | null> {
  const connection = makeConnection(undefined);
  const owner = new PublicKey(walletAddress);
  const msolMint = new PublicKey(cfg.msolMint);
  const ata = getAssociatedTokenAddressSync(msolMint, owner);
  const tokenBalance = await connection
    .getTokenAccountBalance(ata)
    .catch(() => null);
  if (!tokenBalance || tokenBalance.value.amount === "0") return null;
  const msolAmount = BigInt(tokenBalance.value.amount);

  // SOL-equivalent via the pool's own "for FE" display rate (state.msol_price
  // / 2^32 — see lst.config.ts and the offset constants above). Falls back to
  // 1:1 (conservative — mSOL only appreciates against SOL) on a read hiccup,
  // same fallback style as the SPL Stake Pool venues.
  let solEquivalent = msolAmount;
  const msolPrice = await readMarinadeMsolPrice(
    connection,
    new PublicKey(cfg.state),
  );
  if (msolPrice !== null && msolPrice > 0n) {
    solEquivalent = (msolAmount * msolPrice) / MARINADE_PRICE_DENOMINATOR;
  }

  return {
    protocolSlug: SLUG,
    namespace: "solana",
    chainId: CLUSTER,
    assetSymbol: "SOL",
    amountAtDeposit: 0n,
    amountAtDepositUsd: 0,
    currentAmount: solEquivalent,
    currentAmountUsd: 0,
    pnlUsd: 0,
  };
}

// ── Adapter ──────────────────────────────────────────────────────────────

export const SolanaLstAdapter: DefiProtocolAdapter = {
  slug: SLUG,
  namespace: "solana",
  kind: "liquid_staking",
  chainId: CLUSTER,
  displayName: "Solana Liquid Staking",
  staticSafetyScore: 82,
  // "jito-solana" is the retired `SolanaJitoAdapter`'s own slug (never a
  // DeFiLlama project name) — kept here so pre-existing Jito position rows
  // (`protocolSlug: "jito-solana"`, stored before this adapter had a
  // resolver at all) still resolve via `getDefiAdapter`'s slug lookup.
  externalSlugs: [...SOLANA_LST_SLUGS, "jito-solana"],
  targetKinds: ["solana-lst-stake"],

  async buildDeposit({
    wallet,
    chain,
    amount,
    target,
  }: BuildDepositArgs): Promise<UnsignedCall> {
    if (chain.namespace !== "solana") {
      throw new DefiError(
        "unsupported_chain",
        "liquid staking: requires solana namespace",
      );
    }
    const cfg = requireLstConfig(target);
    const connection = makeConnection(chain.rpcUrl);
    const fromPubkey = new PublicKey(wallet.address);
    return cfg.shape === "marinade"
      ? buildMarinadeDeposit(cfg, connection, fromPubkey, amount)
      : buildSplStakePoolDeposit(cfg, connection, fromPubkey, amount);
  },

  async buildWithdraw({
    wallet,
    chain,
    amount,
    target,
  }: BuildWithdrawArgs): Promise<UnsignedCall> {
    if (chain.namespace !== "solana") {
      throw new DefiError(
        "unsupported_chain",
        "liquid staking: requires solana namespace",
      );
    }
    const cfg = requireLstConfig(target);
    const connection = makeConnection(chain.rpcUrl);
    const fromPubkey = new PublicKey(wallet.address);
    return cfg.shape === "marinade"
      ? buildMarinadeWithdraw(cfg, connection, fromPubkey, amount)
      : buildSplStakePoolWithdraw(cfg, connection, fromPubkey, amount);
  },

  async readPosition(
    walletAddress: string,
    ctx?: PositionReadContext,
  ): Promise<DefiPosition | null> {
    if (
      ctx?.target?.kind !== "solana-lst-stake" ||
      !isSolanaLstVenue(ctx.target.venue)
    ) {
      return null;
    }
    const cfg = getSolanaLstConfig(ctx.target.venue);
    try {
      return cfg.shape === "marinade"
        ? await readMarinadePosition(cfg, walletAddress)
        : await readSplStakePoolPosition(cfg, walletAddress);
    } catch (err) {
      devWarn("readPosition", err);
      return null;
    }
  },
};
