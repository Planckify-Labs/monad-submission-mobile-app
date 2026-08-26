/**
 * Kamino kliquidity adapter — ONE `DefiProtocolAdapter` covering Kamino's
 * managed CLMM vault product ("kliquidity"/"yvaults" on-chain, program
 * `6LtLpnUFNByNXLyCoK9wA2MykKAmQNZKBdY8s47dehDc`), dispatched by
 * `DepositTarget.kind === "kamino-liquidity-strategy"`
 * (`{strategy, mintA, mintB}`). This wraps an auto-rebalancing Orca
 * Whirlpool / Raydium CLMM / Meteora DLMM position behind a share vault —
 * SEPARATE from Kamino Lend (`kaminoLend.ts`, Obligation-based) and Kamino
 * kvault (`kaminoKvault.ts`, single-asset share vault); this one is
 * genuinely two-sided.
 *
 * No SDK dependency, same methodology as the sibling Kamino/Raydium
 * adapters: hand-built from `@kamino-finance/kliquidity-sdk`'s (Apache-2.0)
 * published tarball's `src/@codegen/kliquidity/*` (pulled into scratch,
 * never installed), verified 2026-08-26:
 *
 *   - Program id confirmed live: it is the `owner` of all 108 real
 *     `WhirlpoolStrategy` accounts checked this session.
 *   - The `deposit`/`withdraw` instruction discriminators were independently
 *     computed as `sha256("global:<name>")[0..8]` AND cross-checked
 *     byte-for-byte against the SDK's own hardcoded constants — both
 *     matched (and, expected per Anchor's naming-only discriminator scheme,
 *     `deposit`'s bytes are identical to Kamino kvault's and Raydium CPMM's
 *     own `deposit`).
 *   - Every `WhirlpoolStrategy` byte offset used below was NOT hand-summed
 *     alone: a throwaway `@solana/kit` script decoded real accounts with
 *     the SDK's own generated decoder, and a SECOND, independently
 *     hand-computed offset table (summing each field's encoder size in
 *     struct order) was cross-checked against it field-by-field — all
 *     matched exactly, including `tokenATokenProgram`/`tokenBTokenProgram`
 *     (found by encoding a sentinel struct through the SDK's own encoder
 *     and locating the two distinct token-program ids by byte search,
 *     rather than hand-summing the struct's long, variable-shaped tail).
 *     Same double-check for `GlobalConfig.tokenInfos`, the `CollateralInfos`
 *     entry stride/`scopeFeed` offset, and the Orca `Whirlpool`/`Position`
 *     fields this adapter reads (see below) — every one matched the SDK's
 *     own decode of a real account.
 *
 * **Scope is Scope, and it's just a passthrough.** `Deposit`'s account list
 * hard-requires `scopePricesA`/`scopePricesB`/`tokenInfos`, but live
 * verification found ALL 52 distinct `CollateralInfo` ids referenced by
 * every strategy this adapter targets resolve to the SAME single Scope
 * `OraclePrices` account (`3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C`),
 * and the SDK's own off-chain deposit-ratio math
 * (`calculateDepositAmountsProportionalWithTotalTokens`) makes zero price
 * calls — it derives the achievable split purely from the strategy's
 * current on-chain token holdings. This adapter resolves the two
 * `scopeFeed` pubkeys live (`GlobalConfig.tokenInfos` → `CollateralInfos`,
 * indexed by `tokenACollateralId`/`tokenBCollateralId` — the exact same
 * "look up a per-token config row" pattern `kaminoLend.ts` already uses for
 * its own `R_CONFIG_SCOPE_PRICE_FEED`) and passes them through unread. No
 * price is ever interpreted client-side.
 *
 * **The tick↔sqrtPrice and liquidity↔amount math in `clmmMath.ts` was
 * written independently from the public mathematical specification, not by
 * reading any vendor's implementation** (deliberate — Orca's SDK relicensed
 * to a non-commercial-only license in 2025). It was verified two ways
 * without comparing to any vendor's code: (1) `tickIndexToSqrtPriceX64`
 * cross-checked against 12 real, live Orca pools' own `sqrtPrice`/
 * `tickCurrentIndex` — the required invariant
 * (`sqrtPrice(tickCurrentIndex) <= pool.sqrtPrice`) held on all 12, with the
 * expected sub-tick gap (max 3.7e-5 relative) and no larger discrepancy;
 * (2) the liquidity formulas round-trip exactly (amount → liquidity →
 * amount recovers the original to within 1 unit of integer-division
 * truncation) on multiple real sqrtPrice ranges.
 *
 * **v1 scope, deliberately narrow (fail closed, not guessed).** Of the 108
 * DeFiLlama `kamino-liquidity` pools this session could resolve a live
 * strategy address for, ALL 108 use `shareCalculationMethod ===
 * PROPORTION_BASED` (no `DOLAR_BASED` strategy was found among them, so
 * that branch's share-mint math — which may not be oracle-free — was never
 * needed and is refused rather than guessed at). They split 65 Orca-backed /
 * 31 Raydium-backed / 12 Meteora-backed. Of the 65 Orca-backed ones, 34 have
 * NO active reward (checked live) and 31 do — an active reward (either the
 * plain `reward0/1/2` slots or the separate `kaminoRewards` array) needs an
 * extra Scope price account per reward appended as a remaining account
 * (discovered live: the first simulate attempt against a rewarded strategy
 * failed `RewardScopePriceAccountNotPresent`), which this adapter doesn't
 * build. So the real v1 slice is Orca-backed + `PROPORTION_BASED` + NO
 * active reward — 34 strategies, ~$36.4M. Raydium/Meteora-backed strategies
 * need their own CLMM math fork (their sqrtPrice representations differ)
 * and stay Manual; rewarded strategies stay Manual until the extra
 * remaining-account is built. The resolver (`kamino-liquidity.resolver.ts`)
 * deliberately does NOT pre-filter by any of this — this adapter re-reads
 * the strategy's live on-chain state and refuses (fail closed) anything it
 * doesn't support, same split of responsibility as every other Solana
 * resolver/adapter pair in this repo.
 *
 * **Live-verified 2026-08-26**, against the real, unrewarded USDG-USDC
 * strategy (`ByPbo7yGcsfrEXet3ip3DcMKf4hwhUv71b6aAU9umBdu`) and a real funded
 * mainnet wallet found via the established "query the mint's own signature
 * history" trick: `simulateTransaction` with `sigVerify: false` ran the
 * ENTIRE on-chain `Deposit` handler successfully —
 * `vault_operations::deposit(...)` returned
 * `Ok(DepositEffects { shares_to_mint, token_a_to_deposit, token_b_to_deposit })`,
 * meaning the full account list, the Scope passthrough, and the on-chain
 * ratio/share-mint math all executed correctly — and only failed on the
 * subsequent SPL `TransferChecked` with "insufficient funds", because that
 * specific test wallet didn't hold enough of the token being pulled. A
 * smaller test amount against the SAME strategy separately confirmed
 * `DepositLessThanMinimum` (Kamino's own floor) rather than any
 * account-shape error. Both are exactly the "reached a real, benign,
 * wallet/amount-specific failure with nothing wrong upstream" bar this
 * codebase's other hand-rolled Solana adapters cite as their verification
 * (see `kaminoKvault.ts`'s header).
 *
 * **No internal zap — both legs required**, mirroring `raydiumCpmm.ts` /
 * `uniswapV2Lp.ts`'s explicit precedent. `Deposit` itself is two-sided
 * (`tokenMaxA`/`tokenMaxB`) with no swap step of its own; the caller must
 * already hold both tokens. The achievable split is derived from the
 * strategy's LIVE Orca position (liquidity + tick range + pool price) via
 * `clmmMath.ts`'s formulas, not from Kamino's cached, possibly-stale
 * `tokenAAmounts`/`tokenBAmounts` snapshot fields.
 *
 * **`CannotDepositOutOfRange` handled client-side.** Kamino's on-chain
 * program refuses a deposit when the strategy's position has drifted
 * outside its own tick range — this adapter checks
 * `tickLowerIndex <= pool.tickCurrentIndex < tickUpperIndex` itself before
 * building anything, per this codebase's "a clean refusal beats a
 * transaction the chain has to revert" convention.
 *
 * **Withdraw, MAX-only**, same repeated precedent as Curve/Solidly/
 * Uniswap-v2/Raydium CPMM/AMM v4 in this codebase: burns the caller's FULL
 * shares balance and lets the chain compute the proportional `amountA`/
 * `amountB` itself — no client-side ratio math needed, unlike deposit.
 * `Withdraw`'s account list (re-read from the SDK's `withdraw.ts` codegen
 * directly, not from an earlier informal note) needs NONE of what deposit
 * needs — no Scope accounts, no reward accounts at all, so the active-
 * reward gate above applies to deposit only. What it DOES need, each
 * resolved a different way:
 *   - `poolTokenVaultA`/`poolTokenVaultB` (Orca's own pool reserves,
 *     distinct from Kamino's `tokenAVault`/`tokenBVault` buffer) and
 *     `positionTokenAccount` — read straight off the `WhirlpoolStrategy`
 *     account, offsets cross-checked against the SDK's own decoder on a
 *     live account, same as every other field this file reads.
 *   - `treasuryFeeTokenAVault`/`treasuryFeeTokenBVault` — confirmed via the
 *     SDK's own `getTreasuryFeeVaultPDAs` to be plain PDAs,
 *     `["treasury_fee_vault", tokenMint]` under the kliquidity program
 *     itself — NOT an index into `GlobalConfig.treasuryFeeVaults`, contrary
 *     to what an earlier pass here assumed. Deterministic, no live read.
 *   - `poolProgram` — Orca's Whirlpool program id
 *     (`whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc`, read from the SDK's
 *     own `WHIRLPOOL_PROGRAM_ADDRESS` constant), fixed for the
 *     Orca-only scope this adapter targets.
 *   - `eventAuthority` — confirmed via the SDK's own `getEventAuthorityPDA`
 *     that ORCA (and RAYDIUM) strategies pass `None` here, which
 *     Codama's account-meta resolution (`optionalAccountStrategy:
 *     'programId'`) fills with the kliquidity PROGRAM ID itself, not a
 *     PDA — only METEORA strategies need a real derived event authority.
 *     Confirmed by reading `getAccountMetaFactory`'s source directly, not
 *     inferred.
 *   - `memoProgram` — the same pinned `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`
 *     constant `raydiumCpmm.ts` already uses.
 * No Raydium-specific "collect fees before withdraw" prerequisite applies
 * (confirmed in the SDK's `withdrawShares`: that step is gated
 * `if (isRaydium)`, irrelevant to this adapter's Orca-only scope).
 *
 * **One honest gap, not fixed by more code: `Withdraw`'s own instruction
 * data is JUST `sharesAmount` — no `amountAMin`/`amountBMin` at all.** This
 * protocol's own on-chain instruction exposes no slippage floor for a
 * share-burn withdraw (confirmed from the codegen's
 * `WithdrawInstructionDataArgs` directly), so there is nothing for this
 * adapter to enforce beyond what the chain itself guarantees — unlike
 * `raydiumCpmm.ts`'s LP-burn withdraw, which DOES get a `minOutFor`-derived
 * floor because ITS instruction accepts one. A price move between build and
 * confirm can shift how much of each leg a MAX withdraw returns; this is a
 * property of the protocol, not a corner this adapter cut.
 *
 * **Live-verified 2026-08-26**, same USDG-USDC strategy as deposit, against
 * a real wallet found by scanning the shares MINT's own signature history
 * for a nonzero holder (same established trick, applied to the receipt
 * token instead of the underlying asset). A full-balance `Withdraw`
 * (2,082,658,917,057,438 of 3,174,565,904,958,061 total shares) simulated
 * with `err: null` — genuinely clean, not merely "failed later than
 * expected" the way deposit's verification was: the on-chain handler
 * returned `Ok(WithdrawEffects{shares_to_burn, total_a_to_send_to_user,
 * total_b_to_send_to_user, ...})`, actually invoked Orca's Whirlpool
 * program via CPI (`whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc invoke [2]`,
 * disinvesting real liquidity from the live position), and completed three
 * real `TransferChecked` calls sending both tokens back to the wallet's
 * ATAs — full account list, PDA derivations, and the on-chain
 * burn/disinvest/transfer sequence all correct, no simulated error at any
 * step.
 */

