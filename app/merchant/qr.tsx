/**
 * Merchant QR home (spec §1.1.1 step 4, §4.4 `takumipay:v1:` JWS payload,
 * milestone M1). Landing screen after a merchant completes signup in
 * `app/merchant/signup-form.tsx` (task 12) — their day-to-day
 * relationship with TakumiPay: show QR, let customers scan, collect.
 *
 * M1 stub behaviour — the real signed JWS is minted server-side by
 * `takumipay-api` (task 27, M3). Until that endpoint lands this screen
 * renders a locally-constructed placeholder payload so QA can exercise
 * Save-to-Photos + Share-Sheet against a physically scannable QR, even
 * though the QR decodes to a non-authoritative string. The muted header
 * card below the QR makes the stub obvious so nobody ships this
 * thinking it's production-ready.
 *
 * Copy-audience rule (spec §1.1) — merchants are non-crypto users.
 * Zero USDC / chain / gas / signature language on this screen. Allowed:
 * "TakumiPay", "merchant", "QR", "shop".
 *
 * Three-role separation (memory `feedback_role_separation.md`): this
 * screen only renders a payload. No signing happens client-side — the
 * real payload is a server-minted JWS the app displays as-is. The M1
 * stub mirrors that contract (the screen doesn't sign anything, it
 * just encodes a pre-built string).
 *
 * Chain-extension discipline: no namespace branches here. QR display
 * is chain-agnostic surface.
 */

import * as MediaLibrary from "expo-media-library";
import { router } from "expo-router";
import { ArrowLeft, Download, Share2 as ShareIcon } from "lucide-react-native";
import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  Share,
  Text,
  ToastAndroid,
  TouchableOpacity,
  View,
} from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import QRCodeStyled from "react-native-qrcode-styled";
import { SafeAreaView } from "react-native-safe-area-context";
import { captureRef } from "react-native-view-shot";

/**
 * Cross-platform toast shim — mirrors `app/merchant/signup-intro.tsx`.
 * iOS has no `ToastAndroid`, so we fall back to `console.warn`. Task 44
 * will upgrade this to a proper UI toast component.
 */
const showToast = (message: string) => {
  if (ToastAndroid && typeof ToastAndroid.show === "function") {
    ToastAndroid.show(message, ToastAndroid.SHORT);
    return;
  }
  console.warn(message);
};

/**
 * Deterministic-ish placeholder payload for M1. Shape follows
 * `takumipay:v1:<opaque>` (spec §4.4) so any future TakumiPay detector
 * that does a prefix check still routes the QR to the right handler.
 * The `m1-stub-` discriminator + 12-char nonce keeps every generated QR
 * unique enough for QA to tell two devices apart in a side-by-side,
 * while flagging to anyone inspecting the payload that this is NOT a
 * real JWS. Replaced in M3 by `merchantProfile.qr.jws` (task 27).
 */
const buildStubPayload = (): string => {
  const nonce = Array.from({ length: 12 }, () =>
    Math.floor(Math.random() * 36).toString(36),
  ).join("");
  return `takumipay:v1:m1-stub-${nonce}`;
};

// Module-scope QR styling — memoizing the QR component means these
// objects cannot be inlined in JSX (inline object identities break
// `React.memo` prop equality, same pattern as `RecievePaymentModal`).
const QR_SVG_STYLE = { backgroundColor: "#ffffff" } as const;
const QR_GRADIENT = {
  type: "linear" as const,
  options: {
    colors: ["#c71c4b", "#20222c"],
    start: [0, 0] as [number, number],
    end: [1, 1] as [number, number],
  },
};
const QR_OUTER_EYES = {
  topLeft: { borderRadius: 15, color: "#c71c4b" },
  topRight: { borderRadius: 15, color: "#c71c4b" },
  bottomLeft: { borderRadius: 15, color: "#c71c4b" },
};
const QR_INNER_EYES = { borderRadius: 10, color: "#20222c" };

