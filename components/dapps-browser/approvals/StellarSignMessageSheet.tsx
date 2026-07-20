import * as Clipboard from "expo-clipboard";
import React, { useCallback, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import type {
  ApprovalDecision,
  ApprovalIntent,
} from "@/services/bridge/approval";
import type { StellarSignMessagePayload } from "@/services/chains/stellar/payloads";
import { useScreenshotGuard } from "@/services/security/screenshotGuard";
import type { ComputeSigningDigestArgs } from "@/services/walletKit/types";
import { ApprovalShell } from "./ApprovalShell";
import { ClearSigningSection } from "./ClearSigningSection";
import { PrimaryActions, SheetModal } from "./SheetModal";
import { useBiometricApproval } from "./useBiometricApproval";

/** btoa-based utf8 → base64 (no ambient Buffer — Hermes-safe). */
function utf8ToBase64(text: string): string | null {
  try {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  } catch {
    return null;
  }
}

interface Props {
  intent: ApprovalIntent<StellarSignMessagePayload>;
  onDecision: (d: ApprovalDecision) => void;
}

export function StellarSignMessageSheet({
  intent,
  onDecision,
}: Props): React.ReactElement {
  useScreenshotGuard();
  const p = intent.payload;

  // Task 65 — SEP-43 message signing has no network-defined digest, so
  // the Stellar kit currently answers null and the block stays hidden.
  // Wired anyway: if a SEP ever defines one, only the kit changes.
  const digestArgs = useMemo<ComputeSigningDigestArgs | null>(() => {
    const messageBase64 = utf8ToBase64(p.message);
    return messageBase64 ? { kind: "personalMessage", messageBase64 } : null;
  }, [p.message]);

  const copyMessage = async (): Promise<void> => {
    await Clipboard.setStringAsync(p.message);
  };

  const approve = useCallback(
    () => onDecision({ id: intent.id, outcome: "approve" }),
    [intent.id, onDecision],
  );
  const { gatedApprove, pending, error } = useBiometricApproval(
    "Sign message",
    approve,
  );

  return (
    <SheetModal
      onDismiss={() => onDecision({ id: intent.id, outcome: "reject" })}
    >
      <ApprovalShell intent={intent} title="Sign Stellar message">
        <ScrollView className="flex-1">
          {/* SEP-0043's `signMessage` is an arbitrary UTF-8 string, not a
              base64-wrapped blob — no display/decode ambiguity the way
              Sui's `signPersonalMessage` has. No structured SIWx parse
              in v1 (§16) — the plain string is always shown as-is. */}
          <View className="bg-gray-50 rounded-xl p-3 mb-2">
            <Text className="text-xs text-gray-500 mb-1">Message</Text>
            <Text className="text-sm text-gray-900" selectable>
              {p.message}
            </Text>
          </View>

          <ClearSigningSection intent={intent} digestArgs={digestArgs} />

          <Text
            className="text-xs text-violet-700 self-start"
            onPress={() => {
              void copyMessage();
            }}
          >
            Copy message
          </Text>
          {error && <Text className="text-xs text-red-600 mt-2">{error}</Text>}
        </ScrollView>
      </ApprovalShell>
      <PrimaryActions
        approveLabel={pending ? "Authenticating…" : "Approve"}
        onApprove={() => {
          void gatedApprove();
        }}
        onReject={() => onDecision({ id: intent.id, outcome: "reject" })}
        loading={pending}
      />
    </SheetModal>
  );
}
