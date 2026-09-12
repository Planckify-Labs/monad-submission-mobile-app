// TWV-2026-002 — CSPRNG polyfill MUST stay the first import of this file
// AND this file MUST be the first import of `app/_layout.tsx`. Viem and
// `@scure/bip39` read `globalThis.crypto.getRandomValues` at call time;
// if any Viem-importing module loads before this polyfill, entropy can
// silently collapse to a non-CSPRNG fallback. Enforced by the self-check
// below + `services/walletService.test.ts`.
import "react-native-get-random-values";
import "fastestsmallesttextencoderdecoder";

// Prototype-freeze pre-loads. `ox` exports four functions named
// `toString`, which compile to `exports.toString = …` and throw against
// the frozen `Object.prototype` set up in this file's body. They must be
// loaded while assignment is still legal.
//
// Import hoisting is load-bearing: these evaluate before the
// `Object.freeze` below, which is the whole point. They stay AFTER the
// CSPRNG polyfill above (import order is evaluation order) so entropy
// setup still wins its own race.
//
// **Exact file paths, one per offending module per installed copy.**
// This looks unpleasant and every prettier-looking alternative was tried
// and failed on device:
//
//  1. `require("ox/Hex")` resolved ox's `require`/`default` condition to
//     `_cjs/core/Hex.js` — a different module instance from the `_esm`
//     build reached via `import`. Warmed the wrong twin.
//  2. Package-subpath imports only warm what sits on that one path.
//     `viem/utils` pulled `Hex`, `WebAuthnP256` pulled `Base64`,
//     `viem/ens` pulled another; every new consumer found a fresh gap.
//  3. There are TWO copies of ox. `@metamask/smart-accounts-kit` pins
//     `ox@0.8.1`, viem pins `ox@0.9.6` — both exact, so pnpm cannot
//     dedupe. A bare `"ox"` reaches only the hoisted 0.8.1 while viem
//     loads its own nested copy, which stayed cold and kept throwing.
//  4. Barrel imports (`import "ox"`) would cover every module at once,
//     but they drag ~2.6 MB of ox through app startup, and a barrel's
//     `export * as X from` re-exports can compile to lazy getters under
//     `inlineRequires` — which would leave the submodules cold anyway.
//
// A literal file path has none of those failure modes: no exports map,
// no condition negotiation, no barrel indirection, and a side-effect
// import has no binding for `inlineRequires` to defer, so it is eager.
// Metro keys modules by resolved absolute path, so these are the exact
// instances viem and smart-accounts-kit receive. 92 KB total.
//
//  5. Pre-loading only `_esm` missed, because Metro resolves ox through
//     `main` -> `_cjs`, not the `import` condition. The canary happily
//     reported "10/10 warmed" while warming the wrong build, and the
//     `_cjs` twin the app actually loads stayed cold. Metro's
//     `/symbolicate` endpoint is what finally named it:
//     `viem/node_modules/ox/_cjs/core/Hex.js:23`.
//
// So: BOTH builds, BOTH copies. Which one Metro picks depends on its
// package-exports settings, and that is not worth predicting — a wrong
// guess here is silent, and the guard cannot catch it because the line
// is present either way. Loading the unused twin costs one cache entry.
// ~184 KB total across 16 small modules.
import "./node_modules/ox/_cjs/core/Hex.js";
import "./node_modules/ox/_cjs/core/Bytes.js";
import "./node_modules/ox/_cjs/core/Base58.js";
import "./node_modules/ox/_cjs/core/Base64.js";
import "./node_modules/ox/_esm/core/Hex.js";
import "./node_modules/ox/_esm/core/Bytes.js";
import "./node_modules/ox/_esm/core/Base58.js";
import "./node_modules/ox/_esm/core/Base64.js";
import "./node_modules/viem/node_modules/ox/_cjs/core/Hex.js";
import "./node_modules/viem/node_modules/ox/_cjs/core/Bytes.js";
import "./node_modules/viem/node_modules/ox/_cjs/core/Base58.js";
import "./node_modules/viem/node_modules/ox/_cjs/core/Base64.js";
import "./node_modules/viem/node_modules/ox/_esm/core/Hex.js";
import "./node_modules/viem/node_modules/ox/_esm/core/Bytes.js";
import "./node_modules/viem/node_modules/ox/_esm/core/Base58.js";
import "./node_modules/viem/node_modules/ox/_esm/core/Base64.js";
// Third ox copy: `@metamask/smart-accounts-kit` pins 0.8.1 and, since the
// WalletConnect install (`@walletconnect/utils` pins 0.9.3, which is now
// the hoisted copy), it lives nested under its own package.
import "./node_modules/@metamask/smart-accounts-kit/node_modules/ox/_cjs/core/Hex.js";
import "./node_modules/@metamask/smart-accounts-kit/node_modules/ox/_cjs/core/Bytes.js";
import "./node_modules/@metamask/smart-accounts-kit/node_modules/ox/_cjs/core/Base58.js";
import "./node_modules/@metamask/smart-accounts-kit/node_modules/ox/_cjs/core/Base64.js";
import "./node_modules/@metamask/smart-accounts-kit/node_modules/ox/_esm/core/Hex.js";
import "./node_modules/@metamask/smart-accounts-kit/node_modules/ox/_esm/core/Bytes.js";
import "./node_modules/@metamask/smart-accounts-kit/node_modules/ox/_esm/core/Base58.js";
import "./node_modules/@metamask/smart-accounts-kit/node_modules/ox/_esm/core/Base64.js";
// WalletConnect stack (deep-link spec §7.1, gate 00-C). `uint8arrays`
// exports `toString`, `multiformats` exports `toString` from its bytes
// helper, and `es-toolkit`'s lodash-compat layer exports `toString`. All
// three reach the app through `@walletconnect/{core,utils,relay-auth}`.
// Both builds, by exact path, same rules as ox above.
import "./node_modules/uint8arrays/cjs/src/to-string.js";
import "./node_modules/uint8arrays/cjs/src/index.js";
import "./node_modules/uint8arrays/esm/src/to-string.js";
import "./node_modules/multiformats/cjs/src/bytes.js";
import "./node_modules/multiformats/esm/src/bytes.js";
import "./node_modules/es-toolkit/dist/compat/util/toString.js";
import "./node_modules/es-toolkit/dist/compat/util/toString.mjs";
import "./node_modules/es-toolkit/dist/compat/compat.js";
import "./node_modules/es-toolkit/dist/compat/compat.mjs";
import "./node_modules/es-toolkit/dist/compat/index.js";
import "./node_modules/es-toolkit/dist/compat/index.mjs";

