/**
 * `AddWalletSheet` — top-level wallet-management entry point (spec
 * §14.5 / §14.8). Renders a three-card picker; each card swaps in the
 * matching sub-sheet (create / import seed / import pk).
 *
 * Call sites (wired by Task 26, not here):
 *   - `wallet.tsx` "+" header button
 *   - `wallet.tsx` empty-state CTA
 *   - `WalletSwitcherModal.onAddWallet`
 *
 * Modal composition — one modal at a time:
 *   The sub-sheets (`CreateWalletSheet`, `ImportSeedPhraseSheet`,
 *   `ImportPrivateKeySheet`) each render their own `react-native`
 *   `Modal`. To avoid a double-modal overlay (parent picker modal +
 *   child sub-sheet modal stacked with duplicated chrome), this
 *   component renders EITHER the picker modal OR the active sub-sheet
 *   — never both. The step state picks which one is mounted.
 *
 * State reset rules (spec §14.5, non-negotiable):
 *   - `handleClose` always resets `step` to `"picker"` so closing
 *     wipes flow progress.
 *   - A `visible` hidden → visible transition also resets to
 *     `"picker"` so re-opening never lands mid-flow (defence in depth
 *     for cases where the parent forgets to reset between opens).
 *   - Each sub-sheet's `onClose` returns to the picker rather than
 *     closing the whole sheet — the back chevron feels like a sub-flow
 *     rewind, not an exit.
 *
 * Shell: the shared `BaseModal` bottom sheet (`components/common/modal`),
 * which owns the slide/backdrop/drag + the standardized close button.
 */

import { ChevronRight, KeyRound, Plus, ShieldCheck } from "lucide-react-native";
import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  Pressable,
  Text,
  View,
} from "react-native";
import { BaseModal, ModalHeader } from "@/components/common/BaseModal";
import type { TWallet } from "@/constants/types/walletTypes";
import { useWallet } from "@/hooks/useWallet";
import type { Namespace } from "@/services/chains/types";
import { bootstrapFirstLoginWallets } from "@/services/walletKit/bootstrap";
import {
  type AddWalletStep,
  reducerOnImportSeedPhraseInstead,
  shouldResetOnVisibleChange,
} from "./AddWalletSheet.helpers";
import ImportPrivateKeySheet from "./ImportPrivateKeySheet";
import ImportSeedPhraseSheet from "./ImportSeedPhraseSheet";

const { height: SCREEN_HEIGHT } = Dimensions.get("window");
// Picker is short — three cards + header. Don't reserve 92% like the
// sub-sheets; a ~55% sheet keeps the background visible and feels less
// committal than the multi-step flows.
const PICKER_HEIGHT = Math.min(Math.round(SCREEN_HEIGHT * 0.55), 520);

type Props = {
  visible: boolean;
  onClose: () => void;
  onWalletAdded: (walletOrWallets: TWallet | TWallet[]) => void;
  /**
   * Opens straight into the private-key sub-sheet, pre-aimed at this
   * chain. Set by surfaces that already know which wallet is missing
   * (chain switcher, agent tool cards, dApp connect sheet) so the user
   * isn't sent to the generic picker to re-pick the chain they were
   * just told they lack.
   *
   * The seed-phrase route stays one tap away via the sub-sheet's footer
   * link — importing a mnemonic covers this chain too, and for most
   * users is the better answer.
   */
  initialNamespace?: Namespace;
};

type PickerCardProps = {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onPress: () => void;
  testID?: string;
  disabled?: boolean;
};

