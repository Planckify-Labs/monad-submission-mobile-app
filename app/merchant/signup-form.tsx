/**
 * Merchant signup form (spec §1.1.1 step 3, §6.1 `MerchantSignupRequest`,
 * milestone M1). Landing screen from `app/merchant/signup-intro.tsx` on
 * both the scan and manual paths:
 *
 *   /merchant/signup-form?source=qris&qris=<raw>
 *   /merchant/signup-form?source=manual
 *
 * M1 stub behaviour — the `POST /v1/merchants/signup` endpoint is a
 * task-27 deliverable and not live yet. Submit here validates the form
 * client-side, logs the assembled `MerchantSignupRequest` for QA, and
 * routes to `/merchant/qr` (task 13, may 404 until that screen lands).
 * Swap the `handleSubmit` payload-log for a TanStack mutation hitting
 * `takumipay-api /v1/merchants/signup` when task 27 ships.
 *
 * Copy-audience rule (spec §1.1) — merchants are non-crypto UMKM users.
 * Strings on this screen use "payout account", "bank", "e-wallet",
 * "QRIS" — never USDC / chain / gas / signature language.
 *
 * Three-role separation (memory `feedback_role_separation.md`): client
 * validates format + required fields, server authorizes. Do not encode
 * server-side rules (payout min/max, blacklists, KYC thresholds) here.
 *
 * Polymorphic account input — the channel list is served by
 * `GET /v1/merchants/channels?country=ID` (task 28) and cached
 * per-country in MMKV via `useChannelsWithStorage`. Adding a new QRIS
 * rail (LinkAja, BRI, JeniusPay, …) is a backend-only change now. The
 * validator below still switches on `kind` (`"ewallet" | "bank"`) with
 * a safe fallback for unknown kinds (10–20 alphanumeric chars), so a
 * channel with a novel kind never hard-errors the form.
 */

import { router, useLocalSearchParams } from "expo-router";
import {
  ArrowLeft,
  Building2,
  Check,
  ChevronDown,
  Wallet,
} from "lucide-react-native";
import React, { useCallback, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import { SafeAreaView } from "react-native-safe-area-context";
import type { TChannel } from "@/api/types/channel";
import { BaseModal, ModalHeader } from "@/components/common/BaseModal";
import { useChannelsWithStorage } from "@/hooks/useChannelsWithStorage";

/**
 * UI-layer shape of a channel. Derived from the backend `TChannel` via
 * {@link toChannelOption} — fields like `helper` / `placeholder` /
 * `keyboardType` / `maxLength` are presentation concerns the backend
 * deliberately does not ship, so they're computed from `kind`.
 */
type ChannelKind = "ewallet" | "bank";

interface ChannelOption {
  code: string;
  label: string;
  kind: ChannelKind;
  helper: string;
  placeholder: string;
  keyboardType: "phone-pad" | "number-pad";
  maxLength: number;
  iconUrl: string | null;
}

/**
 * Project a backend `TChannel` row onto the UI's `ChannelOption`.
 * Helper copy is personalised with the channel label so the
 * e-wallet line reads "…linked to your GoPay account." rather than a
 * generic template. `iconUrl` is passed through unchanged; the picker
 * renders it when present and falls back to a kind-based glyph when
 * null.
 */
const toChannelOption = (row: TChannel): ChannelOption => {
  const kind: ChannelKind = row.kind === "bank" ? "bank" : "ewallet";
  if (kind === "ewallet") {
    return {
      code: row.channelCode,
      label: row.label,
      kind,
      helper: `Use the Indonesian mobile number linked to your ${row.label} account.`,
      placeholder: "08123456789",
      keyboardType: "phone-pad",
      maxLength: 13,
      iconUrl: row.iconUrl,
    };
  }
  return {
    code: row.channelCode,
    label: row.label,
    kind,
    helper: `Enter your ${row.label} account number.`,
    placeholder: "1234567890",
    keyboardType: "number-pad",
    maxLength: 16,
    iconUrl: row.iconUrl,
  };
};

/**
 * Return the channel by code from a given list. Falls back to `null`
 * so the form treats "nothing picked" and "unknown code" uniformly —
 * both force the user to pick from the list.
 */
const findChannel = (
  channels: ChannelOption[],
  code: string | null,
): ChannelOption | null => channels.find((c) => c.code === code) ?? null;

/**
 * Polymorphic account-number validator. Returns `null` on success, a
 * user-facing message otherwise. Chain-extension discipline: switch is
 * on `kind` (the server-supplied category), not the channel code — new
 * e-wallets / banks added via the backend pick up the right rule for
 * free. Fallback handles unknown kinds with a lenient 10-20 alnum rule
 * so the form never hard-errors on a future channel (TODO task 28).
 */
const validateAccountNumber = (
  value: string,
  channel: ChannelOption | null,
): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return "Account number is required.";
  if (!channel) return "Pick a QRIS type first.";

  if (channel.kind === "ewallet") {
    // Indonesian mobile number: 08 + 8-11 more digits (10-13 total).
    if (!/^08\d{8,11}$/.test(trimmed)) {
      return "Enter a valid Indonesian mobile number (starts with 08, 10–13 digits).";
    }
    return null;
  }

  if (channel.kind === "bank") {
    if (!/^\d{10,16}$/.test(trimmed)) {
      return "Enter a valid bank account number (10–16 digits).";
    }
    return null;
  }

  // Fallback for any future kind not covered above — TODO task 28.
  if (!/^[A-Za-z0-9]{10,20}$/.test(trimmed)) {
    return "Enter 10–20 letters or digits.";
  }
  return null;
};

