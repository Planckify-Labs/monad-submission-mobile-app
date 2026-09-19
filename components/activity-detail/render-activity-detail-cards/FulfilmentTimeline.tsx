import { Check, Clock, RefreshCw, X } from "lucide-react-native";
import React from "react";
import { Text, TouchableOpacity, View } from "react-native";
import type { TFulfilment } from "@/api/types/fulfilment";
import {
  summariseFulfilment,
  type TFulfilmentStep,
  type TFulfilmentTone,
} from "@/utils/fulfilmentUtils";

const TONE_TEXT: Record<TFulfilmentTone, string> = {
  pending: "text-yellow-700",
  warn: "text-orange-600",
  ok: "text-emerald-600",
  bad: "text-red-600",
};

const TONE_BAR: Record<TFulfilmentTone, string> = {
  pending: "border-yellow-500",
  warn: "border-orange-500",
  ok: "border-emerald-500",
  bad: "border-light-primary-red",
};

function StepDot({ state }: { state: TFulfilmentStep["state"] }) {
  switch (state) {
    case "done":
      return (
        <View className="w-6 h-6 rounded-full bg-emerald-500 items-center justify-center">
          <Check size={14} color="#fff" strokeWidth={3} />
        </View>
      );
    case "active":
      return (
        <View className="w-6 h-6 rounded-full bg-yellow-500 items-center justify-center">
          <Clock size={14} color="#fff" strokeWidth={2.5} />
        </View>
      );
    case "failed":
      return (
        <View className="w-6 h-6 rounded-full bg-light-primary-red items-center justify-center">
          <X size={14} color="#fff" strokeWidth={3} />
        </View>
      );
    default:
      return (
        <View className="w-6 h-6 rounded-full border-2 border-light-matte-black/20 bg-white" />
      );
  }
}

/**
 * Paid → Preparing → Delivered, in buyer language, driven entirely by the
 * server's `fulfilment` block. Works without it (older API) by showing
 * the money leg only — it never claims a delivery it cannot see.
 */
export default function FulfilmentTimeline({
  fulfilment,
  moneyStatus,
  kind,
  onRetryWithPoints,
}: {
  fulfilment?: TFulfilment | null;
  moneyStatus: string;
  kind: "purchase" | "redemption";
  /** Shown on REFUNDED: re-open checkout with the same variant + inputs. */
  onRetryWithPoints?: () => void;
}) {
  const summary = summariseFulfilment({ fulfilment, moneyStatus, kind });
  const showRetry =
    !!onRetryWithPoints &&
    fulfilment?.status === "REFUNDED" &&
    fulfilment.refund?.status !== "REVERSED";

  return (
    <View
      className={`bg-white rounded-2xl p-4 shadow-sm border-l-4 ${TONE_BAR[summary.tone]}`}
    >
      <Text className={`font-bold text-lg ${TONE_TEXT[summary.tone]}`}>
        {summary.title}
      </Text>
      {summary.detail ? (
        <Text className="text-light-matte-black/70 text-sm mt-1 leading-5">
          {summary.detail}
        </Text>
      ) : null}

      <View className="mt-4">
        {summary.steps.map((step, i) => (
          <View key={step.key} className="flex-row">
            <View className="items-center mr-3">
              <StepDot state={step.state} />
              {i < summary.steps.length - 1 ? (
                <View
                  className={`w-0.5 flex-1 my-1 ${
                    step.state === "done"
                      ? "bg-emerald-500"
                      : "bg-light-matte-black/10"
                  }`}
                />
              ) : null}
            </View>
            <View
              className={
                i < summary.steps.length - 1 ? "pb-4 flex-1" : "flex-1"
              }
            >
              <Text
                className={`text-sm ${
                  step.state === "todo"
                    ? "text-light-matte-black/40"
                    : "text-light-matte-black font-medium"
                }`}
              >
                {step.label}
              </Text>
              {step.detail ? (
                <Text className="text-light-matte-black/60 text-xs mt-0.5">
                  {step.detail}
                </Text>
              ) : null}
            </View>
          </View>
        ))}
      </View>

      {showRetry ? (
        <TouchableOpacity
          onPress={onRetryWithPoints}
          className="mt-3 bg-light-primary-red rounded-xl p-3 flex-row items-center justify-center"
        >
          <RefreshCw size={16} color="#fff" strokeWidth={2.5} />
          <Text className="text-white font-bold text-sm ml-2">
            Retry with points
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}
