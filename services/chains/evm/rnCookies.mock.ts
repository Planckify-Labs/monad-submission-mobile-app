// Vitest mock for `@react-native-cookies/cookies`. The real package's RN entry
// imports NativeModules (unparseable by esbuild), so any pure-logic test that
// transitively reaches `dappCookies.ts` aliases to this. Mirrors the node
// test-resolver stub ("rn-cookies") — keep both in sync.
export default {
  get: async () => ({}),
  set: async () => true,
  clearAll: async () => true,
};