import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import { DefiError } from "../errors/defiErrors";
import { maxInFor } from "../slippage";
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
  getTokenAFromLiquidity,
  getTokenBFromLiquidity,
  tickIndexToSqrtPriceX64,
} from "./kaminoLiquidityMath";

const SLUG = "kamino-liquidity";
const CLUSTER = "mainnet-beta" as const;

const KAMINO_LIQUIDITY_PROGRAM_ID = new PublicKey(
  "6LtLpnUFNByNXLyCoK9wA2MykKAmQNZKBdY8s47dehDc",
);

const IX_DEPOSIT = Buffer.from("f223c68952e1f2b6", "hex");
const IX_WITHDRAW = Buffer.from("b712469c946da122", "hex");

// Orca's Whirlpool program (SDK's own `WHIRLPOOL_PROGRAM_ADDRESS` constant)
// — fixed since this adapter targets Orca-backed strategies only.
const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey(
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
);
const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

// Strategy classification the adapter is scoped to (see header). Everything
// else refuses.
const STRATEGY_DEX_ORCA = 0n;
const SHARE_CALC_PROPORTION_BASED = 1;
const STRATEGY_STATUS_ACTIVE = 1n;

// ── WhirlpoolStrategy byte offsets (from the start of the raw account
// data, INCLUDING the 8-byte Anchor discriminator) — see header for
// derivation/verification. ─────────────────────────────────────────────────
const S_GLOBAL_CONFIG = 40;
const S_BASE_VAULT_AUTHORITY = 72;
const S_POOL = 112;
const S_POOL_TOKEN_VAULT_A = 144;
const S_POOL_TOKEN_VAULT_B = 176;
const S_TICK_ARRAY_LOWER = 208;
const S_TICK_ARRAY_UPPER = 240;
const S_POSITION = 272;
const S_POSITION_TOKEN_ACCOUNT = 368;
const S_TOKEN_A_VAULT = 400;
const S_TOKEN_B_VAULT = 432;
const S_TOKEN_A_MINT = 544;
const S_TOKEN_B_MINT = 576;
const S_TOKEN_A_COLLATERAL_ID = 640; // u64
const S_TOKEN_B_COLLATERAL_ID = 648; // u64
const S_SHARES_MINT = 720;
const S_SHARES_MINT_AUTHORITY = 760;
const S_SHARES_ISSUED = 800; // u64
const S_STATUS = 808; // u64
const S_REWARD_0_VAULT = 824;
const S_REWARD_1_VAULT = 880;
const S_REWARD_2_VAULT = 936;
const S_KAMINO_REWARDS_START = 1184; // Array<KaminoRewardInfo>, 3 entries
const S_KAMINO_REWARD_STRIDE = 120;
const S_KAMINO_REWARD_MINT_REL_OFFSET = 40; // rewardMint, within each entry
const S_KAMINO_REWARD_DECIMALS_REL_OFFSET = 0; // decimals (u64), within each entry
const S_STRATEGY_DEX = 1544; // u64
const S_DEPOSIT_BLOCKED = 1624; // u8
const S_SHARE_CALCULATION_METHOD = 1627; // u8
const S_WITHDRAW_BLOCKED = 1628; // u8
const S_TOKEN_A_TOKEN_PROGRAM = 2216;
const S_TOKEN_B_TOKEN_PROGRAM = 2248;

