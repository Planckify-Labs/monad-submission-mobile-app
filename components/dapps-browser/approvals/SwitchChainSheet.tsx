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
  const { fromChainId, fromChainName } = intent.payload;
  const from =
    fromChainName ??
    (fromChainId !== undefined
      ? (UserChainStore.get(fromChainId)?.chainName ?? `Chain ${fromChainId}`)
      : "Current network");
  const target = UserChainStore.get(intent.payload.chainId);
  return (
    <SheetModal
      onDismiss={() => onDecision({ id: intent.id, outcome: "reject" })}
    >
      <ApprovalShell intent={intent} title="Switch network">
        <View className="bg-gray-50 rounded-xl p-3">
          <Text className="text-xs text-gray-500">From</Text>
          <Text className="text-base text-gray-900 mb-2">{from}</Text>
          <Text className="text-xs text-gray-500">To</Text>
          <Text className="text-base text-gray-900">
            {target?.chainName ?? `Chain ${intent.payload.chainId}`}
          </Text>
        </View>
      </ApprovalShell>
      <PrimaryActions
        approveLabel="Switch"
        onApprove={() => onDecision({ id: intent.id, outcome: "approve" })}
        onReject={() => onDecision({ id: intent.id, outcome: "reject" })}
      />
    </SheetModal>
  );
}
