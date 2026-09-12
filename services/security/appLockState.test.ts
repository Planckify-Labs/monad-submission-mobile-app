/**
 * S-9 — nothing presents above the lock. The store half: while the app
 * is locked the approval queue keeps accepting intents but reports an
 * empty list to subscribers (so the root `ApprovalHost` renders nothing),
 * and `resume` replays the real queue. The UI half (`ApprovalHost`
 * returns `null` while locked) reads the same mirror through
 * `useSyncExternalStore`.
 */

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { pendingIntentsStore } from "@/services/bridge/pendingIntents";
import {
  __resetAppLockStateForTest,
  isAppLocked,
  setAppLocked,
  subscribeAppLocked,
} from "./appLockState.ts";

const intent = (id: string) => ({
  id,
  namespace: "eip155" as const,
  kind: "signMessage" as const,
  origin: { url: "https://dapp.example" },
  wallet: null,
  payload: {},
  annotations: [],
  createdAt: Date.now(),
});

describe("appLockState + pendingIntentsStore pause", () => {
  beforeEach(() => {
    __resetAppLockStateForTest();
    pendingIntentsStore.__resetForTest();
  });

  it("mirrors the lock and notifies subscribers once per change", () => {
    const seen: boolean[] = [];
    subscribeAppLocked((l) => seen.push(l));
    setAppLocked(true);
    setAppLocked(true);
    setAppLocked(false);
    assert.deepEqual(seen, [true, false]);
    assert.equal(isAppLocked(), false);
  });

  it("a paused queue hides intents from subscribers but keeps them", () => {
    const snapshots: number[] = [];
    pendingIntentsStore.subscribe((l) => snapshots.push(l.length));
    pendingIntentsStore.pause();
    assert.equal(pendingIntentsStore.push(intent("a")), true);
    assert.equal(pendingIntentsStore.snapshot.length, 1);
    assert.equal(snapshots[snapshots.length - 1], 0);
    pendingIntentsStore.resume();
    assert.equal(snapshots[snapshots.length - 1], 1);
  });

  it("wiring: lock → pause, unlock → resume (as bootBridge subscribes)", () => {
    subscribeAppLocked((locked) =>
      locked ? pendingIntentsStore.pause() : pendingIntentsStore.resume(),
    );
    pendingIntentsStore.push(intent("b"));
    let last = -1;
    pendingIntentsStore.subscribe((l) => {
      last = l.length;
    });
    setAppLocked(true);
    assert.equal(last, 0);
    assert.equal(pendingIntentsStore.isPaused, true);
    setAppLocked(false);
    assert.equal(last, 1);
  });
});
