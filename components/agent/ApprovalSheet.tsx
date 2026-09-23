/**
 * ApprovalSheet — hard-stop approval UI for the Takumi Agent.
 *
 * Spec: `AGENT_PROTOCOL.md` §6 "The Approval Sheet with Grant Selection", §10.
 * Task: 14. Depends on task 11 (`permissionGrantStore`). Task 09 wires this
 * component into the real dispatcher via `buildApprovalSheetHandlers`.
 *
 * This module is deliberately self-contained:
 *   - The JSX component reads no agent/session state; its only outside
 *     dependency is the shared `PinConfirmationModal` (which owns `usePin`).
 *   - All testable logic (`buildGrantOptions`, `buildApprovalSheetHandlers`,
 *     `specialWarning`) is exported as plain functions and lives in the same
 *     module so `node --test` can exercise them without the RN runtime.
 *
 * The component renders as a full bottom-sheet Modal. The repo has no
 * `@gorhom/bottom-sheet` dependency, so we compose on top of RN's `Modal`
 * like the sibling `SpendingApprovalModal.tsx`. Backgrounding the app does
 * NOT dismiss the sheet — RN modals retain state across background/foreground
 * transitions, and we do not wire any AppState-driven dismissal.
 *
 * PIN-gated, same shape as `SpendingApprovalModal` / `TrustAssetConfirmModal`:
 * tapping "Approve" does NOT call `onApprove` directly. It stashes the
 * `GrantChoice` the user picked and opens `PinConfirmationModal`; only that
 * modal's own successful `onConfirm` (which verifies the PIN via `usePin`)
 * hands the stashed choice to `onApprove`. Dismissing the PIN sheet drops
 * the stash and leaves the approval sheet up, so the user can retry or
 * Reject. Grant persistence lives behind `onApprove` in the caller, so a
 * grant is never recorded for an approval the PIN did not confirm.
 */

import { AlertTriangle } from "lucide-react-native";
import type React from "react";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import PinConfirmationModal from "@/components/common/PinConfirmationModal";
import {
  DEFAULT_DURATION_PRESET_ID,
  DURATION_PRESETS,
  type GrantChoice,
  type GrantOption,
} from "./approvalSheetLogic";

// Re-export the pure helpers and types so consumers can `import { ... } from
// "@/components/agent/ApprovalSheet"` without reaching into the logic module.
// See `approvalSheetLogic.ts` for the canonical definitions and doc comments.
export {
  buildApprovalSheetHandlers,
  buildGrantOptions,
  DEFAULT_DURATION_PRESET_ID,
  DURATION_PRESETS,
  type DurationPreset,
  type GrantChoice,
  type GrantOption,
  specialWarning,
  type ToolPendingPayload,
} from "./approvalSheetLogic";

// --- Component props -------------------------------------------------------

export interface ApprovalSheetProps {
  title: string;
  summary: string;
  warning?: string;
  grantOptions: GrantOption[];
  onApprove: (choice: GrantChoice) => void;
  onReject: () => void;
  /** When true, buttons are disabled and a "Confirm on your device…" overlay shows. */
  isHardwareSigning?: boolean;
}

// --- Component --------------------------------------------------------------

/**
 * Radio row primitive. Kept inline to avoid dragging a new shared file into
 * the repo — the project has no radio primitive today, just checkbox-like
 * `Pressable + View` rows as seen in `SpendingApprovalModal.tsx`.
 */
interface RadioRowProps {
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
  children: React.ReactNode;
  accessibilityLabel: string;
}

const RadioRow: React.FC<RadioRowProps> = ({
  selected,
  disabled = false,
  onPress,
  children,
  accessibilityLabel,
}) => (
  <Pressable
    onPress={onPress}
    disabled={disabled}
    accessibilityRole="radio"
    accessibilityState={{ selected, disabled }}
    accessibilityLabel={accessibilityLabel}
    className={`flex-row items-center py-3 ${disabled ? "opacity-50" : ""}`}
  >
    <View
      className={`w-5 h-5 rounded-full border-2 items-center justify-center mr-3 ${
        selected ? "border-light-primary-red" : "border-light-matte-black/30"
      }`}
    >
      {selected ? (
        <View className="w-2.5 h-2.5 rounded-full bg-light-primary-red" />
      ) : null}
    </View>
    <View className="flex-1">{children}</View>
  </Pressable>
);

