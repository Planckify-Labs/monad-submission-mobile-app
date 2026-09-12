import { BlurView } from "expo-blur";
import { Globe } from "lucide-react-native";
import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  Animated,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { BaseModal, ModalHeader } from "@/components/common/BaseModal";
import WalletAccountGroupHeader from "@/components/wallet/WalletAccountGroupHeader";
import type { TWallet } from "@/constants/types/walletTypes";
import {
  type DappConnectionWallet,
  useDappConnections,
} from "@/hooks/useDappConnections";
import {
  allTransports,
  useTransportSessions,
} from "@/hooks/useTransportSessions";
import { useWalletAccountGroups } from "@/hooks/useWalletAccountGroups";
import { originHost } from "@/services/permissions/caip";
import type {
  TransportAdapter,
  TransportSession,
} from "@/services/transports/types";
import { chainBadgeLabel } from "@/services/walletKit/chainInfo";
import {
  groupWalletSections,
  type WalletAccountGroup,
} from "@/utils/walletGrouping";
import ConnectedAppsList from "./ConnectedAppsList";
import ConnectedWalletRow from "./ConnectedWalletRow";

interface ConnectionManagerSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Live WebView URL, or `null` when sitting on the dApp hub. */
  currentOrigin: string | null;
  /** WebView page title — used as a secondary header line when present. */
  dappTitle?: string;
  /** Local wallets, lifted from the screen's single `useWallet()`. */
  wallets: TWallet[];
  /** Opens a connected site in the browser (navigates + closes the sheet). */
  onVisitSite?: (origin: string) => void;
}

type ConnectionTab = "wallets" | "sites";

// Brand palette for lucide icons (which take a solid color string).
const MATTE_BLACK = "#20222c"; // light-matte-black
// emerald-700 — the app's "connected" cue (see BrowserAddressBar).
const EMERALD = "#047857";

const SectionLabel = ({ children }: { children: string }) => (
  <Text className="text-[11px] font-semibold tracking-wide text-light-matte-black/40 uppercase mt-5 mb-2">
    {children}
  </Text>
);

/**
 * Connection manager bottom sheet for the dApps browser. Opened from the
 * TakumiPay button in the address bar.
 *
 * Two tabs, floating at the bottom of the sheet (blurred pill + sliding
 * indicator, mirroring `app/activities.tsx`):
 *   - "Wallets" — the wallet list. When a dApp is open it shows the wallets
 *     connected to that site (each with Disconnect) plus the rest as "Not
 *     connected"; on the hub it shows the user's wallets.
 *   - "Connected apps" — one card per app, with a count badge, folding
 *     together the browser grant and any WalletConnect / MWA / app-link
 *     session for the same host (`ConnectedAppsList`). Disconnecting a
 *     browser row fires the live wallet→dApp disconnect event via
 *     `DappBridge.revokeConnection`; disconnecting a session row ends that
 *     session. Settings → Connected apps is the same list.
 */
