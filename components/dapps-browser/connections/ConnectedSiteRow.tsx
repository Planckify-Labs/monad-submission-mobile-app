import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Globe,
} from "lucide-react-native";
import React, { memo, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import type {
  DappConnectionSite,
  DappConnectionWallet,
} from "@/hooks/useDappConnections";
import { originHost } from "@/services/permissions/caip";
import ConnectedWalletRow from "./ConnectedWalletRow";

// lucide takes a solid color string rather than a className.
const BRAND_RED = "#c71c4b"; // light-primary-red
const MATTE_MUTED = "rgba(32,34,44,0.45)"; // secondary controls (chevron)

interface ConnectedSiteRowProps {
  site: DappConnectionSite;
  onDisconnectWallet: (wallet: DappConnectionWallet) => void;
  onDisconnectSite: () => void;
  pendingAddresses: Set<string>;
  /** Opens the site in the browser. Hidden when not provided. */
  onVisit?: () => void;
}

/**
 * Collapsible site entry for the hub-level "Connected sites" list. Tap the
 * header to reveal the wallets connected to that origin, each with its own
 * Disconnect, plus a "Disconnect all" for the whole site.
 */
const ConnectedSiteRow = memo<ConnectedSiteRowProps>(function ConnectedSiteRow({
  site,
  onDisconnectWallet,
  onDisconnectSite,
  pendingAddresses,
  onVisit,
}) {
  const [expanded, setExpanded] = useState(false);
  const host = originHost(site.origin);

  return (
    <View className="bg-light border border-light-matte-black/5 rounded-2xl px-3 mb-3">
      <TouchableOpacity
        onPress={() => setExpanded((v) => !v)}
        activeOpacity={0.7}
        className="flex-row items-center py-3"
      >
        <View className="w-9 h-9 rounded-full bg-light-primary-red/10 items-center justify-center">
          <Globe size={18} color={BRAND_RED} strokeWidth={2} />
        </View>
        <View className="flex-1 ml-3 mr-2">
          <Text
            className="text-sm font-semibold text-light-matte-black"
            numberOfLines={1}
          >
            {host}
          </Text>
          <Text className="text-xs font-semibold text-light-primary-red mt-0.5">
            {site.count} {site.count === 1 ? "wallet" : "wallets"}
          </Text>
        </View>
        {onVisit && (
          <TouchableOpacity
            onPress={onVisit}
            activeOpacity={0.7}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Open ${host}`}
            className="w-8 h-8 rounded-full bg-light-primary-red/10 items-center justify-center mr-1"
          >
            <ExternalLink size={15} color={BRAND_RED} strokeWidth={2} />
          </TouchableOpacity>
        )}
        {expanded ? (
          <ChevronDown size={18} color={MATTE_MUTED} />
        ) : (
          <ChevronRight size={18} color={MATTE_MUTED} />
        )}
      </TouchableOpacity>

      {expanded && (
        <View className="border-t border-light-matte-black/5 pb-2">
          {site.wallets.map((w, i) => (
            <ConnectedWalletRow
              key={w.address}
              wallet={w}
              divider={i > 0}
              action={{
                type: "disconnect",
                onPress: () => onDisconnectWallet(w),
                pending: pendingAddresses.has(w.address.toLowerCase()),
              }}
            />
          ))}
          <TouchableOpacity
            onPress={onDisconnectSite}
            activeOpacity={0.7}
            className="mt-1 py-2.5 rounded-xl bg-light-primary-red/10 items-center"
          >
            <Text className="text-xs font-semibold text-light-primary-red">
              Disconnect all
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
});

export default ConnectedSiteRow;
