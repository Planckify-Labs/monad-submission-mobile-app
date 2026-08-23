/**
 * Kamino Lend adapter — ONE `DefiProtocolAdapter` covering every Kamino
 * lending-market reserve, dispatched by `DepositTarget.kind ===
 * "solana-reserve"` (`{program, reserve, mint}` — the mobile twin of the API
 * `kamino-lend.resolver.ts`, which resolves a DeFiLlama `kamino-lend` pool to
 * a specific `reserve` pubkey by joining on market name + underlying mint).
 *
 * No SDK dependency (deliberate — see the session's scope discussion):
 * `@kamino-finance/klend-sdk` pulls in `@coral-xyz/anchor` plus 4 more Kamino
 * sub-packages (~13.6MB, 20 deps), a bundle/frozen-prototype-risk (`docs/
 * prototype-freeze-crash-retrospective.md`) this integration doesn't need.
 * Every instruction here is hand-built from Kamino's PUBLISHED IDL/SDK
 * source (read as documentation, never imported), verified 2026-08-23:
 *
 *   - Program id (`KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`) confirmed
 *     live: it is the `owner` of every Reserve/Obligation account decoded
 *     below, matching the SDK's own `programId.ts`.
 *   - All 6 instruction discriminators (`refresh_reserve`,
 *     `refresh_obligation`, `init_obligation`, `init_user_metadata`,
 *     `deposit_reserve_liquidity_and_obligation_collateral`,
 *     `withdraw_obligation_collateral_and_redeem_reserve_collateral`) were
 *     independently computed as `sha256("global:<snake_case_name>")[0..8]`
 *     AND cross-checked byte-for-byte against the SDK's own hardcoded
 *     `DISCRIMINATOR` constants in `src/@codegen/klend/instructions/*.ts` —
 *     all 6 matched exactly.
 *   - Every account/PDA below (`lendingMarketAuthority`, the reserve's
 *     liquidity/collateral PDAs, `userMetadata`, the Vanilla `obligation`
 *     PDA) was transcribed from the SDK's `utils/seeds.ts` /
 *     `utils/ObligationType.ts` seed constants — no guessing.
 *   - The `Reserve`/`Obligation` account BYTE OFFSETS used below were not
 *     hand-computed: the SDK's own `borsh.struct([...])` layouts (from
 *     `src/@codegen/klend/{accounts,types}/*.ts`) were reconstructed in a
 *     throwaway script (using only `@coral-xyz/borsh`, never installed into
 *     this app) and used to `.decode()` REAL mainnet Reserve/Obligation
 *     accounts, then the resulting cumulative offsets were read off that
 *     decode and transcribed here as constants. Three independent
 *     cross-checks confirmed them: (1) the decoded `lendingMarket` on a
 *     "SOL/BTC Market" reserve matched that market's own published
 *     `lendingMarket` address from `api.kamino.finance`; (2) `liquidity`
 *     offset 128 and `totalAvailableAmount` offset 224 both match
 *     DeFiLlama's own independently-authored `yield-server` adaptor
 *     constants (`LIQUIDITY_OFFSET = 128`, `+ 96`) exactly, as does
 *     `config.status` at offset 4856 (`CONFIG_OFFSET = 4856`); (3) decoding
 *     several live Obligation accounts (via `getProgramAccounts` filtered on
 *     the Obligation discriminator) showed plausible, self-consistent
 *     `deposits[].depositReserve` addresses that matched real reserve
 *     addresses from the same market (e.g. a bSOL deposit + SOL borrow on
 *     one obligation, both resolving to reserves this same script had
 *     already decoded independently).
 *
 * **Scope, deliberately limited (fail closed, not guessed):** this adapter
 * only supports a wallet whose Kamino obligation (per lending market) holds
 * AT MOST the one reserve being deposited into/withdrawn from, and carries
 * no debt. `refreshObligation`'s `remaining_accounts` must list every OTHER
 * reserve the obligation already touches (confirmed by reading the SDK's own
 * `addRefreshObligationIx` — it passes `[...kaminoObligation.deposits.keys()]`
 * verbatim), and correctly enumerating + refreshing an arbitrary set of a
 * user's pre-existing cross-reserve/borrow positions is a materially bigger
 * (and higher-blast-radius-if-wrong) problem than this pass covers. A wallet
 * with other Kamino positions gets a clean refusal here, never a guessed
 * remaining-accounts list. This app doesn't build a borrow flow at all, so
 * `hasDebt` should never legitimately be set for a position this adapter
 * created — the check only fires for a wallet that used Kamino outside this
 * app.
 *
 * **No Address Lookup Table.** Kamino's own client always pairs a brand-new
 * user's `initUserMetadata` with creating a fresh on-chain LUT and passing
 * its address as `userLookupTable`. That field is pure client-side
 * tx-compression bookkeeping — it does not appear in ANY other instruction's
 * account list, so nothing here ever reads it back — so this adapter passes
 * `SystemProgram.programId` as a placeholder instead of paying rent for a
 * LUT this app has no other use for.
 *
 * **Farm rewards are not claimed.** Kamino's current SDK marks the plain
 * `depositReserveLiquidityAndObligationCollateral` `@deprecated -- use
 * addDepositIxV2 instead` because V2 also registers the deposit with the
 * reserve's farm (if any) for bonus token emissions. The on-chain program
 * still accepts the plain instruction (multiple current SDK call sites use
 * it), and skipping farm registration only forgoes bonus emissions on
 * reserves that have them — the core supply position and its interest
 * accrual are unaffected. Wiring farms (`initObligationFarmsForReserve`,
 * per-reserve farm-state discovery) is future work, not a fund-safety gap.
 */