export default function ConnectionManagerSheet({
  visible,
  onClose,
  currentOrigin,
  dappTitle,
  wallets,
  onVisitSite,
}: ConnectionManagerSheetProps) {
  const {
    isConnected,
    connectedWallets,
    otherWallets,
    sites,
    disconnectWallet,
    disconnectSite,
  } = useDappConnections({ origin: currentOrigin, wallets });

  // Passive read: only sessions the transports already hold, so opening
  // the sheet never starts WalletConnect / MWA on its own.
  const transports = allTransports();
  const sessions = useTransportSessions(transports, { eager: false });

  // Lowercased addresses with an in-flight disconnect (spinner + tap guard).
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

  // Informational wallet rows for the hub "Your wallets" list.
  const hubWallets = useMemo<DappConnectionWallet[]>(
    () =>
      wallets.map((w) => ({
        address: w.address,
        name: w.name ?? w.address,
        namespace: w.namespace,
        badge: chainBadgeLabel(w.namespace),
        grantedAt: 0,
        connected: false,
      })),
    [wallets],
  );

  const host = currentOrigin ? originHost(currentOrigin) : null;
  const isDapp = !!currentOrigin;

  // Group the "Other wallets" list by account so multiple Google logins
  // (each deriving EVM + Solana + Sui) collapse under one email header.
  // Default the currently-connected account open; the rest start collapsed.
  const connectedAddress = connectedWallets[0]?.address;
  const {
    groups: accountGroups,
    isExpanded,
    toggleExpanded,
  } = useWalletAccountGroups(wallets, connectedAddress, visible);

  // Tab state + sliding indicator. Two segments, index 0/1.
  const [activeTab, setActiveTab] = useState<ConnectionTab>("wallets");
  const indicator = useRef(new Animated.Value(0)).current;
  const onSelectTab = useCallback(
    (tab: ConnectionTab, index: number) => {
      setActiveTab(tab);
      Animated.spring(indicator, {
        toValue: index,
        tension: 70,
        friction: 10,
        useNativeDriver: true,
      }).start();
    },
    [indicator],
  );

  return (
    <BaseModal visible={visible} onClose={onClose} height="80%">
      <View className="flex-1">
        <View className="px-5 pt-1">
          <ModalHeader
            title={isDapp ? "Connection" : "Wallet connections"}
            left={
              isDapp ? (
                <View className="flex-1 flex-row items-center">
                  <View
                    className={`w-9 h-9 rounded-full items-center justify-center ${
                      isConnected ? "bg-emerald-50" : "bg-light-main-container"
                    }`}
                  >
                    <Globe
                      size={18}
                      color={isConnected ? EMERALD : MATTE_BLACK}
                      strokeWidth={2}
                    />
                  </View>
                  <View className="flex-1 ml-3">
                    <Text
                      className="text-base font-bold text-light-matte-black"
                      numberOfLines={1}
                    >
                      {host}
                    </Text>
                    <View className="flex-row items-center mt-0.5">
                      <View
                        className={`w-1.5 h-1.5 rounded-full mr-1.5 ${
                          isConnected
                            ? "bg-emerald-700"
                            : "bg-light-matte-black/20"
                        }`}
                      />
                      <Text
                        className="text-xs text-light-matte-black/50"
                        numberOfLines={1}
                      >
                        {isConnected ? "Connected" : "Not connected"}
                        {dappTitle ? ` · ${dappTitle}` : ""}
                      </Text>
                    </View>
                  </View>
                </View>
              ) : undefined
            }
          />
        </View>

        <View className="flex-1 relative">
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 96 }}
          >
            {activeTab === "wallets" ? (
              isDapp ? (
                <DappWalletsBody
                  host={host as string}
                  origin={currentOrigin as string}
                  connectedWallets={connectedWallets}
                  otherWallets={otherWallets}
                  pending={pending}
                  onDisconnectWallet={onDisconnectWallet}
                  onDisconnectSite={onDisconnectSite}
                  accountGroups={accountGroups}
                  isExpanded={isExpanded}
                  toggleExpanded={toggleExpanded}
                />
              ) : (
                <HubWalletsBody hubWallets={hubWallets} />
              )
            ) : (
              <ConnectedAppsBody
                sites={sites}
                pending={pending}
                onDisconnectWallet={onDisconnectWallet}
                onDisconnectSite={onDisconnectSite}
                onVisitSite={onVisitSite}
                sessions={sessions}
                transports={transports}
                wallets={wallets}
              />
            )}
          </ScrollView>

          <ConnectionTabs
            activeTab={activeTab}
            connectionCount={sites.length + sessions.length}
            indicator={indicator}
            onSelectTab={onSelectTab}
          />
        </View>
      </View>
    </BaseModal>
  );
}

