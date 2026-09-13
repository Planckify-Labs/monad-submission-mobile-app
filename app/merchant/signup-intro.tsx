/**
 * Merchant onboarding — scan-or-manual fork (spec §1.1.1 step 2,
 * milestone M1). This is the first screen after tapping "Register as
 * Merchant" on `app/login.tsx` (task 10). It forks the path into:
 *
 *   - Scan my QRIS sticker → camera, decode EMVCo locally, route to
 *     `/merchant/signup-form?source=qris&qris=<raw>`.
 *   - Pick from my gallery → system image picker, decode the QR
 *     statically via `Camera.scanFromURLAsync`, route same as scan.
 *   - Enter my details manually → straight to
 *     `/merchant/signup-form?source=manual`.
 *
 * Copy-audience rule (spec §1.1): merchants are non-crypto users, so
 * NO USDC / chain / gas language appears on this screen. Allowed:
 * "TakumiPay", "merchant", "QRIS", "sticker".
 *
 * Three-role separation (memory `feedback_role_separation.md`): this
 * screen only classifies and routes. No server calls, no signup POST
 * (that's task 12, eventually M3 backend).
 *
 * Chain-extension discipline (memory
 * `feedback_chain_extension_discipline.md`): the scan branch imports
 * `qrisDetector` by name because QRIS is the ONLY scan target on this
 * surface per §1.1.1 — this is a legitimate single-purpose detector
 * call, not a namespace branch.
 */

import { type BarcodeScanningResult, Camera, CameraView } from "expo-camera";
import { router } from "expo-router";
import {
  ArrowLeft,
  Camera as CameraIcon,
  ImageIcon,
  Pencil,
} from "lucide-react-native";
import React, { useCallback, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  ToastAndroid,
  TouchableOpacity,
  View,
} from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  NoQrInImageError,
  PickCanceledError,
  PickPermissionDeniedError,
  pickQrFromGallery,
} from "@/services/paymentIntent";
import { qrisDetector } from "@/services/paymentIntent/detectors";

/**
 * Cross-platform toast shim — mirrors `app/scan-to-pay.tsx`. iOS has
 * no ToastAndroid so we fall back to `console.warn`. Task 44 (error-
 * matrix component) will upgrade this to a proper UI toast.
 */
const showToast = (message: string) => {
  if (ToastAndroid && typeof ToastAndroid.show === "function") {
    ToastAndroid.show(message, ToastAndroid.SHORT);
    return;
  }
  console.warn(message);
};

type Mode = "intro" | "scanning";

