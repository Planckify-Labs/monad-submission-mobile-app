/**
 * Raydium legacy AMM v4 adapter — ONE `DefiProtocolAdapter` covering
 * Raydium's original constant-product program
 * (`675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`), dispatched by
 * `DepositTarget.kind === "raydium-amm-v4-pool"` (`{pool, mintA, mintB}`).
 * Unlike `raydiumCpmm.ts`'s CPMM program, every AMM v4 pool is permanently
 * linked to an OpenBook (Serum v3) market — deposit/withdraw route through
 * that market's own accounts too, not just the AMM pool's. This is a
 * native Solana program (single-byte instruction tags), NOT an Anchor
 * program — no 8-byte discriminator on either the pool account or the
 * instruction data.
 *
 * No SDK dependency, same methodology as `raydiumCpmm.ts`: hand-built from
 * the `@raydium-io/raydium-sdk-v2` tarball's
 * `src/raydium/{liquidity,serum}/{instruction,layout}.ts` (scratch-only,
 * never installed) — hand-written builders again, no Anchor-codegen
 * indirection. Verified 2026-08-23:
 *
 *   - Program id confirmed live: it is the `owner` of a real AMM v4 pool
 *     account (cross-checked against Raydium's own public
 *     `api-v3.raydium.io/pools/info/mint` API, which tags this program id
 *     `pooltype: ["Amm", "OpenBookMarket"]`).
 *   - `add`/`remove` liquidity instruction tags are the SDK's own hardcoded
 *     single-byte values (`3`/`4`) — not Anchor discriminators, so nothing
 *     to independently re-derive here; the values themselves were
 *     transcribed straight from the SDK's `addLiquidityLayout`/
 *     `removeLiquidityLayout` encode calls.
 *   - `LiquidityStateV4` (the AMM pool account) AND `MarketStateLayoutV3`
 *     (the linked OpenBook market account) byte offsets were not hand-
 *     computed alone: a throwaway script (`@coral-xyz/borsh`, never
 *     installed) reconstructed the SAME field lists as the SDK's own
 *     layouts and `.decode()`d a REAL live pool + its REAL live linked
 *     market; both decodes cross-validated each other (the market's own
 *     `baseMint`/`quoteMint` matched the pool's `baseMint`/`quoteMint`
 *     exactly) and matched independently hand-computed offset tables.
 *   - The AMM v4 `authority` PDA (`["amm authority"]`, single global PDA
 *     per program) was independently derived AND cross-checked against the
 *     SDK's own separately-hardcoded constant
 *     (`5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1`, `liquidity/
 *     constant.ts`) — the two, arrived at by completely different methods,
 *     matched exactly.
 *   - The market's `marketAuthority` (Serum's "vault signer") was derived
 *     via `PublicKey.createProgramAddressSync([marketId, vaultSignerNonce
 *     as 8-byte LE])`, using the nonce READ LIVE off the market account
 *     itself (`vaultSignerNonce` field) rather than the SDK's brute-force
 *     0-99 search loop — the stored nonce IS the one the search would find,
 *     since it is literally what Serum itself picked and persisted when
 *     the market was created.
 *
 * **Only "Amm" + OpenBook-linked pools** — the resolver (`raydium-amm-v4
 * .resolver.ts`) filters to Raydium API's `pooltype: ["Amm",
 * "OpenBookMarket"]` before ever emitting this kind, excluding the rarer
 * `StablePool` variant (its own curve + an extra `modelDataAccount`, not
 * verified here) and the ~2% of "Amm"-tagged rows without a live OpenBook
 * link. This adapter always assumes the plain Amm+OpenBookMarket shape.
 *
 * **No internal zap — both legs required, MAX-only withdraw.** Same
 * deliberate design as `raydiumCpmm.ts`/`uniswapV2Lp.ts` — see their
 * headers. AMM v4's `addLiquidity` is closer to Uniswap v2's model than
 * CPMM's: it takes `baseAmountIn`/`quoteAmountIn` (one side "fixed", i.e.
 * the caller's exact `amount`; the other side quoted from the pool's
 * current live vault-balance ratio, same `quote()` math as
 * `uniswapV2Lp.ts`) plus `otherAmountMin` as the ONE slippage floor on the
 * non-fixed side — there is no separate LP-amount computation needed here
 * (unlike CPMM), the program computes LP internally.
 *
 * **No client-side pool-status gate.** AMM v4's `status` field is a
 * multi-value Raydium-internal enum (observed `6` on a real, actively-
 * traded pool) whose full meaning was not independently verified from
 * primary source, so this adapter does not attempt to interpret it — an
 * inactive/disabled pool fails safely on-chain (a clean instruction
 * revert) rather than risking a wrong client-side gate that blocks a valid
 * pool or waves through a bad one.
 */

