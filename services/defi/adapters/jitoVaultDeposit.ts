/**
 * Jito Restaking Vault deposit adapter — ONE `DefiProtocolAdapter` covering
 * the generic `MintTo` instruction on Jito's public Vault program
 * (`jito-foundation/restaking`, Apache-2.0), dispatched by
 * `DepositTarget.kind === "jito-vault-deposit"` (`{vault, mint}`). The only
 * live instance resolved today is Kyros's kySOL vault, but the shape is the
 * program's, not Kyros's — a future VRT on the same Vault program is a new
 * pinned `vault` row, not new adapter code.
 *
 * **Why this isn't `"solana-lst-stake"`.** Kyros's own docs (docs.kyros.fi)
 * label their on-chain program as `kySo1nETpsZE2NWe5vj2C64mPSciH1SppmHb4XieQ7B`
 * — that address is WRONG, or at least not a program: live `getAccountInfo`
 * shows it's owned by the SPL Token program (it's the kySOL MINT). The real
 * program is Jito's own public Vault program
 * (`Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8`, confirmed live: executable,
 * owner `BPFLoaderUpgradeable`), and the pinned vault
 * (`CQpvXgoaaawDCLh8FwMZEwQqnPakRUZ5BnzhjnEBPJv`) and Jito's restaking
 * `Config` PDA are both confirmed live-owned by it too. This is a
 * fundamentally different shape from every `spl-stake-pool`/`marinade`
 * venue in `adapters/solana/lst.config.ts`: the deposited asset is JitoSOL
 * (an SPL mint), not native SOL.
 *
 * **Withdraw is two-phase (2026-08-27), via the optional `buildRequestRedeem`/
 * `buildClaimRedeem`/`readAsyncRequest` capabilities (§7-style, mirrors
 * `asyncVault.ts`).** This program's exit is genuinely NOT a single atomic
 * action: `EnqueueWithdrawal` burns nothing yet — it transfers the staker's
 * VRT into a fresh `VaultStakerWithdrawalTicket` PDA's own token account and
 * records the enqueue slot; only after `is_withdrawable` (more than one full
 * epoch has elapsed — `epoch_length` is 432,000 slots on mainnet, so roughly
 * 2-4 days depending on where in the epoch the enqueue landed) does
 * `BurnWithdrawalTicket` actually burn the VRT and pay out the underlying,
 * closing the ticket. `readAsyncRequest` finds the wallet's own outstanding
 * ticket for this vault (there is no `pendingRedeemRequest`-style counter
 * like ERC-7540 — Jito's tickets are individual PDAs, found via
 * `getProgramAccounts` filtered on `dataSize=384` +
 * `memcmp(offset:8, vault)` + `memcmp(offset:40, staker)`, confirmed live to
 * work on the public RPC without restriction) and reports it as
 * pending/claimable by re-deriving `is_withdrawable` from the ticket's own
 * `slot_unstaked` plus `Config.epoch_length`, read live rather than assumed.
 *
 * **`buildRequestRedeem` is MAX-only** (enqueues the wallet's ENTIRE VRT
 * balance) — a deliberate scope limit, not a shortcut. `EnqueueWithdrawal`'s
 * `vrt_amount` has NO on-chain slippage/min-out floor at all (unlike
 * `MintTo`'s `min_amount_out`), and the JitoSOL actually paid out at claim
 * time depends on the vault's exchange rate THEN, days later — the same
 * "an asset-amount-to-shares conversion this imprecise isn't worth
 * predicting, so burn the whole balance instead" reasoning already applied
 * repeatedly in this codebase (Raydium CPMM/AMM-v4, Kamino kliquidity,
 * Kamino kvault). `buildRequestRedeem` refuses a partial amount outright
 * rather than silently rounding a guess. Only one outstanding ticket is
 * supported at a time: a second `buildRequestRedeem` while one is already
 * pending is refused (`cooldown_in_progress`) rather than creating a second,
 * harder-to-reconcile ticket.
 *
 * **Verification story (2026-08-27), no vendor SDK read (public Apache-2.0
 * source + live on-chain data only):**
 *
 *   - Program id, `Config` PDA (seeds `["config"]`, from
 *     `vault_core/src/config.rs::seeds()`) and the `MintTo` instruction's
 *     account list + args (`amount_in: u64, min_amount_out: u64`, single-byte
 *     discriminant `11`) were read directly from
 *     `jito-foundation/restaking`'s `vault_program/src/mint_to.rs` +
 *     `idl/jito_vault.json` (Apache-2.0, no license concern — unlike the
 *     Orca/Raydium families elsewhere in this file set).
 *   - The on-chain `Vault` account layout (`vault_core/src/vault.rs`) is a
 *     `#[repr(C)] Pod` struct with an 8-byte account header (byte 0 = the
 *     `VaultDiscriminator` tag, `2` for `Vault`; bytes 1-7 unused) — NOT a
 *     1-byte header as the enum's Rust representation might suggest. This
 *     was caught empirically: a naive "1-byte discriminator, zero padding"
 *     offset table decoded `vrt_mint` as garbage, byte-searching the REAL
 *     `vrtMint` pubkey inside the raw account bytes found it 7 bytes later
 *     than that naive table predicted, and re-deriving every subsequent
 *     offset with an 8-byte header made every field decode sane (vrtMint ==
 *     kySOL's real mint, supportedMint == JitoSOL's real mint, fee/admin
 *     fields all valid pubkeys, all bps fields ≤ 10000). `DelegationState`'s
 *     byte size (280 = 3×`PodU64` + 256-byte reserved) came directly from
 *     `vault_core/src/delegation_state.rs`, not guessed.
 *   - Every account this adapter builds (`config`, `vaultTokenAccount =
 *     ATA(vault, supportedMint)`, `vaultFeeTokenAccount = ATA(feeWallet,
 *     vrtMint)`) was cross-checked against a REAL, historical `MintTo`
 *     transaction found via the vault's own signature history
 *     (`5xbza7xAF6tc1ArAi8wfemmjmzLzrCcjBuLePhqDe5vgdKKwxzd1U9uXWDWj9yucQwsnV8toZkokXwyErJvZsFQd`)
 *     — the account order, the discriminant byte, and both computed ATAs
 *     matched the live transaction exactly, byte for byte. That transaction
 *     also confirms `mint_burn_admin` being the default/zero pubkey (live-
 *     read, confirmed) means the optional 10th `mintSigner` account can be
 *     omitted entirely — the live tx padded it with the program's own id as
 *     a filler, but `check_mint_burn_admin`'s short-circuit (`if
 *     self.mint_burn_admin.ne(&Pubkey::default())`) shows that filler is
 *     inert either way when the admin is unset, so this adapter just omits
 *     the 9th (0-indexed) account.
 *   - `calculate_vrt_mint_amount`/`mint_with_fee`'s pro-rata formula
 *     (`vrt_out = amount_in * vrt_supply / tokens_deposited`, minus a
 *     `deposit_fee_bps` cut — currently 0 for Kyros, read live rather than
 *     assumed) is reproduced off-chain to size `minAmountOut` via this
 *     codebase's shared `slippage.ts` policy, exactly like every other
 *     slippage-bearing family here — never a hardcoded 0.
 *
 * **Withdraw verification (2026-08-27), same no-vendor-SDK discipline:**
 *
 *   - `EnqueueWithdrawal` (discriminant `12`) and `BurnWithdrawalTicket`
 *     (discriminant `14`) account lists + args were read from
 *     `vault_program/src/{enqueue_withdrawal,burn_withdrawal_ticket}.rs` +
 *     `idl/jito_vault.json`.
 *   - The `VaultStakerWithdrawalTicket` PDA (seeds
 *     `["vault_staker_withdrawal_ticket", vault, base]`) and its byte layout
 *     (`vault_core/src/vault_staker_withdrawal_ticket.rs`: `staker`@40,
 *     `base`@72, `vrt_amount`@104 (u64), `slot_unstaked`@112 (u64), same
 *     8-byte-header convention as `Vault`) were BOTH cross-checked against a
 *     REAL, live ticket found via `getProgramAccounts` (filtered
 *     `dataSize=384` + `memcmp(offset:8, <kySOL vault>)` — 347 real,
 *     currently-open tickets exist for this one vault, confirming
 *     `getProgramAccounts` works unrestricted against this program on the
 *     public RPC, unlike the LP-mint-holder scans flagged elsewhere as
 *     429-prone): the decoded `vault`/`staker`/`base` fields were all valid
 *     pubkeys, and re-deriving the PDA from that ticket's own decoded
 *     `vault`+`base` reproduced its exact address AND bump (251) —
 *     independent confirmation of both the seeds and the byte offsets in one
 *     shot.
 *   - `Config`'s `epoch_length` (offset 72, u64) and `program_fee_wallet`
 *     (offset 96) were read from the SAME live `Config` account already used
 *     for `CONFIG_PDA` — `epoch_length` came back exactly `432,000`
 *     (Solana's own `DEFAULT_SLOTS_PER_EPOCH`), and the OTHER three
 *     Config-derived constants read alongside it that round-trip through
 *     known public defaults (`deposit_withdrawal_fee_cap_bps`=2000,
 *     `fee_rate_of_change_bps`=2500, `fee_bump_bps`=10 — all three match
 *     `Config`'s own documented `DEFAULT_*` constants exactly) corroborate
 *     the whole offset table independently of the PDA re-derivation above.
 *   - `is_withdrawable`'s rule (current epoch must be strictly greater than
 *     `epoch_unstaked + 1`, i.e. more than one full epoch must have elapsed)
 *     is reproduced off-chain exactly as written in
 *     `vault_staker_withdrawal_ticket.rs`, using the SAME live `epoch_length`
 *     rather than a hardcoded constant.
 *   - `calculate_burn_summary`'s payout formula (`out_amount = (vrt_amount -
 *     program_fee - vault_fee) * tokens_deposited / vrt_supply`, evaluated
 *     with the vault's state AT CLAIM TIME) confirms there is genuinely no
 *     way to predict a partial withdrawal's payout accurately across the
 *     multi-day cooldown — the rate can move between enqueue and claim —
 *     which is the concrete reason `buildRequestRedeem` is MAX-only rather
 *     than accepting an estimated partial amount.
 *
 * **Capacity/pause checks** (`is_paused`, `deposit_capacity` vs
 * `tokens_deposited`) are read live and enforced client-side too, so a
 * paused vault or a capacity-exceeding deposit fails with a curated message
 * instead of an on-chain revert.
 */

