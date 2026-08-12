/**
 * Solana compute-budget instructions for first-party sends — spec
 * phase J.
 *
 * The wallet already *decodes* `setComputeUnitLimit` /
 * `setComputeUnitPrice` out of dApp-built transactions so the approval
 * sheet can show what a dApp chose. Its own send path never *set* them:
 * every first-party transfer went out at the 200k default compute limit
 * with no priority fee, which under congestion means the transaction is
 * deprioritised and can simply fail to land. To the user that looks like
 * a send that silently did nothing.
 *
 * Two deliberate scoping decisions:
 *
 *   - **First-party only.** dApp-built transactions keep whatever
 *     compute budget the dApp set. We decode and display theirs; we do
 *     not rewrite it. Rewriting would change what the user approved.
 *   - **Contention-scoped, not global.** `getRecentPrioritizationFees`
 *     takes the writable accounts a transaction locks, so the fee is
 *     derived from contention on *those* accounts. A transfer touching
 *     an uncontended account should not pay a hot account's premium.
 *
 * Instruction encoding is hand-rolled rather than pulled from
 * `@solana-program/compute-budget` (not a dependency here). The
 * discriminators match this repo's own shipped decoder in
 * `programDecoder.ts` — 2 for the unit limit, 3 for the unit price.
 */

import { type Address, address, type IInstruction } from "@solana/kit";

const COMPUTE_BUDGET_PROGRAM =
  "ComputeBudget111111111111111111111111111111" as const;

/**
 * Hard ceiling on the priority fee, in micro-lamports per compute unit.
 * A fee oracle returning an absurd figure — a spike, a bad RPC, a
 * hostile one — must not be able to drain the user's balance into fees
 * on a routine transfer.
 */
const MAX_MICRO_LAMPORTS_PER_CU = 1_000_000n;

/** Fallback when the oracle is unavailable. Cheap, but not zero. */
const DEFAULT_MICRO_LAMPORTS_PER_CU = 1_000n;

/** Margin over simulated usage, since simulation is not exact. */
const COMPUTE_UNIT_MARGIN = 1.2;

/** Solana's per-transaction ceiling. */
const MAX_COMPUTE_UNITS = 1_400_000;

function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

function u64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

export function setComputeUnitLimitInstruction(units: number): IInstruction {
  const clamped = Math.max(1, Math.min(MAX_COMPUTE_UNITS, Math.ceil(units)));
  const data = new Uint8Array(5);
  data[0] = 2;
  data.set(u32le(clamped), 1);
  return {
    programAddress: address(COMPUTE_BUDGET_PROGRAM) as Address,
    data,
  };
}

export function setComputeUnitPriceInstruction(
  microLamports: bigint,
): IInstruction {
  const clamped =
    microLamports > MAX_MICRO_LAMPORTS_PER_CU
      ? MAX_MICRO_LAMPORTS_PER_CU
      : microLamports < 0n
        ? 0n
        : microLamports;
  const data = new Uint8Array(9);
  data[0] = 3;
  data.set(u64le(clamped), 1);
  return {
    programAddress: address(COMPUTE_BUDGET_PROGRAM) as Address,
    data,
  };
}

interface PrioritizationFeeRpc {
  getRecentPrioritizationFees(addresses: Address[]): {
    send(): Promise<ReadonlyArray<{ prioritizationFee: bigint | number }>>;
  };
}

/**
 * Median recent priority fee for the given writable accounts.
 *
 * Median rather than max: the RPC returns one sample per recent slot,
 * and a single congested slot should not set the price for the next
 * one. Falls back to a default on any failure — a fee oracle that hangs
 * or errors must never block a send, which is the whole point of the
 * timeout the caller wraps this in.
 */
export async function fetchPriorityFee(
  rpc: unknown,
  writableAccounts: Address[],
): Promise<bigint> {
  try {
    const client = rpc as PrioritizationFeeRpc;
    if (typeof client?.getRecentPrioritizationFees !== "function") {
      return DEFAULT_MICRO_LAMPORTS_PER_CU;
    }
    const samples = await client
      .getRecentPrioritizationFees(writableAccounts)
      .send();
    const fees = samples
      .map((s) => BigInt(s.prioritizationFee))
      .filter((f) => f > 0n)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (fees.length === 0) return DEFAULT_MICRO_LAMPORTS_PER_CU;
    const median = fees[Math.floor(fees.length / 2)];
    return median > MAX_MICRO_LAMPORTS_PER_CU
      ? MAX_MICRO_LAMPORTS_PER_CU
      : median;
  } catch {
    return DEFAULT_MICRO_LAMPORTS_PER_CU;
  }
}

/**
 * Measure a signed transaction's actual compute usage.
 *
 * `sigVerify: false` + `replaceRecentBlockhash: true` so this works on a
 * transaction we are about to re-sign with a tighter budget — we are
 * measuring the program's cost, not validating the signature. Returns
 * `null` on any failure, which leaves the provisional limit in place.
 */
export async function simulateComputeUnits(
  rpc: unknown,
  wireBase64: string,
): Promise<number | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (await (rpc as any)
      .simulateTransaction(wireBase64, {
        encoding: "base64",
        replaceRecentBlockhash: true,
        sigVerify: false,
      })
      .send()) as
      | { value?: { unitsConsumed?: number | bigint; err?: unknown } }
      | undefined;
    const value = raw?.value;
    // A simulation that errored tells us nothing usable about cost, and
    // sizing the budget off a failed run would under-provision the real
    // send.
    if (!value || value.err) return null;
    return computeUnitLimitFromSimulation(value.unitsConsumed);
  } catch {
    return null;
  }
}

/** Simulated usage plus margin, or `null` to leave the default alone. */
export function computeUnitLimitFromSimulation(
  unitsConsumed: number | bigint | null | undefined,
): number | null {
  if (unitsConsumed === null || unitsConsumed === undefined) return null;
  const n = Number(unitsConsumed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(MAX_COMPUTE_UNITS, Math.ceil(n * COMPUTE_UNIT_MARGIN));
}

/**
 * Bound any promise so a slow RPC degrades instead of blocking a send.
 * Mirrors the EVM gas-estimate timeout pattern.
 */
export async function withFeeTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

export const PRIORITY_FEE_TIMEOUT_MS = 2500;

/**
 * Provisional limit for the measuring pass. Generous enough that a
 * transfer plus an ATA creation cannot hit the ceiling and report a
 * misleading failure, then replaced by the measured figure.
 */
export const PROVISIONAL_COMPUTE_UNITS = 200_000;
export { DEFAULT_MICRO_LAMPORTS_PER_CU, MAX_MICRO_LAMPORTS_PER_CU };
