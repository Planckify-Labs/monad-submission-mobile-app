/**
 * WalletConnect pairing-URI scheme handler — deep-link spec §4.4 / §7.3.
 *
 * Pure: validates the EIP-1328 shape (`wc:<topic>@<version>?<params>`,
 * required `symKey`, `relay-protocol`, optional `expiryTimestamp`) and
 * emits a `pair` intent. Pairing itself (`walletConnectTransport.pair`)
 * runs after the interstitial's Continue, or straight away from the QR
 * scanner (D-10: the sheet is the consent there).
 */

import type { DeepLinkSchemeHandler } from "@/services/deeplinks/schemeRegistry";
import type { DeepLinkIntent } from "@/services/deeplinks/types";

const TOPIC_RE = /^[0-9a-f]{64}$/i;

/**
 * `https://takumipay.xyz/wc?wc_ev=…&topic=…` — a Phase 2b Link Mode
 * envelope (a relay message for an existing session), not a pairing URI.
 */
export function isLinkModeEnvelope(uri: string): boolean {
  return /[?&]wc_ev=/.test(uri) && /[?&]topic=/.test(uri);
}

const SESSION_TOPIC_RE = /[?&]sessionTopic=([0-9a-f]{64})(?:&|$|#)/i;
const REQUEST_ID_RE = /[?&]requestId=(\d{1,32})(?:&|$|#)/;

/**
 * `handleDeeplinkRedirect` in `@walletconnect/sign-client` opens
 * `<WALLETCONNECT_DEEPLINK_CHOICE.href>/wc?requestId=<id>&sessionTopic=<topic>`
 * when a dApp sends a request. What `href` is depends on the dApp
 * library: our native scheme (`takumiwallet://wc?…`), our universal link
 * (`https://takumipay.xyz/wc/wc?…`), a formatted pairing redirect
 * (`takumiwallet://wc?uri=<enc>/wc?…`), or, with RainbowKit, the raw
 * pairing URI cut at `?` (`wc:<topic>@2/wc?…`). All of them mean the same
 * thing: "come to the front, a request is waiting on `sessionTopic`".
 * Returns the request/topic pair when `raw` has that shape.
 */
export function parseRequestRedirect(
  raw: string,
): { topic: string; requestId: string } | null {
  if (
    !/(?:^|[/:?&])wc\?[^#]*requestId=/i.test(raw) &&
    !/[?&]requestId=/.test(raw)
  )
    return null;
  const topic = SESSION_TOPIC_RE.exec(raw)?.[1];
  const requestId = REQUEST_ID_RE.exec(raw)?.[1];
  if (!topic || !requestId) return null;
  return { topic: topic.toLowerCase(), requestId };
}

export function validatePairingUri(
  ssp: string,
  query: URLSearchParams,
):
  | { ok: true; topic: string }
  | { ok: false; code: "malformed" | "expired" | "unsupported_operation" } {
  const [topic, version] = ssp.split("@");
  if (!topic || !TOPIC_RE.test(topic)) return { ok: false, code: "malformed" };
  if (version !== "2") return { ok: false, code: "unsupported_operation" };
  if (!query.get("symKey")) return { ok: false, code: "malformed" };
  const relay = query.get("relay-protocol");
  if (!relay) return { ok: false, code: "malformed" };
  if (relay !== "irn") return { ok: false, code: "unsupported_operation" };
  const expiry = query.get("expiryTimestamp");
  if (expiry) {
    const n = Number(expiry);
    if (!Number.isFinite(n)) return { ok: false, code: "malformed" };
    if (n * 1000 < Date.now()) return { ok: false, code: "expired" };
  }
  return { ok: true, topic };
}

export const walletConnectPairHandler: DeepLinkSchemeHandler = {
  id: "walletconnect",
  namespace: null,
  schemes: ["wc"],
  priority: 10,
  parse(split, envelope): DeepLinkIntent {
    const v = validatePairingUri(split.ssp, split.query);
    if (!v.ok) return { kind: "reject", code: v.code };
    return {
      kind: "pair",
      transport: "walletconnect",
      uri: envelope.raw,
      provenance: {
        verification: { kind: "none" },
        firstSeen: false,
        transport: "walletconnect",
        source: envelope.source,
      },
    };
  },
};

export const walletConnectDeepLinkHandlers: readonly DeepLinkSchemeHandler[] = [
  walletConnectPairHandler,
];
