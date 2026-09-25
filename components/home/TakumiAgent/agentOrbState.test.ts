import { describe, expect, it } from "vitest";
import { MOBILE_WRITE_TOOLS } from "@/services/agent-executors/expectedMobileTools";
import type { AgentMessagePart } from "@/services/agent-messages/types";
import {
  agentOrbState,
  agentStatusLabel,
  findRunningTool,
  type TAgentActivity,
} from "./agentOrbState";

const tool = (
  toolName: string,
  state: Extract<AgentMessagePart, { type: "tool" }>["state"],
): AgentMessagePart => ({
  type: "tool",
  toolName,
  toolCallId: `${toolName}-${state}`,
  input: {},
  state,
});

const idle: TAgentActivity = {
  status: null,
  composing: false,
  runningTool: null,
};
const reading = { toolName: "get_wallet_assets", isWrite: false };
const sending = { toolName: "send_token", isWrite: true };

describe("findRunningTool", () => {
  it("finds nothing when no tool is in flight", () => {
    expect(findRunningTool([], MOBILE_WRITE_TOOLS)).toBeNull();
    expect(
      findRunningTool(
        [
          { type: "text", text: "hi" },
          tool("get_wallet_assets", "output-available"),
        ],
        MOBILE_WRITE_TOOLS,
      ),
    ).toBeNull();
  });

  it("classifies a running read and a running write", () => {
    expect(
      findRunningTool(
        [tool("get_wallet_assets", "input-available")],
        MOBILE_WRITE_TOOLS,
      ),
    ).toEqual(reading);
    expect(
      findRunningTool(
        [tool("send_token", "input-available")],
        MOBILE_WRITE_TOOLS,
      ),
    ).toEqual(sending);
  });

  it("prefers the write when a read and a write run together", () => {
    expect(
      findRunningTool(
        [
          tool("send_token", "input-available"),
          tool("get_wallet_assets", "input-available"),
        ],
        MOBILE_WRITE_TOOLS,
      ),
    ).toEqual(sending);
  });

  it("never reads a declined write as running", () => {
    // The dispatcher's rejectDeclined moves the part to output-error.
    expect(
      findRunningTool([tool("send_token", "output-error")], MOBILE_WRITE_TOOLS),
    ).toBeNull();
  });
});

describe("agentOrbState", () => {
  it("breathes while the model thinks", () => {
    expect(agentOrbState(idle)).toBe("breathing");
    expect(agentOrbState({ ...idle, status: "Thinking…" })).toBe("breathing");
  });

  it("composes while reply text streams", () => {
    expect(agentOrbState({ ...idle, composing: true })).toBe("composing");
  });

  it("follows the phone's own tool activity, not server labels", () => {
    // "Thinking…" is still the last status while a phone tool runs.
    expect(
      agentOrbState({ ...idle, status: "Thinking…", runningTool: reading }),
    ).toBe("searching");
    expect(
      agentOrbState({ ...idle, status: "Thinking…", runningTool: sending }),
    ).toBe("shaping");
  });

  it("shows the connecting web on reconnect, above everything else", () => {
    expect(
      agentOrbState({
        ...idle,
        status: "Reconnecting… (attempt 2)",
        runningTool: sending,
      }),
    ).toBe("connecting");
  });

  it("works for the server-side handoff/clarify tools", () => {
    expect(agentOrbState({ ...idle, status: "Working…" })).toBe("working");
  });
});

describe("agentStatusLabel", () => {
  it("leaves thinking, working, reading and composing to the motion", () => {
    expect(agentStatusLabel(idle)).toBeNull();
    expect(agentStatusLabel({ ...idle, status: "Thinking…" })).toBeNull();
    expect(agentStatusLabel({ ...idle, status: "Working…" })).toBeNull();
    expect(agentStatusLabel({ ...idle, runningTool: reading })).toBeNull();
    expect(agentStatusLabel({ ...idle, composing: true })).toBeNull();
  });

  it("names a running write", () => {
    expect(
      agentStatusLabel({ ...idle, status: "Thinking…", runningTool: sending }),
    ).toBe("Processing transaction…");
  });

  it("doesn't call a recurring plan a transaction", () => {
    expect(MOBILE_WRITE_TOOLS.has("defi_set_recurring_invest")).toBe(true);
    expect(
      agentStatusLabel({
        ...idle,
        runningTool: { toolName: "defi_set_recurring_invest", isWrite: true },
      }),
    ).toBe("Saving your plan…");
  });

  it("says when the stream is reconnecting, even mid-write", () => {
    expect(
      agentStatusLabel({
        ...idle,
        status: "Reconnecting… (attempt 2)",
        runningTool: sending,
      }),
    ).toBe("Reconnecting… (attempt 2)");
  });
});
