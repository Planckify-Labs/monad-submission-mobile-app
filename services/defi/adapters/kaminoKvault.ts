/**
 * Kamino kvault adapter — ONE `DefiProtocolAdapter` covering Kamino's "Earn"
 * share-vault product, dispatched by `DepositTarget.kind === "kamino-kvault"`
 * (`{vault, mint}`). This is the program BEHIND DeFiLlama's `sentora`
 * project on Solana (`poolMeta: "Kamino Sentora PYUSD"` / `"Kamino USDG
 * Ethena"`) — `sentora` itself is a cross-chain aggregator BRAND, not a
 * single program, so only its 2 Solana pools resolve here (see
 * `kamino-kvault.resolver.ts`'s header). It is a SEPARATE on-chain program
 * from Kamino Lend (`kamino-lend`, `adapters/kaminoLend.ts`) — a plain
 * ERC4626-style share vault (deposit assets, mint shares; burn shares,
 * redeem assets), not an Obligation.
 *
 * No SDK dependency, same rationale and methodology as `kaminoLend.ts`:
 * hand-built from Kamino's published `@kamino-finance/klend-sdk` tarball's
 * `src/@codegen/kvault/*` (pulled into scratch, never installed), verified
 * 2026-08-23:
 *
 *   - Program id (`KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd`) confirmed
 *     live: it is the `owner` of both known VaultState accounts, matching
 *     the SDK's own `programId.ts`.
 *   - The `deposit` and `withdrawFromAvailable` instruction discriminators
 *     were independently computed as `sha256("global:<name>")[0..8]` AND
 *     cross-checked byte-for-byte against the SDK's hardcoded
 *     `DISCRIMINATOR` constants — both matched exactly.
 *   - The `VaultState` byte layout was not hand-computed: the SDK's own
 *     `borsh.struct([...])` (from `src/@codegen/kvault/accounts/
 *     VaultState.ts` + `types/VaultAllocation.ts`) was reconstructed in a
 *     throwaway script (`@coral-xyz/borsh`, never installed into this app)
 *     and used to `.decode()` the REAL "Sentora PYUSD" vault account; the
 *     resulting field offsets were read off that decode and cross-checked
 *     against a SECOND, independently hand-computed offset table (summing
 *     each field's borsh size in the same struct order) — the two matched
 *     on every field, including the 2160-byte `VaultAllocation` stride
 *     (`32+32+8*4+126*8+8*2+16+128*8`) inside the 25-slot
 *     `vaultAllocationStrategy` array.
 *   - The `eventAuthority` (`["__event_authority"]`) and `globalConfig`
 *     (`["global_config"]`) PDAs were transcribed from the SDK's
 *     `utils/seeds.ts` / `classes/vault.ts` seed constants; `globalConfig`
 *     was confirmed to exist live and be owned by the kvault program.
 *   - A full `deposit` instruction (all 13 fixed accounts + the vault's live
 *     remaining-accounts reserve/market list) was built and run through
 *     `simulateTransaction` against a real, funded, on-curve mainnet wallet:
 *     Anchor logged `Instruction: Deposit` and got all the way to the
 *     `user_token_ata` check (`AccountNotInitialized`, expected — that test
 *     wallet holds no PYUSD) with no account-ordering/PDA errors anywhere
 *     upstream of it.
 *
 * **Scope, deliberately limited (fail closed, not guessed):** withdraw only
 * ever calls `withdrawFromAvailable` — the vault's own uninvested buffer
 * (`VaultState.tokenAvailable`). Kvault's OTHER withdraw instruction
 * (`withdraw`, singular) can additionally drain ONE specific klend reserve
 * the vault has invested into, needing a `ctokenVault`/`lendingMarketAuthority`
 * PDA set per reserve and a choice of WHICH reserve to hit for a partial
 * shortfall — a materially bigger problem (mirrors `kaminoLend.ts`'s
 * single-reserve-scope discipline). Most of a mature vault's TVL is invested
 * (this session found the $114M "Sentora PYUSD" vault holding only ~$41 of
 * `tokenAvailable` at read time), so most withdrawal AMOUNTS will be refused
 * here — that is the intended, honest behaviour: a clean refusal beats a
 * transaction the chain has to revert. Deposit is unaffected by this limit
 * (it only ever adds to `tokenAvailable`; the vault's own crank later invests
 * it, off the critical path of this adapter).
 *
 * **Farm staking is not wired.** Both known vaults have a `vaultFarm`
 * configured (confirmed live), and DeFiLlama's `apyReward` on the PYUSD pool
 * corroborates a farm reward stream — but per this codebase's
 * skip-farm-registration precedent (`kaminoLend.ts`'s header), this adapter
 * mints shares straight to the user's own ATA rather than staking them.
 * The user's core position and its NAV appreciation are unaffected; only
 * bonus farm token emissions are forgone. Wiring farm stake/unstake is
 * future work.
 *
 * **Share pricing.** `deposit`'s on-chain argument is already asset-
 * denominated (`maxAmount`, token units) — no conversion needed. `withdraw
 * FromAvailable` takes `sharesAmount` (shares), so withdraw converts the
 * caller's asset-denominated `amount` using
 * `netAum = tokenAvailable + Σ(reserve cToken allocation → liquidity, at
 * each active reserve's LIVE klend exchange rate) - pendingFeesSf/2^60`
 * (the same `Fraction` scale, 2^60, independently re-verified against the
 * SDK's `classes/fraction.ts` — NOT assumed to match klend's just because
 * both are Kamino programs) and `sharesForAmount = amount * sharesIssued /
 * netAum`. The exchange-rate math per reserve reuses the exact formula
 * verified for `kaminoLend.ts` (`cTokensToLiquidity`), since kvault invests
 * into the SAME klend Reserve accounts.
 */

