/**
 * `MwaHost` — drives one Mobile Wallet Adapter session (spec §8.2).
 *
 * Starts the walletlib event listener and the local WebSocket session
 * (the MWA spec wants the server listening within 10 s of launch — this
 * is the first thing the host activity's root renders), forwards every
 * `MWARequest` to `mwaTransport`, and ends the activity when the
 * session terminates. Renders a small status card; the approval sheets
 * themselves come from the root `ApprovalHost`.
 */

import {
  initializeMobileWalletAdapterSession,
  initializeMWAEventListener,
  type MWARequest,
  type MWASessionEvent,
  MWASessionEventType,
} from "@solana-mobile/mobile-wallet-adapter-walletlib";
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Platform, Text, View } from "react-native";
import { mwaAttestation } from "./attestation";
import { MWA_CONFIG, MWA_WALLET_NAME, mwaTransport } from "./index";

type Status = "starting" | "serving" | "ended" | "failed";

export function MwaHost({
  onSessionEnded,
}: {
  onSessionEnded: () => void;
}): React.ReactElement | null {
  const [status, setStatus] = useState<Status>("starting");
  const ended = useRef(false);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const finish = () => {
      if (ended.current) return;
      ended.current = true;
      setStatus("ended");
      // Origin attestations are scoped to one session (spec: "authorized
      // during this session"); the next launch must re-attest.
      mwaAttestation.resetSession();
      onSessionEnded();
    };
    // Phase 3b: the attestation page returns to this activity through its
    // private scheme. `openAuthSessionAsync` usually catches it, but a
    // Custom Tab that was backgrounded can deliver it as a plain `url`
    // event instead, so both paths feed `completeProvisioning`.
    const urlSub = Linking.addEventListener("url", ({ url }) => {
      void mwaAttestation.completeProvisioning(url);
    });
    const listener = initializeMWAEventListener(
      (request: MWARequest) => {
        void mwaTransport.handleRequest(request);
      },
      (event: MWASessionEvent) => {
        switch (event.__type) {
          case MWASessionEventType.SessionReadyEvent:
          case MWASessionEventType.SessionServingClientsEvent:
            setStatus("serving");
            break;
          case MWASessionEventType.SessionTerminatedEvent:
          case MWASessionEventType.SessionCompleteEvent:
          case MWASessionEventType.SessionTeardownCompleteEvent:
          case MWASessionEventType.SessionErrorEvent:
          case MWASessionEventType.LowPowerNoConnectionEvent:
            finish();
            break;
          default:
            break;
        }
      },
    );
    void (async () => {
      try {
        await mwaTransport.start();
        await initializeMobileWalletAdapterSession(MWA_WALLET_NAME, MWA_CONFIG);
      } catch (e) {
        if (__DEV__) console.warn("[mwa] session init failed", e);
        setStatus("failed");
        setTimeout(finish, 1500);
      }
    })();
    return () => {
      listener.remove();
      urlSub.remove();
    };
  }, [onSessionEnded]);

  if (status === "ended") return null;
  return (
    <View className="flex-1 justify-end">
      <View className="bg-white rounded-t-3xl px-5 pt-5 pb-8 items-center">
        {status === "failed" ? (
          <Text className="text-sm text-light-matte-black/70">
            Couldn&apos;t connect to the app. Please try again from the app.
          </Text>
        ) : (
          <>
            <ActivityIndicator color="#c71c4b" />
            <Text className="text-sm text-light-matte-black/70 mt-3">
              {status === "starting"
                ? "Connecting to the app..."
                : "Waiting for the app..."}
            </Text>
          </>
        )}
      </View>
    </View>
  );
}