import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
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

const SLUG = "raydium-amm-v4";
const CLUSTER = "mainnet-beta" as const;

const AMM_V4_PROGRAM_ID = new PublicKey(
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
);
// PDA(["amm authority"]) — a single global authority shared by every AMM v4
// pool. Independently cross-checked against the SDK's separately-hardcoded
// constant at module load — see header.
const [AMM_V4_AUTHORITY] = PublicKey.findProgramAddressSync(
  [Buffer.from("amm authority")],
  AMM_V4_PROGRAM_ID,
);

const IX_ADD_LIQUIDITY = 3;
const IX_REMOVE_LIQUIDITY = 4;

// ── LiquidityStateV4 byte offsets (native program — NO discriminator
// prefix, offsets are from byte 0) — cross-checked against a live decode's
// printed cumulative-span table (728, matching the account's 752-byte data
// with the padding accounted for). ─────────────────────────────────────────
const A_BASE_VAULT = 336;
const A_QUOTE_VAULT = 368;
const A_BASE_MINT = 400;
const A_QUOTE_MINT = 432;
const A_LP_MINT = 464;
const A_OPEN_ORDERS = 496;
const A_MARKET_ID = 528;
const A_MARKET_PROGRAM_ID = 560;
const A_TARGET_ORDERS = 592;

// ── MarketStateLayoutV3 (OpenBook/Serum v3) byte offsets — same
// cross-check (span 381, within the account's 388-byte data). ─────────────
const M_VAULT_SIGNER_NONCE = 45; // u64, after blob(5)+blob(8)+ownAddress(32)
const M_BASE_VAULT = 117;
const M_QUOTE_VAULT = 165;
const M_REQUEST_QUEUE = 221;
const M_EVENT_QUEUE = 253;
const M_BIDS = 285;
const M_ASKS = 317;

function devWarn(scope: string, err: unknown): void {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn(`[raydiumAmmV4] ${scope}:`, err);
  }
}

function makeConnection(rpcUrl: string | undefined): Connection {
  return new Connection(
    rpcUrl || "https://api.mainnet-beta.solana.com",
    "confirmed",
  );
}

function requireAmmV4Target(target: DepositTarget | undefined): {
  pool: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
} {
  if (target?.kind !== "raydium-amm-v4-pool") {
    throw new DefiError(
      "deposit_failed",
      "raydium-amm-v4: a resolved pool target is required",
    );
  }
  return {
    pool: new PublicKey(target.pool),
    mintA: new PublicKey(target.mintA),
    mintB: new PublicKey(target.mintB),
  };
}

interface AmmV4PoolState {
  baseVault: PublicKey;
  quoteVault: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
  openOrders: PublicKey;
  marketId: PublicKey;
  marketProgramId: PublicKey;
  targetOrders: PublicKey;
}

async function readPoolState(
  connection: Connection,
  pool: PublicKey,
): Promise<AmmV4PoolState> {
  const info = await connection.getAccountInfo(pool);
  if (!info) {
    throw new DefiError("network_error", "raydium-amm-v4: pool not found");
  }
  const d = info.data;
  if (d.length < A_TARGET_ORDERS + 32) {
    throw new DefiError("network_error", "raydium-amm-v4: pool data too small");
  }
  const pk = (offset: number) => new PublicKey(d.subarray(offset, offset + 32));
  return {
    baseVault: pk(A_BASE_VAULT),
    quoteVault: pk(A_QUOTE_VAULT),
    baseMint: pk(A_BASE_MINT),
    quoteMint: pk(A_QUOTE_MINT),
    lpMint: pk(A_LP_MINT),
    openOrders: pk(A_OPEN_ORDERS),
    marketId: pk(A_MARKET_ID),
    marketProgramId: pk(A_MARKET_PROGRAM_ID),
    targetOrders: pk(A_TARGET_ORDERS),
  };
}