import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
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

const SLUG = "kamino-kvault";
const CLUSTER = "mainnet-beta" as const;

const KVAULT_PROGRAM_ID = new PublicKey(
  "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd",
);
// Same klend program the sibling `kaminoLend.ts` adapter uses — kvault
// invests into klend's Reserve accounts and passes this as a fixed account.
const KLEND_PROGRAM_ID = new PublicKey(
  "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
);

const IX_DEPOSIT = Buffer.from("f223c68952e1f2b6", "hex");
const IX_WITHDRAW_FROM_AVAILABLE = Buffer.from("1383709baadc2239", "hex");

const [EVENT_AUTHORITY] = PublicKey.findProgramAddressSync(
  [Buffer.from("__event_authority")],
  KVAULT_PROGRAM_ID,
);
const [GLOBAL_CONFIG] = PublicKey.findProgramAddressSync(
  [Buffer.from("global_config")],
  KVAULT_PROGRAM_ID,
);

// ── VaultState byte offsets (from the start of the raw account data,
// INCLUDING the 8-byte Anchor discriminator) — see header for derivation. ──
const V_BASE_VAULT_AUTHORITY = 32;
const V_TOKEN_MINT = 72;
const V_TOKEN_VAULT = 112;
const V_TOKEN_PROGRAM = 144;
const V_SHARES_MINT = 176;
const V_TOKEN_AVAILABLE = 216; // u64
const V_SHARES_ISSUED = 224; // u64
const V_PENDING_FEES_SF = 288; // u128, Fraction (2^60) scale
const V_ALLOCATIONS_START = 304;
const V_ALLOCATION_STRIDE = 2160;
const V_ALLOCATION_COUNT = 25;
const V_ALLOCATION_CTOKEN_OFFSET = 1104; // within each 2160-byte slot
const FRACTION_SF = 1n << 60n; // Kamino's `Fraction::FRACTIONS` — re-verified for kvault, see header

// ── klend Reserve byte offsets (subset reused from `kaminoLend.ts`, kept
// self-contained here rather than shared, matching this codebase's
// per-adapter-file convention). ────────────────────────────────────────────
const R_LIQUIDITY_TOTAL_AVAILABLE = 224; // u64
const R_LIQUIDITY_BORROWED_SF = 232; // u128
const R_LIQUIDITY_ACCUM_PROTOCOL_FEES_SF = 344; // u128
const R_LIQUIDITY_ACCUM_REFERRER_FEES_SF = 360; // u128
const R_LIQUIDITY_PENDING_REFERRER_FEES_SF = 376; // u128
const R_COLLATERAL_MINT_TOTAL_SUPPLY = 2592; // u64
const R_LENDING_MARKET = 32;

