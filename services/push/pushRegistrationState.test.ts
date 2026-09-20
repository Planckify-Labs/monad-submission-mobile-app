import { beforeEach, describe, expect, it } from "vitest";
import { storage } from "@/lib/storage/mmkv";
import {
  type PushRegistrationState,
  readPushRegistrationState,
  writePushRegistrationState,
} from "./pushRegistrationState";

const STATE_KEY = "takumipay_push_registration_state";

const state = (
  overrides: Partial<PushRegistrationState> = {},
): PushRegistrationState => ({
  failed: false,
  wallets: [],
  lastSuccessAt: 0,
  lastAttemptAt: 0,
  consecutiveFailures: 0,
  ...overrides,
});

describe("pushRegistrationState", () => {
  beforeEach(() => {
    storage.remove(STATE_KEY);
  });

  it("returns a default state when nothing is persisted", () => {
    expect(readPushRegistrationState()).toEqual(state());
  });

  it("round-trips a written state", () => {
    const written = state({
      failed: true,
      wallets: ["0xABC"],
      consecutiveFailures: 2,
      lastError: "backend post failed after retries",
    });
    writePushRegistrationState(written);
    expect(readPushRegistrationState()).toEqual(written);
  });

  it("falls back to default on a corrupt blob", () => {
    storage.set(STATE_KEY, "not json");
    expect(readPushRegistrationState()).toEqual(state());
  });

  it("falls back to default on a shape it doesn't recognize", () => {
    storage.set(STATE_KEY, JSON.stringify({ unrelated: true }));
    expect(readPushRegistrationState()).toEqual(state());
  });
});
