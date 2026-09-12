/**
 * Node ESM resolution hook for `EvmWalletKit.test.ts`.
 *
 * See `_test-resolver.mjs` for registration. This file implements the
 * hook body. NO kit logic here.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// ../../../ relative to this file = mobile-app root
const PROJECT_ROOT = resolvePath(__dirname, "..", "..", "..");

// Minimum-viable stubs for RN / Expo modules reachable only through the
// preserved `services/walletService.ts` dwell sites. The kit never
// exercises these paths under this test.
const STUB_SOURCES = {
  "expo-secure-store": `
    export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = "whenUnlockedThisDeviceOnly";
    export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = "afterFirstUnlockThisDeviceOnly";
    export async function getItemAsync() { return null; }
    export async function setItemAsync() {}
    export async function deleteItemAsync() {}
    // API-surface twin of lib/storage/expoSecureStore.mock.ts. This side
    // stays a no-op store, so there is nothing to dump; these exist only
    // so the two stubs remain importable in step.
    export function __resetSecureStore() {}
    export function __dumpSecureStore() { return ""; }
    export default {};
  `,
  "rn-cookies": `
    export default {
      get: async () => ({}),
      set: async () => true,
      clearAll: async () => true,
    };
  `,
  // In-memory MMKV stub. Deliberately a REAL map, not a no-op: modules
  // that persist through it (the agent's confirmed-counterparty store) are
  // only meaningfully testable if a write can be read back. A no-op stub
  // silently makes every lookup miss, which for a security store reads as
  // "nothing is ever confirmed" and hides regressions in both directions.
  // \`remove\` is the API the app actually calls (not \`delete\`).
  "mmkv-storage": `
    const mem = new Map();
    export const storage = {
      getString: (k) => (mem.has(k) ? mem.get(k) : undefined),
      getBoolean: (k) => (mem.has(k) ? mem.get(k) === "true" : undefined),
      getNumber: (k) => (mem.has(k) ? Number(mem.get(k)) : undefined),
      set: (k, v) => { mem.set(k, String(v)); },
      remove: (k) => { mem.delete(k); },
      delete: (k) => { mem.delete(k); },
      clearAll: () => { mem.clear(); },
    };
  `,
  // posthog-react-native (+ expo-application/expo-device peers) ships
  // RN/Flow syntax that Node's plain strip-types loader can't parse.
  // Stub at our own module boundary, same as the mmkv-storage stub above —
  // mirrored on the vitest side by services/analytics/posthog.mock.ts.
  "analytics-posthog": `
    export const posthog = {
      identify: () => {},
      capture: () => {},
      screen: async () => {},
      optIn: async () => {},
      optOut: async () => {},
    };
    export function track() {}
  `,
  // `services/tokens/tokenList.ts` persists through expo-sqlite, which
  // ships JSX in `expo-sqlite/build/hooks.js` and cannot be parsed by
  // Node's strip-types loader. `EvmAdapter` imports `isDefaultToken`
  // from it for the phase-D ERC-20/ERC-721 `approve` disambiguation.
  // Stub at our own module boundary, same rule as mmkv/posthog above;
  // mirrored on the vitest side by an alias in vitest.config.ts.
  "token-list": `
    export function isDefaultToken() { return false; }
    export function getDefaultTokens() { return []; }
    export function getAllDefaultTokens() { return []; }
    export function getUserTokens() { return []; }
    export function getTokenPrefs() { return undefined; }
    export function getAllTokenPrefs() { return new Map(); }
    export function addUserToken() {}
    export function pinToken() {}
    export function hideToken() {}
    export function unhideToken() {}
    export function markAsSpam() {}
    export const TOP_100_NAMES = [];
  `,
  // In-memory AsyncStorage stub for the permissions store test
  // (services/permissions/store.ts persists grants through it).
  "async-storage": `
    const mem = new Map();
    export default {
      getItem: async (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: async (k, v) => { mem.set(k, String(v)); },
      removeItem: async (k) => { mem.delete(k); },
      clear: async () => { mem.clear(); },
    };
  `,
  "@metamask/smart-accounts-kit": `
    let mockEnvironment = null;
    export function setMockEnvironment(env) {
      mockEnvironment = env;
    }
    export function getSmartAccountsEnvironment(chainId) {
      if (mockEnvironment) return mockEnvironment;
      return {
        implementations: {
          EIP7702StatelessDeleGatorImpl: "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B"
        }
      };
    }
    // ── ERC-7710 delegation surface (Phase 2). Real string values so the
    //    scope-mapping test is meaningful; createDelegation echoes a
    //    realistic struct so the builder/serializer paths are exercisable
    //    without pulling the full SDK into the Node harness.
    export const ScopeType = {
      Erc20TransferAmount: "erc20TransferAmount",
      NativeTokenTransferAmount: "nativeTokenTransferAmount",
      FunctionCall: "functionCall",
      Erc20PeriodTransfer: "erc20PeriodTransfer",
      NativeTokenPeriodTransfer: "nativeTokenPeriodTransfer",
    };
    export const Implementation = {
      Stateless7702: "Stateless7702",
      Hybrid: "Hybrid",
      MultiSig: "MultiSig",
    };
    export const CaveatType = {
      Timestamp: "timestamp",
      LimitedCalls: "limitedCalls",
      AllowedTargets: "allowedTargets",
      AllowedMethods: "allowedMethods",
    };
    export function createDelegation({ from, to, caveats = [], salt = "0x00" }) {
      return {
        delegate: to,
        delegator: from,
        authority: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        caveats: caveats.map((_c, i) => ({
          enforcer: "0x" + String(i + 1).padStart(40, "0"),
          terms: "0x00",
          args: "0x",
        })),
        salt,
      };
    }
    export async function toMetaMaskSmartAccount() {
      return { signDelegation: async () => "0x" + "ab".repeat(65) };
    }
  `,
  "@metamask/smart-accounts-kit/utils": `
    export function encodeDelegations() {
      return "0x" + "00".repeat(32);
    }
  `,
};

function stubUrl(src) {
  return "data:text/javascript;base64," + Buffer.from(src).toString("base64");
}

function tryExtensions(absNoExt) {
  for (const ext of [".ts", ".tsx", ".mjs", ".js"]) {
    const candidate = absNoExt + ext;
    if (existsSync(candidate)) return candidate;
  }
  if (existsSync(absNoExt) && statSync(absNoExt).isDirectory()) {
    for (const ext of [".ts", ".tsx", ".mjs", ".js"]) {
      const candidate = resolvePath(absNoExt, "index" + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  // Stub expo-secure-store.
  if (specifier === "expo-secure-store") {
    return {
      shortCircuit: true,
      url: stubUrl(STUB_SOURCES["expo-secure-store"]),
      format: "module",
    };
  }
  // Stub the native cookie module (`@react-native-cookies/cookies`) — its RN
  // entry imports NativeModules, which the strip-types loader can't parse.
  if (specifier === "@react-native-cookies/cookies") {
    return {
      shortCircuit: true,
      url: stubUrl(STUB_SOURCES["rn-cookies"]),
      format: "module",
    };
  }
  // Stub the mmkv storage helper (`@/lib/storage/mmkv`).
  if (specifier === "@/lib/storage/mmkv") {
    return {
      shortCircuit: true,
      url: stubUrl(STUB_SOURCES["mmkv-storage"]),
      format: "module",
    };
  }
  // Stub the analytics client (`@/services/analytics/posthog`).
  if (specifier === "@/services/analytics/posthog") {
    return {
      shortCircuit: true,
      url: stubUrl(STUB_SOURCES["analytics-posthog"]),
      format: "module",
    };
  }
  // Stub the token registry (`@/services/tokens/tokenList`).
  if (specifier === "@/services/tokens/tokenList") {
    return {
      shortCircuit: true,
      url: stubUrl(STUB_SOURCES["token-list"]),
      format: "module",
    };
  }
  // Stub AsyncStorage (used by services/permissions/store.ts).
  if (specifier === "@react-native-async-storage/async-storage") {
    return {
      shortCircuit: true,
      url: stubUrl(STUB_SOURCES["async-storage"]),
      format: "module",
    };
  }
  // Stub @metamask/smart-accounts-kit (+ its /utils subpath).
  if (specifier === "@metamask/smart-accounts-kit") {
    return {
      shortCircuit: true,
      url: stubUrl(STUB_SOURCES["@metamask/smart-accounts-kit"]),
      format: "module",
    };
  }
  if (specifier === "@metamask/smart-accounts-kit/utils") {
    return {
      shortCircuit: true,
      url: stubUrl(STUB_SOURCES["@metamask/smart-accounts-kit/utils"]),
      format: "module",
    };
  }

  // Alias rewrite for `@/*`.
  if (specifier.startsWith("@/")) {
    const rel = specifier.slice(2);
    const abs = resolvePath(PROJECT_ROOT, rel);
    const withExt =
      existsSync(abs) && statSync(abs).isFile() ? abs : tryExtensions(abs);
    if (withExt) {
      return nextResolve(pathToFileURL(withExt).href, context);
    }
  }

  // Relative imports missing an explicit extension.
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    !/\.[a-zA-Z0-9]+$/.test(specifier) &&
    context.parentURL
  ) {
    const parentDir = dirname(fileURLToPath(context.parentURL));
    const abs = resolvePath(parentDir, specifier);
    const withExt = tryExtensions(abs);
    if (withExt) {
      return nextResolve(pathToFileURL(withExt).href, context);
    }
  }

  return nextResolve(specifier, context);
}

/**
 * Load hook: surgically rewrites a short list of hot-spot files whose
 * import style ("plain" named imports of types like `import { TWallet }`)
 * confuses Node's strip-types runner. We only touch files on the kit's
 * transitive load path — this is test-harness plumbing, not a
 * modification of the original source on disk. The original files
 * remain byte-identical in the working tree; Task 05's "no edits" rule
 * is preserved.
 */
