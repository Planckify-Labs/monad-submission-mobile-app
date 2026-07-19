import {
  ChevronRight,
  CloudDownload,
  KeyRound,
  Plus,
  ShieldCheck,
} from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import { BaseModal, ModalHeader } from "@/components/common/BaseModal";
import { BACKUP_ERROR_COPY, BackupError } from "@/services/backup/errors";
import { hasRemoteBackupInteractive } from "@/services/backup/seedBackup";

interface AccountFoundSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Opens the Google Drive restore flow (grants Drive access if needed, then
   * asks for the backup passphrase). */
  onRestoreFromDrive: () => void;
  /** Opens the existing ImportSeedPhraseSheet. */
  onEnterRecoveryPhrase: () => void;
  /** After an honest "this can't be recovered" confirmation, mint a fresh
   * wallet. */
  onCreateNewInstead: () => void;
  emailMasked?: string;
}

/**
 * Shown after a successful OTP when the server recognises this Google account
 * as having a wallet, but nothing was auto-restored locally.
 *
 * Two views:
 *   1. **Located** — the happy path. The account has a wallet, so we lead with
 *      the one action that gets it back seamlessly: **Restore from Google
 *      Drive** (requests Drive access, then the passphrase). No recovery-phrase
 *      button here — offering it alongside would just muddy the primary path.
 *   2. **No recovery info** — reached via the "I don't have my recovery phrase
 *      or backup" link. For the user who has neither: enter the seed phrase (if
 *      they wrote it down after all) or, as a true last resort, start fresh with
 *      a new wallet. Non-custodial means the existing wallet is otherwise
 *      unrecoverable — the create-new path confirms that plainly first.
 */