// Native-JSI crypto — replaces the pure-JS fallbacks viem / @scure / @noble
// use (secp256k1, sha256, keccak256, pbkdf2, HMAC, etc.) with C++ via JSI.
// Order matters: install AFTER the CSPRNG polyfill so the native module's
// RNG picks up `react-native-get-random-values`, and BEFORE any import
// that pulls in `viem/accounts` or `@scure/bip32` so their lazy binding
// to `global.crypto` sees the native implementations.
//
// Impact on this app:
//   - BIP-32 derivation (`mnemonicToAccount`) — ~10× faster on mobile
//   - ECDSA sign / verify — ~10× faster
//   - SHA-256 / keccak256 batch work — ~20× faster
//
// Does NOT accelerate Ed25519 (Solana) — that still goes through the
// WebCrypto polyfill below. See the optional worker-offload in
// `services/cryptoWorker.ts` for the Solana-side speedup.
import { install as installQuickCrypto } from "react-native-quick-crypto";

installQuickCrypto();

// TWV-2026-070 — Ed25519 polyfill MUST load after the CSPRNG polyfill and
// the TextEncoder/TextDecoder shim, and BEFORE any `@solana/kit` import.
// Hermes' WebCrypto ships without Ed25519; without this shim,
// `subtle.generateKey({name:'Ed25519'}, …)` throws at runtime and the
// Solana signing path silently breaks TWV-2026-046 parity.
//
// `@noble/ed25519` (the hash backend the polyfill uses) calls
// `crypto.subtle.digest('SHA-512', …)` via its `etc.sha512Async` hook.
// Hermes does not implement `subtle.digest`, so we install a pure-JS
// SHA-512 (@noble/hashes) BEFORE the polyfill is called. Any later
// mutation of `etc.sha512Async` would silently re-introduce the
// `subtle.digest` dependency, so reviewers should catch edits that
// drop this block.
import * as ed25519 from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2";