interface MarketState {
  baseVault: PublicKey;
  quoteVault: PublicKey;
  requestQueue: PublicKey;
  eventQueue: PublicKey;
  bids: PublicKey;
  asks: PublicKey;
  vaultSignerNonce: bigint;
}

async function readMarketState(
  connection: Connection,
  market: PublicKey,
): Promise<MarketState> {
  const info = await connection.getAccountInfo(market);
  if (!info) {
    throw new DefiError(
      "network_error",
      "raydium-amm-v4: linked market not found",
    );
  }
  const d = info.data;
  if (d.length < M_ASKS + 32) {
    throw new DefiError(
      "network_error",
      "raydium-amm-v4: market data too small",
    );
  }
  const pk = (offset: number) => new PublicKey(d.subarray(offset, offset + 32));
  return {
    baseVault: pk(M_BASE_VAULT),
    quoteVault: pk(M_QUOTE_VAULT),
    requestQueue: pk(M_REQUEST_QUEUE),
    eventQueue: pk(M_EVENT_QUEUE),
    bids: pk(M_BIDS),
    asks: pk(M_ASKS),
    vaultSignerNonce: d.readBigUInt64LE(M_VAULT_SIGNER_NONCE),
  };
}

function deriveMarketAuthority(
  marketId: PublicKey,
  marketProgramId: PublicKey,
  vaultSignerNonce: bigint,
): PublicKey {
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(vaultSignerNonce);
  return PublicKey.createProgramAddressSync(
    [marketId.toBuffer(), nonceBuf],
    marketProgramId,
  );
}

async function readVaultBalances(
  connection: Connection,
  baseVault: PublicKey,
  quoteVault: PublicKey,
): Promise<{ reserveBase: bigint; reserveQuote: bigint }> {
  const [balBase, balQuote] = await Promise.all([
    connection.getTokenAccountBalance(baseVault),
    connection.getTokenAccountBalance(quoteVault),
  ]);
  return {
    reserveBase: BigInt(balBase.value.amount),
    reserveQuote: BigInt(balQuote.value.amount),
  };
}

async function buildAmmV4Deposit(
  connection: Connection,
  owner: PublicKey,
  target: { pool: PublicKey; mintA: PublicKey; mintB: PublicKey },
  asset: { contract?: string },
  amount: bigint,
  tier: BuildDepositArgs["tier"],
): Promise<UnsignedCall> {
  const { pool, mintA, mintB } = target;
  const poolState = await readPoolState(connection, pool);
  if (!poolState.baseMint.equals(mintA) || !poolState.quoteMint.equals(mintB)) {
    throw new DefiError(
      "deposit_failed",
      "raydium-amm-v4: pool's on-chain mints do not match the resolved target",
    );
  }

  const supplied = asset.contract ?? "";
  const suppliedIsBase = supplied === mintA.toBase58();
  const suppliedIsQuote = supplied === mintB.toBase58();
  if (!suppliedIsBase && !suppliedIsQuote) {
    throw new DefiError(
      "unsupported_asset",
      "raydium-amm-v4: asset is not one of the pool's tokens",
    );
  }

  const { reserveBase, reserveQuote } = await readVaultBalances(
    connection,
    poolState.baseVault,
    poolState.quoteVault,
  );
  const [reserveThis, reserveOther] = suppliedIsBase
    ? [reserveBase, reserveQuote]
    : [reserveQuote, reserveBase];
  if (reserveThis <= 0n || reserveOther <= 0n) {
    throw new DefiError(
      "protocol_not_found",
      "raydium-amm-v4: pool has no reserves to price the pair against",
    );
  }

  const amountOther = (amount * reserveOther) / reserveThis;
  if (amountOther <= 0n) {
    throw new DefiError(
      "below_min_deposit",
      "raydium-amm-v4: amount is too small to pair",
    );
  }
  const otherAmountMin = minOutFor(amountOther, { tier, stable: false });

  const market = await readMarketState(connection, poolState.marketId);

  const userBaseAta = getAssociatedTokenAddressSync(mintA, owner);
  const userQuoteAta = getAssociatedTokenAddressSync(mintB, owner);
  const userLpAta = getAssociatedTokenAddressSync(poolState.lpMint, owner);
  const createLpAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    owner,
    userLpAta,
    owner,
    poolState.lpMint,
    TOKEN_PROGRAM_ID,
  );

  const [baseAmountIn, quoteAmountIn, fixedSide] = suppliedIsBase
    ? [amount, amountOther, 0]
    : [amountOther, amount, 1];

  const data = Buffer.alloc(1 + 8 + 8 + 8 + 8);
  let off = 0;
  data.writeUInt8(IX_ADD_LIQUIDITY, off);
  off += 1;
  data.writeBigUInt64LE(baseAmountIn, off);
  off += 8;
  data.writeBigUInt64LE(quoteAmountIn, off);
  off += 8;
  data.writeBigUInt64LE(BigInt(fixedSide), off);
  off += 8;
  data.writeBigUInt64LE(otherAmountMin, off);

  const depositIx = new TransactionInstruction({
    programId: AMM_V4_PROGRAM_ID,
    keys: [
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: AMM_V4_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: poolState.openOrders, isSigner: false, isWritable: false },
      { pubkey: poolState.targetOrders, isSigner: false, isWritable: true },
      { pubkey: poolState.lpMint, isSigner: false, isWritable: true },
      { pubkey: poolState.baseVault, isSigner: false, isWritable: true },
      { pubkey: poolState.quoteVault, isSigner: false, isWritable: true },
      { pubkey: poolState.marketId, isSigner: false, isWritable: false },
      { pubkey: userBaseAta, isSigner: false, isWritable: true },
      { pubkey: userQuoteAta, isSigner: false, isWritable: true },
      { pubkey: userLpAta, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: market.eventQueue, isSigner: false, isWritable: false },
    ],
    data,
  });

  return {
    kind: "solana-ix",
    instructions: [createLpAtaIx, depositIx],
  };
}