import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { DefiError } from "../errors/defiErrors";
import { minOutFor } from "../slippage";
import type {
  AsyncRequestState,
  BuildDepositArgs,
  BuildWithdrawArgs,
  DefiPosition,
  DefiProtocolAdapter,
  DepositTarget,
  PositionReadContext,
  UnsignedCall,
} from "../types";

const SLUG = "kyros";
const CLUSTER = "mainnet-beta" as const;

const VAULT_PROGRAM_ID = new PublicKey(
  "Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8",
);
const IX_MINT_TO = 11;
const IX_ENQUEUE_WITHDRAWAL = 12;
const IX_BURN_WITHDRAWAL_TICKET = 14;

const [CONFIG_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("config")],
  VAULT_PROGRAM_ID,
);

// ── Config account byte offsets (same 8-byte-header convention) — see
// header's withdraw-verification section for the live cross-checks. ──────
const C_EPOCH_LENGTH = 72; // u64
const C_PROGRAM_FEE_WALLET = 96;

// ── VaultStakerWithdrawalTicket byte offsets + PDA seed. ──────────────────
const TICKET_SIZE = 384;
const T_STAKER = 40;
const T_BASE = 72;
const T_VRT_AMOUNT = 104; // u64
const T_SLOT_UNSTAKED = 112; // u64
const TICKET_SEED = "vault_staker_withdrawal_ticket";