export default function MerchantQrHome() {
  // Build the payload once per mount. The QR matches the merchant's
  // session but is stable across re-renders so the rendered SVG
  // doesn't thrash and the Save/Share buttons always capture the same
  // payload the user is looking at. In M3 this becomes
  // `useMerchantProfile().data.qr.jws`.
  const payload = useMemo(() => buildStubPayload(), []);

  // `captureRef` walks the native view tree from this host node. We
  // wrap ONLY the QR (not the whole card) so the saved PNG is a clean
  // QR-on-white asset suitable for printing as a sticker. No muted
  // "M3 placeholder" banner ends up in the exported image.
  const qrContainerRef = useRef<View>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSharing, setIsSharing] = useState(false);

  const captureQrPng = useCallback(async (): Promise<string> => {
    // 400×400 per spec §11.1 printability guidance — business-card
    // sticker prints stay crisp at that density. PNG keeps the QR
    // modules lossless so scanners don't choke on JPEG ringing.
    return await captureRef(qrContainerRef, {
      format: "png",
      quality: 1,
      result: "tmpfile",
      width: 400,
      height: 400,
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      const { status, canAskAgain } =
        await MediaLibrary.requestPermissionsAsync(true);
      if (status !== "granted") {
        // Spec + task constraint: graceful denial. If the user has
        // permanently refused (`canAskAgain === false` on iOS) the
        // toast steers them to Settings; otherwise the same copy still
        // reads as actionable.
        showToast(
          canAskAgain
            ? "Allow photo library access to save."
            : "Allow photo library access in Settings to save.",
        );
        return;
      }

      const uri = await captureQrPng();
      await MediaLibrary.saveToLibraryAsync(uri);
      showToast("Saved to Photos.");
    } catch (err) {
      console.warn("[merchant/qr] save failed:", err);
      showToast("Couldn't save QR. Try again.");
    } finally {
      setIsSaving(false);
    }
  }, [captureQrPng, isSaving]);

  const handleShare = useCallback(async () => {
    if (isSharing) return;
    setIsSharing(true);
    try {
      const uri = await captureQrPng();
      // React Native core `Share` API — no extra dep. iOS accepts
      // `url` (file:// is fine), Android accepts `message` +
      // optional `url`. We pass both so the sticker surfaces in
      // WhatsApp/Gmail alongside a human-readable caption.
      const shareUrl =
        Platform.OS === "android" && !uri.startsWith("file://")
          ? `file://${uri}`
          : uri;
      await Share.share(
        {
          title: "My TakumiPay QR",
          message: "Scan to pay my shop on TakumiPay.",
          url: shareUrl,
        },
        { dialogTitle: "Share my TakumiPay QR" },
      );
    } catch (err) {
      console.warn("[merchant/qr] share failed:", err);
      showToast("Couldn't open share sheet.");
    } finally {
      setIsSharing(false);
    }
  }, [captureQrPng, isSharing]);

  return (
    <>
      <SystemBars style="dark" />
      <SafeAreaView className="flex-1 bg-light-main-container">
        <View className="flex-row items-center px-4 pt-2">
          <Pressable onPress={() => router.back()} className="p-2 -ml-2">
            <ArrowLeft color="#20222c" size={24} />
          </Pressable>
        </View>

        <View className="flex-1 px-6 pt-4">
          <Text className="text-light-matte-black text-3xl font-bold mb-2">
            Your shop QR
          </Text>
          <Text className="text-light-matte-black/70 text-base mb-5">
            Show this QR to receive payments from customers.
          </Text>

          {/*
            Stub banner — deliberately loud (amber) so QA and reviewers
            can't miss that this is an M1 placeholder. Removed in M3
            when the server-issued JWS arrives via `useMerchantProfile`
            (task 27).
          */}
          <View className="bg-amber-100 border border-amber-300 rounded-xl px-4 py-3 mb-6">
            <Text className="text-amber-900 text-xs font-semibold mb-0.5">
              Preview only
            </Text>
            <Text className="text-amber-900/80 text-xs">
              Merchant profile pending backend issuance (M3). This QR is a
              placeholder — your real printable QR appears here once signup is
              live.
            </Text>
          </View>

          <View className="flex-1 items-center">
            <View
              ref={qrContainerRef}
              collapsable={false}
              className="bg-white rounded-3xl p-6 shadow-sm"
              style={{ width: 296, height: 296 }}
            >
              <QRCodeStyled
                data={payload}
                style={QR_SVG_STYLE}
                padding={8}
                size={248}
                pieceBorderRadius={3.5}
                isPiecesGlued={true}
                color="#20222c"
                gradient={QR_GRADIENT}
                outerEyesOptions={QR_OUTER_EYES}
                innerEyesOptions={QR_INNER_EYES}
                errorCorrectionLevel="M"
              />
            </View>

            <View className="w-full mt-6 gap-3">
              <TouchableOpacity
                activeOpacity={0.8}
                onPress={handleSave}
                disabled={isSaving}
                className="bg-light-primary-red rounded-xl py-4 flex-row items-center justify-center gap-2"
              >
                <Download color="#ffffff" size={18} />
                <Text className="text-light font-semibold text-base">
                  {isSaving ? "Saving…" : "Save to Photos"}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                activeOpacity={0.8}
                onPress={handleShare}
                disabled={isSharing}
                className="bg-light border border-light-matte-black/15 rounded-xl py-4 flex-row items-center justify-center gap-2"
              >
                <ShareIcon color="#20222c" size={18} />
                <Text className="text-light-matte-black font-semibold text-base">
                  {isSharing ? "Opening…" : "Share"}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </SafeAreaView>
    </>
  );
}