import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
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

const SLUG = "kamino-lend";
const CLUSTER = "mainnet-beta" as const;

// Sysvar1nstructions1111111111111111111111111 — not exported by web3.js.
const SYSVAR_INSTRUCTIONS_PUBKEY = new PublicKey(
  "Sysvar1nstructions1111111111111111111111111",
);

const SEED_LENDING_MARKET_AUTH = Buffer.from("lma");
const SEED_RESERVE_LIQ_SUPPLY = Buffer.from("reserve_liq_supply");
const SEED_RESERVE_COLL_MINT = Buffer.from("reserve_coll_mint");
const SEED_RESERVE_COLL_SUPPLY = Buffer.from("reserve_coll_supply");
const SEED_USER_METADATA = Buffer.from("user_meta");

// Anchor global-instruction discriminators — sha256("global:<name>")[0..8],
// verified against the SDK's own hardcoded values (see header).
const IX_REFRESH_RESERVE = Buffer.from("02da8aeb4fc91966", "hex");
const IX_REFRESH_OBLIGATION = Buffer.from("218493e497c04859", "hex");
const IX_INIT_OBLIGATION = Buffer.from("fb0ae74c1b0b9f60", "hex");
const IX_INIT_USER_METADATA = Buffer.from("75a9b045c5170fa2", "hex");
const IX_DEPOSIT = Buffer.from("81c70402de271a2e", "hex");
const IX_WITHDRAW = Buffer.from("4b5d5ddc2296dac4", "hex");

// ── Reserve account byte offsets (from the start of the raw account data,
// i.e. INCLUDING the 8-byte Anchor discriminator) — see header for how these
// were derived and cross-checked. ──────────────────────────────────────────
const R_LENDING_MARKET = 32;
const R_LIQUIDITY_MINT = 128;
const R_LIQUIDITY_TOTAL_AVAILABLE = 224; // u64
const R_LIQUIDITY_BORROWED_SF = 232; // u128, Fraction (2^60) scale
const R_LIQUIDITY_ACCUM_PROTOCOL_FEES_SF = 344; // u128
const R_LIQUIDITY_ACCUM_REFERRER_FEES_SF = 360; // u128
const R_LIQUIDITY_PENDING_REFERRER_FEES_SF = 376; // u128
const R_LIQUIDITY_TOKEN_PROGRAM = 408;
const R_COLLATERAL_MINT_TOTAL_SUPPLY = 2592; // u64
const R_CONFIG_STATUS = 4856; // u8, 0 = Active
const R_CONFIG_SCOPE_PRICE_FEED = 5112;
const R_CONFIG_SWITCHBOARD_PRICE_AGGREGATOR = 5160;
const R_CONFIG_SWITCHBOARD_TWAP_AGGREGATOR = 5192;
const R_CONFIG_PYTH_PRICE = 5224;
const FRACTION_SF = 1n << 60n; // Kamino's `Fraction::FRACTIONS`