export const ApprovalSheet: React.FC<ApprovalSheetProps> = ({
  title,
  summary,
  warning,
  grantOptions,
  onApprove,
  onReject,
  isHardwareSigning = false,
}) => {
  const { bottom } = useSafeAreaInsets();
  const bottomOffset = Platform.OS === "ios" ? 16 : bottom > 0 ? bottom : 16;

  // Default selection: "Just this once" (index 0, most conservative).
  const [selectedId, setSelectedId] = useState<string>(
    grantOptions[0]?.id ?? "once",
  );
  const [presetId, setPresetId] = useState<string>(DEFAULT_DURATION_PRESET_ID);
  const [showPresetMenu, setShowPresetMenu] = useState(false);
  const [pickedDateMs, setPickedDateMs] = useState<number | null>(null);
  // The choice awaiting PIN confirmation. Captured at tap time so a radio
  // change behind the PIN sheet cannot alter what gets approved.
  const [pendingChoice, setPendingChoice] = useState<GrantChoice | null>(null);
  // Date picker is intentionally a no-op stub for this task — a date-picker
  // primitive doesn't exist in the repo. Tapping the "Until" row currently
  // seeds a far-future placeholder so QA can click through. Task 17 adds a
  // real picker.
  const handlePickDate = useCallback(() => {
    // Placeholder: 7 days out, rounded to the nearest second.
    const placeholder = Date.now() + 7 * 24 * 60 * 60 * 1000;
    setPickedDateMs(placeholder);
    setSelectedId("timed_until");
  }, []);

  const selectedOption = useMemo(
    () => grantOptions.find((o) => o.id === selectedId) ?? grantOptions[0],
    [grantOptions, selectedId],
  );

  const currentPreset = useMemo(
    () =>
      DURATION_PRESETS.find((p) => p.id === presetId) ?? DURATION_PRESETS[1],
    [presetId],
  );

  /**
   * Translate the UI state into the `GrantChoice` we hand back on approve.
   * For "timed_relative" we rebase `expires_at` to "now + preset.ms" so the
   * clock starts the moment the user taps Approve. For "timed_until" we
   * substitute the date the user picked.
   */
  const buildChoiceForApprove = useCallback((): GrantChoice | null => {
    if (!selectedOption) return null;
    if (selectedOption.id === "timed_relative" && currentPreset) {
      return {
        scope: selectedOption.scope,
        lifetime: {
          type: "timed",
          expires_at: Date.now() + currentPreset.ms,
        },
      };
    }
    if (selectedOption.id === "timed_until") {
      if (pickedDateMs == null) return null;
      return {
        scope: selectedOption.scope,
        lifetime: { type: "timed", expires_at: pickedDateMs },
      };
    }
    return { scope: selectedOption.scope, lifetime: selectedOption.lifetime };
  }, [selectedOption, currentPreset, pickedDateMs]);

  const canApprove =
    !isHardwareSigning &&
    selectedOption != null &&
    (selectedOption.id !== "timed_until" || pickedDateMs != null);

  const handleApprove = useCallback(() => {
    if (pendingChoice) return;
    const choice = buildChoiceForApprove();
    if (!choice) return;
    setPendingChoice(choice);
  }, [pendingChoice, buildChoiceForApprove]);

  const handlePinConfirm = useCallback(() => {
    const choice = pendingChoice;
    setPendingChoice(null);
    if (!choice) return;
    onApprove(choice);
  }, [pendingChoice, onApprove]);

  const handlePinClose = useCallback(() => {
    setPendingChoice(null);
  }, []);

  const handleReject = useCallback(() => {
    if (isHardwareSigning) return;
    onReject();
  }, [isHardwareSigning, onReject]);

  // Composed a11y label: title + summary + warning + current radio selection,
  // read by VoiceOver when the sheet mounts.
  const a11yIntro =
    `${title}. ${summary}.` +
    (warning ? ` Warning: ${warning}.` : "") +
    (selectedOption ? ` Selected: ${selectedOption.label}.` : "");

  return (
    <>
      <Modal
        transparent
        visible
        animationType="fade"
        // Disable RN's hardware-back dismissal — this sheet is a hard stop.
        onRequestClose={() => {
          /* no-op: user must tap Reject or Approve */
        }}
      >
        <View
          accessible
          accessibilityLabel={a11yIntro}
          style={{ flex: 1, backgroundColor: "rgba(0, 0, 0, 0.5)" }}
        >
          <View style={{ flex: 1 }} />
          <View
            style={{
              backgroundColor: "#f5f6f9",
              borderTopLeftRadius: 28,
              borderTopRightRadius: 28,
              paddingBottom: bottomOffset,
              shadowColor: "#000",
              shadowOffset: { width: 0, height: -3 },
              shadowOpacity: 0.1,
              shadowRadius: 10,
              elevation: 10,
            }}
          >
            {/* Drag handle (visual only — sheet is not swipe-dismissible) */}
            <View className="w-full items-center pt-4 pb-2">
              <View className="w-12 h-1 bg-gray-300 rounded-full" />
            </View>

            <View className="px-6 pb-4">
              <Text
                className="text-light-matte-black text-xl font-bold mb-2"
                accessibilityRole="header"
              >
                {title}
              </Text>
              <Text className="text-light-matte-black/70 text-sm mb-4">
                {summary}
              </Text>

              {warning ? (
                <View className="bg-orange-50 border border-orange-200 rounded-xl p-4 mb-4 flex-row items-start">
                  <AlertTriangle
                    size={18}
                    color="#f59e0b"
                    style={{ marginRight: 8, marginTop: 2 }}
                  />
                  <View className="flex-1">
                    <Text className="text-orange-800 font-medium text-sm mb-1">
                      Security Notice
                    </Text>
                    <Text className="text-orange-700 text-xs">{warning}</Text>
                  </View>
                </View>
              ) : null}

              <View className="bg-white rounded-2xl p-4 mb-4">
                <Text className="text-light-matte-black/70 text-xs uppercase tracking-wide mb-2">
                  Allow agent to do this
                </Text>

                {grantOptions.map((option) => {
                  const isSelected = option.id === selectedId;
                  // "timed_until" row is only enabled once a date has been
                  // picked (or when tapped via the Pick Date button below).
                  const disabled =
                    option.id === "timed_until" && pickedDateMs == null;

                  return (
                    <View key={option.id}>
                      <RadioRow
                        selected={isSelected}
                        disabled={disabled}
                        onPress={() => {
                          if (disabled) {
                            handlePickDate();
                            return;
                          }
                          setSelectedId(option.id);
                        }}
                        accessibilityLabel={option.label}
                      >
                        <View className="flex-row items-center justify-between">
                          <Text className="text-light-matte-black text-base">
                            {option.label}
                          </Text>
                          {option.id === "timed_relative" ? (
                            <Pressable
                              onPress={() => {
                                setSelectedId("timed_relative");
                                setShowPresetMenu((v) => !v);
                              }}
                              accessibilityRole="button"
                              accessibilityLabel={`Duration: ${currentPreset?.label ?? ""}`}
                              className="bg-light-main-container px-3 py-1 rounded-lg"
                            >
                              <Text className="text-light-matte-black text-sm">
                                {currentPreset?.label ?? ""} ▾
                              </Text>
                            </Pressable>
                          ) : null}
                          {option.id === "timed_until" ? (
                            <Pressable
                              onPress={handlePickDate}
                              accessibilityRole="button"
                              accessibilityLabel="Pick a date"
                              className="bg-light-main-container px-3 py-1 rounded-lg"
                            >
                              <Text className="text-light-matte-black text-sm">
                                {pickedDateMs
                                  ? new Date(pickedDateMs).toLocaleDateString()
                                  : "Pick a date"}
                              </Text>
                            </Pressable>
                          ) : null}
                        </View>
                      </RadioRow>

                      {option.id === "timed_relative" && showPresetMenu ? (
                        <View className="bg-light-main-container/50 rounded-xl p-2 mb-2">
                          {DURATION_PRESETS.map((preset) => (
                            <Pressable
                              key={preset.id}
                              onPress={() => {
                                setPresetId(preset.id);
                                setShowPresetMenu(false);
                                setSelectedId("timed_relative");
                              }}
                              accessibilityRole="button"
                              accessibilityLabel={preset.label}
                              className="py-2 px-3"
                            >
                              <Text className="text-light-matte-black text-sm">
                                {preset.label}
                              </Text>
                            </Pressable>
                          ))}
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </View>

              <View className="flex-row gap-3">
                <Pressable
                  onPress={handleReject}
                  disabled={isHardwareSigning}
                  accessibilityRole="button"
                  accessibilityLabel="Reject"
                  className={`flex-1 bg-light-main-container py-4 rounded-xl items-center ${
                    isHardwareSigning ? "opacity-50" : ""
                  }`}
                >
                  <Text className="text-light-matte-black font-bold">
                    Reject
                  </Text>
                </Pressable>

                <Pressable
                  onPress={handleApprove}
                  disabled={!canApprove}
                  accessibilityRole="button"
                  accessibilityLabel="Approve"
                  className={`flex-1 bg-light-primary-red py-4 rounded-xl items-center ${
                    !canApprove ? "opacity-50" : ""
                  }`}
                >
                  <Text className="text-white font-bold">Approve</Text>
                </Pressable>
              </View>
            </View>
          </View>

          {isHardwareSigning ? (
            <View
              accessible
              accessibilityLabel="Confirm on your device"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: "rgba(0, 0, 0, 0.7)",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <ActivityIndicator size="large" color="#ffffff" />
              <Text className="text-white text-base font-medium mt-4">
                Confirm on your device…
              </Text>
            </View>
          ) : null}
        </View>
      </Modal>

      <PinConfirmationModal
        visible={pendingChoice != null}
        title="Confirm with PIN"
        onClose={handlePinClose}
        onConfirm={handlePinConfirm}
      />
    </>
  );
};

export default ApprovalSheet;
