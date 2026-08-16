/**
 * SSE client for the Takumi Agent API.
 *
 * The server exposes the SSE stream on `POST /chat` (see
 * AGENT_PROTOCOL.md §4, §8.3). React Native does not ship with a
 * built-in `EventSource`, so we use `expo/fetch` — the same primitive
 * already used by `components/home/TakumiAgent/AgentMode.tsx` to drive
 * the existing chat — and parse the `text/event-stream` body chunk by
 * chunk. `expo/fetch` yields a WHATWG `ReadableStream` on
 * `response.body`, which the rest of the RN runtime does not reliably
 * provide when you call `global.fetch` directly.
 *
 * Responsibilities:
 *   1. Open the stream with the right headers + query-param auth
 *      (matching `networkHelpers.ts`).
 *   2. Parse each `data:` line into a typed `AgentEvent` and push it
 *      onto an async iterator.
 *   3. Reconnect on drop while the caller reports unresolved
 *      `tool_pending` events, with exponential backoff capped at 30s.
 *   4. Dedupe re-emitted `tool_pending` events by `tool_call_id` — the
 *      dispatcher already dedupes, but doing it here too keeps the
 *      event stream clean and avoids log noise.
 *
 * What this file does NOT do:
 *   - It does not know about `resolveUxTreatment`, `EXECUTORS`, the UI
 *     bindings, or any domain logic. Those live in `dispatcher.ts` and
 *     `agentSession.ts`. Keeping this file transport-only makes it
 *     trivially mockable from the test runner.
 */

import { fetch as expoFetch } from "expo/fetch";
import { __internals as net } from "./networkHelpers.ts";
import type { AgentEvent, ChatRequest } from "./protocol.ts";

// --- Public types -----------------------------------------------------------

export interface SseClientOptions {
  /** Request body for the initial `POST /chat`. */
  request: ChatRequest;
  /**
   * Snapshot of `pending_approvals.size` at stream-drop time. Called
   * _without_ arguments — returns the current map size when invoked.
   * Reconnect is only attempted when this returns `> 0`.
   */
  hasPendingApprovals: () => boolean;
  /**
   * Hook fired each time a reconnect attempt is about to run. Receives
   * the attempt number (1-indexed) and the backoff delay in ms. Useful
   * for surfacing "Reconnecting…" state in the chat UI.
   */
  onReconnectAttempt?: (attempt: number, delayMs: number) => void;
  /**
   * Hook fired when the client gives up reconnecting (stream closed
   * while `pending_approvals` was empty — nothing to resume).
   */
  onClosed?: () => void;
}

/**
 * Handle returned by `openSseStream`. Callers iterate the `events`
 * async iterable and call `close()` on `done` / unmount.
 */
export interface SseClientHandle {
  events: AsyncIterable<AgentEvent>;
  close: () => void;
}

// --- Constants --------------------------------------------------------------

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

// --- Parser helpers ---------------------------------------------------------

/**
 * Parse a single SSE message block (everything between two blank lines).
 * Returns `null` when the block is a keepalive / empty / malformed.
 *
 * SSE framing recap: each block is a set of `field: value` lines. The
 * Takumi Agent API emits standard framing — an `event:` line carrying
 * the event name followed by one or more `data:` lines whose joined
 * payload is the JSON body. The server's `encodeSseEvent` helper
 * (see `agent-api/src/chat.events.ts`) produces exactly:
 *
 *     event: text_delta
 *     data: {"content":"..."}
 *
 * so the parser must reconstruct `{event, data}` from the `event:` line
 * plus the decoded `data:` payload. A small fallback also accepts the
 * legacy wrapped shape (`data: {"event":"...","data":...}`) so older
 * server builds don't break the chat.
 */
function parseSseBlock(block: string): AgentEvent | null {
  const lines = block.split("\n");
  const dataLines: string[] = [];
  let eventName: string | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const field = line.slice(0, colonIdx);
    // Skip exactly one space after the colon per the SSE spec.
    const value = line.slice(colonIdx + 1).replace(/^ /, "");
    if (field === "data") {
      dataLines.push(value);
    } else if (field === "event") {
      eventName = value;
    }
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  let parsedData: unknown;
  try {
    parsedData = JSON.parse(payload);
  } catch {
    // Silently drop malformed frames — the server never emits them.
    return null;
  }

  // Preferred path: event name on the `event:` line, data on the
  // `data:` line.
  if (eventName) {
    return { event: eventName, data: parsedData } as AgentEvent;
  }

  // Legacy fallback: the whole `{event, data}` shape embedded in the
  // data payload. Kept so old server builds don't silently break.
  if (
    parsedData &&
    typeof parsedData === "object" &&
    typeof (parsedData as { event?: unknown }).event === "string"
  ) {
    return parsedData as AgentEvent;
  }

  return null;
}

// --- Stream opener ----------------------------------------------------------

