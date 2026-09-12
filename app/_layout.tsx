// TWV-2026-002 — pollyfills MUST load before any module that can transitively
// pull in Viem or `@scure/bip39`. Keep this the first import of the app.
import "../pollyfills";
import {
  QueryClient,
  useIsRestoring,
  useQueryClient,
} from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { router, SplashScreen, Stack, usePathname } from "expo-router";
import { PostHogProvider } from "posthog-react-native";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { LogBox } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ChainSwitchingOverlay } from "@/components/common/ChainSwitchingOverlay";
import { DeepLinkNoticeHost } from "@/components/deeplinks/DeepLinkNoticeHost";
import { PerformanceProvider } from "@/components/providers/PerformanceProvider";
import LockScreen from "@/components/security/LockScreen";
import QKEY_Wallets from "@/constants/queryKeys/walletQueryKeys";
import { useAppSessionTracking } from "@/hooks/useAppSessionTracking";
// Ordering (spec §6.2): polyfill import → bootWalletKits() → any screen/provider.
import { useWallet } from "@/hooks/useWallet";
import {
  mmkvPersister,
  shouldPersistQuery,
} from "@/lib/storage/queryPersister";
import {
  identifyDevice,
  syncWalletProperties,
} from "@/services/analytics/identity";
import { posthog } from "@/services/analytics/posthog";
import { resolveScreenName } from "@/services/analytics/screenNames";
import { ApprovalHost } from "@/services/bridge/ApprovalHost";
import {
  bootBridgeAtRoot,
  setRootBridgeWallets,
} from "@/services/bridge/rootBoot";
import { bootstrapBridgeAdapters } from "@/services/bridgeRoutes/bootstrap";
import "@/services/deeplinks/boot";
import { linkInbox } from "@/services/deeplinks/inbox";
import { INBOX_ROUTE } from "@/services/deeplinks/intake";
import { bootDefi } from "@/services/defi/bootstrap";
import { bootGasAbstraction } from "@/services/gasAbstraction/boot";
import { initNotificationHandlers } from "@/services/notifications/handlers";
import { bootPpobCategorizers } from "@/services/ppob";
import {
  registerForPushNotifications,
  usePushNotificationHandler,
  usePushRegistrationRetry,
} from "@/services/push";
import { installQRMatrixCache } from "@/services/qrMatrixCache";
import { setAppLocked } from "@/services/security/appLockState";
import { hydrateSigningMode } from "@/services/security/signingMode";
import { bootTransports } from "@/services/transports/boot";
import { bootWalletKits } from "@/services/walletKit/boot";
import { hasStoredWallets } from "@/services/walletService";
import { refreshSettlementRailConfig } from "@/services/x402/refreshSettlementRailConfig";
import "../global.css";

// Register WalletKit adapters before any screen/provider reads the registry.
bootWalletKits();
// Deep-link spec F3: the approval spine boots at the root so a request
// arriving on any screen (WalletConnect relay, SEP-0007 `tx`, MWA) has a
// host to render in. Needs the kits above; the browser screen's own
// `bootBridge()` becomes a rebind.
bootBridgeAtRoot();
// Seed the lock mirror before the first render so the root approval host
// never paints during the one frame before `AppShell`'s effect runs.
setAppLocked(hasStoredWallets());
// Session transports (WalletConnect today). Eager only when there are
// active sessions or the launch link is a pairing; lazy otherwise.
void bootTransports();
// Signing mode (TWV-2026-035) gates deep links at intake (S-13); hydrate
// the synchronous cache before the first link can arrive.
void hydrateSigningMode();
// Register gas-abstraction providers (resolve the EVM kit, so AFTER walletKits).
bootGasAbstraction();
// Register DeFi adapters
bootDefi();
// Register bridge-route adapters (lifi + cctp). Resolves wallet kits at
// execute time, not registration time, so ordering vs. bootWalletKits is
// not load-bearing — but keep it after for consistency with bootDefi.
bootstrapBridgeAdapters();
// Register PPOB catalog categorizers (vcGamer today) — pure logic, no
// registry deps, so ordering vs. the chain boots doesn't matter.
bootPpobCategorizers();
// Refresh the API-driven x402 settlement-rail override (enable/disable,
// reorder, fee caps) into the on-device cache — best-effort, fire-and-forget
// (x402-extensibility-spec §12.1, OQ-2). Failure leaves defaults in place.
void refreshSettlementRailConfig();

