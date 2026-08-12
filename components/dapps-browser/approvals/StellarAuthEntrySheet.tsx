import React, { useCallback } from "react";
import { ScrollView, Text, View } from "react-native";
import type {
  ApprovalDecision,
  ApprovalIntent,
} from "@/services/bridge/approval";
import type { StellarSignAuthEntryPayload } from "@/services/chains/stellar/payloads";
import { originHost } from "@/services/permissions/caip";
import { useScreenshotGuard } from "@/services/security/screenshotGuard";
import { truncateAddress } from "@/utils/walletUtils";
import { ApprovalShell } from "./ApprovalShell";
import { PrimaryActions, SheetModal } from "./SheetModal";
import { useBiometricApproval } from "./useBiometricApproval";

// Hand-written per the user-facing-errors rule. An auth entry is an
// unfamiliar object to almost every user, so the sheet leads with what
// it does rather than what it is called.
const WHAT_THIS_IS =
  "This site is asking for permission to call a contract on your behalf. It is not a payment, and nothing moves right now.";
const SUB_INVOCATION_NOTE =
  "Approving the call below also approves the calls it makes in turn.";

interface Props {
  intent: ApprovalIntent<StellarSignAuthEntryPayload>;
  onDecision: (d: ApprovalDecision) => void;
}

export function StellarAuthEntrySheet({
  intent,
  onDecision,
}: Props): React.ReactElement {
  useScreenshotGuard();
  const p = intent.payload;
  const decoded = p.decoded;

  const approve = useCallback(
    () => onDecision({ id: intent.id, outcome: "approve" }),
    [intent.id, onDecision],
  );
  const { gatedApprove, pending, error } = useBiometricApproval(
    `Authorize contract call for ${originHost(intent.origin.url)}`,
    approve,
  );

  return (
    <SheetModal
      onDismiss={() => onDecision({ id: intent.id, outcome: "reject" })}
    >
      <ApprovalShell intent={intent} title="Authorize a contract call">
        <ScrollView className="flex-1">
          <View className="flex-row items-center mb-3">
            <View className="px-3 py-1 rounded-full bg-blue-50">
              <Text className="text-xs text-blue-700">Stellar</Text>
            </View>
            <Text className="ml-2 text-xs text-gray-600">
              {truncateAddress({ address: p.address })}
            </Text>
          </View>

          <View className="bg-gray-50 rounded-xl p-3 mb-3">
            <Text className="text-sm text-gray-800">{WHAT_THIS_IS}</Text>
          </View>

          {/*
            When the decode came back empty we say so rather than
            printing the raw XDR: a wall of base64 is not review, and
            presenting it as though it were invites a false sense of
            having checked.
          */}
          {decoded?.contractId || decoded?.function ? (
            <View className="bg-white border border-gray-200 rounded-xl p-3 mb-3">
              <Row k="Contract" v={decoded.contractId ?? "Could not be read"} />
              <Row k="Function" v={decoded.function ?? "Could not be read"} />
              {decoded.subInvocationCount !== undefined &&
                decoded.subInvocationCount > 0 && (
                  <>
                    <Row
                      k="Also allows"
                      v={`${decoded.subInvocationCount} further call${
                        decoded.subInvocationCount === 1 ? "" : "s"
                      }`}
                    />
                    <Text className="text-xs text-gray-600 mt-2">
                      {SUB_INVOCATION_NOTE}
                    </Text>
                  </>
                )}
              {decoded.expirationLedger !== undefined && (
                <Row
                  k="Expires at ledger"
                  v={String(decoded.expirationLedger)}
                />
              )}
            </View>
          ) : (
            <View className="bg-amber-50 border border-amber-300 rounded-xl p-3 mb-3">
              <Text className="text-xs font-semibold text-amber-900">
                We could not read this request
              </Text>
              <Text className="text-xs text-amber-800 mt-1">
                We cannot show you what this permission allows. Only continue if
                you trust this site completely.
              </Text>
            </View>
          )}
        </ScrollView>
      </ApprovalShell>
      {error && (
        <Text
          className="text-xs text-red-600 px-4 mt-2"
          accessibilityLabel="biometric-error"
        >
          {error}
        </Text>
      )}
      <PrimaryActions
        approveLabel={pending ? "Authenticating…" : "Authorize"}
        onApprove={() => void gatedApprove()}
        onReject={() => onDecision({ id: intent.id, outcome: "reject" })}
        loading={pending}
      />
    </SheetModal>
  );
}

function Row({ k, v }: { k: string; v: string }): React.ReactElement {
  return (
    <View className="flex-row mt-1">
      <Text className="text-xs text-gray-500 w-28">{k}</Text>
      <Text className="text-xs text-gray-900 flex-1" selectable>
        {v}
      </Text>
    </View>
  );
}
