// TWV-2026-011 — Pre-sign transaction simulation entry point. Single
// call site for both the user-signer path (EvmTransactionSheet) and the
// agent path so behaviour stays in parity (§7).
//
// Hard rules:
//   1. Simulator MUST run against a pinned RPC, NOT the dApp-supplied
//      one. Trusting the dApp's RPC defeats the control (Bybit-class).
//   2. Simulation failure (revert / network / unsupported chain) MUST
//      block the default Sign button. Opt-out is a distinct secondary
//      action surfaced by the UI, not a fall-through here.
//
// Asset-delta extraction is intentionally conservative — a full
// trace-based simulator (Tenderly-class) is a follow-up. The decoder
// below predicts deltas for the calldata patterns the wallet already
// classifies as risk-bearing (`transfer`, `approve`,
// `setApprovalForAll`); everything else returns an empty delta list
// with `coverage: "partial"` so the UI can warn the user that asset
// movement could not be enumerated.

import { ethAddress, type PublicClient } from "viem";
import { simulateCalls } from "viem/actions";
import {
  type ApproveTargetKind,
  decodeCalldata,
} from "../decoders/calldata.ts";

export interface TxSimulationInput {
  to: `0x${string}`;
  from: `0x${string}`;
  value?: bigint;
  data?: `0x${string}`;
  chainId: number;
  /**
   * The adapter's resolution of what `to` is. Required for `approve`:
   * ERC-20 and ERC-721 share the selector byte-for-byte, so without it
   * the decoder must report indeterminate and no allowance delta can be
   * claimed.
   */
  approveTargetKind?: ApproveTargetKind;
}

export type AssetDeltaDirection = "in" | "out";

export interface AssetDelta {
  /** Token contract or null for native currency. */
  token: `0x${string}` | null;
  symbol: string;
  direction: AssetDeltaDirection;
  /** Magnitude in token base units (10^decimals); "unlimited" for max approvals. */
  amount: bigint | "unlimited";
  /** Human label for the counterparty (recipient / spender). */
  counterparty: `0x${string}`;
  kind: "transfer" | "approve" | "approveAll" | "native";
}

export type TxSimulationResult =
  | {
      status: "ok";
      deltas: AssetDelta[];
      coverage: "full" | "partial";
      gasEstimate?: bigint;
    }
  | {
      status: "reverted";
      reason: string;
    }
  | {
      status: "transport_error";
      reason: string;
    }
  | {
      status: "unsupported_chain";
      reason: string;
    };

/**
 * Predict asset deltas from calldata WITHOUT a trace-based simulator.
 * Conservative — only the well-known risk-bearing selectors. Other
 * payloads return `coverage: "partial"`, which the UI must surface as
 * "asset movement could not be enumerated — sign with caution".
 */
export function predictAssetDeltasFromCalldata(input: TxSimulationInput): {
  deltas: AssetDelta[];
  coverage: "full" | "partial";
} {
  const deltas: AssetDelta[] = [];
  const decoded = decodeCalldata(input.data, {
    approveTargetKind: input.approveTargetKind,
  });

  if (input.value && input.value > 0n) {
    deltas.push({
      token: null,
      symbol: "ETH",
      direction: "out",
      amount: input.value,
      counterparty: input.to,
      kind: "native",
    });
  }

  if (!decoded || !decoded.signature) {
    return {
      deltas,
      coverage: input.value && input.value > 0n ? "full" : "partial",
    };
  }

  if (decoded.functionName === "transfer" && decoded.args) {
    const to = decoded.args[0]?.value as `0x${string}` | undefined;
    const amount = decoded.args[1]?.value as bigint | undefined;
    if (to && typeof amount === "bigint") {
      deltas.push({
        token: input.to,
        symbol: "TOKEN",
        direction: "out",
        amount,
        counterparty: to,
        kind: "transfer",
      });
      return { deltas, coverage: "full" };
    }
  }

  if (decoded.risk?.kind === "approve") {
    deltas.push({
      token: input.to,
      symbol: "TOKEN",
      direction: "out",
      amount: decoded.risk.isUnlimited ? "unlimited" : decoded.risk.amount,
      counterparty: decoded.risk.spender,
      kind: "approve",
    });
    return { deltas, coverage: "full" };
  }

  if (decoded.risk?.kind === "approveNft") {
    // One item, not an allowance. The token id is an identifier, so it
    // must never reach the amount field.
    deltas.push({
      token: input.to,
      symbol: "NFT",
      direction: "out",
      amount: 1n,
      counterparty: decoded.risk.operator,
      kind: "approve",
    });
    return { deltas, coverage: "full" };
  }

  // `approveUnknownAsset` deliberately falls through to partial coverage
  // below. We know an approval is happening but not whether the second
  // argument is an amount or a token id, and a delta that guesses wrong
  // is worse than the honest "could not enumerate".

  if (decoded.risk?.kind === "setApprovalForAll" && decoded.risk.approved) {
    deltas.push({
      token: input.to,
      symbol: "NFT collection",
      direction: "out",
      amount: "unlimited",
      counterparty: decoded.risk.operator,
      kind: "approveAll",
    });
    return { deltas, coverage: "full" };
  }

  return { deltas, coverage: "partial" };
}

