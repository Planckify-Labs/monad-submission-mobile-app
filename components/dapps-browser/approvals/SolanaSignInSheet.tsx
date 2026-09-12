import React, { useCallback } from "react";
import { ScrollView, Text, View } from "react-native";
import type {
  ApprovalDecision,
  ApprovalIntent,
} from "@/services/bridge/approval";
import type { SolanaSignInPayload } from "@/services/chains/solana/payloads";
import { ApprovalShell } from "./ApprovalShell";
import { RiskBanner } from "./RiskBanner";
import { PrimaryActions, SheetModal } from "./SheetModal";
import { useBiometricApproval } from "./useBiometricApproval";

interface Props {
  intent: ApprovalIntent<SolanaSignInPayload & { message?: string }>;
  onDecision: (d: ApprovalDecision) => void;
}

function Row({
  label,
  value,
}: {
  label: string;
  value?: string;
}): React.ReactElement | null {
  if (!value) return null;
  return (
    <View className="flex-row py-1.5 border-b border-gray-100">
      <Text className="w-28 text-xs text-gray-500">{label}</Text>
      <Text className="flex-1 text-sm text-gray-900" selectable>
        {value}
      </Text>
    </View>
  );
}

export function SolanaSignInSheet({
  intent,
  onDecision,
}: Props): React.ReactElement {
  const p = intent.payload;
  const approve = useCallback(
    () => onDecision({ id: intent.id, outcome: "approve" }),
    [intent.id, onDecision],
  );
  const { gatedApprove, pending, error } = useBiometricApproval(
    `Sign in to ${p.domain || "site"}`,
    approve,
  );
  return (
    <SheetModal
      onDismiss={() => onDecision({ id: intent.id, outcome: "reject" })}
    >
      <ApprovalShell intent={intent} title="Sign in with Solana">
        <RiskBanner annotations={intent.annotations} showProvenance={false} />
        <ScrollView
          className="flex-1"
          contentContainerClassName="pb-4"
          showsVerticalScrollIndicator
        >
          {p.statement && (
            <View className="bg-gray-50 rounded-xl p-3 mb-3">
              <Text className="text-sm text-gray-900" selectable>
                {p.statement}
              </Text>
            </View>
          )}
          <Row label="Domain" value={p.domain} />
          <Row label="Address" value={p.address} />
          <Row label="URI" value={p.uri} />
          <Row label="Chain" value={p.chainId} />
          <Row label="Nonce" value={p.nonce} />
          <Row label="Issued at" value={p.issuedAt} />
          <Row label="Expires" value={p.expirationTime} />
          <Row label="Not before" value={p.notBefore} />
          <Row label="Request ID" value={p.requestId} />
          {p.resources && p.resources.length > 0 && (
            <View className="mt-3">
              <Text className="text-xs text-gray-500 mb-1">Resources</Text>
              {p.resources.map((r) => (
                <Text key={r} className="text-xs text-gray-700">
                  · {r}
                </Text>
              ))}
            </View>
          )}
          {error && <Text className="text-xs text-red-600 mt-2">{error}</Text>}
        </ScrollView>
      </ApprovalShell>
      <PrimaryActions
        approveLabel={pending ? "Authenticating…" : "Sign in"}
        onApprove={() => {
          void gatedApprove();
        }}
        onReject={() => onDecision({ id: intent.id, outcome: "reject" })}
        loading={pending}
      />
    </SheetModal>
  );
}
