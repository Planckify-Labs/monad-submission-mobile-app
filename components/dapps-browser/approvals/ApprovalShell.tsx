import { Globe, ShieldCheck, Sparkles } from "lucide-react-native";
import React from "react";
import { Text, TouchableOpacity, View } from "react-native";
import type { ApprovalIntent } from "@/services/bridge/approval";
import { getDappBridge } from "@/services/bridge/DappBridge";
import { InspectorRegistry } from "@/services/bridge/inspector";
import { useApprovalQueue } from "@/services/bridge/useApprovalQueue";
import { truncateAddress } from "@/utils/walletUtils";
import { RiskBanner } from "./RiskBanner";

interface Props {
  intent: ApprovalIntent;
  title: string;
  /**
   * One plain sentence under the title saying what the site is asking
   * for, in the user's terms rather than the protocol's. A title alone
   * names the mechanism ("Approve transaction"); this says what it means
   * ("This site wants permission to spend your tokens.").
   */
  subtitle?: string;
  children: React.ReactNode;
}

export function ApprovalShell({
  intent,
  title,
  subtitle,
  children,
}: Props): React.ReactElement {
  // Render strictly from the intent. The dApp surface MUST NOT
  // depend on the home-screen `useWallet().activeWallet` /
  // `activeChain` — each dApp connection is per-origin and per-wallet
  // (same isolation rule as the payment flow). Leaking the global
  // active row into the sign sheet header was the bug that made
  // signatures look like they were produced by the wrong wallet: the
  // bridge was signing with `intent.wallet` (correct), but the header
  // was showing whatever was active on the home screen (often a
  // different wallet), which read as "wrong wallet" to both the user
  // and the dApp's mismatch error.
  //
  // No fallback. If `intent.wallet` is null, the sheet renders without
  // a wallet line — that case is a genuine bug in the dispatch path
  // and should be visible, not papered over by the global active row.
  const signingWallet = intent.wallet;
  const isSecure = intent.origin.url.startsWith("https://");
  let host = intent.origin.url;
  try {
    host = new URL(intent.origin.url).hostname;
  } catch {
    // keep raw url as fallback
  }

  const onDemandInspectors = InspectorRegistry.list("on-demand").filter(
    (i) => !i.namespaces || i.namespaces.includes(intent.namespace),
  );
  const canAskAgent = onDemandInspectors.some((i) => i.name === "agent");

  // Phase Q — say how many requests are waiting, and offer one tap out.
  // A sheet that hides the queue turns "another one appeared" into a
  // surprise every time, which is what makes rapid-fire approvals work.
  const queue = useApprovalQueue(intent.id);

  return (
    <View className="flex-1">
      <View className="px-4 pt-2 pb-3">
        {queue.depth > 1 && (
          <View className="flex-row items-center mb-2">
            <View className="bg-amber-100 rounded-full px-2 py-0.5">
              <Text className="text-xs font-semibold text-amber-900">
                Request {queue.position} of {queue.depth}
              </Text>
            </View>
            <View className="flex-1" />
            <TouchableOpacity
              onPress={queue.rejectAll}
              accessibilityLabel="reject-all-pending"
            >
              <Text className="text-xs font-semibold text-light-primary-red underline">
                Reject all
              </Text>
            </TouchableOpacity>
          </View>
        )}
        <Text className="text-lg font-semibold text-gray-900">{title}</Text>
        {subtitle && (
          <Text className="text-sm text-light-matte-black/60 mt-1">
            {subtitle}
          </Text>
        )}
        <View className="flex-row items-center mt-2">
          <Globe size={14} color={isSecure ? "#059669" : "#ea580c"} />
          <Text className="ml-1 text-xs text-gray-600 flex-1" numberOfLines={1}>
            {host}
          </Text>
          {isSecure ? (
            <ShieldCheck size={12} color="#059669" />
          ) : (
            <Text className="text-xs text-orange-600">insecure</Text>
          )}
        </View>
        {signingWallet?.address && (
          <View className="flex-row items-center mt-2">
            <Text className="text-xs text-gray-500">
              {signingWallet.name ?? "Wallet"} ·{" "}
              {truncateAddress({ address: signingWallet.address })}
            </Text>
          </View>
        )}
      </View>

      <View className="px-4">
        <RiskBanner annotations={intent.annotations} />
        {canAskAgent && (
          <TouchableOpacity
            onPress={() => {
              getDappBridge()?.runOnDemandInspector("agent", intent.id);
            }}
            className="flex-row items-center self-start bg-purple-50 border border-purple-200 rounded-full px-3 py-1.5 mb-3"
          >
            <Sparkles size={12} color="#7c3aed" />
            <Text className="ml-1 text-xs text-purple-700 font-medium">
              Ask Takumi AI to review
            </Text>
          </TouchableOpacity>
        )}
      </View>

      <View className="flex-1 px-4">{children}</View>
    </View>
  );
}
