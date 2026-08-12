/**
 * The approval queue is memory-only. These cover both reasons why.
 *
 * **Availability.** A tower.exchange swap opened an approval sheet that
 * crashed on mount (the `ox` / prototype-freeze `TypeError`, fixed in
 * pollyfills.ts), and the intent behind it stayed in SecureStore.
 * `ApprovalHost` is mounted only by the dApps screen, so every later
 * visit rehydrated the same intent, re-presented the same sheet, and
 * crashed again — across app restarts — until it aged past the old
 * five-minute staleness window. That window was the only thing ending
 * it, which is why the screen "fixed itself" after 5-8 minutes. A
 * restored queue is now discarded, which the "Persist pending intents"
 * bullet in `docs/dapp-bridge-spec.md` allows ("clean rejection on
 * boot").
 *
 * **Confidentiality (TWV-2026-004).** Writing the queue at all meant
 * serialising `intent.wallet`, a `TWallet` carrying `privateKey` and
 * `seedPhrase`, through a bare `SecureStore.setItemAsync(key, value)`
 * with no `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. Every dApp approval left a
 * second, less-protected copy of the signing key on disk. The write is
 * gone; `hydrate()` purges anything an older build left behind.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  __dumpSecureStore,
  __resetSecureStore,
  getItemAsync,
  setItemAsync,
} from "@/lib/storage/expoSecureStore.mock";
import type { ApprovalIntent } from "./approval";
import { pendingIntentsStore } from "./pendingIntents";

const STORAGE_KEY = "dapp_bridge.pending_intents";

function swapIntent(overrides: Partial<ApprovalIntent> = {}): ApprovalIntent {
  return {
    id: "intent-1",
    namespace: "eip155",
    kind: "sendTransaction",
    origin: { url: "https://tower.exchange" },
    wallet: null,
    payload: { from: "0xabc", to: "0xdef", value: "0x0", chainId: 1 },
    annotations: [],
    createdAt: Date.now(),
    ...overrides,
  } as ApprovalIntent;
}

/** `hydrated` is a per-process latch; reset it between cases. */
function resetHydrationLatch(): void {
  const s = pendingIntentsStore as unknown as {
    hydrated: boolean;
    hydratePromise: Promise<void> | null;
  };
  s.hydrated = false;
  s.hydratePromise = null;
  pendingIntentsStore.__resetForTest();
}

describe("pendingIntentsStore.hydrate", () => {
  beforeEach(() => {
    __resetSecureStore();
    resetHydrationLatch();
  });

  it("does not re-present a persisted intent, however recent", async () => {
    // Written one second ago: comfortably inside the window the old
    // staleness check treated as still-presentable.
    await setItemAsync(
      STORAGE_KEY,
      JSON.stringify([swapIntent({ createdAt: Date.now() - 1_000 })]),
    );

    await pendingIntentsStore.hydrate();

    expect(pendingIntentsStore.snapshot).toEqual([]);
  });

  it("clears the stored queue so a restart cannot replay it", async () => {
    await setItemAsync(STORAGE_KEY, JSON.stringify([swapIntent()]));

    await pendingIntentsStore.hydrate();
    expect(await getItemAsync(STORAGE_KEY)).toBeNull();

    // Second launch, same disk: nothing left to come back.
    resetHydrationLatch();
    await pendingIntentsStore.hydrate();
    expect(pendingIntentsStore.snapshot).toEqual([]);
  });

  it("clears a payload that cannot be parsed rather than retrying it", async () => {
    await setItemAsync(STORAGE_KEY, "{ not json");

    await expect(pendingIntentsStore.hydrate()).resolves.toBeUndefined();

    expect(pendingIntentsStore.snapshot).toEqual([]);
    expect(await getItemAsync(STORAGE_KEY)).toBeNull();
  });

  it("never writes the queue to SecureStore (it embeds wallet key material)", async () => {
    // TWV-2026-004. `intent.wallet` is a TWallet, which carries
    // `privateKey` and `seedPhrase`. The old `persist()` serialised the
    // whole queue with a bare `SecureStore.setItemAsync(key, value)` —
    // no `WHEN_UNLOCKED_THIS_DEVICE_ONLY` — so every dApp approval wrote
    // a second, less-protected copy of the signing key to disk.
    await pendingIntentsStore.hydrate();

    pendingIntentsStore.push(
      swapIntent({
        id: "secret-bearing",
        wallet: {
          name: "Dev wallet",
          address: "0xabc",
          balance: "0",
          source: "Imported",
          type: "PrivateKey",
          namespace: "eip155",
          account: {},
          privateKey: "0xPRIVATE_KEY_MUST_NEVER_REACH_DISK",
          seedPhrase: "seed phrase must never reach disk",
        },
      } as Partial<ApprovalIntent>),
    );
    pendingIntentsStore.remove("secret-bearing");
    pendingIntentsStore.clearAll();

    // Nothing under the queue's key, and no trace of the secrets under
    // any key the store might have written.
    expect(await getItemAsync(STORAGE_KEY)).toBeNull();
    expect(__dumpSecureStore()).not.toContain(
      "PRIVATE_KEY_MUST_NEVER_REACH_DISK",
    );
    expect(__dumpSecureStore()).not.toContain(
      "seed phrase must never reach disk",
    );
  });

  it("purges a legacy queue written by an older build", async () => {
    // Older builds persisted wallet key material here. Booting once on a
    // build without `persist()` has to get that off the device.
    await setItemAsync(
      STORAGE_KEY,
      JSON.stringify([
        swapIntent({
          wallet: { privateKey: "0xLEAKED_BY_OLD_BUILD" },
        } as Partial<ApprovalIntent>),
      ]),
    );

    await pendingIntentsStore.hydrate();

    expect(await getItemAsync(STORAGE_KEY)).toBeNull();
    expect(__dumpSecureStore()).not.toContain("0xLEAKED_BY_OLD_BUILD");
  });

  it("leaves a live in-session queue alone", async () => {
    // The latch means a screen remount never re-enters hydrate; only a
    // cold start does. An intent pushed this session must survive it.
    await pendingIntentsStore.hydrate();
    pendingIntentsStore.push(swapIntent({ id: "live" }));

    await pendingIntentsStore.hydrate();

    expect(pendingIntentsStore.snapshot.map((i) => i.id)).toEqual(["live"]);
  });
});
