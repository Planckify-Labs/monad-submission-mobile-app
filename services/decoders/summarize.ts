/**
 * AI plain-English summary layer — task 65 (TWV-2026-066) Phase D.
 *
 * One implementation for every chain: the input is the chain-agnostic
 * `ClearSigningDescriptor` Phase B already normalized — NEVER raw
 * hex/BCS/XDR bytes and never the dApp's own description. If Phase B
 * found nothing, this layer does not run (the AI must not guess at
 * unparseable bytes). Output is one plain-English sentence, or `null`
 * on any failure — callers hide the row entirely (CLAUDE.md
 * user-facing-errors rule: no raw API error ever reaches the sheet).
 *
 * Endpoint: `POST <EXPO_PUBLIC_AI_API_URL>/summarize/clear-signing`,
 * same base URL + `secrectApiKey` auth shape the agent chat uses
 * (`services/agentSession/networkHelpers.ts`).
 */

import type { ClearSigningDescriptor } from "@/services/walletKit/types";

/** Hard cap so a misbehaving backend can't dump paragraphs into the sheet. */
const MAX_SUMMARY_LENGTH = 240;

const REQUEST_TIMEOUT_MS = 6000;

function resolveEndpoint(): string | null {
  const base = process.env.EXPO_PUBLIC_AI_API_URL;
  const apiKey = process.env.EXPO_PUBLIC_SECRET_AI_KEY;
  if (!base || !apiKey) return null;
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}/summarize/clear-signing?secrectApiKey=${encodeURIComponent(apiKey)}`;
}

/**
 * Returns the one-sentence summary, or `null` when the endpoint is
 * unconfigured, unreachable, errors, times out, or answers with
 * anything that isn't a short string. Never throws.
 */
export async function summarizeClearSigningDescriptor(
  descriptor: ClearSigningDescriptor,
  opts?: { signal?: AbortSignal },
): Promise<string | null> {
  const endpoint = resolveEndpoint();
  if (!endpoint) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  opts?.signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.EXPO_PUBLIC_SECRET_AI_KEY ?? "",
      },
      body: JSON.stringify({ descriptor }),
      signal: controller.signal,
    });
    if (!res.ok) {
      if (typeof __DEV__ !== "undefined" && __DEV__) {
        console.warn("[summarize] clear-signing summary failed", res.status);
      }
      return null;
    }
    const json = (await res.json()) as { summary?: unknown };
    const summary = typeof json.summary === "string" ? json.summary.trim() : "";
    if (!summary || summary.length > MAX_SUMMARY_LENGTH) return null;
    return summary;
  } catch (err) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn("[summarize] clear-signing summary errored", err);
    }
    return null;
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener("abort", onOuterAbort);
  }
}
