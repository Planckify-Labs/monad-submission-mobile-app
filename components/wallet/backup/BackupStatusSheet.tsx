import {
  CheckCircle2,
  ChevronRight,
  RefreshCw,
  Trash2,
} from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import { BaseModal, ModalHeader } from "@/components/common/BaseModal";
import { track } from "@/services/analytics/posthog";
import { BACKUP_ERROR_COPY, BackupError } from "@/services/backup/errors";
import { removeBackup } from "@/services/backup/seedBackup";
import { authenticateUser } from "@/utils/authUtils";

interface BackupStatusSheetProps {
  visible: boolean;
  onClose: () => void;
  lastBackupAt: number | null;
  walletAddress: string;
  /** Owning Google account — remove targets its Drive, not the active session's. */
  ownerEmail?: string;
  /** Auth passed → open the passphrase form to re-encrypt & replace. */
  onChangePassphrase: () => void;
  /** Backup deleted from Drive → parent refreshes the row. */
  onRemoved: () => void;
}

function relativeBackup(at: number): string {
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/**
 * Shown when the active wallet already has a Drive backup. Instead of dropping
 * the user straight back into the passphrase form (which reads like "start
 * over"), this surfaces the status and the two things they can actually do:
 * rotate the passphrase, or delete the backup.
 *
 * Both actions are gated by device auth (biometric / passcode) — the same gate
 * that guards revealing wallet info — because either one alters the recovery
 * material for this wallet. Remove additionally routes through an in-sheet
 * "are you sure?" confirm before the auth prompt: it's reversible (you can
 * re-back-up), but it's still a delete, so it shouldn't fire on a single tap.
 */
export default function BackupStatusSheet({
  visible,
  onClose,
  lastBackupAt,
  walletAddress,
  ownerEmail,
  onChangePassphrase,
  onRemoved,
}: BackupStatusSheetProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Second step for the delete: the status view's "Remove backup" only opens
  // this confirm; the actual auth + delete run from the confirm's own button.
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  // Reopen clean — never land back on the confirm step or a stale error.
  useEffect(() => {
    if (!visible) {
      setConfirmingRemove(false);
      setError(null);
    }
  }, [visible]);

  const handleChangePassphrase = useCallback(async () => {
    if (busy) return;
    setError(null);
    const ok = await authenticateUser(
      "Authenticate to change your backup passphrase",
    );
    if (!ok) return;
    onChangePassphrase();
  }, [busy, onChangePassphrase]);

  const handleRemovePress = useCallback(() => {
    setError(null);
    setConfirmingRemove(true);
  }, []);

  const handleCancelRemove = useCallback(() => {
    if (busy) return;
    setConfirmingRemove(false);
  }, [busy]);

  const handleConfirmRemove = useCallback(async () => {
    if (busy) return;
    setError(null);
    const ok = await authenticateUser(
      "Authenticate to remove your Google Drive backup",
    );
    if (!ok) return;

    setBusy(true);
    try {
      await removeBackup(walletAddress, ownerEmail);
      track("wallet_backup_removed");
      onRemoved();
      onClose();
    } catch (err) {
      if (__DEV__) console.warn("remove backup failed", err);
      track("wallet_backup_failed", {
        stage: "remove",
        reason: err instanceof BackupError ? err.code : "unknown",
      });
      setError(
        err instanceof BackupError
          ? BACKUP_ERROR_COPY[err.code]
          : BACKUP_ERROR_COPY.unknown,
      );
    } finally {
      setBusy(false);
    }
  }, [busy, walletAddress, ownerEmail, onRemoved, onClose]);

  return (
    <BaseModal
      visible={visible}
      onClose={onClose}
      closeButtonDisabled={busy}
      height="auto"
      contentClassName="px-5"
    >
      <ModalHeader title="Google Drive Backup" />

      <View className="pb-2">
        {confirmingRemove ? (
          <>
            <View className="items-center mb-6">
              <View className="w-16 h-16 rounded-full bg-light-primary-red/10 items-center justify-center mb-4">
                <Trash2 color="#c71c4b" size={28} />
              </View>
              <Text className="text-light-matte-black text-lg font-bold mb-1">
                Remove this backup?
              </Text>
              <Text className="text-light-matte-black/70 text-center text-sm leading-5 max-w-80">
                Your encrypted backup will be deleted from Google Drive. This
                wallet stays on this device. You can back it up again anytime.
              </Text>
            </View>

            <TouchableOpacity
              activeOpacity={0.7}
              onPress={handleConfirmRemove}
              disabled={busy}
              className="bg-light-primary-red py-4 px-5 rounded-xl flex-row items-center justify-center mb-3"
            >
              {busy ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <>
                  <Trash2 color="#ffffff" size={18} />
                  <Text className="text-light font-semibold ml-2">
                    Remove backup
                  </Text>
                </>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              activeOpacity={0.7}
              onPress={handleCancelRemove}
              disabled={busy}
              className="bg-light border border-light-matte-black/10 py-4 px-5 rounded-xl items-center justify-center"
            >
              <Text className="text-light-matte-black font-semibold">
                Keep backup
              </Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <View className="items-center mb-6">
              <View className="w-16 h-16 rounded-full bg-emerald-500/10 items-center justify-center mb-4">
                <CheckCircle2 color="#059669" size={30} />
              </View>
              <Text className="text-light-matte-black text-lg font-bold mb-1">
                {lastBackupAt
                  ? `Backed up ${relativeBackup(lastBackupAt)}`
                  : "Backed up"}
              </Text>
              <Text className="text-light-matte-black/70 text-center text-sm leading-5 max-w-80">
                Your encrypted seed phrase is stored in your Google Drive. Only
                your passphrase can open it.
              </Text>
            </View>

            <TouchableOpacity
              activeOpacity={0.7}
              onPress={handleChangePassphrase}
              disabled={busy}
              className="bg-light border border-light-matte-black/10 py-4 px-5 rounded-xl flex-row items-center justify-between mb-3"
            >
              <View className="flex-row items-center flex-1">
                <View className="w-11 h-11 bg-light-primary-red/10 rounded-full items-center justify-center mr-3">
                  <RefreshCw color="#c71c4b" size={18} />
                </View>
                <View className="flex-1">
                  <Text className="text-light-matte-black font-semibold">
                    Change passphrase
                  </Text>
                  <Text className="text-light-matte-black/50 text-xs">
                    Re-encrypt and replace your backup
                  </Text>
                </View>
              </View>
              <ChevronRight color="#20222c" size={18} />
            </TouchableOpacity>

            <TouchableOpacity
              activeOpacity={0.7}
              onPress={handleRemovePress}
              disabled={busy}
              className="bg-light border border-light-primary-red/20 py-4 px-5 rounded-xl flex-row items-center justify-between"
            >
              <View className="flex-row items-center flex-1">
                <View className="w-11 h-11 bg-light-primary-red/10 rounded-full items-center justify-center mr-3">
                  <Trash2 color="#c71c4b" size={18} />
                </View>
                <View className="flex-1">
                  <Text className="text-light-primary-red font-semibold">
                    Remove backup
                  </Text>
                  <Text className="text-light-matte-black/50 text-xs">
                    Delete it from your Google Drive
                  </Text>
                </View>
              </View>
              <ChevronRight color="#c71c4b" size={18} />
            </TouchableOpacity>

            <Text className="text-light-matte-black/40 text-xs text-center mt-5 max-w-80 self-center">
              Removing the backup won&apos;t touch this wallet. You can always
              back it up again.
            </Text>
          </>
        )}

        {error ? (
          <Text className="text-light-primary-red text-sm text-center mt-4">
            {error}
          </Text>
        ) : null}
      </View>
    </BaseModal>
  );
}
