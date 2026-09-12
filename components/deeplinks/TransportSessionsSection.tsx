/**
 * "Connected apps" section for the dApp-permissions screen — deep-link
 * spec §7.6 / D-16. Lists live sessions across every session transport
 * (WalletConnect today, MWA scopes on Android, Phantom-compatible
 * encrypted-link sessions) with peer name/url rendered as plain text
 * (never auto-opened, TWV-2026-030), chains, bound accounts and a
 * Disconnect action. Chain-agnostic: chips come from the CAIP-2 prefix.
 */

import { Link2, Unplug } from "lucide-react-native";
import React, { useMemo } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import {
  allTransports,
  TRANSPORT_LABEL,
  useTransportSessions,
} from "@/hooks/useTransportSessions";
import type { Namespace } from "@/services/chains/types";
import type { TransportSession } from "@/services/transports/types";
import { chainBadgeLabel } from "@/services/walletKit/chainInfo";
import { truncateAddress } from "@/utils/walletUtils";

export function TransportSessionsSection(): React.ReactElement | null {
  const transports = allTransports();
  const sessions = useTransportSessions(transports);
  const byTransport = useMemo(() => {
    const groups = new Map<TransportSession["transport"], TransportSession[]>();
    for (const s of sessions)
      groups.set(s.transport, [...(groups.get(s.transport) ?? []), s]);
    return [...groups.entries()];
  }, [sessions]);

  if (sessions.length === 0) return null;

  return (
    <View className="mb-6">
      <Text className="text-xs font-semibold text-gray-500 uppercase mb-2">
        Connected apps
      </Text>
      {byTransport.map(([transport, list]) => (
        <View key={transport} className="mb-3">
          <Text className="text-xs text-gray-400 mb-1">
            {TRANSPORT_LABEL[transport]}
          </Text>
          {list.map((s) => {
            const namespaces = [
              ...new Set(s.chains.map((c) => c.split(":")[0] as Namespace)),
            ];
            const t = transports.find((x) => x.id === s.transport);
            return (
              <View
                key={`${s.transport}-${s.id}`}
                className="bg-white border border-gray-100 rounded-2xl p-3 mb-2"
              >
                <View className="flex-row items-center">
                  <View className="w-8 h-8 rounded-full bg-light-primary-red/10 items-center justify-center">
                    <Link2 size={16} color="#c71c4b" />
                  </View>
                  <View className="ml-3 flex-1">
                    <Text
                      className="text-sm font-semibold text-gray-900"
                      numberOfLines={1}
                    >
                      {s.peer.name || "Unnamed app"}
                    </Text>
                    <Text
                      className="text-xs text-gray-500"
                      numberOfLines={1}
                      selectable
                    >
                      {s.peer.url || "No address provided"}
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => void t?.disconnect(s.id)}
                    className="flex-row items-center px-2 py-1 rounded-full bg-gray-100"
                    accessibilityLabel={`disconnect-${s.transport}-${s.id}`}
                  >
                    <Unplug size={12} color="#20222c" />
                    <Text className="ml-1 text-xs font-semibold text-gray-800">
                      Disconnect
                    </Text>
                  </TouchableOpacity>
                </View>
                <View className="flex-row flex-wrap mt-2">
                  {namespaces.map((ns) => (
                    <View
                      key={ns}
                      className="px-2 py-0.5 rounded-full bg-gray-100 mr-1 mb-1"
                    >
                      <Text className="text-[10px] font-semibold text-gray-700">
                        {chainBadgeLabel(ns)}
                      </Text>
                    </View>
                  ))}
                  {s.accounts.slice(0, 3).map((a) => {
                    const addr = a.split(":")[2] ?? a;
                    return (
                      <View
                        key={a}
                        className="px-2 py-0.5 rounded-full bg-gray-50 border border-gray-100 mr-1 mb-1"
                      >
                        <Text className="text-[10px] text-gray-600">
                          {truncateAddress({ address: addr })}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}
