/**
 * Per-turn consolidation of repeated card-backed tool calls.
 *
 * Root cause this addresses: the model sometimes fans ONE goal out into
 * SEVERAL calls of the same list tool in a single assistant turn (e.g.
 * `defi_list_opportunities` once per chain namespace), and every call
 * rendered its own full card — the user saw the "same" list stacked two
 * or three times. Earlier fixes were per-symptom (balance cards got a
 * subset-dedupe, the setup CTA got an owner pass), so the class kept
 * reappearing on other tools. This module is the generic mechanism: any
 * tool registered in `TOOL_OUTPUT_MERGERS` renders AT MOST ONE card per
 * assistant message, carrying the union of every sibling call's rows.
 *
 * Semantics per registered tool within one message:
 *  - ≥2 successful results → the FIRST success renders (stable position),
 *    with the later successes' rows merged into its output.
 *  - a pending sibling that follows a success is suppressed — its rows
 *    join the surviving card when the result lands, instead of showing an
 *    interim duplicate skeleton.
 *  - a failed sibling is suppressed when a success exists or ANY later
 *    sibling supersedes it (same rule as the retry-supersede pass in
 *    MessageContent — the newest attempt owns the slot).
 *  - a single call, or calls that are all pending / all failed except the
 *    last, render exactly as before.
 *
 * Registering a tool here is a product statement: "N calls of this tool
 * in one turn are one list, not N lists". Only register tools whose rows
 * carry their own identity (so a union is lossless) — paginated catalogs,
 * for example, do NOT belong here.
 *
 * Kept free of React Native imports so it runs under plain vitest (same
 * split as `cards/bridgeFormat.test.ts`).
 */

import {
  EXPECTED_MOBILE_TOOLS,
  MOBILE_WRITE_TOOLS,
} from "@/services/agent-executors/expectedMobileTools";
import type { AgentMessagePart } from "@/services/agent-messages/types";

type ToolPart = Extract<AgentMessagePart, { type: "tool" }>;

export type ToolOutputMerger = (outputs: unknown[]) => unknown;

type RowRecord = Record<string, unknown>;

function asRecord(value: unknown): RowRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RowRecord)
    : null;
}

/**
 * Stable identity for a list row. Prefers the backend `id`; falls back to
 * the tuple that names a pool/position uniquely. Rows that defeat both
 * (non-object, no fields) fall back to their JSON so two literally
 * identical rows still collapse.
 */
function rowIdentity(row: unknown): string {
  const r = asRecord(row);
  if (!r) return JSON.stringify(row);
  if (typeof r.id === "string" || typeof r.id === "number") {
    return `id:${r.id}`;
  }
  return JSON.stringify([
    r.protocol_slug ?? null,
    r.namespace ?? null,
    r.chain_id ?? null,
    r.pool_id ?? null,
    r.asset_symbol ?? null,
  ]);
}

/**
 * Merge sibling executor outputs whose payload is `data.<listKey>: rows[]`
 * (the shared `{ status, data }` ToolResult shape). Union is by
 * `rowIdentity`, first occurrence wins, order preserved. The first
 * output's other fields (status, scope markers, …) are kept as-is so the
 * surviving card renders exactly what its own call returned, plus rows.
 */
function mergeListOutputs(listKey: string): ToolOutputMerger {
  return (outputs) => {
    const first = asRecord(outputs[0]);
    if (!first) return outputs[0];
    const rows: unknown[] = [];
    const seen = new Set<string>();
    for (const output of outputs) {
      const data = asRecord(asRecord(output)?.data);
      const list = data?.[listKey];
      if (!Array.isArray(list)) continue;
      for (const row of list) {
        const key = rowIdentity(row);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(row);
      }
    }
    const firstData = asRecord(first.data) ?? {};
    // A merged list spans whatever scopes its siblings used, so a
    // per-call scope label (e.g. "active chain only") stops being true
    // the moment two differing calls combine.
    const scopes = new Set(
      outputs
        .map((o) => asRecord(asRecord(o)?.data)?.chain_scope)
        .filter((s): s is string => typeof s === "string"),
    );
    const chainScope =
      scopes.size > 1 ? "all_chains" : (firstData.chain_scope ?? undefined);
    return {
      ...first,
      data: {
        ...firstData,
        [listKey]: rows,
        count: rows.length,
        ...(chainScope !== undefined ? { chain_scope: chainScope } : {}),
      },
    };
  };
}

export const TOOL_OUTPUT_MERGERS: Record<string, ToolOutputMerger> = {
  defi_list_opportunities: mergeListOutputs("opportunities"),
  defi_list_positions: mergeListOutputs("positions"),
};

function isFailed(part: ToolPart): boolean {
  if (part.state === "output-error") return true;
  const output = asRecord(part.output);
  return output?.status === "failed";
}