// ── Vault account byte offsets (from the start of the raw account data,
// INCLUDING the 8-byte header whose byte 0 is the `VaultDiscriminator` tag)
// — see header for the empirical derivation. ────────────────────────────
// Hardcoded (not derived by formula) — each value was independently
// confirmed by live-decoding the real kySOL vault account and checking the
// result is sane (correct mint pubkeys, bps fields <= 10000, etc — see
// header). A prior symbolic-arithmetic pass here mis-added one pubkey-count
// term and silently computed 728 for a value verified live to be 696; hand
// arithmetic on this struct is exactly the failure mode this codebase's own
// prior sessions caught more than once, so the verified literals are kept
// instead of a re-derivable expression.
const V_VRT_MINT = 40;
const V_SUPPORTED_MINT = 72;
const V_VRT_SUPPLY = 104; // u64
const V_TOKENS_DEPOSITED = 112; // u64
const V_DEPOSIT_CAPACITY = 120; // u64
const V_FEE_WALLET = 696;
const V_MINT_BURN_ADMIN = 728;
const V_DEPOSIT_FEE_BPS = 840; // u16
const V_IS_PAUSED = 851;

function devWarn(scope: string, err: unknown): void {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn(`[jitoVaultDeposit] ${scope}:`, err);
  }
}

