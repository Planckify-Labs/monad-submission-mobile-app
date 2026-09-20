/**
 * `usePreferredGasToken` — the user's default gas-payment token.
 *
 * Canonical store is MMKV (`storage`), so the value is readable
 * synchronously both inside React (this hook, via `useRQGlobalState` for
 * reactive UI) and outside it (`getPreferredGasToken()` for the agent
 * executor, which runs off the render tree). `"native"` is the default —
 * gas is paid in the chain's native coin unless the user opts into a
 * stablecoin (any symbol the relayer accepts on the chain in use — the
 * option list itself comes from `useGasFeeTokenOptions`).
 */

import { useCallback } from "react";
import { storage } from "@/lib/storage/mmkv";
import { normalizeGasTokenPreference } from "@/services/gasAbstraction/preference";
import {
  type GasFeeTokenPreference,
  NATIVE_GAS_TOKEN,
} from "@/services/gasAbstraction/types";
import useRQGlobalState from "./useRQGlobalState";

const STORAGE_KEY = "takumipay_preferred_gas_token";
const QUERY_KEY = ["preferredGasToken"];
const DEFAULT: GasFeeTokenPreference = NATIVE_GAS_TOKEN;

/** Non-reactive accessor for code outside React (agent executors). */
export function getPreferredGasToken(): GasFeeTokenPreference {
  return normalizeGasTokenPreference(storage.getString(STORAGE_KEY));
}

/** Persist + broadcast. Exported so non-hook callers can also write. */
export function setStoredPreferredGasToken(pref: GasFeeTokenPreference): void {
  storage.set(STORAGE_KEY, normalizeGasTokenPreference(pref));
}

export function usePreferredGasToken() {
  const { data, setNewData } = useRQGlobalState<GasFeeTokenPreference>({
    queryKey: QUERY_KEY,
    initialData: getPreferredGasToken(),
  });

  const setPreferredGasToken = useCallback(
    (pref: GasFeeTokenPreference) => {
      const normalized = normalizeGasTokenPreference(pref);
      setStoredPreferredGasToken(normalized);
      setNewData(normalized);
    },
    [setNewData],
  );

  return {
    preferredGasToken: data ?? DEFAULT,
    setPreferredGasToken,
  };
}