// ── Obligation account byte offsets (VanillaObligation only). ─────────────
const O_LENDING_MARKET = 32;
const O_OWNER = 64;
const O_DEPOSITS_START = 96;
const O_DEPOSIT_SLOT_SIZE = 136;
const O_DEPOSIT_SLOTS = 8;
const O_HAS_DEBT = 2287; // u8

function devWarn(scope: string, err: unknown): void {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn(`[kaminoLend] ${scope}:`, err);
  }
}

function makeConnection(rpcUrl: string | undefined): Connection {
  return new Connection(
    rpcUrl || "https://api.mainnet-beta.solana.com",
    "confirmed",
  );
}

function requireReserveTarget(target: DepositTarget | undefined): {
  program: PublicKey;
  reserve: PublicKey;
  mint: PublicKey;
} {
  if (target?.kind !== "solana-reserve") {
    throw new DefiError(
      "deposit_failed",
      "kamino: a resolved reserve target is required",
    );
  }
  return {
    program: new PublicKey(target.program),
    reserve: new PublicKey(target.reserve),
    mint: new PublicKey(target.mint),
  };
}

function isDefaultPubkey(pk: PublicKey): boolean {
  return pk.equals(SystemProgram.programId);
}

/** `isSome(...) ? real : programId` — mirrors the SDK's Option-None convention. */
function optionalAccount(pk: PublicKey, programId: PublicKey): PublicKey {
  return isDefaultPubkey(pk) ? programId : pk;
}

interface ReserveState {
  lendingMarket: PublicKey;
  liquidityMint: PublicKey;
  liquidityTokenProgram: PublicKey;
  totalAvailableAmount: bigint;
  borrowedSf: bigint;
  accumProtocolFeesSf: bigint;
  accumReferrerFeesSf: bigint;
  pendingReferrerFeesSf: bigint;
  collateralMintTotalSupply: bigint;
  statusActive: boolean;
  pythOracle: PublicKey;
  switchboardPriceOracle: PublicKey;
  switchboardTwapOracle: PublicKey;
  scopePrices: PublicKey;
}

async function readReserveState(
  connection: Connection,
  reserve: PublicKey,
): Promise<ReserveState> {
  const info = await connection.getAccountInfo(reserve);
  if (!info) {
    throw new DefiError("network_error", "kamino: reserve not found");
  }
  const d = info.data;
  if (d.length < R_CONFIG_PYTH_PRICE + 32) {
    throw new DefiError("network_error", "kamino: reserve data too small");
  }
  const pk = (offset: number) => new PublicKey(d.subarray(offset, offset + 32));
  const u64 = (offset: number) => d.readBigUInt64LE(offset);
  const u128 = (offset: number) =>
    d.readBigUInt64LE(offset) | (d.readBigUInt64LE(offset + 8) << 64n);
  return {
    lendingMarket: pk(R_LENDING_MARKET),
    liquidityMint: pk(R_LIQUIDITY_MINT),
    liquidityTokenProgram: pk(R_LIQUIDITY_TOKEN_PROGRAM),
    totalAvailableAmount: u64(R_LIQUIDITY_TOTAL_AVAILABLE),
    borrowedSf: u128(R_LIQUIDITY_BORROWED_SF),
    accumProtocolFeesSf: u128(R_LIQUIDITY_ACCUM_PROTOCOL_FEES_SF),
    accumReferrerFeesSf: u128(R_LIQUIDITY_ACCUM_REFERRER_FEES_SF),
    pendingReferrerFeesSf: u128(R_LIQUIDITY_PENDING_REFERRER_FEES_SF),
    collateralMintTotalSupply: u64(R_COLLATERAL_MINT_TOTAL_SUPPLY),
    statusActive: d.readUInt8(R_CONFIG_STATUS) === 0,
    pythOracle: pk(R_CONFIG_PYTH_PRICE),
    switchboardPriceOracle: pk(R_CONFIG_SWITCHBOARD_PRICE_AGGREGATOR),
    switchboardTwapOracle: pk(R_CONFIG_SWITCHBOARD_TWAP_AGGREGATOR),
    scopePrices: pk(R_CONFIG_SCOPE_PRICE_FEED),
  };
}