function makeConnection(rpcUrl: string | undefined): Connection {
  return new Connection(
    rpcUrl || "https://api.mainnet-beta.solana.com",
    "confirmed",
  );
}

function requireTarget(target: DepositTarget | undefined): {
  vault: PublicKey;
  mint: PublicKey;
} {
  if (target?.kind !== "jito-vault-deposit") {
    throw new DefiError(
      "deposit_failed",
      "jito-vault-deposit: a resolved vault target is required",
    );
  }
  return {
    vault: new PublicKey(target.vault),
    mint: new PublicKey(target.mint),
  };
}

interface VaultInfo {
  vrtMint: PublicKey;
  supportedMint: PublicKey;
  feeWallet: PublicKey;
  mintBurnAdmin: PublicKey;
  vrtSupply: bigint;
  tokensDeposited: bigint;
  depositCapacity: bigint;
  depositFeeBps: bigint;
  isPaused: boolean;
}

async function readVault(
  connection: Connection,
  vault: PublicKey,
): Promise<VaultInfo> {
  const info = await connection.getAccountInfo(vault);
  if (!info) {
    throw new DefiError("network_error", "jito-vault: vault not found");
  }
  const d = info.data;
  if (d.length < V_IS_PAUSED + 1) {
    throw new DefiError("network_error", "jito-vault: vault data too small");
  }
  const pk = (offset: number) => new PublicKey(d.subarray(offset, offset + 32));
  const u64 = (offset: number) => d.readBigUInt64LE(offset);
  const u16 = (offset: number) => BigInt(d.readUInt16LE(offset));
  return {
    vrtMint: pk(V_VRT_MINT),
    supportedMint: pk(V_SUPPORTED_MINT),
    feeWallet: pk(V_FEE_WALLET),
    mintBurnAdmin: pk(V_MINT_BURN_ADMIN),
    vrtSupply: u64(V_VRT_SUPPLY),
    tokensDeposited: u64(V_TOKENS_DEPOSITED),
    depositCapacity: u64(V_DEPOSIT_CAPACITY),
    depositFeeBps: u16(V_DEPOSIT_FEE_BPS),
    isPaused: d[V_IS_PAUSED] !== 0,
  };
}

/** Mirrors `Vault::calculate_vrt_mint_amount` + `mint_with_fee`'s deposit-fee cut. */
function expectedVrtOut(vault: VaultInfo, amountIn: bigint): bigint {
  const vrtMintAmount =
    vault.tokensDeposited === 0n
      ? amountIn
      : (amountIn * vault.vrtSupply) / vault.tokensDeposited;
  const fee = (vrtMintAmount * vault.depositFeeBps + 9_999n) / 10_000n; // div_ceil, matches on-chain
  return vrtMintAmount - fee;
}

