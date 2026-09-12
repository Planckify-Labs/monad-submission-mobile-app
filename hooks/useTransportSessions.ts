/**
 * Live sessions across every session transport (WalletConnect,
 * Phantom-compatible encrypted links, MWA scopes on Android). Shared by
 * the dApp-permissions "Connected apps" section and the dApps-browser
 * connection sheet (which matches sessions to the open site by peer URL,
 * since transport grants are keyed `wc+https://…#topic`, never by the
 * WebView origin).
 */

import { useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";
import { encryptedLinkTransport } from "@/services/transports/encryptedLink";
import type {
  TransportAdapter,
  TransportSession,
} from "@/services/transports/types";
import { walletConnectTransport } from "@/services/transports/walletconnect";

export const TRANSPORT_LABEL: Record<TransportSession["transport"], string> = {
  walletconnect: "WalletConnect",
  mwa: "Mobile Wallet Adapter",
  "encrypted-link": "App link",
};

function loadMwaTransport(): TransportAdapter | null {
  if (Platform.OS !== "android") return null;
  try {
    // Android-only native module; resolved lazily so iOS never loads it.
    return (
      require("@/services/transports/mwa") as { mwaTransport: TransportAdapter }
    ).mwaTransport;
  } catch {
    return null;
  }
}

let cached: TransportAdapter[] | null = null;

/** Every transport adapter available on this platform (stable identity). */
export function allTransports(): TransportAdapter[] {
  if (!cached) {
    const list: TransportAdapter[] = [
      walletConnectTransport,
      encryptedLinkTransport,
    ];
    const mwa = loadMwaTransport();
    if (mwa) list.push(mwa);
    cached = list;
  }
  return cached;
}

export function useTransportSessions(
  transports: TransportAdapter[] = allTransports(),
  opts: {
    /**
     * Start every transport on mount (the permissions screen wants the
     * full picture). Off, the hook only mirrors what is already running;
     * `bootTransports` starts WalletConnect whenever sessions exist, so
     * a passive reader such as the browser sheet still sees them.
     */
    eager?: boolean;
  } = {},
): TransportSession[] {
  const eager = opts.eager ?? true;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const unsubs = transports.map((t) =>
      t.subscribe(() => setTick((n) => n + 1)),
    );
    if (eager) for (const t of transports) void t.start();
    return () => {
      for (const u of unsubs) u();
    };
  }, [transports, eager]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the invalidation signal from the transports' subscriptions.
  return useMemo(
    () => transports.flatMap((t) => t.sessions()),
    [transports, tick],
  );
}

/** Disconnect a transport session by id (revokes its grants, notifies the peer). */
export async function disconnectTransportSession(
  transport: TransportSession["transport"],
  sessionId: string,
): Promise<void> {
  const t = allTransports().find((x) => x.id === transport);
  if (t) await t.disconnect(sessionId);
}
