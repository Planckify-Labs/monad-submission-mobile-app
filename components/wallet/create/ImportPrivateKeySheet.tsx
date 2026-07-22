/**
 * `ImportPrivateKeySheet` — three-step, single-chain private-key import.
 *
 * Spec reference: `docs/solana-chain-support-spec.md` §14.6.
 * Task: `docs/solana-chain-support-task/25_import_private_key_sheet_*.md`.
 *
 * Flow:
 *   1. Pick chain — `NamespacePicker` (single-select), filtered to kits
 *      that advertise `supportsPrivateKeyImport !== false`. If the user
 *      has already pasted once and stepped back, `inferNamespaceFromKey`
 *      PRE-HIGHLIGHTS the inferred card — the user still taps (soft
 *      hint, not auto-select — a 64-hex string is ambiguous).
 *   2. Paste key — single-line `TextInput` with a chain-specific
 *      placeholder and error copy. Live validation via
 *      `walletKitRegistry.get(namespace).validatePrivateKey(...)`.
 *   3. Name & confirm — optional `name` field. Confirm calls
 *      `kit.createWalletFromPrivateKey({ privateKey, name })`, then
 *      `addWallet(params)` on success — where the params shape matches
 *      the existing `TWalletCreationParams` contract (EVM passes
 *      `"PrivateKey"`; Solana passes `"SolanaPrivateKey"`). We route
 *      through params rather than feeding a pre-built `TWallet` because
 *      `useWallet.addWallet` is the canonical dedup / persistence entry
 *      point (Task 23 will add a batch variant; we stay on the singular
 *      path).
 *
 * Rules (non-negotiable, spec §14.6):
 *   - No cross-chain derivation. EVM hex → only `eip155`; Solana base58
 *     → only `solana`. The kit validators enforce; the UI never exposes
 *     an "import on both chains" toggle.
 *   - User-confirmed pick. Inference pre-highlights, never auto-selects.
 *   - TWV-2026-057 dwell discipline. The raw key is held only during
 *     the synchronous `kit.createWalletFromPrivateKey` + `addWallet`
 *     call chain; the local paste state is cleared on success / dismiss.
 *   - Trim + optional `0x` strip on EVM; no silent re-encoding elsewhere.
 */

import { ArrowLeft } from "lucide-react-native";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { BaseModal } from "@/components/common/BaseModal";
import LoadinngSpinnerPopup from "@/components/common/LoadinngSpinnerPopup";
import type { TWallet } from "@/constants/types/walletTypes";
import { useWallet } from "@/hooks/useWallet";
import type { Namespace } from "@/services/chains/types";
import { walletKitRegistry } from "@/services/walletKit/registry";
import {
  buildAddWalletParams,
  computeValidationState,
  normalizePrivateKeyInput,
} from "./ImportPrivateKeySheet.helpers";
import { inferNamespaceFromKey } from "./inferNamespaceFromKey";
import { NamespacePicker } from "./NamespacePicker";

const { height: SCREEN_HEIGHT } = Dimensions.get("window");
const SHEET_HEIGHT = SCREEN_HEIGHT * 0.92;

// Deriving a wallet from a private key blocks the JS thread. A spinner rendered
// *inside* the sheet would freeze mid-frame, so we fully close the sheet FIRST,
// then show the shared loading popup and derive — the same handoff the
// create-wallet flow uses in `app/login.tsx`.
//
// The derivation is kicked off from BaseModal's `onClosed` callback (which
// fires exactly when the slide-out animation has completely finished) rather
// than a guessed timer, so the sheet is always fully gone before the spinner
// appears. `SPINNER_PAINT_DELAY_MS` then gives the spinner a beat to paint
// before the blocking derivation freezes the thread.
const SPINNER_PAINT_DELAY_MS = 180; // let the spinner paint before deriving
const SUCCESS_HOLD_MS = 300; // hold "You're all set" briefly before closing
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

