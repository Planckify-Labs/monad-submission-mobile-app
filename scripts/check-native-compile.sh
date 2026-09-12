#!/usr/bin/env bash
# check-native-compile.sh — compile the project's own native modules the way
# EAS does, without a 15-minute EAS build.
#
# A bare `kotlinc` cannot do this: the modules compile against
# expo-modules-core and the Android SDK, which only exist as classes after
# Gradle builds them. So this runs the exact Gradle compile tasks for the
# local Expo modules (modules/*), the vendored MWA walletlib fork and the
# pnpm-patched React Native walletlib bridge. `--configure-on-demand` keeps
# `:app` (NDK, CMake) out of it; the JVM flags keep it inside ~2 GB so it
# does not freeze a laptop.
#
# First run downloads Gradle dependencies (minutes); later runs take about
# 3-6 minutes. `android/` is regenerated first (CNG), so local edits there
# are expected to be discarded.
set -euo pipefail
cd "$(dirname "$0")/.."

export NODE_OPTIONS=--max-old-space-size=2048
nice -n 19 ionice -c 3 npx expo prebuild --platform android --no-install

TASKS=(
  ":app-minimizer:compileReleaseKotlin"
  ":agent-keep-alive:compileReleaseKotlin"
  ":mwa-walletlib:compileReleaseJavaWithJavac"
  ":solana-mobile_mobile-wallet-adapter-walletlib:compileReleaseKotlin"
)

cd android
nice -n 19 ionice -c 3 ./gradlew \
  --configure-on-demand --max-workers=1 --no-daemon --console=plain \
  -Dorg.gradle.jvmargs="-Xmx1536m -XX:MaxMetaspaceSize=384m" \
  -Pkotlin.compiler.execution.strategy=in-process \
  "${TASKS[@]}"

echo "native-compile check: OK — ${#TASKS[@]} module compile tasks passed."