// GlobalConfig — one fixed account per Kamino kliquidity deployment.
const GC_TOKEN_INFOS = 10448;

// CollateralInfos — one fixed account per deployment (GlobalConfig.tokenInfos),
// a flat array of fixed-size entries indexed by collateral id.
const CI_ENTRY_STRIDE = 216;
const CI_SCOPE_FEED_REL_OFFSET = 152;
const CI_ENTRIES_START = 8; // after the 8-byte discriminator

// Orca Whirlpool (pool) account — read-only reference, no adapter-owned copy.
const WP_SQRT_PRICE = 65; // u128
const WP_TICK_CURRENT_INDEX = 81; // i32

// Orca Position account.
const POS_LIQUIDITY = 72; // u128
const POS_TICK_LOWER_INDEX = 88; // i32
const POS_TICK_UPPER_INDEX = 92; // i32

function devWarn(scope: string, err: unknown): void {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn(`[kaminoLiquidity] ${scope}:`, err);
  }
}

function makeConnection(rpcUrl: string | undefined): Connection {
  return new Connection(
    rpcUrl || "https://api.mainnet-beta.solana.com",
    "confirmed",
  );
}

function requireKliquidityTarget(target: DepositTarget | undefined): {
  strategy: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
} {
  if (target?.kind !== "kamino-liquidity-strategy") {
    throw new DefiError(
      "deposit_failed",
      "kamino-liquidity: a resolved strategy target is required",
    );
  }
  return {
    strategy: new PublicKey(target.strategy),
    mintA: new PublicKey(target.mintA),
    mintB: new PublicKey(target.mintB),
  };
}