function devWarn(scope: string, err: unknown): void {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn(`[kaminoKvault] ${scope}:`, err);
  }
}

function makeConnection(rpcUrl: string | undefined): Connection {
  return new Connection(
    rpcUrl || "https://api.mainnet-beta.solana.com",
    "confirmed",
  );
}

function requireKvaultTarget(target: DepositTarget | undefined): {
  vault: PublicKey;
  mint: PublicKey;
} {
  if (target?.kind !== "kamino-kvault") {
    throw new DefiError(
      "deposit_failed",
      "kamino-kvault: a resolved vault target is required",
    );
  }
  return {
    vault: new PublicKey(target.vault),
    mint: new PublicKey(target.mint),
  };
}

interface VaultAllocationEntry {
  reserve: PublicKey;
  ctokenAllocation: bigint;
}

interface VaultStateInfo {
  baseVaultAuthority: PublicKey;
  tokenMint: PublicKey;
  tokenVault: PublicKey;
  tokenProgram: PublicKey;
  sharesMint: PublicKey;
  tokenAvailable: bigint;
  sharesIssued: bigint;
  pendingFeesSf: bigint;
  allocations: VaultAllocationEntry[]; // active slots only
}

function isDefaultPubkey(pk: PublicKey): boolean {
  return pk.equals(PublicKey.default);
}

async function readVaultState(
  connection: Connection,
  vault: PublicKey,
): Promise<VaultStateInfo> {
  const info = await connection.getAccountInfo(vault);
  if (!info) {
    throw new DefiError("network_error", "kamino-kvault: vault not found");
  }
  const d = info.data;
  const minLen = V_ALLOCATIONS_START + V_ALLOCATION_COUNT * V_ALLOCATION_STRIDE;
  if (d.length < minLen) {
    throw new DefiError("network_error", "kamino-kvault: vault data too small");
  }
  const pk = (offset: number) => new PublicKey(d.subarray(offset, offset + 32));
  const u64 = (offset: number) => d.readBigUInt64LE(offset);
  const u128 = (offset: number) =>
    d.readBigUInt64LE(offset) | (d.readBigUInt64LE(offset + 8) << 64n);

  const allocations: VaultAllocationEntry[] = [];
  for (let i = 0; i < V_ALLOCATION_COUNT; i++) {
    const base = V_ALLOCATIONS_START + i * V_ALLOCATION_STRIDE;
    const reserve = pk(base);
    if (isDefaultPubkey(reserve)) continue;
    allocations.push({
      reserve,
      ctokenAllocation: u64(base + V_ALLOCATION_CTOKEN_OFFSET),
    });
  }

  return {
    baseVaultAuthority: pk(V_BASE_VAULT_AUTHORITY),
    tokenMint: pk(V_TOKEN_MINT),
    tokenVault: pk(V_TOKEN_VAULT),
    tokenProgram: pk(V_TOKEN_PROGRAM),
    sharesMint: pk(V_SHARES_MINT),
    tokenAvailable: u64(V_TOKEN_AVAILABLE),
    sharesIssued: u64(V_SHARES_ISSUED),
    pendingFeesSf: u128(V_PENDING_FEES_SF),
    allocations,
  };
}

interface ReserveExchangeInfo {
  lendingMarket: PublicKey;
  totalSupplySf: bigint;
  collateralMintTotalSupply: bigint;
}

