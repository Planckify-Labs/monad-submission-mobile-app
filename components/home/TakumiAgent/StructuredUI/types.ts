import type React from "react";
import type { AgentMessagePart } from "@/services/agent-messages/types";

/**
 * Authorization decision threaded to a live write card (deny-layer spec
 * §6.5). Mirrors the `decision` on the tool message part.
 */
export type ToolDecision = "authorized" | "ask" | "deny";

export type ToolComponentProps<Input, Output> = {
  state: Extract<AgentMessagePart, { type: "tool" }>["state"];
  input: Input;
  output?: Output;
  error?: string;
  mode: "live" | "historical";
  addToolResult?: (output: Output) => void;
  // Inline shortcut: a card can send a fresh user message to the
  // agent (e.g. OpportunityListCard's "Let Takumi pick for you"
  // footer). Undefined in historical mode so frozen cards stay inert.
  onUserPrompt?: (prompt: string) => void;
  /**
   * Authorization decision for this call (deny-layer spec §6.5). A write
   * card renders the run-down veto ONLY when this is `authorized`
   * (INV-1); for `ask` it renders the static proposal card whose Approve
   * calls `onRequestApproval`. Absent → fail closed (treat as `ask`).
   */
  decision?: ToolDecision;
  /**
   * Open the approval sheet for an `ask` decision (deny-layer §4.1 step
   * 2). The proposal card's Approve button calls this — it does NOT
   * execute or post a result. Undefined in historical mode.
   */
  onRequestApproval?: () => void;
  /**
   * Whether this card may render the "set up your DeFi strategy" CTA.
   *
   * Several DeFi cards embed the same CTA, so a turn that lists (say)
   * USDC and USDT opportunities used to render it once per card. The
   * parent (`MessageContent`) grants it to the FIRST CTA-capable card in
   * a message and withholds it from the rest, so the prompt appears once.
   * Defaults to true when a card is rendered outside that parent.
   */
  showSetupCTA?: boolean;
};

export type ToolComponent<Input, Output> = React.ComponentType<
  ToolComponentProps<Input, Output>
>;
