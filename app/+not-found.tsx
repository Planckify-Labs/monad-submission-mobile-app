import { router, Stack, useFocusEffect } from "expo-router";
import { SearchX } from "lucide-react-native";
import React, { useCallback } from "react";
import { BackHandler, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

// A bad/expired deep link (e.g. `takumiwallet://<unrecognised-path>`) can
// land here as the very first screen in the stack — there's no previous
// route to pop to, so the default expo-router "Go back" and the Android
// hardware back button both fall through to backgrounding the app instead
// of taking the user anywhere useful. Route both explicitly to Home.
export default function NotFoundScreen() {
  useFocusEffect(
    useCallback(() => {
      const backHandler = BackHandler.addEventListener(
        "hardwareBackPress",
        () => {
          router.replace("/");
          return true;
        },
      );
      return () => backHandler.remove();
    }, []),
  );

  return (
    <SafeAreaView className="flex-1 bg-light-main-container" edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 items-center justify-center px-8">
        <SearchX color="#20222c" size={48} strokeWidth={1.5} />
        <Text className="text-light-matte-black text-xl font-bold mt-4">
          Page not found
        </Text>
        <Text className="text-light-matte-black/60 text-sm text-center mt-2">
          That link doesn&apos;t lead anywhere in TakumiPay.
        </Text>
        <Pressable
          onPress={() => router.replace("/")}
          className="flex-row items-center justify-center border-2 border-light-primary-red bg-light-primary-red/10 gap-2 rounded-full px-6 py-2 mt-6"
        >
          <Text className="text-light-matte-black text-sm font-bold">
            Go to Home
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
