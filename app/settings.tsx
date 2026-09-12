/**
 * Settings screen — the single home for app-level preferences and the
 * permission / privacy surfaces that used to sit as loose cards at the
 * bottom of the Wallets screen. Rows are grouped by concern and each one
 * links out to its own screen; nothing is edited inline here.
 */

import { type Href, router } from "expo-router";
import {
  ArrowLeft,
  ChevronRight,
  Fuel,
  History,
  Link2,
  type LucideIcon,
  Shield,
  Sparkles,
} from "lucide-react-native";
import React from "react";
import {
  Pressable,
  ScrollView,
  StatusBar,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { useStrategiesPrefetch } from "@/hooks/strategies/useStrategiesPrefetch";
import { useDappConnections } from "@/hooks/useDappConnections";
import { usePreferredGasToken } from "@/hooks/usePreferredGasToken";
import { useTransportSessions } from "@/hooks/useTransportSessions";
import { useWallet } from "@/hooks/useWallet";

const CARD_SHADOW = {
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.04,
  shadowRadius: 6,
  elevation: 1,
} as const;

type TSettingsRow = {
  icon: LucideIcon;
  label: string;
  hint: string;
  href: Href;
  accessibilityHint: string;
  /** Trailing read-only value, e.g. the currently selected gas token. */
  value?: string;
};

type TSettingsGroup = {
  title: string;
  rows: TSettingsRow[];
};

export default function SettingsScreen() {
  const { bottom } = useSafeAreaInsets();
  const { preferredGasToken } = usePreferredGasToken();

  // Everything that can see the user's wallet: browser-site grants plus
  // live transport sessions (WalletConnect / MWA / app links). Passive
  // read of the transports: `bootTransports` already runs WalletConnect
  // whenever sessions exist, and starting MWA / app links just to count
  // them is not worth it on a menu screen.
  const { wallets } = useWallet();
  const { sites } = useDappConnections({ origin: null, wallets });
  const sessions = useTransportSessions(undefined, { eager: false });
  const connectedCount = sites.length + sessions.length;

  // Warm the strategies screen's queries while the user is here, so the
  // DeFi Strategies row below renders with cached data instead of a cold
  // spinner.
  useStrategiesPrefetch();

  const groups: TSettingsGroup[] = [
    {
      title: "Earn",
      rows: [
        {
          icon: Sparkles,
          label: "DeFi Strategies",
          hint: "Positions, opportunities, and strategy preferences",
          href: "/strategies",
          accessibilityHint:
            "Open your DeFi strategy positions, opportunities, and settings",
        },
      ],
    },
    {
      title: "Transactions",
      rows: [
        {
          icon: Fuel,
          label: "Gas Settings",
          hint: "Which token pays your network fees",
          href: "/gas-settings",
          accessibilityHint:
            "Choose whether transaction gas is paid in USDC or the native token",
          value: preferredGasToken === "usdc" ? "USDC" : "Native",
        },
      ],
    },
    {
      title: "Privacy & security",
      rows: [
        {
          icon: Link2,
          label: "Connected apps",
          hint: "Sites and apps that can see your wallet",
          href: "/dapp-permissions",
          accessibilityHint: "Review and disconnect connected sites and apps",
          value: String(connectedCount),
        },
        {
          icon: Shield,
          label: "Agent Permissions",
          hint: "What the AI agent is allowed to do for you",
          href: "/agent-permissions",
          accessibilityHint:
            "View and revoke permissions granted to the AI agent",
        },
        {
          icon: History,
          label: "Browser Privacy",
          hint: "Sites the dApp browser remembers",
          href: "/browser-privacy",
          accessibilityHint:
            "Review and clear the sites the dApp browser suggests",
        },
      ],
    },
  ];

  return (
    <>
      <StatusBar barStyle="dark-content" />
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
              <ArrowLeft size={18} color="#c71c4b" />
            </Pressable>
            <View className="flex-1">
              <Text className="text-light-matte-black text-2xl font-bold tracking-tight">
                Settings
              </Text>
              <Text className="text-light-matte-black/50 text-xs mt-0.5">
                Preferences, permissions, and privacy.
              </Text>
            </View>
          </View>
        </View>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingBottom: 48 }}
          showsVerticalScrollIndicator={false}
        >
          {groups.map((group) => (
            <SettingsGroup key={group.title} group={group} />
          ))}
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

function SettingsGroup({ group }: { group: TSettingsGroup }) {
  return (
    <View className="mx-4 mb-5">
      <Text className="text-light-matte-black/50 text-xs uppercase tracking-wide mb-2 ml-1">
        {group.title}
      </Text>
      <View
        className="bg-light rounded-2xl overflow-hidden"
        style={CARD_SHADOW}
      >
        {group.rows.map((row, index) => (
          <React.Fragment key={row.label}>
            {index > 0 ? (
              <View className="h-px bg-light-matte-black/5" />
            ) : null}
            <SettingsRow row={row} />
          </React.Fragment>
        ))}
      </View>
    </View>
  );
}

function SettingsRow({ row }: { row: TSettingsRow }) {
  const Icon = row.icon;
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={() => router.push(row.href)}
      accessibilityRole="button"
      accessibilityLabel={row.label}
      accessibilityHint={row.accessibilityHint}
      className="px-4 py-3.5 flex-row items-center"
    >
      <View className="w-9 h-9 rounded-xl bg-light-primary-red/10 items-center justify-center mr-3">
        <Icon size={18} color="#c71c4b" />
      </View>
      <View className="flex-1 pr-3">
        <Text
          className="text-light-matte-black font-semibold"
          numberOfLines={1}
        >
          {row.label}
        </Text>
        <Text
          className="text-light-matte-black/50 text-xs mt-0.5"
          numberOfLines={1}
        >
          {row.hint}
        </Text>
      </View>
      {row.value ? (
        <Text className="text-light-matte-black/50 text-sm mr-1.5">
          {row.value}
        </Text>
      ) : null}
      <ChevronRight size={18} color="#c71c4b" />
    </TouchableOpacity>
  );
}
