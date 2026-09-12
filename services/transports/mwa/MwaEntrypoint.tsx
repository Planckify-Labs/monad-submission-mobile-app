/**
 * Second React root for the Mobile Wallet Adapter host activity —
 * deep-link spec §8.1 (Android only).
 *
 * `MobileWalletAdapterActivity` (declared by
 * `plugins/withSolanaMobileWalletAdapter.js`) renders the component
 * registered as `TakumiMwaEntrypoint` from `index.js`. It is a minimal
 * tree: pollyfills → wallet kits + bridge boot (shared module scope with
 * the main app) → providers → `MwaHost` (drives the walletlib session)
 * → `ApprovalHost`. It does NOT mount the router, the home screen, or
 * the WebView, and it sits behind the same lock screen as the main app.
 *
 * Why a separate activity: `getCallingPackage()` (the only OS-attested
 * identity in the whole spec) is `null` unless the dApp used
 * `startActivityForResult` into an activity that is not the task root.
 */

import "../../../pollyfills";
import { QueryClientProvider } from "@tanstack/react-query";
import React, { useCallback, useEffect, useState } from "react";
import { BackHandler, StyleSheet, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppLockedContext, queryClient } from "@/app/_layout";
import { DeepLinkNoticeHost } from "@/components/deeplinks/DeepLinkNoticeHost";
import LockScreen from "@/components/security/LockScreen";
import { useWallet } from "@/hooks/useWallet";
import { ApprovalHost } from "@/services/bridge/ApprovalHost";
import {
  bootBridgeAtRoot,
  setRootBridgeWallets,
} from "@/services/bridge/rootBoot";
import { setAppLocked } from "@/services/security/appLockState";
import { bootWalletKits } from "@/services/walletKit/boot";
import { hasStoredWallets } from "@/services/walletService";
import { MwaHost } from "./MwaHost";

bootWalletKits();
bootBridgeAtRoot();
setAppLocked(hasStoredWallets());

function MwaShell(): React.ReactElement {
  const [locked, setLocked] = useState<boolean>(hasStoredWallets());
  const { wallets } = useWallet();
  setRootBridgeWallets(wallets);

  useEffect(() => {
    setAppLocked(locked);
  }, [locked]);

  const exit = useCallback(() => {
    setTimeout(() => BackHandler.exitApp(), 150);
  }, []);

  const onUnlocked = useCallback(async () => {
    setLocked(false);
  }, []);

  return (
    <AppLockedContext.Provider value={locked}>
      <View style={styles.root}>
        <MwaHost onSessionEnded={exit} />
        {locked ? <LockScreen onUnlocked={onUnlocked} /> : null}
        <ApprovalHost />
        <DeepLinkNoticeHost />
      </View>
    </AppLockedContext.Provider>
  );
}

export function MwaEntrypoint(): React.ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider>
        <MwaShell />
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "transparent" },
});

export default MwaEntrypoint;
