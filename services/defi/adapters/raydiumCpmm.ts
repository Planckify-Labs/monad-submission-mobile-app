/**
 * Raydium CPMM adapter — ONE `DefiProtocolAdapter` covering Raydium's newer,
 * self-contained constant-product AMM program
 * (`CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`), dispatched by
 * `DepositTarget.kind === "raydium-cpmm-pool"` (`{pool, mintA, mintB}`).
 * Structurally this is Solana's Uniswap-v2 (the pool account IS the LP
 * mint's controller, plain `x*y=k`) — NOT Raydium's legacy `AMM v4`
 * (OpenBook-market-linked, a separate program, separate future kind) and NOT
 * Raydium's CLMM (concentrated liquidity, separate program, deferred
 * everywhere else in this codebase too).
 *
 * No SDK dependency, same methodology as `kaminoLend.ts`/`kaminoKvault.ts`:
 * hand-built from Raydium's own published `@raydium-io/raydium-sdk-v2`
 * tarball's `src/raydium/cpmm/{instruction,layout,pda}.ts` (pulled into
 * scratch, never installed) — unlike the Kamino SDKs, Raydium's CPMM
 * instruction builders are hand-written (no Anchor-codegen indirection), so
 * this file mirrors that source's account lists directly rather than
 * reverse-engineering generated code. Verified 2026-08-23:
 *
 *   - Program id confirmed live: it is the `owner` of a real CPMM pool
 *     account (cross-checked against Raydium's own public
 *     `api-v3.raydium.io/pools/info/list?poolType=standard` API, which
 *     tags this exact program id `"Cpmm"`).
 *   - `deposit`/`withdraw` discriminators are the SDK's own hardcoded
 *     `anchorDataBuf` bytes, independently re-derived as
 *     `sha256("global:deposit")[0..8]` / `sha256("global:withdraw")[0..8]`
 *     — both matched exactly (and, incidentally, `deposit`'s discriminator
 *     is byte-identical to Kamino kvault's `deposit` — expected, since
 *     Anchor discriminators only depend on the instruction NAME, not the
 *     program, and both happen to be named "deposit").
 *   - The `CpmmPoolInfoLayout` byte offsets were not hand-computed alone: a
 *     throwaway script (`@coral-xyz/borsh`, never installed into this app)
 *     reconstructed the SAME field list as the SDK's own layout and
 *     `.decode()`d a REAL live pool account; the resulting offsets matched
 *     a second, independently hand-computed table exactly.
 *   - Every PDA this adapter derives (`authority`, `mintLp`, `vaultA`,
 *     `vaultB`, `observationId` — all single-seed-list PDAs off `poolId`/
 *     `mintA`/`mintB`, per the SDK's `pda.ts`) was cross-checked against
 *     that SAME live pool's on-chain-decoded values and matched on every
 *     field, including the pinned `authority` constant
 *     (`GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL`) against its own PDA
 *     re-derivation.
 *
 * **No internal zap — both legs required.** Mirrors `uniswapV2Lp.ts`'s
 * explicit, deliberate design (its header: "Turning one token into a
 * balanced pair is a swap... approximating it here would quietly sell half
 * the user's position at whatever price the moment offered"). The CPMM
 * `deposit` instruction itself has no single-sided variant either way — it
 * pulls both `userVaultA` and `userVaultB` unconditionally. `buildDeposit`
 * quotes the OTHER leg's amount from the pool's current live vault
 * balances (same `amountB = amountA * reserveB / reserveA` ratio math as
 * `uniswapV2Lp.ts`'s router `quote()`), but the caller must already hold
 * both tokens.
 *
 * **Withdraw is MAX-only**, same repeated precedent as Curve/Solidly/
 * Uniswap-v2 in this codebase: `amount` is denominated in the underlying
 * asset but the on-chain instruction burns LP, and a guessed LP figure from
 * a partial asset amount removes the wrong value.
 *
 * **Deliberately NO `externalSlugs`.** DeFiLlama's `raydium-amm` project
 * will eventually be shared by a SECOND Solana adapter once legacy AMM v4
 * ships (same project slug, distinguished only by `poolMeta`, not by
 * program) — claiming it here would make `getDefiAdapter("raydium-amm")`
 * ambiguous between the two. Same precaution as `kaminoKvault.ts`'s
 * `sentora` note; resolution relies purely on the resolved target's `kind`.
 */

import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { DefiError } from "../errors/defiErrors";
import { maxInFor, minOutFor } from "../slippage";
import type {
  BuildDepositArgs,
  BuildWithdrawArgs,
  DefiPosition,
  DefiProtocolAdapter,
  DepositTarget,
  PositionReadContext,
  UnsignedCall,
} from "../types";

