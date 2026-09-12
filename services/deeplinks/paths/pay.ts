/**
 * `/pay?uri=<encoded chain URI>` — spec §4.4.
 *
 * Exists so a merchant or dApp targeting *this* wallet on iOS (where a
 * custom scheme's winner is undefined) has an exclusive entry that still
 * carries the chain's own standard URI unchanged. The inner URI is parsed
 * by the scheme registry exactly as if it had arrived bare; only the
 * provenance differs (`universal-link` when it came through our host).
 */

import { parseDeepLink } from "../schemeRegistry";
import type { DeepLinkIntent } from "../types";
import { safeDecodeComponent } from "../uri";
import type { PathParseArgs } from "./index";

export function parsePayPath({
  query,
  envelope,
  ctx,
  provenance,
}: PathParseArgs): DeepLinkIntent {
  const encoded = query.get("uri");
  if (!encoded) return { kind: "reject", code: "malformed" };
  // `URLSearchParams` already decoded once; a double-encoded value (what
  // AppKit-style `encodeURIComponent` wrapping produces) decodes again
  // harmlessly, a plain value is unchanged.
  const inner = safeDecodeComponent(encoded) ?? encoded;
  const intent = parseDeepLink(envelope, ctx, inner);
  if ("provenance" in intent) {
    // Keep what the chain handler learned (transport, claimed origin);
    // the entry path decides only how strongly we believe the link
    // targeted us.
    return {
      ...intent,
      provenance: {
        ...intent.provenance,
        verification: provenance.verification,
        source: provenance.source,
      },
    };
  }
  return intent;
}
