import { useCallback, useEffect, useState } from "react";
import {
  clearPin,
  isPinSet,
  setPin as storePin,
  verifyPin as verifyStoredPin,
} from "@/services/security/pinStore";

/**
 * React face of `services/security/pinStore.ts`. The hook owns only the
 * `hasPin` flag the modals branch on; hashing, storage and the legacy
 * plaintext migration all live in the store.
 */
interface UsePinReturn {
  hasPin: boolean;
  isLoading: boolean;
  verifyPin: (pin: string) => Promise<boolean>;
  setPin: (pin: string) => Promise<void>;
  resetPin: () => Promise<void>;
}

export function usePin(): UsePinReturn {
  const [hasPin, setHasPin] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const checkForExistingPin = useCallback(async () => {
    try {
      setIsLoading(true);
      setHasPin(await isPinSet());
    } catch (error) {
      if (__DEV__) console.warn("[usePin] isPinSet failed", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    checkForExistingPin();
  }, [checkForExistingPin]);

  const verifyPin = useCallback(async (pin: string): Promise<boolean> => {
    try {
      return await verifyStoredPin(pin);
    } catch (error) {
      if (__DEV__) console.warn("[usePin] verify failed", error);
      return false;
    }
  }, []);

  const setPin = useCallback(async (pin: string): Promise<void> => {
    try {
      await storePin(pin);
      setHasPin(true);
    } catch (error) {
      if (__DEV__) console.warn("[usePin] set failed", error);
      throw new Error("Failed to save PIN");
    }
  }, []);

  const resetPin = useCallback(async (): Promise<void> => {
    try {
      await clearPin();
      setHasPin(false);
    } catch (error) {
      if (__DEV__) console.warn("[usePin] reset failed", error);
      throw new Error("Failed to reset PIN");
    }
  }, []);

  return {
    hasPin,
    isLoading,
    verifyPin,
    setPin,
    resetPin,
  };
}
