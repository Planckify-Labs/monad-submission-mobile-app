/**
 * `GetWalletSheet` — "you don't hold a wallet on this chain, here's how to
 * get one", with the same options as the login screen and without leaving
 * the screen you're on.
 *
 * WHY IT EXISTS. The gap this closes is a private-key import covering
 * exactly ONE namespace, so a user can be fully set up and still have no
 * way to act on Sui. The previous CTA sent them to private-key import
 * pre-aimed at the missing chain, which is the WORST of the available
 * remedies: it fixes exactly one chain, and they hit the same wall again
 * the next time. So the options are ordered by what the user actually
 * needs, not by what the surface happens to know:
 *
 *   1. Continue with Google — signs in and mints or restores this
 *      account's wallet on every chain. Also the only option that
 *      survives losing the device.
 *   2. Create new wallet — `bootstrapFirstLoginWallets` mints one wallet
 *      per registered kit, so a fifth chain is covered the day it
 *      registers, with no edit here.
 *   3. Import seed phrase — derives every chain from a mnemonic.
 *   4. Import private key — demoted, and labelled honestly as covering
 *      only the one chain.
 *
 * The Google flow is the SAME code the login screen runs
 * (`useGoogleWalletAuth`), not a copy: the rules deciding whether to mint,
 * restore from Drive, or reuse an existing wallet are security-sensitive
 * and must not exist twice. The only thing this host does differently is
 * close instead of navigating home.
 *
 * Modal composition mirrors `AddWalletSheet`: render EITHER the picker OR
 * an active sub-sheet, never both, so the user never sees two stacked
 * backdrops for one decision.
 */

import { ChevronRight, KeyRound, Plus, ShieldCheck } from "lucide-react-native";
import type React from "react";
import { memo, useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  Text,
  View,
} from "react-native";
import { BaseModal, ModalHeader } from "@/components/common/BaseModal";
import LoadinngSpinnerPopup from "@/components/common/LoadinngSpinnerPopup";
import { missingWalletCopy } from "@/components/wallet/missingWalletCopy";
import type { TWallet } from "@/constants/types/walletTypes";
import { useGoogleWalletAuth } from "@/hooks/useGoogleWalletAuth";
import { useLoadingSteps } from "@/hooks/useLoadingSteps";
import { useWallet } from "@/hooks/useWallet";
import type { Namespace } from "@/services/chains/types";
import { bootstrapFirstLoginWallets } from "@/services/walletKit/bootstrap";
import { ImportPrivateKeySheet } from "./ImportPrivateKeySheet";
import { ImportSeedPhraseSheet } from "./ImportSeedPhraseSheet";

type Step = "picker" | "seed" | "pk";

export type GetWalletSheetProps = {
  visible: boolean;
  onClose: () => void;
  /**
   * The chain the user was trying to reach, when there is one. Drives the
   * explanation and pre-aims the private-key route. Omitted for a plain
   * "add a wallet" entry point, where the sheet reads as generic.
   */
  namespace?: Namespace;
  /** Fired after any route produces wallets. Hosts usually just close. */
  onWalletAdded?: (wallets: TWallet | TWallet[]) => void;
};

type OptionProps = {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onPress: () => void;
  disabled?: boolean;
  /** Visually subordinate: a partial fix, not the recommended one. */
  secondary?: boolean;
};

const Option: React.FC<OptionProps> = memo(function Option({
  icon,
  title,
  subtitle,
  onPress,
  disabled,
  secondary,
}: OptionProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={subtitle}
      accessibilityState={{ disabled: !!disabled }}
      className={`flex-row items-center rounded-2xl px-4 py-4 mb-3 ${
        secondary
          ? "bg-transparent border border-light-matte-black/10"
          : "bg-light"
      } ${disabled ? "opacity-60" : ""}`}
    >
      <View
        className={`w-11 h-11 rounded-full items-center justify-center mr-3 ${
          secondary ? "bg-light-matte-black/5" : "bg-light-primary-red/10"
        }`}
      >
        {icon}
      </View>
      <View className="flex-1 pr-2">
        <Text
          className={`font-bold text-base ${
            secondary ? "text-light-matte-black/70" : "text-light-matte-black"
          }`}
        >
          {title}
        </Text>
        <Text className="text-light-matte-black/60 text-sm mt-0.5">
          {subtitle}
        </Text>
      </View>
      <ChevronRight size={20} color="#20222c80" />
    </Pressable>
  );
});

