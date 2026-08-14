// TWV-2026-051 — Scam-domain feed integration. Inferno / Pink / Angel
// drainers harvest Permit / Permit2 signatures via lookalike airdrop
// claim sites. The defence pair: block signatures on flagged origins
// using a live feed, and surface a pending-permits screen for revoke.
//
// This module is the lookup gate. The ACTUAL feed (ScamSniffer /
// Blockaid / GoPlus) is fetched + cached by a background task — that
// integration is a follow-up that requires the chosen vendor's API
// key. For now: a small embedded list of known-bad hosts that the
// background task can replace, and the predicate the bridge / signer
// UI calls.
//
// Privacy invariant: feed lookups MUST NOT include the user's wallet
// address. Hash the domain only.

import { parseUrl } from "@/services/dappsBrowser/omnibox";

let cachedFlagged: Set<string> | null = null;
let cachedAt = 0;

const FALLBACK_FLAGGED: ReadonlySet<string> = new Set([
  // Embed a tiny seed list so the predicate is non-trivial even
  // before the background-fetched feed lands. Add via PR review.
  "uniswap-airdrop.com",
  "uniswap-claim.io",
  "lido-staking.app",
  "free-eth-airdrop.com",
  "metamask-update.com",
]);

const STALE_TTL_MS = 12 * 60 * 60 * 1000; // 12h

/**
 * Replace the in-memory flagged set. Called by the background task
 * after a successful feed fetch. Hosts MUST be lowercased.
 */
export function setFlaggedHosts(hosts: Iterable<string>): void {
  cachedFlagged = new Set(Array.from(hosts).map((h) => h.toLowerCase()));
  cachedAt = Date.now();
}

/**
 * Bare hostname for a lookup, lowercased. Accepts either a full URL or a
 * naked host.
 *
 * This used to be `try { new URL(raw).hostname } catch { return false }`.
 * On device that catch is unreachable: React Native's `URL` is a regex
 * shim that never throws and returns `""` for a hostname it cannot match
 * (see the note at the top of `omnibox.ts`). A blocklist that silently
 * looks up the empty string is a blocklist that never fires, and the
 * failure is invisible because the Node test runner has a real WHATWG
 * `URL` and passes. `parseUrl` is the repo's own parser and behaves the
 * same in both places.
 */
function hostForLookup(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const parsed = parseUrl(trimmed);
  if (parsed) return parsed.host;
  // Callers also pass bare hosts (a permission-store origin key, a
  // suggestion row). Accept those, but only if they look like a hostname
  // rather than a path or free text.
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(trimmed) ? trimmed : null;
}

export function isFlaggedHost(rawUrl: string): boolean {
  const host = hostForLookup(rawUrl);
  if (!host) return false;
  // Spec rule: when feed is stale, fall back to fallback list — DO NOT
  // soft-fail open for known-flagged cached entries.
  const live =
    cachedFlagged && Date.now() - cachedAt < STALE_TTL_MS
      ? cachedFlagged
      : null;
  if (live?.has(host)) return true;
  if (live && Array.from(live).some((flagged) => host.endsWith(`.${flagged}`)))
    return true;
  if (FALLBACK_FLAGGED.has(host)) return true;
  for (const f of FALLBACK_FLAGGED) {
    if (host.endsWith(`.${f}`)) return true;
  }
  return false;
}

/**
 * The methods that produce a signature; the bridge MUST hard-block
 * these when `isFlaggedHost(origin) === true`. `personal_sign` and
 * `eth_signTypedData_v4` are the active drainer surfaces; broader
 * `eth_sendTransaction` is the legacy ice-phish path.
 */
export const SIGNATURE_PRODUCING_METHODS: ReadonlySet<string> = new Set([
  "personal_sign",
  "eth_signTypedData",
  "eth_signTypedData_v1",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
  "eth_sendTransaction",
  "eth_signTransaction",
]);
