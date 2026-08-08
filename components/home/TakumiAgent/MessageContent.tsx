import React from "react";
import { Text, View } from "react-native";
import type { AgentMessage } from "@/services/agent-messages/types";
import MarkdownMessage from "./MarkdownMessage";
import PlainTextMessage from "./PlainTextMessage";
import {
  BALANCE_TOOL_NAMES,
  SETUP_CTA_TOOLS,
  toolComponents,
} from "./StructuredUI";
import { normalizeWalletBalancesOutput } from "./StructuredUI/cards/BalancesCard";
import { consolidateToolParts } from "./StructuredUI/mergeToolParts";
import { useOriginAgentDisplay } from "./useOriginAgentDisplay";

interface MessageContentProps {
  message: AgentMessage;
  mode: "live" | "historical";
  addToolResult?: (toolCallId: string, output: unknown) => void;
  onUserPrompt?: (prompt: string) => void;
  /**
   * Open the approval sheet for an `ask` proposal card (deny-layer §4.1).
   * Keyed by `toolCallId` like `addToolResult`.
   */
  onRequestApproval?: (toolCallId: string) => void;
}

/**
 * The set of (namespace, chain_id, token-address, symbol) tuples a
 * balance-tool result paints. Used by the dedupe pass below to suppress
 * any card whose entries are a (non-strict) subset of another card's
 * — the LLM frequently calls `get_wallet_balance` (native only) and
 * then `get_wallet_tokens` (native + ERC20s) in the same turn, and
 * the second card's entries cover the first.
 *
 * Returns `null` when no normalized payload is present (loading
 * skeleton, error) — those cards always render.
 */
function balanceEntries(output: unknown): Set<string> | null {
  if (!output || typeof output !== "object") return null;
  try {
    const normalized = normalizeWalletBalancesOutput(output as never);
    const payload = normalized.display ?? normalized.data;
    if (!payload?.groups?.length) return null;
    const entries = new Set<string>();
    for (const g of payload.groups) {
      const ns = g.namespace;
      const cid = String(g.chain_id ?? "");
      for (const t of g.tokens ?? []) {
        const addr = (t.address ?? "").toLowerCase();
        // Symbol included to distinguish addr-less native rows across
        // namespaces ("" + ETH vs "" + SOL).
        entries.add(`${ns}|${cid}|${addr}|${t.symbol}`);
      }
    }
    return entries.size > 0 ? entries : null;
  } catch {
    return null;
  }
}

