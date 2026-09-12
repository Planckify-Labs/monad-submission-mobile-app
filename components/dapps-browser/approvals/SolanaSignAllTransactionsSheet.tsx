import { ChevronDown, ChevronRight } from "lucide-react-native";
import React, { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import type {
  ApprovalDecision,
  ApprovalIntent,
} from "@/services/bridge/approval";
import type { SolanaSignAllTransactionsPayload } from "@/services/chains/solana/payloads";
import type { ComputeSigningDigestArgs } from "@/services/walletKit/types";
import { ApprovalShell } from "./ApprovalShell";
import { ClearSigningSection } from "./ClearSigningSection";
import { RiskBanner } from "./RiskBanner";
import { PrimaryActions, SheetModal } from "./SheetModal";
import { useBiometricApproval } from "./useBiometricApproval";

interface Props {
  intent: ApprovalIntent<SolanaSignAllTransactionsPayload>;
  onDecision: (d: ApprovalDecision) => void;
}

const CLUSTER_LABEL: Record<string, string> = {
  "mainnet-beta": "Mainnet",
  devnet: "Devnet",
  testnet: "Testnet",
};

function TxCard({
  intent,
  index,
  body,
  version,
  simulationWarningCount,
  defaultOpen,
}: {
  intent: ApprovalIntent<SolanaSignAllTransactionsPayload>;
  index: number;
  body: string;
  version: 0 | "legacy";
  simulationWarningCount: number;
  defaultOpen: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  // Task 65 — per-transaction message SHA-256 digest (every entry in
  // the batch is its own signature payload).
  const digestArgs = useMemo<ComputeSigningDigestArgs>(
    () => ({ kind: "transaction", transaction: body }),
    [body],
  );
  return (
    <View className="border border-gray-200 rounded-xl mb-2 overflow-hidden">
      <TouchableOpacity
        onPress={() => setOpen((o) => !o)}
        className="flex-row items-center px-3 py-2 bg-gray-50"
      >
        {open ? (
          <ChevronDown size={16} color="#111" />
        ) : (
          <ChevronRight size={16} color="#111" />
        )}
        <Text className="ml-2 text-sm font-medium text-gray-900 flex-1">
          Transaction {index + 1}
        </Text>
        <Text className="text-xs text-gray-500 mr-2">
          {version === 0 ? "v0" : "legacy"}
        </Text>
        {simulationWarningCount > 0 && (
          <View className="px-2 py-0.5 rounded-full bg-amber-100">
            <Text className="text-[10px] font-medium text-amber-900">
              {simulationWarningCount} warn
            </Text>
          </View>
        )}
      </TouchableOpacity>
      {open && (
        <View className="px-3 py-2">
          <ClearSigningSection intent={intent} digestArgs={digestArgs} />
          <Text className="text-[10px] text-gray-400 mb-1">Base64 payload</Text>
          <Text
            className="text-xs font-mono text-gray-700"
            selectable
            numberOfLines={6}
          >
            {body}
          </Text>
        </View>
      )}
    </View>
  );
}

export function SolanaSignAllTransactionsSheet({
  intent,
  onDecision,
}: Props): React.ReactElement {
  const p = intent.payload;
  const n = p.transactions.length;

  const approve = useCallback(
    () => onDecision({ id: intent.id, outcome: "approve" }),
    [intent.id, onDecision],
  );
  const { gatedApprove, pending, error } = useBiometricApproval(
    `Sign ${n} transactions`,
    approve,
  );

  return (
    <SheetModal
      onDismiss={() => onDecision({ id: intent.id, outcome: "reject" })}
    >
      <ApprovalShell intent={intent} title={`Sign ${n} transactions`}>
        <RiskBanner annotations={intent.annotations} showProvenance={false} />
        <View className="flex-row items-center mb-3">
          <View className="px-2 py-0.5 rounded-full bg-violet-100">
            <Text className="text-xs font-medium text-violet-700">
              Solana · {CLUSTER_LABEL[p.cluster] ?? p.cluster}
            </Text>
          </View>
          <View className="ml-2 px-2 py-0.5 rounded-full bg-gray-100">
            <Text className="text-xs text-gray-700">Batch of {n}</Text>
          </View>
        </View>
        <Text className="text-xs text-gray-500 mb-2">
          Approving signs every transaction below in order. Reject cancels all.
        </Text>
        <ScrollView className="flex-1">
          {p.transactions.map((tx, i) => (
            <TxCard
              key={`${i}-${tx.transaction.slice(0, 8)}`}
              intent={intent}
              index={i}
              body={tx.transaction}
              version={tx.version}
              simulationWarningCount={tx.simulation?.warnings.length ?? 0}
              defaultOpen={i === 0}
            />
          ))}
          {error && <Text className="text-xs text-red-600 mt-2">{error}</Text>}
        </ScrollView>
      </ApprovalShell>
      <PrimaryActions
        approveLabel={pending ? "Authenticating…" : `Approve all (${n})`}
        onApprove={() => {
          void gatedApprove();
        }}
        onReject={() => onDecision({ id: intent.id, outcome: "reject" })}
        loading={pending}
      />
    </SheetModal>
  );
}
