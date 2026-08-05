/**
 * Bridge adapter registry.
 *
 * Spec: docs/bridge-capability-spec.md §5.2.
 *
 * Mirrors `services/defi/registry.ts`: register / get / list, no central
 * switch. Nothing here knows how many adapters exist or what they are
 * called.
 */

import type { TCaip2 } from "@/api/types/bridge";
import type { BridgeRouteAdapter } from "./types";

const adapters = new Map<string, BridgeRouteAdapter>();

export function registerBridgeAdapter(a: BridgeRouteAdapter): void {
  adapters.set(a.key, a);
}

export function getBridgeAdapter(key: string): BridgeRouteAdapter | null {
  return adapters.get(key) ?? null;
}

export function listBridgeAdapters(): BridgeRouteAdapter[] {
  return [...adapters.values()];
}

/** Test-only: drop every registration so suites start clean. */
export function resetBridgeAdapters(): void {
  adapters.clear();
}

/**
 * Adapters that can serve this route. Empty means a CAPABILITY BOUNDARY
 * (§7.6) — the card renders a plain explanatory state, not an error.
 */
export function resolveBridgeAdapters(
  from: TCaip2,
  to: TCaip2,
): BridgeRouteAdapter[] {
  return listBridgeAdapters().filter((a) => a.supports(from, to));
}

/**
 * Pick the adapter that produced a quote, falling back to route
 * resolution when the caller has no provider key (e.g. a status poll
 * restored from history).
 */
export function adapterForQuote(
  provider: string | undefined,
  from: TCaip2,
  to: TCaip2,
): BridgeRouteAdapter | null {
  if (provider) {
    const direct = getBridgeAdapter(provider);
    if (direct) return direct;
  }
  return resolveBridgeAdapters(from, to)[0] ?? null;
}