ed25519.etc.sha512Async = async (...messages: Uint8Array[]) => {
  let total = 0;
  for (const m of messages) total += m.length;
  const joined = new Uint8Array(total);
  let off = 0;
  for (const m of messages) {
    joined.set(m, off);
    off += m.length;
  }
  return sha512(joined);
};
ed25519.etc.sha512Sync = (...messages: Uint8Array[]) => {
  let total = 0;
  for (const m of messages) total += m.length;
  const joined = new Uint8Array(total);
  let off = 0;
  for (const m of messages) {
    joined.set(m, off);
    off += m.length;
  }
  return sha512(joined);
};

// The react-native entry of this package does NOT auto-install — it
// only exports `install()`. Call it explicitly here so the polyfill
// actually runs. Enforced by the self-check below.
import { install as installEd25519Polyfill } from "@solana/webcrypto-ed25519-polyfill";

installEd25519Polyfill();

// The v2.0.0 polyfill compares `algorithm !== "Ed25519"` with strict
// string equality, but `@solana/keys` (and Firefox) pass the algorithm
// as `{ name: "Ed25519" }` per the WebCrypto spec. When the object
// form is used, the polyfill skips its Ed25519 branch, falls through
// to the native `generateKey`/`importKey` — which doesn't exist on
// Hermes — and throws `TypeError: No native ... function exists`.
// Normalise the algorithm argument to the string form the polyfill
// expects so both call styles reach the polyfill's implementation.
(() => {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle as
    | (SubtleCrypto & {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        generateKey: (...args: any[]) => Promise<any>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        importKey: (...args: any[]) => Promise<any>;
      })
    | undefined;
  if (!subtle) return;
  const normalizeAlg = (algorithm: unknown): unknown => {
    if (
      algorithm &&
      typeof algorithm === "object" &&
      "name" in (algorithm as Record<string, unknown>) &&
      (algorithm as { name: unknown }).name === "Ed25519"
    ) {
      return "Ed25519";
    }
    return algorithm;
  };
  const origGenerateKey = subtle.generateKey.bind(subtle);
  subtle.generateKey = (algorithm: unknown, ...rest: unknown[]) =>
    origGenerateKey(normalizeAlg(algorithm), ...rest);
  const origImportKey = subtle.importKey.bind(subtle);
  subtle.importKey = (
    format: unknown,
    keyData: unknown,
    algorithm: unknown,
    ...rest: unknown[]
  ) => origImportKey(format, keyData, normalizeAlg(algorithm), ...rest);
})();

if (typeof globalThis.crypto?.getRandomValues !== "function") {
  // Fail loud. A missing CSPRNG at boot is a seed-entropy incident —
  // see MetaMask / Trust Wallet Core 2023 post-mortems cited in the spec.
  throw new Error(
    "CSPRNG polyfill missing: `crypto.getRandomValues` is not a function. " +
      "Check that `pollyfills.ts` is imported before any Viem / @scure/bip39 code.",
  );
}

// ---------------------------------------------------------------------
// Pre-freeze module loads. Everything between here and the
// `Object.freeze` call below exists for one reason: these modules assign
// to a property name that `Object.prototype` also defines, and that
// assignment must land while the prototype is still writable.
//
// These `require` calls look like dead code. They are load-bearing.
// Deleting one does not fail a test or a type-check — it force-closes
// the app on whichever screen first touches that module. Background,
// failure signatures, and the diagnostic procedure:
// `docs/prototype-freeze-crash-retrospective.md`. `pnpm check:protofreeze`
// enforces the list.
// ---------------------------------------------------------------------