/**
 * Run an `eth_call` against the pinned RPC to detect a pre-sign revert.
 * Returns the simulator verdict; never throws. Consumer MUST gate the
 * primary Sign button on `status === "ok"`.
 */
export async function simulateTransaction(
  pinnedClient: PublicClient,
  input: TxSimulationInput,
): Promise<TxSimulationResult> {
  // Chain-id parity gate — if the pinned client and the input disagree,
  // bail out instead of silently simulating against the wrong network.
  try {
    const reportedChainId = await pinnedClient.getChainId();
    if (reportedChainId !== input.chainId) {
      return {
        status: "unsupported_chain",
        reason: `pinned RPC chainId ${reportedChainId} ≠ tx chainId ${input.chainId}`,
      };
    }
  } catch (e) {
    return {
      status: "transport_error",
      reason: e instanceof Error ? e.message : String(e),
    };
  }

  let gasEstimate: bigint | undefined;
  try {
    // eth_call probes for revert; on success the asset-delta predictor
    // gives the user-facing summary.
    await pinnedClient.call({
      account: input.from,
      to: input.to,
      value: input.value,
      data: input.data,
    });
    try {
      gasEstimate = await pinnedClient.estimateGas({
        account: input.from,
        to: input.to,
        value: input.value,
        data: input.data,
      });
    } catch {
      // estimateGas can be flaky for some chains/contracts; the call
      // already passed so we don't fail the simulation on this.
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    if (/revert/i.test(reason) || /execution reverted/i.test(reason)) {
      return { status: "reverted", reason };
    }
    return { status: "transport_error", reason };
  }

  const { deltas, coverage } = predictAssetDeltasFromCalldata(input);
  return { status: "ok", deltas, coverage, gasEstimate };
}

// ---------------------------------------------------------------------------
// TWV-2026-011 follow-up — real trace-based asset-change simulation.
//
// The static predictor above only understands `transfer` / `approve` /
// `setApprovalForAll` / native value; arbitrary calldata (a Universal
// Router `execute`, a bespoke router, a batched multicall) returns
// `coverage: "partial"`. This is the promised upgrade: run the call
// through the node's `eth_simulateV1` (via viem's `simulateCalls` with
// asset-change tracing) against a PINNED client and read back the actual
// per-token balance diffs of the signer — symbol and decimals included,
// so the UI can format amounts instead of dumping raw base units.
//
// Same hard rule as `simulateTransaction`: the caller MUST pass a client
// built on the wallet's own RPC, never the dApp-supplied one.
// ---------------------------------------------------------------------------

/** One concrete balance change for the signer, ready for display. */
export interface SimulatedAssetChange {
  /** Token contract, or `null` for the native currency. */
  token: `0x${string}` | null;
  symbol: string;
  decimals: number;
  direction: AssetDeltaDirection;
  /** Magnitude of the change in base units (10^decimals). */
  amount: bigint;
}

export type TraceSimulationResult =
  | {
      status: "ok";
      changes: SimulatedAssetChange[];
      /** True when the call itself reverts under simulation. */
      reverted: boolean;
    }
  /** The RPC does not implement `eth_simulateV1` — fall back to the predictor. */
  | { status: "unsupported" }
  /** Network / RPC failure — fall back to the predictor. */
  | { status: "transport_error" };

const NATIVE_PSEUDO_ADDRESS = ethAddress.toLowerCase();

/** The subset of viem's `assetChanges` entry this module consumes. */
export interface RawAssetChange {
  token: { address: string; decimals?: number; symbol?: string };
  value: { diff: bigint };
}

/**
 * Map viem's raw `assetChanges` (balance diffs of the traced signer) into
 * display-ready deltas: native detected via the ETH pseudo-address,
 * direction from the sign of the diff, zero-diffs dropped. Pure — the unit
 * seam for `simulateAssetChanges`.
 */
export function mapSimulatedAssetChanges(
  assetChanges: readonly RawAssetChange[],
): SimulatedAssetChange[] {
  const changes: SimulatedAssetChange[] = [];
  for (const change of assetChanges) {
    const diff = change.value.diff;
    if (diff === 0n) continue;
    const isNative =
      change.token.address.toLowerCase() === NATIVE_PSEUDO_ADDRESS;
    changes.push({
      token: isNative ? null : (change.token.address as `0x${string}`),
      symbol: change.token.symbol ?? (isNative ? "native" : "token"),
      decimals:
        typeof change.token.decimals === "number"
          ? change.token.decimals
          : isNative
            ? 18
            : 0,
      direction: diff > 0n ? "in" : "out",
      amount: diff > 0n ? diff : -diff,
    });
  }
  return changes;
}

// viem/geth signal an unimplemented `eth_simulateV1` in several shapes
// depending on the provider. Any of these means "this RPC can't trace,
// degrade gracefully" rather than "the transaction is bad".
export function isUnsupportedSimulationError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("method not found") ||
    m.includes("not supported") ||
    m.includes("does not exist/is not available") ||
    m.includes("does not exist") ||
    m.includes("unsupported method") ||
    m.includes("eth_simulatev1") ||
    m.includes("could not be found") ||
    m.includes("not available") ||
    m.includes("-32601")
  );
}