/**
 * `mintTotalSupply / totalSupply`, kept at Fraction (2^60) scale throughout
 * so `ctokens = liquidity * mintTotalSupply * 2^60 / totalSupplySf` never
 * loses precision to an intermediate division — mirrors
 * `KaminoReserve.getTotalSupplySf()` / `getCollateralExchangeRate()` exactly.
 */
function totalSupplySf(r: ReserveState): bigint {
  return (
    r.totalAvailableAmount * FRACTION_SF +
    r.borrowedSf -
    r.accumProtocolFeesSf -
    r.accumReferrerFeesSf -
    r.pendingReferrerFeesSf
  );
}

function liquidityToCTokens(liquidity: bigint, r: ReserveState): bigint {
  const supplySf = totalSupplySf(r);
  if (supplySf <= 0n || r.collateralMintTotalSupply <= 0n) return liquidity; // 1:1 initial rate
  return (liquidity * r.collateralMintTotalSupply * FRACTION_SF) / supplySf;
}

function cTokensToLiquidity(ctokens: bigint, r: ReserveState): bigint {
  const supplySf = totalSupplySf(r);
  if (supplySf <= 0n || r.collateralMintTotalSupply <= 0n) return ctokens;
  return (ctokens * supplySf) / (r.collateralMintTotalSupply * FRACTION_SF);
}

interface ObligationDeposit {
  reserve: PublicKey;
  depositedAmount: bigint;
}

interface ObligationState {
  lendingMarket: PublicKey;
  owner: PublicKey;
  deposits: ObligationDeposit[]; // active slots only
  hasDebt: boolean;
}

function vanillaObligationPda(
  program: PublicKey,
  owner: PublicKey,
  lendingMarket: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from([0]), // tag: Vanilla
      Buffer.from([0]), // id
      owner.toBuffer(),
      lendingMarket.toBuffer(),
      SystemProgram.programId.toBuffer(), // seed1 (unused for Vanilla)
      SystemProgram.programId.toBuffer(), // seed2 (unused for Vanilla)
    ],
    program,
  );
  return pda;
}

async function readObligationState(
  connection: Connection,
  obligation: PublicKey,
): Promise<ObligationState | null> {
  const info = await connection.getAccountInfo(obligation);
  if (!info) return null;
  const d = info.data;
  if (d.length < O_HAS_DEBT + 1) return null;
  const deposits: ObligationDeposit[] = [];
  for (let i = 0; i < O_DEPOSIT_SLOTS; i++) {
    const base = O_DEPOSITS_START + i * O_DEPOSIT_SLOT_SIZE;
    const reservePk = new PublicKey(d.subarray(base, base + 32));
    if (isDefaultPubkey(reservePk)) continue;
    deposits.push({
      reserve: reservePk,
      depositedAmount: d.readBigUInt64LE(base + 32),
    });
  }
  return {
    lendingMarket: new PublicKey(
      d.subarray(O_LENDING_MARKET, O_LENDING_MARKET + 32),
    ),
    owner: new PublicKey(d.subarray(O_OWNER, O_OWNER + 32)),
    deposits,
    hasDebt: d.readUInt8(O_HAS_DEBT) !== 0,
  };
}

/**
 * Refuses (rather than guesses `refreshObligation`'s remaining-accounts list)
 * for a wallet whose obligation already touches a reserve other than the one
 * being acted on, or carries debt — see the header's scope note.
 */
function assertSingleReserveScope(
  obligation: ObligationState | null,
  reserve: PublicKey,
): void {
  if (!obligation) return;
  if (obligation.hasDebt) {
    throw new DefiError(
      "deposit_failed",
      "kamino: this wallet has an existing borrow position we don't support",
    );
  }
  const otherReserve = obligation.deposits.find(
    (dep) => !dep.reserve.equals(reserve),
  );
  if (otherReserve) {
    throw new DefiError(
      "deposit_failed",
      "kamino: this wallet already has another Kamino position we don't support yet",
    );
  }
}