function ConnectionTabs({
  activeTab,
  connectionCount,
  indicator,
  onSelectTab,
}: {
  activeTab: ConnectionTab;
  connectionCount: number;
  indicator: Animated.Value;
  onSelectTab: (tab: ConnectionTab, index: number) => void;
}) {
  const [tabRowWidth, setTabRowWidth] = useState(0);
  const tabSegmentWidth = tabRowWidth / 2;

  return (
    <View className="absolute bottom-0 left-0 right-0 pb-2">
      <BlurView
        intensity={30}
        experimentalBlurMethod="dimezisBlurView"
        className="overflow-hidden rounded-full mx-4 border-4 border-light-main-container/80"
      >
        <View
          className="w-full flex-row items-center justify-evenly relative"
          onLayout={(e) => setTabRowWidth(e.nativeEvent.layout.width)}
        >
          <TouchableOpacity
            onPress={() => onSelectTab("wallets", 0)}
            activeOpacity={0.7}
            className="px-2 py-2.5 items-center justify-center flex-1"
          >
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.8}
              className={`${
                activeTab === "wallets"
                  ? "text-light-primary-red/75"
                  : "text-light-matte-black/50"
              } text-center font-bold`}
            >
              Wallets
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => onSelectTab("sites", 1)}
            activeOpacity={0.7}
            className="px-2 py-2.5 items-center justify-center flex-1 flex-row gap-1.5"
          >
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.8}
              className={`${
                activeTab === "sites"
                  ? "text-light-primary-red/75"
                  : "text-light-matte-black/50"
              } text-center font-bold`}
            >
              Connected apps
            </Text>
            {connectionCount > 0 && (
              <View
                className={`min-w-5 h-5 px-1.5 rounded-full items-center justify-center ${
                  activeTab === "sites"
                    ? "bg-light-primary-red/75"
                    : "bg-light-matte-black/30"
                }`}
              >
                <Text className="text-[11px] font-bold text-white">
                  {connectionCount}
                </Text>
              </View>
            )}
          </TouchableOpacity>

          <Animated.View
            className="absolute bottom-0 h-1 bg-light-primary-red/75 left-0 rounded-t-md"
            style={{
              width: tabSegmentWidth,
              transform: [
                {
                  translateX: indicator.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, tabSegmentWidth],
                    extrapolate: "clamp",
                  }),
                },
              ],
            }}
          />
        </View>
      </BlurView>
    </View>
  );
}

function DappWalletsBody({
  host,
  origin,
  connectedWallets,
  otherWallets,
  pending,
  onDisconnectWallet,
  onDisconnectSite,
  accountGroups,
  isExpanded,
  toggleExpanded,
}: {
  host: string;
  origin: string;
  connectedWallets: DappConnectionWallet[];
  otherWallets: DappConnectionWallet[];
  pending: Set<string>;
  onDisconnectWallet: (origin: string, wallet: DappConnectionWallet) => void;
  onDisconnectSite: (origin: string, addresses: string[]) => void;
  accountGroups: WalletAccountGroup[];
  isExpanded: (accountId: string) => boolean;
  toggleExpanded: (accountId: string) => void;
}) {
  // Look up the connection row for a grouped wallet by address.
  const otherByAddress = useMemo(() => {
    const m = new Map<string, DappConnectionWallet>();
    for (const w of otherWallets) m.set(w.address.toLowerCase(), w);
    return m;
  }, [otherWallets]);

  const otherSections = useMemo(
    () =>
      groupWalletSections(accountGroups, {
        isVisible: (w) => otherByAddress.has(w.address.toLowerCase()),
        isExpanded,
        forceExpand: false,
      }),
    [accountGroups, otherByAddress, isExpanded],
  );

  return (
    <>
      <SectionLabel>{`Connected to ${host}`}</SectionLabel>
      {connectedWallets.length === 0 ? (
        <View className="bg-light rounded-2xl p-4">
          <Text className="text-sm text-light-matte-black">
            No wallets are connected to this site yet. When you approve a
            connection, it will show up here.
          </Text>
        </View>
      ) : (
        <>
          <View className="bg-light rounded-2xl px-4">
            {connectedWallets.map((w, i) => (
              <ConnectedWalletRow
                key={`${w.via?.sessionId ?? "webview"}-${w.address}`}
                wallet={w}
                divider={i > 0}
                action={{
                  type: "disconnect",
                  onPress: () => onDisconnectWallet(origin, w),
                  pending: pending.has(w.address.toLowerCase()),
                }}
              />
            ))}
          </View>
          {connectedWallets.length > 1 && (
            <TouchableOpacity
              onPress={() =>
                onDisconnectSite(
                  origin,
                  connectedWallets.map((w) => w.address),
                )
              }
              activeOpacity={0.7}
              className="mt-3 py-3 rounded-2xl bg-light-primary-red/10 items-center"
            >
              <Text className="text-sm font-semibold text-light-primary-red">
                Disconnect all
              </Text>
            </TouchableOpacity>
          )}
        </>
      )}

      {otherSections.length > 0 && (
        <>
          <SectionLabel>Other wallets</SectionLabel>
          {otherSections.map((section) => (
            <View key={section.group.id} className="mb-2">
              {section.showHeader && (
                <WalletAccountGroupHeader
                  group={section.group}
                  count={section.wallets.length}
                  expanded={section.expanded}
                  collapsible={section.collapsible}
                  containsActive={false}
                  onToggle={() => toggleExpanded(section.group.id)}
                />
              )}
              {section.expanded && (
                <View className="bg-light rounded-2xl px-4">
                  {section.wallets.map((w, i) => {
                    const row = otherByAddress.get(w.address.toLowerCase());
                    if (!row) return null;
                    return (
                      <ConnectedWalletRow
                        key={w.address}
                        wallet={row}
                        divider={i > 0}
                        action={{ type: "status", label: "Not connected" }}
                      />
                    );
                  })}
                </View>
              )}
            </View>
          ))}
        </>
      )}
    </>
  );
}

