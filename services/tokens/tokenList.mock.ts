/**
 * Vitest twin of `services/tokens/tokenList.ts`.
 *
 * The real module persists through `expo-sqlite`, which ships JSX in
 * `expo-sqlite/build/hooks.js` and cannot be parsed outside the app
 * runtime. `EvmAdapter` imports `isDefaultToken` from it for the
 * phase-D ERC-20/ERC-721 `approve` disambiguation, so any pure-logic
 * test reaching the adapter transitively pulls SQLite in.
 *
 * Mirrors the `token-list` stub in
 * `services/walletKit/evm/_test-resolver-hook.mjs` — keep the two in
 * sync. `isDefaultToken` returns false so tests exercise the
 * ERC-165-probe branch rather than short-circuiting on the registry.
 */

import type { TokenInfo } from "./types";

export function isDefaultToken(): boolean {
  return false;
}
export function getDefaultTokens(): TokenInfo[] {
  return [];
}
export function getAllDefaultTokens(): TokenInfo[] {
  return [];
}
export function getUserTokens(): TokenInfo[] {
  return [];
}
export function getTokenPrefs(): undefined {
  return undefined;
}
export function getAllTokenPrefs(): Map<string, unknown> {
  return new Map();
}
export function addUserToken(): void {}
export function pinToken(): void {}
export function hideToken(): void {}
export function unhideToken(): void {}
export function markAsSpam(): void {}
export const TOP_100_NAMES: string[] = [];