async function buildRefreshIxs(
  programId: PublicKey,
  reserve: PublicKey,
  reserveState: ReserveState,
  obligation: PublicKey,
  obligationState: ObligationState | null,
): Promise<TransactionInstruction[]> {
  const refreshReserveIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: reserve, isSigner: false, isWritable: true },
      {
        pubkey: reserveState.lendingMarket,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: optionalAccount(reserveState.pythOracle, programId),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: optionalAccount(reserveState.switchboardPriceOracle, programId),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: optionalAccount(reserveState.switchboardTwapOracle, programId),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: optionalAccount(reserveState.scopePrices, programId),
        isSigner: false,
        isWritable: false,
      },
    ],
    data: IX_REFRESH_RESERVE,
  });

  // remaining_accounts = the obligation's OWN pre-existing deposit reserves
  // (writable), matching the SDK's `addRefreshObligationIx` verbatim. Under
  // `assertSingleReserveScope` this is either [] (brand-new obligation) or
  // exactly [reserve] (a repeat deposit into the same reserve).
  const remainingAccounts = (obligationState?.deposits ?? []).map((dep) => ({
    pubkey: dep.reserve,
    isSigner: false,
    isWritable: true,
  }));
  const refreshObligationIx = new TransactionInstruction({
    programId,
    keys: [
      {
        pubkey: reserveState.lendingMarket,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: obligation, isSigner: false, isWritable: true },
      ...remainingAccounts,
    ],
    data: IX_REFRESH_OBLIGATION,
  });

  return [refreshReserveIx, refreshObligationIx];
}

async function buildKaminoDeposit(
  connection: Connection,
  fromPubkey: PublicKey,
  target: { program: PublicKey; reserve: PublicKey; mint: PublicKey },
  amount: bigint,
): Promise<UnsignedCall> {
  const { program, reserve, mint } = target;
  const reserveState = await readReserveState(connection, reserve);
  if (!reserveState.liquidityMint.equals(mint)) {
    throw new DefiError(
      "deposit_failed",
      "kamino: reserve's on-chain mint does not match the resolved target",
    );
  }
  if (!reserveState.statusActive) {
    throw new DefiError("deposit_failed", "kamino: reserve is not active");
  }

  const lendingMarket = reserveState.lendingMarket;
  const obligation = vanillaObligationPda(program, fromPubkey, lendingMarket);
  const userMetadata = PublicKey.findProgramAddressSync(
    [SEED_USER_METADATA, fromPubkey.toBuffer()],
    program,
  )[0];
  const [
    lendingMarketAuthority,
    reserveLiquiditySupply,
    reserveCollateralMint,
    reserveCollateralSupply,
  ] = [
    PublicKey.findProgramAddressSync(
      [SEED_LENDING_MARKET_AUTH, lendingMarket.toBuffer()],
      program,
    )[0],
    PublicKey.findProgramAddressSync(
      [SEED_RESERVE_LIQ_SUPPLY, reserve.toBuffer()],
      program,
    )[0],
    PublicKey.findProgramAddressSync(
      [SEED_RESERVE_COLL_MINT, reserve.toBuffer()],
      program,
    )[0],
    PublicKey.findProgramAddressSync(
      [SEED_RESERVE_COLL_SUPPLY, reserve.toBuffer()],
      program,
    )[0],
  ];

  const [userMetadataInfo, obligationState] = await Promise.all([
    connection.getAccountInfo(userMetadata),
    readObligationState(connection, obligation),
  ]);
  assertSingleReserveScope(obligationState, reserve);

  const setupIxs: TransactionInstruction[] = [];

  if (!userMetadataInfo) {
    const data = Buffer.alloc(8 + 32);
    IX_INIT_USER_METADATA.copy(data, 0);
    // `userLookupTable` — see header: not used by any other instruction, a
    // real LUT is a client-side compression optimisation this app skips.
    SystemProgram.programId.toBuffer().copy(data, 8);
    setupIxs.push(
      new TransactionInstruction({
        programId: program,
        keys: [
          { pubkey: fromPubkey, isSigner: true, isWritable: false },
          { pubkey: fromPubkey, isSigner: true, isWritable: true },
          { pubkey: userMetadata, isSigner: false, isWritable: true },
          { pubkey: program, isSigner: false, isWritable: false }, // referrerUserMetadata: None
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data,
      }),
    );
  }

  if (!obligationState) {
    const data = Buffer.alloc(10);
    IX_INIT_OBLIGATION.copy(data, 0);
    data.writeUInt8(0, 8); // tag: Vanilla
    data.writeUInt8(0, 9); // id
    setupIxs.push(
      new TransactionInstruction({
        programId: program,
        keys: [
          { pubkey: fromPubkey, isSigner: true, isWritable: false },
          { pubkey: fromPubkey, isSigner: true, isWritable: true },
          { pubkey: obligation, isSigner: false, isWritable: true },
          { pubkey: lendingMarket, isSigner: false, isWritable: false },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          }, // seed1Account
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          }, // seed2Account
          { pubkey: userMetadata, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data,
      }),
    );
  }

  const refreshIxs = await buildRefreshIxs(
    program,
    reserve,
    reserveState,
    obligation,
    obligationState,
  );

  const userSourceLiquidity = getAssociatedTokenAddressSync(
    mint,
    fromPubkey,
    false,
    reserveState.liquidityTokenProgram,
  );

  const depositData = Buffer.alloc(16);
  IX_DEPOSIT.copy(depositData, 0);
  depositData.writeBigUInt64LE(amount, 8);

  const depositIx = new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: fromPubkey, isSigner: true, isWritable: true },
      { pubkey: obligation, isSigner: false, isWritable: true },
      { pubkey: lendingMarket, isSigner: false, isWritable: false },
      { pubkey: lendingMarketAuthority, isSigner: false, isWritable: false },
      { pubkey: reserve, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: reserveLiquiditySupply, isSigner: false, isWritable: true },
      { pubkey: reserveCollateralMint, isSigner: false, isWritable: true },
      { pubkey: reserveCollateralSupply, isSigner: false, isWritable: true },
      { pubkey: userSourceLiquidity, isSigner: false, isWritable: true },
      { pubkey: program, isSigner: false, isWritable: false }, // placeholderUserDestinationCollateral: None
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // collateralTokenProgram
      {
        pubkey: reserveState.liquidityTokenProgram,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
    ],
    data: depositData,
  });

  return {
    kind: "solana-ix",
    instructions: [...setupIxs, ...refreshIxs, depositIx],
  };
}

