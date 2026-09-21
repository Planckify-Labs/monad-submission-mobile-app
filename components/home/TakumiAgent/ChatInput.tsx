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
import { useVoiceTranscription } from "@/hooks/useVoiceTranscription";
import { AudioWaveBars } from "./AudioWaveBars";

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
}

export default function ChatInput({
  value,
  onChangeText,
  onSend,
  isLoading = false,
  placeholder = "Ask me anything...",
  onCancel,
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
      return <ActivityIndicator size="small" color="#c71c4b" />;
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
      <KeyboardAvoidingView
        behavior="padding"
        keyboardVerticalOffset={bottomInset ? bottomInset + 40 : 40}
        style={{ width: "100%" }}
        className="absolute bottom-1 left-0 w-full"
      >
        <View>
          <View
            className="flex-row items-center px-3- gap-2"
            style={{
              paddingHorizontal: Platform.OS === "ios" ? 20 : 12,
            }}
          >
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
                    <GHTouchableOpacity
                      className="pl-1 pr-2 justify-center items-center"
                      onPress={() => {
                        void voice.cancel();
                      }}
                      accessibilityLabel="Cancel voice input"
                    >
                      <X size={18} color="#1a1a1a" />
                    </GHTouchableOpacity>
                    <AudioWaveBars recorder={voice.recorder} />
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
                width: 44,
                height: 44,
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
                    onPress={() => {
                      void voice.cancel();
                    }}
                    accessibilityLabel="Cancel voice input"
                  >
                    <X size={20} color="#1a1a1a" />
                  </GHTouchableOpacity>
                  <AudioWaveBars recorder={voice.recorder} />
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