const SOURCE_REWRITES = {
  "utils/walletUtils.ts": (src) =>
    src.replace(
      /^import\s*\{\s*TWallet\s*,\s*TWalletCreationParams\s*\}\s*from\s*"@\/constants\/types\/walletTypes";/m,
      `import type { TWallet, TWalletCreationParams } from "@/constants/types/walletTypes";`,
    ),
  "utils/clients.ts": (src) => {
    let rewritten = src.replace(
      /^import\s*\{\s*([\s\S]*?)\s*\}\s*from\s*"viem";/m,
      (_match, inner) => {
        // viem's `Account` / `Chain` are types; the rest (createPublicClient,
        // createWalletClient, http) are runtime. Split them so Node's
        // strip-types doesn't try to bind types at runtime.
        const names = inner
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean);
        const typeNames = names.filter((n) => /^[A-Z]/.test(n));
        const valueNames = names.filter((n) => !/^[A-Z]/.test(n));
        const lines = [];
        if (valueNames.length) {
          lines.push(`import { ${valueNames.join(", ")} } from "viem";`);
        }
        if (typeNames.length) {
          lines.push(`import type { ${typeNames.join(", ")} } from "viem";`);
        }
        return lines.join("\n");
      },
    );

    // Inject mock variables and setters dynamically in memory for testing
    rewritten =
      `
      let globalMockPublicClient = null;
      let globalMockWalletClient = null;
      export const setGlobalMockPublicClient = (client) => {
        globalMockPublicClient = client;
      };
      export const setGlobalMockWalletClient = (client) => {
        globalMockWalletClient = client;
      };
    ` + rewritten;

    // Inject override checks at the start of getPublicClient and getWalletClient
    rewritten = rewritten.replace(
      /export const getPublicClient = \(chain: TChainConfig\) => \{/,
      "export const getPublicClient = (chain: TChainConfig) => { if (globalMockPublicClient) return globalMockPublicClient;",
    );
    rewritten = rewritten.replace(
      /export const getWalletClient = \(account: Account, chain: TChainConfig\) => \{/,
      "export const getWalletClient = (account: Account, chain: TChainConfig) => { if (globalMockWalletClient) return globalMockWalletClient;",
    );

    return rewritten;
  },
  "services/walletService.ts": (src) =>
    src.replace(
      /^import\s*\{\s*TWallet\s*\}\s*from\s*"@\/constants\/types\/walletTypes";/m,
      `import type { TWallet } from "@/constants/types/walletTypes";`,
    ),
};

export async function load(url, context, nextLoad) {
  if (url.startsWith("file://")) {
    const absPath = fileURLToPath(url);

    // JSON imports — Metro/RN supports these natively without an import
    // attribute, but Node's ESM loader requires `with { type: "json" }`.
    // Surface JSON files as ESM modules that re-export the parsed object
    // as the default export, matching Metro's behaviour.
    if (absPath.endsWith(".json")) {
      const raw = readFileSync(absPath, "utf8");
      const source = `export default ${raw};`;
      return {
        format: "module",
        shortCircuit: true,
        source,
      };
    }

    for (const [suffix, rewrite] of Object.entries(SOURCE_REWRITES)) {
      if (absPath.endsWith(suffix.replaceAll("/", sep))) {
        const raw = readFileSync(absPath, "utf8");
        const rewritten = rewrite(raw);
        const stripped = stripTypeScriptTypes(rewritten, {
          mode: "strip",
          sourceUrl: url,
        });
        return {
          format: "module",
          shortCircuit: true,
          source: stripped,
        };
      }
    }
  }
  return nextLoad(url, context);
}
