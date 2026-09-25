import type { OrbState } from "thinking-orbs/engine";
import type { AgentMessagePart } from "@/services/agent-messages/types";

/** A tool on the live reply that has started but not returned yet. */
export type TRunningTool = { toolName: string; isWrite: boolean };

/**
 * What the agent is doing right now, as the chat screen can see it.
 *
 * Tool activity has to come from the reply's own tool parts. agent-api
 * only sends a status label for tools IT executes (`executeServerTool`),
 * and nearly every tool runs on the phone (`executor: 'mobile'`), so its
 * "Reading chain state…" / "Preparing transaction…" labels effectively
 * never arrive. What does arrive is "Thinking…" at the start of each
 * model step, "Working…" for the server-side handoff/clarify tools, and
 * the client's own reconnect line.
 */
export type TAgentActivity = {
  /** Status line from agent-api, or the client's reconnect line. */
  status: string | null;
  /** The live reply's last part is text: words are streaming. */
  composing: boolean;
  runningTool: TRunningTool | null;
};

/**
 * The tool on the live reply that is still running, preferring a write
 * when several run together. A part leaves `input-*` when its result
 * lands or when the user declines it (the dispatcher writes
 * `output-error`), so a declined write never reads as running. Waits on
 * the user (run-down card, proposal, approval sheet) are hidden by the
 * caller, not here.
 */
export function findRunningTool(
  parts: readonly AgentMessagePart[],
  writeTools: ReadonlySet<string>,
): TRunningTool | null {
  let running: TRunningTool | null = null;
  for (const p of parts) {
    if (p.type !== "tool") continue;
    if (p.state !== "input-streaming" && p.state !== "input-available") {
      continue;
    }
    const isWrite = writeTools.has(p.toolName);
    if (isWrite) return { toolName: p.toolName, isWrite };
    running = { toolName: p.toolName, isWrite };
  }
  return running;
}

/**
 * Which ThinkingOrb motion to show, so reading, running a transaction
 * and writing a reply look different without any words.
 */
export function agentOrbState(activity: TAgentActivity): OrbState {
  const { status, composing, runningTool } = activity;
  if (status?.startsWith("Reconnecting")) return "connecting";
  if (runningTool) return runningTool.isWrite ? "shaping" : "searching";
  // Server tool labels, should a read/write tool ever run server-side.
  if (status?.startsWith("Reading") || status?.startsWith("Looking up")) {
    return "searching";
  }
  if (status?.startsWith("Preparing")) return "shaping";
  if (composing) return "composing";
  if (status === null || status.startsWith("Thinking")) return "breathing";
  return "working";
}

// A write that isn't a transaction gets its own words.
const WRITE_LABELS: Readonly<Record<string, string>> = {
  defi_set_recurring_invest: "Saving your plan…",
};

/**
 * The words to show under the orb, or null for none. Generic thinking,
 * working, reading and writing a reply are left to the motion. A running
 * write keeps words, because the pending-tx cards show no progress of
 * their own while it signs and submits, and so does a dropped stream.
 */
export function agentStatusLabel(activity: TAgentActivity): string | null {
  const { status, runningTool } = activity;
  if (status?.startsWith("Reconnecting")) return status;
  if (runningTool?.isWrite) {
    return WRITE_LABELS[runningTool.toolName] ?? "Processing transaction…";
  }
  if (runningTool) return null;
  if (status === null) return null;
  if (status.startsWith("Thinking") || status.startsWith("Working")) {
    return null;
  }
  return status;
}
