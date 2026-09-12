/**
 * `wc:` QR detector — deep-link spec §7.3 (priority 15).
 *
 * The scanner already recognises payment payloads; a WalletConnect
 * pairing QR is the one non-payment code users point the camera at. It
 * resolves to a `PaymentIntent`-shaped `{ channel: { kind: "wc", uri } }`
 * so `classify()` stays the single parser, and the scan screen routes it
 * to the pairing flow instead of `/send` (D-10: the ConnectSheet is the
 * consent, no interstitial for a QR the user chose to scan).
 */

import { type Detector, register } from "../detectorRegistry.ts";
import type { PaymentIntent, RawScan } from "../types.ts";

const WC_RE = /^wc:[0-9a-f]{64}@2\?/i;

const detect = (raw: RawScan): PaymentIntent | null => {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!WC_RE.test(trimmed)) return null;
  return {
    source: "qr",
    channel: { kind: "wc", uri: trimmed },
    rawScan: raw,
  };
};

export const walletConnectDetector: Detector = {
  name: "walletConnect",
  priority: 15,
  detect,
};

register(walletConnectDetector);
