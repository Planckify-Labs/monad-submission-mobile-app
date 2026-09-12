/**
 * Scheme registry — the chain-agnostic dock (spec §4.4).
 *
 * Mirrors `services/paymentIntent/detectorRegistry.ts`: per-namespace
 * files call `registerSchemeHandler()` at module load, `parseDeepLink()`
 * dispatches by scheme, and nothing here names a chain. Adding a chain
 * family is one `services/chains/<ns>/deeplinks.ts` file plus one import
 * in `services/deeplinks/boot.ts`.
 *
 * Priority is numeric, lower first, for schemes shared by two handlers
 * (`solana` → transfer vs transaction request). A handler returns
 * `null` to decline so the next one can try; the first non-null wins.
 */

import type { Namespace } from "@/services/chains/types";
import type {
  DeepLinkEnvelope,
  DeepLinkIntent,
  DeepLinkParseContext,
  DeepLinkPlatform,
} from "./types";
import type { SplitUri } from "./uri";
import { splitUri } from "./uri";

export interface DeepLinkSchemeHandler {
  /** "eip681" | "solana-pay-transfer" | "sep7" | "walletconnect" | … */
  id: string;
  /** `null` = transport-level (e.g. WalletConnect pairing). */
  namespace: Namespace | null;
  /** Lower-case schemes this handler claims, e.g. `["solana"]`. */
  schemes: readonly string[];
  /** Omit = both platforms. MWA sets `["android"]`. */
  platforms?: readonly DeepLinkPlatform[];
  /**
   * The OS routes this scheme to a component of ours other than the main
   * app (the MWA host activity), so an in-app WebView must hand it to the
   * OS rather than the kernel.
   */
  osOwned?: boolean;
  /** Lower runs first. */
  priority: number;
  /**
   * Pure and synchronous: no network, no keystore, no storage. Returns
   * `null` to decline (another handler for the same scheme may match).
   */
  parse(
    split: SplitUri,
    envelope: DeepLinkEnvelope,
    ctx: DeepLinkParseContext,
  ): DeepLinkIntent | null;
}

const handlers: DeepLinkSchemeHandler[] = [];

export function registerSchemeHandler(h: DeepLinkSchemeHandler): void {
  if (handlers.some((x) => x.id === h.id)) return;
  handlers.push(h);
  handlers.sort((a, b) => a.priority - b.priority);
}

export function listSchemeHandlers(): readonly DeepLinkSchemeHandler[] {
  return [...handlers];
}

/** Every scheme any registered handler claims (used by the config test). */
export function registeredSchemes(): string[] {
  const out = new Set<string>();
  for (const h of handlers) for (const s of h.schemes) out.add(s);
  return [...out].sort();
}

/** `true` when the scheme's handler declares it `osOwned` (see the field). */
export function isOsOwnedScheme(scheme: string): boolean {
  const s = scheme.toLowerCase();
  return handlers.some((h) => h.osOwned === true && h.schemes.includes(s));
}

/** `true` when a handler exists for `scheme` on `platform`. */
export function hasHandlerForScheme(
  scheme: string,
  platform: DeepLinkPlatform,
): boolean {
  const s = scheme.toLowerCase();
  return handlers.some(
    (h) =>
      h.schemes.includes(s) && (!h.platforms || h.platforms.includes(platform)),
  );
}

/**
 * Dispatch a URI to the registered handlers. Never throws: a handler
 * that throws on attacker-controlled input is treated as `malformed`.
 */
export function parseDeepLink(
  envelope: DeepLinkEnvelope,
  ctx: DeepLinkParseContext,
  rawOverride?: string,
): DeepLinkIntent {
  const raw = rawOverride ?? envelope.raw;
  // Handlers read `envelope.raw` (SEP-0007 signs the URI byte-for-byte),
  // so an inner URI unwrapped from `/pay?uri=` must be what they see.
  const inner: DeepLinkEnvelope =
    raw === envelope.raw ? envelope : { ...envelope, raw };
  const split = splitUri(raw);
  if (!split) return { kind: "reject", code: "malformed" };
  const candidates = handlers.filter(
    (h) =>
      h.schemes.includes(split.scheme) &&
      (!h.platforms || h.platforms.includes(envelope.platform)),
  );
  if (candidates.length === 0) {
    return { kind: "reject", code: "unsupported_scheme" };
  }
  for (const h of candidates) {
    try {
      const out = h.parse(split, inner, ctx);
      if (out) return out;
    } catch (e) {
      if (typeof __DEV__ !== "undefined" && __DEV__) {
        console.warn("[deeplinks] handler threw", h.id, e);
      }
      return { kind: "reject", code: "malformed" };
    }
  }
  return { kind: "reject", code: "malformed" };
}

/** Test seam. */
export function __resetSchemeRegistryForTest(): void {
  handlers.length = 0;
}
