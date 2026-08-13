import { useRouter } from "expo-router";
import { ChevronLeft, Trash2 } from "lucide-react-native";
import React, { useCallback, useSyncExternalStore } from "react";
import { Alert, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BrowserHistoryStore } from "@/services/dappsBrowser/historyStore";

/**
 * Browser privacy settings.
 *
 * The bulk "forget everything" control lives here rather than in the dApp
 * browser's connection sheet. In that sheet it sat under a list of
 * connected sites, each with its own disconnect, and a full-width
 * destructive button in that company reads as "cut off all of these" —
 * a user could believe they had revoked every connection when nothing had
 * been revoked at all. Here the frame is housekeeping, so the control says
 * what it does and there is room to explain it.
 *
 * The everyday version of this action is a long press on an address-bar
 * suggestion, which forgets one site.
 */
export default function BrowserPrivacy(): React.ReactElement {
  const router = useRouter();
  const history = useSyncExternalStore(
    BrowserHistoryStore.subscribe,
    BrowserHistoryStore.list,
  );

  const confirmClear = useCallback(() => {
    Alert.alert(
      "Clear browsing history?",
      "Recent sites will stop appearing as suggestions in the address bar. Your wallet connections are not affected.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: () => BrowserHistoryStore.clear(),
        },
      ],
    );
  }, []);

  const isEmpty = history.length === 0;

  return (
    <SafeAreaView className="flex-1 bg-light-main-container" edges={["top"]}>
      <View className="flex-row items-center px-4 py-3">
        <TouchableOpacity
          onPress={() => router.back()}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          className="w-10 h-10 rounded-full bg-white items-center justify-center mr-3"
        >
          <ChevronLeft size={20} color="#20222c" />
        </TouchableOpacity>
        <Text className="text-lg font-bold text-light-matte-black">
          Browser privacy
        </Text>
      </View>

      <ScrollView className="flex-1 px-4" showsVerticalScrollIndicator={false}>
        <View className="bg-white rounded-2xl p-4 border border-light-matte-black/10">
          <Text className="text-sm font-semibold text-light-matte-black">
            Recent sites
          </Text>
          <Text className="text-xs text-light-matte-black/55 mt-1.5 leading-5">
            The dApp browser remembers sites you have opened so the address bar
            can suggest them as you type. It stays on this device, and it never
            includes anything after the site name.
          </Text>

          <Text className="text-xs text-light-matte-black/40 mt-3">
            {isEmpty
              ? "Nothing saved yet"
              : history.length === 1
                ? "1 site saved"
                : `${history.length} sites saved`}
          </Text>

          <TouchableOpacity
            onPress={confirmClear}
            disabled={isEmpty}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityState={{ disabled: isEmpty }}
            className={`mt-4 py-3 rounded-2xl flex-row items-center justify-center ${
              isEmpty ? "bg-light-matte-black/5" : "bg-light-primary-red/10"
            }`}
          >
            <Trash2
              size={16}
              color={isEmpty ? "rgba(32,34,44,0.3)" : "#c71c4b"}
              strokeWidth={2}
            />
            <Text
              className={`text-sm font-semibold ml-2 ${
                isEmpty ? "text-light-matte-black/30" : "text-light-primary-red"
              }`}
            >
              Clear browsing history
            </Text>
          </TouchableOpacity>
        </View>

        <Text className="text-xs text-light-matte-black/40 mt-3 px-1 leading-5">
          To forget a single site, press and hold it in the address bar
          suggestions.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
