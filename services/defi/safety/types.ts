/**
 * Safety layer — chain-agnostic types (docs/defi-evm-protocol-expansion-spec.md
 * §11.0, §11.5).
 *
 * We route user funds into third-party contracts, with an LLM proposing intents
 * and external APIs supplying data. No single check is sufficient, so safety is
 * a **pipeline of independent layers**, each fail-closed, ordered cheapest and
 * earliest first. A target must clear **every** layer that applies to its kind.
 *
 * **Chain-agnostic by construction.** The protocol families this was written
 * for are EVM, but the taxonomy is not: only the *primitive* used to satisfy a
 * check differs per chain, and each chain docks its primitives in through
 * `ChainSafetyProvider`. Adding a chain is implementing a provider — never
 * editing a check. That is why the checks compile against `DecodedIntent` and
 * `SafetyContext` and nothing else: adding EVM's allowance rules did not teach
 * the runner about ERC-20, and adding Stellar trustlines won't either.
 */

import type { Namespace } from "@/services/chains/types";
import type { DefiErrorCode } from "../errors/defiErrors";
import type {
  DepositTarget,
  DepositTargetKind,
  RiskTier,
  UnsignedCall,
} from "../types";

/** Layer index, cheapest/earliest (0) to most expensive/latest (6). */
export type SafetyLayer = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * What the pipeline is being asked to authorise. A check that only makes
 * sense for one direction of fund flow docks itself to it via
 * `SafetyCheck.appliesTo.actions` — same mechanism as `namespaces` /
 * `kinds` / `stages`, zero runner changes. This is deliberately its own
 * dimension rather than inferred from `stage` or `target.kind`: a check
 * like the exposure/velocity/tier-whitelist policy trio is a ceiling on
 * NEW capital, and blocking it on withdraw would trap a user's funds in
 * exactly the protocol they are trying to leave — the omission has to be
 * explicit and visible at the check's own declaration, not an accident of
 * which context fields happen to be populated.
 *
 * New actions (`claim`, `rebalance`, …) dock the same way: add the union
 * member here, scope any check that shouldn't run for it, done.
 */
export type SafetyAction = "deposit" | "withdraw";

/**
 * Which trust anchor is running (§11.1). The backend owns identity, policy and
 * provenance; the on-device signer owns simulate and the decoded-intent match.
 * Neither alone can authorise a transfer — a compromised backend still can't
 * get past the on-device decode assertion, and a compromised client still can't
 * get a target the backend never resolved.
 */
export type SafetyStage =
  /** Before an adapter builds anything: input shape, policy, economics. */
  | "presign"
  /** After the call is built, before ANY signature: decode, bind, scope the approval. */
  | "submit"
  /**
   * Approvals settled, the protocol call about to be broadcast. Distinct from
   * `submit` because an ERC-20 deposit's allowance does not exist yet at that
   * point: a dry-run there reverts on every first-time deposit and says nothing
   * about the deposit itself.
   */
  | "broadcast"
  /** After the receipt: position delta, finality. */
  | "postexec";

export type SafetyResult =
  | { ok: true }
  | { ok: false; fail: DefiErrorCode; detail?: string };

/**
 * A check declares WHAT it verifies and WHERE it applies — never HOW to talk to
 * a chain. An omitted `appliesTo` field means "all".
 */
export interface SafetyCheck {
  /** Stable id, e.g. "target-has-code". Appears in the audit trail. */
  readonly id: string;
  readonly layer: SafetyLayer;
  readonly appliesTo?: {
    readonly namespaces?: readonly Namespace[];
    readonly kinds?: readonly DepositTargetKind[];
    readonly stages?: readonly SafetyStage[];
    readonly actions?: readonly SafetyAction[];
  };
  run(ctx: SafetyContext): Promise<SafetyResult>;
}

/**
 * What the built call actually does, chain-normalised
 * (`provider.decodeIntent`). This is the vocabulary that makes a check like
 * "the recipient is the user's own wallet" identical on all four chains — EVM
 * decodes calldata, Sui inspects PTB moveCalls, Solana inspects instruction
 * program-ids, and all of them collapse to this one struct.
 */