// Pre-load bn.js (used by @solana/web3.js v1) BEFORE the prototype
// freeze below. bn.js assigns `BN.prototype.toString = …` which
// fails after `Object.freeze(Object.prototype)` because `toString`
// is inherited from the now-frozen `Object.prototype`. Loading the
// module here lets it install its prototype methods while assignment
// is still permitted.
try {
  require("bn.js");
} catch {}

// Same issue, different shape: @posthog/core's bundled CJS output does
// `exports.hasOwnProperty = <helper>` (it exports a utility literally
// named `hasOwnProperty`). Once `Object.prototype.hasOwnProperty` is
// frozen below, that assignment throws "Cannot assign to read-only
// property 'hasOwnProperty'" the first time anything imports
// posthog-react-native. Pre-loading here lets the assignment land on
// the (still-writable) exports object before the freeze; the module
// cache then serves that same object to `services/analytics/posthog.ts`
// later, freeze or no freeze.
try {
  require("posthog-react-native");
} catch {}

// `ox` — the third instance of this class, and the one that shipped a
// crash — is handled by the exact-path imports at the TOP of this file.
// They have to be `import` statements to be hoisted above the freeze, so
// they cannot live down here with their siblings. Read the note up there
// before touching them; four different spellings were tried on device
// and three of them silently warmed the wrong module.

// TWV-2026-021 diagnostic — name the module that lost a frozen-prototype
// assignment.
//
// Metro's `guardedLoadModule` catches a module-factory throw, hands it to
// `ErrorUtils.reportFatalError`, and returns `undefined` (see
// metro-runtime/src/polyfills/require.js). LogBox then renders it with
// `node_modules` frames COLLAPSED, so the report names the app function
// that happened to trigger the load and hides the package that actually
// failed. That is why this bug was chased through four wrong packages:
// the stack on screen pointed at `simulateAssetChanges` every time, and
// the real offender was never visible.
//
// This prints the raw, unfiltered stack for exactly this error class, so
// the failing module names itself. __DEV__ only.
if (__DEV__) {
  const EU = (
    globalThis as unknown as {
      ErrorUtils?: { reportFatalError?: (e: unknown) => void };
    }
  ).ErrorUtils;
  const original = EU?.reportFatalError;
  if (EU && typeof original === "function") {
    EU.reportFatalError = (e: unknown) => {
      try {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("read-only property")) {
          console.error(
            "[TWV-2026-021] frozen-prototype assignment failed. " +
              "The LAST node_modules frame below is the module to pre-load:\n" +
              String((e as Error)?.stack ?? e),
          );
        }
      } catch {
        // Diagnostics must never mask the original report.
      }
      return original.call(EU, e);
    };
  }
}

// TWV-2026-021 — freeze the global prototypes before any third-party
// code runs. CVE-2019-10744 (lodash) and friends mutate
// `Object.prototype` to swap addresses / chainIds mid-request; freezing
// removes the class wholesale. Self-check below logs (does not throw)
// if a downstream dep un-freezes it so we can detect regressions
// without bricking the app.
try {
  Object.freeze(Object.prototype);
  Object.freeze(Array.prototype);
  if (!Object.isFrozen(Object.prototype) || !Object.isFrozen(Array.prototype)) {
    console.error(
      "[TWV-2026-021] prototype freeze unstuck — a dep un-froze it. " +
        "Investigate before merging any prototype-pollution-relevant change.",
    );
  }
} catch (e) {
  console.error("[TWV-2026-021] prototype freeze failed:", e);
}

