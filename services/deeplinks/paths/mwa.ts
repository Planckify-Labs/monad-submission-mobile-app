/**
 * `/mobilewalletadapter/v1/associate/local?…` — the `wallet_uri_base`
 * form of a Mobile Wallet Adapter association (spec §2.2.2 / §8). The
 * association itself is handled by the dedicated MWA host activity on
 * Android; if this path reaches the main app (iOS, or Android with the
 * plugin absent) it is refused with copy rather than silently ignored.
 */

import type { DeepLinkIntent } from "../types";
import type { PathParseArgs } from "./index";

export function parseMwaPath({
  rest,
  query,
  envelope,
  provenance,
}: PathParseArgs): DeepLinkIntent {
  const [version, associate, local] = rest;
  if (version !== "v1" || associate !== "associate" || local !== "local") {
    return { kind: "reject", code: "unsupported_operation" };
  }
  if (envelope.platform !== "android") {
    return { kind: "reject", code: "unsupported_scheme" };
  }
  const association = query.get("association");
  const port = Number(query.get("port"));
  if (!association || !Number.isInteger(port) || port < 49152 || port > 65535) {
    return { kind: "reject", code: "malformed" };
  }
  const uri = `solana-wallet:/v1/associate/local?${query.toString()}`;
  return {
    kind: "associate",
    transport: "mwa",
    uri,
    provenance: { ...provenance, transport: "mwa" },
  };
}