function readReserveExchangeInfo(data: Buffer): ReserveExchangeInfo {
  const u64 = (offset: number) => data.readBigUInt64LE(offset);
  const u128 = (offset: number) =>
    data.readBigUInt64LE(offset) | (data.readBigUInt64LE(offset + 8) << 64n);
  const totalAvailableAmount = u64(R_LIQUIDITY_TOTAL_AVAILABLE);
  const borrowedSf = u128(R_LIQUIDITY_BORROWED_SF);
  const accumProtocolFeesSf = u128(R_LIQUIDITY_ACCUM_PROTOCOL_FEES_SF);
  const accumReferrerFeesSf = u128(R_LIQUIDITY_ACCUM_REFERRER_FEES_SF);
  const pendingReferrerFeesSf = u128(R_LIQUIDITY_PENDING_REFERRER_FEES_SF);
  return {
    lendingMarket: new PublicKey(
      data.subarray(R_LENDING_MARKET, R_LENDING_MARKET + 32),
    ),
    totalSupplySf:
      totalAvailableAmount * FRACTION_SF +
      borrowedSf -
      accumProtocolFeesSf -
      accumReferrerFeesSf -
      pendingReferrerFeesSf,
    collateralMintTotalSupply: u64(R_COLLATERAL_MINT_TOTAL_SUPPLY),
  };
}

function ctokensToLiquidity(ctokens: bigint, r: ReserveExchangeInfo): bigint {
  if (r.totalSupplySf <= 0n || r.collateralMintTotalSupply <= 0n)
    return ctokens;
  return (
    (ctokens * r.totalSupplySf) / (r.collateralMintTotalSupply * FRACTION_SF)
  );
}

/**
 * Net AUM (in token base units) across the vault's available buffer plus
 * every active reserve allocation, minus accrued-but-uncollected fees — see
 * header for the formula and why it's needed even though withdraw only ever
 * draws from `tokenAvailable`: `sharesForAmount` needs an ACCURATE price to
 * pick the right share count, not just the buffer-only figure.
 */
async function computeNetAumAndReserveMarkets(
  connection: Connection,
  vaultState: VaultStateInfo,
): Promise<{
  netAum: bigint;
  remainingAccounts: TransactionInstruction["keys"];
}> {
  if (vaultState.allocations.length === 0) {
    return {
      netAum:
        vaultState.tokenAvailable - vaultState.pendingFeesSf / FRACTION_SF,
      remainingAccounts: [],
    };
  }
  const reserveInfos = await connection.getMultipleAccountsInfo(
    vaultState.allocations.map((a) => a.reserve),
  );
  let invested = 0n;
  const markets: PublicKey[] = [];
  reserveInfos.forEach((info, i) => {
    if (!info) {
      throw new DefiError(
        "network_error",
        "kamino-kvault: an allocated reserve was not found",
      );
    }
    const exch = readReserveExchangeInfo(info.data);
    invested += ctokensToLiquidity(
      vaultState.allocations[i].ctokenAllocation,
      exch,
    );
    markets.push(exch.lendingMarket);
  });
  const netAum =
    vaultState.tokenAvailable +
    invested -
    vaultState.pendingFeesSf / FRACTION_SF;
  const remainingAccounts = [
    ...vaultState.allocations.map((a) => ({
      pubkey: a.reserve,
      isSigner: false,
      isWritable: true,
    })),
    ...markets.map((m) => ({ pubkey: m, isSigner: false, isWritable: false })),
  ];
  return { netAum, remainingAccounts };
}

