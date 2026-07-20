import * as Clipboard from "expo-clipboard";
import React, { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import type {
  ApprovalDecision,
  ApprovalIntent,
} from "@/services/bridge/approval";
import type { SuiSignPersonalMessagePayload } from "@/services/chains/sui/payloads";
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
  intent: ApprovalIntent<SuiSignPersonalMessagePayload>;
  onDecision: (d: ApprovalDecision) => void;
}

function decodeBase64Utf8(b64: string): string | null {
  try {
    if (typeof atob === "function") {
      const bin = atob(b64);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return new TextDecoder("utf-8", { fatal: true } as any).decode(
          Uint8Array.from(bin, (c) => c.charCodeAt(0)),
        );
      } catch {
        return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function SuiSignPersonalMessageSheet({
  intent,
  onDecision,
}: Props): React.ReactElement {
  useScreenshotGuard();
  const [showRaw, setShowRaw] = useState(false);
  const p = intent.payload;

  const decodedUtf8 = useMemo(() => {
    if (p.display === "utf8") return p.message;
    return decodeBase64Utf8(p.message);
  }, [p.message, p.display]);

  // Task 65 — the PersonalMessage-intent digest: the exact preimage
  // hash the wallet signs, reproducible from the copied base64.
  const digestArgs = useMemo<ComputeSigningDigestArgs | null>(() => {
    const messageBase64 =
      p.display === "base64" ? p.message : utf8ToBase64(p.message);
    return messageBase64 ? { kind: "personalMessage", messageBase64 } : null;
  }, [p.message, p.display]);

  const copyBase64 = async (): Promise<void> => {
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
      <ApprovalShell intent={intent} title="Sign Sui message">
        <ScrollView className="flex-1">
          {p.display === "utf8" || decodedUtf8 ? (
            <View className="bg-gray-50 rounded-xl p-3 mb-2">
              <Text className="text-xs text-gray-500 mb-1">
                Human-readable message
              </Text>
              <Text className="text-sm text-gray-900" selectable>
                {p.display === "utf8" ? p.message : decodedUtf8}
              </Text>
            </View>
          ) : (
            <View className="bg-gray-50 rounded-xl p-3 mb-2">
              <Text className="text-xs text-gray-500 mb-1">
                Opaque payload (base64)
              </Text>
              <Text
                className="text-xs font-mono text-gray-700"
                selectable
                numberOfLines={showRaw ? undefined : 4}
              >
                {p.message}
              </Text>
              <TouchableOpacity
                onPress={() => setShowRaw((s) => !s)}
                className="mt-2"
              >
                <Text className="text-xs text-violet-700">
                  {showRaw ? "Hide raw" : "Show raw"}
                </Text>
              </TouchableOpacity>
            </View>
          )}

          <ClearSigningSection intent={intent} digestArgs={digestArgs} />

          <TouchableOpacity
            onPress={copyBase64}
            className="self-start px-3 py-1 rounded-lg border border-gray-200"
          >
            <Text className="text-xs text-gray-700">Copy base64</Text>
          </TouchableOpacity>
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
