import { useCallback } from "react";
import { queryClient } from "@/app/_layout";
import { storage } from "@/lib/storage/mmkv";
import useRQGlobalState from "./useRQGlobalState";

const AGENT_PREFILL_QUERY_KEY = ["agent-prefill-prompt"] as const;

/**
 * Durable twin of the in-memory prefill, for intents that must survive
 * leaving the screen — today only the DCA reminder
 * (docs/defi-quick-invest-spec.md §12.5b).
 */
const PENDING_PROMPT_KEY = "agent:pending-prompt";

export interface AgentPrefill {
  /** The prompt text handed to the agent chat. */
  text: string;
  /**
   * When true, `AgentMode` fires the prompt straight into a new turn
   * (capability / spotlight / quick-prompt cards — one-tap actions). When
   * false it only fills the composer for the user to review and send (the
   * voice mic, which prefills the transcript).
   */
  autoSend: boolean;
}

/**
 * One-shot channel for handing a prompt to the Takumi Agent chat from a
 * sibling screen (e.g. the home `TakumiAgentSection` voice bar / cards)
 * without prop-drilling through the home pager.
 *
 * The producer (home section) writes the text via `setPrefill`; the
 * consumer (`AgentMode`) reads it on mount / change. With `autoSend:false`
 * it drops the text into the `ChatInput` value (NOT auto-sent — the user
 * reviews and taps send); with `autoSend:true` it sends the prompt
 * immediately once the wallet/session context is ready. Either way it
 * `clearPrefill`s so a later remount doesn't re-fill / re-send a stale
 * value. Backed by `useRQGlobalState` so both screens share the same
 * React-Query cache entry.
 */
export function useAgentPrefill() {
  const { data, setNewData } = useRQGlobalState<AgentPrefill | null>({
    queryKey: AGENT_PREFILL_QUERY_KEY,
    initialData: null,
  });

  const setPrefill = useCallback(
    (text: string, options?: { autoSend?: boolean }) => {
      setNewData({ text, autoSend: options?.autoSend ?? false });
    },
    [setNewData],
  );

  const clearPrefill = useCallback(() => {
    setNewData(null);
  }, [setNewData]);

  return { prefill: data ?? null, setPrefill, clearPrefill };
}

/**
 * Set the prefill from OUTSIDE React.
 *
 * The push-notification response listener is module-level — it cannot call
 * a hook — so it writes the shared React Query cache entry directly. The
 * consumer (`AgentMode`) is unchanged; it reads the same key either way.
 *
 * `queryClient` is referenced inside the function body rather than at
 * module scope on purpose: `app/_layout` imports the push module, so a
 * top-level read would resolve to `undefined` during that import cycle.
 * By the time a notification is tapped, the module graph is long settled.
 */
export function setAgentPrefillDirect(
  text: string,
  options?: { autoSend?: boolean },
): void {
  queryClient.setQueryData<AgentPrefill>(AGENT_PREFILL_QUERY_KEY, {
    text,
    autoSend: options?.autoSend ?? false,
  });
}

/**
 * Remember an intent that must survive a detour through sign-in
 * (§12.5b — the failure mode unique to DCA).
 *
 * Every other prefill is produced and consumed inside one session. A DCA
 * nudge fires days or weeks after setup, by which point the JWT may have
 * expired with silent refresh failing. Without this, tapping the reminder
 * lands the user in a turn that immediately dead-ends on a sign-in error,
 * having promised action — and the intent is gone. Persisted rather than
 * held in memory because the sign-in detour can unmount the chat screen.
 *
 * Cleared only once the prompt has actually been sent with a live session.
 */
export function armPendingAgentPrompt(text: string): void {
  try {
    storage.set(PENDING_PROMPT_KEY, text);
  } catch (err) {
    if (__DEV__) console.warn("[agentPrefill] could not persist intent", err);
  }
}

export function readPendingAgentPrompt(): string | null {
  try {
    const value = storage.getString(PENDING_PROMPT_KEY);
    return value && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function clearPendingAgentPrompt(): void {
  try {
    storage.remove(PENDING_PROMPT_KEY);
  } catch {
    // Nothing to recover; a stale key only re-offers an intent the user
    // asked for, and the next successful send clears it.
  }
}