const PickerCard: React.FC<PickerCardProps> = memo(function PickerCard({
  icon,
  title,
  subtitle,
  onPress,
  testID,
  disabled,
}: PickerCardProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={subtitle}
      accessibilityState={{ disabled: !!disabled }}
      testID={testID}
      // min 56pt tap target → comfortably above the 44pt iOS / 48dp
      // Android floor for the whole card surface.
      className={`flex-row items-center bg-light rounded-2xl px-4 py-4 mb-3 ${disabled ? "opacity-60" : ""}`}
    >
      <View className="w-11 h-11 rounded-full bg-light-primary-red/10 items-center justify-center mr-3">
        {icon}
      </View>
      <View className="flex-1 pr-2">
        <Text className="text-light-matte-black font-bold text-base">
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

const AddWalletSheet: React.FC<Props> = memo(function AddWalletSheet({
  visible,
  onClose,
  onWalletAdded,
  initialNamespace,
}: Props) {
  // A caller that named a chain has already made the "which route"
  // decision for the user, so the picker would be a dead step. Everything
  // else still starts on the picker per spec §14.5.
  const entryStep: AddWalletStep = initialNamespace ? "pk" : "picker";

  const [step, setStep] = useState<AddWalletStep>(entryStep);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const { addWallets } = useWallet();

  const prevVisibleRef = useRef<boolean>(false);

  // Close handler: always wipe the step so next open starts where this
  // invocation should start (spec §14.5). Parent controls the `visible`
  // flag; we just report the close event.
  const handleClose = useCallback(() => {
    setStep(entryStep);
    onClose();
  }, [onClose, entryStep]);

  // Edge-detect hidden→visible transitions. If the parent re-opens the
  // sheet without an intermediate close (e.g. deep-link that flips
  // visible true→false→true quickly), still land on the entry step.
  useEffect(() => {
    if (shouldResetOnVisibleChange(prevVisibleRef.current, visible)) {
      setStep(entryStep);
    }
    prevVisibleRef.current = visible;
  }, [visible, entryStep]);

  // ── Sub-sheet wiring ───────────────────────────────────────────────
  // Each sub-sheet gets `visible={visible && step === "..."}` so only
  // one modal is ever mounted at a time. On success they forward
  // their wallet payload through `onWalletAdded` and we close the
  // whole sheet (resetting the step). On their own `onClose`, we rewind
  // to the picker so the user can try another option.
  // Sub-sheet back chevron. When the user was dropped straight into the
  // private-key flow there is no picker behind it to rewind to, so back
  // means dismiss the whole sheet.
  const handleSubSheetClose = useCallback(() => {
    if (initialNamespace) {
      handleClose();
      return;
    }
    setStep("picker");
  }, [initialNamespace, handleClose]);

  // "Create new wallet" → silently auto-mint one wallet per registered
  // kit from a single CSPRNG mnemonic (spec §14.3). No seed reveal, no
  // verify step, no namespace picker. Backup lives on wallet.tsx as a
  // follow-up settings flow.
  const handleCreatePressed = useCallback(async () => {
    if (creating) return;
    setCreateError(null);
    setCreating(true);
    try {
      const minted = await bootstrapFirstLoginWallets();
      if (minted.length === 0) {
        setCreateError("Could not create a wallet — please try again.");
        return;
      }
      await addWallets(minted);
      onWalletAdded(minted);
      setCreating(false);
      handleClose();
    } catch {
      setCreateError("Could not create a wallet — please try again.");
    } finally {
      setCreating(false);
    }
  }, [creating, addWallets, onWalletAdded, handleClose]);

  const handleSeedWalletsAdded = useCallback(
    (wallets: TWallet[]) => {
      onWalletAdded(wallets);
      handleClose();
    },
    [onWalletAdded, handleClose],
  );

  const handlePrivateKeyWalletAdded = useCallback(
    (wallet: TWallet) => {
      onWalletAdded(wallet);
      handleClose();
    },
    [onWalletAdded, handleClose],
  );

  const handleImportSeedPhraseInstead = useCallback(() => {
    setStep((prev) => reducerOnImportSeedPhraseInstead(prev));
  }, []);

  // ── Render: mutual exclusion between picker modal and sub-sheets ──
  // "create" is no longer a sub-sheet step — it's an inline auto-mint
  // triggered from the picker card. Only "seed" and "pk" route to
  // dedicated sub-sheets.
  if (step === "seed") {
    return (
      <ImportSeedPhraseSheet
        visible={visible}
        onClose={handleSubSheetClose}
        onWalletsAdded={handleSeedWalletsAdded}
      />
    );
  }

  if (step === "pk") {
    return (
      <ImportPrivateKeySheet
        visible={visible}
        onClose={handleSubSheetClose}
        onWalletAdded={handlePrivateKeyWalletAdded}
        onImportSeedPhraseInstead={handleImportSeedPhraseInstead}
        initialNamespace={initialNamespace}
      />
    );
  }

  // step === "picker"
  return (
    <BaseModal
      visible={visible}
      onClose={handleClose}
      height={PICKER_HEIGHT}
      contentClassName="px-4"
    >
      <ModalHeader title="Add wallet" />

      {/* Cards */}
      <View className="pt-2">
        <PickerCard
          testID="add-wallet-card-create"
          icon={
            creating ? (
              <ActivityIndicator size="small" color="#c71c4b" />
            ) : (
              <Plus size={22} color="#c71c4b" />
            )
          }
          title={creating ? "Creating wallet…" : "Create new wallet"}
          subtitle="Generates a wallet on every supported chain"
          onPress={handleCreatePressed}
          disabled={creating}
        />
        {createError ? (
          <Text className="text-light-primary-red text-xs mb-2 px-1">
            {createError}
          </Text>
        ) : null}
        <PickerCard
          testID="add-wallet-card-seed"
          icon={<ShieldCheck size={22} color="#c71c4b" />}
          title="Import seed phrase"
          subtitle="12 or 24 words"
          onPress={() => setStep("seed")}
          disabled={creating}
        />
        <PickerCard
          testID="add-wallet-card-pk"
          icon={<KeyRound size={22} color="#c71c4b" />}
          title="Import private key"
          subtitle="One chain, one key"
          onPress={() => setStep("pk")}
          disabled={creating}
        />
      </View>
    </BaseModal>
  );
});

export default AddWalletSheet;
export { AddWalletSheet };
export type { Props as AddWalletSheetProps };