/**
 * Trace the signer's asset changes for a single call via `eth_simulateV1`.
 * Never throws: an unsupported RPC or a network error is reported as a
 * discriminated status so the caller can fall back to the static
 * predictor. Balance validation is left OFF so the preview reflects the
 * call's intent even when the wallet's current balance is zero.
 */
export async function simulateAssetChanges(
  client: PublicClient,
  input: TxSimulationInput,
): Promise<TraceSimulationResult> {
  try {
    const { assetChanges, results } = await simulateCalls(client, {
      account: input.from,
      calls: [
        {
          to: input.to,
          value: input.value ?? 0n,
          data: input.data,
        },
      ],
      traceAssetChanges: true,
      traceTransfers: true,
    });

    const reverted = results[0]?.status === "failure";
    const changes = mapSimulatedAssetChanges(assetChanges);
    return { status: "ok", changes, reverted };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (isUnsupportedSimulationError(message)) {
      return { status: "unsupported" };
    }
    return { status: "transport_error" };
  }
}

/** Batch simulation adds which entries reverted, on top of the net deltas. */
export type BatchTraceSimulationResult =
  | {
      status: "ok";
      changes: SimulatedAssetChange[];
      /** Index-aligned with the calls passed in. */
      revertedIndexes: number[];
    }
  | { status: "unsupported" }
  | { status: "transport_error" };

/**
 * Trace a whole `wallet_sendCalls` batch — spec phase L.
 *
 * The calls go to `simulateCalls` as one array rather than one request
 * per entry, and that is the substance of this function rather than a
 * convenience. Simulating each call independently would evaluate every
 * entry against current chain state, so the swap in the canonical
 * approve-then-swap batch would trace against a world where its own
 * approve never happened and report a revert that will not occur. A
 * false "this will fail" on a legitimate batch teaches users to ignore
 * the warning, which costs more than showing nothing.
 *
 * The returned `changes` are therefore the signer's **net** position
 * change across the batch, which is also the number the user actually
 * cares about.
 */
export async function simulateBatchAssetChanges(
  client: PublicClient,
  input: {
    from: `0x${string}`;
    calls: ReadonlyArray<{
      to?: `0x${string}`;
      value?: bigint;
      data?: `0x${string}`;
    }>;
  },
): Promise<BatchTraceSimulationResult> {
  // A batch entry with no recipient is a contract creation, which
  // `eth_simulateV1` has no call target for. Rather than dropping it and
  // tracing a batch the user was not asked to sign, decline to simulate
  // the whole thing — the sheet then says so, which is accurate.
  const calls: Array<{
    to: `0x${string}`;
    value: bigint;
    data?: `0x${string}`;
  }> = [];
  for (const c of input.calls) {
    if (!c.to) return { status: "unsupported" };
    calls.push({ to: c.to, value: c.value ?? 0n, data: c.data });
  }
  try {
    const { assetChanges, results } = await simulateCalls(client, {
      account: input.from,
      calls,
      traceAssetChanges: true,
      traceTransfers: true,
    });
    const revertedIndexes = results.flatMap((r, i) =>
      r?.status === "failure" ? [i] : [],
    );
    return {
      status: "ok",
      changes: mapSimulatedAssetChanges(assetChanges),
      revertedIndexes,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (isUnsupportedSimulationError(message)) return { status: "unsupported" };
    return { status: "transport_error" };
  }
}
