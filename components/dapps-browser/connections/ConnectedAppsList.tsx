/**
 * The "Connected apps" list: one card per app, whatever the transport.
 * Shared by the browser's connection sheet and the Settings screen so
 * there is a single implementation of "what can see my wallet, and how do
 * I cut it off".
 *
 * A card always shows its first connection (wallet row with Disconnect),
 * so the list answers "who is connected where" without a tap. Only a card
 * with more than one connection gets a chevron; expanding it reveals the
 * rest and a "Disconnect all".
 *
 * A card folds together everything connected to one host:
 *   - the in-app browser grant (wallet rows, per-wallet Disconnect), and
 *   - every WalletConnect / MWA / app-link session (deep-link spec §7.6,
 *     D-16), each its own block: page name when several are open, URL as
 *     plain text (never auto-opened, TWV-2026-030), Verify API state,
 *     expiry, then its wallet row with Disconnect.
 * When both are present every wallet row carries a source pill, "Browser"
 * or the transport ("WalletConnect"), the same cue the sheet's per-site
 * Wallets tab uses, so a wallet connected both ways reads as two sibling
 * connections to one app rather than two apps.
 *
 * One dApp can legitimately hold several sessions at once, even for the
 * same wallet: a WalletConnect session is one pairing with one dApp
 * instance (two tabs, two browsers, a tab that dropped its local state
 * without sending `session_delete`) and the wallet cannot merge them.
 * "Disconnect all" ends every connection on the card.
 */