function GetWalletSheetBase({
  visible,
  onClose,
  namespace,
  onWalletAdded,
}: GetWalletSheetProps) {
  const [step, setStep] = useState<Step>("picker");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const { addWallets } = useWallet();

  const {
    isLoading: spinnerVisible,
    currentMessage: spinnerMessage,
    completeStep,
    start: startSpinner,
    stop: stopSpinner,
    delay,
  } = useLoadingSteps([
    "Verifying your account...",
    "Setting up your wallet...",
    "Finishing up...",
    "You're all set! 🎉",
  ]);

  const finish = useCallback(
    (added?: TWallet | TWallet[]) => {
      // `useLoadingSteps.completeStep` does NOT clear `isLoading` — the login
      // screen never noticed because `router.replace("/")` unmounted the whole
      // spinner with it. A sheet stays mounted, so without this the "You're
      // all set" popup would sit on top of the app after we close.
      stopSpinner();
      if (added) onWalletAdded?.(added);
      setStep("picker");
      onClose();
    },
    [onWalletAdded, onClose, stopSpinner],
  );

  // Same flow as the login screen, different tail: no `router.replace("/")`,
  // because the user is mid-task somewhere and must land back where they were.
  const google = useGoogleWalletAuth({
    onStep: completeStep,
    onStart: startSpinner,
    onStop: stopSpinner,
    delay,
    onComplete: () => finish(),
    onRequestSeedPhrase: () => setStep("seed"),
    onError: (title, message) => Alert.alert(title, message),
  });

  const handleCreate = useCallback(async () => {
    if (creating) return;
    setCreateError(null);
    setCreating(true);
    try {
      // One wallet per registered kit, so this covers the missing chain
      // AND every other one at the same time.
      const minted = await bootstrapFirstLoginWallets();
      if (minted.length === 0) {
        setCreateError("Could not create a wallet, please try again.");
        return;
      }
      await addWallets(minted);
      finish(minted);
    } catch {
      setCreateError("Could not create a wallet, please try again.");
    } finally {
      setCreating(false);
    }
  }, [creating, addWallets, finish]);

  const handleSeedAdded = useCallback(
    (added: TWallet[]) => {
      // No-op unless this import was the Google recovery path.
      google.completeSeedPhraseRecovery(added);
      finish(added);
    },
    [google, finish],
  );

  const backToPicker = useCallback(() => {
    google.cancelSeedPhraseRecovery();
    setStep("picker");
  }, [google]);

  // One modal at a time (see file header).
  if (step === "seed") {
    return (
      <>
        <ImportSeedPhraseSheet
          visible={visible}
          onClose={backToPicker}
          onWalletsAdded={handleSeedAdded}
          tagSocial={google.seedRecoveryAccount}
        />
        {google.sheets}
        <LoadinngSpinnerPopup
          visible={spinnerVisible}
          title="Setting Up"
          message={spinnerMessage}
        />
      </>
    );
  }

  if (step === "pk") {
    return (
      <>
        <ImportPrivateKeySheet
          visible={visible}
          onClose={backToPicker}
          onWalletAdded={(w) => finish(w)}
          onImportSeedPhraseInstead={() => setStep("seed")}
          initialNamespace={namespace}
        />
        {google.sheets}
      </>
    );
  }

  const chainName = namespace ? missingWalletCopy(namespace).chainName : null;

  return (
    <>
      <BaseModal
        visible={visible}
        onClose={() => finish()}
        height="72%"
        contentClassName="px-4"
      >
        <ModalHeader
          title={chainName ? `Get a ${chainName} wallet` : "Add wallet"}
        />

        <View className="px-1 pb-4">
          <Text className="text-light-matte-black/70 text-sm">
            {chainName
              ? `Your current wallet can't be used on ${chainName}. A wallet from a private key only works on the one chain it came from, so you'll need a wallet that covers ${chainName}.`
              : "Add a wallet to this device."}
          </Text>
        </View>

        <View>
          <Option
            icon={
              google.isStarting ? (
                <ActivityIndicator size="small" color="#c71c4b" />
              ) : (
                // Same mark the login screen uses, so the option reads as
                // the same thing the user may already have signed in with.
                <Image
                  source={require("@/assets/images/google-takumipay.png")}
                  style={{ width: 22, height: 22 }}
                  resizeMode="contain"
                />
              )
            }
            title="Continue with Google"
            subtitle={
              chainName
                ? `Sets up a wallet on ${chainName} and every other chain`
                : "Sets up a wallet on every supported chain"
            }
            onPress={google.start}
            disabled={google.isStarting || creating}
          />
          <Option
            icon={
              creating ? (
                <ActivityIndicator size="small" color="#c71c4b" />
              ) : (
                <Plus size={22} color="#c71c4b" />
              )
            }
            title={creating ? "Creating wallet…" : "Create new wallet"}
            subtitle={
              chainName
                ? `Generates a new wallet on ${chainName} and every other chain`
                : "Generates a wallet on every supported chain"
            }
            onPress={handleCreate}
            disabled={creating || google.isStarting}
          />
          {createError ? (
            <Text className="text-light-primary-red text-xs mb-2 px-1">
              {createError}
            </Text>
          ) : null}
          <Option
            icon={<ShieldCheck size={22} color="#c71c4b" />}
            title="Import seed phrase"
            subtitle="12 or 24 words, restores every chain"
            onPress={() => setStep("seed")}
            disabled={creating || google.isStarting}
          />
          <Option
            secondary
            icon={<KeyRound size={20} color="#20222c80" />}
            title="Import private key"
            subtitle={
              chainName
                ? `${chainName} only, won't cover other chains`
                : "One chain, one key"
            }
            onPress={() => setStep("pk")}
            disabled={creating || google.isStarting}
          />
        </View>
      </BaseModal>

      {/* Google's OTP / Drive-restore / Account-found sheets. Siblings of the
          picker so they stack above it rather than being unmounted with it. */}
      {google.sheets}

      <LoadinngSpinnerPopup
        visible={spinnerVisible}
        title="Setting Up"
        message={spinnerMessage}
      />
    </>
  );
}

const GetWalletSheet = memo(GetWalletSheetBase);

export default GetWalletSheet;
export { GetWalletSheet };