async function buildKvaultDeposit(
  connection: Connection,
  fromPubkey: PublicKey,
  target: { vault: PublicKey; mint: PublicKey },
  amount: bigint,
): Promise<UnsignedCall> {
  const { vault, mint } = target;
  const vaultState = await readVaultState(connection, vault);
  if (!vaultState.tokenMint.equals(mint)) {
    throw new DefiError(
      "deposit_failed",
      "kamino-kvault: vault's on-chain mint does not match the resolved target",
    );
  }

  const userTokenAta = getAssociatedTokenAddressSync(
    mint,
    fromPubkey,
    false,
    vaultState.tokenProgram,
  );
  const userSharesAta = getAssociatedTokenAddressSync(
    vaultState.sharesMint,
    fromPubkey,
    false,
    TOKEN_PROGRAM_ID,
  );
  const createSharesAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    fromPubkey,
    userSharesAta,
    fromPubkey,
    vaultState.sharesMint,
    TOKEN_PROGRAM_ID,
  );

  // Deposit doesn't need netAum (its arg is already asset-denominated), but
  // it still needs the live active-reserve/market remaining-accounts list —
  // reuse the same helper and discard the price.
  const { remainingAccounts } = await computeNetAumAndReserveMarkets(
    connection,
    vaultState,
  );

  const depositData = Buffer.alloc(16);
  IX_DEPOSIT.copy(depositData, 0);
  depositData.writeBigUInt64LE(amount, 8);

  const depositIx = new TransactionInstruction({
    programId: KVAULT_PROGRAM_ID,
    keys: [
      { pubkey: fromPubkey, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: vaultState.tokenVault, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      {
        pubkey: vaultState.baseVaultAuthority,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: vaultState.sharesMint, isSigner: false, isWritable: true },
      { pubkey: userTokenAta, isSigner: false, isWritable: true },
      { pubkey: userSharesAta, isSigner: false, isWritable: true },
      { pubkey: KLEND_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: vaultState.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // sharesTokenProgram
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: KVAULT_PROGRAM_ID, isSigner: false, isWritable: false }, // program (self, CPI event emission)
      ...remainingAccounts,
    ],
    data: depositData,
  });

  return {
    kind: "solana-ix",
    instructions: [createSharesAtaIx, depositIx],
  };
}

async function buildKvaultWithdraw(
  connection: Connection,
  fromPubkey: PublicKey,
  target: { vault: PublicKey; mint: PublicKey },
  amount: bigint | "MAX",
): Promise<UnsignedCall> {
  const { vault, mint } = target;
  const vaultState = await readVaultState(connection, vault);
  if (!vaultState.tokenMint.equals(mint)) {
    throw new DefiError(
      "deposit_failed",
      "kamino-kvault: vault's on-chain mint does not match the resolved target",
    );
  }

  const userSharesAta = getAssociatedTokenAddressSync(
    vaultState.sharesMint,
    fromPubkey,
    false,
    TOKEN_PROGRAM_ID,
  );

  const { netAum, remainingAccounts } = await computeNetAumAndReserveMarkets(
    connection,
    vaultState,
  );
  if (netAum <= 0n || vaultState.sharesIssued <= 0n) {
    throw new DefiError("position_not_found", "kamino-kvault: no position");
  }

  let requestedAmount: bigint;
  if (amount === "MAX") {
    const sharesBalance = await connection
      .getTokenAccountBalance(userSharesAta)
      .then((r) => BigInt(r.value.amount))
      .catch(() => 0n);
    if (sharesBalance <= 0n) {
      throw new DefiError("position_not_found", "kamino-kvault: no position");
    }
    requestedAmount = (sharesBalance * netAum) / vaultState.sharesIssued;
  } else {
    requestedAmount = amount;
  }

  if (requestedAmount > vaultState.tokenAvailable) {
    throw new DefiError(
      "deposit_failed",
      "kamino-kvault: this withdrawal exceeds the vault's available liquidity right now, try a smaller amount",
    );
  }

  const sharesAmount = (requestedAmount * vaultState.sharesIssued) / netAum;
  if (sharesAmount <= 0n) {
    throw new DefiError("position_not_found", "kamino-kvault: no position");
  }

  const userTokenAta = getAssociatedTokenAddressSync(
    mint,
    fromPubkey,
    false,
    vaultState.tokenProgram,
  );
  const createTokenAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    fromPubkey,
    userTokenAta,
    fromPubkey,
    mint,
    vaultState.tokenProgram,
  );

  const withdrawData = Buffer.alloc(16);
  IX_WITHDRAW_FROM_AVAILABLE.copy(withdrawData, 0);
  withdrawData.writeBigUInt64LE(sharesAmount, 8);

  const withdrawIx = new TransactionInstruction({
    programId: KVAULT_PROGRAM_ID,
    keys: [
      { pubkey: fromPubkey, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: GLOBAL_CONFIG, isSigner: false, isWritable: false },
      { pubkey: vaultState.tokenVault, isSigner: false, isWritable: true },
      {
        pubkey: vaultState.baseVaultAuthority,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: userTokenAta, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: userSharesAta, isSigner: false, isWritable: true },
      { pubkey: vaultState.sharesMint, isSigner: false, isWritable: true },
      { pubkey: vaultState.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // sharesTokenProgram
      { pubkey: KLEND_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: KVAULT_PROGRAM_ID, isSigner: false, isWritable: false }, // program
      ...remainingAccounts,
    ],
    data: withdrawData,
  });

  return {
    kind: "solana-ix",
    instructions: [createTokenAtaIx, withdrawIx],
  };
}

