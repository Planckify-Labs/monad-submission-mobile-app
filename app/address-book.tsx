import { useFocusEffect } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import {
  ArrowLeft,
  BookUser,
  Plus,
  Search,
  Shield,
  X,
} from "lucide-react-native";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  Text,
  TextInput,
  ToastAndroid,
  TouchableOpacity,
  View,
} from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import type { TCreateAddressBookDto } from "@/api/types/addressBook";
import AddContactModal from "@/components/address-book/AddContactModal";
import AddressBookItem from "@/components/address-book/AddressBookItem";
import EmptyState from "@/components/address-book/EmptyState";
import type { TAddressBookEntry } from "@/constants/types/addressBookTypes";
import { useIsAuthenticated } from "@/hooks/queries/useAuth";
import { useAddressBook } from "@/hooks/useAddressBook";
import { useWallet } from "@/hooks/useWallet";
import { getChainFamilyLabel } from "@/services/walletKit/chainInfo";

export default function AddressBook() {
  const { isAuthenticated, hadPreviousSession } = useIsAuthenticated();
  const { activeWallet } = useWallet();
  const chainFamily = getChainFamilyLabel(activeWallet?.namespace);
  // Send-screen-style yield hack for the sign-in CTA: flip the button to
  // a spinner, wait 100 ms so React commits + paints that frame, THEN
  // fire the navigation. Without the yield, the `router.push` triggers
  // an immediate mount of `/auth` that freezes the main thread through
  // the transition animation — the button press feels dead even though
  // we already set the pressed state.
  const [navigatingToAuth, setNavigatingToAuth] = useState(false);
  const goToAuth = useCallback(async () => {
    if (navigatingToAuth) return;
    setNavigatingToAuth(true);
    await new Promise((r) => setTimeout(r, 100));
    router.push("/auth");
  }, [navigatingToAuth]);
  // Reset the spinner when the user comes back to this screen — e.g.
  // they cancelled on `/auth`. Without this, the button stays in the
  // "Opening sign-in…" state forever until the screen unmounts.
  useFocusEffect(
    useCallback(() => {
      setNavigatingToAuth(false);
    }, []),
  );
  const {
    contacts,
    search,
    setSearch,
    add,
    update,
    remove,
    refetch,
    isAdding,
    isUpdating,
    addError,
  } = useAddressBook();
  const [showModal, setShowModal] = useState(false);
  const [editingEntry, setEditingEntry] = useState<TAddressBookEntry | null>(
    null,
  );
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const searchRef = useRef<TextInput>(null);
  const { bottom } = useSafeAreaInsets();
  const bottomOffset = Platform.OS === "ios" ? 0 : bottom > 0 ? bottom : 16;

  const handleCopy = useCallback(async (address: string) => {
    await Clipboard.setStringAsync(address);
    if (Platform.OS === "android") {
      ToastAndroid.show("Address copied", ToastAndroid.SHORT);
    } else {
      Alert.alert("Copied", "Address copied to clipboard", [{ text: "OK" }]);
    }
  }, []);

  const handleEdit = useCallback((entry: TAddressBookEntry) => {
    setEditingEntry(entry);
    setShowModal(true);
  }, []);

  const handleDelete = useCallback(
    (id: string) => {
      Alert.alert(
        "Delete Contact",
        "Remove this contact from your address book?",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: () => remove(id) },
        ],
      );
    },
    [remove],
  );

  const handleCloseModal = useCallback(() => {
    setShowModal(false);
    setEditingEntry(null);
  }, []);

  const handleSave = useCallback(
    async (dto: TCreateAddressBookDto) => {
      if (editingEntry) {
        await update(editingEntry.id, dto);
      } else {
        await add(dto);
      }
      handleCloseModal();
    },
    [editingEntry, add, update, handleCloseModal],
  );

  const handleOpenAdd = useCallback(() => {
    setEditingEntry(null);
    setShowModal(true);
  }, []);

  const handleRefresh = useCallback(async () => {
    setIsManualRefreshing(true);
    await refetch();
    setIsManualRefreshing(false);
  }, [refetch]);

  const renderItem = useCallback(
    ({ item, index }: { item: TAddressBookEntry; index: number }) => (
      <AddressBookItem
        entry={item}
        index={index}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onCopy={handleCopy}
      />
    ),
    [handleEdit, handleDelete, handleCopy],
  );

  const keyExtractor = useCallback((item: TAddressBookEntry) => item.id, []);

  // Show sign-in prompt immediately for users who have never
  // authenticated. Previously this waited for `isAuthLoading === false`
  // too, which delayed the prompt while `useIsAuthenticated` did its
  // SecureStore cascade — users saw a flash of the "real" screen (which
  // fires auth'd contact queries that all fail) before the prompt
  // appeared. Since `hadPreviousSession` is the authoritative signal
  // for "user has ever had tokens on this wallet", we don't need to
  // wait for the loading state to resolve.
  if (isAuthenticated !== true && !hadPreviousSession) {
    return (
      <GestureHandlerRootView className="flex-1">
        <SystemBars style="dark" />
        <SafeAreaView
          edges={["top"]}
          className="flex-1 bg-light-main-container"
        >
          {/* Header */}
          <View className="px-4 pt-2 pb-4">
            <View className="flex-row items-center gap-3">
              <Pressable
                onPress={() => router.back()}
                hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                className="w-9 h-9 rounded-xl bg-light items-center justify-center shadow-sm"
              >
                <ArrowLeft size={18} color="#c71c4b" />
              </Pressable>
              <Text className="text-light-matte-black text-2xl font-bold tracking-tight flex-1">
                Address Book
              </Text>
            </View>
          </View>

          {/* Sign-in prompt */}
          <View className="flex-1 items-center justify-center px-10">
            <View className="mb-8 relative items-center justify-center h-32">
              <View className="absolute w-28 h-28 bg-light-primary-red/5 rounded-full" />
              <View className="absolute w-20 h-20 bg-light-primary-red/10 rounded-full" />
              <View className="absolute -top-2 -left-8 w-3 h-3 bg-light-primary-red/30 rounded-full" />
              <View className="absolute top-4 -right-10 w-2 h-2 bg-light-primary-red/40 rounded-full" />
              <View className="absolute -bottom-2 left-6 w-2.5 h-2.5 bg-light-primary-red/25 rounded-full" />
              <View
                className="bg-white w-24 h-24 rounded-3xl items-center justify-center border-2 border-light-primary-red/20"
                style={{
                  shadowColor: "#c71c4b",
                  shadowOffset: { width: 0, height: 8 },
                  shadowOpacity: 0.15,
                  shadowRadius: 20,
                  elevation: 10,
                }}
              >
                <View className="absolute inset-2 bg-light-primary-red/5 rounded-2xl" />
                <BookUser size={40} color="#c71c4b" />
              </View>
              <View className="absolute -top-1 -right-6 w-5 h-5 bg-light-primary-red rounded-full border-[3px] border-light-main-container items-center justify-center">
                <View className="w-2 h-2 bg-white rounded-full" />
              </View>
            </View>

            <View className="items-center max-w-[280px] mb-8">
              <Text className="text-light-matte-black font-bold text-2xl mb-3 text-center">
                Sign in to access your Address Book
              </Text>
              <Text className="text-light-matte-black/45 text-center text-sm leading-6">
                Save and manage wallet addresses with friendly names. Sign in
                with {chainFamily} to get started.
              </Text>
            </View>

            <TouchableOpacity
              activeOpacity={0.8}
              onPress={goToAuth}
              disabled={navigatingToAuth}
              className={`py-4 px-8 rounded-2xl flex-row items-center gap-3 mb-6 ${
                navigatingToAuth
                  ? "bg-light-primary-red/80"
                  : "bg-light-primary-red"
              }`}
              style={{
                shadowColor: "#c71c4b",
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.2,
                shadowRadius: 12,
                elevation: 8,
              }}
            >
              {navigatingToAuth && (
                <ActivityIndicator size="small" color="#ffffff" />
              )}
              <Text className="text-white font-bold text-base">
                {navigatingToAuth
                  ? "Opening sign-in…"
                  : `Sign In With ${chainFamily}`}
              </Text>
            </TouchableOpacity>

            <View className="gap-2.5 w-full">
              <View className="flex-row items-center gap-3 px-3 py-2.5 rounded-xl bg-light">
                <View className="bg-light-primary-red/10 p-1.5 rounded-lg">
                  <Shield color="#c71c4b" size={14} strokeWidth={2.5} />
                </View>
                <Text className="text-light-matte-black/55 text-xs flex-1 font-medium">
                  Secure & gasless authentication
                </Text>
              </View>
              <View className="flex-row items-center gap-3 px-3 py-2.5 rounded-xl bg-light">
                <View className="bg-light-primary-red/10 p-1.5 rounded-lg">
                  <BookUser color="#c71c4b" size={14} strokeWidth={2.5} />
                </View>
                <Text className="text-light-matte-black/55 text-xs flex-1 font-medium">
                  Save addresses with friendly names
                </Text>
              </View>
            </View>
          </View>
        </SafeAreaView>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView className="flex-1">
      <SystemBars style="dark" />
      <SafeAreaView
        edges={["top"]}
        className="flex-1 bg-light-main-container"
        style={{ paddingBottom: bottomOffset }}
      >
        {/* Header */}
        <View className="px-4 pt-2 pb-4">
          <View className="flex-row items-center justify-between mb-1">
            <View className="flex-row items-center gap-3 flex-1">
              <Pressable
                onPress={() => router.back()}
                hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                className="w-9 h-9 rounded-xl bg-light items-center justify-center shadow-sm"
              >
                <ArrowLeft size={18} color="#c71c4b" />
              </Pressable>
              <View className="flex-1">
                <Text
                  className="text-light-matte-black text-2xl font-bold tracking-tight"
                  numberOfLines={1}
                >
                  Address Book
                </Text>
                <Text className="text-light-matte-black/50 text-xs">
                  {contacts.length === 0 && !search
                    ? "No contacts saved"
                    : `${contacts.length} contact${contacts.length !== 1 ? "s" : ""}`}
                </Text>
              </View>
            </View>

            <Pressable
              onPress={handleOpenAdd}
              className="w-10 h-10 rounded-[13px] bg-light-primary-red items-center justify-center shadow-md"
              style={{ shadowColor: "#c71c4b" }}
            >
              <Plus size={20} color="white" />
            </Pressable>
          </View>

          {/* Search bar */}
          <View className="mt-3 flex-row items-center bg-light rounded-2xl px-[14px] shadow-sm">
            <Search size={16} color="#20222c50" />
            <TextInput
              ref={searchRef}
              value={search}
              onChangeText={setSearch}
              placeholder="Search by name, address or ENS..."
              placeholderTextColor="#20222c40"
              autoCapitalize="none"
              autoCorrect={false}
              className="flex-1 ml-[10px] py-[13px] text-sm text-light-matte-black"
            />
            {!!search && (
              <Pressable
                onPress={() => setSearch("")}
                hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
              >
                <X size={16} color="#20222c60" />
              </Pressable>
            )}
          </View>
        </View>

        {/* List */}
        {/*
          Windowing props below are the real fix for the "back nav feels
          laggy" bug. Each `AddressBookItem` owns two reanimated shared
          values, two `useAnimatedStyle` hooks, a Pan gesture handler,
          and a `FadeInDown` entering animation. FlatList defaults mount
          ~21 viewports worth of rows; on a 30+ contact list that's 30
          reanimated trees living in memory. When the native stack
          starts the back transition, React has to tear all of them
          down on the JS thread while the UI thread runs the slide
          animation — they contend for frames and the transition looks
          janky. Tightening the window to ~2 viewports + clipping
          offscreen rows cuts the teardown cost dramatically.
        */}
        <FlatList
          data={contacts}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingTop: 4,
            paddingBottom: 24,
            flexGrow: 1,
          }}
          ListEmptyComponent={<EmptyState isSearching={!!search} />}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          removeClippedSubviews
          initialNumToRender={8}
          maxToRenderPerBatch={6}
          windowSize={5}
          refreshControl={
            <RefreshControl
              refreshing={isManualRefreshing}
              onRefresh={handleRefresh}
              tintColor="#c71c4b"
              colors={["#c71c4b"]}
            />
          }
        />

        {/* Swipe hint */}
        {contacts.length > 0 && (
          <View className="pb-2 items-center">
            <Text className="text-[11px] text-light-matte-black/25">
              Swipe left on a contact to edit or delete
            </Text>
          </View>
        )}
      </SafeAreaView>

      <AddContactModal
        visible={showModal}
        onClose={handleCloseModal}
        onSave={handleSave}
        editing={editingEntry}
        isSaving={isAdding || isUpdating}
        saveError={addError as Error | null}
      />
    </GestureHandlerRootView>
  );
}