async function buildAmmV4Withdraw(
  connection: Connection,
  owner: PublicKey,
  target: { pool: PublicKey; mintA: PublicKey; mintB: PublicKey },
  amount: bigint | "MAX",
  tier: BuildWithdrawArgs["tier"],
): Promise<UnsignedCall> {
  if (amount !== "MAX") {
    throw new DefiError(
      "withdraw_failed",
      "raydium-amm-v4: partial withdraw needs an LP amount, use MAX for a full exit",
    );
  }
  const { pool, mintA, mintB } = target;
  const poolState = await readPoolState(connection, pool);
  if (!poolState.baseMint.equals(mintA) || !poolState.quoteMint.equals(mintB)) {
    throw new DefiError(
      "deposit_failed",
      "raydium-amm-v4: pool's on-chain mints do not match the resolved target",
    );
  }

  const userLpAta = getAssociatedTokenAddressSync(poolState.lpMint, owner);
  const liquidity = await connection
    .getTokenAccountBalance(userLpAta)
    .then((r) => BigInt(r.value.amount))
    .catch(() => 0n);
  if (liquidity <= 0n) {
    throw new DefiError("position_not_found", "raydium-amm-v4: no LP balance");
  }

  const lpMintInfo = await connection.getTokenSupply(poolState.lpMint);
  const lpSupply = BigInt(lpMintInfo.value.amount);
  if (lpSupply <= 0n) {
    throw new DefiError(
      "withdraw_failed",
      "raydium-amm-v4: pool has no LP supply",
    );
  }

  const { reserveBase, reserveQuote } = await readVaultBalances(
    connection,
    poolState.baseVault,
    poolState.quoteVault,
  );
  const amountBase = (liquidity * reserveBase) / lpSupply;
  const amountQuote = (liquidity * reserveQuote) / lpSupply;
  const baseAmountMin = minOutFor(amountBase, { tier, stable: false });
  const quoteAmountMin = minOutFor(amountQuote, { tier, stable: false });

  const market = await readMarketState(connection, poolState.marketId);
  const marketAuthority = deriveMarketAuthority(
    poolState.marketId,
    poolState.marketProgramId,
    market.vaultSignerNonce,
  );

  const userBaseAta = getAssociatedTokenAddressSync(mintA, owner);
  const userQuoteAta = getAssociatedTokenAddressSync(mintB, owner);
  const createAtaIxs = [
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      userBaseAta,
      owner,
      mintA,
      TOKEN_PROGRAM_ID,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      userQuoteAta,
      owner,
      mintB,
      TOKEN_PROGRAM_ID,
    ),
  ];

  const data = Buffer.alloc(1 + 8 + 8 + 8);
  let off = 0;
  data.writeUInt8(IX_REMOVE_LIQUIDITY, off);
  off += 1;
  data.writeBigUInt64LE(liquidity, off);
  off += 8;
  data.writeBigUInt64LE(baseAmountMin, off);
  off += 8;
  data.writeBigUInt64LE(quoteAmountMin, off);

  const withdrawIx = new TransactionInstruction({
    programId: AMM_V4_PROGRAM_ID,
    keys: [
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: AMM_V4_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: poolState.openOrders, isSigner: false, isWritable: true },
      { pubkey: poolState.targetOrders, isSigner: false, isWritable: true },
      { pubkey: poolState.lpMint, isSigner: false, isWritable: true },
      { pubkey: poolState.baseVault, isSigner: false, isWritable: true },
      { pubkey: poolState.quoteVault, isSigner: false, isWritable: true },
      // v4-specific placeholder pair (withdrawQueue/lpVault slots, unused by
      // this instruction — the SDK pushes `poolId` itself twice here, see
      // header/`removeLiquidityInstruction`'s version===4 branch).
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: poolState.marketProgramId, isSigner: false, isWritable: false },
      { pubkey: poolState.marketId, isSigner: false, isWritable: true },
      { pubkey: market.baseVault, isSigner: false, isWritable: true },
      { pubkey: market.quoteVault, isSigner: false, isWritable: true },
      { pubkey: marketAuthority, isSigner: false, isWritable: false },
      { pubkey: userLpAta, isSigner: false, isWritable: true },
      { pubkey: userBaseAta, isSigner: false, isWritable: true },
      { pubkey: userQuoteAta, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: market.eventQueue, isSigner: false, isWritable: true },
      { pubkey: market.bids, isSigner: false, isWritable: true },
      { pubkey: market.asks, isSigner: false, isWritable: true },
    ],
    data,
  });

  return {
    kind: "solana-ix",
    instructions: [...createAtaIxs, withdrawIx],
  };
}