function HubWalletsBody({
  hubWallets,
}: {
  hubWallets: DappConnectionWallet[];
}) {
  return (
    <>
      <View className="bg-light rounded-2xl p-4 mt-2">
        <Text className="text-sm text-light-matte-black">
          You&apos;re not browsing a dApp right now. Open one to see and manage
          the wallets it&apos;s connected to. Manage past connections in the
          Connected sites tab.
        </Text>
      </View>

      <SectionLabel>Your wallets</SectionLabel>
      {hubWallets.length === 0 ? (
        <View className="bg-light rounded-2xl p-4">
          <Text className="text-sm text-light-matte-black">
            No wallets yet.
          </Text>
        </View>
      ) : (
        <View className="bg-light rounded-2xl px-4">
          {hubWallets.map((w, i) => (
            <ConnectedWalletRow
              key={w.address}
              wallet={w}
              divider={i > 0}
              action={{ type: "none" }}
            />
          ))}
        </View>
      )}
    </>
  );
}

function ConnectedAppsBody({
  sites,
  pending,
  onDisconnectWallet,
  onDisconnectSite,
  onVisitSite,
  sessions,
  transports,
  wallets,
}: {
  sites: ReturnType<typeof useDappConnections>["sites"];
  pending: Set<string>;
  onDisconnectWallet: (origin: string, wallet: DappConnectionWallet) => void;
  onDisconnectSite: (origin: string, addresses: string[]) => void;
  onVisitSite?: (origin: string) => void;
  sessions: TransportSession[];
  transports: TransportAdapter[];
  wallets: TWallet[];
}) {
  // Connections only. Browsing history used to be cleared from the bottom
  // of this list, and a red full-width button under six rows of "1 wallet"
  // reads as "disconnect all of these" — a user could believe they had cut
  // off every site when nothing had been revoked. It lives in Settings now
  // (`app/browser-privacy.tsx`), and single entries are removed from the
  // address-bar suggestion that shows them.
  if (sites.length === 0 && sessions.length === 0) {
    return (
      <Text className="text-sm text-light-matte-black py-3 mt-2">
        No connected apps yet.
      </Text>
    );
  }
  return (
    <View className="mt-2">
      <ConnectedAppsList
        sites={sites}
        sessions={sessions}
        transports={transports}
        wallets={wallets}
        pending={pending}
        onDisconnectWallet={onDisconnectWallet}
        onDisconnectSite={onDisconnectSite}
        onVisitSite={onVisitSite}
      />
    </View>
  );
}