export default function MerchantSignupIntro() {
  const [mode, setMode] = useState<Mode>("intro");
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [scanned, setScanned] = useState(false);

  const handlePressScan = useCallback(async () => {
    const { status } = await Camera.requestCameraPermissionsAsync();
    setHasPermission(status === "granted");
    setScanned(false);
    setMode("scanning");
  }, []);

  const handlePressManual = useCallback(() => {
    router.push("/merchant/signup-form?source=manual" as never);
  }, []);

  // Route a decoded raw string through the QRIS detector and navigate
  // on success. Shared by the live-camera `onBarcodeScanned` path and
  // the gallery-pick path — both sources produce the same raw-string
  // shape, so this is the single validation + routing funnel.
  const handleDecodedRaw = useCallback(async (raw: string) => {
    // QRIS is the only scan target on this surface (spec §1.1.1).
    // `Promise.resolve` collapses the `Detector.detect` sync/async
    // union so this call site stays robust if the QRIS detector is
    // ever refactored to do async work.
    const intent = await Promise.resolve(qrisDetector.detect(raw));

    if (!intent || intent.channel.kind !== "merchant") {
      showToast("Couldn't read QRIS, try manually");
      setScanned(false);
      return;
    }

    router.replace(
      `/merchant/signup-form?source=qris&qris=${encodeURIComponent(raw)}` as never,
    );
  }, []);

  const handleBarCodeScanned = useCallback(
    async (result: BarcodeScanningResult) => {
      if (scanned) return;
      setScanned(true);
      await handleDecodedRaw(result.data.trim());
    },
    [scanned, handleDecodedRaw],
  );

  const handlePressGallery = useCallback(async () => {
    if (scanned) return;
    setScanned(true);
    try {
      const raw = await pickQrFromGallery();
      await handleDecodedRaw(raw);
    } catch (err) {
      if (err instanceof PickCanceledError) {
        // Silent — user backed out of the picker.
      } else if (err instanceof PickPermissionDeniedError) {
        showToast("Allow photo library access to pick your QRIS");
      } else if (err instanceof NoQrInImageError) {
        showToast("No QRIS code found in that image");
      } else {
        console.warn("[signup-intro] gallery pick failed:", err);
        showToast("Couldn't read that image");
      }
      setScanned(false);
    }
  }, [scanned, handleDecodedRaw]);

  const handleCancelScan = useCallback(() => {
    setMode("intro");
    setScanned(false);
  }, []);

  if (mode === "scanning") {
    if (hasPermission === null) {
      return (
        <SafeAreaView className="flex-1 bg-black">
          <Text className="text-white text-center p-4">
            Requesting camera permission...
          </Text>
        </SafeAreaView>
      );
    }

    if (hasPermission === false) {
      return (
        <SafeAreaView className="flex-1 bg-black">
          <Text className="text-white text-center p-4">
            No access to camera
          </Text>
          <Pressable
            className="bg-light-primary-red p-3 rounded-lg m-5 items-center"
            onPress={handleCancelScan}
          >
            <Text className="text-white font-bold">Go Back</Text>
          </Pressable>
        </SafeAreaView>
      );
    }

    return (
      <>
        <SystemBars style="light" />
        <SafeAreaView className="flex-1 bg-black" edges={[]}>
          <View className="flex-1 overflow-hidden relative">
            <CameraView
              style={StyleSheet.absoluteFillObject}
              facing="back"
              barcodeScannerSettings={{
                barcodeTypes: ["qr"],
              }}
              onBarcodeScanned={handleBarCodeScanned}
            />

            <View className="absolute inset-0 bg-black/50 justify-center items-center">
              <View className="w-[250px] h-[250px] border-4 border-matte-black bg-transparent rounded-2xl" />
            </View>
          </View>

          <View className="flex-row items-center p-4 absolute top-8 left-0 right-0 z-10">
            <Pressable onPress={handleCancelScan} className="mr-4">
              <ArrowLeft color="#ffffff" size={24} />
            </Pressable>
            <Text className="text-light-main-container text-lg font-bold bg-light-matte-black/70 px-4 py-1 rounded-full">
              Scan your QRIS sticker
            </Text>
          </View>

          <View className="p-5 items-center absolute bottom-8 left-0 right-0">
            <Text className="text-white text-center bg-light-matte-black/70 px-4 py-1 rounded-full mb-3">
              Aim at your QRIS sticker to get started
            </Text>
            <Pressable
              onPress={handlePressGallery}
              className="flex-row items-center bg-white/95 px-5 py-3 rounded-full"
              accessibilityRole="button"
              accessibilityLabel="Pick a QRIS image from your gallery"
            >
              <ImageIcon color="#20222c" size={18} />
              <Text className="text-light-matte-black font-semibold ml-2">
                Pick from gallery
              </Text>
            </Pressable>
          </View>
        </SafeAreaView>
      </>
    );
  }

  return (
    <>
      <SystemBars style="dark" />
      <SafeAreaView className="flex-1 bg-light-main-container">
        <View className="flex-row items-center px-4 pt-2">
          <Pressable onPress={() => router.back()} className="p-2 -ml-2">
            <ArrowLeft color="#20222c" size={24} />
          </Pressable>
        </View>

        <View className="flex-1 px-6 pt-6">
          <Text className="text-light-matte-black text-3xl font-bold mb-2">
            Register as Merchant
          </Text>
          <Text className="text-light-matte-black/70 text-base mb-8">
            Let&apos;s set up your shop in TakumiPay.
          </Text>

          <TouchableOpacity
            activeOpacity={0.7}
            className="bg-light rounded-2xl p-5 mb-4 border border-light-matte-black/10"
            onPress={handlePressScan}
          >
            <View className="flex-row items-center">
              <View className="w-12 h-12 bg-light-primary-red/10 rounded-full items-center justify-center mr-4">
                <CameraIcon color="#c71c4b" size={22} />
              </View>
              <View className="flex-1">
                <Text className="text-light-matte-black font-semibold text-base mb-1">
                  Scan my QRIS sticker
                </Text>
                <Text className="text-light-matte-black/60 text-sm">
                  Use your phone camera to read the QRIS you already have.
                </Text>
              </View>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            activeOpacity={0.7}
            className="bg-light rounded-2xl p-5 mb-4 border border-light-matte-black/10"
            onPress={handlePressGallery}
          >
            <View className="flex-row items-center">
              <View className="w-12 h-12 bg-light-primary-red/10 rounded-full items-center justify-center mr-4">
                <ImageIcon color="#c71c4b" size={22} />
              </View>
              <View className="flex-1">
                <Text className="text-light-matte-black font-semibold text-base mb-1">
                  Pick from my gallery
                </Text>
                <Text className="text-light-matte-black/60 text-sm">
                  Choose a photo of your QRIS sticker from your phone.
                </Text>
              </View>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            activeOpacity={0.7}
            className="bg-light rounded-2xl p-5 mb-4 border border-light-matte-black/10"
            onPress={handlePressManual}
          >
            <View className="flex-row items-center">
              <View className="w-12 h-12 bg-light-primary-red/10 rounded-full items-center justify-center mr-4">
                <Pencil color="#c71c4b" size={22} />
              </View>
              <View className="flex-1">
                <Text className="text-light-matte-black font-semibold text-base mb-1">
                  Enter my details manually
                </Text>
                <Text className="text-light-matte-black/60 text-sm">
                  No QRIS sticker yet? Type your shop details instead.
                </Text>
              </View>
            </View>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </>
  );
}
