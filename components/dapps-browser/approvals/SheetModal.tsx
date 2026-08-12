import React, { useEffect } from "react";
import { BackHandler, Modal, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQueueInputLock } from "@/services/bridge/useApprovalQueue";

interface Props {
  onDismiss: () => void;
  children: React.ReactNode;
}

/**
 * Shared modal chrome — full-screen slide-up sheet. Hardware back dismisses
 * (as reject, per spec §10.4 invariant 2).
 */
export function SheetModal({ onDismiss, children }: Props): React.ReactElement {
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onDismiss();
      return true;
    });
    return () => sub.remove();
  }, [onDismiss]);

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onDismiss}>
      <View className="flex-1 bg-black/40 justify-end">
        <SafeAreaView
          edges={["bottom"]}
          className="bg-light-main-container rounded-t-3xl h-[92%]"
        >
          {/*
            TWV-2026-064 — trusted-UI indicator via the drag handle. Native
            drawn above the WebView; the dApp page cannot replicate the
            sheet's native chrome (fullscreen WebView API is disabled in
            `injectedJavaScript` in `app/dapps-browser.tsx`).
          */}
          <View
            accessibilityLabel="TakumiPay trusted prompt"
            className="items-center py-3"
          >
            <View className="w-10 h-1 bg-light-matte-black/20 rounded-full" />
          </View>
          {children}
        </SafeAreaView>
      </View>
    </Modal>
  );
}

export function PrimaryActions({
  onApprove,
  onReject,
  approveLabel = "Approve",
  rejectLabel = "Reject",
  disabled,
  loading,
}: {
  onApprove: () => void;
  onReject: () => void;
  approveLabel?: string;
  rejectLabel?: string;
  disabled?: boolean;
  loading?: boolean;
}): React.ReactElement {
  // Phase Q — when this sheet appeared because the last one just went
  // away, approve stays inert for a moment. Reject does not: the escape
  // must never be the slower option, or the lock becomes an obstacle to
  // the safe choice. Applied here, in the shared action bar, so no sheet
  // has to opt in.
  const queueLocked = useQueueInputLock();
  const approveBlocked = disabled || loading || queueLocked;
  return (
    <View className="px-4 pt-3 pb-4">
      {queueLocked && (
        <Text className="text-xs text-gray-500 mb-2 text-center">
          Another request just closed. Take a moment to read this one.
        </Text>
      )}
      <View className="flex-row gap-3">
        <TouchableOpacity
          onPress={onReject}
          className="flex-1 py-4 rounded-2xl bg-light items-center"
          disabled={loading}
        >
          <Text className="text-light-matte-black font-bold">
            {rejectLabel}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onApprove}
          className={`flex-1 py-4 rounded-2xl items-center ${
            approveBlocked ? "bg-light-primary-red/40" : "bg-light-primary-red"
          }`}
          disabled={approveBlocked}
        >
          <Text className="text-white font-bold">
            {loading ? "…" : approveLabel}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