import { Image } from "expo-image";
import { router } from "expo-router";
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Globe,
  Link2,
  ScanLine,
  ShieldCheck,
  Unlink,
} from "lucide-react-native";
import React, { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import type { TWallet } from "@/constants/types/walletTypes";
import { useAppIcons } from "@/hooks/dapps-browser/useAppIcons";
import type {
  DappConnectionSite,
  DappConnectionWallet,
} from "@/hooks/useDappConnections";
import { TRANSPORT_LABEL } from "@/hooks/useTransportSessions";
import type {
  TransportAdapter,
  TransportSession,
} from "@/services/transports/types";
import {
  addressesEqual,
  chainBadgeLabel,
} from "@/services/walletKit/chainInfo";
import { truncateAddress } from "@/utils/walletUtils";
import ConnectedWalletRow from "./ConnectedWalletRow";
import {
  buildConnectedApps,
  type ConnectedApp,
  sessionExpiryLabel,
  sessionWallets,
} from "./connectedApps";

// lucide takes a solid color string rather than a className.
const BRAND_RED = "#c71c4b"; // light-primary-red
const EMERALD = "#047857"; // emerald-700, the app's "connected" cue
const MATTE_MUTED = "rgba(32,34,44,0.45)"; // secondary controls (chevron)

// Stable empty list so a session-only card's memo deps don't churn.
const NO_WALLETS: DappConnectionWallet[] = [];

/** One connection on a card: a browser-grant wallet or a session. */
type ConnectionItem =
  | { kind: "site"; wallet: DappConnectionWallet }
  | { kind: "session"; session: TransportSession };

interface ConnectedAppsListProps {
  sites: DappConnectionSite[];
  sessions: TransportSession[];
  transports: TransportAdapter[];
  /** Local wallets, to name the addresses a session can see. */
  wallets: TWallet[];
  /** Lowercased addresses with an in-flight browser-grant disconnect. */
  pending: Set<string>;
  onDisconnectWallet: (origin: string, wallet: DappConnectionWallet) => void;
  onDisconnectSite: (origin: string, addresses: string[]) => void;
  /** Opens a site in the browser. Per-card button hidden when omitted. */
  onVisitSite?: (origin: string) => void;
}

export default function ConnectedAppsList({
  sites,
  sessions,
  transports,
  wallets,
  pending,
  onDisconnectWallet,
  onDisconnectSite,
  onVisitSite,
}: ConnectedAppsListProps): React.ReactElement {
  const apps = useMemo(
    () => buildConnectedApps(sites, sessions),
    [sites, sessions],
  );
  // Same icon pipeline as the dApps hub: curated catalogue logo, then the
  // app's own (a WalletConnect peer icon), then the favicon recorded from
  // the page on an earlier visit. All cached; nothing is fetched to guess.
  const iconFor = useAppIcons();

  // Session ids with an in-flight disconnect (spinner + tap guard). Browser
  // grants keep the caller's `pending` set: those disconnects go through
  // the live bridge and the caller owns that state.
  const [sessionPending, setSessionPending] = useState<Set<string>>(
    () => new Set(),
  );
  const disconnectSessions = useCallback(
    async (list: TransportSession[]) => {
      const ids = list.map((s) => s.id);
      setSessionPending((prev) => new Set([...prev, ...ids]));
      try {
        for (const s of list) {
          const t = transports.find((x) => x.id === s.transport);
          if (!t) continue;
          try {
            await t.disconnect(s.id);
          } catch (e) {
            if (__DEV__) console.warn("[connected-apps] disconnect failed", e);
          }
        }
      } finally {
        setSessionPending((prev) => {
          const next = new Set(prev);
          for (const id of ids) next.delete(id);
          return next;
        });
      }
    },
    [transports],
  );

  return (
    <View>
      {apps.map((app) => (
        <ConnectedAppRow
          key={app.key}
          app={app}
          iconUrl={iconFor(app.key, app.icon)}
          wallets={wallets}
          sitePending={pending}
          sessionPending={sessionPending}
          onDisconnectWallet={onDisconnectWallet}
          onDisconnectSite={onDisconnectSite}
          onDisconnectSessions={(list) => void disconnectSessions(list)}
          onVisitSite={onVisitSite}
        />
      ))}
    </View>
  );
}

function ConnectedAppRow({
  app,
  iconUrl,
  wallets,
  sitePending,
  sessionPending,
  onDisconnectWallet,
  onDisconnectSite,
  onDisconnectSessions,
  onVisitSite,
}: {
  app: ConnectedApp;
  iconUrl?: string;
  wallets: TWallet[];
  sitePending: Set<string>;
  sessionPending: Set<string>;
  onDisconnectWallet: (origin: string, wallet: DappConnectionWallet) => void;
  onDisconnectSite: (origin: string, addresses: string[]) => void;
  onDisconnectSessions: (list: TransportSession[]) => void;
  onVisitSite?: (origin: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { site, sessions } = app;
  const mixed = !!site && sessions.length > 0;
  const siteRows = site?.wallets ?? NO_WALLETS;
  const connectionCount = siteRows.length + sessions.length;

  // Every connection on the card, browser rows first, in display order.
  // The first one is always visible so a card answers "who is connected"
  // at a glance; the chevron only exists when there is more to show.
  const items = useMemo<ConnectionItem[]>(
    () => [
      ...siteRows.map((wallet): ConnectionItem => ({ kind: "site", wallet })),
      ...sessions.map(
        (session): ConnectionItem => ({ kind: "session", session }),
      ),
    ],
    [siteRows, sessions],
  );
  const expandable = items.length > 1;
  const visible = expanded ? items : items.slice(0, 1);

  // A single session and nothing else is the one case where the app's own
  // name is the better title ("Tower Exchange"); everything else is keyed
  // by host, like the browser's site list always was.
  const title =
    !site && sessions.length === 1 ? sessions[0].peer.name || app.key : app.key;
  const transportsPresent = [...new Set(sessions.map((s) => s.transport))];
  const countLabel =
    connectionCount === 1
      ? "1 wallet"
      : sessions.length === 0
        ? `${connectionCount} wallets`
        : `${connectionCount} connections`;

  const anyPending =
    siteRows.some((w) => sitePending.has(w.address.toLowerCase())) ||
    sessions.some((s) => sessionPending.has(s.id));

  const disconnectAll = () => {
    if (site) {
      onDisconnectSite(
        site.origin,
        site.wallets.map((w) => w.address),
      );
    }
    if (sessions.length > 0) onDisconnectSessions(sessions);
  };

  return (
    <View className="bg-light border border-light-matte-black/5 rounded-2xl px-3 mb-3">
      <TouchableOpacity
        onPress={() => setExpanded((v) => !v)}
        disabled={!expandable}
        activeOpacity={0.7}
        accessibilityRole={expandable ? "button" : "text"}
        accessibilityState={expandable ? { expanded } : undefined}
        accessibilityLabel={`${title}, ${countLabel}`}
        className="flex-row items-center py-3"
      >
        <AppIcon uri={iconUrl} name={title} />
        <View className="flex-1 ml-3 mr-2">
          <Text
            className="text-[15px] font-bold text-light-matte-black"
            numberOfLines={1}
          >
            {title}
          </Text>
          <View className="flex-row items-center gap-1.5 mt-0.5">
            {transportsPresent.map((t) => (
              <TransportPill key={t} transport={t} />
            ))}
            <Text className="text-xs font-semibold text-light-primary-red">
              {countLabel}
            </Text>
          </View>
        </View>
        {site && onVisitSite ? (
          <TouchableOpacity
            onPress={() => onVisitSite(site.origin)}
            activeOpacity={0.7}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Open ${app.key}`}
            className="w-8 h-8 rounded-full bg-light-primary-red/10 items-center justify-center mr-1.5"
          >
            <ExternalLink size={15} color={BRAND_RED} strokeWidth={2} />
          </TouchableOpacity>
        ) : null}
        {expandable ? (
          expanded ? (
            <ChevronUp size={18} color={MATTE_MUTED} />
          ) : (
            <ChevronDown size={18} color={MATTE_MUTED} />
          )
        ) : null}
      </TouchableOpacity>

      <View className="border-t border-light-matte-black/5 pb-2">
        {visible.map((item, i) =>
          item.kind === "site" ? (
            <ConnectedWalletRow
              key={item.wallet.address}
              wallet={item.wallet}
              divider={i > 0}
              sourceLabel={mixed ? "Browser" : undefined}
              action={{
                type: "disconnect",
                onPress: () =>
                  site
                    ? onDisconnectWallet(site.origin, item.wallet)
                    : undefined,
                pending: sitePending.has(item.wallet.address.toLowerCase()),
              }}
            />
          ) : (
            <SessionBlock
              key={`${item.session.transport}-${item.session.id}`}
              session={item.session}
              wallets={wallets}
              showName={sessions.length > 1}
              showVia={mixed}
              divider={i > 0}
              pending={sessionPending.has(item.session.id)}
              onDisconnect={() => onDisconnectSessions([item.session])}
            />
          ),
        )}
        {expandable && expanded && !anyPending ? (
          <TouchableOpacity
            onPress={disconnectAll}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={`Disconnect all ${title} connections`}
            className="mt-1 py-2.5 rounded-xl bg-light-primary-red/10 items-center"
          >
            <Text className="text-xs font-semibold text-light-primary-red">
              Disconnect all
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

/**
 * One session inside an expanded card: its meta line, then its wallet
 * row. A WalletConnect session cannot drop a single account, so the wallet
 * row's Disconnect ends the session; a session that sees several wallets
 * gets one Disconnect on its meta line instead.
 */
function SessionBlock({
  session,
  wallets,
  showName,
  showVia,
  divider,
  pending,
  onDisconnect,
}: {
  session: TransportSession;
  wallets: TWallet[];
  /** Page title per session when the card holds several. */
  showName: boolean;
  /** Transport pill on the wallet row, when browser rows share the card. */
  showVia: boolean;
  divider: boolean;
  pending: boolean;
  onDisconnect: () => void;
}) {
  const expiry = sessionExpiryLabel(session.expiresAt);
  const rows = useMemo(
    () => sessionRows(session, wallets, showVia),
    [session, wallets, showVia],
  );
  const perWallet = rows.length === 1;

  return (
    <View className={divider ? "border-t border-light-matte-black/5" : ""}>
      <View className="flex-row items-center pt-3">
        <View className="flex-1 mr-2">
          {showName ? (
            <Text
              className="text-xs font-semibold text-light-matte-black"
              numberOfLines={1}
            >
              {session.peer.name || "Unnamed app"}
            </Text>
          ) : null}
          <View className="flex-row items-center">
            <VerificationMark verification={session.verification} />
            <Text
              className="text-xs text-light-matte-black/50 shrink"
              numberOfLines={1}
              selectable
            >
              {session.peer.url || "No address provided"}
            </Text>
            {expiry ? (
              <Text className="text-[11px] text-light-matte-black/45 ml-2">
                {expiry}
              </Text>
            ) : null}
          </View>
        </View>
        {perWallet ? null : (
          <DisconnectPill pending={pending} onPress={onDisconnect} />
        )}
      </View>
      {rows.map((w) => (
        <ConnectedWalletRow
          key={w.address}
          wallet={w}
          action={
            perWallet
              ? { type: "disconnect", onPress: onDisconnect, pending }
              : { type: "none" }
          }
        />
      ))}
    </View>
  );
}

/**
 * The session's wallets as connection rows, named from the local wallets
 * the way the browser rows are. An address we no longer hold (wallet
 * deleted after pairing) keeps its short form as the name.
 */
function sessionRows(
  session: TransportSession,
  wallets: TWallet[],
  withVia: boolean,
): DappConnectionWallet[] {
  return sessionWallets(session).map(({ namespace, address }) => {
    const local = wallets.find(
      (w) =>
        w.namespace === namespace &&
        addressesEqual(namespace, w.address, address),
    );
    const resolved = local?.address ?? address;
    return {
      address: resolved,
      name: local?.name || truncateAddress({ address: resolved }),
      namespace,
      badge: chainBadgeLabel(namespace),
      grantedAt: session.createdAt,
      connected: true,
      ...(withVia
        ? {
            via: {
              transport: session.transport,
              sessionId: session.id,
              originKey: session.originKey,
            },
          }
        : {}),
    };
  });
}

/** Session-level Disconnect, the same pill `ConnectedWalletRow` draws. */
function DisconnectPill({
  pending,
  onPress,
}: {
  pending: boolean;
  onPress: () => void;
}) {
  if (pending) return <ActivityIndicator size="small" color={BRAND_RED} />;
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Disconnect"
      className="flex-row items-center gap-1.5 pl-3 pr-2.5 py-1.5 rounded-full bg-light-primary-red/10"
    >
      <Text className="text-xs font-semibold text-light-primary-red">
        Disconnect
      </Text>
      <Unlink size={14} color={BRAND_RED} strokeWidth={2} />
    </TouchableOpacity>
  );
}

function TransportPill({
  transport,
}: {
  transport: TransportSession["transport"];
}) {
  return (
    <View className="px-1.5 py-0.5 rounded bg-emerald-50">
      <Text className="text-[10px] font-semibold text-emerald-700">
        {TRANSPORT_LABEL[transport]}
      </Text>
    </View>
  );
}

/**
 * The app's icon: the resolved logo (curated, the app's own, or the cached
 * favicon; https only) contained and inset inside the same round tile the
 * wallet rows use, so a square favicon shows whole instead of losing its
 * corners to the mask. The globe is drawn only when there is nothing to
 * load or the URL fails.
 */
function AppIcon({ uri, name }: { uri?: string; name: string }) {
  const [failed, setFailed] = useState(false);
  const usable = !!uri && /^https:\/\//i.test(uri) && !failed;
  return (
    <View
      className={`w-9 h-9 rounded-full items-center justify-center overflow-hidden ${
        usable
          ? "bg-light-main-container border border-light-matte-black/5"
          : "bg-light-primary-red/10"
      }`}
    >
      {usable ? (
        <Image
          source={{ uri }}
          // 25px is the square that fits inside a 36px circle.
          style={{ width: 25, height: 25 }}
          contentFit="contain"
          transition={150}
          onError={() => setFailed(true)}
          accessibilityLabel={`${name} icon`}
        />
      ) : (
        <Globe size={18} color={BRAND_RED} strokeWidth={2} />
      )}
    </View>
  );
}

/**
 * Verify API state, in the same vocabulary as the connect sheet's
 * provenance banner: a check for a domain match, "Unverified" for unknown,
 * "Domain mismatch" for a session the user connected to anyway. Nothing
 * for transports that don't verify.
 */
function VerificationMark({
  verification,
}: {
  verification: TransportSession["verification"];
}) {
  if (verification === "VALID") {
    return (
      <View className="mr-1" accessibilityLabel="Verified by WalletConnect">
        <ShieldCheck size={11} color={EMERALD} strokeWidth={2.5} />
      </View>
    );
  }
  if (verification === "INVALID") {
    return (
      <Text className="text-[10px] font-semibold text-orange-600 mr-1.5">
        Domain mismatch
      </Text>
    );
  }
  if (verification === "UNKNOWN") {
    return (
      <Text className="text-[10px] font-semibold text-light-matte-black/40 mr-1.5">
        Unverified
      </Text>
    );
  }
  return null;
}

export function EmptyConnectedApps() {
  return (
    <View className="bg-light border border-light-matte-black/5 rounded-2xl px-4 py-6 items-center">
      <View className="w-11 h-11 rounded-full bg-light-primary-red/10 items-center justify-center mb-3">
        <Link2 size={20} color={BRAND_RED} strokeWidth={2} />
      </View>
      <Text className="text-sm font-semibold text-light-matte-black">
        No connected apps yet
      </Text>
      <Text className="text-xs text-light-matte-black/50 text-center mt-1 leading-4">
        Connect a wallet to an app in the dApp browser, or scan a WalletConnect
        QR code from a desktop app.
      </Text>
      <TouchableOpacity
        onPress={() => router.push("/scan-to-pay")}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Scan QR code"
        className="flex-row items-center gap-1.5 mt-4 pl-3 pr-3.5 py-2 rounded-full bg-light-primary-red/10"
      >
        <ScanLine size={14} color={BRAND_RED} strokeWidth={2} />
        <Text className="text-xs font-semibold text-light-primary-red">
          Scan QR code
        </Text>
      </TouchableOpacity>
    </View>
  );
}
