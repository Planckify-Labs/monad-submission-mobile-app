import * as Clipboard from "expo-clipboard";
import React, { useCallback, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import type {
  ApprovalDecision,
  ApprovalIntent,
} from "@/services/bridge/approval";
import { resolveStellarChainConfigForPassphrase } from "@/services/chains/stellar/horizonClient";
import type {
  StellarDecodedOperation,
  StellarSignTransactionPayload,
} from "@/services/chains/stellar/payloads";
import { useScreenshotGuard } from "@/services/security/screenshotGuard";
import { walletKitRegistry } from "@/services/walletKit/registry";
import { truncateAddress } from "@/utils/walletUtils";
import { ApprovalShell } from "./ApprovalShell";
import { PrimaryActions, SheetModal } from "./SheetModal";
import { useBiometricApproval } from "./useBiometricApproval";

interface Props {
  intent: ApprovalIntent<StellarSignTransactionPayload>;
  onDecision: (d: ApprovalDecision) => void;
}

function shortAddr(a: string): string {
  return truncateAddress({ address: a });
}

function assetLabel(asset: string): string {
  if (asset === "native") return "XLM";
  const [code] = asset.split(":");
  return code || asset;
}

function operationLabel(op: StellarDecodedOperation): string {
  switch (op.kind) {
    case "payment":
      return `Payment · ${op.amount} ${assetLabel(op.asset)}`;
    case "createAccount":
      return "Create account";
    case "changeTrust":
      return `Change trust · ${assetLabel(op.asset)}`;
    case "pathPaymentStrictSend":
      return "Path payment (strict send)";
    case "pathPaymentStrictReceive":
      return "Path payment (strict receive)";
    case "manageSellOffer":
      return "Manage sell offer";
    case "manageBuyOffer":
      return "Manage buy offer";
    case "accountMerge":
      return "Merge account";
    case "invokeHostFunction":
      return "Soroban contract invocation";
    case "other":
      return op.type;
  }
}

function operationDetail(op: StellarDecodedOperation): string {
  switch (op.kind) {
    case "payment":
      return `→ ${shortAddr(op.destination)}`;
    case "createAccount":
      return `→ ${shortAddr(op.destination)} · starting balance ${op.startingBalance}`;
    case "changeTrust":
      return `limit ${op.limit}`;
    case "pathPaymentStrictSend":
      return `${assetLabel(op.sendAsset)} → ${assetLabel(op.destAsset)}, to ${shortAddr(op.destination)}`;
    case "pathPaymentStrictReceive":
      return `${assetLabel(op.sendAsset)} → ${assetLabel(op.destAsset)}, to ${shortAddr(op.destination)}`;
    case "manageSellOffer":
      return `${assetLabel(op.selling)} → ${assetLabel(op.buying)}`;
    case "manageBuyOffer":
      return `${assetLabel(op.selling)} → ${assetLabel(op.buying)}`;
    case "accountMerge":
      return `→ ${shortAddr(op.destination)}`;
    case "invokeHostFunction":
      return "Cannot be decoded. Review carefully before signing.";
    case "other":
      return "Unrecognized operation type.";
  }
}

function formatFee(
  fee: string | undefined,
  networkPassphrase: string,
): string | null {
  if (!fee) return null;
  if (!walletKitRegistry.has("stellar")) return null;
  try {
    const kit = walletKitRegistry.get("stellar");
    const chain = resolveStellarChainConfigForPassphrase(networkPassphrase);
    return kit.formatNativeAmount(BigInt(fee), chain);
  } catch {
    return null;
  }
}

function memoLabel(memo: StellarSignTransactionPayload["memo"]): string | null {
  if (!memo || memo.type === "none") return null;
  return `Memo (${memo.type}): ${memo.value ?? ""}`;
}

export function StellarTransactionSheet({
  intent,
  onDecision,
}: Props): React.ReactElement {
  useScreenshotGuard();
  const p = intent.payload;
  const decoded = p.decoded ?? [];

  const fee = useMemo(
    () => formatFee(p.fee, p.networkPassphrase),
    [p.fee, p.networkPassphrase],
  );
  const memo = useMemo(() => memoLabel(p.memo), [p.memo]);

  const approve = useCallback(
    () => onDecision({ id: intent.id, outcome: "approve" }),
    [intent.id, onDecision],
  );
  const { gatedApprove, pending, error } = useBiometricApproval(
    "Sign transaction",
    approve,
  );

  const copyXdr = async (): Promise<void> => {
    await Clipboard.setStringAsync(p.xdr);
  };

  return (
    <SheetModal
      onDismiss={() => onDecision({ id: intent.id, outcome: "reject" })}
    >
      <ApprovalShell intent={intent} title="Sign Stellar transaction">
        <ScrollView className="flex-1">
          <View className="flex-row items-center mb-3">
            <View className="px-3 py-1 rounded-full bg-blue-50">
              <Text className="text-xs text-blue-700">Stellar</Text>
            </View>
            <Text className="ml-2 text-xs text-gray-600">
              {shortAddr(p.address)}
            </Text>
          </View>

          {decoded.length > 0 ? (
            <View className="bg-gray-50 rounded-xl p-3 mb-3">
              <Text className="text-xs text-gray-500 mb-1">
                {decoded.length} operation{decoded.length === 1 ? "" : "s"}
              </Text>
              {decoded.map((op, i) => (
                <View key={i} className="py-1 border-t border-gray-100">
                  <Text className="text-sm text-gray-900">
                    {i + 1}. {operationLabel(op)}
                  </Text>
                  <Text className="text-xs text-gray-500" selectable>
                    {operationDetail(op)}
                  </Text>
                </View>
              ))}
            </View>
          ) : (
            <View className="bg-gray-50 rounded-xl p-3 mb-3">
              <Text className="text-xs text-gray-500">
                Decoder unavailable — review the raw XDR carefully.
              </Text>
              <Text
                className="text-xs font-mono text-gray-700 mt-2"
                selectable
                numberOfLines={3}
              >
                {p.xdr}
              </Text>
            </View>
          )}

          {(fee || memo) && (
            <View className="bg-gray-50 rounded-xl p-3 mb-3">
              {fee && <Text className="text-xs text-gray-600">Fee: {fee}</Text>}
              {memo && (
                <Text className="text-xs text-gray-600 mt-0.5" selectable>
                  {memo}
                </Text>
              )}
            </View>
          )}

          {p.submit === true && (
            <Text className="text-xs text-orange-700 mb-2">
              This dApp also asked to broadcast the transaction after signing.
            </Text>
          )}

          <Text
            className="text-xs text-violet-700 mb-2"
            onPress={() => {
              void copyXdr();
            }}
          >
            Copy transaction (XDR)
          </Text>
          {error && <Text className="text-xs text-red-600 mt-2">{error}</Text>}
        </ScrollView>
      </ApprovalShell>
      <PrimaryActions
        approveLabel={pending ? "Authenticating…" : "Sign"}
        onApprove={() => {
          void gatedApprove();
        }}
        onReject={() => onDecision({ id: intent.id, outcome: "reject" })}
        loading={pending}
      />
    </SheetModal>
  );
}
