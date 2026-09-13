import * as Clipboard from "expo-clipboard";
import { router, useLocalSearchParams } from "expo-router";
import {
  BookUser,
  Check,
  CheckCircle,
  ChevronRight,
  Copy,
  ExternalLink,
  X,
} from "lucide-react-native";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Linking,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import { SafeAreaView } from "react-native-safe-area-context";
import type { TCreateAddressBookDto } from "@/api/types/addressBook";
import AddContactModal from "@/components/address-book/AddContactModal";
import { useAddressBook } from "@/hooks/useAddressBook";

function shortAddress(address: string): string {
  if (!address) return "";
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function shortHash(hash: string): string {
  if (!hash) return "";
  if (hash.length <= 18) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

function pickParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export default function SendSuccessScreen() {
  const params = useLocalSearchParams();
  const amount = pickParam(params.amount);
  const symbol = pickParam(params.symbol);
  const chainLabel = pickParam(params.chainLabel);
  const recipientAddress = pickParam(params.recipientAddress);
  const txHash = pickParam(params.txHash);
  const explorerUrl = pickParam(params.explorerUrl);
  const chainBackendName = pickParam(params.chainBackendName);
  const gasFeeSymbol = pickParam(params.gasFeeSymbol);
  const gasFeeAmount = pickParam(params.gasFeeAmount);
  // The exact fee is known only on the abstracted (USDC) path; on the
  // native path we still tell the user which token paid for gas.
  const networkFeeText = gasFeeSymbol
    ? gasFeeAmount
      ? `${gasFeeAmount} ${gasFeeSymbol}`
      : `Paid in ${gasFeeSymbol}`
    : "";

  const { allContacts, add: addContact, isAdding, addError } = useAddressBook();

  const [copied, setCopied] = useState(false);
  const [addContactVisible, setAddContactVisible] = useState(false);

  const checkScale = useRef(new Animated.Value(0)).current;
  const ringScale = useRef(new Animated.Value(0.6)).current;
  const ringOpacity = useRef(new Animated.Value(0.5)).current;
  const heroOpacity = useRef(new Animated.Value(0)).current;
  const heroTranslate = useRef(new Animated.Value(12)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(heroOpacity, {
        toValue: 1,
        duration: 260,
        useNativeDriver: true,
      }),
      Animated.spring(heroTranslate, {
        toValue: 0,
        tension: 70,
        friction: 9,
        useNativeDriver: true,
      }),
    ]).start();

    Animated.sequence([
      Animated.delay(120),
      Animated.parallel([
        Animated.spring(checkScale, {
          toValue: 1,
          tension: 90,
          friction: 6,
          useNativeDriver: true,
        }),
        Animated.timing(ringScale, {
          toValue: 1.4,
          duration: 600,
          useNativeDriver: true,
        }),
        Animated.timing(ringOpacity, {
          toValue: 0,
          duration: 600,
          useNativeDriver: true,
        }),
      ]),
    ]).start();
  }, [checkScale, ringScale, ringOpacity, heroOpacity, heroTranslate]);

  const canPromptSave = useMemo(() => {
    if (!recipientAddress) return false;
    const recipientLower = recipientAddress.toLowerCase();
    return !allContacts.some((c) => c.address.toLowerCase() === recipientLower);
  }, [recipientAddress, allContacts]);

  const handleCopyHash = async () => {
    if (!txHash) return;
    try {
      await Clipboard.setStringAsync(txHash);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (error) {
      console.warn("Failed to copy tx hash:", error);
    }
  };

  const handleOpenExplorer = () => {
    if (!explorerUrl) return;
    Linking.openURL(explorerUrl).catch((err) => {
      console.warn("Failed to open explorer URL:", err);
    });
  };

  const handleDone = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/");
    }
  };

  const handleOpenAddContact = () => {
    setAddContactVisible(true);
  };

  const handleAddContactSave = async (dto: TCreateAddressBookDto) => {
    try {
      await addContact(dto);
      setAddContactVisible(false);
      handleDone();
    } catch {
      // Inline error renders inside AddContactModal via saveError.
    }
  };

  const handleAddContactClose = () => {
    setAddContactVisible(false);
  };

  return (
    <>
      <SystemBars style="dark" />
      <SafeAreaView
        className="flex-1 bg-light-main-container"
        edges={["top", "bottom"]}
      >
        <View className="flex-row items-center justify-end px-6 pt-2 pb-2">
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={handleDone}
            hitSlop={10}
            className="w-9 h-9 rounded-full bg-light items-center justify-center"
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <X size={18} color="#20222c" strokeWidth={2.25} />
          </TouchableOpacity>
        </View>

        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 24 }}
          showsVerticalScrollIndicator={false}
        >
          <Animated.View
            style={{
              opacity: heroOpacity,
              transform: [{ translateY: heroTranslate }],
            }}
            className="items-center mt-6 mb-6"
          >
            <View className="w-28 h-28 items-center justify-center mb-4">
              <Animated.View
                style={{
                  position: "absolute",
                  width: 112,
                  height: 112,
                  borderRadius: 56,
                  backgroundColor: "#10b98126",
                  transform: [{ scale: ringScale }],
                  opacity: ringOpacity,
                }}
              />
              <Animated.View
                style={{ transform: [{ scale: checkScale }] }}
                className="w-24 h-24 rounded-full bg-green-100 items-center justify-center"
              >
                <CheckCircle size={56} color="#10b981" strokeWidth={2} />
              </Animated.View>
            </View>

            <Text className="text-light-matte-black text-2xl font-bold text-center">
              Transfer Successful
            </Text>
            <Text className="text-light-matte-black/60 text-sm text-center mt-1.5 px-4">
              Your transaction has been submitted to the network
            </Text>
          </Animated.View>

          <View className="items-center mb-6">
            <Text
              className="text-light-matte-black text-3xl font-extrabold text-center"
              style={{ letterSpacing: -0.5 }}
            >
              {amount}{" "}
              <Text className="text-light-matte-black/55 text-xl font-bold">
                {symbol}
              </Text>
            </Text>
            {chainLabel ? (
              <View className="mt-2 px-3 py-1 rounded-full bg-light-primary-red/10">
                <Text className="text-light-primary-red text-xs font-bold tracking-wide">
                  {chainLabel}
                </Text>
              </View>
            ) : null}
          </View>

          <View className="bg-light rounded-2xl p-4 shadow-sm mb-3">
            <View className="flex-row items-center justify-between py-2">
              <Text className="text-light-matte-black/60 text-sm">To</Text>
              <Text className="text-light-matte-black text-sm font-semibold">
                {shortAddress(recipientAddress)}
              </Text>
            </View>
            <View className="h-px bg-light-matte-black/10" />
            <View className="flex-row items-center justify-between py-2">
              <Text className="text-light-matte-black/60 text-sm">Tx hash</Text>
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={handleCopyHash}
                hitSlop={6}
                className="flex-row items-center gap-1.5"
              >
                <Text className="text-light-matte-black text-sm font-semibold">
                  {shortHash(txHash)}
                </Text>
                {copied ? (
                  <Check size={14} color="#16a34a" strokeWidth={2.5} />
                ) : (
                  <Copy size={14} color="#c71c4b" strokeWidth={2} />
                )}
              </TouchableOpacity>
            </View>
            {networkFeeText ? (
              <>
                <View className="h-px bg-light-matte-black/10" />
                <View className="flex-row items-center justify-between py-2">
                  <Text className="text-light-matte-black/60 text-sm">
                    Network fee
                  </Text>
                  <Text className="text-light-matte-black text-sm font-semibold">
                    {networkFeeText}
                  </Text>
                </View>
              </>
            ) : null}
          </View>

          {explorerUrl ? (
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={handleOpenExplorer}
              className="flex-row items-center justify-center gap-1.5 py-3 mb-2"
            >
              <ExternalLink size={16} color="#c71c4b" strokeWidth={2.25} />
              <Text className="text-light-primary-red text-sm font-semibold">
                View on explorer
              </Text>
            </TouchableOpacity>
          ) : null}

          {canPromptSave ? (
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={handleOpenAddContact}
              className="bg-light rounded-2xl p-4 flex-row items-center mt-2"
            >
              <View className="w-10 h-10 rounded-full bg-light-primary-red/15 items-center justify-center mr-3">
                <BookUser size={20} color="#c71c4b" strokeWidth={2.25} />
              </View>
              <View className="flex-1">
                <Text className="text-light-matte-black font-semibold text-sm">
                  Save to address book
                </Text>
                <Text className="text-light-matte-black/60 text-xs mt-0.5">
                  Send to this address again easily
                </Text>
              </View>
              <ChevronRight size={20} color="#c71c4b" strokeWidth={2.25} />
            </TouchableOpacity>
          ) : null}
        </ScrollView>

        <View className="px-6 pt-3 pb-2">
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={handleDone}
            className="bg-light-primary-red py-4 rounded-full items-center justify-center"
          >
            <Text className="text-light font-bold text-base">Done</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      <AddContactModal
        visible={addContactVisible}
        onClose={handleAddContactClose}
        onSave={handleAddContactSave}
        prefill={{
          address: recipientAddress,
          chainName: chainBackendName || undefined,
        }}
        isSaving={isAdding}
        saveError={addError as Error | null}
      />
    </>
  );
}
