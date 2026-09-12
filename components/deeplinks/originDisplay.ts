/**
 * How approval sheets name an origin — deep-link spec §11 / S-5.
 *
 * WebView origins are page URLs; external transports carry a
 * transport-prefixed key in `origin.url` and the peer's human string in
 * `origin.displayUrl`. Sheets must show the human string and must never
 * label a link-originated request "insecure" just because the key is
 * not `https://`: the security posture is carried by the provenance
 * banner, not by a padlock derived from the key's scheme.
 */

import type { Origin } from "@/services/chains/types";
import { isExternalOriginKey } from "@/services/deeplinks/originKey";

export interface OriginDisplay {
  /** Text for the host line. */
  host: string;
  /** Padlock state: `secure` (https page), `insecure` (http page), `link` (external transport / deep link). */
  security: "secure" | "insecure" | "link";
  /** Short chip label for external transports. */
  viaLabel: string | null;
}

function hostOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#]+)/i.exec(url);
  return m?.[1] ?? url;
}

export function describeOrigin(origin: Origin): OriginDisplay {
  const external =
    isExternalOriginKey(origin.url) ||
    (origin.via !== undefined &&
      origin.via !== "webview" &&
      origin.via !== "agent");
  const shown = origin.displayUrl ?? origin.url;
  if (external || origin.url.startsWith("link://")) {
    const viaLabel =
      origin.via === "walletconnect"
        ? "WalletConnect"
        : origin.via === "mwa"
          ? "Mobile Wallet Adapter"
          : "From a link";
    const host = origin.displayUrl
      ? hostOf(origin.displayUrl)
      : (origin.title ?? viaLabel);
    return { host, security: "link", viaLabel };
  }
  return {
    host: hostOf(shown),
    security: shown.startsWith("https://") ? "secure" : "insecure",
    viaLabel: null,
  };
}