export default function AccountFoundSheet({
  visible,
  onClose,
  onRestoreFromDrive,
  onEnterRecoveryPhrase,
  onCreateNewInstead,
  emailMasked,
}: AccountFoundSheetProps) {
  const [showRecoveryOptions, setShowRecoveryOptions] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the Drive check ran and came back empty, so the recovery view can
  // explain *why* it's asking for the seed instead of silently switching.
  const [noBackupFound, setNoBackupFound] = useState(false);

  // Always reopen on the primary view.
  useEffect(() => {
    if (!visible) {
      setShowRecoveryOptions(false);
      setChecking(false);
      setError(null);
      setNoBackupFound(false);
    }
  }, [visible]);

  /**
   * Confirm a backup file actually exists (requesting Drive access if needed)
   * BEFORE handing off to the passphrase prompt — otherwise the user types a
   * passphrase only to be told there's no backup. No backup → drop straight to
   * the recovery options.
   */
  const handleRestorePress = useCallback(async () => {
    if (checking) return;
    setError(null);
    setChecking(true);
    try {
      const exists = await hasRemoteBackupInteractive();
      setChecking(false);
      if (exists) {
        onRestoreFromDrive();
      } else {
        setNoBackupFound(true);
        setShowRecoveryOptions(true);
      }
    } catch (err) {
      setChecking(false);
      setError(
        err instanceof BackupError
          ? BACKUP_ERROR_COPY[err.code]
          : BACKUP_ERROR_COPY.unknown,
      );
    }
  }, [checking, onRestoreFromDrive]);

  return (
    <BaseModal
      visible={visible}
      onClose={onClose}
      height="auto"
      contentClassName="px-5"
    >
      <ModalHeader title="Account found" />

      <View className="pb-2">
        {showRecoveryOptions ? (
          <>
            <View className="items-center mb-6">
              <View className="w-16 h-16 bg-light-primary-red/10 rounded-full items-center justify-center mb-4">
                <ShieldCheck color="#c71c4b" size={28} />
              </View>
              <Text className="text-light-matte-black text-lg font-bold mb-2">
                {noBackupFound
                  ? "No Google Drive backup"
                  : "No recovery phrase or backup?"}
              </Text>
              <Text className="text-light-matte-black/70 text-center text-sm leading-5 max-w-80">
                {noBackupFound
                  ? "We couldn't find a backup for this account on Google Drive. Enter your recovery phrase if you wrote it down, or start fresh."
                  : "Enter your recovery phrase if you wrote it down. Otherwise you can start fresh. Your existing wallet can't be recovered without it."}
              </Text>
            </View>

            <TouchableOpacity
              activeOpacity={0.7}
              className="bg-light-primary-red py-4 px-5 rounded-xl flex-row items-center justify-between mb-3"
              onPress={onEnterRecoveryPhrase}
            >
              <View className="flex-row items-center flex-1">
                <View className="w-11 h-11 bg-light/20 rounded-full items-center justify-center mr-3">
                  <ShieldCheck color="#ffffff" size={20} />
                </View>
                <View className="flex-1">
                  <Text className="text-light font-semibold">
                    Enter recovery phrase
                  </Text>
                  <Text className="text-light/70 text-xs">
                    12 or 24 words, restores every chain
                  </Text>
                </View>
              </View>
              <ChevronRight color="#ffffff" size={18} />
            </TouchableOpacity>

            <TouchableOpacity
              activeOpacity={0.7}
              className="bg-light border border-light-matte-black/10 py-4 px-5 rounded-xl flex-row items-center justify-between"
              onPress={onCreateNewInstead}
            >
              <View className="flex-row items-center flex-1">
                <View className="w-11 h-11 bg-light-primary-red/10 rounded-full items-center justify-center mr-3">
                  <Plus color="#c71c4b" size={20} />
                </View>
                <View className="flex-1">
                  <Text className="text-light-matte-black font-semibold">
                    Create a new wallet
                  </Text>
                  <Text className="text-light-matte-black/50 text-xs">
                    Start fresh, begins empty
                  </Text>
                </View>
              </View>
              <ChevronRight color="#20222c" size={18} />
            </TouchableOpacity>

            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => setShowRecoveryOptions(false)}
              className="mt-5 self-center"
              hitSlop={8}
            >
              <Text className="text-light-matte-black/50 text-xs underline">
                Back
              </Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <View className="items-center mb-6">
              <View className="w-16 h-16 bg-light-primary-red/10 rounded-full items-center justify-center mb-4">
                <KeyRound color="#c71c4b" size={28} />
              </View>
              <Text className="text-light-matte-black text-lg font-bold mb-2">
                We located your wallet
              </Text>
              <Text className="text-light-matte-black/70 text-center text-sm leading-5 max-w-80">
                {emailMasked
                  ? `${emailMasked} already has a wallet. `
                  : "This account already has a wallet. "}
                Restore it from your encrypted Google Drive backup.
              </Text>
            </View>

            <TouchableOpacity
              activeOpacity={0.7}
              className="bg-light-primary-red py-4 px-5 rounded-xl flex-row items-center justify-between"
              onPress={handleRestorePress}
              disabled={checking}
            >
              <View className="flex-row items-center flex-1">
                <View className="w-11 h-11 bg-light/20 rounded-full items-center justify-center mr-3">
                  {checking ? (
                    <ActivityIndicator size="small" color="#ffffff" />
                  ) : (
                    <CloudDownload color="#ffffff" size={20} />
                  )}
                </View>
                <View className="flex-1">
                  <Text className="text-light font-semibold">
                    {checking
                      ? "Checking your Drive…"
                      : "Restore from Google Drive"}
                  </Text>
                  <Text className="text-light/70 text-xs">
                    Uses your backup passphrase
                  </Text>
                </View>
              </View>
              <ChevronRight color="#ffffff" size={18} />
            </TouchableOpacity>

            {error ? (
              <Text className="text-light-primary-red text-sm text-center mt-3">
                {error}
              </Text>
            ) : (
              <Text className="text-light-matte-black/40 text-xs text-center mt-5 max-w-80 self-center">
                Only your backup passphrase can open it. TakumiPay can&apos;t
                see it or restore it for you.
              </Text>
            )}

            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => setShowRecoveryOptions(true)}
              className="mt-4 self-center"
              hitSlop={8}
            >
              <Text className="text-light-matte-black/50 text-xs underline">
                I don&apos;t have my recovery phrase or backup
              </Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </BaseModal>
  );
}