// Patch `qrcode.create` with an MMKV-backed cache so receive-sheet QRs
// skip the Reed-Solomon compute on repeat opens. Must run before any
// component imports `react-native-qrcode-styled`.
installQRMatrixCache();

// Without this, expo-notifications' default handler suppresses any
// notification (local or push) while the app is foregrounded — the OS
// channel only takes over display when the app is backgrounded/killed.
// Must run before any push can arrive, so it's called at module scope
// rather than inside an effect.
initNotificationHandlers();

SplashScreen.preventAutoHideAsync();

/**
 * App-level lock gate. `true` whenever the LockScreen is floating over
 * the Stack — i.e. wallets are persisted on device but the user hasn't
 * unlocked this session yet. Exposed so screens and expensive hooks
 * (SecureStore cascades in `useIsAuthenticated`, BIP-32 / Ed25519
 * pre-warm in `useWallet`, network queries gated by auth) can short-
 * circuit their work while the user is behind the blur. The Stack
 * still renders so the LockScreen's BlurView has home content to
 * blur — but the heavy work doesn't fire until after unlock.
 */
export const AppLockedContext = createContext<boolean>(false);
export const useAppLocked = (): boolean => useContext(AppLockedContext);

LogBox.ignoreLogs([
  "VirtualizedLists should never be nested",
  "Sending `onAnimatedValueUpdate` with no listeners registered",
]);

const PERSIST_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60 * 1000,
      // gcTime must be >= PERSIST_MAX_AGE so data isn't GC'd before persistence reads it
      gcTime: PERSIST_MAX_AGE,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnMount: true,
      // Re-enable reconnect refetch so stale data refreshes when coming back online
      refetchOnReconnect: true,
    },
  },
});

function InitializeApp({
  didUnlockThisSession,
  onShouldLock,
}: {
  didUnlockThisSession: boolean;
  onShouldLock: (locked: boolean) => void;
}) {
  const isRestoring = useIsRestoring();
  const { wallets, isLoading } = require("@/hooks/useWallet").useWallet();

  useEffect(() => {
    if (isRestoring || isLoading) return;

    if (hasStoredWallets() && !didUnlockThisSession) {
      onShouldLock(true);
    } else if (wallets.length === 0 && !hasStoredWallets()) {
      onShouldLock(false);
      router.replace("/login");
    } else {
      onShouldLock(false);
    }

    SplashScreen.hideAsync();
  }, [
    isRestoring,
    isLoading,
    wallets.length,
    didUnlockThisSession,
    onShouldLock,
  ]);

  return null;
}

