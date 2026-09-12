/**
 * `/dapp/<url>` or `/dapp?url=<encoded>` — open a page in the in-app
 * browser (Class D). Only http(s) targets; the browser applies its own
 * scam-feed interstitial.
 */

import type { DeepLinkIntent } from "../types";
import { hostnameOfHttps, safeDecodeComponent } from "../uri";
import type { PathParseArgs } from "./index";

export function parseDappPath({ rest, query }: PathParseArgs): DeepLinkIntent {
  let target = query.get("url");
  if (!target && rest.length > 0) {
    target = safeDecodeComponent(rest.join("/"));
  }
  if (!target) return { kind: "reject", code: "malformed" };
  const decoded = safeDecodeComponent(target) ?? target;
  const withScheme = /^https?:\/\//i.test(decoded)
    ? decoded
    : `https://${decoded}`;
  if (!hostnameOfHttps(withScheme.replace(/^http:/i, "https:"))) {
    return { kind: "reject", code: "malformed" };
  }
  return { kind: "open-dapp", url: withScheme };
}
