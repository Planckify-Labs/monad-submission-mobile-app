import {
  CheckCircle2,
  CloudUpload,
  Eye,
  EyeOff,
  RefreshCw,
  ShieldAlert,
} from "lucide-react-native";
import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { BaseModal, ModalHeader } from "@/components/common/BaseModal";
import { track } from "@/services/analytics/posthog";
import { BACKUP_ERROR_COPY, BackupError } from "@/services/backup/errors";
import {
  checkPassphrase,
  MIN_PASSPHRASE_LENGTH,
  type TPassphraseStrength,
} from "@/services/backup/passphrasePolicy";
import { backupSeed } from "@/services/backup/seedBackup";
import { useScreenshotGuard } from "@/services/security/screenshotGuard";

const STRENGTH_LABEL: Record<TPassphraseStrength, string> = {
  weak: "Weak",
  fair: "Fair",
  strong: "Strong",
};

const STRENGTH_STYLE: Record<TPassphraseStrength, string> = {
  weak: "text-light-primary-red",
  fair: "text-amber-600",
  strong: "text-emerald-600",
};

interface BackupPassphraseSheetProps {
  visible: boolean;
  onClose: () => void;
  onBackedUp: () => void;
  /** Mnemonic to encrypt. Undefined for private-key wallets. */
  seedPhrase?: string;
  walletAddress: string;
  /** Signed-in Google address — used to reject a passphrase built from it. */
  email?: string;
  /** Timestamp of the last local backup, or null. Drives the "replaces your
   * existing backup" notice so a re-backup isn't silent. */
  lastBackupAt?: number | null;
}

