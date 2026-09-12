/**
 * Legacy classifier — reduced to what in-app callers still need (spec
 * §13.2 "router.ts"): `classifyURI` answers "is this a third-party web
 * page to open in the dApp browser, or one of our own links?" for the
 * agent's markdown link handler. Everything that carries intent goes
 * through `services/deeplinks/intake.ts`; the old `handleDeepLink` with
 * its direct `router.push("/send")` is gone (invariant S-1) and the
 * duplicate ERC-681 parser with it (F8 — `walletUri.ts` is the single
 * parser, reached through `services/chains/evm/deeplinks.ts`).
 *
 * No `new URL`: RN's implementation is a regex shim
 * (`feedback_rn_url_is_regex_shim`); `splitUri` / `hostnameOfHttps` are
 * explicit.
 */

import { VERIFIED_HOST } from "@/services/security/deeplinkGate";
import { hostnameOfHttps, splitUri } from "./uri";

export type DeepLinkResult =
  /** A third-party http(s) page — open in the in-app browser. */
  | { type: "dapp"; url: string }
  /** One of our own links (verified host or own scheme) — the kernel owns it. */
  | { type: "own"; raw: string }
  /** Anything with a non-web scheme — hand it to the kernel / OS. */
  | { type: "unknown"; raw: string };

export function classifyURI(uri: string): DeepLinkResult {
  const split = splitUri(uri);
  if (!split) return { type: "unknown", raw: uri };
  if (split.scheme === "https" || split.scheme === "http") {
    const host = hostnameOfHttps(uri.replace(/^http:/i, "https:"));
    if (!host) return { type: "unknown", raw: uri };
    if (host === VERIFIED_HOST) return { type: "own", raw: uri };
    return { type: "dapp", url: uri };
  }
  return { type: "unknown", raw: uri };
}
