/**
 * Typed Stellar transfer / account-precondition errors.
 *
 * Spec reference: `docs/stellar-chain-support-spec.md` §4.1.
 *
 * Mirrors the Sui pattern (`services/chains/sui/errorCodes.ts`): each
 * error has a stable `name` string so executors / UI can branch by
 * `err.name === "..."` without depending on class identity (which can
 * drift across module reloads). These map into
 * `services/agent-executors/types.ts#mapUnknownError` (§4.1) so
 * agent-mode failures surface curated `ExecutorErrorCode` reasons
 * instead of raw text (CLAUDE.md user-facing-errors rule).
 */

/**
 * `loadAccount` 404s for a source (the wallet's own) lookup — the
 * wallet itself has never received XLM and therefore doesn't exist on
 * the ledger yet (spec §1.3 — "Accounts must be created on-ledger
 * before they exist").
 */
export class StellarAccountNotFoundError extends Error {
  override readonly name = "StellarAccountNotFoundError";
  readonly address: string;
  constructor(address: string) {
    super(`Stellar account ${address} does not exist on the ledger yet`);
    this.address = address;
  }
}

/**
 * Destination has no ledger entry yet and the operation being attempted
 * isn't `createAccount` (e.g. a non-native asset payment, which cannot
 * be the first transfer to a new address — spec §3.5).
 */
export class StellarDestinationUnfundedError extends Error {
  override readonly name = "StellarDestinationUnfundedError";
  readonly address: string;
  constructor(address: string) {
    super(
      `Destination ${address} has no ledger entry yet — it must receive XLM (createAccount) first`,
    );
    this.address = address;
  }
}

/**
 * Destination exists but has no trustline to the asset being sent.
 * Surfaced BEFORE submission (via a pre-flight `hasTrustline` check,
 * §4.1) rather than letting the payment round-trip to Horizon just to
 * get `op_no_trust` back.
 */
export class StellarNoTrustlineError extends Error {
  override readonly name = "StellarNoTrustlineError";
  readonly address: string;
  readonly code: string;
  readonly issuer: string;
  constructor(address: string, code: string, issuer: string) {
    super(
      `${address} has no trustline to ${code}:${issuer} — recipient must establish a trustline first`,
    );
    this.address = address;
    this.code = code;
    this.issuer = issuer;
  }
}

/**
 * Establishing a trustline / sending would drop the source below its
 * minimum reserve balance (spec §1.3 — base reserve + subentry reserve
 * math, `accountState.ts#computeMinBalance`).
 */
export class StellarInsufficientReserveError extends Error {
  override readonly name = "StellarInsufficientReserveError";
  constructor(message?: string) {
    super(
      message ?? "Operation would drop the account below its minimum reserve",
    );
  }
}

/**
 * `createAccount`'s `startingBalance` is below the new account's own
 * minimum reserve (1 XLM baseline, spec §1.3 / §3.5).
 */
export class StellarInsufficientCreateAmountError extends Error {
  override readonly name = "StellarInsufficientCreateAmountError";
  readonly startingBalanceStroops: bigint;
  readonly minimumStroops: bigint;
  constructor(startingBalanceStroops: bigint, minimumStroops: bigint) {
    super(
      `startingBalance ${startingBalanceStroops} stroops is below the new account's minimum reserve of ${minimumStroops} stroops`,
    );
    this.startingBalanceStroops = startingBalanceStroops;
    this.minimumStroops = minimumStroops;
  }
}

/**
 * `tx_bad_seq` — another submission consumed the sequence number first
 * (e.g. a rapid double-tap). UX should retry with a freshly reloaded
 * account, not surface a raw code (spec §4.1).
 */
export class StellarSequenceNumberRaceError extends Error {
  override readonly name = "StellarSequenceNumberRaceError";
  constructor() {
    super(
      "Transaction sequence number was consumed by another submission — reload the account and retry",
    );
  }
}

