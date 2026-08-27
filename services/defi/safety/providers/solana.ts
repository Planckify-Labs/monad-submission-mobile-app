/**
 * The `solana` ChainSafetyProvider (spec §11.0b, §11.4, mirrors
 * `providers/eip155.ts`'s header exactly: "Every check is written against
 * this interface, not against a chain SDK... Adding a chain is implementing
 * a provider — never editing a check.").
 *
 * Registering this is what makes every Solana `DepositTarget.kind` reachable
 * through the safety pipeline at all — before this file, `getChainSafetyProvider("solana")`
 * returned `null` and `TargetHasCodeCheck` (layer 1) failed EVERY Solana
 * target closed with `unsupported_chain`, regardless of anything else. That
 * was the real, structural reason no Solana DeFi adapter shipped in any
 * prior session was reachable from the agent's `defi_deposit`/
 * `defi_withdraw` tools — found and fixed 2026-08-27 alongside wiring
 * `services/agent-executors/defi/writes.ts` to actually submit a
 * `solana-ix` `UnsignedCall` (see that file's own header note).
 *
 * **Scope, honestly stated per method** (this file does NOT pretend every
 * required method is equally deep for every kind — see each method's own
 * comment):
 *
 *   - `targetExists`/`isAllowlisted`/`readUnderlying`/`assertChainBinding`/
 *     `simulate`/`readPositionDelta`/`readBalance` are REAL for every
 *     currently-registered Solana kind (`solana-lst-stake`, `solana-reserve`,
 *     `kamino-kvault`, `raydium-cpmm-pool`, `raydium-amm-v4-pool`,
 *     `raydium-stable-pool`, `kamino-liquidity-strategy`,
 *     `jito-vault-deposit`) — see `destinationOf`'s per-kind map, all
 *     addresses pinned from the adapters' own already-verified constants
 *     (never re-typed from memory: grepped out of each adapter file).
 *   - `decodeIntent` is FULLY decoded (destination, assetIn, amountIn,
 *     recipient) only for `jito-vault-deposit` and `kamino-kvault` — the two
 *     single-asset kinds where the built instruction's arguments map
 *     directly onto `ctx.requestedAmount`/`ctx.wallet`. For the two-legged
 *     LP kinds (the three Raydium kinds + `kamino-liquidity-strategy`) the
 *     on-chain argument is NOT a simple one-to-one mapping to a single
 *     requested amount (Raydium CPMM/AMM-v4/Stable take exact-LP-out/max-
 *     assets-in; kliquidity's deposit lets the program compute the achievable
 *     ratio itself), so `amountIn`/`recipient` are honestly left `null`
 *     (skips those two sub-assertions in `DecodedIntentMatchCheck`, exactly
 *     the same "not one of the shapes we encode" fallback `eip155.ts` uses
 *     for Curve/Solidly/Balancer/router-call) — `destination` and `assetIn`
 *     are still asserted for every kind, and `SimulateBeforeSignCheck`
 *     (mandatory, every kind) is the universal backstop regardless.
 *   - `isProtocolHalted` has a real on-chain read only for
 *     `jito-vault-deposit` (`Vault.is_paused`). Every other kind answers
 *     `false` — the SAME default `eip155.ts` uses for every EVM kind that
 *     has no known pause primitive (aave-v3, curve-lp, uniswap-v2, …); not a
 *     Solana-specific gap.
 *   - `readExitTerms` is implemented per kind (see the method). It was
 *     MISSING in the first version of this file, and the consequence was not
 *     a softer check — it was a total outage: `ExitTermsConsentCheck` treats
 *     "provider docked, capability absent" as a refusal, so every Solana
 *     deposit failed Layer 3 with `exit_terms_unknown` while the catalogue
 *     went on badging those pools "Deposit in-app". Fail-closed did its job;
 *     nothing else did. Found and fixed 2026-08-27.
 *   - `isAllowedDestination` binds the BUILT call to this kind's pinned
 *     program (see the method) — the assertion `DecodedIntentMatchCheck`'s
 *     doc always described and no provider actually performed.
 *   - `readDecimals` is implemented (SPL mints always expose it cheaply).
 *     `finalityDepth`/`supportsPrivateSubmit`/`readDepositCapHeadroom` stay
 *     unset: the interface documents them as safe to omit, and each is a
 *     claim we cannot honestly make yet (no confirmation count reaches the
 *     postexec context, no private-mempool route is wired, and none of these
 *     kinds exposes a readable deposit cap).
 */

import { getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import {
  getSolanaLstConfig,
  isSolanaLstVenue,
} from "../../adapters/solana/lst.config";
import { getDefiAdapterForKind } from "../../registry";
import type { DepositTarget, UnsignedCall } from "../../types";
import { NATIVE_ASSET_SENTINEL, targetUnderlying } from "../../types";
import type {
  ChainSafetyProvider,
  DecodedIntent,
  ExitTerms,
  SafetyContext,
  SimResult,
} from "../types";

/** Mirrors `eip155.ts`'s resolver-hook pattern exactly. */
type SolanaChainResolver = (chainId: number | string) => ChainConfig | null;
let resolveChain: SolanaChainResolver = () => null;
export function setSolanaChainResolver(resolver: SolanaChainResolver): void {
  resolveChain = resolver;
}

const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";

function rpcUrlFor(chainId: number | string): string {
  const config = resolveChain(chainId);
  if (config && config.namespace === "solana") return config.rpcUrl;
  return DEFAULT_RPC_URL;
}

function connectionFor(chainId: number | string): Connection {
  return new Connection(rpcUrlFor(chainId), "confirmed");
}

// ── Pinned program ids — grepped from each adapter's own already-verified
// constant, never re-typed from memory. ─────────────────────────────────
const KLEND_PROGRAM_ID = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const KVAULT_PROGRAM_ID = "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd";
const CPMM_PROGRAM_ID = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const AMM_V4_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const STABLE_PROGRAM_ID = "5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h";
const KAMINO_LIQUIDITY_PROGRAM_ID =
  "6LtLpnUFNByNXLyCoK9wA2MykKAmQNZKBdY8s47dehDc";
const JITO_VAULT_PROGRAM_ID = "Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8";
/** `PROGRAM_IDS.lending.main` from the bundled `@jup-ag/lend` SDK — the same
 *  constant `adapters/jupiterLend.ts` builds against (its header records the
 *  cross-check against the protocol's own published IDL). */
const JUPITER_LEND_PROGRAM_ID = "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9";
/** Owner of any deployed upgradeable program account. Verified live for
 *  `JUPITER_LEND_PROGRAM_ID` (getAccountInfo, 2026-08-27: `executable: true`,
 *  `owner: BPFLoaderUpgradeab1e…`). */
const BPF_LOADER_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";

/**
 * Programs that may appear in a built call WITHOUT being the protocol itself:
 * account plumbing every Solana transaction needs (create the ATA, wrap SOL,
 * set a compute budget). They move nothing on their own — a token transfer
 * still needs the user's signature, and the recipient assertion covers where
 * it lands — so allowing them is not a hole, while refusing them would reject
 * essentially every real deposit this app builds.
 */
const INFRASTRUCTURE_PROGRAM_IDS: ReadonlySet<string> = new Set([
  "11111111111111111111111111111111", // System
  "ComputeBudget111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token Account
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", // Memo v2
]);

/** The account a target's on-chain identity actually lives at, per kind,
 * plus the program that MUST own it — pinned here, never trusted from the
 * target itself (a `solana-reserve` target's own `program` field is
 * server-resolved and therefore exactly the kind of value this check exists
 * to independently verify, not to trust). */
function destinationOf(
  target: DepositTarget,
): { address: PublicKey; expectedOwner: PublicKey } | null {
  switch (target.kind) {
    case "solana-lst-stake": {
      if (!isSolanaLstVenue(target.venue)) return null;
      const cfg = getSolanaLstConfig(target.venue);
      const address =
        cfg.shape === "spl-stake-pool" ? cfg.stakePool : cfg.state;
      return {
        address: new PublicKey(address),
        expectedOwner: new PublicKey(cfg.program),
      };
    }
    case "solana-reserve":
      return {
        address: new PublicKey(target.reserve),
        expectedOwner: new PublicKey(KLEND_PROGRAM_ID),
      };
    case "kamino-kvault":
      return {
        address: new PublicKey(target.vault),
        expectedOwner: new PublicKey(KVAULT_PROGRAM_ID),
      };
    case "raydium-cpmm-pool":
      return {
        address: new PublicKey(target.pool),
        expectedOwner: new PublicKey(CPMM_PROGRAM_ID),
      };
    case "raydium-amm-v4-pool":
      return {
        address: new PublicKey(target.pool),
        expectedOwner: new PublicKey(AMM_V4_PROGRAM_ID),
      };
    case "raydium-stable-pool":
      return {
        address: new PublicKey(target.pool),
        expectedOwner: new PublicKey(STABLE_PROGRAM_ID),
      };
    case "kamino-liquidity-strategy":
      return {
        address: new PublicKey(target.strategy),
        expectedOwner: new PublicKey(KAMINO_LIQUIDITY_PROGRAM_ID),
      };
    case "jito-vault-deposit":
      return {
        address: new PublicKey(target.vault),
        expectedOwner: new PublicKey(JITO_VAULT_PROGRAM_ID),
      };
    // The one Solana kind whose target carries NO address: Jupiter Lend Earn
    // routes by underlying mint (`{ kind, asset }`) and the SDK derives every
    // account from it, so there is no per-vault account to own-check. What
    // IS checkable, and what this kind's Layer-1 therefore asserts, is that
    // the pinned lending program is a deployed program: an executable account
    // owned by the BPF upgradeable loader. The asset itself is bound
    // separately, by `readUnderlying` → `UnderlyingMatchesCheck`, against the
    // server-resolved pool's own underlying.
    //
    // Before this case existed `destinationOf` returned `null` here, so
    // `targetExists` answered `false` and EVERY Jupiter Lend deposit failed
    // Layer 1 with `target_not_a_contract` (found 2026-08-27).
    case "jupiter-lend-vault":
      return {
        address: new PublicKey(JUPITER_LEND_PROGRAM_ID),
        expectedOwner: new PublicKey(BPF_LOADER_UPGRADEABLE),
      };
    default:
      return null;
  }
}

/**
 * The program a given kind's protocol instruction must belong to. Exported so
 * the offline coverage test can assert that EVERY Solana kind resolves to a
 * pin — from outside, a missing pin and a wrong destination both surface as a
 * plain `false`, which is exactly how the `jupiter-lend-vault` gap survived. Same pins as
 * `destinationOf`'s `expectedOwner`, read from the other direction: that map
 * answers "who owns this account", this one answers "whose instruction may
 * this call carry".
 */
export function protocolProgramFor(target: DepositTarget): string | null {
  switch (target.kind) {
    case "solana-lst-stake":
      return isSolanaLstVenue(target.venue)
        ? getSolanaLstConfig(target.venue).program
        : null;
    case "solana-reserve":
      return KLEND_PROGRAM_ID;
    case "kamino-kvault":
      return KVAULT_PROGRAM_ID;
    case "raydium-cpmm-pool":
      return CPMM_PROGRAM_ID;
    case "raydium-amm-v4-pool":
      return AMM_V4_PROGRAM_ID;
    case "raydium-stable-pool":
      return STABLE_PROGRAM_ID;
    case "kamino-liquidity-strategy":
      return KAMINO_LIQUIDITY_PROGRAM_ID;
    case "jito-vault-deposit":
      return JITO_VAULT_PROGRAM_ID;
    case "jupiter-lend-vault":
      return JUPITER_LEND_PROGRAM_ID;
    default:
      return null;
  }
}

// ── jito-vault-deposit instruction shapes (see adapters/jitoVaultDeposit.ts
// for the full verification story — these mirror its constants exactly). ──
const JITO_IX_MINT_TO = 11;
const JITO_IX_ENQUEUE_WITHDRAWAL = 12;
const JITO_IX_BURN_WITHDRAWAL_TICKET = 14;

// ── kamino-kvault instruction shapes (see adapters/kaminoKvault.ts). ──────
const KVAULT_IX_DEPOSIT = "f223c68952e1f2b6";
const KVAULT_IX_WITHDRAW = "1383709baadc2239";

type SolanaInstruction = Extract<
  UnsignedCall,
  { kind: "solana-ix" }
>["instructions"][number];

/**
 * Decode the ONE fully-understood shape per fully-decoded kind, identified
 * purely from the LAST instruction's own `programId` — `decodeIntent` gets
 * only `call` (no resolved target: that is the interface's own contract,
 * shared with `eip155.ts`), so kind inference has to come from the call
 * itself. This works because these two programs are pinned, fixed
 * constants unique to their kind (unlike `solana-lst-stake`, which spans
 * multiple programs and is left undecoded below). See file header for why
 * only these two kinds get amountIn/recipient at all.
 */
function decodeKnownIntent(
  lastIx: SolanaInstruction,
): Pick<DecodedIntent, "amountIn" | "recipient"> {
  const programId = lastIx.programId.toBase58();
  const data = Buffer.from(lastIx.data);

  if (programId === JITO_VAULT_PROGRAM_ID) {
    const disc = data.length > 0 ? data.readUInt8(0) : -1;
    if (disc === JITO_IX_MINT_TO) {
      return {
        amountIn: data.length >= 9 ? data.readBigUInt64LE(1) : null,
        recipient: lastIx.keys[3]?.pubkey.toBase58() ?? null,
      };
    }
    if (disc === JITO_IX_ENQUEUE_WITHDRAWAL) {
      return {
        amountIn: data.length >= 9 ? data.readBigUInt64LE(1) : null,
        recipient: lastIx.keys[4]?.pubkey.toBase58() ?? null,
      };
    }
    if (disc === JITO_IX_BURN_WITHDRAWAL_TICKET) {
      return {
        amountIn: null,
        recipient: lastIx.keys[4]?.pubkey.toBase58() ?? null,
      };
    }
    return { amountIn: null, recipient: null };
  }

  if (programId === KVAULT_PROGRAM_ID) {
    const discHex = data.subarray(0, 8).toString("hex");
    if (discHex === KVAULT_IX_DEPOSIT || discHex === KVAULT_IX_WITHDRAW) {
      return {
        amountIn: data.length >= 16 ? data.readBigUInt64LE(8) : null,
        recipient: lastIx.keys[0]?.pubkey.toBase58() ?? null,
      };
    }
    return { amountIn: null, recipient: null };
  }

  return { amountIn: null, recipient: null };
}

async function ownerOf(
  connection: Connection,
  address: PublicKey,
): Promise<PublicKey | null> {
  try {
    const info = await connection.getAccountInfo(address);
    return info?.owner ?? null;
  } catch {
    return null;
  }
}

export const SolanaSafetyProvider: ChainSafetyProvider = {
  namespace: "solana",

  /** L1: the destination account exists at all. */
  async targetExists(target, chainId) {
    const dest = destinationOf(target);
    if (!dest) return false;
    const connection = connectionFor(chainId);
    const info = await connection
      .getAccountInfo(dest.address)
      .catch(() => null);
    return info !== null;
  },

  /** L1: the deposited asset identity — pure, no RPC needed (every Solana
   * kind's identity is already carried on the resolved target itself). */
  async readUnderlying(target) {
    return targetUnderlying(target);
  },

  /** L1: the destination account's on-chain owner is the exact pinned
   * program for this kind — never trusts a target-supplied `program`
   * field as self-validating. */
  async isAllowlisted(target, chainId) {
    const dest = destinationOf(target);
    if (!dest) return false;
    const connection = connectionFor(chainId);
    const owner = await ownerOf(connection, dest.address);
    return owner !== null && owner.equals(dest.expectedOwner);
  },

  /** L4: there is no Solana analogue of an EIP-155 chainId to bind against
   * — a Solana tx's blockhash lifetime is inherent to whichever cluster's
   * RPC built it. What this asserts is that the call is genuinely a
   * `solana-ix` call (never an EVM/Sui call misrouted through this
   * provider) and that this namespace's RPC is resolvable. */
  assertChainBinding(call, chainId) {
    if (call.kind !== "solana-ix") return false;
    return rpcUrlFor(chainId) !== "";
  },

  /**
   * L4: decode the built instructions into the normalised intent. The
   * interface hands this ONLY `call` (same contract `eip155.ts` has —
   * `LAYER4_CHECKS` always calls it as `provider.decodeIntent(ctx.call)`),
   * so `destination` comes straight off the last instruction's own
   * `programId` (no target needed for that part) and `assetIn` is left
   * `null` generically — Layer 1's `UnderlyingMatchesCheck` already asserts
   * the resolved target's underlying against the pool's expected asset
   * BEFORE this ever runs, using the real target it DOES have; re-asserting
   * it here would need the same target this interface deliberately doesn't
   * pass to this method, and duplicating that check is not worth a
   * ctx-shaped guess. See file header for the FULL-vs-PARTIAL split on
   * `amountIn`/`recipient` per kind (identified from `programId` alone).
   */
  async decodeIntent(call): Promise<DecodedIntent | null> {
    if (call.kind !== "solana-ix") return null;
    if (call.instructions.length === 0) return null;

    const lastIx = call.instructions[call.instructions.length - 1];
    const { amountIn, recipient } = decodeKnownIntent(lastIx);

    return {
      destination: lastIx.programId.toBase58(),
      action: "unknown",
      assetIn: null,
      amountIn,
      recipient,
      valueNative: 0n,
      spender: null,
      approvalAmount: null,
      minOut: null,
      deadline: null,
    };
  },

  /** L4: `simulateTransaction` without broadcasting — the SAME method this
   * whole Solana DeFi expansion has used to verify every adapter's built
   * instructions all session, now run generically for every kind through
   * the actual safety pipeline rather than only in a scratch script. */
  async simulate(call, ctx): Promise<SimResult> {
    if (call.kind !== "solana-ix") return { ok: true };
    const connection = connectionFor(ctx.chainId);
    try {
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      const { TransactionMessage, VersionedTransaction } = await import(
        "@solana/web3.js"
      );
      const message = new TransactionMessage({
        payerKey: new PublicKey(ctx.wallet),
        recentBlockhash: blockhash,
        instructions: call.instructions,
      }).compileToV0Message();
      const tx = new VersionedTransaction(message);
      const res = await connection.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: false,
        commitment: "confirmed",
      });
      if (res.value.err) {
        return {
          ok: false,
          revertReason:
            typeof res.value.err === "string"
              ? res.value.err
              : JSON.stringify(res.value.err),
        };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        revertReason: err instanceof Error ? err.name : "simulation error",
      };
    }
  },

  /** L5: only `jito-vault-deposit` has a known on-chain pause flag today —
   * `false` default for everything else mirrors `eip155.ts`'s own default
   * for every EVM kind without a known pause primitive. */
  async isProtocolHalted(target, chainId) {
    if (target.kind !== "jito-vault-deposit") return false;
    const connection = connectionFor(chainId);
    const info = await connection
      .getAccountInfo(new PublicKey(target.vault))
      .catch(() => null);
    if (!info) return false;
    const IS_PAUSED_OFFSET = 851; // see adapters/jitoVaultDeposit.ts
    return info.data.length > IS_PAUSED_OFFSET
      ? info.data[IS_PAUSED_OFFSET] !== 0
      : false;
  },

  /** L5: reuse the kind's OWN already-verified `readPosition` rather than
   * re-deriving each kind's receipt-balance logic a second time here. */
  async readPositionBalance(target, owner, chainId) {
    const adapter = getDefiAdapterForKind(target.kind);
    // No adapter ⇒ nothing can read this position. `null`, not `0n`: an
    // unreadable position must not look like an empty one to the postexec
    // delta check (see `readPositionBalance`'s contract).
    if (!adapter) return null;
    const rpcUrl = rpcUrlFor(chainId);
    const chain = {
      namespace: "solana",
      rpcUrl,
      cluster: String(chainId),
    } as unknown as ChainConfig;
    try {
      const position = await adapter.readPosition(owner, { target, chain });
      // A `null` position is a real, readable ZERO (the wallet has not
      // deposited here yet) — that is the state a first deposit must be
      // measurable against, so it must not be reported as unreadable. Only
      // a THROWN read below becomes `null`.
      return position?.currentAmount ?? 0n;
    } catch {
      return null;
    }
  },

  /** L2: native SOL or SPL balance for the wallet. `NATIVE_ASSET_SENTINEL`
   * is the SAME sentinel `writes.ts` already falls back to for a Solana
   * kind with no named input asset (`targetUnderlying` returning `null`) —
   * reused as-is, not a new Solana-specific marker. */
  async readBalance(asset, owner, chainId) {
    const connection = connectionFor(chainId);
    try {
      if (asset === NATIVE_ASSET_SENTINEL) {
        const lamports = await connection.getBalance(
          new PublicKey(owner),
          "confirmed",
        );
        return BigInt(lamports);
      }
      const mint = new PublicKey(asset);
      const ata = getAssociatedTokenAddressSync(
        mint,
        new PublicKey(owner),
        true,
      );
      const bal = await connection
        .getTokenAccountBalance(ata)
        .catch(() => null);
      return bal ? BigInt(bal.value.amount) : 0n;
    } catch {
      return null;
    }
  },

  /**
   * L4: every top-level instruction in the built call belongs either to this
   * kind's own pinned program or to the account-plumbing set. Solana's
   * "destination" is plural — a transaction is a LIST of instructions — so
   * asserting only the one `decodeIntent` surfaced would leave an appended
   * leg to an arbitrary program unexamined, which is precisely the shape this
   * assertion exists to refuse. The `call` the check hands over is what makes
   * the plural version possible.
   *
   * A kind with no pinned program returns `false`: Layer 1 has already
   * refused it (`destinationOf` is the same map), and agreeing here would be
   * the second half of a contradiction.
   */
  async isAllowedDestination(target, destination, _chainId, call) {
    const expected = protocolProgramFor(target);
    if (!expected) return false;

    const allowed = (programId: string) =>
      programId === expected || INFRASTRUCTURE_PROGRAM_IDS.has(programId);

    if (call && call.kind === "solana-ix") {
      return call.instructions.every((ix) => allowed(ix.programId.toBase58()));
    }
    // No call to widen to (a caller that only has the decoded destination):
    // assert what we were given.
    return allowed(destination);
  },

  /**
   * L5: how long funds are locked on the way out (§12 Q2).
   *
   * The verdict describes THE EXIT THIS APP BUILDS, not every exit the
   * protocol offers — that distinction decides two of the rows below, and
   * getting it backwards would either promise liquidity we don't build or
   * warn about a queue we never enter.
   *
   * Same conservative rule `eip155.ts` uses: liquidity is a Layer-2 problem,
   * a protocol-imposed wait is a lockup, and anything we cannot characterise
   * is `unknown` (which refuses at Layer 3 rather than assuming instant). The
   * `default` is what makes a NEW Solana kind fail closed until someone
   * decides its terms deliberately.
   */
  async readExitTerms(target): Promise<ExitTerms> {
    switch (target.kind) {
      // Money markets, share vaults and AMM pools: withdraw is one call
      // whenever the venue has liquidity. Utilisation/reserve depth is
      // Layer 2's problem, exactly as an Aave reserve at full utilisation is
      // on EVM — an illiquidity condition, not a protocol-imposed wait.
      case "solana-reserve":
      case "kamino-kvault":
      case "jupiter-lend-vault":
      case "raydium-cpmm-pool":
      case "raydium-amm-v4-pool":
      case "raydium-stable-pool":
      case "kamino-liquidity-strategy":
        return { kind: "instant" };

      // Both LST shapes exit in ONE transaction as this adapter builds it:
      // `spl-stake-pool` uses `WithdrawSol`(16), paid out of the pool's
      // reserve, and `marinade` uses `liquid_unstake`, paid out of the
      // liquidity pool (`adapters/solanaLst.ts`). The DELAYED alternatives
      // exist on both protocols — SPL `WithdrawStake` hands back a stake
      // account that must deactivate over an epoch, Marinade's
      // `order_unstake`/`claim` is a ~2-epoch ticket — but this app never
      // builds them, so warning about them would describe someone else's
      // withdraw. Marinade's unstake fee and a drained reserve are Layer-2
      // cost/liquidity questions, not lockups.
      case "solana-lst-stake":
        return { kind: "instant" };

      // Jito restaking vault: `EnqueueWithdrawal`(12) mints a withdrawal
      // ticket, and `BurnWithdrawalTicket`(14) can only pay out once MORE
      // than one full epoch has elapsed (`Config.epoch_length` = 432,000
      // slots on mainnet ⇒ roughly 2-4 days depending on where in the epoch
      // the enqueue landed — read live by the adapter, see
      // `adapters/jitoVaultDeposit.ts`). That is a protocol-imposed wait, and
      // its duration genuinely is not a fixed number, so `queued` rather than
      // a `delayed` with an invented figure.
      //
      // `declared`, not `onchain`, for the same reason `async-vault` and the
      // EVM queue-exit LSTs are: the queue was reviewed when the family was
      // pinned and is documented in the adapter's own header, so it does not
      // need per-deposit consent — the approval card still discloses it
      // through `exitTermsNotice`.
      case "jito-vault-deposit":
        return { kind: "queued", source: "declared" };

      default:
        return { kind: "unknown" };
    }
  },

  /** §11.6 #1: on-chain decimals — SPL mints always expose this cheaply. */
  async readDecimals(asset, chainId) {
    if (asset === NATIVE_ASSET_SENTINEL) return 9; // native SOL
    const connection = connectionFor(chainId);
    try {
      const mint = await getMint(connection, new PublicKey(asset));
      return mint.decimals;
    } catch {
      return null;
    }
  },
};