type Props = {
  visible: boolean;
  onClose: () => void;
  onWalletAdded: (wallet: TWallet) => void;
  /**
   * Wired by the parent `AddWalletSheet` (Task 22) so the footer link
   * can pivot to the seed-phrase sub-sheet. When omitted the footer
   * link hides entirely — we never render a dead link.
   */
  onImportSeedPhraseInstead?: () => void;
};

type Step = 1 | 2 | 3;

// Chain-specific copy. Kept inline rather than on `WalletKitAdapter`
// because this is UI wording (subject to product polish), not adapter
// behavior — and a future kit author shouldn't have to thread English
// strings through the port.
const PLACEHOLDER: Record<Namespace, string> = {
  eip155: "0x... (64 hex chars)",
  solana: "Base58 (88 chars, Phantom export format)",
  sui: "Sui private key",
  stellar: "Stellar secret key (S...)",
};

const INVALID_COPY: Record<Namespace, string> = {
  eip155: "This doesn't look like a 64-hex EVM private key.",
  solana:
    "This doesn't look like a Solana private key — expected 64-byte base58.",
  sui: "This doesn't look like a Sui private key.",
  stellar: "This doesn't look like a Stellar secret key.",
};

function ImportPrivateKeySheet({
  visible,
  onClose,
  onWalletAdded,
  onImportSeedPhraseInstead,
}: Props): React.ReactElement | null {
  // ── Step machine ──────────────────────────────────────────────────
  const [step, setStep] = useState<Step>(1);
  const [namespace, setNamespace] = useState<Namespace | null>(null);
  const [privateKey, setPrivateKey] = useState<string>("");
  const [name, setName] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  // Spinner visibility is decoupled from `submitting` so the sheet can finish
  // its close animation BEFORE the spinner appears (see `handleSheetClosed`).
  const [showSpinner, setShowSpinner] = useState<boolean>(false);
  // Message shown in the shared spinner popup while the sheet is hidden.
  const [loadingMessage, setLoadingMessage] = useState<string>("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { addWallet } = useWallet();

  // Focus target for step 2.
  const keyInputRef = useRef<TextInput>(null);

  // Import inputs captured on Confirm, consumed once the sheet has FULLY
  // closed. Deriving is deferred to BaseModal's `onClosed` so the sheet is
  // completely gone before the spinner + compute take over.
  const pendingImportRef = useRef<{
    namespace: Namespace;
    privateKey: string;
    name: string | undefined;
  } | null>(null);

  // Reset on open / close. Matches the discipline of holding the raw
  // key only for the lifetime of the sheet.
  useEffect(() => {
    if (!visible) {
      pendingImportRef.current = null;
      setStep(1);
      setNamespace(null);
      setPrivateKey("");
      setName("");
      setSubmitting(false);
      setShowSpinner(false);
      setLoadingMessage("");
      setSubmitError(null);
    }
  }, [visible]);

  useEffect(() => {
    if (visible && step === 2) {
      // Tiny deferred focus so the TextInput is mounted.
      const t = setTimeout(() => keyInputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [visible, step]);

  // Soft inference: if the user has already pasted and returns to step
  // 1, pre-highlight the card that matches the paste format. Inference
  // is advisory — the user still taps to confirm. Computed on every
  // render; cheap (regex only).
  const inferred = useMemo(
    () => (privateKey.trim() ? inferNamespaceFromKey(privateKey) : null),
    [privateKey],
  );

  const selectedForPicker: Namespace[] = useMemo(() => {
    if (namespace) return [namespace];
    if (inferred) return [inferred];
    return [];
  }, [namespace, inferred]);

  const handleNamespaceChange = useCallback((v: Namespace[]) => {
    setNamespace(v[0] ?? null);
  }, []);

  const proceedFromStep1 = useCallback(() => {
    if (!namespace) return;
    setStep(2);
  }, [namespace]);

  const validationState = useMemo(
    () => computeValidationState(privateKey, namespace),
    [privateKey, namespace],
  );

  const proceedFromStep2 = useCallback(() => {
    if (validationState !== "valid") return;
    setStep(3);
  }, [validationState]);

  const goBack = useCallback(() => {
    setSubmitError(null);
    if (step === 1) {
      onClose();
      return;
    }
    setStep((s) => (s === 3 ? 2 : 1) as Step);
  }, [step, onClose]);

  // The actual import. Runs ONLY after the sheet has fully closed (invoked
  // from `handleSheetClosed`), so the blocking derivation never fights the
  // slide-out animation for the JS thread.
  const runImport = useCallback(
    async (
      ns: Namespace,
      normalized: string,
      walletName: string | undefined,
    ) => {
      // Sheet is gone — reveal the spinner and let it paint before deriving.
      setLoadingMessage("Importing your wallet...");
      setShowSpinner(true);
      await sleep(SPINNER_PAINT_DELAY_MS);
      try {
        const kit = walletKitRegistry.get(ns);
        const built = await kit.createWalletFromPrivateKey({
          privateKey: normalized,
          name: walletName,
        });
        if (!built) {
          setSubmitError(
            "We couldn't import this key. Double-check that it matches the chain you picked.",
          );
          return;
        }
        // Route through `addWallet` so the singular dedup / persistence
        // path owns it. We pass params — the hook calls
        // `createWalletFromParams` internally; re-deriving from the same
        // normalized key yields the same address as `built.address`, so
        // there's no mismatch risk.
        const ok = await addWallet(
          buildAddWalletParams(ns, normalized, walletName),
        );
        if (!ok) {
          setSubmitError(
            "We couldn't import this wallet. It may already exist in your wallet list.",
          );
          return;
        }
        // Hand the just-built wallet to the parent. We don't read back
        // from `useWallet().wallets` because that array is stale inside
        // this closure — the query cache update from `addWallet` lands
        // on the next render. `built` has the same address as what the
        // hook persisted (both go through the same derivation), so it's
        // a faithful reference.
        onWalletAdded(built);
        // Hold the success message briefly, then drop local key state and close.
        setLoadingMessage("You're all set! 🎉");
        await sleep(SUCCESS_HOLD_MS);
        setPrivateKey("");
        setName("");
        onClose();
      } catch (e) {
        if (__DEV__) console.warn("ImportPrivateKeySheet: confirm failed", e);
        setSubmitError(
          "Something went wrong importing this wallet. Please try again.",
        );
      } finally {
        // On error this un-hides the sheet (with the error) and drops the
        // spinner; on success the parent has already closed us.
        setSubmitting(false);
        setShowSpinner(false);
      }
    },
    [addWallet, onWalletAdded, onClose],
  );

  const handleConfirm = useCallback(() => {
    if (!namespace || submitting) return;
    setSubmitError(null);
    // Capture the inputs now; the derivation itself is deferred until the
    // sheet has FULLY closed (see `handleSheetClosed`). We only close the
    // sheet here — no compute, no spinner yet.
    // TWV-2026-057 — raw key held only until `addWallet`; local state is
    // cleared on success / on unmount.
    pendingImportRef.current = {
      namespace,
      privateKey: normalizePrivateKeyInput(privateKey, namespace),
      name: name.trim() || undefined,
    };
    setLoadingMessage("Preparing import...");
    setSubmitting(true);
  }, [namespace, privateKey, name, submitting]);

  // Fired by BaseModal when the slide-out animation has completely finished.
  // If an import is pending, the sheet is now fully gone, so it's safe to show
  // the spinner and run the blocking derivation.
  const handleSheetClosed = useCallback(() => {
    const pending = pendingImportRef.current;
    pendingImportRef.current = null;
    if (pending) {
      void runImport(pending.namespace, pending.privateKey, pending.name);
    }
    // Otherwise it was an ordinary dismiss — reset is handled by the
    // `visible` effect above when the parent drops `visible`.
  }, [runImport]);

  const title =
    step === 1
      ? "Pick a chain"
      : step === 2
        ? "Paste private key"
        : "Name this wallet";

  return (
    <>
      <BaseModal
        // Gate `visible` off during import so the sheet slides fully out;
        // `onClosed` then fires the derivation once the animation is done.
        visible={visible && !submitting}
        onClose={onClose}
        onClosed={handleSheetClosed}
        height={SHEET_HEIGHT}
        enablePanToClose={!submitting}
        enableBackdropClose={!submitting}
        closeButtonDisabled={submitting}
      >
        {/* Header */}
        <View className="flex-row items-center justify-between px-4 pb-3">
          {step > 1 ? (
            <Pressable
              onPress={goBack}
              accessibilityRole="button"
              accessibilityLabel="Back"
              hitSlop={12}
              className="p-1"
            >
              <ArrowLeft size={24} color="#c71c4b" />
            </Pressable>
          ) : (
            <View className="w-8" />
          )}
          <Text className="text-light-matte-black font-semibold text-base">
            Step {step} of 3
          </Text>
          {/* Spacer balances the back button; BaseModal renders the close. */}
          <View className="w-8" />
        </View>

        <ScrollView
          className="flex-1 px-6"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 24 }}
        >
          <Text className="text-light-matte-black text-2xl font-bold mb-2">
            {title}
          </Text>

          {step === 1 ? (
            <Step1Body
              selected={selectedForPicker}
              onChange={handleNamespaceChange}
              inferredHint={!namespace && inferred !== null}
            />
          ) : null}

          {step === 2 && namespace ? (
            <Step2Body
              namespace={namespace}
              value={privateKey}
              onChangeText={setPrivateKey}
              validationState={validationState}
              inputRef={keyInputRef}
            />
          ) : null}

          {step === 3 && namespace ? (
            <Step3Body
              namespace={namespace}
              name={name}
              onChangeName={setName}
              submitError={submitError}
            />
          ) : null}
        </ScrollView>

        {/* Primary action */}
        <View className="px-6 pb-2">
          {step === 1 ? (
            <PrimaryButton
              label="Continue"
              disabled={!namespace}
              onPress={proceedFromStep1}
            />
          ) : null}
          {step === 2 ? (
            <PrimaryButton
              label="Continue"
              disabled={validationState !== "valid"}
              onPress={proceedFromStep2}
            />
          ) : null}
          {step === 3 ? (
            <PrimaryButton
              label={submitting ? "Importing..." : "Import wallet"}
              disabled={submitting}
              loading={submitting}
              onPress={handleConfirm}
            />
          ) : null}
        </View>

        {/* Footer — present on every step */}
        {onImportSeedPhraseInstead ? (
          <View className="px-6 pt-2">
            <Text className="text-light-matte-black/60 text-xs text-center mb-1">
              Wrong chain? A seed phrase imports all chains at once.
            </Text>
            <Pressable
              onPress={onImportSeedPhraseInstead}
              accessibilityRole="button"
              accessibilityLabel="Import seed phrase instead"
              hitSlop={8}
            >
              <Text className="text-light-primary-red text-sm font-semibold text-center">
                Import seed phrase instead
              </Text>
            </Pressable>
          </View>
        ) : null}
      </BaseModal>

      {/* Shared spinner — revealed only AFTER the sheet has fully closed, and
          stays up while the wallet derives. Lives outside BaseModal so it
          survives the slide-out. */}
      <LoadinngSpinnerPopup
        visible={showSpinner}
        title="Importing Wallet"
        message={loadingMessage}
      />
    </>
  );
}

// ── Step bodies ──────────────────────────────────────────────────────

type Step1Props = {
  selected: Namespace[];
  onChange: (v: Namespace[]) => void;
  inferredHint: boolean;
};

function Step1Body({ selected, onChange, inferredHint }: Step1Props) {
  return (
    <View>
      <Text className="text-light-matte-black/70 text-sm mb-4">
        Which chain does this private key belong to? One key, one chain — pick
        deliberately.
      </Text>
      {inferredHint ? (
        <View className="bg-light-primary-red/10 rounded-xl p-3 mb-3">
          <Text className="text-light-matte-black text-xs">
            We highlighted a likely match based on your paste — tap to confirm.
          </Text>
        </View>
      ) : null}
      <NamespacePicker
        mode="single"
        selected={selected}
        onChange={onChange}
        filter={(k) => k.supportsPrivateKeyImport !== false}
      />
    </View>
  );
}

type Step2Props = {
  namespace: Namespace;
  value: string;
  onChangeText: (s: string) => void;
  validationState: "empty" | "invalid" | "valid";
  inputRef: React.RefObject<TextInput | null>;
};

function Step2Body({
  namespace,
  value,
  onChangeText,
  validationState,
  inputRef,
}: Step2Props) {
  const chainDisplayName =
    walletKitRegistry.get(namespace).displayName ?? namespace;
  return (
    <View>
      <Text className="text-light-matte-black/70 text-sm mb-4">
        Paste the private key for your {chainDisplayName} wallet. Nothing leaves
        your device until you confirm in the next step.
      </Text>
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={onChangeText}
        placeholder={PLACEHOLDER[namespace]}
        placeholderTextColor="#00000066"
        autoCapitalize="none"
        autoCorrect={false}
        // Keep single-line per task spec. Hide characters so a shoulder
        // surfer doesn't get a peek — this field is sensitive.
        secureTextEntry
        spellCheck={false}
        className={`bg-light-main-container border rounded-xl px-4 py-3 text-light-matte-black ${
          validationState === "invalid"
            ? "border-light-primary-red"
            : "border-light-matte-black/10"
        }`}
      />
      {validationState === "invalid" ? (
        <Text className="text-light-primary-red text-xs mt-2">
          {INVALID_COPY[namespace]}
        </Text>
      ) : null}
      {validationState === "valid" ? (
        <Text className="text-light-matte-black/60 text-xs mt-2">
          Key looks good. Tap Continue to name and confirm.
        </Text>
      ) : null}
    </View>
  );
}

type Step3Props = {
  namespace: Namespace;
  name: string;
  onChangeName: (s: string) => void;
  submitError: string | null;
};

function Step3Body({ namespace, name, onChangeName, submitError }: Step3Props) {
  const chainDisplayName =
    walletKitRegistry.get(namespace).displayName ?? namespace;
  return (
    <View>
      <Text className="text-light-matte-black/70 text-sm mb-4">
        Give your {chainDisplayName} wallet a name. You can change this later.
      </Text>
      <TextInput
        value={name}
        onChangeText={onChangeName}
        placeholder="e.g. Trading wallet"
        placeholderTextColor="#00000066"
        maxLength={32}
        className="bg-light-main-container border border-light-matte-black/10 rounded-xl px-4 py-3 text-light-matte-black"
      />
      {submitError ? (
        <Text className="text-light-primary-red text-xs mt-3">
          {submitError}
        </Text>
      ) : null}
    </View>
  );
}

// ── Primary button ───────────────────────────────────────────────────

type PrimaryButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
};

function PrimaryButton({
  label,
  onPress,
  disabled,
  loading,
}: PrimaryButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      className={`py-4 rounded-full items-center flex-row justify-center ${
        disabled ? "bg-light-primary-red/50" : "bg-light-primary-red"
      }`}
    >
      {loading ? (
        <ActivityIndicator color="#ffffff" style={{ marginRight: 8 }} />
      ) : null}
      <Text className="text-light font-bold text-base">{label}</Text>
    </Pressable>
  );
}

export default ImportPrivateKeySheet;
export { ImportPrivateKeySheet };
export type { Props as ImportPrivateKeySheetProps };