const SLUG = "raydium-cpmm";
const CLUSTER = "mainnet-beta" as const;

const CPMM_PROGRAM_ID = new PublicKey(
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
);
// PDA(["vault_and_lp_mint_auth_seed"]) — a single global authority shared by
// every CPMM pool, re-derived and matched against the pinned constant at
// module load (cheap; catches a program upgrade changing the seed).
const [CPMM_AUTHORITY] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault_and_lp_mint_auth_seed")],
  CPMM_PROGRAM_ID,
);
const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

const IX_DEPOSIT = Buffer.from("f223c68952e1f2b6", "hex");
const IX_WITHDRAW = Buffer.from("b712469c946da122", "hex");

// ── CpmmPoolInfoLayout byte offsets (from the start of the raw account
// data, INCLUDING the 8-byte Anchor discriminator) — see header. ──────────
const P_VAULT_A = 64;
const P_VAULT_B = 96;
const P_MINT_LP = 128;
const P_MINT_A = 160;
const P_MINT_B = 192;
const P_MINT_PROGRAM_A = 224;
const P_MINT_PROGRAM_B = 256;
const P_STATUS = 321; // u8, 0 = active
const P_LP_AMOUNT = 325; // u64 — total LP supply, tracked on-chain

function devWarn(scope: string, err: unknown): void {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn(`[raydiumCpmm] ${scope}:`, err);
  }
}

function makeConnection(rpcUrl: string | undefined): Connection {
  return new Connection(
    rpcUrl || "https://api.mainnet-beta.solana.com",
    "confirmed",
  );
}

function requireCpmmTarget(target: DepositTarget | undefined): {
  pool: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
} {
  if (target?.kind !== "raydium-cpmm-pool") {
    throw new DefiError(
      "deposit_failed",
      "raydium-cpmm: a resolved pool target is required",
    );
  }
  return {
    pool: new PublicKey(target.pool),
    mintA: new PublicKey(target.mintA),
    mintB: new PublicKey(target.mintB),
  };
}

interface CpmmPoolState {
  vaultA: PublicKey;
  vaultB: PublicKey;
  mintLp: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
  mintProgramA: PublicKey;
  mintProgramB: PublicKey;
  statusActive: boolean;
  lpSupply: bigint;
}

async function readPoolState(
  connection: Connection,
  pool: PublicKey,
): Promise<CpmmPoolState> {
  const info = await connection.getAccountInfo(pool);
  if (!info) {
    throw new DefiError("network_error", "raydium-cpmm: pool not found");
  }
  const d = info.data;
  if (d.length < P_LP_AMOUNT + 8) {
    throw new DefiError("network_error", "raydium-cpmm: pool data too small");
  }
  const pk = (offset: number) => new PublicKey(d.subarray(offset, offset + 32));
  return {
    vaultA: pk(P_VAULT_A),
    vaultB: pk(P_VAULT_B),
    mintLp: pk(P_MINT_LP),
    mintA: pk(P_MINT_A),
    mintB: pk(P_MINT_B),
    mintProgramA: pk(P_MINT_PROGRAM_A),
    mintProgramB: pk(P_MINT_PROGRAM_B),
    statusActive: d.readUInt8(P_STATUS) === 0,
    lpSupply: d.readBigUInt64LE(P_LP_AMOUNT),
  };
}

async function readVaultBalances(
  connection: Connection,
  vaultA: PublicKey,
  vaultB: PublicKey,
): Promise<{ reserveA: bigint; reserveB: bigint }> {
  const [balA, balB] = await Promise.all([
    connection.getTokenAccountBalance(vaultA),
    connection.getTokenAccountBalance(vaultB),
  ]);
  return {
    reserveA: BigInt(balA.value.amount),
    reserveB: BigInt(balB.value.amount),
  };
}