async function buildKaminoWithdraw(
  connection: Connection,
  fromPubkey: PublicKey,
  target: { program: PublicKey; reserve: PublicKey; mint: PublicKey },
  amount: bigint | "MAX",
): Promise<UnsignedCall> {
  const { program, reserve, mint } = target;
  const reserveState = await readReserveState(connection, reserve);
  const lendingMarket = reserveState.lendingMarket;
  const obligation = vanillaObligationPda(program, fromPubkey, lendingMarket);
  const obligationState = await readObligationState(connection, obligation);
  assertSingleReserveScope(obligationState, reserve);

  const deposit = obligationState?.deposits.find((dep) =>
    dep.reserve.equals(reserve),
  );
  if (!deposit || deposit.depositedAmount === 0n) {
    throw new DefiError(
      "position_not_found",
      "kamino: no deposit in this reserve",
    );
  }

  const collateralAmount =
    amount === "MAX"
      ? deposit.depositedAmount
      : (() => {
          const converted = liquidityToCTokens(amount, reserveState);
          return converted >= deposit.depositedAmount
            ? deposit.depositedAmount
            : converted;
        })();

  const [
    lendingMarketAuthority,
    reserveLiquiditySupply,
    reserveCollateralMint,
    reserveCollateralSupply,
  ] = [
    PublicKey.findProgramAddressSync(
      [SEED_LENDING_MARKET_AUTH, lendingMarket.toBuffer()],
      program,
    )[0],
    PublicKey.findProgramAddressSync(
      [SEED_RESERVE_LIQ_SUPPLY, reserve.toBuffer()],
      program,
    )[0],
    PublicKey.findProgramAddressSync(
      [SEED_RESERVE_COLL_MINT, reserve.toBuffer()],
      program,
    )[0],
    PublicKey.findProgramAddressSync(
      [SEED_RESERVE_COLL_SUPPLY, reserve.toBuffer()],
      program,
    )[0],
  ];

  const refreshIxs = await buildRefreshIxs(
    program,
    reserve,
    reserveState,
    obligation,
    obligationState,
  );

  const userDestinationLiquidity = getAssociatedTokenAddressSync(
    mint,
    fromPubkey,
    false,
    reserveState.liquidityTokenProgram,
  );
  const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    fromPubkey,
    userDestinationLiquidity,
    fromPubkey,
    mint,
    reserveState.liquidityTokenProgram,
  );

  const withdrawData = Buffer.alloc(16);
  IX_WITHDRAW.copy(withdrawData, 0);
  withdrawData.writeBigUInt64LE(collateralAmount, 8);

  const withdrawIx = new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: fromPubkey, isSigner: true, isWritable: true },
      { pubkey: obligation, isSigner: false, isWritable: true },
      { pubkey: lendingMarket, isSigner: false, isWritable: false },
      { pubkey: lendingMarketAuthority, isSigner: false, isWritable: false },
      { pubkey: reserve, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: reserveCollateralSupply, isSigner: false, isWritable: true }, // reserveSourceCollateral
      { pubkey: reserveCollateralMint, isSigner: false, isWritable: true },
      { pubkey: reserveLiquiditySupply, isSigner: false, isWritable: true },
      { pubkey: userDestinationLiquidity, isSigner: false, isWritable: true },
      { pubkey: program, isSigner: false, isWritable: false }, // placeholderUserDestinationCollateral: None
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      {
        pubkey: reserveState.liquidityTokenProgram,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
    ],
    data: withdrawData,
  });

  return {
    kind: "solana-ix",
    instructions: [createAtaIx, ...refreshIxs, withdrawIx],
  };
}

