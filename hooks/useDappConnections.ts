import { useCallback, useEffect, useMemo, useState } from "react";
import type { TWallet } from "@/constants/types/walletTypes";
import { getDappBridge } from "@/services/bridge/DappBridge";
import type { Namespace } from "@/services/chains/types";
import { isExternalOriginKey } from "@/services/deeplinks/originKey";
import { originHost, originKey } from "@/services/permissions/caip";
import {
  namespaceForChainKey,
  type PermissionGrant,
  PermissionStore,
} from "@/services/permissions/store";
import type { TransportSession } from "@/services/transports/types";
import { chainBadgeLabel } from "@/services/walletKit/chainInfo";
import {
  disconnectTransportSession,
  useTransportSessions,
} from "./useTransportSessions";

/** A wallet row as shown in the connection manager. */
export interface DappConnectionWallet {
  /** Display-cased address (the matched wallet's, else the grant's). */
  address: string;
  /** Wallet name, or a truncated address when the wallet isn't local. */
  name: string;
  namespace: Namespace;
  /** Compact chain code, e.g. "EVM" / "SOL" / "SUI". */
  badge: string;
  /** When the connection was first granted (0 for non-connected rows). */
  grantedAt: number;
  connected: boolean;
  /**
   * Set when the connection is a transport session (WalletConnect, MWA,
   * app link) whose peer URL is this site, rather than a WebView grant.
   * Disconnecting such a row ends the session.
   */
  via?: {
    transport: TransportSession["transport"];
    sessionId: string;
    originKey: string;
  };
}

/** A connected site, grouped for the hub-level "Connected sites" list. */
export interface DappConnectionSite {
  origin: string;
  wallets: DappConnectionWallet[];
  count: number;
}

export interface UseDappConnections {
  /** True when the passed `origin` has at least one grant. */
  isConnected: boolean;
  /** Wallets connected to the current `origin` (deduped across chains). */
  connectedWallets: DappConnectionWallet[];
  /** Local wallets NOT connected to the current `origin`. */
  otherWallets: DappConnectionWallet[];
  /** Every connected site, for the hub view. */
  sites: DappConnectionSite[];
  disconnectWallet: (args: {
    origin: string;
    address: string;
    via?: DappConnectionWallet["via"];
  }) => Promise<void>;
  disconnectSite: (args: { origin: string }) => Promise<void>;
}

interface UseDappConnectionsParams {
  /** Normalised inside; pass the live WebView URL or `null` on the hub. */
  origin: string | null;
  /** Local wallets (from a single `useWallet()` instance upstream). */
  wallets: TWallet[];
}

