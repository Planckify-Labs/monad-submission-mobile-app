import {
  ChevronDown,
  ChevronUp,
  Copy,
  Gift,
  Mail,
  Receipt,
  Send,
} from "lucide-react-native";
import React, { useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import type {
  TDeliveryPayload,
  TDeliveryType,
  TFulfilment,
} from "@/api/types/fulfilment";
import type { TCustomerInfo } from "@/api/types/redeem";
import { customerInfoTarget } from "@/utils/fulfilmentUtils";
import { copyToClipboard } from "@/utils/helperUtils";
import { isPLNVoucher } from "@/utils/vcGamerUtils";
import PLNCard from "./PLNCard";

function plnMeter(customerInfo: TCustomerInfo | undefined): number {
  const target = customerInfoTarget(customerInfo);
  return Number(target ?? 0) || 0;
}

/**
 * Bridge for API versions that predate `fulfilment.delivery`: the legacy
 * `voucherCode` string becomes a raw-only payload.
 */
function fromLegacy(
  voucherCode: string | null | undefined,
  deliveryType: TDeliveryType | undefined,
  customerInfo: TCustomerInfo | undefined,
): TDeliveryPayload | null {
  if (!voucherCode) return null;
  const kind =
    deliveryType === "DIRECT_TOPUP"
      ? "topup"
      : deliveryType === "BILL_PAYMENT"
        ? "bill"
        : deliveryType === "EMAIL"
          ? "email"
          : "voucher";
  return {
    kind,
    primary:
      kind === "voucher"
        ? { label: "Code", value: voucherCode, copyable: true }
        : undefined,
    fields: [],
    raw: voucherCode,
    parse: "none",
    parserId: null,
    target: customerInfoTarget(customerInfo, deliveryType),
  };
}

function RawBlock({
  raw,
  initiallyOpen,
}: {
  raw: string;
  initiallyOpen: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <View className="mt-3">
      <TouchableOpacity
        onPress={() => setOpen((v) => !v)}
        className="flex-row items-center justify-between"
      >
        <Text className="text-light-matte-black/60 text-xs font-semibold uppercase tracking-wider">
          Exactly as the provider sent it
        </Text>
        {open ? (
          <ChevronUp size={14} color="#6b7280" />
        ) : (
          <ChevronDown size={14} color="#6b7280" />
        )}
      </TouchableOpacity>
      {open ? (
        <View className="flex-row items-start bg-light-main-container/50 rounded-lg p-3 mt-2">
          <Text
            className="text-light-matte-black text-xs font-mono flex-1"
            selectable
          >
            {raw}
          </Text>
          <TouchableOpacity
            onPress={() => copyToClipboard(raw, "Copied")}
            className="ml-2 p-1"
          >
            <Copy size={14} color="#c71c4b" />
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The one card for whatever the provider handed over. Renders the
 * server-parsed `DeliveryPayload` without knowing the product: a big
 * copyable `primary`, labelled rows, and the raw provider text — always
 * available, expanded automatically when the parse wasn't exact so an
 * unknown format is "less pretty", never "missing".
 */
export default function DeliveryCard({
  fulfilment,
  legacyVoucherCode,
  customerInfo,
}: {
  fulfilment?: TFulfilment | null;
  legacyVoucherCode?: string | null;
  customerInfo?: TCustomerInfo;
}) {
  const delivery =
    fulfilment?.delivery ??
    fromLegacy(legacyVoucherCode, fulfilment?.deliveryType, customerInfo);
  if (!delivery) return null;
  if (
    fulfilment &&
    fulfilment.status !== "DELIVERED" &&
    fulfilment.status !== "REFUNDED"
  ) {
    // Nothing handed over yet; the timeline says what's happening.
    return null;
  }

  // PLN keeps its dedicated card: the raw is always the vendor string.
  // Decided by content, not `kind`: vendor feeds type PLN as a top-up, and
  // rows parsed before the server learned that still say "topup".
  if (delivery.raw && isPLNVoucher(delivery.raw)) {
    return (
      <View className="bg-white rounded-2xl shadow-sm">
        <PLNCard
          plnCustomerInfo={{
            vcGamerVoucher: delivery.raw,
            meterNumber: plnMeter(customerInfo),
          }}
        />
        {delivery.parse !== "exact" ? (
          <View className="px-4 pb-4">
            <RawBlock raw={delivery.raw} initiallyOpen />
          </View>
        ) : null}
      </View>
    );
  }

  const heading =
    delivery.kind === "topup"
      ? {
          icon: <Send size={18} color="#c71c4b" />,
          title: "Delivered",
          sub: delivery.target
            ? `Sent to ${delivery.target}`
            : "Sent to your account",
        }
      : delivery.kind === "bill"
        ? {
            icon: <Receipt size={18} color="#c71c4b" />,
            title: "Receipt",
            sub: delivery.target ? `For ${delivery.target}` : undefined,
          }
        : delivery.kind === "email"
          ? {
              icon: <Mail size={18} color="#c71c4b" />,
              title: "On its way by email",
              sub: delivery.target
                ? `The provider is emailing it to ${delivery.target}. Check spam if it isn't there in a few minutes.`
                : "The provider is emailing it to you. Check spam if it isn't there in a few minutes.",
            }
          : {
              icon: <Gift size={18} color="#c71c4b" />,
              title: "Your voucher",
              sub: "Tap to copy, then redeem it with the provider.",
            };

  const showRaw =
    !!delivery.raw && (delivery.parse !== "exact" || !delivery.primary);
  const rawIsAllWeShow =
    !!delivery.raw && !delivery.primary && delivery.fields.length === 0;

  return (
    <View className="bg-white rounded-2xl p-4 shadow-sm">
      <View className="flex-row items-center mb-3">
        {heading.icon}
        <View className="ml-2 flex-1">
          <Text className="text-light-matte-black font-bold text-lg">
            {heading.title}
          </Text>
          {heading.sub ? (
            <Text className="text-light-matte-black/60 text-xs mt-0.5">
              {heading.sub}
            </Text>
          ) : null}
        </View>
      </View>

      {delivery.primary ? (
        <View className="border-2 border-dashed border-light-primary-red/40 rounded-xl p-3">
          <Text className="text-light-matte-black/60 text-xs mb-1">
            {delivery.primary.label}
          </Text>
          <View className="flex-row items-center justify-between">
            <Text
              className="text-light-primary-red font-bold text-lg font-mono flex-1 tracking-widest"
              selectable
            >
              {delivery.primary.value}
            </Text>
            <TouchableOpacity
              onPress={() =>
                copyToClipboard(
                  delivery.primary?.value ?? "",
                  `${delivery.primary?.label} copied`,
                )
              }
              className="ml-2 p-2"
            >
              <Copy size={18} color="#c71c4b" />
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {delivery.fields.length > 0 ? (
        <View className={delivery.primary ? "mt-3" : ""}>
          {delivery.fields.map((f, i) => (
            <View
              key={`${f.label}-${i}`}
              className="flex-row justify-between items-center py-1.5 border-b border-light-matte-black/5"
            >
              <Text className="text-light-matte-black/60 text-sm flex-1">
                {f.label || "Detail"}
              </Text>
              <View className="flex-row items-center flex-1 justify-end">
                <Text
                  className="text-light-matte-black text-sm font-medium text-right"
                  selectable
                >
                  {f.value}
                </Text>
                {f.copyable ? (
                  <TouchableOpacity
                    onPress={() =>
                      copyToClipboard(f.value, `${f.label || "Value"} copied`)
                    }
                    className="ml-2 p-1"
                  >
                    <Copy size={12} color="#c71c4b" />
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {showRaw && delivery.raw ? (
        rawIsAllWeShow ? (
          <View className="flex-row items-start bg-light-main-container/50 rounded-lg p-3">
            <Text
              className="text-light-matte-black text-sm font-mono flex-1"
              selectable
            >
              {delivery.raw}
            </Text>
            <TouchableOpacity
              onPress={() => copyToClipboard(delivery.raw ?? "", "Copied")}
              className="ml-2 p-1"
            >
              <Copy size={16} color="#c71c4b" />
            </TouchableOpacity>
          </View>
        ) : (
          <RawBlock
            raw={delivery.raw}
            initiallyOpen={delivery.parse !== "exact"}
          />
        )
      ) : null}
    </View>
  );
}
