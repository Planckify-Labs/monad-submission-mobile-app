/**
 * Root-mounted host for `deepLinkNotices` — a small modal with fixed
 * copy and at most one action. Used by the session transports for
 * outcomes that have no screen of their own (blocked scam proposal,
 * "Sent back to {app}", callback delivery).
 */

import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Modal, Text, TouchableOpacity, View } from "react-native";
import {
  type DeepLinkNotice,
  deepLinkNotices,
} from "@/services/deeplinks/notices";
import {
  isAppLocked,
  subscribeAppLocked,
} from "@/services/security/appLockState";

export function DeepLinkNoticeHost(): React.ReactElement | null {
  const [notices, setNotices] = useState<DeepLinkNotice[]>([]);
  const locked = useSyncExternalStore(subscribeAppLocked, isAppLocked);

  useEffect(() => deepLinkNotices.subscribe(setNotices), []);

  const current = notices[0];
  useEffect(() => {
    if (!current?.autoDismissMs) return;
    const t = setTimeout(
      () => deepLinkNotices.dismiss(current.id),
      current.autoDismissMs,
    );
    return () => clearTimeout(t);
  }, [current]);

  if (locked || !current) return null;

  return (
    <Modal visible transparent animationType="fade">
      <View className="flex-1 bg-black/40 items-center justify-center px-8">
        <View className="bg-white rounded-2xl p-5 w-full">
          <Text className="text-base font-bold text-light-matte-black">
            {current.title}
          </Text>
          <Text className="text-sm text-light-matte-black/70 mt-2">
            {current.body}
          </Text>
          {current.action ? (
            <TouchableOpacity
              onPress={() => {
                deepLinkNotices.dismiss(current.id);
                current.action?.onPress();
              }}
              className="mt-4 py-3 rounded-2xl bg-light-primary-red items-center"
            >
              <Text className="text-white font-bold">
                {current.action.label}
              </Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            onPress={() => deepLinkNotices.dismiss(current.id)}
            className={`py-3 rounded-2xl items-center ${current.action ? "mt-2 bg-light-matte-black/5" : "mt-4 bg-light-primary-red"}`}
            accessibilityLabel="dismiss-deeplink-notice"
          >
            <Text
              className={`font-bold ${current.action ? "text-light-matte-black" : "text-white"}`}
            >
              Close
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}