interface StrategyState {
  globalConfig: PublicKey;
  baseVaultAuthority: PublicKey;
  pool: PublicKey;
  poolTokenVaultA: PublicKey;
  poolTokenVaultB: PublicKey;
  tickArrayLower: PublicKey;
  tickArrayUpper: PublicKey;
  position: PublicKey;
  positionTokenAccount: PublicKey;
  tokenAVault: PublicKey;
  tokenBVault: PublicKey;
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  tokenACollateralId: bigint;
  tokenBCollateralId: bigint;
  sharesMint: PublicKey;
  sharesMintAuthority: PublicKey;
  sharesIssued: bigint;
  status: bigint;
  strategyDex: bigint;
  depositBlocked: number;
  withdrawBlocked: number;
  shareCalculationMethod: number;
  tokenATokenProgram: PublicKey;
  tokenBTokenProgram: PublicKey;
  hasActiveReward: boolean;
}

async function readStrategyState(
  connection: Connection,
  strategy: PublicKey,
): Promise<StrategyState> {
  const info = await connection.getAccountInfo(strategy);
  if (!info) {
    throw new DefiError(
      "network_error",
      "kamino-liquidity: strategy not found",
    );
  }
  const d = info.data;
  if (d.length < S_TOKEN_B_TOKEN_PROGRAM + 32) {
    throw new DefiError(
      "network_error",
      "kamino-liquidity: strategy data too small",
    );
  }
  const pk = (offset: number) => new PublicKey(d.subarray(offset, offset + 32));
  const u64 = (offset: number) => d.readBigUInt64LE(offset);
  const baseVaultAuthority = pk(S_BASE_VAULT_AUTHORITY);
  // An unused reward slot is sentinelled as `baseVaultAuthority`, not the
  // zero pubkey (matches Kamino's own `getAllScopePriceFeedsForStrategy`
  // check: `reward0Vault !== DEFAULT && reward0Vault !== baseVaultAuthority`).
  // Live-verified 2026-08-26: a strategy with an active reward requires an
  // additional Scope price account per active reward, appended as a
  // remaining account (`RewardScopePriceAccountNotPresent` when omitted) —
  // this adapter doesn't build that yet, so any strategy with an active
  // reward (either mechanism: the plain reward0/1/2 slots, or the separate
  // `kaminoRewards` array) is refused rather than guessed at.
  const rewardVaultActive = (offset: number) => {
    const v = pk(offset);
    return !v.equals(PublicKey.default) && !v.equals(baseVaultAuthority);
  };
  let hasKaminoReward = false;
  for (let i = 0; i < 3; i++) {
    const base = S_KAMINO_REWARDS_START + i * S_KAMINO_REWARD_STRIDE;
    const mint = pk(base + S_KAMINO_REWARD_MINT_REL_OFFSET);
    const decimals = d.readBigUInt64LE(
      base + S_KAMINO_REWARD_DECIMALS_REL_OFFSET,
    );
    if (!mint.equals(PublicKey.default) && decimals > 0n)
      hasKaminoReward = true;
  }
  const hasActiveReward =
    rewardVaultActive(S_REWARD_0_VAULT) ||
    rewardVaultActive(S_REWARD_1_VAULT) ||
    rewardVaultActive(S_REWARD_2_VAULT) ||
    hasKaminoReward;
  return {
    globalConfig: pk(S_GLOBAL_CONFIG),
    baseVaultAuthority: pk(S_BASE_VAULT_AUTHORITY),
    pool: pk(S_POOL),
    poolTokenVaultA: pk(S_POOL_TOKEN_VAULT_A),
    poolTokenVaultB: pk(S_POOL_TOKEN_VAULT_B),
    tickArrayLower: pk(S_TICK_ARRAY_LOWER),
    tickArrayUpper: pk(S_TICK_ARRAY_UPPER),
    position: pk(S_POSITION),
    positionTokenAccount: pk(S_POSITION_TOKEN_ACCOUNT),
    tokenAVault: pk(S_TOKEN_A_VAULT),
    tokenBVault: pk(S_TOKEN_B_VAULT),
    tokenAMint: pk(S_TOKEN_A_MINT),
    tokenBMint: pk(S_TOKEN_B_MINT),
    tokenACollateralId: u64(S_TOKEN_A_COLLATERAL_ID),
    tokenBCollateralId: u64(S_TOKEN_B_COLLATERAL_ID),
    sharesMint: pk(S_SHARES_MINT),
    sharesMintAuthority: pk(S_SHARES_MINT_AUTHORITY),
    sharesIssued: u64(S_SHARES_ISSUED),
    status: u64(S_STATUS),
    strategyDex: u64(S_STRATEGY_DEX),
    depositBlocked: d.readUInt8(S_DEPOSIT_BLOCKED),
    withdrawBlocked: d.readUInt8(S_WITHDRAW_BLOCKED),
    shareCalculationMethod: d.readUInt8(S_SHARE_CALCULATION_METHOD),
    tokenATokenProgram: pk(S_TOKEN_A_TOKEN_PROGRAM),
    tokenBTokenProgram: pk(S_TOKEN_B_TOKEN_PROGRAM),
    hasActiveReward,
  };
}