function relativeBackup(at: number): string {
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/**
 * Collects a passphrase and uploads the encrypted seed to the user's Drive.
 *
 * The passphrase is never persisted, here or anywhere else. It exists as React
 * state for the life of this sheet and is dropped on close. An attacker who
 * takes over the Google account gets the ciphertext and can guess **offline**
 * with no rate limit, which is why `checkPassphrase` refuses anything short —
 * and why the app's 6-digit PIN is not reused for this.
 */
export default function BackupPassphraseSheet({
  visible,
  onClose,
  onBackedUp,
  seedPhrase,
  walletAddress,
  email,
  lastBackupAt,
}: BackupPassphraseSheetProps) {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reveal, setReveal] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The passphrase is as sensitive as the seed it protects.
  useScreenshotGuard(visible);

  const check = useMemo(
    () => checkPassphrase(passphrase, email),
    [passphrase, email],
  );

  const matches = passphrase.length > 0 && passphrase === confirm;
  const canSubmit =
    check.ok && matches && acknowledged && !busy && !!seedPhrase;

  const reset = useCallback(() => {
    setPassphrase("");
    setConfirm("");
    setReveal(false);
    setAcknowledged(false);
    setError(null);
    setDone(false);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const handleSubmit = useCallback(async () => {
    if (!seedPhrase || !canSubmit) return;
    setBusy(true);
    setError(null);

    try {
      // `email` is the wallet's owning Google account — backupSeed switches to
      // it so the seed lands in that account's Drive, not the active session's.
      await backupSeed(seedPhrase, passphrase, walletAddress, email);
      // Show the confirmation in-sheet; refresh the parent's "Backed up …" row
      // now, but let the user dismiss the success screen themselves.
      setDone(true);
      track("wallet_backup_completed", { is_update: !!lastBackupAt });
      onBackedUp();
    } catch (err) {
      track("wallet_backup_failed", {
        stage: lastBackupAt ? "update" : "create",
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
  }, [
    seedPhrase,
    canSubmit,
    passphrase,
    walletAddress,
    email,
    lastBackupAt,
    onBackedUp,
  ]);

  return (
    <BaseModal
      visible={visible}
      onClose={handleClose}
      closeButtonDisabled={busy}
      height="auto"
      contentClassName="px-5"
    >
      <ModalHeader title="Back up to Google Drive" />

      <View className="pb-2">
        {done ? (
          <View className="items-center py-4">
            <View className="w-16 h-16 rounded-full bg-emerald-500/10 items-center justify-center mb-4">
              <CheckCircle2 color="#059669" size={34} />
            </View>
            <Text className="text-light-matte-black text-xl font-bold mb-1">
              Wallet backed up
            </Text>
            <Text className="text-light-matte-black/70 text-center text-sm leading-5 max-w-80 mb-6">
              Your encrypted seed phrase is saved to your Google Drive. Only
              your passphrase can open it. Keep it somewhere safe.
            </Text>
            <TouchableOpacity
              activeOpacity={0.7}
              className="bg-light-primary-red py-4 rounded-xl items-center w-full"
              onPress={handleClose}
            >
              <Text className="text-light font-semibold">Done</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View className="items-center mb-5">
              <View className="w-16 h-16 bg-light-primary-red/10 rounded-full items-center justify-center mb-4">
                <CloudUpload color="#c71c4b" size={28} />
              </View>
              <Text className="text-light-matte-black/70 text-center text-sm leading-5 max-w-80">
                Your seed phrase is encrypted on this device before it&apos;s
                uploaded. Only this passphrase can open it, not TakumiPay, not
                Google.
              </Text>
            </View>

            {lastBackupAt ? (
              <View className="flex-row items-start bg-light-main-container rounded-2xl p-3 mb-4">
                <RefreshCw color="#7a7d8a" size={16} />
                <Text className="text-light-matte-black/70 text-xs leading-5 ml-2 flex-1">
                  Already backed up {relativeBackup(lastBackupAt)}. Backing up
                  again replaces it with this new passphrase.
                </Text>
              </View>
            ) : null}

            <View className="relative mb-3">
              <TextInput
                value={passphrase}
                onChangeText={(t) => {
                  setPassphrase(t);
                  if (error) setError(null);
                }}
                placeholder="Create a passphrase"
                placeholderTextColor="#9a9ca6"
                secureTextEntry={!reveal}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                autoComplete="off"
                editable={!busy}
                className="bg-light border border-light-matte-black/10 rounded-xl px-4 py-4 pr-12 text-light-matte-black"
              />
              <TouchableOpacity
                className="absolute right-4 top-4"
                onPress={() => setReveal((r) => !r)}
                hitSlop={8}
              >
                {reveal ? (
                  <EyeOff color="#7a7d8a" size={18} />
                ) : (
                  <Eye color="#7a7d8a" size={18} />
                )}
              </TouchableOpacity>
            </View>

            <TextInput
              value={confirm}
              onChangeText={setConfirm}
              placeholder="Confirm passphrase"
              placeholderTextColor="#9a9ca6"
              secureTextEntry={!reveal}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              autoComplete="off"
              editable={!busy}
              className="bg-light border border-light-matte-black/10 rounded-xl px-4 py-4 text-light-matte-black mb-2"
            />

            <View className="min-h-6 mb-3">
              {passphrase.length === 0 ? (
                <Text className="text-light-matte-black/40 text-xs">
                  At least {MIN_PASSPHRASE_LENGTH} characters. Longer is
                  stronger.
                </Text>
              ) : check.problem ? (
                <Text className="text-light-primary-red text-xs">
                  {check.problem}
                </Text>
              ) : confirm.length > 0 && !matches ? (
                <Text className="text-light-primary-red text-xs">
                  Passphrases don&apos;t match.
                </Text>
              ) : (
                <Text className={`text-xs ${STRENGTH_STYLE[check.strength]}`}>
                  Strength: {STRENGTH_LABEL[check.strength]}
                </Text>
              )}
            </View>

            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => setAcknowledged((a) => !a)}
              disabled={busy}
              className="flex-row items-start bg-light-primary-red/5 border border-light-primary-red/20 rounded-2xl p-4 mb-5"
            >
              <View
                className={`w-5 h-5 rounded-md border-2 items-center justify-center mt-0.5 ${
                  acknowledged
                    ? "bg-light-primary-red border-light-primary-red"
                    : "border-light-matte-black/30"
                }`}
              >
                {acknowledged && (
                  <Text className="text-light text-xs font-bold">✓</Text>
                )}
              </View>
              <Text className="text-light-matte-black/70 text-xs leading-5 ml-3 flex-1">
                I understand that if I forget this passphrase, nobody, including
                TakumiPay, can recover this backup, and my seed phrase remains
                the only other way back into my wallet.
              </Text>
            </TouchableOpacity>

            {error && (
              <View className="flex-row items-center mb-4">
                <ShieldAlert color="#c71c4b" size={16} />
                <Text className="text-light-primary-red text-sm ml-2 flex-1">
                  {error}
                </Text>
              </View>
            )}

            <TouchableOpacity
              activeOpacity={0.7}
              className={`py-4 rounded-xl items-center ${
                canSubmit ? "bg-light-primary-red" : "bg-light-matte-black/10"
              }`}
              onPress={handleSubmit}
              disabled={!canSubmit}
            >
              {busy ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <Text
                  className={`font-semibold ${
                    canSubmit ? "text-light" : "text-light-matte-black/40"
                  }`}
                >
                  Encrypt and back up
                </Text>
              )}
            </TouchableOpacity>
          </>
        )}
      </View>
    </BaseModal>
  );
}