// TWV-2026-021 canary — prove the pre-loads above actually warmed the
// modules they were meant to.
//
// This exists because `pnpm check:protofreeze` cannot: CI can only prove
// a pre-load LINE exists, not that it resolved to the module the app
// really loads. Four fixes for the ox crash passed CI and failed on
// device — wrong export condition, wrong package copy, wrong subpath —
// and each was invisible until a user hit the one screen that touched
// the cold module.
//
// The check is a cache probe. A warmed module re-requires as a cache hit
// and cannot throw; a missed one runs its factory now, under the frozen
// prototype, and throws exactly as it would have on that screen. So a
// miss is loud, at boot, naming the specifier, instead of silent until a
// swap sheet blanks out.
//
// __DEV__ only: it is a development trip-wire, and in production every
// listed module has already been loaded by the imports above, so the
// probe would be pure startup cost.
if (__DEV__) {
  // Both builds are probed, not just the one we think Metro picks.
  // Probing only `_esm` is precisely how this canary certified a broken
  // fix: it reported 10/10 while the `_cjs` twin the app actually loads
  // was still cold.
  const canaries: [string, () => unknown][] = [
    ["ox/_cjs/Hex", () => require("./node_modules/ox/_cjs/core/Hex.js")],
    ["ox/_cjs/Bytes", () => require("./node_modules/ox/_cjs/core/Bytes.js")],
    ["ox/_cjs/Base58", () => require("./node_modules/ox/_cjs/core/Base58.js")],
    ["ox/_cjs/Base64", () => require("./node_modules/ox/_cjs/core/Base64.js")],
    ["ox/_esm/Hex", () => require("./node_modules/ox/_esm/core/Hex.js")],
    ["ox/_esm/Bytes", () => require("./node_modules/ox/_esm/core/Bytes.js")],
    ["ox/_esm/Base58", () => require("./node_modules/ox/_esm/core/Base58.js")],
    ["ox/_esm/Base64", () => require("./node_modules/ox/_esm/core/Base64.js")],
    [
      "viem>ox/_cjs/Hex",
      () => require("./node_modules/viem/node_modules/ox/_cjs/core/Hex.js"),
    ],
    [
      "viem>ox/_cjs/Bytes",
      () => require("./node_modules/viem/node_modules/ox/_cjs/core/Bytes.js"),
    ],
    [
      "viem>ox/_cjs/Base58",
      () => require("./node_modules/viem/node_modules/ox/_cjs/core/Base58.js"),
    ],
    [
      "viem>ox/_cjs/Base64",
      () => require("./node_modules/viem/node_modules/ox/_cjs/core/Base64.js"),
    ],
    [
      "viem>ox/_esm/Hex",
      () => require("./node_modules/viem/node_modules/ox/_esm/core/Hex.js"),
    ],
    [
      "viem>ox/_esm/Bytes",
      () => require("./node_modules/viem/node_modules/ox/_esm/core/Bytes.js"),
    ],
    [
      "viem>ox/_esm/Base58",
      () => require("./node_modules/viem/node_modules/ox/_esm/core/Base58.js"),
    ],
    [
      "viem>ox/_esm/Base64",
      () => require("./node_modules/viem/node_modules/ox/_esm/core/Base64.js"),
    ],
    [
      "sak/ox/_cjs/Hex",
      () =>
        require("./node_modules/@metamask/smart-accounts-kit/node_modules/ox/_cjs/core/Hex.js"),
    ],
    [
      "sak/ox/_cjs/Bytes",
      () =>
        require("./node_modules/@metamask/smart-accounts-kit/node_modules/ox/_cjs/core/Bytes.js"),
    ],
    [
      "sak/ox/_cjs/Base58",
      () =>
        require("./node_modules/@metamask/smart-accounts-kit/node_modules/ox/_cjs/core/Base58.js"),
    ],
    [
      "sak/ox/_cjs/Base64",
      () =>
        require("./node_modules/@metamask/smart-accounts-kit/node_modules/ox/_cjs/core/Base64.js"),
    ],
    [
      "sak/ox/_esm/Hex",
      () =>
        require("./node_modules/@metamask/smart-accounts-kit/node_modules/ox/_esm/core/Hex.js"),
    ],
    [
      "sak/ox/_esm/Bytes",
      () =>
        require("./node_modules/@metamask/smart-accounts-kit/node_modules/ox/_esm/core/Bytes.js"),
    ],
    [
      "sak/ox/_esm/Base58",
      () =>
        require("./node_modules/@metamask/smart-accounts-kit/node_modules/ox/_esm/core/Base58.js"),
    ],
    [
      "sak/ox/_esm/Base64",
      () =>
        require("./node_modules/@metamask/smart-accounts-kit/node_modules/ox/_esm/core/Base64.js"),
    ],
    [
      "uint8arrays/cjs/to-string",
      () => require("./node_modules/uint8arrays/cjs/src/to-string.js"),
    ],
    [
      "uint8arrays/cjs/index",
      () => require("./node_modules/uint8arrays/cjs/src/index.js"),
    ],
    [
      "uint8arrays/esm/to-string",
      () => require("./node_modules/uint8arrays/esm/src/to-string.js"),
    ],
    [
      "multiformats/cjs/bytes",
      () => require("./node_modules/multiformats/cjs/src/bytes.js"),
    ],
    [
      "multiformats/esm/bytes",
      () => require("./node_modules/multiformats/esm/src/bytes.js"),
    ],
    [
      "es-toolkit/compat/toString.js",
      () => require("./node_modules/es-toolkit/dist/compat/util/toString.js"),
    ],
    [
      "es-toolkit/compat/toString.mjs",
      () => require("./node_modules/es-toolkit/dist/compat/util/toString.mjs"),
    ],
    [
      "es-toolkit/compat/compat.js",
      () => require("./node_modules/es-toolkit/dist/compat/compat.js"),
    ],
    [
      "es-toolkit/compat/compat.mjs",
      () => require("./node_modules/es-toolkit/dist/compat/compat.mjs"),
    ],
    [
      "es-toolkit/compat/index.js",
      () => require("./node_modules/es-toolkit/dist/compat/index.js"),
    ],
    [
      "es-toolkit/compat/index.mjs",
      () => require("./node_modules/es-toolkit/dist/compat/index.mjs"),
    ],
    ["bn.js", () => require("bn.js")],
    ["posthog-react-native", () => require("posthog-react-native")],
  ];
  const missed: string[] = [];
  for (const [label, load] of canaries) {
    try {
      load();
    } catch {
      missed.push(label);
    }
  }
  // Always print, pass or fail. A canary that is silent on success makes
  // "no output" ambiguous between "everything warmed" and "this file
  // never re-executed" — and the second is the common case, because
  // Fast Refresh does NOT re-run module-scope side effects in the entry
  // graph. Chasing that ambiguity cost a full retest cycle.
  if (missed.length === 0) {
    console.info(
      `[TWV-2026-021] pre-load canary: ${canaries.length}/${canaries.length} warmed, prototypes frozen.`,
    );
  } else {
    console.error(
      `[TWV-2026-021] pre-load MISSED (${missed.length}/${canaries.length}): ${missed.join(", ")}. ` +
        "These were not warmed before the prototype freeze, so each will " +
        "throw the first time any screen touches it. See " +
        "docs/prototype-freeze-crash-retrospective.md.",
    );
  }
}

// TWV-2026-070 self-check — Ed25519 must be usable at boot. A missing
// polyfill means Solana key generation silently falls through to a
// non-Ed25519 path or throws at sign time — either way an incident.
// Mirrors the TWV-2026-002 pattern: fail loud, not warn.
(async () => {
  try {
    await crypto.subtle.generateKey(
      { name: "Ed25519" } as unknown as EcKeyGenParams,
      false,
      ["sign", "verify"],
    );
  } catch {
    throw new Error(
      "TWV-2026-070: Ed25519 unavailable at boot — polyfill did not install. " +
        "Verify `@solana/webcrypto-ed25519-polyfill` import order in pollyfills.ts.",
    );
  }
})();
