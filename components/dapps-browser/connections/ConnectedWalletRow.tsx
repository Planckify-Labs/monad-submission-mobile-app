import { Link2Off, Unlink } from "lucide-react-native";
import React, { memo } from "react";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import type { DappConnectionWallet } from "@/hooks/useDappConnections";
import { TRANSPORT_LABEL } from "@/hooks/useTransportSessions";
import { truncateAddress, walletAvatarInitials } from "@/utils/walletUtils";

// Brand palette (tailwind.config.js `light.*`) for the lucide icons, which
// take a solid color string rather than a className.
const BRAND_RED = "#c71c4b"; // light-primary-red
const MATTE_MUTED = "rgba(32,34,44,0.4)"; // light-matte-black @ 40%

/**
 * Trailing affordance for a wallet row:
 *   - `disconnect` — a tappable unlink pill with an optional pending spinner.
 *   - `status`     — read-only "not connected" icon (`label` is the a11y text).
 *   - `none`       — nothing (informational row).
 */
export type WalletRowAction =
  | { type: "disconnect"; onPress: () => void; pending?: boolean }
  | { type: "status"; label: string }
  | { type: "none" };

interface ConnectedWalletRowProps {
  wallet: DappConnectionWallet;
  action: WalletRowAction;
  /** Hairline divider above the row — set for every row after the first. */
  divider?: boolean;
}

/**
 * One wallet line in the connection manager — avatar, name, truncated
 * address, a compact chain badge, and a trailing action. Presentational
 * only; the parent owns connection state and disconnect handlers.
 */
const ConnectedWalletRow = memo<ConnectedWalletRowProps>(
  function ConnectedWalletRow({ wallet, action, divider }) {
    return (
      <View
        className={`flex-row items-center py-3 ${
          divider ? "border-t border-light-matte-black/5" : ""
        }`}
      >
        <View
          className={`w-9 h-9 rounded-xl items-center justify-center ${
            wallet.connected
              ? "bg-light-primary-red/10"
              : "bg-light-main-container"
          }`}
        >
          <Text
            className={`text-xs font-bold ${
              wallet.connected
                ? "text-light-primary-red"
                : "text-light-matte-black/45"
            }`}
          >
            {walletAvatarInitials({ name: wallet.name })}
          </Text>
        </View>

        <View className="flex-1 ml-3 mr-2">
          <View className="flex-row items-center gap-2">
            <Text
              className="text-sm font-semibold text-light-matte-black"
              numberOfLines={1}
            >
              {wallet.name}
            </Text>
            <View className="px-1.5 py-0.5 rounded bg-light-main-container">
              <Text className="text-[10px] font-semibold text-light-matte-black">
                {wallet.badge}
              </Text>
            </View>
            {wallet.via ? (
              <View className="px-1.5 py-0.5 rounded bg-emerald-50">
                <Text className="text-[10px] font-semibold text-emerald-700">
                  {TRANSPORT_LABEL[wallet.via.transport]}
                </Text>
              </View>
            ) : null}
          </View>
          <Text
            className="text-xs text-light-matte-black mt-0.5"
            numberOfLines={1}
          >
            {truncateAddress({ address: wallet.address, preset: "medium" })}
          </Text>
        </View>

        {action.type === "disconnect" &&
          (action.pending ? (
            <ActivityIndicator size="small" color={BRAND_RED} />
          ) : (
            <TouchableOpacity
              onPress={action.onPress}
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
          ))}

        {action.type === "status" && (
          <View
            accessibilityLabel={action.label}
            className="w-9 h-9 items-center justify-center"
          >
            <Link2Off size={16} color={MATTE_MUTED} strokeWidth={2} />
          </View>
        )}
      </View>
    );
  },
);

export default ConnectedWalletRow;
