/**
 * Session-transport boot — deep-link spec §7.1 / §9.
 *
 * WalletConnect starts eagerly when the wallet already holds sessions
 * (a relay message can arrive at any time) and lazily otherwise — the
 * first `pair()` starts it. The Phantom-compatible encrypted-link
 * transport has no background channel and needs no start. MWA lives in
 * its own activity / React root (`index.ts`, §8.1) and is not booted
 * from the main app.
 *
 * Called from `app/_layout.tsx` at module scope, fire-and-forget; every
 * failure is logged under `__DEV__` and leaves the wallet usable.
 */

import { getRootBridgeWallets } from "@/services/bridge/rootBoot";
import { FEATURE_WALLETCONNECT } from "@/services/deeplinks/flags";
import { walletConnectTransport } from "./walletconnect";

let booted = false;

export async function bootTransports(): Promise<void> {
  if (booted) return;
  booted = true;
  walletConnectTransport.bindWallets({ getWallets: getRootBridgeWallets });
  if (!FEATURE_WALLETCONNECT) return;
  try {
    if (await walletConnectTransport.hasStoredSessions()) {
      await walletConnectTransport.start();
    }
  } catch (e) {
    if (__DEV__)
      console.warn("[transports] WalletConnect eager start failed", e);
  }
}

/** Test seam. */
export function __resetTransportsBootForTest(): void {
  booted = false;
}