/**
 * Lightweight EMVCo QRIS extractor — pulls merchant name (tag 59) and
 * the PAN from the merchant-account-info sub-tag (tags 26-51, sub-tag
 * 01). Inline per task constraint (no new files under `services/`). The
 * real CRC-validated decoder lives in
 * `services/paymentIntent/detectors/qris.ts`; we trust upstream
 * validation and only re-walk the TLV stream for two fields.
 */
interface QrisExtract {
  merchantName?: string;
  qrisPan?: string;
}

const extractQrisFields = (raw: string): QrisExtract => {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("000201")) return {};

  const tags: { tag: string; value: string }[] = [];
  let i = 0;
  while (i + 4 <= trimmed.length) {
    const tag = trimmed.slice(i, i + 2);
    const lenStr = trimmed.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lenStr)) return {};
    const length = Number.parseInt(lenStr, 10);
    const start = i + 4;
    const end = start + length;
    if (end > trimmed.length) return {};
    tags.push({ tag, value: trimmed.slice(start, end) });
    i = end;
  }

  const merchantName = tags.find((t) => t.tag === "59")?.value;

  // Walk tag 26-51 for the first merchant-account-info block; its
  // sub-tag 01 is the merchant PAN.
  let qrisPan: string | undefined;
  for (const t of tags) {
    const tagNum = Number.parseInt(t.tag, 10);
    if (tagNum < 26 || tagNum > 51) continue;
    let j = 0;
    while (j + 4 <= t.value.length) {
      const subTag = t.value.slice(j, j + 2);
      const subLenStr = t.value.slice(j + 2, j + 4);
      if (!/^\d{2}$/.test(subTag) || !/^\d{2}$/.test(subLenStr)) break;
      const subLen = Number.parseInt(subLenStr, 10);
      const subStart = j + 4;
      const subEnd = subStart + subLen;
      if (subEnd > t.value.length) break;
      if (subTag === "01") {
        qrisPan = t.value.slice(subStart, subEnd);
        break;
      }
      j = subEnd;
    }
    if (qrisPan) break;
  }

  return { merchantName, qrisPan };
};

interface SignupFormValues {
  displayName: string;
  countryCode: string;
  payoutChannel: string;
  payoutAccountNumber: string;
  payoutAccountHolderName: string;
}

