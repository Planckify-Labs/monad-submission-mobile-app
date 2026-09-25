import {
  ArrowUp,
  Maximize2,
  Mic,
  Minimize2,
  Square,
  X,
} from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  GestureHandlerRootView,
  TouchableOpacity as GHTouchableOpacity,
} from "react-native-gesture-handler";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { HalftoneHalo } from "@/components/common/HalftoneHalo";
import { HalftoneVoiceWave } from "@/components/common/HalftoneVoiceWave";
import { ThinkingOrb } from "@/components/common/ThinkingOrb";
import { useVoiceTranscription } from "@/hooks/useVoiceTranscription";

const SEND_BUTTON_SIZE = 44;
/** Extra touch area around the small cancel-recording X, without moving it. */
const CANCEL_HIT_SLOP = { top: 14, bottom: 14, left: 14, right: 10 };

export interface ChatInputProps {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => Promise<void> | void;
  isLoading?: boolean;
  placeholder?: string;
  /**
   * Optional cancel handler. When provided AND `isLoading` is true,
   * the send button switches to a stop button that invokes this
   * instead. The text field stays read-only while loading so the user
   * can read the streaming reply without accidentally sending.
   */
  onCancel?: () => void | Promise<void>;
  /**
   * Rendered centered directly above the input, so it rides the keyboard
   * with it. It never receives touches: the chat underneath still scrolls
   * and taps through it. The input floats over the list, so the caller
   * must reserve space at the end of the list for any part of the
   * accessory that would otherwise sit on the last message.
   */
  accessory?: React.ReactNode;
}

