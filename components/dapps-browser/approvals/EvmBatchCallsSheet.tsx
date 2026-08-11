import React, { useCallback, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { formatEther } from "viem";
import type {
  ApprovalDecision,
  ApprovalIntent,
} from "@/services/bridge/approval";
import type { EvmBatchCallsPayload } from "@/services/chains/evm/payloads";
import { decodeCalldata } from "@/services/decoders";
import { originHost } from "@/services/permissions/caip";
import type { ComputeSigningDigestArgs } from "@/services/walletKit/types";
import { ApprovalShell } from "./ApprovalShell";
import { ClearSigningSection } from "./ClearSigningSection";
import { PrimaryActions, SheetModal } from "./SheetModal";
import { useBiometricApproval } from "./useBiometricApproval";

/**
 * Task 65 — per-call clear-signing block. Each batch entry gets its
 * own Stage-2 descriptor + ERC-8213 Flow B calldata digest ("both,
 * never one" applies per calldata, and a batch is N calldatas).
 */
function BatchCallClearSigning({
  intent,
  call,
}: {
  intent: ApprovalIntent<EvmBatchCallsPayload>;
  call: EvmBatchCallsPayload["calls"][number];
}): React.ReactElement | null {
  const hasCalldata = !!call.data && call.data !== "0x";
  const clearSigningCall = useMemo(
    () =>
      hasCalldata
        ? { to: call.to, chainId: intent.payload.chainId, data: call.data }
        : undefined,
    [hasCalldata, call.to, call.data, intent.payload.chainId],
  );
  const digestArgs = useMemo<ComputeSigningDigestArgs>(
    () => ({ kind: "calldata", calldata: call.data ?? "0x" }),
    [call.data],
  );
  return (
    <ClearSigningSection
      intent={intent}
      call={clearSigningCall}
      digestArgs={digestArgs}
    />
  );
}

interface Props {
  intent: ApprovalIntent<EvmBatchCallsPayload>;
  onDecision: (d: ApprovalDecision) => void;
}

export function EvmBatchCallsSheet({
  intent,
  onDecision,
}: Props): React.ReactElement {
  const p = intent.payload;
  const atomic =
    intent.wallet?.type === "Smart4337" || intent.wallet?.type === "Smart7702";

  // Device-owner check before the wallet signs. A batch is N fund-moving
  // calls behind one tap, so it needs the gate at least as much as the
  // single-transaction sheet does.
  const approve = useCallback(
    () => onDecision({ id: intent.id, outcome: "approve" }),
    [intent.id, onDecision],
  );
  const {
    gatedApprove,
    pending,
    error: biometricError,
  } = useBiometricApproval(
    `Confirm ${p.calls.length} calls for ${originHost(intent.origin.url)}`,
    approve,
  );

  return (
    <SheetModal
      onDismiss={() => onDecision({ id: intent.id, outcome: "reject" })}
    >
      <ApprovalShell intent={intent} title={`Batch (${p.calls.length} calls)`}>
        <ScrollView className="flex-1">
          <View
            className={`self-start px-2 py-1 rounded-full mb-3 ${
              atomic ? "bg-green-50" : "bg-amber-50"
            }`}
          >
            <Text
              className={`text-xs ${
                atomic ? "text-green-700" : "text-amber-700"
              }`}
            >
              {atomic ? "Atomic batch" : "Sequential"}
            </Text>
          </View>
          {!atomic && (
            <Text className="text-xs text-amber-700 mb-3">
              Sequential: if one step fails, earlier steps will still be
              on-chain.
            </Text>
          )}
          {p.calls.map((c, i) => {
            const decoded = decodeCalldata(c.data);
            return (
              <View
                key={`${c.to}-${i}`}
                className="bg-white border border-gray-200 rounded-xl p-3 mb-2"
              >
                <Text className="text-xs text-gray-500">Call {i + 1}</Text>
                <Text className="text-sm text-gray-900" selectable>
                  {c.to}
                </Text>
                {c.value && c.value > 0n && (
                  <Text className="text-xs text-gray-500 mt-1">
                    Value: {formatEther(c.value)}
                  </Text>
                )}
                {decoded?.signature && (
                  <Text className="text-xs text-gray-700 mt-1">
                    {decoded.functionName}(
                    {decoded.args?.map((a) => a.name).join(", ")})
                  </Text>
                )}
                <View className="mt-2">
                  <BatchCallClearSigning intent={intent} call={c} />
                </View>
              </View>
            );
          })}
        </ScrollView>
      </ApprovalShell>
      {biometricError && (
        <Text
          className="text-xs text-red-600 px-4 mt-2"
          accessibilityLabel="biometric-error"
        >
          {biometricError}
        </Text>
      )}
      <PrimaryActions
        approveLabel={pending ? "Authenticating…" : "Confirm batch"}
        onApprove={() => {
          void gatedApprove();
        }}
        onReject={() => onDecision({ id: intent.id, outcome: "reject" })}
        loading={pending}
      />
    </SheetModal>
  );
}