async function buildVaultDeposit(
  connection: Connection,
  fromPubkey: PublicKey,
  target: { vault: PublicKey; mint: PublicKey },
  amount: bigint,
): Promise<UnsignedCall> {
  const { vault, mint } = target;
  const v = await readVault(connection, vault);
  if (!v.supportedMint.equals(mint)) {
    throw new DefiError(
      "deposit_failed",
      "jito-vault-deposit: vault's on-chain supported mint does not match the resolved target",
    );
  }
  if (v.isPaused) {
    throw new DefiError(
      "strategy_paused",
      "jito-vault-deposit: vault is paused",
    );
  }
  if (v.tokensDeposited + amount > v.depositCapacity) {
    throw new DefiError(
      "deposit_cap_exceeded",
      "jito-vault-deposit: deposit would exceed the vault's capacity",
    );
  }
  // Extra signer only required when `mint_burn_admin` is set — see header.
  if (!v.mintBurnAdmin.equals(PublicKey.default)) {
    throw new DefiError(
      "strategy_not_configured",
      "jito-vault-deposit: this vault requires a delegated mint signer, not supported",
    );
  }

  const expected = expectedVrtOut(v, amount);
  const minAmountOut = minOutFor(expected, { stable: true });

  const depositorTokenAccount = getAssociatedTokenAddressSync(
    mint,
    fromPubkey,
    false,
    TOKEN_PROGRAM_ID,
  );
  const vaultTokenAccount = getAssociatedTokenAddressSync(
    mint,
    vault,
    true,
    TOKEN_PROGRAM_ID,
  );
  const depositorVrtTokenAccount = getAssociatedTokenAddressSync(
    v.vrtMint,
    fromPubkey,
    false,
    TOKEN_PROGRAM_ID,
  );
  const vaultFeeTokenAccount = getAssociatedTokenAddressSync(
    v.vrtMint,
    v.feeWallet,
    true,
    TOKEN_PROGRAM_ID,
  );

  const createDepositorTokenAtaIx =
    createAssociatedTokenAccountIdempotentInstruction(
      fromPubkey,
      depositorTokenAccount,
      fromPubkey,
      mint,
      TOKEN_PROGRAM_ID,
    );
  const createDepositorVrtAtaIx =
    createAssociatedTokenAccountIdempotentInstruction(
      fromPubkey,
      depositorVrtTokenAccount,
      fromPubkey,
      v.vrtMint,
      TOKEN_PROGRAM_ID,
    );

  const data = Buffer.alloc(17);
  data.writeUInt8(IX_MINT_TO, 0);
  data.writeBigUInt64LE(amount, 1);
  data.writeBigUInt64LE(minAmountOut, 9);

  const mintToIx = new TransactionInstruction({
    programId: VAULT_PROGRAM_ID,
    keys: [
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: v.vrtMint, isSigner: false, isWritable: true },
      { pubkey: fromPubkey, isSigner: true, isWritable: true },
      { pubkey: depositorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: depositorVrtTokenAccount, isSigner: false, isWritable: true },
      { pubkey: vaultFeeTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });

  return {
    kind: "solana-ix",
    instructions: [
      createDepositorTokenAtaIx,
      createDepositorVrtAtaIx,
      mintToIx,
    ],
  };
}

interface ConfigInfo {
  epochLength: bigint;
  programFeeWallet: PublicKey;
}

async function readConfig(connection: Connection): Promise<ConfigInfo> {
  const info = await connection.getAccountInfo(CONFIG_PDA);
  if (!info) {
    throw new DefiError("network_error", "jito-vault: config not found");
  }
  const d = info.data;
  return {
    epochLength: d.readBigUInt64LE(C_EPOCH_LENGTH),
    programFeeWallet: new PublicKey(
      d.subarray(C_PROGRAM_FEE_WALLET, C_PROGRAM_FEE_WALLET + 32),
    ),
  };
}

interface TicketInfo {
  address: PublicKey;
  staker: PublicKey;
  base: PublicKey;
  vrtAmount: bigint;
  slotUnstaked: bigint;
}

function getEpoch(slot: bigint, epochLength: bigint): bigint {
  return slot / epochLength;
}

/** Mirrors `VaultStakerWithdrawalTicket::is_withdrawable` exactly. */
function isWithdrawable(
  ticket: TicketInfo,
  currentSlot: bigint,
  epochLength: bigint,
): boolean {
  const currentEpoch = getEpoch(currentSlot, epochLength);
  const epochUnstaked = getEpoch(ticket.slotUnstaked, epochLength);
  return currentEpoch > epochUnstaked + 1n;
}

/**
 * Finds the wallet's own outstanding withdrawal ticket for this vault, via
 * `getProgramAccounts` scoped by `dataSize` + two `memcmp` filters — see
 * header for why this is verified to work unrestricted on the public RPC
 * for this program. Throws (rather than picking one) if more than one is
 * found — this adapter's own `buildRequestRedeem` never creates a second
 * ticket while one is outstanding, so multiple here means a ticket was
 * opened outside this app and needs external resolution.
 */
async function findOutstandingTicket(
  connection: Connection,
  vault: PublicKey,
  staker: PublicKey,
): Promise<TicketInfo | null> {
  const accounts = await connection.getProgramAccounts(VAULT_PROGRAM_ID, {
    filters: [
      { dataSize: TICKET_SIZE },
      { memcmp: { offset: 8, bytes: vault.toBase58() } },
      { memcmp: { offset: T_STAKER, bytes: staker.toBase58() } },
    ],
  });
  if (accounts.length === 0) return null;
  if (accounts.length > 1) {
    throw new DefiError(
      "withdraw_failed",
      "jito-vault-deposit: more than one pending withdrawal ticket exists for this wallet; resolve at kyros.fi before requesting another",
    );
  }
  const { pubkey, account } = accounts[0];
  const d = account.data;
  return {
    address: pubkey,
    staker: new PublicKey(d.subarray(T_STAKER, T_STAKER + 32)),
    base: new PublicKey(d.subarray(T_BASE, T_BASE + 32)),
    vrtAmount: d.readBigUInt64LE(T_VRT_AMOUNT),
    slotUnstaked: d.readBigUInt64LE(T_SLOT_UNSTAKED),
  };
}

async function buildVaultRequestRedeem(
  connection: Connection,
  fromPubkey: PublicKey,
  target: { vault: PublicKey; mint: PublicKey },
  amount: bigint | "MAX",
): Promise<UnsignedCall> {
  if (amount !== "MAX") {
    throw new DefiError(
      "withdraw_failed",
      "jito-vault-deposit: withdrawal requests must be for the full (MAX) balance — see adapter header for why a partial amount can't be sized safely here",
    );
  }
  const { vault, mint } = target;
  const v = await readVault(connection, vault);
  if (!v.supportedMint.equals(mint)) {
    throw new DefiError(
      "deposit_failed",
      "jito-vault-deposit: vault's on-chain supported mint does not match the resolved target",
    );
  }
  if (v.isPaused) {
    throw new DefiError(
      "strategy_paused",
      "jito-vault-deposit: vault is paused",
    );
  }
  if (!v.mintBurnAdmin.equals(PublicKey.default)) {
    throw new DefiError(
      "strategy_not_configured",
      "jito-vault-deposit: this vault requires a delegated mint signer, not supported",
    );
  }

  const existing = await findOutstandingTicket(connection, vault, fromPubkey);
  if (existing) {
    throw new DefiError(
      "cooldown_in_progress",
      "jito-vault-deposit: a withdrawal is already pending for this wallet",
    );
  }

  const stakerVrtTokenAccount = getAssociatedTokenAddressSync(
    v.vrtMint,
    fromPubkey,
    false,
    TOKEN_PROGRAM_ID,
  );
  const vrtBalance = await connection
    .getTokenAccountBalance(stakerVrtTokenAccount)
    .then((r) => BigInt(r.value.amount))
    .catch(() => 0n);
  if (vrtBalance <= 0n) {
    throw new DefiError(
      "position_not_found",
      "jito-vault-deposit: no position",
    );
  }

  const base = Keypair.generate();
  const [ticket] = PublicKey.findProgramAddressSync(
    [Buffer.from(TICKET_SEED), vault.toBuffer(), base.publicKey.toBuffer()],
    VAULT_PROGRAM_ID,
  );
  const ticketVrtTokenAccount = getAssociatedTokenAddressSync(
    v.vrtMint,
    ticket,
    true,
    TOKEN_PROGRAM_ID,
  );

  const createTicketVrtAtaIx =
    createAssociatedTokenAccountIdempotentInstruction(
      fromPubkey,
      ticketVrtTokenAccount,
      ticket,
      v.vrtMint,
      TOKEN_PROGRAM_ID,
    );

  const data = Buffer.alloc(9);
  data.writeUInt8(IX_ENQUEUE_WITHDRAWAL, 0);
  data.writeBigUInt64LE(vrtBalance, 1);

  const enqueueIx = new TransactionInstruction({
    programId: VAULT_PROGRAM_ID,
    keys: [
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: ticket, isSigner: false, isWritable: true },
      { pubkey: ticketVrtTokenAccount, isSigner: false, isWritable: true },
      { pubkey: fromPubkey, isSigner: true, isWritable: true },
      { pubkey: stakerVrtTokenAccount, isSigner: false, isWritable: true },
      { pubkey: base.publicKey, isSigner: true, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  return {
    kind: "solana-ix",
    instructions: [createTicketVrtAtaIx, enqueueIx],
    additionalSigners: [base],
  };
}

async function buildVaultClaimRedeem(
  connection: Connection,
  fromPubkey: PublicKey,
  target: { vault: PublicKey; mint: PublicKey },
): Promise<UnsignedCall> {
  const { vault, mint } = target;
  const v = await readVault(connection, vault);
  if (!v.supportedMint.equals(mint)) {
    throw new DefiError(
      "deposit_failed",
      "jito-vault-deposit: vault's on-chain supported mint does not match the resolved target",
    );
  }
  const ticket = await findOutstandingTicket(connection, vault, fromPubkey);
  if (!ticket) {
    throw new DefiError(
      "position_not_found",
      "jito-vault-deposit: no pending withdrawal to claim",
    );
  }
  const config = await readConfig(connection);
  const slot = BigInt(await connection.getSlot("confirmed"));
  if (!isWithdrawable(ticket, slot, config.epochLength)) {
    throw new DefiError(
      "cooldown_in_progress",
      "jito-vault-deposit: the withdrawal cooldown has not elapsed yet",
    );
  }

  const vaultTokenAccount = getAssociatedTokenAddressSync(
    mint,
    vault,
    true,
    TOKEN_PROGRAM_ID,
  );
  const stakerTokenAccount = getAssociatedTokenAddressSync(
    mint,
    fromPubkey,
    false,
    TOKEN_PROGRAM_ID,
  );
  const ticketVrtTokenAccount = getAssociatedTokenAddressSync(
    v.vrtMint,
    ticket.address,
    true,
    TOKEN_PROGRAM_ID,
  );
  const vaultFeeTokenAccount = getAssociatedTokenAddressSync(
    v.vrtMint,
    v.feeWallet,
    true,
    TOKEN_PROGRAM_ID,
  );
  const programFeeTokenAccount = getAssociatedTokenAddressSync(
    v.vrtMint,
    config.programFeeWallet,
    true,
    TOKEN_PROGRAM_ID,
  );

  const createStakerTokenAtaIx =
    createAssociatedTokenAccountIdempotentInstruction(
      fromPubkey,
      stakerTokenAccount,
      fromPubkey,
      mint,
      TOKEN_PROGRAM_ID,
    );

  const data = Buffer.alloc(1);
  data.writeUInt8(IX_BURN_WITHDRAWAL_TICKET, 0);

  const burnIx = new TransactionInstruction({
    programId: VAULT_PROGRAM_ID,
    keys: [
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: v.vrtMint, isSigner: false, isWritable: true },
      { pubkey: fromPubkey, isSigner: false, isWritable: true },
      { pubkey: stakerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: ticket.address, isSigner: false, isWritable: true },
      { pubkey: ticketVrtTokenAccount, isSigner: false, isWritable: true },
      { pubkey: vaultFeeTokenAccount, isSigner: false, isWritable: true },
      { pubkey: programFeeTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  return {
    kind: "solana-ix",
    instructions: [createStakerTokenAtaIx, burnIx],
  };
}

async function readVaultAsyncRequest(
  connection: Connection,
  vault: PublicKey,
  staker: PublicKey,
): Promise<AsyncRequestState | null> {
  const ticket = await findOutstandingTicket(connection, vault, staker);
  if (!ticket) {
    return { phase: "redeem", requestId: "0", pending: 0n, claimable: 0n };
  }
  const config = await readConfig(connection);
  const slot = BigInt(await connection.getSlot("confirmed"));
  const ready = isWithdrawable(ticket, slot, config.epochLength);
  return {
    phase: "redeem",
    requestId: ticket.address.toBase58(),
    pending: ready ? 0n : ticket.vrtAmount,
    claimable: ready ? ticket.vrtAmount : 0n,
  };
}

async function readVaultPosition(
  walletAddress: string,
  target: DepositTarget & { kind: "jito-vault-deposit" },
): Promise<DefiPosition | null> {
  const connection = makeConnection(undefined);
  const vault = new PublicKey(target.vault);
  const owner = new PublicKey(walletAddress);

  const v = await readVault(connection, vault);
  const vrtAta = getAssociatedTokenAddressSync(
    v.vrtMint,
    owner,
    false,
    TOKEN_PROGRAM_ID,
  );
  const vrtBalance = await connection
    .getTokenAccountBalance(vrtAta)
    .then((r) => BigInt(r.value.amount))
    .catch(() => 0n);
  if (vrtBalance <= 0n) return null;
  if (v.vrtSupply <= 0n) return null;

  const currentAmount = (vrtBalance * v.tokensDeposited) / v.vrtSupply;
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

export const JitoVaultDepositAdapter: DefiProtocolAdapter = {
  slug: SLUG,
  namespace: "solana",
  kind: "liquid_staking",
  chainId: CLUSTER,
  displayName: "Kyros",
  staticSafetyScore: 62,
  targetKinds: ["jito-vault-deposit"],

  async buildDeposit({
    wallet,
    chain,
    amount,
    target,
  }: BuildDepositArgs): Promise<UnsignedCall> {
    if (chain.namespace !== "solana") {
      throw new DefiError(
        "unsupported_chain",
        "jito-vault-deposit: requires solana namespace",
      );
    }
    const t = requireTarget(target);
    const connection = makeConnection(chain.rpcUrl);
    const fromPubkey = new PublicKey(wallet.address);
    return buildVaultDeposit(connection, fromPubkey, t, amount);
  },

  /**
   * The synchronous entry point is deliberately unavailable — same
   * discipline as `asyncVault.ts`'s `buildWithdraw`. A caller that reaches
   * this has routed a two-phase exit through the sync path.
   */
  buildWithdraw(): Promise<UnsignedCall> {
    throw new DefiError(
      "withdraw_failed",
      "jito-vault-deposit: use buildRequestRedeem / buildClaimRedeem (two-phase, see adapter header)",
    );
  },

  async buildRequestRedeem({
    wallet,
    chain,
    amount,
    target,
  }: BuildWithdrawArgs): Promise<UnsignedCall> {
    if (chain.namespace !== "solana") {
      throw new DefiError(
        "unsupported_chain",
        "jito-vault-deposit: requires solana namespace",
      );
    }
    const t = requireTarget(target);
    const connection = makeConnection(chain.rpcUrl);
    const fromPubkey = new PublicKey(wallet.address);
    return buildVaultRequestRedeem(connection, fromPubkey, t, amount);
  },

  async buildClaimRedeem({
    wallet,
    chain,
    target,
  }: BuildWithdrawArgs): Promise<UnsignedCall> {
    if (chain.namespace !== "solana") {
      throw new DefiError(
        "unsupported_chain",
        "jito-vault-deposit: requires solana namespace",
      );
    }
    const t = requireTarget(target);
    const connection = makeConnection(chain.rpcUrl);
    const fromPubkey = new PublicKey(wallet.address);
    return buildVaultClaimRedeem(connection, fromPubkey, t);
  },

  async readAsyncRequest(
    walletAddress: string,
    ctx: PositionReadContext,
  ): Promise<AsyncRequestState | null> {
    if (ctx.target?.kind !== "jito-vault-deposit") return null;
    try {
      const rpcUrl =
        ctx.chain?.namespace === "solana" ? ctx.chain.rpcUrl : undefined;
      const connection = makeConnection(rpcUrl);
      return await readVaultAsyncRequest(
        connection,
        new PublicKey(ctx.target.vault),
        new PublicKey(walletAddress),
      );
    } catch (err) {
      devWarn("readAsyncRequest", err);
      return null;
    }
  },

  async readPosition(
    walletAddress: string,
    ctx?: PositionReadContext,
  ): Promise<DefiPosition | null> {
    if (ctx?.target?.kind !== "jito-vault-deposit") return null;
    try {
      return await readVaultPosition(
        walletAddress,
        ctx.target as DepositTarget & { kind: "jito-vault-deposit" },
      );
    } catch (err) {
      devWarn("readPosition", err);
      return null;
    }
  },
};