/** Gates shared by deposit AND withdraw. */
function assertStrategyUsable(s: StrategyState): void {
  if (s.status !== STRATEGY_STATUS_ACTIVE) {
    throw new DefiError(
      "strategy_paused",
      "kamino-liquidity: this vault isn't active right now",
    );
  }
  if (s.strategyDex !== STRATEGY_DEX_ORCA) {
    throw new DefiError(
      "unsupported_asset",
      "kamino-liquidity: this vault isn't supported yet",
    );
  }
  if (s.shareCalculationMethod !== SHARE_CALC_PROPORTION_BASED) {
    throw new DefiError(
      "unsupported_asset",
      "kamino-liquidity: this vault isn't supported yet",
    );
  }
}

/**
 * Deposit-only gate: `Withdraw`'s account list needs no Scope accounts at
 * all (confirmed from the SDK's own `withdraw.ts` codegen), so an active
 * reward only blocks DEPOSIT — see header.
 */
function assertDepositSupported(s: StrategyState): void {
  assertStrategyUsable(s);
  if (s.depositBlocked !== 0) {
    throw new DefiError(
      "strategy_paused",
      "kamino-liquidity: deposits are paused for this vault",
    );
  }
  if (s.hasActiveReward) {
    throw new DefiError(
      "unsupported_asset",
      "kamino-liquidity: this vault isn't supported yet",
    );
  }
}

function assertWithdrawSupported(s: StrategyState): void {
  assertStrategyUsable(s);
  if (s.withdrawBlocked !== 0) {
    throw new DefiError(
      "strategy_paused",
      "kamino-liquidity: withdrawals are paused for this vault",
    );
  }
}

interface PoolState {
  sqrtPrice: bigint;
  tickCurrentIndex: number;
}

async function readPoolState(
  connection: Connection,
  pool: PublicKey,
): Promise<PoolState> {
  const info = await connection.getAccountInfo(pool);
  if (!info) {
    throw new DefiError("network_error", "kamino-liquidity: pool not found");
  }
  const d = info.data;
  const sqrtPrice =
    d.readBigUInt64LE(WP_SQRT_PRICE) |
    (d.readBigUInt64LE(WP_SQRT_PRICE + 8) << 64n);
  return {
    sqrtPrice,
    tickCurrentIndex: d.readInt32LE(WP_TICK_CURRENT_INDEX),
  };
}

interface OrcaPositionState {
  liquidity: bigint;
  tickLowerIndex: number;
  tickUpperIndex: number;
}