function isSuccess(part: ToolPart): boolean {
  return (
    part.state === "output-available" &&
    part.output !== undefined &&
    !isFailed(part)
  );
}

/**
 * Read tools whose repeat calls are safe to collapse when their INPUTS
 * are identical: a second call with the same arguments can only paint the
 * same card twice.
 *
 * Allowlist, not denylist — a tool must be a known mobile tool AND not a
 * known write. Writes are excluded because two identical `send_token`
 * calls can be two real transfers the user asked for, and hiding the
 * second receipt would hide money moving. An unrecognised tool name (a
 * newer server tool this build doesn't know) is left alone for the same
 * fail-safe reason. `MOBILE_WRITE_TOOLS` is kept honest against the
 * server registry by `registryParity.test.ts`.
 */
const DEDUPABLE_READ_TOOLS: ReadonlySet<string> = new Set(
  EXPECTED_MOBILE_TOOLS.filter((name) => !MOBILE_WRITE_TOOLS.has(name)),
);

/** Order-insensitive key for a tool input, for identical-call detection. */
function inputKey(input: unknown): string {
  const seen = new WeakSet<object>();
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    const record = asRecord(value);
    if (!record) return value;
    if (seen.has(record)) return "[circular]";
    seen.add(record);
    return Object.keys(record)
      .sort()
      .map((k) => [k, stable(record[k])]);
  };
  try {
    return JSON.stringify(stable(input)) ?? "undefined";
  } catch {
    return "unserializable";
  }
}

/**
 * Pick the one part of a sibling group that renders, and report which of
 * the others are stale failures. A failure never owns the slot while a
 * sibling can fill it: any success supersedes it, and so does any LATER
 * attempt (whose own skeleton/result is the newer truth) — mirroring the
 * retry-supersede pass in MessageContent. Otherwise the first success
 * wins, and before any result lands the first attempt holds the slot, so
 * a turn shows ONE skeleton that becomes the final card rather than N
 * skeletons collapsing into one.
 */
function pickSurvivor(group: ToolPart[]): ToolPart {
  const anySuccess = group.some(isSuccess);
  const viable = group.filter((part, index) => {
    if (!isFailed(part)) return true;
    return !(anySuccess || index < group.length - 1);
  });
  return group.find(isSuccess) ?? viable[0] ?? group[0];
}

export interface ConsolidatedToolParts {
  /** toolCallIds whose cards must not render. */
  suppressed: Set<string>;
  /** Merged output for the surviving part, keyed by its toolCallId. */
  outputs: Map<string, unknown>;
}

function groupBy(
  parts: readonly AgentMessagePart[],
  keyOf: (part: ToolPart) => string | null,
): Map<string, ToolPart[]> {
  const groups = new Map<string, ToolPart[]>();
  for (const part of parts) {
    if (part.type !== "tool") continue;
    const key = keyOf(part);
    if (key === null) continue;
    const group = groups.get(key);
    if (group) group.push(part);
    else groups.set(key, [part]);
  }
  return groups;
}

/**
 * Compute, for one assistant message, which tool parts render and what
 * output the survivor carries. Pure — safe for live streaming and
 * historical replay alike (it re-runs as parts settle).
 *
 * Two passes, narrowest first:
 *  1. Registered list tools collapse to one card per tool, unioning rows
 *     across sibling calls even when their filters differed.
 *  2. Every other known read tool collapses only EXACT repeats (same
 *     tool, same input), which can never be anything but a duplicate.
 */
export function consolidateToolParts(
  parts: readonly AgentMessagePart[],
): ConsolidatedToolParts {
  const suppressed = new Set<string>();
  const outputs = new Map<string, unknown>();

  const mergeable = groupBy(parts, (part) =>
    part.toolName in TOOL_OUTPUT_MERGERS ? part.toolName : null,
  );
  for (const [toolName, group] of mergeable) {
    if (group.length < 2) continue;
    const survivor = pickSurvivor(group);
    for (const part of group) {
      if (part !== survivor) suppressed.add(part.toolCallId);
    }
    const successes = group.filter(isSuccess);
    if (successes.length > 1) {
      outputs.set(
        survivor.toolCallId,
        TOOL_OUTPUT_MERGERS[toolName](successes.map((p) => p.output)),
      );
    }
  }

  const repeats = groupBy(parts, (part) =>
    !(part.toolName in TOOL_OUTPUT_MERGERS) &&
    DEDUPABLE_READ_TOOLS.has(part.toolName)
      ? `${part.toolName} ${inputKey(part.input)}`
      : null,
  );
  for (const group of repeats.values()) {
    if (group.length < 2) continue;
    const survivor = pickSurvivor(group);
    for (const part of group) {
      if (part !== survivor) suppressed.add(part.toolCallId);
    }
  }

  return { suppressed, outputs };
}
