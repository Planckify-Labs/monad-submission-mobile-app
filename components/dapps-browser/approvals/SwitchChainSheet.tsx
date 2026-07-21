import React from "react";
import { Text, View } from "react-native";
import type {
  ApprovalDecision,
  ApprovalIntent,
} from "@/services/bridge/approval";
import { UserChainStore } from "@/services/chains/evm/chainStore";
import type { EvmSwitchChainPayload } from "@/services/chains/evm/payloads";
import { ApprovalShell } from "./ApprovalShell";
import { PrimaryActions, SheetModal } from "./SheetModal";

interface Props {
  intent: ApprovalIntent<EvmSwitchChainPayload>;
  onDecision: (d: ApprovalDecision) => void;
}

export function SwitchChainSheet({
  intent,
  onDecision,
}: Props): React.ReactElement {
  // dApp-bridge isolation: "From" is the chain the dApp session is on,
  // stamped into the payload by the adapter — never the home-screen
  // `useWallet().activeChain`, which can point somewhere else entirely.
  const { fromChainId, fromChainName, toChainName, toIsCustom } =
    intent.payload;
  const from =
    fromChainName ??
    (fromChainId !== undefined
      ? (UserChainStore.get(fromChainId)?.chainName ?? `Chain ${fromChainId}`)
      : "Current network");
  // Prefer the name the adapter stamped (feed for registered chains,
  // UserChainStore for custom). Falls back to a store read, then the id.
  const to =
    toChainName ??
    UserChainStore.get(intent.payload.chainId)?.chainName ??
    `Chain ${intent.payload.chainId}`;
  return (
    <SheetModal
      onDismiss={() => onDecision({ id: intent.id, outcome: "reject" })}
    >
      <ApprovalShell intent={intent} title="Switch network">
        <View className="bg-gray-50 rounded-xl p-3">
          <Text className="text-xs text-gray-500">From</Text>
          <Text className="text-base text-gray-900 mb-2">{from}</Text>
          <Text className="text-xs text-gray-500">To</Text>
          <Text className="text-base text-gray-900">{to}</Text>
        </View>
        {toIsCustom && (
          <View className="mt-3 bg-amber-50 border border-amber-200 rounded-xl p-3">
            <Text className="text-xs text-amber-800">
              This is a custom network this site added. It is not one of our
              verified networks, so balances and transaction previews on it
              cannot be checked. Continue only if you trust this site.
            </Text>
          </View>
        )}
      </ApprovalShell>
      <PrimaryActions
        approveLabel="Switch"
        onApprove={() => onDecision({ id: intent.id, outcome: "approve" })}
        onReject={() => onDecision({ id: intent.id, outcome: "reject" })}
      />
    </SheetModal>
  );
}