function isSubsetOf(a: Set<string>, b: Set<string>): boolean {
  if (a.size > b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Decide which balance-tool parts to suppress. A part is suppressed
 * when another part in the same message holds entries that are a
 * superset of it — strict superset wins outright; on ties, the
 * earlier part wins so narrative order is preserved.
 */
function computeSuppressedToolParts(message: AgentMessage): Set<string> {
  const balances: Array<{
    toolCallId: string;
    index: number;
    entries: Set<string>;
  }> = [];
  message.parts.forEach((part, index) => {
    if (part.type !== "tool") return;
    if (!BALANCE_TOOL_NAMES.has(part.toolName)) return;
    const entries = balanceEntries(part.output);
    if (!entries) return;
    balances.push({ toolCallId: part.toolCallId, index, entries });
  });

  const suppressed = new Set<string>();
  for (const a of balances) {
    for (const b of balances) {
      if (a.toolCallId === b.toolCallId) continue;
      if (!isSubsetOf(a.entries, b.entries)) continue;
      const strictSubset = a.entries.size < b.entries.size;
      // Equal entries: keep the earlier card, drop later duplicates.
      // Strict subset: drop A regardless of order.
      if (strictSubset || a.index > b.index) {
        suppressed.add(a.toolCallId);
        break;
      }
    }
  }
  return suppressed;
}

/**
 * Tool families where a FAILED part is transient: when the agent's first
 * call fails and it retries with a sibling, the failed card sticks around
 * and renders an error banner above the in-flight one. Suppress the failed
 * card as soon as a later sibling of the SAME family appears in the message
 * — pending, succeeded, or otherwise — so the user sees the new card's
 * skeleton/result instead of the stale error.
 *
 *  - Catalog family: `get_redemption_catalog` & co. retry across siblings
 *    ("Couldn't load catalog").
 *  - Intent-preview family: a relative-amount swap ("90% of my SUI") can
 *    fail a `defi_intent_preview` attempt and retry; the stale yellow
 *    "couldn't prepare that plan" / "not enough balance" banner must vanish
 *    once a later preview supersedes it (Sui Overflow Scene 3 — the guardian
 *    block must show ONE clean NOT-RECOMMENDED card, no leftover errors).
 *
 * Mirrors the balance-tool dedupe above; the key difference is that
 * "in-flight" counts as "supersedes the earlier failure" — we don't wait
 * for the retry to land. A *blocked* preview is output-available (not
 * failed), so the final NOT-RECOMMENDED card is never suppressed and is
 * exactly what supersedes the earlier failures.
 */
const RETRY_SUPERSEDE_FAMILIES: ReadonlyArray<ReadonlySet<string>> = [
  new Set([
    "get_redemption_catalog",
    "search_redemption_catalog",
    "get_redemption_categories",
  ]),
  new Set(["defi_intent_preview"]),
];

function isFailedToolPart(output: unknown, state: string): boolean {
  if (state === "output-error") return true;
  if (output && typeof output === "object" && "status" in output) {
    return (output as { status?: unknown }).status === "failed";
  }
  return false;
}

function computeSuppressedRetryParts(message: AgentMessage): Set<string> {
  const suppressed = new Set<string>();
  for (const family of RETRY_SUPERSEDE_FAMILIES) {
    const familyParts: Array<{
      toolCallId: string;
      index: number;
      failed: boolean;
    }> = [];
    message.parts.forEach((part, index) => {
      if (part.type !== "tool") return;
      if (!family.has(part.toolName)) return;
      familyParts.push({
        toolCallId: part.toolCallId,
        index,
        failed: isFailedToolPart(part.output, part.state),
      });
    });

    for (const a of familyParts) {
      if (!a.failed) continue;
      // A failed part is replaced by ANY later sibling of the same family —
      // the later one's own state (skeleton / success / error) owns the slot.
      const supersededBy = familyParts.find((b) => b.index > a.index);
      if (supersededBy) suppressed.add(a.toolCallId);
    }
  }
  return suppressed;
}

const MessageContent: React.FC<MessageContentProps> = React.memo(
  ({ message, mode, addToolResult, onUserPrompt, onRequestApproval }) => {
    const isUser = message.role === "user";
    const suppressedBalanceParts = computeSuppressedToolParts(message);
    const suppressedRetryParts = computeSuppressedRetryParts(message);
    // Generic once-per-turn rule for list tools: when the model fans one
    // goal into several calls of the same tool (e.g. an opportunity list
    // per chain), render ONE card carrying the union of the results.
    const consolidated = consolidateToolParts(message.parts);
    const originDisplayName = useOriginAgentDisplay(message.originAgentId);

    return (
      <View className="w-full">
        {!isUser && originDisplayName ? (
          <Text className="mb-1 text-xs text-muted">
            via {originDisplayName}
          </Text>
        ) : null}
        {(() => {
          // Several DeFi cards embed the same "set up your strategy" CTA, so
          // a turn listing e.g. USDC and USDT opportunities rendered it twice.
          // Grant it to the first CTA-capable part that actually renders —
          // a suppressed part (consolidated duplicate, superseded retry)
          // would silently swallow the CTA.
          const setupCtaOwner = message.parts.find(
            (p) =>
              p.type === "tool" &&
              SETUP_CTA_TOOLS.has(p.toolName) &&
              !consolidated.suppressed.has(p.toolCallId) &&
              !suppressedBalanceParts.has(p.toolCallId) &&
              !suppressedRetryParts.has(p.toolCallId),
          );
          const setupCtaOwnerId =
            setupCtaOwner && setupCtaOwner.type === "tool"
              ? setupCtaOwner.toolCallId
              : undefined;
          return message.parts.map((part, i) => {
            if (part.type === "text") {
              if (isUser) {
                return (
                  <PlainTextMessage key={`text-${i}`} content={part.text} />
                );
              }
              // Space consecutive assistant text blocks so two segments never
              // glue into a run-on ("…have it!I need…"). The first block sits
              // flush; later blocks get a paragraph gap above.
              return (
                <View key={`text-${i}`} className={i > 0 ? "mt-2" : undefined}>
                  <MarkdownMessage content={part.text} />
                </View>
              );
            }

            if (part.type === "tool") {
              const Component = toolComponents[part.toolName];
              if (!Component) return null;
              if (suppressedBalanceParts.has(part.toolCallId)) return null;
              if (suppressedRetryParts.has(part.toolCallId)) return null;
              if (consolidated.suppressed.has(part.toolCallId)) return null;

              // The surviving card of a consolidated group renders the union
              // of its siblings' rows; every other part renders its own.
              const renderedOutput = consolidated.outputs.has(part.toolCallId)
                ? consolidated.outputs.get(part.toolCallId)
                : part.output;

              const liveCallback =
                mode === "live" && addToolResult
                  ? (output: unknown) => addToolResult(part.toolCallId, output)
                  : undefined;
              // `onUserPrompt` only appends a user message, which is safe
              // from any card — including a historical one (e.g. depositing
              // from an earlier OpportunityListCard after the turn settled).
              // Unlike addToolResult/onRequestApproval (write/approval gates
              // kept live-only above), it never acts on stale state.
              // IntentPreviewCard independently guards on `mode !==
              // "historical"`, so it stays inert when frozen.
              const livePromptCallback = onUserPrompt;
              const liveRequestApproval =
                mode === "live" && onRequestApproval
                  ? () => onRequestApproval(part.toolCallId)
                  : undefined;
              return (
                <Component
                  key={part.toolCallId}
                  state={part.state}
                  input={part.input}
                  output={renderedOutput}
                  error={part.error}
                  mode={mode}
                  addToolResult={liveCallback}
                  onUserPrompt={livePromptCallback}
                  decision={part.decision}
                  onRequestApproval={liveRequestApproval}
                  showSetupCTA={part.toolCallId === setupCtaOwnerId}
                />
              );
            }

            return null;
          });
        })()}
      </View>
    );
  },
);

MessageContent.displayName = "MessageContent";

export default MessageContent;