export default function MerchantSignupForm() {
  const params = useLocalSearchParams<{
    source?: string;
    qris?: string;
  }>();

  const source = params.source === "qris" ? "qris" : "manual";
  const qrisRaw = typeof params.qris === "string" ? params.qris : undefined;

  const qrisExtract = useMemo<QrisExtract>(
    () => (source === "qris" && qrisRaw ? extractQrisFields(qrisRaw) : {}),
    [source, qrisRaw],
  );

  // Server-fed QRIS type list — MMKV-cached for frame-0 render on
  // return visits and offline opens (task 28 backend + the mirror hook
  // `useChannelsWithStorage`). Empty array while the first fetch is in
  // flight on a cold install; the picker surfaces the loading state
  // below so the user doesn't get a silently-empty modal.
  const { data: backendChannels, isLoading: isLoadingChannels } =
    useChannelsWithStorage("ID");
  const channels = useMemo<ChannelOption[]>(
    () => (backendChannels ?? []).map(toChannelOption),
    [backendChannels],
  );

  const {
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<SignupFormValues>({
    defaultValues: {
      displayName: qrisExtract.merchantName ?? "",
      countryCode: "ID",
      payoutChannel: "",
      payoutAccountNumber: "",
      payoutAccountHolderName: "",
    },
    mode: "onBlur",
  });

  const pickedChannelCode = watch("payoutChannel");
  const pickedChannel = useMemo(
    () => findChannel(channels, pickedChannelCode || null),
    [channels, pickedChannelCode],
  );

  const [pickerOpen, setPickerOpen] = useState(false);

  const handlePickChannel = useCallback(
    (code: string) => {
      setValue("payoutChannel", code, { shouldValidate: true });
      // Clear a previous account-number entry whose format no longer
      // fits the newly-picked channel — avoids a stale phone number
      // lingering after the user flips from GoPay to BCA.
      setValue("payoutAccountNumber", "", { shouldValidate: false });
      setPickerOpen(false);
    },
    [setValue],
  );

  const onSubmit = useCallback(
    (values: SignupFormValues) => {
      // TODO(task 27): replace this console.log with a TanStack mutation
      // to `POST /v1/merchants/signup` carrying the payload below. Until
      // the endpoint lands, we log for QA visibility and optimistically
      // route to the merchant QR home.
      const payload = {
        displayName: values.displayName.trim(),
        contactPhone: undefined, // M1 scope: not collected on this screen
        country: values.countryCode,
        channelCode: values.payoutChannel,
        accountNumber: values.payoutAccountNumber.trim(),
        accountHolderName: values.payoutAccountHolderName.trim(),
        qrisLink:
          source === "qris" && qrisExtract.qrisPan
            ? { qrisPan: qrisExtract.qrisPan }
            : undefined,
      };
      console.log("[merchant/signup-form] MerchantSignupRequest:", payload);
      router.replace("/merchant/qr" as never);
    },
    [source, qrisExtract.qrisPan],
  );

  return (
    <>
      <SystemBars style="dark" />
      <SafeAreaView className="flex-1 bg-light-main-container">
        <View className="flex-row items-center px-4 pt-2">
          <Pressable onPress={() => router.back()} className="p-2 -ml-2">
            <ArrowLeft color="#20222c" size={24} />
          </Pressable>
        </View>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingBottom: 48 }}
          keyboardShouldPersistTaps="handled"
        >
          <View className="px-6 pt-4">
            <Text className="text-light-matte-black text-3xl font-bold mb-2">
              Your shop details
            </Text>
            <Text className="text-light-matte-black/70 text-base mb-6">
              {source === "qris"
                ? "We pre-filled your shop name from your QRIS sticker. Double-check and add your payout account."
                : "Tell us where to send the money when customers pay you."}
            </Text>

            {source === "qris" && qrisExtract.qrisPan ? (
              <View className="bg-light rounded-2xl p-4 mb-6 border border-light-matte-black/10">
                <Text className="text-light-matte-black/60 text-xs mb-1">
                  Linked QRIS
                </Text>
                <Text className="text-light-matte-black font-semibold">
                  {qrisExtract.qrisPan.slice(0, 6)}****
                  {qrisExtract.qrisPan.slice(-4)}
                </Text>
              </View>
            ) : null}

            {/* Display name */}
            <View className="mb-5">
              <Text className="text-light-matte-black font-medium mb-2">
                Shop name
              </Text>
              <Controller
                control={control}
                name="displayName"
                rules={{
                  required: "Shop name is required.",
                  maxLength: {
                    value: 80,
                    message: "Shop name is too long (max 80 characters).",
                  },
                }}
                render={({ field: { onChange, onBlur, value } }) => (
                  <TextInput
                    value={value}
                    onChangeText={onChange}
                    onBlur={onBlur}
                    placeholder="Warung Bu Ani"
                    placeholderTextColor="#20222c80"
                    className="bg-light border border-light-matte-black/15 rounded-xl px-4 py-3 text-light-matte-black text-base"
                  />
                )}
              />
              {errors.displayName ? (
                <Text className="text-light-primary-red text-xs mt-1">
                  {errors.displayName.message}
                </Text>
              ) : (
                <Text className="text-light-matte-black/50 text-xs mt-1">
                  This is what customers see at checkout.
                </Text>
              )}
            </View>

            {/* Country code */}
            <View className="mb-5">
              <Text className="text-light-matte-black font-medium mb-2">
                Country
              </Text>
              <Controller
                control={control}
                name="countryCode"
                rules={{ required: "Country is required." }}
                render={({ field: { onChange, value } }) => (
                  <TextInput
                    value={value}
                    onChangeText={(text) => onChange(text.toUpperCase())}
                    placeholder="ID"
                    placeholderTextColor="#20222c80"
                    maxLength={2}
                    autoCapitalize="characters"
                    className="bg-light border border-light-matte-black/15 rounded-xl px-4 py-3 text-light-matte-black text-base"
                  />
                )}
              />
              {errors.countryCode ? (
                <Text className="text-light-primary-red text-xs mt-1">
                  {errors.countryCode.message}
                </Text>
              ) : (
                <Text className="text-light-matte-black/50 text-xs mt-1">
                  Indonesia only for now.
                </Text>
              )}
            </View>

            {/* QRIS type */}
            <View className="mb-5">
              <Text className="text-light-matte-black font-medium mb-2">
                QRIS type
              </Text>
              <Controller
                control={control}
                name="payoutChannel"
                rules={{ required: "Pick a QRIS type." }}
                render={({ field: { value } }) => (
                  <TouchableOpacity
                    activeOpacity={0.7}
                    onPress={() => setPickerOpen(true)}
                    className="bg-light border border-light-matte-black/15 rounded-xl px-4 py-3 flex-row items-center justify-between"
                  >
                    <View className="flex-row items-center">
                      {pickedChannel ? (
                        <View className="w-8 h-8 bg-light-primary-red/10 rounded-full items-center justify-center mr-3 overflow-hidden">
                          {pickedChannel.iconUrl ? (
                            <Image
                              source={{ uri: pickedChannel.iconUrl }}
                              style={{ width: 32, height: 32 }}
                              resizeMode="contain"
                            />
                          ) : pickedChannel.kind === "ewallet" ? (
                            <Wallet color="#c71c4b" size={16} />
                          ) : (
                            <Building2 color="#c71c4b" size={16} />
                          )}
                        </View>
                      ) : null}
                      <Text
                        className={
                          value
                            ? "text-light-matte-black text-base font-medium"
                            : "text-light-matte-black/50 text-base"
                        }
                      >
                        {pickedChannel ? pickedChannel.label : "Pick a channel"}
                      </Text>
                    </View>
                    <ChevronDown color="#20222c" size={18} />
                  </TouchableOpacity>
                )}
              />
              {errors.payoutChannel ? (
                <Text className="text-light-primary-red text-xs mt-1">
                  {errors.payoutChannel.message}
                </Text>
              ) : null}
            </View>

            {/* Account number (polymorphic) */}
            <View className="mb-5">
              <Text className="text-light-matte-black font-medium mb-2">
                {pickedChannel?.kind === "bank"
                  ? "Bank account number"
                  : "Account number"}
              </Text>
              <Controller
                control={control}
                name="payoutAccountNumber"
                rules={{
                  validate: (value) =>
                    validateAccountNumber(value, pickedChannel) ?? true,
                }}
                render={({ field: { onChange, onBlur, value } }) => (
                  <TextInput
                    value={value}
                    onChangeText={(text) => {
                      // Keep digits-only for both e-wallet (Indonesian
                      // mobile) and bank — both accept decimal characters
                      // exclusively. The server-fallback (unknown kind)
                      // handles alphanumerics so we only strip when a
                      // channel with a digit-only kind is picked.
                      if (
                        pickedChannel?.kind === "ewallet" ||
                        pickedChannel?.kind === "bank"
                      ) {
                        onChange(text.replace(/\D/g, ""));
                      } else {
                        onChange(text);
                      }
                    }}
                    onBlur={onBlur}
                    placeholder={pickedChannel?.placeholder ?? "08123456789"}
                    placeholderTextColor="#20222c80"
                    keyboardType={pickedChannel?.keyboardType ?? "number-pad"}
                    maxLength={pickedChannel?.maxLength ?? 20}
                    editable={pickedChannel !== null}
                    className="bg-light border border-light-matte-black/15 rounded-xl px-4 py-3 text-light-matte-black text-base"
                  />
                )}
              />
              {errors.payoutAccountNumber ? (
                <Text className="text-light-primary-red text-xs mt-1">
                  {errors.payoutAccountNumber.message}
                </Text>
              ) : (
                <Text className="text-light-matte-black/50 text-xs mt-1">
                  {pickedChannel
                    ? pickedChannel.helper
                    : "Pick a channel above to see the expected format."}
                </Text>
              )}
            </View>

            {/* Account holder name */}
            <View className="mb-6">
              <Text className="text-light-matte-black font-medium mb-2">
                Account holder name
              </Text>
              <Controller
                control={control}
                name="payoutAccountHolderName"
                rules={{
                  required: "Account holder name is required.",
                  minLength: {
                    value: 2,
                    message: "Enter the full name on the account.",
                  },
                }}
                render={({ field: { onChange, onBlur, value } }) => (
                  <TextInput
                    value={value}
                    onChangeText={onChange}
                    onBlur={onBlur}
                    placeholder="Full name as on the account"
                    placeholderTextColor="#20222c80"
                    autoCapitalize="words"
                    className="bg-light border border-light-matte-black/15 rounded-xl px-4 py-3 text-light-matte-black text-base"
                  />
                )}
              />
              {errors.payoutAccountHolderName ? (
                <Text className="text-light-primary-red text-xs mt-1">
                  {errors.payoutAccountHolderName.message}
                </Text>
              ) : (
                <Text className="text-light-matte-black/50 text-xs mt-1">
                  Must match the name on the account.
                </Text>
              )}
            </View>

            <TouchableOpacity
              activeOpacity={0.8}
              onPress={handleSubmit(onSubmit)}
              disabled={isSubmitting}
              className="bg-light-primary-red rounded-xl py-4 items-center"
            >
              <Text className="text-light font-semibold text-base">
                {isSubmitting ? "Saving…" : "Create my shop"}
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>

        <BaseModal
          visible={pickerOpen}
          onClose={() => setPickerOpen(false)}
          backgroundColor="#fff"
          contentClassName="px-5"
        >
          <ModalHeader title="Pick a QRIS type" />
          <View>
            {channels.length === 0 ? (
              <View className="items-center py-8">
                {isLoadingChannels ? (
                  <>
                    <ActivityIndicator color="#c71c4b" />
                    <Text className="text-light-matte-black/60 text-sm mt-3">
                      Loading QRIS types…
                    </Text>
                  </>
                ) : (
                  <Text className="text-light-matte-black/60 text-sm text-center">
                    Couldn&apos;t load QRIS types. Check your connection and try
                    again.
                  </Text>
                )}
              </View>
            ) : (
              channels.map((c) => {
                const active = c.code === pickedChannelCode;
                return (
                  <TouchableOpacity
                    key={c.code}
                    activeOpacity={0.7}
                    onPress={() => handlePickChannel(c.code)}
                    className="flex-row items-center py-3 border-b border-light-matte-black/5"
                  >
                    <View className="w-10 h-10 bg-light-primary-red/10 rounded-full items-center justify-center mr-3 overflow-hidden">
                      {c.iconUrl ? (
                        <Image
                          source={{ uri: c.iconUrl }}
                          style={{ width: 40, height: 40 }}
                          resizeMode="contain"
                        />
                      ) : c.kind === "ewallet" ? (
                        <Wallet color="#c71c4b" size={18} />
                      ) : (
                        <Building2 color="#c71c4b" size={18} />
                      )}
                    </View>
                    <View className="flex-1">
                      <Text className="text-light-matte-black font-medium">
                        {c.label}
                      </Text>
                      <Text className="text-light-matte-black/50 text-xs">
                        {c.kind === "ewallet" ? "E-wallet" : "Bank"}
                      </Text>
                    </View>
                    {active ? <Check color="#c71c4b" size={18} /> : null}
                  </TouchableOpacity>
                );
              })
            )}
          </View>
        </BaseModal>
      </SafeAreaView>
    </>
  );
}
