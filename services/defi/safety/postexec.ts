/**
 * Post-execution verification (spec §11 Layer 5, §11.6 #3).
 *
 * The `postexec` stage existed in the type union and had two checks written
 * against it since the safety layer shipped, and no caller ever passed it: on
 * every chain, `PositionDeltaCheck` and `FinalityCheck` were dead code. This
 * module is the caller, and it exists as its own file because the postexec
 * stage needs a call-site contract the other four stages do not.
 *
 * **It never throws, and never turns a landed transaction into a reported
 * failure.** Everywhere else in the pipeline, a refusal means nothing
 * happened, so `assertSafetyResult` throwing is exactly right. Here the money
 * has already moved. Throwing would tell a user their deposit failed while
 * their funds sit in the protocol, which is the same class of bug
 * `submitTx.ts` was written to eliminate on the broadcast side, and it is
 * strictly worse than saying nothing: the user would retry.
 *
 * So the verdict is DATA the caller reports, not control flow:
 *   - `verified`   — the position moved in the right direction.
 *   - `mismatch`   — the transaction succeeded and the position did NOT move.
 *                    A reconciliation alert, never a user-facing error.
 *   - `unverified` — we could not look (no target, no provider, no snapshot,
 *                    no receipt inside the wait window, read failed). Not
 *                    evidence of anything.
 *
 * Every run still goes through `runSafetyPipeline`, so the audit sink records
 * it exactly like any other stage and `ran` shows which checks actually fired.
 */

import type { DefiErrorCode } from "../errors/defiErrors";
import type { DepositTarget } from "../types";
import { getChainSafetyProvider, runSafetyPipeline } from "./registry";
import type { SafetyContext } from "./types";

export type PostExecStatus = "verified" | "mismatch" | "unverified";

export interface PostExecVerdict {
  status: PostExecStatus;
  /** Only on `mismatch` — the check's own code, for logs and analytics. */
  fail?: DefiErrorCode;
  /** Curated, never user-facing verbatim. */
  detail?: string;
  /** Which checks ran, for the incident trail (§11.6 #7). */
  ran: readonly string[];
  /** Why nothing could be asserted, on `unverified`. */
  reason?: "no_target" | "no_provider" | "no_snapshot" | "checks_skipped";
}

/**
 * Read the position balance the postexec delta check will compare against.
 *
 * Call this immediately before submitting, so the two readings are as close
 * together as the chain allows: anything in between (a yield accrual, another
 * device depositing) widens the window in which a real change gets attributed
 * to this transaction.
 *
 * Returns `null` when the position cannot be read at all, which the caller
 * passes straight through — `positionBefore` absent means the deposit ends up
 * `unverified` rather than measured against a number nobody read.
 */
export async function snapshotPositionBefore(
  ctx: Pick<SafetyContext, "namespace" | "target" | "wallet" | "chainId">,
): Promise<bigint | null> {
  if (!ctx.target) return null;
  const provider = getChainSafetyProvider(ctx.namespace);
  if (!provider) return null;
  try {
    return await provider.readPositionBalance(
      ctx.target,
      ctx.wallet,
      ctx.chainId,
    );
  } catch {
    return null;
  }
}

/**
 * Run the `postexec` stage over a transaction that has already executed.
 *
 * `base` is the same `SafetyContext` the pre-sign stages used, so the verdict
 * is about the deposit that was actually authorised rather than a
 * reconstruction of it.
 */
export async function verifyPostExecution(
  base: SafetyContext,
  args: {
    /** From `snapshotPositionBefore`, taken before submitting. */
    positionBefore: bigint | null;
    /** Confirmations the submitter observed. Omit when unknown. */
    confirmations?: number;
  },
): Promise<PostExecVerdict> {
  const target: DepositTarget | undefined = base.target;
  if (!target) return { status: "unverified", ran: [], reason: "no_target" };
  if (!getChainSafetyProvider(base.namespace)) {
    return { status: "unverified", ran: [], reason: "no_provider" };
  }
  if (args.positionBefore === null) {
    return { status: "unverified", ran: [], reason: "no_snapshot" };
  }

  let result: Awaited<ReturnType<typeof runSafetyPipeline>>;
  try {
    result = await runSafetyPipeline({
      ...base,
      stage: "postexec",
      positionBefore: args.positionBefore,
      confirmations: args.confirmations,
    });
  } catch {
    // The runner already converts a throwing CHECK into a failure, so this
    // only catches the runner itself. Even then: the transaction landed, and
    // a verification that could not run says nothing about it.
    return { status: "unverified", ran: [], reason: "checks_skipped" };
  }

  if (result.ok) {
    // A pipeline that selected nothing is not a verification. Reporting
    // `verified` off an empty run is how a check that silently stopped
    // applying would look identical to one that passed.
    return result.ran.length > 0
      ? { status: "verified", ran: result.ran }
      : { status: "unverified", ran: result.ran, reason: "checks_skipped" };
  }
  return {
    status: "mismatch",
    fail: result.fail,
    detail: result.detail,
    ran: result.ran,
  };
}

/**
 * The one line a caller may show a user when verification did not confirm.
 *
 * Hand-written, and deliberately not alarming: the overwhelmingly likely
 * cause is indexing lag, not a lost deposit, and the transaction hash is in
 * the result either way. Raw codes and check ids stay in the audit trail
 * (CLAUDE.md — never raw error text to users; no em-dashes in UI copy).
 */
export const POSTEXEC_UNCONFIRMED_NOTE =
  "Your transaction went through. We could not see the position update yet, so it may take a few minutes to appear.";