function AppShell() {
  const queryClient = useQueryClient();
  const [locked, setLocked] = useState<boolean>(hasStoredWallets());
  const [didUnlockThisSession, setDidUnlockThisSession] = useState(false);
  const { wallets } = useWallet();
  const pathname = usePathname();

  usePushNotificationHandler();
  usePushRegistrationRetry();
  useAppSessionTracking(locked);

  // Keep the non-React mirrors of app state current. The root bridge
  // context reads the wallet list from a holder (never the active
  // wallet), and `ApprovalHost` / `pendingIntentsStore` freeze while the
  // lock screen is up (deep-link spec S-9).
  setRootBridgeWallets(wallets);
  useEffect(() => {
    setAppLocked(locked);
  }, [locked]);

  useEffect(() => {
    void identifyDevice();
  }, []);

  useEffect(() => {
    const name = resolveScreenName(pathname);
    if (name) void posthog.screen(name);
  }, [pathname]);

  // Re-register whenever the wallet list changes so new wallets are
  // subscribed immediately. walletKey is a stable string derived from
  // the address list — the effect only fires when addresses actually change.
  const walletKey = wallets.map((w) => w.address).join(",");
  useEffect(() => {
    const addresses = wallets.map((w) => w.address);
    if (addresses.length === 0) return;
    void registerForPushNotifications(addresses);
    syncWalletProperties(wallets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletKey]);

  // Two-phase unlock — lift the gate first (so all `useAppLocked()`
  // consumers fire their gated effects + the React re-render cascade
  // runs), then dismiss the LockScreen after a short settle window.
  // The spinner stays up while home's hooks wake up; the user only
  // sees the home screen once the cascade has quieted and taps land
  // instantly.
  //
  // Without this two-phase approach, `locked` and `didUnlockThisSession`
  // flipped in the same commit. The LockScreen dismissed at the exact
  // frame the cascade started — user saw home but couldn't interact
  // for ~300–500 ms while the re-render wave settled. Classic "freeze
  // right after unlock" bug.
  //
  // `await new Promise(setTimeout(400))` is the same yield hack as the
  // rest of the crypto UI (pattern 1 in `docs/crypto-ui-perf-patterns
  // .md`), just with a larger value because we're covering a bigger
  // window (multiple React commits + deferred effects via
  // `InteractionManager.runAfterInteractions`).
  const handleUnlocked = useCallback(async () => {
    // LockScreen already loaded wallets via `loadWalletsFromStorage()`
    // into the `walletService` module cache. The `[wallets]` query
    // picks up that cached value on first use — no invalidation needed.
    // Previously this fired an `invalidateQueries({wallets})` which
    // queued a 2nd `loadWallets` deferredTask (visible in logs), for
    // no new data.
    //
    // Phase 1 — lift the gate. Gated hooks fire while the LockScreen
    // is still visible. Heavy work runs behind the spinner.
    setDidUnlockThisSession(true);
    // Phase 2 — wait for the React cascade to quiet, then dismiss.
    // 100 ms is enough now that signer caches + auth state + wallet
    // index are all primed synchronously inside LockScreen — the
    // cascade from flipping `isLocked` is just React re-renders, not
    // any heavy work.
    await new Promise((r) => setTimeout(r, 100));
    setLocked(false);
    // Deep-link spec §4.8: drain the link inbox only after unlock. A
    // link that arrived behind the lock screen already pointed the
    // router at the interstitial; this covers the case where something
    // else navigated away in between.
    if (linkInbox.peek() && pathname !== INBOX_ROUTE) {
      router.push(INBOX_ROUTE as never);
    }
  }, [pathname]);

  return (
    <AppLockedContext.Provider value={locked}>
      <InitializeApp
        didUnlockThisSession={didUnlockThisSession}
        onShouldLock={setLocked}
      />
      <Stack
        screenOptions={{
          headerShown: false,
          animation: "ios_from_left",
          contentStyle: { backgroundColor: "#f5f6f9" },
          animationDuration: 300,
        }}
      />
      {locked ? <LockScreen onUnlocked={handleUnlocked} /> : null}
      <ChainSwitchingOverlay />
      {/* Deep-link spec F3 / S-9: root-mounted approval host. Renders
          `null` while locked (it subscribes to the lock mirror itself). */}
      <ApprovalHost />
      <DeepLinkNoticeHost />
    </AppLockedContext.Provider>
  );
}

export default function RootLayout() {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister: mmkvPersister,
        maxAge: PERSIST_MAX_AGE,
        dehydrateOptions: {
          shouldDehydrateQuery: shouldPersistQuery,
        },
      }}
    >
      <PerformanceProvider>
        <PostHogProvider
          client={posthog}
          autocapture={{ captureScreens: false, captureTouches: false }}
        >
          <SafeAreaProvider>
            <AppShell />
          </SafeAreaProvider>
        </PostHogProvider>
      </PerformanceProvider>
    </PersistQueryClientProvider>
  );
}