function shortName(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Reactive view over `PermissionStore` for the dApps-browser connection
 * manager. Joins persisted grants to the user's local wallets so each
 * connection shows a real wallet name + chain badge, and exposes
 * disconnect actions that route through `DappBridge.revokeConnection`
 * (which both revokes the grant AND fires the live wallet→dApp disconnect
 * event). Falls back to a bare `PermissionStore.revoke` if the bridge
 * singleton isn't up yet.
 *
 * Namespace-agnostic by construction: chain labels come from
 * `chainBadgeLabel` / `namespaceForChainKey` (services helpers), never a
 * `namespace === …` branch here — keeps the hook clean under `check:chains`.
 */
export function useDappConnections({
  origin,
  wallets,
}: UseDappConnectionsParams): UseDappConnections {
  const [grants, setGrants] = useState<PermissionGrant[]>(() =>
    PermissionStore.listAll(),
  );
  // Deep-link spec §4.9 / §7.6: a dApp opened in this browser may have
  // connected over WalletConnect (its modal navigated to `wc:`), which
  // lands under `wc+https://<host>#<topic>`, not the WebView origin. Match
  // those sessions to the open site by the peer's URL so the sheet shows
  // the connection the page is actually using.
  const sessions = useTransportSessions(undefined, { eager: false });

  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (active) setGrants(PermissionStore.listAll());
    };
    void PermissionStore.hydrate().then(refresh);
    const unsubscribe = PermissionStore.subscribe(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // address (lowercased) -> local wallet, for name/casing resolution.
  const walletByAddress = useMemo(() => {
    const m = new Map<string, TWallet>();
    for (const w of wallets) m.set(w.address.toLowerCase(), w);
    return m;
  }, [wallets]);

  const originForKey = origin ? originKey(origin) : null;
  const hostForSite = origin ? originHost(origin) : null;

  // Collapse a wallet's grants for one origin (it may hold several, one
  // per chain of the same namespace) into a single connection row.
  const buildWalletRows = useCallback(
    (
      originGrants: PermissionGrant[],
      via?: DappConnectionWallet["via"],
    ): DappConnectionWallet[] => {
      const byAddress = new Map<string, PermissionGrant[]>();
      for (const g of originGrants) {
        const list = byAddress.get(g.walletAddress) ?? [];
        list.push(g);
        byAddress.set(g.walletAddress, list);
      }
      const rows: DappConnectionWallet[] = [];
      for (const [addrLower, list] of byAddress) {
        const wallet = walletByAddress.get(addrLower);
        const namespace = namespaceForChainKey(list[0].chainId);
        const address = wallet?.address ?? addrLower;
        rows.push({
          address,
          name: wallet?.name ?? shortName(address),
          namespace,
          badge: chainBadgeLabel(namespace),
          grantedAt: Math.min(...list.map((g) => g.grantedAt)),
          connected: true,
          ...(via ? { via } : {}),
        });
      }
      return rows.sort((a, b) => a.grantedAt - b.grantedAt);
    },
    [walletByAddress],
  );

  const { connectedWallets, otherWallets, isConnected } = useMemo(() => {
    if (!originForKey) {
      return {
        connectedWallets: [] as DappConnectionWallet[],
        otherWallets: [] as DappConnectionWallet[],
        isConnected: false,
      };
    }
    const originGrants = grants.filter((g) => g.origin === originForKey);
    const connected = buildWalletRows(originGrants);
    // Transport sessions whose peer is this site, one row set per session.
    for (const s of sessions) {
      if (!hostForSite || originHost(s.peer.url) !== hostForSite) continue;
      const sessionGrants = grants.filter((g) => g.origin === s.originKey);
      connected.push(
        ...buildWalletRows(sessionGrants, {
          transport: s.transport,
          sessionId: s.id,
          originKey: s.originKey,
        }),
      );
    }
    const connectedSet = new Set(connected.map((w) => w.address.toLowerCase()));
    const other: DappConnectionWallet[] = wallets
      .filter((w) => !connectedSet.has(w.address.toLowerCase()))
      .map((w) => ({
        address: w.address,
        name: w.name ?? shortName(w.address),
        namespace: w.namespace,
        badge: chainBadgeLabel(w.namespace),
        grantedAt: 0,
        connected: false,
      }));
    return {
      connectedWallets: connected,
      otherWallets: other,
      isConnected: connected.length > 0,
    };
  }, [grants, originForKey, hostForSite, sessions, wallets, buildWalletRows]);

  const sites = useMemo(() => {
    const byOrigin = new Map<string, PermissionGrant[]>();
    for (const g of grants) {
      // Session-transport grants (WalletConnect, MWA, app links) are
      // listed by the transports' own section with peer metadata; they
      // are not browser sites (deep-link spec §4.9, §7.6).
      if (isExternalOriginKey(g.origin)) continue;
      const list = byOrigin.get(g.origin) ?? [];
      list.push(g);
      byOrigin.set(g.origin, list);
    }
    const out: DappConnectionSite[] = [];
    for (const [siteOrigin, list] of byOrigin) {
      const rows = buildWalletRows(list);
      out.push({ origin: siteOrigin, wallets: rows, count: rows.length });
    }
    // Most-recently-connected sites first.
    return out.sort(
      (a, b) =>
        Math.max(0, ...b.wallets.map((w) => w.grantedAt)) -
        Math.max(0, ...a.wallets.map((w) => w.grantedAt)),
    );
  }, [grants, buildWalletRows]);

  const disconnectWallet = useCallback(
    async ({
      origin: o,
      address,
      via,
    }: {
      origin: string;
      address: string;
      via?: DappConnectionWallet["via"];
    }) => {
      try {
        if (via) {
          await disconnectTransportSession(via.transport, via.sessionId);
          return;
        }
        const bridge = getDappBridge();
        if (bridge) {
          await bridge.revokeConnection({ origin: o, walletAddress: address });
        } else {
          await PermissionStore.revoke({ origin: o, walletAddress: address });
        }
      } catch (e) {
        if (__DEV__) {
          console.warn("[useDappConnections] disconnectWallet failed", e);
        }
      }
    },
    [],
  );

  const disconnectSite = useCallback(
    async ({ origin: o }: { origin: string }) => {
      try {
        const bridge = getDappBridge();
        if (bridge) await bridge.revokeConnection({ origin: o });
        else await PermissionStore.revoke({ origin: o });
      } catch (e) {
        if (__DEV__) {
          console.warn("[useDappConnections] disconnectSite failed", e);
        }
      }
    },
    [],
  );

  return {
    isConnected,
    connectedWallets,
    otherWallets,
    sites,
    disconnectWallet,
    disconnectSite,
  };
}
