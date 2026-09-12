import React from "react";
import { ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import ConnectedSitesList from "@/components/dapps-browser/connections/ConnectedSitesList";
import { TransportSessionsSection } from "@/components/deeplinks/TransportSessionsSection";
import { useDappConnections } from "@/hooks/useDappConnections";
import { useWallet } from "@/hooks/useWallet";

// Stable empty set — this screen has no live WebView to push disconnect
// events into, so there's no in-flight spinner state to track. Revokes
// here just mutate `PermissionStore` (the hook's `disconnect*` actions
// fall back to a bare revoke when no bridge/live session is present).
const EMPTY_PENDING: Set<string> = new Set();

export default function DappPermissions(): React.ReactElement {
  const { wallets } = useWallet();
  const { sites, disconnectWallet, disconnectSite } = useDappConnections({
    origin: null,
    wallets,
  });

  return (
    <SafeAreaView className="flex-1 bg-white" edges={["top"]}>
      <View className="px-4 py-3 border-b border-gray-100">
        <Text className="text-lg font-semibold text-gray-900">
          dApp permissions
        </Text>
        <Text className="text-xs text-gray-500 mt-1">
          Sites and apps you&apos;ve connected your wallet to.
        </Text>
      </View>
      <ScrollView className="flex-1 px-4 py-3">
        {/* Deep-link spec §7.6: WalletConnect / MWA / app-link sessions. */}
        <TransportSessionsSection />
        <ConnectedSitesList
          sites={sites}
          pending={EMPTY_PENDING}
          onDisconnectWallet={(origin, wallet) =>
            void disconnectWallet({
              origin,
              address: wallet.address,
              via: wallet.via,
            })
          }
          onDisconnectSite={(origin) => void disconnectSite({ origin })}
          emptyLabel="No connected sites yet."
        />
      </ScrollView>
    </SafeAreaView>
  );
}