async function readOrcaPositionState(
  connection: Connection,
  position: PublicKey,
): Promise<OrcaPositionState> {
  const info = await connection.getAccountInfo(position);
  if (!info) {
    throw new DefiError(
      "network_error",
      "kamino-liquidity: position not found",
    );
  }
  const d = info.data;
  const liquidity =
    d.readBigUInt64LE(POS_LIQUIDITY) |
    (d.readBigUInt64LE(POS_LIQUIDITY + 8) << 64n);
  return {
    liquidity,
    tickLowerIndex: d.readInt32LE(POS_TICK_LOWER_INDEX),
    tickUpperIndex: d.readInt32LE(POS_TICK_UPPER_INDEX),
  };
}

async function readScopeFeed(
  connection: Connection,
  globalConfig: PublicKey,
  tokenACollateralId: bigint,
  tokenBCollateralId: bigint,
): Promise<{
  tokenInfos: PublicKey;
  scopeFeedA: PublicKey;
  scopeFeedB: PublicKey;
}> {
  const gcInfo = await connection.getAccountInfo(globalConfig);
  if (!gcInfo) {
    throw new DefiError(
      "network_error",
      "kamino-liquidity: global config not found",
    );
  }
  const tokenInfos = new PublicKey(
    gcInfo.data.subarray(GC_TOKEN_INFOS, GC_TOKEN_INFOS + 32),
  );
  const ciInfo = await connection.getAccountInfo(tokenInfos);
  if (!ciInfo) {
    throw new DefiError(
      "network_error",
      "kamino-liquidity: collateral info table not found",
    );
  }
  const feedFor = (collateralId: bigint) => {
    const offset =
      CI_ENTRIES_START +
      Number(collateralId) * CI_ENTRY_STRIDE +
      CI_SCOPE_FEED_REL_OFFSET;
    return new PublicKey(ciInfo.data.subarray(offset, offset + 32));
  };
  return {
    tokenInfos,
    scopeFeedA: feedFor(tokenACollateralId),
    scopeFeedB: feedFor(tokenBCollateralId),
  };
}

async function buildKliquidityDeposit(
  connection: Connection,
  owner: PublicKey,
  target: { strategy: PublicKey; mintA: PublicKey; mintB: PublicKey },
  asset: { contract?: string },
  amount: bigint,
  tier: BuildDepositArgs["tier"],
): Promise<UnsignedCall> {
  const { strategy, mintA, mintB } = target;
  const s = await readStrategyState(connection, strategy);
  if (!s.tokenAMint.equals(mintA) || !s.tokenBMint.equals(mintB)) {
    throw new DefiError(
      "deposit_failed",
      "kamino-liquidity: strategy's on-chain mints do not match the resolved target",
    );
  }
  assertDepositSupported(s);

  const [pool, position] = await Promise.all([
    readPoolState(connection, s.pool),
    readOrcaPositionState(connection, s.position),
  ]);
  if (
    pool.tickCurrentIndex < position.tickLowerIndex ||
    pool.tickCurrentIndex >= position.tickUpperIndex
  ) {
    throw new DefiError(
      "deposit_failed",
      "kamino-liquidity: this vault's position is out of range, deposits are paused",
    );
  }

  const sqrtPriceLower = tickIndexToSqrtPriceX64(position.tickLowerIndex);
  const sqrtPriceUpper = tickIndexToSqrtPriceX64(position.tickUpperIndex);
  const tokenAHoldings = getTokenAFromLiquidity(
    position.liquidity,
    pool.sqrtPrice,
    sqrtPriceUpper,
    false,
  );
  const tokenBHoldings = getTokenBFromLiquidity(
    position.liquidity,
    sqrtPriceLower,
    pool.sqrtPrice,
    false,
  );
  if (tokenAHoldings <= 0n || tokenBHoldings <= 0n) {
    throw new DefiError(
      "protocol_not_found",
      "kamino-liquidity: vault has no two-sided liquidity to price the pair against",
    );
  }

  const supplied = asset.contract ?? "";
  const suppliedIsA = supplied === mintA.toBase58();
  const suppliedIsB = supplied === mintB.toBase58();
  if (!suppliedIsA && !suppliedIsB) {
    throw new DefiError(
      "unsupported_asset",
      "kamino-liquidity: asset is not one of the vault's tokens",
    );
  }
  const [holdingsThis, holdingsOther] = suppliedIsA
    ? [tokenAHoldings, tokenBHoldings]
    : [tokenBHoldings, tokenAHoldings];
  const amountOther = (amount * holdingsOther) / holdingsThis;
  if (amountOther <= 0n) {
    throw new DefiError(
      "below_min_deposit",
      "kamino-liquidity: amount is too small to pair",
    );
  }

  const amountMaxThis = maxInFor(amount, { tier, stable: false });
  const amountMaxOther = maxInFor(amountOther, { tier, stable: false });
  const [amountMaxA, amountMaxB] = suppliedIsA
    ? [amountMaxThis, amountMaxOther]
    : [amountMaxOther, amountMaxThis];

  const { tokenInfos, scopeFeedA, scopeFeedB } = await readScopeFeed(
    connection,
    s.globalConfig,
    s.tokenACollateralId,
    s.tokenBCollateralId,
  );

  const tokenAAta = getAssociatedTokenAddressSync(
    mintA,
    owner,
    false,
    s.tokenATokenProgram,
  );
  const tokenBAta = getAssociatedTokenAddressSync(
    mintB,
    owner,
    false,
    s.tokenBTokenProgram,
  );
  const userSharesAta = getAssociatedTokenAddressSync(
    s.sharesMint,
    owner,
    false,
    TOKEN_PROGRAM_ID,
  );
  const createSharesAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    owner,
    userSharesAta,
    owner,
    s.sharesMint,
    TOKEN_PROGRAM_ID,
  );

  const data = Buffer.alloc(24);
  IX_DEPOSIT.copy(data, 0);
  data.writeBigUInt64LE(amountMaxA, 8);
  data.writeBigUInt64LE(amountMaxB, 16);

  const depositIx = new TransactionInstruction({
    programId: KAMINO_LIQUIDITY_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: strategy, isSigner: false, isWritable: true },
      { pubkey: s.globalConfig, isSigner: false, isWritable: false },
      { pubkey: s.pool, isSigner: false, isWritable: false },
      { pubkey: s.position, isSigner: false, isWritable: false },
      { pubkey: s.tickArrayLower, isSigner: false, isWritable: false },
      { pubkey: s.tickArrayUpper, isSigner: false, isWritable: false },
      { pubkey: s.tokenAVault, isSigner: false, isWritable: true },
      { pubkey: s.tokenBVault, isSigner: false, isWritable: true },
      { pubkey: s.baseVaultAuthority, isSigner: false, isWritable: false },
      { pubkey: tokenAAta, isSigner: false, isWritable: true },
      { pubkey: tokenBAta, isSigner: false, isWritable: true },
      { pubkey: mintA, isSigner: false, isWritable: false },
      { pubkey: mintB, isSigner: false, isWritable: false },
      { pubkey: userSharesAta, isSigner: false, isWritable: true },
      { pubkey: s.sharesMint, isSigner: false, isWritable: true },
      { pubkey: s.sharesMintAuthority, isSigner: false, isWritable: false },
      { pubkey: scopeFeedA, isSigner: false, isWritable: false },
      { pubkey: scopeFeedB, isSigner: false, isWritable: false },
      { pubkey: tokenInfos, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // shares token program
      { pubkey: s.tokenATokenProgram, isSigner: false, isWritable: false },
      { pubkey: s.tokenBTokenProgram, isSigner: false, isWritable: false },
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
    ],
    data,
  });

  return {
    kind: "solana-ix",
    instructions: [createSharesAtaIx, depositIx],
  };
}

