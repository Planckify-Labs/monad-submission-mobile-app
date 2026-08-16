import { useCallback, useMemo } from "react";
import { queryClient } from "@/app/_layout";
import useRQGlobalState from "./useRQGlobalState";

/**
 * Global SSE connection state for the active agent turn. Published by
 * `AgentMode.tsx` from the session's `onReconnecting` / `onReconnected`
 * UI bindings (see `services/agentSession/agentSession.ts`).
 *
 * Read directly by `WriteApprovalGate.tsx` (and any other card) instead
 * of prop-drilling through `MessageContent` → the `toolComponents`
 * registry → each card component, per the `avoid-props-drilling`
 * convention.
 */
export interface AgentConnectionState {
  isReconnecting: boolean;
  attempt: number;
}

const AGENT_CONNECTION_QUERY_KEY = ["agent-connection-state"] as const;

const DEFAULT_STATE: AgentConnectionState = {
  isReconnecting: false,
  attempt: 0,
};

export function useAgentConnectionPublisher() {
  const publish = useCallback((next: AgentConnectionState) => {
    const current =
      queryClient.getQueryData<AgentConnectionState>(
        AGENT_CONNECTION_QUERY_KEY,
      ) ?? DEFAULT_STATE;
    if (
      next.isReconnecting === current.isReconnecting &&
      next.attempt === current.attempt
    ) {
      return;
    }
    queryClient.setQueryData(AGENT_CONNECTION_QUERY_KEY, next);
  }, []);

  const clear = useCallback(() => {
    const current = queryClient.getQueryData<AgentConnectionState>(
      AGENT_CONNECTION_QUERY_KEY,
    );
    if (current && !current.isReconnecting && current.attempt === 0) return;
    queryClient.setQueryData(AGENT_CONNECTION_QUERY_KEY, DEFAULT_STATE);
  }, []);

  return useMemo(() => ({ publish, clear }), [publish, clear]);
}

export function useAgentConnection(): AgentConnectionState {
  const { data } = useRQGlobalState<AgentConnectionState>({
    queryKey: AGENT_CONNECTION_QUERY_KEY,
    initialData: DEFAULT_STATE,
  });
  return data ?? DEFAULT_STATE;
}
