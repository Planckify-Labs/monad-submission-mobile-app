import React from "react";
import { ScrollView, Text, View } from "react-native";
import type {
  ApprovalDecision,
  ApprovalIntent,
} from "@/services/bridge/approval";
import type { EvmAddChainPayload } from "@/services/chains/evm/payloads";
import { ApprovalShell } from "./ApprovalShell";
import { PrimaryActions, SheetModal } from "./SheetModal";

interface Props {
  intent: ApprovalIntent<EvmAddChainPayload>;
  onDecision: (d: ApprovalDecision) => void;
}

export function AddChainSheet({
  intent,
  onDecision,
}: Props): React.ReactElement {
  const p = intent.payload;
  return (
    <SheetModal
      onDismiss={() => onDecision({ id: intent.id, outcome: "reject" })}
    >
      <ApprovalShell intent={intent} title="Add network">
        <ScrollView className="flex-1">
          <View className="mb-3 bg-amber-50 border border-amber-200 rounded-xl p-3">
            <Text className="text-xs text-amber-800">
              This site wants to add a custom network we do not verify. It will
              be available only on this site, and balances or transaction
              previews on it cannot be checked. Add it only if you trust this
              site.
            </Text>
          </View>
          <View className="bg-gray-50 rounded-xl p-3">
            <Row k="Name" v={p.chainName} />
            <Row k="Chain ID" v={String(p.chainId)} />
            <Row k="Currency" v={p.nativeCurrency.symbol} />
            <Row k="RPC" v={p.rpcUrls[0] ?? ""} />
            {p.blockExplorerUrls?.[0] && (
              <Row k="Explorer" v={p.blockExplorerUrls[0]} />
            )}
          </View>
        </ScrollView>
      </ApprovalShell>
      <PrimaryActions
        approveLabel="Add"
        onApprove={() => onDecision({ id: intent.id, outcome: "approve" })}
        onReject={() => onDecision({ id: intent.id, outcome: "reject" })}
      />
    </SheetModal>
  );
}

function Row({ k, v }: { k: string; v: string }): React.ReactElement {
  return (
    <View className="flex-row py-1">
      <Text className="text-xs text-gray-500 w-24">{k}</Text>
      <Text className="text-xs text-gray-900 flex-1" selectable>
        {v}
      </Text>
    </View>
  );
}