// ── dApp-bridge error codes (docs/stellar-dapp-bridge-spec.md §1.1, §4.1) ──
//
// Two distinct code spaces, both defined here, mirroring the split
// `services/chains/sui/errorCodes.ts` already established:
//   1. `STELLAR_ERROR_CODES` — the JSON-RPC-ish internal codes
//      `StellarAdapter.handleRequest` / `executeApproval` emit on
//      `ChainResult`/thrown `Error`, same code space as
//      EVM/Solana/Sui adapters (4001 user-reject, 4100 unauthorized, …).
//   2. `SEP0043_ERROR_CODES` — the 4-code wire taxonomy SEP-0043 defines
//      (§1.1) and Freighter's own `FreighterApiError.code` uses. The
//      injected script's outermost `.catch` (§1.5/§5.3) maps an internal
//      code to one of these via `toSep0043Code` before posting the
//      `FREIGHTER_EXTERNAL_MSG_RESPONSE` — dApps never see the internal
//      code space directly.

export const STELLAR_ERROR_CODES = {
  /** User pressed Reject in an approval sheet. */
  USER_REJECT: 4001,
  /** No grant / no active Stellar wallet / cross-namespace trust rejection. */
  UNAUTHORIZED: 4100,
  /** Active wallet deleted mid-flight. */
  DISCONNECTED: 4900,
  /** Unsupported feature (SUBMIT_TOKEN §0 non-goal). */
  UNSUPPORTED: 4200,
  /**
   * Soroban contract storage has expired (spec phase E). The invocation
   * cannot run until a `RestoreFootprint` transaction renews it, either
   * because the user declined the restore or because one restore was not
   * enough. Distinct from a generic failure so callers can offer the
   * right next step instead of "try again".
   */
  ARCHIVED_STATE: -32003,
  /** Another approval from this origin already pending. */
  RESOURCE_UNAVAILABLE: -32002,
  /** Invalid params — malformed XDR, address mismatch, bad accountToSign. */
  INVALID_PARAMS: -32602,
  /** Internal failure — signer missing, decoder explosion. */
  INTERNAL: -32603,
  /** Horizon / external-service failure (submit, preflight RPC). */
  EXTERNAL_SERVICE: -32001,
  /** Generic adapter error fallback. */
  GENERIC: -32000,
} as const;

export type StellarErrorCode =
  (typeof STELLAR_ERROR_CODES)[keyof typeof STELLAR_ERROR_CODES];

const VALID_STELLAR_CODES: ReadonlySet<number> = new Set<number>(
  Object.values(STELLAR_ERROR_CODES),
);

/** Assert a code is part of the contract. Throws if it is not. */
export function assertStellarErrorCode(code: number): void {
  if (!VALID_STELLAR_CODES.has(code)) {
    throw new Error(
      `Stellar adapter emitted non-contract error code ${code} — see services/chains/stellar/errorCodes.ts`,
    );
  }
}

/** SEP-0043 §1.1's `Error.code` taxonomy — the wire-level shape dApps see. */
export const SEP0043_ERROR_CODES = {
  INTERNAL: -1,
  EXTERNAL_SERVICE: -2,
  INVALID_REQUEST: -3,
  USER_REJECTED: -4,
} as const;

export type Sep0043ErrorCode =
  (typeof SEP0043_ERROR_CODES)[keyof typeof SEP0043_ERROR_CODES];

/**
 * Maps an internal `STELLAR_ERROR_CODES` value (or any other adapter
 * error code) onto the SEP-0043 4-code wire taxonomy. Used by the
 * injected script's response builder (§5.3/§5.4) — never by the adapter
 * itself, which stays in the internal code space per the project-wide
 * `ChainResult` contract.
 */
export function toSep0043Code(internalCode: number): Sep0043ErrorCode {
  switch (internalCode) {
    case STELLAR_ERROR_CODES.USER_REJECT:
      return SEP0043_ERROR_CODES.USER_REJECTED;
    case STELLAR_ERROR_CODES.UNAUTHORIZED:
    case STELLAR_ERROR_CODES.UNSUPPORTED:
    case STELLAR_ERROR_CODES.INVALID_PARAMS:
    case STELLAR_ERROR_CODES.RESOURCE_UNAVAILABLE:
      return SEP0043_ERROR_CODES.INVALID_REQUEST;
    case STELLAR_ERROR_CODES.EXTERNAL_SERVICE:
      return SEP0043_ERROR_CODES.EXTERNAL_SERVICE;
    default:
      return SEP0043_ERROR_CODES.INTERNAL;
  }
}
