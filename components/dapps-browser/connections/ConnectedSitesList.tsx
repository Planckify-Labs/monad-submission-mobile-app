import React from "react";
import { Text, View } from "react-native";
import type {
  DappConnectionSite,
  DappConnectionWallet,
} from "@/hooks/useDappConnections";
import ConnectedSiteRow from "./ConnectedSiteRow";

interface ConnectedSitesListProps {
  sites: DappConnectionSite[];
  /** Lowercased addresses with an in-flight disconnect. */
  pending: Set<string>;
  onDisconnectWallet: (origin: string, wallet: DappConnectionWallet) => void;
  onDisconnectSite: (origin: string, addresses: string[]) => void;
  /** Opens a site in the browser. Per-row button hidden when omitted. */
  onVisitSite?: (origin: string) => void;
  emptyLabel?: string;
}

/**
 * The grouped "connected sites" list, shared by the connection manager's
 * hub view and the standalone `app/dapp-permissions.tsx` screen so there's
 * a single implementation of site-grouped disconnect.
 */
export default function ConnectedSitesList({
  sites,
  pending,
  onDisconnectWallet,
  onDisconnectSite,
  onVisitSite,
  emptyLabel = "No connected sites yet.",
}: ConnectedSitesListProps) {
  if (sites.length === 0) {
    return (
      <Text className="text-sm text-light-matte-black py-3">{emptyLabel}</Text>
    );
  }
  return (
    <View>
      {sites.map((site) => (
        <ConnectedSiteRow
          key={site.origin}
          site={site}
          pendingAddresses={pending}
          onDisconnectWallet={(wallet) =>
            onDisconnectWallet(site.origin, wallet)
          }
          onDisconnectSite={() =>
            onDisconnectSite(
              site.origin,
              site.wallets.map((w) => w.address),
            )
          }
          onVisit={onVisitSite ? () => onVisitSite(site.origin) : undefined}
        />
      ))}
    </View>
  );
}
