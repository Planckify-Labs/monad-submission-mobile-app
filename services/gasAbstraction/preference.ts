/**
 * Stored-value normalisation for the gas-token preference. Pure so the
 * legacy-migration rule is Node-testable; `hooks/usePreferredGasToken`
 * is the MMKV-backed caller.
 */

import { type GasFeeTokenPreference, NATIVE_GAS_TOKEN } from "./types";

/**
 * Stored value → preference. Symbols are stored exactly as the relayer
 * tags them (`"USDC"`, `"mUSD"`) and matched case-insensitively
 * downstream. The first release persisted the lowercase literal `"usdc"`;
 * it maps to the same USDC choice so an upgrade never silently flips a
 * user back to native gas.
 */
export function normalizeGasTokenPreference(
  raw: string | undefined | null,
): GasFeeTokenPreference {
  if (typeof raw !== "string") return NATIVE_GAS_TOKEN;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return NATIVE_GAS_TOKEN;
  if (trimmed.toLowerCase() === NATIVE_GAS_TOKEN) return NATIVE_GAS_TOKEN;
  if (trimmed === "usdc") return "USDC";
  return trimmed;
}