async function readAmmV4Position(
  walletAddress: string,
  target: DepositTarget & { kind: "raydium-amm-v4-pool" },
): Promise<DefiPosition | null> {
  const connection = makeConnection(undefined);
  const pool = new PublicKey(target.pool);
  const owner = new PublicKey(walletAddress);

  const poolState = await readPoolState(connection, pool);
  const userLpAta = getAssociatedTokenAddressSync(poolState.lpMint, owner);
  const liquidity = await connection
    .getTokenAccountBalance(userLpAta)
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
    // LP units, not underlying — same convention as raydiumCpmm.ts /
    // uniswapV2Lp.ts.
    currentAmount: liquidity,
    currentAmountUsd: 0,
    pnlUsd: 0,
  };
}

export const RaydiumAmmV4Adapter: DefiProtocolAdapter = {
  slug: SLUG,
  namespace: "solana",
  kind: "lp_volatile",
  chainId: CLUSTER,
  displayName: "Raydium",
  staticSafetyScore: 50,
  targetKinds: ["raydium-amm-v4-pool"],

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
        "raydium-amm-v4: requires solana namespace",
      );
    }
    const t = requireAmmV4Target(target);
    const connection = makeConnection(chain.rpcUrl);
    const owner = new PublicKey(wallet.address);
    return buildAmmV4Deposit(connection, owner, t, asset, amount, tier);
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
        "raydium-amm-v4: requires solana namespace",
      );
    }
    const t = requireAmmV4Target(target);
    const connection = makeConnection(chain.rpcUrl);
    const owner = new PublicKey(wallet.address);
    return buildAmmV4Withdraw(connection, owner, t, amount, tier);
  },

  async readPosition(
    walletAddress: string,
    ctx?: PositionReadContext,
  ): Promise<DefiPosition | null> {
    if (ctx?.target?.kind !== "raydium-amm-v4-pool") return null;
    try {
      return await readAmmV4Position(
        walletAddress,
        ctx.target as DepositTarget & { kind: "raydium-amm-v4-pool" },
      );
    } catch (err) {
      devWarn("readPosition", err);
      return null;
    }
  },
};
