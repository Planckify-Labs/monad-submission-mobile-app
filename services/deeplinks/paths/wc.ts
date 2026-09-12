/**
 * `/wc?uri=<encoded wc URI>` — spec §4.4 / §5.
 *
 * AppKit opens a wallet with `<wallet link>/wc?uri=<encodeURIComponent(wcUri)>`
 * (`CoreHelperUtil.formatUniversalUrl` / `formatNativeUrl`). The inner
 * URI is validated by the registered WalletConnect scheme handler; this
 * path only unwraps it.
 */

import { parseDeepLink } from "../schemeRegistry";
import type { DeepLinkIntent } from "../types";
import { safeDecodeComponent } from "../uri";
import type { PathParseArgs } from "./index";

export function parseWcPath({
  query,
  envelope,
  ctx,
  provenance,
}: PathParseArgs): DeepLinkIntent {
  // Phase 2b Link Mode: `…/wc?wc_ev=<envelope>&topic=<topic>` carries a
  // relay message for an existing session, not a pairing. The SDK's own
  // `Linking` listener decrypts and dispatches it; the kernel hands the
  // URL to the transport only to make sure the SDK is started.
  if (query.get("wc_ev") && query.get("topic")) {
    return {
      kind: "pair",
      transport: "walletconnect",
      uri: envelope.raw,
      provenance: { ...provenance, transport: "walletconnect" },
      linkMode: true,
    };
  }
  const encoded = query.get("uri");
  if (!encoded) return { kind: "reject", code: "malformed" };
  const inner = safeDecodeComponent(encoded) ?? encoded;
  const intent = parseDeepLink(envelope, ctx, inner);
  if (intent.kind === "pair") {
    return { ...intent, provenance: { ...intent.provenance, ...provenance } };
  }
  if (intent.kind === "reject") return intent;
  // A `/wc` link must carry a pairing URI and nothing else.
  return { kind: "reject", code: "malformed" };
}