export default function ChatInput({
  value,
  onChangeText,
  onSend,
  isLoading = false,
  placeholder = "Ask me anything...",
  onCancel,
  accessory,
}: ChatInputProps) {
  const [contentHeight, setContentHeight] = useState(0);
  const [isExpanded, setIsExpanded] = useState(false);
  const { bottom: bottomInset, top: topInset } = useSafeAreaInsets();
  const voice = useVoiceTranscription();

  const handleMicPress = useCallback(async () => {
    if (voice.status === "transcribing") return;
    if (voice.status === "recording") {
      const transcript = await voice.stopAndTranscribe();
      if (transcript) {
        const next =
          value.trim().length > 0 ? `${value} ${transcript}` : transcript;
        onChangeText(next);
      }
      return;
    }
    await voice.start();
  }, [voice, value, onChangeText]);

  const renderMicIcon = () => {
    if (voice.status === "transcribing") {
      // Speech being woven into text; the button's own label carries the
      // accessible name.
      return <ThinkingOrb state="weaving" size={20} decorative />;
    }
    if (voice.status === "recording") {
      return <Square size={18} color="#c71c4b" fill="#c71c4b" />;
    }
    return <Mic size={20} color="#c71c4b" />;
  };

  const micDisabled = isLoading || voice.status === "transcribing";

  useEffect(() => {
    if (!value) {
      setContentHeight(0);
    }
  }, [value]);

  const getBorderRadius = () => {
    const lineHeight = 20;
    const estimatedLines = Math.ceil(contentHeight / lineHeight);

    if (estimatedLines <= 1) return 9999;
    if (estimatedLines <= 2) return 24;
    if (estimatedLines <= 3) return 30;
    return 23;
  };

  const hasEnoughLines = Math.ceil(contentHeight / 20) >= 5;
  const canCancel = isLoading && !!onCancel;
  // Button is disabled when not cancellable AND the send payload is
  // empty / loading. When cancellable, the button is *always* tappable
  // so the user can stop the agent.
  const isSendDisabled = canCancel ? false : isLoading || !value.trim();
  // A draft ready to send: the send button wears the Replying halo, which
  // dissolves on send as the agent's orb takes over above the input.
  const showSendHalo = !isLoading && !isExpanded && value.trim().length > 0;
  const rowPaddingX = Platform.OS === "ios" ? 20 : 12;

  const handleSend = useCallback(() => {
    if (canCancel) {
      return Promise.resolve(onCancel!());
    }
    if (isSendDisabled) {
      return Promise.resolve();
    }
    return Promise.resolve(onSend());
  }, [canCancel, isSendDisabled, onCancel, onSend]);

  return (
    <>
      {/* box-none on both wrappers: with an accessory mounted they span
          the space above the input, and a plain View there would swallow
          the list's scroll and taps even though nothing in it is
          interactive. */}
      <KeyboardAvoidingView
        behavior="padding"
        keyboardVerticalOffset={bottomInset ? bottomInset + 40 : 40}
        style={{ width: "100%" }}
        className="absolute bottom-1 left-0 w-full"
        pointerEvents="box-none"
      >
        <View pointerEvents="box-none">
          {/* Mounted even when empty (zero height): if this wrapper
              unmounted with the accessory, the accessory's own Reanimated
              `exiting` animation would never run. */}
          <View pointerEvents="none" className="items-center">
            {accessory}
          </View>
          <View
            className="flex-row items-center px-3- gap-2"
            style={{
              paddingHorizontal: rowPaddingX,
            }}
          >
            {/* Anchored on the send button's center (44dp, last in the row).
                First in the row, so the input pill and the button draw
                over it; it fades toward the pill on the left. */}
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                right: rowPaddingX + SEND_BUTTON_SIZE / 2,
                top: "50%",
                width: 0,
                height: 0,
              }}
            >
              <HalftoneHalo
                visible={showSendHalo}
                radius={SEND_BUTTON_SIZE / 2}
                fadeToward={Math.PI}
              />
            </View>
            <View
              style={{
                flex: 1,
                position: "relative",
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  backgroundColor: "#f5f5f5",
                  borderRadius: getBorderRadius(),
                  paddingHorizontal: 12,
                  borderWidth: 4,
                  borderColor: "#1a1a1a",
                }}
              >
                {voice.status === "recording" ? (
                  <View className="flex-1 flex-row items-center py-2.5">
                    {/* The icon is small and the layout must not change, so
                        the tap target grows through hitSlop only: about
                        46dp square around the 18dp icon. */}
                    <GHTouchableOpacity
                      className="pl-1 pr-2 justify-center items-center"
                      hitSlop={CANCEL_HIT_SLOP}
                      onPress={() => {
                        void voice.cancel();
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Cancel voice input"
                    >
                      <X size={18} color="#1a1a1a" />
                    </GHTouchableOpacity>
                    <HalftoneVoiceWave recorder={voice.recorder} />
                  </View>
                ) : (
                  <TextInput
                    className="flex-1 py-2.5 px-2 text-base text-light-matte-black"
                    placeholder={placeholder}
                    placeholderTextColor="#999"
                    value={value}
                    onChangeText={onChangeText}
                    onContentSizeChange={(e) =>
                      setContentHeight(e.nativeEvent.contentSize.height)
                    }
                    numberOfLines={5}
                    multiline
                    maxLength={1200}
                    editable={!isLoading}
                    returnKeyType="send"
                    onSubmitEditing={() => {
                      void handleSend();
                    }}
                  />
                )}

                <GHTouchableOpacity
                  className="p-3 justify-center items-center"
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  disabled={micDisabled}
                  onPress={() => {
                    void handleMicPress();
                  }}
                  accessibilityLabel={
                    voice.status === "recording"
                      ? "Stop recording"
                      : voice.status === "transcribing"
                        ? "Transcribing voice input"
                        : "Start voice input"
                  }
                >
                  {renderMicIcon()}
                </GHTouchableOpacity>
              </View>

              {hasEnoughLines && (
                <GHTouchableOpacity
                  containerStyle={{
                    position: "absolute",
                    top: 8,
                    right: 8,
                  }}
                  style={{
                    padding: 8,
                    justifyContent: "center",
                    alignItems: "center",
                  }}
                  onPress={() => setIsExpanded(true)}
                >
                  <Maximize2 size={15} color="#c71c4b" />
                </GHTouchableOpacity>
              )}
            </View>

            <GHTouchableOpacity
              style={{
                width: SEND_BUTTON_SIZE,
                height: SEND_BUTTON_SIZE,
                borderRadius: 9999,
                justifyContent: "center",
                alignItems: "center",
                backgroundColor: isSendDisabled ? "#d1d5db" : "#c71c4b",
                opacity: isSendDisabled ? 0.6 : 1,
              }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              activeOpacity={1}
              onPress={() => {
                void handleSend();
              }}
              disabled={isSendDisabled}
              accessibilityLabel={canCancel ? "Stop agent" : "Send message"}
            >
              {canCancel ? (
                <Square size={16} color="#ffffff" fill="#ffffff" />
              ) : isLoading ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <ArrowUp
                  size={23}
                  stroke="#ffffff"
                  strokeWidth={3}
                  color="#ffffff"
                />
              )}
            </GHTouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>

      <Modal
        visible={isExpanded}
        animationType="slide"
        transparent={false}
        onRequestClose={() => setIsExpanded(false)}
      >
        {/*
         * iOS renders RN Modals in their own UIWindow, so the
         * GestureHandlerRootView at the app root does not reach inside.
         * Without a local one, the GH-based mic/send/cancel buttons in
         * here silently lose their native gesture capture and revert to
         * the RN responder system — which loses the "tap while keyboard
         * up" race against the focused multiline TextInput.
         */}
        <GestureHandlerRootView style={{ flex: 1 }}>
          <KeyboardAvoidingView
            behavior="padding"
            className="flex-1 bg-light"
            style={{ paddingTop: topInset }}
          >
            <View className="flex-1 pl-4 flex-row">
              {voice.status === "recording" ? (
                <View className="flex-1 flex-row items-center">
                  <GHTouchableOpacity
                    className="pr-2 justify-center items-center"
                    hitSlop={CANCEL_HIT_SLOP}
                    onPress={() => {
                      void voice.cancel();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel voice input"
                  >
                    <X size={20} color="#1a1a1a" />
                  </GHTouchableOpacity>
                  <HalftoneVoiceWave recorder={voice.recorder} />
                </View>
              ) : (
                <TextInput
                  className="flex-1 text-base text-light-matte-black"
                  placeholder={placeholder}
                  placeholderTextColor="#999"
                  value={value}
                  onChangeText={onChangeText}
                  multiline
                  maxLength={500}
                  editable={!isLoading}
                  textAlignVertical="top"
                />
              )}

              <TouchableOpacity
                onPress={() => setIsExpanded(false)}
                className="p-2 mt-2"
              >
                <Minimize2 size={20} color="#c71c4b" />
              </TouchableOpacity>
            </View>

            <View className="flex-row items-center justify-between px-4 py-4">
              <GHTouchableOpacity
                className="p-3 justify-center items-center"
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                disabled={micDisabled}
                onPress={() => {
                  void handleMicPress();
                }}
                accessibilityLabel={
                  voice.status === "recording"
                    ? "Stop recording"
                    : "Start voice input"
                }
              >
                {renderMicIcon()}
              </GHTouchableOpacity>

              <GHTouchableOpacity
                className={`w-11 h-11 rounded-full justify-center items-center ${
                  isSendDisabled
                    ? "bg-gray-300 opacity-60"
                    : "bg-light-primary-red"
                }`}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                onPress={() => {
                  void handleSend().then(() => setIsExpanded(false));
                }}
                disabled={isSendDisabled}
              >
                {isLoading ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <ArrowUp
                    size={23}
                    stroke="#ffffff"
                    strokeWidth={3}
                    color="#ffffff"
                  />
                )}
              </GHTouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        </GestureHandlerRootView>
      </Modal>
    </>
  );
}