/**
 * Open a `POST /chat` SSE stream and return an async iterable of
 * typed `AgentEvent`s. Reconnects automatically while the caller still
 * has unresolved `tool_pending` events (see the spec §4 "SSE Reconnect
 * Mid-Turn").
 *
 * The returned iterable terminates either when:
 *   - the server emits `done` (caller breaks out)
 *   - the caller invokes `close()`
 *   - the stream drops AND `hasPendingApprovals()` returns `false` — this
 *     throws (via `onClosed` + rethrow) rather than returning silently,
 *     since there is nothing left to reconnect for but the caller still
 *     needs to know the turn died so it can stop showing a loading state.
 */
export function openSseStream(opts: SseClientOptions): SseClientHandle {
  let closed = false;
  const emittedToolCallIds = new Set<string>();

  /**
   * Single-attempt read of the SSE stream. Yields events until the
   * stream ends or an error is thrown. Reconnect logic lives in the
   * outer iterator — this function stays transport-only.
   */
  async function* readOnce(
    bodyOverride?: ChatRequest,
  ): AsyncGenerator<AgentEvent> {
    const body = bodyOverride ?? opts.request;
    // Use the same base URL + api key source as `networkHelpers`.
    const url = net.buildUrl("/chat");
    const headers = {
      ...net.buildHeaders(),
      Accept: "text/event-stream",
    };

    const response = await expoFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `[agentSession] POST /chat failed: ${response.status} ${text}`,
      );
    }

    // expo/fetch gives us a WHATWG ReadableStream — read with a reader.
    const reader = (
      response.body as unknown as ReadableStream<Uint8Array>
    ).getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        if (closed) return;
        const { value, done } = await reader.read();
        if (done) return;
        if (!value) continue;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are terminated by a blank line (\n\n). Some
        // servers emit \r\n\r\n — normalize before splitting.
        buffer = buffer.replace(/\r\n/g, "\n");
        let delimIdx = buffer.indexOf("\n\n");
        while (delimIdx !== -1) {
          const block = buffer.slice(0, delimIdx);
          buffer = buffer.slice(delimIdx + 2);
          const event = parseSseBlock(block);
          if (event) {
            // Dedupe `tool_pending` by tool_call_id so a reconnect-
            // triggered re-emit doesn't reach the dispatcher twice.
            // Other events (text_delta, status, etc.) are always
            // forwarded as-is.
            if (event.event === "tool_pending") {
              const id = event.data.tool_call_id;
              if (emittedToolCallIds.has(id)) {
                continue;
              }
              emittedToolCallIds.add(id);
            }
            yield event;
          }
          delimIdx = buffer.indexOf("\n\n");
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore — stream already closed
      }
    }
  }

  /**
   * The outer iterator with reconnect. On stream drop, checks
   * `hasPendingApprovals()`. If true, rebuilds the request body as
   * `{ session_id, messages: [], wallet_context }` per §4 and retries
   * with exponential backoff. Otherwise it emits `onClosed` and exits.
   */
  async function* withReconnect(): AsyncGenerator<AgentEvent> {
    let attempt = 0;
    // First iteration uses the real request; subsequent iterations
    // replace `messages` with `[]` to signal "reconnect only".
    let body: ChatRequest | undefined;

    while (!closed) {
      try {
        yield* readOnce(body);
        // `close()` was called explicitly (e.g. `done` already ran and
        // tore the session down, or the caller unmounted/reset) — this
        // is an intentional shutdown, not a drop. Nothing to surface.
        if (closed) return;
        // The stream ended on its own without an explicit `close()` and
        // without a `done`/`error` event ever having reached us — e.g.
        // the OS reclaimed the connection while the app was backgrounded,
        // or the network dropped mid-turn. With no pending approvals
        // there is nothing to resume per §4, but silently returning here
        // leaves the caller's `isStreaming` UI stuck forever with no
        // recovery path — throw so it falls into the same `onClosed` +
        // rethrow handling as a hard read error below, surfacing a
        // retryable error the caller's "Try again" affordance can use.
        if (!opts.hasPendingApprovals()) {
          throw new Error(
            "[agentSession] SSE stream ended unexpectedly with no pending approvals",
          );
        }
        // Stream ended but caller still has pending approvals — treat
        // as an implicit drop and fall through to reconnect.
      } catch (err) {
        if (closed) return;
        if (!opts.hasPendingApprovals()) {
          opts.onClosed?.();
          throw err;
        }
        // Fall through to reconnect.
      }

      // --- Backoff + reconnect -------------------------------------
      attempt += 1;
      const delayMs = Math.min(
        INITIAL_BACKOFF_MS * 2 ** (attempt - 1),
        MAX_BACKOFF_MS,
      );
      opts.onReconnectAttempt?.(attempt, delayMs);
      await sleep(delayMs);
      if (closed) return;

      // Build a reconnect body: same session_id, empty messages.
      // See AGENT_PROTOCOL.md §4 "SSE Reconnect Mid-Turn".
      body = {
        session_id: opts.request.session_id,
        messages: [],
        wallet_context: opts.request.wallet_context,
      };
    }
  }

  return {
    events: withReconnect(),
    close: () => {
      closed = true;
    },
  };
}

// --- Misc -------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