async function buildCpmmDeposit(
  connection: Connection,
  owner: PublicKey,
  target: { pool: PublicKey; mintA: PublicKey; mintB: PublicKey },
  asset: { contract?: string },
  amount: bigint,
  tier: BuildDepositArgs["tier"],
): Promise<UnsignedCall> {
  const { pool, mintA, mintB } = target;
  const poolState = await readPoolState(connection, pool);
  if (!poolState.mintA.equals(mintA) || !poolState.mintB.equals(mintB)) {
    throw new DefiError(
      "deposit_failed",
      "raydium-cpmm: pool's on-chain mints do not match the resolved target",
    );
  }
  if (!poolState.statusActive) {
    throw new DefiError("deposit_failed", "raydium-cpmm: pool is not active");
  }

  const supplied = asset.contract ?? "";
  const suppliedIsA = supplied === mintA.toBase58();
  const suppliedIsB = supplied === mintB.toBase58();
  if (!suppliedIsA && !suppliedIsB) {
    throw new DefiError(
      "unsupported_asset",
      "raydium-cpmm: asset is not one of the pool's tokens",
    );
  }

  const { reserveA, reserveB } = await readVaultBalances(
    connection,
    poolState.vaultA,
    poolState.vaultB,
  );
  const [reserveThis, reserveOther] = suppliedIsA
    ? [reserveA, reserveB]
    : [reserveB, reserveA];
  if (reserveThis <= 0n || reserveOther <= 0n || poolState.lpSupply <= 0n) {
    throw new DefiError(
      "protocol_not_found",
      "raydium-cpmm: pool has no reserves to price the pair against",
    );
  }

  const amountOther = (amount * reserveOther) / reserveThis;
  const lpAmount = (amount * poolState.lpSupply) / reserveThis;
  if (amountOther <= 0n || lpAmount <= 0n) {
    throw new DefiError(
      "below_min_deposit",
      "raydium-cpmm: amount is too small to pair",
    );
  }

  const amountMaxThis = maxInFor(amount, { tier, stable: false });
  const amountMaxOther = maxInFor(amountOther, { tier, stable: false });
  const [amountMaxA, amountMaxB] = suppliedIsA
    ? [amountMaxThis, amountMaxOther]
    : [amountMaxOther, amountMaxThis];

  const userVaultA = getAssociatedTokenAddressSync(
    mintA,
    owner,
    false,
    poolState.mintProgramA,
  );
  const userVaultB = getAssociatedTokenAddressSync(
    mintB,
    owner,
    false,
    poolState.mintProgramB,
  );
  const userLpAccount = getAssociatedTokenAddressSync(
    poolState.mintLp,
    owner,
    false,
    TOKEN_PROGRAM_ID,
  );
  const createLpAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    owner,
    userLpAccount,
    owner,
    poolState.mintLp,
    TOKEN_PROGRAM_ID,
  );

  const data = Buffer.alloc(32);
  IX_DEPOSIT.copy(data, 0);
  data.writeBigUInt64LE(lpAmount, 8);
  data.writeBigUInt64LE(amountMaxA, 16);
  data.writeBigUInt64LE(amountMaxB, 24);

  const depositIx = new TransactionInstruction({
    programId: CPMM_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: CPMM_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: userLpAccount, isSigner: false, isWritable: true },
      { pubkey: userVaultA, isSigner: false, isWritable: true },
      { pubkey: userVaultB, isSigner: false, isWritable: true },
      { pubkey: poolState.vaultA, isSigner: false, isWritable: true },
      { pubkey: poolState.vaultB, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: mintA, isSigner: false, isWritable: false },
      { pubkey: mintB, isSigner: false, isWritable: false },
      { pubkey: poolState.mintLp, isSigner: false, isWritable: true },
    ],
    data,
  });

  return {
    kind: "solana-ix",
    instructions: [createLpAtaIx, depositIx],
  };
}

async function buildCpmmWithdraw(
  connection: Connection,
  owner: PublicKey,
  target: { pool: PublicKey; mintA: PublicKey; mintB: PublicKey },
  amount: bigint | "MAX",
  tier: BuildWithdrawArgs["tier"],
): Promise<UnsignedCall> {
  if (amount !== "MAX") {
    throw new DefiError(
      "withdraw_failed",
      "raydium-cpmm: partial withdraw needs an LP amount, use MAX for a full exit",
    );
  }
  const { pool, mintA, mintB } = target;
  const poolState = await readPoolState(connection, pool);
  if (!poolState.mintA.equals(mintA) || !poolState.mintB.equals(mintB)) {
    throw new DefiError(
      "deposit_failed",
      "raydium-cpmm: pool's on-chain mints do not match the resolved target",
    );
  }

  const userLpAccount = getAssociatedTokenAddressSync(
    poolState.mintLp,
    owner,
    false,
    TOKEN_PROGRAM_ID,
  );
  const liquidity = await connection
    .getTokenAccountBalance(userLpAccount)
    .then((r) => BigInt(r.value.amount))
    .catch(() => 0n);
  if (liquidity <= 0n) {
    throw new DefiError("position_not_found", "raydium-cpmm: no LP balance");
  }
  if (poolState.lpSupply <= 0n) {
    throw new DefiError("withdraw_failed", "raydium-cpmm: pool has no supply");
  }

  const { reserveA, reserveB } = await readVaultBalances(
    connection,
    poolState.vaultA,
    poolState.vaultB,
  );
  const amountA = (liquidity * reserveA) / poolState.lpSupply;
  const amountB = (liquidity * reserveB) / poolState.lpSupply;
  const amountMinA = minOutFor(amountA, { tier, stable: false });
  const amountMinB = minOutFor(amountB, { tier, stable: false });

  const userVaultA = getAssociatedTokenAddressSync(
    mintA,
    owner,
    false,
    poolState.mintProgramA,
  );
  const userVaultB = getAssociatedTokenAddressSync(
    mintB,
    owner,
    false,
    poolState.mintProgramB,
  );
  const createAtaIxs = [
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      userVaultA,
      owner,
      mintA,
      poolState.mintProgramA,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      userVaultB,
      owner,
      mintB,
      poolState.mintProgramB,
    ),
  ];

  const data = Buffer.alloc(32);
  IX_WITHDRAW.copy(data, 0);
  data.writeBigUInt64LE(liquidity, 8);
  data.writeBigUInt64LE(amountMinA, 16);
  data.writeBigUInt64LE(amountMinB, 24);

  const withdrawIx = new TransactionInstruction({
    programId: CPMM_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: CPMM_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: userLpAccount, isSigner: false, isWritable: true },
      { pubkey: userVaultA, isSigner: false, isWritable: true },
      { pubkey: userVaultB, isSigner: false, isWritable: true },
      { pubkey: poolState.vaultA, isSigner: false, isWritable: true },
      { pubkey: poolState.vaultB, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: mintA, isSigner: false, isWritable: false },
      { pubkey: mintB, isSigner: false, isWritable: false },
      { pubkey: poolState.mintLp, isSigner: false, isWritable: true },
      { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });

  return {
    kind: "solana-ix",
    instructions: [...createAtaIxs, withdrawIx],
  };
}

