/**
 * About screen — TWV-2026-065.
 *
 * Surfaces the identity users need in order to verify they have the
 * real app:
 *   - iOS bundle ID / Android package
 *   - Expected SHA-256 of the signing certificate (iOS) / key (Android)
 *   - Version, build number, commit hash
 *   - Official distribution channels
 *   - A blunt warning against third-party "Takumi" installers
 *
 * Users can cross-check the fingerprint below against the OS report
 * (iOS Settings → General → About or a `keytool -list` / Play Store
 * listing on Android). Mismatch = not us.
 */

import Constants from "expo-constants";
import * as Linking from "expo-linking";
import { router } from "expo-router";
import { AlertTriangle, ArrowLeft, ExternalLink } from "lucide-react-native";
import React, { useMemo } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  BUILD_META,
  type BuildProfile,
  DISTRIBUTION_WARNING,
  isPlaceholderFingerprint,
  OFFICIAL_LINKS,
} from "@/constants/about";

function resolveBuildProfile(): BuildProfile {
  const extraVariant = Constants.expoConfig?.extra?.appVariant;
  if (extraVariant === "development" || extraVariant === "preview") {
    return extraVariant;
  }
  return "production";
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between items-start py-3 border-b border-light-matte-black/5">
      <Text className="text-light-matte-black/60 text-sm flex-1 pr-4">
        {label}
      </Text>
      <Text
        className="text-light-matte-black font-medium text-sm text-right flex-1"
        selectable
      >
        {value}
      </Text>
    </View>
  );
}

function LinkRow({ label, url }: { label: string; url: string }) {
  return (
    <Pressable
      onPress={() => Linking.openURL(url).catch(() => {})}
      className="flex-row justify-between items-center py-3 border-b border-light-matte-black/5"
      accessibilityRole="link"
      accessibilityLabel={`${label} — opens ${url}`}
    >
      <View className="flex-1 pr-4">
        <Text className="text-light-matte-black font-medium text-sm mb-0.5">
          {label}
        </Text>
        <Text className="text-light-matte-black/50 text-xs" numberOfLines={1}>
          {url}
        </Text>
      </View>
      <ExternalLink size={18} color="#c71c4b" />
    </Pressable>
  );
}

function ComingSoonRow({ label }: { label: string }) {
  return (
    <View className="flex-row justify-between items-center py-3 border-b border-light-matte-black/5">
      <View className="flex-1 pr-4">
        <Text className="text-light-matte-black font-medium text-sm mb-0.5">
          {label}
        </Text>
        <Text className="text-light-matte-black/50 text-xs">Coming soon</Text>
      </View>
    </View>
  );
}

export default function AboutScreen() {
  const profile = resolveBuildProfile();
  const meta = BUILD_META[profile];
  const commitHash =
    (Constants.expoConfig?.extra?.commitHash as string) ?? "local-dev";
  const version = Constants.expoConfig?.version ?? "unknown";
  const buildNumber = useMemo(() => {
    if (Platform.OS === "ios") {
      return Constants.expoConfig?.ios?.buildNumber ?? "—";
    }
    return String(Constants.expoConfig?.android?.versionCode ?? "—");
  }, []);

  const platformCert =
    Platform.OS === "ios" ? meta.signingCert.ios : meta.signingCert.android;
  const isPlaceholder = isPlaceholderFingerprint(platformCert.sha256);

  return (
    <>
      <SystemBars style="dark" />
      <SafeAreaView className="flex-1 bg-light-main-container" edges={["top"]}>
        <ScrollView
          className="flex-1 px-6"
          contentContainerStyle={{ paddingBottom: 32 }}
        >
          <Pressable onPress={() => router.back()} className="my-4">
            <ArrowLeft color="#c71c4b" size={24} />
          </Pressable>

          <Text className="text-light-matte-black text-3xl font-bold mb-1">
            About TakumiPay
          </Text>
          {/*
            Show the build-profile badge ONLY on non-production builds so
            a developer can tell a dev / preview binary apart from the
            shipped one. End users on production see nothing here.
          */}
          {profile !== "production" ? (
            <Text className="text-light-primary-red text-xs font-semibold mb-6 uppercase tracking-wide">
              {profile} build
            </Text>
          ) : (
            <View className="mb-6" />
          )}

          {/* Warning */}
          <View className="bg-light-primary-red/10 rounded-2xl p-4 mb-6 flex-row">
            <AlertTriangle
              size={20}
              color="#c71c4b"
              strokeWidth={2}
              style={{ marginTop: 2, marginRight: 8 }}
            />
            <Text className="text-light-matte-black text-sm flex-1 leading-5">
              {DISTRIBUTION_WARNING}
            </Text>
          </View>

          {/* Official links */}
          <Text className="text-light-matte-black font-bold text-lg mb-2">
            Official channels
          </Text>
          <View className="bg-light rounded-2xl px-4 mb-6">
            {OFFICIAL_LINKS.appStore ? (
              <LinkRow label="Apple App Store" url={OFFICIAL_LINKS.appStore} />
            ) : (
              <ComingSoonRow label="Apple App Store" />
            )}
            <LinkRow label="Google Play Store" url={OFFICIAL_LINKS.playStore} />
            <LinkRow label="Website" url={OFFICIAL_LINKS.website} />
            {Object.entries(OFFICIAL_LINKS.socials).map(([platform, url]) => (
              <LinkRow key={platform} label={platform} url={url} />
            ))}
          </View>

          {/* App identity */}
          <Text className="text-light-matte-black font-bold text-lg mb-2">
            App identity
          </Text>
          <View className="bg-light rounded-2xl px-4 mb-6">
            {/*
              Only show the identity row for the platform the user is
              actually running on — the other one is noise.
            */}
            {Platform.OS === "ios" ? (
              <Row label="iOS Bundle ID" value={meta.iosBundleId} />
            ) : (
              <Row label="Android Package" value={meta.androidPackage} />
            )}
            <Row label="Version" value={version} />
            <Row label="Build" value={buildNumber} />
            {/*
              Commit hash is useful for fingerprint verification AND
              bug reports — but only when it's a real git SHA. On a
              local `pnpm start` the value is "local-dev", which means
              nothing to a user. Hide it in that case.
            */}
            {commitHash !== "local-dev" ? (
              <Row label="Commit" value={commitHash} />
            ) : null}
          </View>

          {/* Signing certificate fingerprint */}
          {/* hidden for now */}
          <Text className="text-light-matte-black font-bold text-lg mb-2 hidden">
            Signing certificate
          </Text>
          <View className="bg-light rounded-2xl px-4 mb-3">
            <Row label={platformCert.label} value="SHA-256" />
            <View className="py-3">
              <Text
                className="text-light-matte-black font-mono text-xs leading-5"
                selectable
              >
                {platformCert.sha256}
              </Text>
            </View>
          </View>

          {isPlaceholder ? (
            <View className="bg-light-primary-red/10 rounded-2xl p-4 mb-6">
              <Text className="text-light-matte-black text-xs leading-5">
                Fingerprint not yet populated for this build profile. The
                security team will publish the real SHA-256 before the
                production binary ships — until then, treat this value as a
                placeholder rather than a verification target.
              </Text>
            </View>
          ) : (
            <Text className="text-light-matte-black/60 text-xs leading-5 mb-6">
              Compare this fingerprint to what your OS reports for the installed
              app. iOS: Settings → General → About. Android: Play Store listing
              or `keytool -printcert -jarfile`. A mismatch means the binary was
              not signed by us.
            </Text>
          )}
        </ScrollView>
      </SafeAreaView>
    </>
  );
}