/**
 * PDAs confirmed via the SDK's own `getTreasuryFeeVaultPDAs` — see header.
 */
function treasuryFeeVaultPda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury_fee_vault"), mint.toBuffer()],
    KAMINO_LIQUIDITY_PROGRAM_ID,
  );
  return pda;
}

async function buildKliquidityWithdraw(
  connection: Connection,
  owner: PublicKey,
  target: { strategy: PublicKey; mintA: PublicKey; mintB: PublicKey },
  amount: bigint | "MAX",
): Promise<UnsignedCall> {
  if (amount !== "MAX") {
    throw new DefiError(
      "withdraw_failed",
      "kamino-liquidity: partial withdraw needs a shares amount, use MAX for a full exit",
    );
  }
  const { strategy, mintA, mintB } = target;
  const s = await readStrategyState(connection, strategy);
  if (!s.tokenAMint.equals(mintA) || !s.tokenBMint.equals(mintB)) {
    throw new DefiError(
      "deposit_failed",
      "kamino-liquidity: strategy's on-chain mints do not match the resolved target",
    );
  }
  assertWithdrawSupported(s);

  const userSharesAta = getAssociatedTokenAddressSync(
    s.sharesMint,
    owner,
    false,
    TOKEN_PROGRAM_ID,
  );
  const sharesAmount = await connection
    .getTokenAccountBalance(userSharesAta)
    .then((r) => BigInt(r.value.amount))
    .catch(() => 0n);
  if (sharesAmount <= 0n) {
    throw new DefiError("position_not_found", "kamino-liquidity: no position");
  }

  const tokenAAta = getAssociatedTokenAddressSync(
    mintA,
    owner,
    false,
    s.tokenATokenProgram,
  );
  const tokenBAta = getAssociatedTokenAddressSync(
    mintB,
    owner,
    false,
    s.tokenBTokenProgram,
  );
  const createAtaIxs = [
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      tokenAAta,
      owner,
      mintA,
      s.tokenATokenProgram,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      tokenBAta,
      owner,
      mintB,
      s.tokenBTokenProgram,
    ),
  ];

  const treasuryFeeTokenAVault = treasuryFeeVaultPda(mintA);
  const treasuryFeeTokenBVault = treasuryFeeVaultPda(mintB);

  const data = Buffer.alloc(16);
  IX_WITHDRAW.copy(data, 0);
  data.writeBigUInt64LE(sharesAmount, 8);

  const withdrawIx = new TransactionInstruction({
    programId: KAMINO_LIQUIDITY_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: strategy, isSigner: false, isWritable: true },
      { pubkey: s.globalConfig, isSigner: false, isWritable: false },
      { pubkey: s.pool, isSigner: false, isWritable: true },
      { pubkey: s.position, isSigner: false, isWritable: true },
      { pubkey: s.tickArrayLower, isSigner: false, isWritable: true },
      { pubkey: s.tickArrayUpper, isSigner: false, isWritable: true },
      { pubkey: s.tokenAVault, isSigner: false, isWritable: true },
      { pubkey: s.tokenBVault, isSigner: false, isWritable: true },
      { pubkey: s.baseVaultAuthority, isSigner: false, isWritable: false },
      { pubkey: s.poolTokenVaultA, isSigner: false, isWritable: true },
      { pubkey: s.poolTokenVaultB, isSigner: false, isWritable: true },
      { pubkey: tokenAAta, isSigner: false, isWritable: true },
      { pubkey: tokenBAta, isSigner: false, isWritable: true },
      { pubkey: mintA, isSigner: false, isWritable: false },
      { pubkey: mintB, isSigner: false, isWritable: false },
      { pubkey: userSharesAta, isSigner: false, isWritable: true },
      { pubkey: s.sharesMint, isSigner: false, isWritable: true },
      { pubkey: treasuryFeeTokenAVault, isSigner: false, isWritable: true },
      { pubkey: treasuryFeeTokenBVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // tokenProgram (shares mint's program — always legacy SPL Token per readStrategyState's sharesMint ATA derivation)
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // tokenProgram2022 — pinned constant, exactly what the SDK's own withdrawShares() passes unconditionally
      { pubkey: s.tokenATokenProgram, isSigner: false, isWritable: false },
      { pubkey: s.tokenBTokenProgram, isSigner: false, isWritable: false },
      { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: s.positionTokenAccount, isSigner: false, isWritable: true },
      { pubkey: ORCA_WHIRLPOOL_PROGRAM_ID, isSigner: false, isWritable: false },
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
      // `eventAuthority` — omitted for ORCA strategies. Codama resolves an
      // omitted optional account to the PROGRAM's own address (see header:
      // `getAccountMetaFactory(programAddress, 'programId')`), so this is
      // that same self-reference made explicit rather than left to a
      // default this adapter doesn't control.
      {
        pubkey: KAMINO_LIQUIDITY_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
    ],
    data,
  });

  return {
    kind: "solana-ix",
    instructions: [...createAtaIxs, withdrawIx],
  };
}