async function readKaminoPosition(
  walletAddress: string,
  target: DepositTarget & { kind: "solana-reserve" },
): Promise<DefiPosition | null> {
  const connection = makeConnection(undefined);
  const program = new PublicKey(target.program);
  const reserve = new PublicKey(target.reserve);
  const owner = new PublicKey(walletAddress);

  const reserveState = await readReserveState(connection, reserve);
  const obligation = vanillaObligationPda(
    program,
    owner,
    reserveState.lendingMarket,
  );
  const obligationState = await readObligationState(connection, obligation);
  const deposit = obligationState?.deposits.find((dep) =>
    dep.reserve.equals(reserve),
  );
  if (!deposit || deposit.depositedAmount === 0n) return null;

  const liquidityEquivalent = cTokensToLiquidity(
    deposit.depositedAmount,
    reserveState,
  );

  return {
    protocolSlug: SLUG,
    namespace: "solana",
    chainId: CLUSTER,
    assetSymbol: target.mint,
    amountAtDeposit: 0n,
    amountAtDepositUsd: 0,
    currentAmount: liquidityEquivalent,
    currentAmountUsd: 0,
    pnlUsd: 0,
  };
}

export const KaminoLendAdapter: DefiProtocolAdapter = {
  slug: SLUG,
  namespace: "solana",
  kind: "stablecoin_lending",
  chainId: CLUSTER,
  displayName: "Kamino Lend",
  staticSafetyScore: 78,
  externalSlugs: ["kamino-lend"],
  targetKinds: ["solana-reserve"],

  async buildDeposit({
    wallet,
    chain,
    amount,
    target,
  }: BuildDepositArgs): Promise<UnsignedCall> {
    if (chain.namespace !== "solana") {
      throw new DefiError(
        "unsupported_chain",
        "kamino: requires solana namespace",
      );
    }
    const t = requireReserveTarget(target);
    const connection = makeConnection(chain.rpcUrl);
    const fromPubkey = new PublicKey(wallet.address);
    return buildKaminoDeposit(connection, fromPubkey, t, amount);
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
        "kamino: requires solana namespace",
      );
    }
    const t = requireReserveTarget(target);
    const connection = makeConnection(chain.rpcUrl);
    const fromPubkey = new PublicKey(wallet.address);
    return buildKaminoWithdraw(connection, fromPubkey, t, amount);
  },

  async readPosition(
    walletAddress: string,
    ctx?: PositionReadContext,
  ): Promise<DefiPosition | null> {
    if (ctx?.target?.kind !== "solana-reserve") return null;
    try {
      return await readKaminoPosition(
        walletAddress,
        ctx.target as DepositTarget & { kind: "solana-reserve" },
      );
    } catch (err) {
      devWarn("readPosition", err);
      return null;
    }
  },
};