export interface DecodedIntent {
  /** eip155 `to` · solana programId · sui pkg::mod::fn · stellar contract. */
  destination: string;
  action: "deposit" | "withdraw" | "approve" | "stake" | "claim" | "unknown";
  /** Token address / mint / coinType / asset code. */
  assetIn: string | null;
  amountIn: bigint | null;
  /** MUST equal the user's own wallet. */
  recipient: string | null;
  /** Native coin attached (ETH/SOL/SUI/XLM). */
  valueNative: bigint;
  /** Approval grantee (== destination, or null). */
  spender: string | null;
  /** Exact; never unbounded. */
  approvalAmount: bigint | null;
  /** Slippage floor for LP / router / min-out vaults. */
  minOut: bigint | null;
  /** Quote or transaction expiry (unix seconds). */
  deadline: number | null;
}

/**
 * When the user can get their money back out (§11 Layer 3/5).
 *
 * There is no ERC that declares a lockup, so this is deliberately a *verdict*
 * rather than a number: a cooldown vault, a withdrawal-queue LST and a plain
 * money market are indistinguishable through the ERC-4626 interface alone, and
 * a deposit the user cannot exit is a real loss even when nothing was stolen.
 *
 * `unknown` is NOT "probably fine" — it is the fail-closed value. A protocol we
 * cannot characterise must not be badged as instantly withdrawable, because the
 * failure mode is a user whose funds are locked for a month they never agreed
 * to (see `adapters/asyncVault.ts` for the same reasoning applied to Tier 4).
 */
export type ExitTerms =
  /** Proven withdrawable in one transaction, now. */
  | { kind: "instant" }
  /** A fixed cooldown before funds are claimable. */
  | {
      kind: "delayed";
      seconds: number;
      /** `onchain` = read from the protocol this block; `declared` = pinned after review. */
      source: "onchain" | "declared";
    }
  /** Async/queued exit whose duration the protocol does not expose. */
  | { kind: "queued"; source: "onchain" | "declared" }
  /** Could not characterise. Fail closed — never treat as instant. */
  | { kind: "unknown" };

/** Seconds of lockup a verdict implies, for comparison and copy. */
export function exitDelaySeconds(terms: ExitTerms): number {
  return terms.kind === "delayed" ? terms.seconds : 0;
}

/** True when the user must be told before they commit funds. */
export function exitNeedsConsent(terms: ExitTerms): boolean {
  return terms.kind !== "instant";
}

export interface SimResult {
  ok: boolean;
  revertReason?: string;
  stateDelta?: Record<string, string>;
}

/** Per-user and ops policy, resolved by the caller before the pipeline runs. */
export interface SafetyPolicy {
  tier?: RiskTier;
  protocolWhitelist?: readonly string[];
  allowAllInTier?: boolean;
  paused?: boolean;
  /** Share of the user's DeFi funds already in this protocol/family, 0–1. */
  currentExposurePct?: number;
  /** Ceiling for the above, 0–1. */
  maxExposurePct?: number;
  /** Deposits already made in the rolling velocity window. */
  recentDepositCount?: number;
  maxDepositsPerWindow?: number;
}

/**
 * The surrounding decision context: identity + policy + economics + simulation.
 * Everything a check is allowed to read.
 *
 * No field here originates from the model — the LLM supplies only `pool_id`
 * (§11 Layer 0). Every parameter is produced by a trusted layer and
 * cross-checked by the opposite trust anchor (§11.1, §11.5).
 */
export interface SafetyContext {
  namespace: Namespace;
  /** Required, not defaulted — a caller must state it explicitly so a check
   *  can never run under the wrong action by omission (see `SafetyAction`). */
  action: SafetyAction;
  target: DepositTarget;
  chainId: number | string;
  wallet: string;
  requestedAmount: bigint | "MAX";
  /** The underlying the resolved target says this pool deposits. */
  underlyingExpected: string;
  previewOut: bigint | null;
  tvlUsdSnapshot: number | null;
  sim: SimResult | null;
  feeEstimate: bigint | null;