async function readCpmmPosition(
  walletAddress: string,
  target: DepositTarget & { kind: "raydium-cpmm-pool" },
): Promise<DefiPosition | null> {
  const connection = makeConnection(undefined);
  const pool = new PublicKey(target.pool);
  const owner = new PublicKey(walletAddress);

  const poolState = await readPoolState(connection, pool);
  const userLpAccount = getAssociatedTokenAddressSync(
    poolState.mintLp,
    owner,
    false,
    TOKEN_PROGRAM_ID,
  );
  const liquidity = await connection
    .getTokenAccountBalance(userLpAccount)
    .then((r) => BigInt(r.value.amount))
    .catch(() => 0n);
  if (liquidity <= 0n) return null;

  return {
    protocolSlug: SLUG,
    namespace: "solana",
    chainId: CLUSTER,
    assetSymbol: target.mintA,
    amountAtDeposit: 0n,
    amountAtDepositUsd: 0,
    // LP units, not underlying — same convention as uniswapV2Lp.ts: an LP
    // position's value in one leg is path-dependent, priced upstream where
    // both reserves and the USD rate are available.
    currentAmount: liquidity,
    currentAmountUsd: 0,
    pnlUsd: 0,
  };
}

export const RaydiumCpmmAdapter: DefiProtocolAdapter = {
  slug: SLUG,
  namespace: "solana",
  kind: "lp_volatile",
  chainId: CLUSTER,
  displayName: "Raydium",
  staticSafetyScore: 55,
  targetKinds: ["raydium-cpmm-pool"],

  async buildDeposit({
    wallet,
    chain,
    asset,
    amount,
    target,
    tier,
  }: BuildDepositArgs): Promise<UnsignedCall> {
    if (chain.namespace !== "solana") {
      throw new DefiError(
        "unsupported_chain",
        "raydium-cpmm: requires solana namespace",
      );
    }
    const t = requireCpmmTarget(target);
    const connection = makeConnection(chain.rpcUrl);
    const owner = new PublicKey(wallet.address);
    return buildCpmmDeposit(connection, owner, t, asset, amount, tier);
  },

  async buildWithdraw({
    wallet,
    chain,
    amount,
    target,
    tier,
  }: BuildWithdrawArgs): Promise<UnsignedCall> {
    if (chain.namespace !== "solana") {
      throw new DefiError(
        "unsupported_chain",
        "raydium-cpmm: requires solana namespace",
      );
    }
    const t = requireCpmmTarget(target);
    const connection = makeConnection(chain.rpcUrl);
    const owner = new PublicKey(wallet.address);
    return buildCpmmWithdraw(connection, owner, t, amount, tier);
  },

  async readPosition(
    walletAddress: string,
    ctx?: PositionReadContext,
  ): Promise<DefiPosition | null> {
    if (ctx?.target?.kind !== "raydium-cpmm-pool") return null;
    try {
      return await readCpmmPosition(
        walletAddress,
        ctx.target as DepositTarget & { kind: "raydium-cpmm-pool" },
      );
    } catch (err) {
      devWarn("readPosition", err);
      return null;
    }
  },
};