async function readKvaultPosition(
  walletAddress: string,
  target: DepositTarget & { kind: "kamino-kvault" },
): Promise<DefiPosition | null> {
  const connection = makeConnection(undefined);
  const vault = new PublicKey(target.vault);
  const owner = new PublicKey(walletAddress);

  const vaultState = await readVaultState(connection, vault);
  const userSharesAta = getAssociatedTokenAddressSync(
    vaultState.sharesMint,
    owner,
    false,
    TOKEN_PROGRAM_ID,
  );
  const sharesBalance = await connection
    .getTokenAccountBalance(userSharesAta)
    .then((r) => BigInt(r.value.amount))
    .catch(() => 0n);
  if (sharesBalance <= 0n) return null;

  const { netAum } = await computeNetAumAndReserveMarkets(
    connection,
    vaultState,
  );
  if (netAum <= 0n || vaultState.sharesIssued <= 0n) return null;
  const currentAmount = (sharesBalance * netAum) / vaultState.sharesIssued;
  if (currentAmount <= 0n) return null;

  return {
    protocolSlug: SLUG,
    namespace: "solana",
    chainId: CLUSTER,
    assetSymbol: target.mint,
    amountAtDeposit: 0n,
    amountAtDepositUsd: 0,
    currentAmount,
    currentAmountUsd: 0,
    pnlUsd: 0,
  };
}

export const KaminoKvaultAdapter: DefiProtocolAdapter = {
  slug: SLUG,
  namespace: "solana",
  kind: "yield_vault",
  chainId: CLUSTER,
  displayName: "Kamino Earn",
  staticSafetyScore: 76,
  // Deliberately NO `externalSlugs: ["sentora"]` — "sentora" is a multi-chain
  // DeFiLlama project (it also has an unrelated Ethereum USDC pool that is
  // NOT Kamino), and `getDefiAdapter(slug)` is a flat, namespace-blind match
  // consulted directly by `positions/reader.ts` before any target/kind
  // check. Declaring it would let a non-Kamino "sentora" position resolve to
  // THIS adapter. This is the exact class of bug already found and fixed for
  // `Erc4626Adapter`/Sky (see reader.ts's header comment) — kind-routed
  // families that share an ambiguous project slug rely on the target's
  // `kind` for resolution, never on `externalSlugs`.
  targetKinds: ["kamino-kvault"],

  async buildDeposit({
    wallet,
    chain,
    amount,
    target,
  }: BuildDepositArgs): Promise<UnsignedCall> {
    if (chain.namespace !== "solana") {
      throw new DefiError(
        "unsupported_chain",
        "kamino-kvault: requires solana namespace",
      );
    }
    const t = requireKvaultTarget(target);
    const connection = makeConnection(chain.rpcUrl);
    const fromPubkey = new PublicKey(wallet.address);
    return buildKvaultDeposit(connection, fromPubkey, t, amount);
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
        "kamino-kvault: requires solana namespace",
      );
    }
    const t = requireKvaultTarget(target);
    const connection = makeConnection(chain.rpcUrl);
    const fromPubkey = new PublicKey(wallet.address);
    return buildKvaultWithdraw(connection, fromPubkey, t, amount);
  },

  async readPosition(
    walletAddress: string,
    ctx?: PositionReadContext,
  ): Promise<DefiPosition | null> {
    if (ctx?.target?.kind !== "kamino-kvault") return null;
    try {
      return await readKvaultPosition(
        walletAddress,
        ctx.target as DepositTarget & { kind: "kamino-kvault" },
      );
    } catch (err) {
      devWarn("readPosition", err);
      return null;
    }
  },
};