  // ── Additions the checks need, all optional so a caller can run the
  // layers it has data for and skip the rest (the runner reports which ran).
  stage: SafetyStage;
  /** The built call — required by every Layer-4 check. */
  call?: UnsignedCall;
  /** Raw tool input, for the Layer-0 provenance checks. */
  toolInput?: Record<string, unknown>;
  poolId?: string;
  protocolSlug?: string;
  /** Family/kind key the ops kill-switch is keyed by. */
  family?: string;
  /**
   * The lockup, in seconds, that the user was actually SHOWN and accepted.
   *
   * The consent half of the exit-terms gate: probing the delay only tells us
   * the protocol locks funds, it does not tell us the user agreed to it. An
   * agent can deposit on the user's behalf, so "they saw 30 days and said yes"
   * has to be carried explicitly — an absent value means nobody was asked, and
   * the check blocks. Never default this.
   */
  exitDelayAcknowledgedSec?: number;
  policy?: SafetyPolicy;
  /** On-chain `decimals()` for the deposited asset (§11.6 #1). */
  assetDecimals?: number;
  /** Human-scale amount the user asked for, before scaling. */
  requestedHuman?: number;
  /** APY the caller expects, for the drift guard. */
  expectedApy?: number;
  cachedApy?: number;
  /** Dedup key for the idempotency guard (§11.6 #5). */
  submissionKey?: string;
  /** Withdraw-only: asset symbol, for the hint/position match check. */
  assetSymbol?: string;
  /** Withdraw-only: the position's live on-chain balance, for the
   *  amount-vs-balance check. `undefined` when the live read failed —
   *  the check is non-fatal in that case, same posture as everywhere
   *  else a live read backs a safety check. */
  positionBalance?: bigint;
}

/**
 * The ONLY chain-specific seam. Checks call this capability interface, not
 * viem/Sui/Solana SDKs directly — which is what lets a check like "target has
 * code" be written once and gain a new chain the moment that chain's provider
 * is registered, with zero change to the check.
 *
 * Required primitives are the seven from §11.0b. The optional ones are §11.6
 * capabilities a chain may not have; callers presence-check them rather than
 * assuming.
 */
export interface ChainSafetyProvider {
  readonly namespace: Namespace;

  /** L1: the target address/object/account exists and is executable code. */
  targetExists(
    target: DepositTarget,
    chainId: number | string,
  ): Promise<boolean>;
  /** L1: identity read — vault.asset() / comet.baseToken() / coinType / mint. */
  readUnderlying(
    target: DepositTarget,
    chainId: number | string,
  ): Promise<string | null>;
  /** L1: target ∈ pinned per-chain address-book / program allowlist. */
  isAllowlisted(
    target: DepositTarget,
    chainId: number | string,
  ): Promise<boolean>;
  /** L4: the built call is bound to the intended chain. */
  assertChainBinding(call: UnsignedCall, chainId: number | string): boolean;
  /** L4: decode the call into the normalised intent for matching. */
  decodeIntent(call: UnsignedCall): Promise<DecodedIntent | null>;
  /** L4: dry-run without broadcasting. */
  simulate(call: UnsignedCall, ctx: SafetyContext): Promise<SimResult>;
  /** L5: the protocol's own emergency state (paused/frozen/deprecated/expired). */
  isProtocolHalted(
    target: DepositTarget,
    chainId: number | string,
  ): Promise<boolean>;
  /**
   * L5: how long funds are locked before they can be withdrawn.
   *
   * OPTIONAL on purpose (the space-docking rule): a chain whose provider does
   * not implement this yet reports `unknown`, and the Layer-3 consent check
   * fails closed rather than assuming instant. Docking a new chain is adding
   * this method, never editing the check.
   */
  readExitTerms?(
    target: DepositTarget,
    chainId: number | string,
  ): Promise<ExitTerms>;
  /** L5: post-execution position delta, for the assertion. */
  readPositionDelta(
    target: DepositTarget,
    owner: string,
    chainId: number | string,
  ): Promise<bigint>;

  // ── Optional capabilities (§11.6), presence-checked ──────────────────────
  /** #1: on-chain `decimals()` for an asset — never a symbol→decimals map. */
  readDecimals?(
    asset: string,
    chainId: number | string,
  ): Promise<number | null>;
  /** #3: confirmations required before a position counts as settled. */
  finalityDepth?(chainId: number | string): number;
  /** #4: whether sandwich-prone kinds can route through a private mempool. */
  supportsPrivateSubmit?(chainId: number | string): boolean;
  /** L2: the protocol's own cap on how much it will accept right now. */
  readDepositCapHeadroom?(
    target: DepositTarget,
    owner: string,
    chainId: number | string,
  ): Promise<bigint | null>;
  /**
   * L2: what the wallet actually holds of the asset it is about to deposit.
   * `null` ⇒ the chain could not answer; the caller must NOT read that as
   * "empty" (see `SufficientBalanceCheck`).
   */
  readBalance?(
    asset: string,
    owner: string,
    chainId: number | string,
  ): Promise<bigint | null>;
}

/** What the runner reports back. */
export type PipelineResult =
  | { ok: true; ran: readonly string[] }
  | {
      ok: false;
      fail: DefiErrorCode;
      layer: SafetyLayer;
      id: string;
      detail?: string;
      ran: readonly string[];
    };