async function readKliquidityPosition(
  walletAddress: string,
  target: DepositTarget & { kind: "kamino-liquidity-strategy" },
): Promise<DefiPosition | null> {
  const connection = makeConnection(undefined);
  const strategy = new PublicKey(target.strategy);
  const owner = new PublicKey(walletAddress);

  const s = await readStrategyState(connection, strategy);
  const userSharesAta = getAssociatedTokenAddressSync(
    s.sharesMint,
    owner,
    false,
    TOKEN_PROGRAM_ID,
  );
  const sharesBalance = await connection
    .getTokenAccountBalance(userSharesAta)
    .then((r) => BigInt(r.value.amount))
    .catch(() => 0n);
  if (sharesBalance <= 0n) return null;

  return {
    protocolSlug: SLUG,
    namespace: "solana",
    chainId: CLUSTER,
    assetSymbol: target.mintA,
    amountAtDeposit: 0n,
    amountAtDepositUsd: 0,
    // Shares, not underlying — same convention as raydiumCpmm.ts's LP
    // units: a two-sided position's value in one leg is path-dependent,
    // priced upstream where both reserves and a USD rate are available.
    currentAmount: sharesBalance,
    currentAmountUsd: 0,
    pnlUsd: 0,
  };
}

export const KaminoLiquidityAdapter: DefiProtocolAdapter = {
  slug: SLUG,
  namespace: "solana",
  kind: "lp_volatile",
  chainId: CLUSTER,
  displayName: "Kamino Liquidity",
  staticSafetyScore: 60,
  // Deliberately no `externalSlugs` — kind-routed only, same precaution as
  // every other recent Solana adapter in this file (see kaminoKvault.ts's
  // header for the bug class this avoids).
  targetKinds: ["kamino-liquidity-strategy"],

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
        "kamino-liquidity: requires solana namespace",
      );
    }
    const t = requireKliquidityTarget(target);
    const connection = makeConnection(chain.rpcUrl);
    const owner = new PublicKey(wallet.address);
    return buildKliquidityDeposit(connection, owner, t, asset, amount, tier);
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
        "kamino-liquidity: requires solana namespace",
      );
    }
    const t = requireKliquidityTarget(target);
    const connection = makeConnection(chain.rpcUrl);
    const owner = new PublicKey(wallet.address);
    return buildKliquidityWithdraw(connection, owner, t, amount);
  },

  async readPosition(
    walletAddress: string,
    ctx?: PositionReadContext,
  ): Promise<DefiPosition | null> {
    if (ctx?.target?.kind !== "kamino-liquidity-strategy") return null;
    try {
      return await readKliquidityPosition(
        walletAddress,
        ctx.target as DepositTarget & { kind: "kamino-liquidity-strategy" },
      );
    } catch (err) {
      devWarn("readPosition", err);
      return null;
    }
  },
};
