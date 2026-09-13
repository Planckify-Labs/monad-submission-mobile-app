/**
 * Connected apps screen. One card per app for everything that can see
 * the user's wallet, whatever the transport: dApp-browser grants and live
 * WalletConnect / MWA / app-link sessions (deep-link spec §7.6, D-16) fold
 * into the same card by host. A desktop dApp paired by QR never touches
 * the in-app browser, so this is the only place a user who never opens the
 * browser can find and revoke it.
 *
 * The browser's connection sheet ("Connected apps" tab) renders the same
 * `ConnectedAppsList`; this screen is the entry point for a user who never
 * opens the browser. The route stays `/dapp-permissions`: it is the
 * read-only deep-link target allowlisted in
 * `services/deeplinks/paths/navigate.ts`.
 */

import { router } from "expo-router";
import { ArrowLeft } from "lucide-react-native";
import React, { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import ConnectedAppsList, {
  EmptyConnectedApps,
} from "@/components/dapps-browser/connections/ConnectedAppsList";
import {
  type DappConnectionWallet,
  useDappConnections,
} from "@/hooks/useDappConnections";
import {
  allTransports,
  useTransportSessions,
} from "@/hooks/useTransportSessions";
import { useWallet } from "@/hooks/useWallet";

// lucide takes a solid color string rather than a className.
const BRAND_RED = "#c71c4b"; // light-primary-red

export default function DappPermissions(): React.ReactElement {
  const { bottom } = useSafeAreaInsets();
  const { wallets } = useWallet();
  const { sites, disconnectWallet, disconnectSite } = useDappConnections({
    origin: null,
    wallets,
  });
  // Eager: this screen wants the full picture, so every transport starts.
  const transports = allTransports();
  const sessions = useTransportSessions(transports);

  // Lowercased addresses with an in-flight disconnect (spinner + tap
  // guard), same shape the browser's connection sheet keeps. There is no
  // live WebView here, so the hook's `disconnect*` actions fall back to a
  // bare `PermissionStore` revoke.
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const runDisconnect = useCallback(
    async (keys: string[], fn: () => Promise<void>) => {
      const lowered = keys.map((k) => k.toLowerCase());
      setPending((prev) => new Set([...prev, ...lowered]));
      try {
        await fn();
      } finally {
        setPending((prev) => {
          const next = new Set(prev);
          for (const k of lowered) next.delete(k);
          return next;
        });
      }
    },
    [],
  );

  const onDisconnectWallet = useCallback(
    (origin: string, wallet: DappConnectionWallet) =>
      runDisconnect([wallet.address], () =>
        disconnectWallet({ origin, address: wallet.address, via: wallet.via }),
      ),
    [runDisconnect, disconnectWallet],
  );

  const onDisconnectSite = useCallback(
    (origin: string, addresses: string[]) =>
      runDisconnect(addresses, () => disconnectSite({ origin })),
    [runDisconnect, disconnectSite],
  );

  return (
    <>
      <SystemBars style="dark" />
      <SafeAreaView
        className="flex-1 bg-light-main-container"
        edges={["top"]}
        style={{ paddingBottom: bottom > 0 ? bottom : 0 }}
      >
        {/* Header */}
        <View className="px-4 pt-2 pb-4">
          <View className="flex-row items-center gap-3">
            <Pressable
              onPress={() => router.back()}
              hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
              className="w-9 h-9 rounded-xl bg-light items-center justify-center shadow-sm"
              accessibilityRole="button"
              accessibilityLabel="Back"
            >
              <ArrowLeft size={18} color={BRAND_RED} />
            </Pressable>
            <View className="flex-1">
              <Text className="text-light-matte-black text-2xl font-bold tracking-tight">
                Connected apps
              </Text>
              <Text className="text-light-matte-black/50 text-xs mt-0.5">
                Apps that can see your wallet.
              </Text>
            </View>
          </View>
        </View>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingBottom: 48 }}
          showsVerticalScrollIndicator={false}
        >
          <View className="mx-4 mb-5">
            {sites.length === 0 && sessions.length === 0 ? (
              <EmptyConnectedApps />
            ) : (
              <ConnectedAppsList
                sites={sites}
                sessions={sessions}
                transports={transports}
                wallets={wallets}
                pending={pending}
                onDisconnectWallet={onDisconnectWallet}
                onDisconnectSite={onDisconnectSite}
              />
            )}
          </View>
        </ScrollView>
      </SafeAreaView>
    </>
  );
}
