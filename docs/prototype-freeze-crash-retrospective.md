# Frozen `Object.prototype` vs. Strict-Mode Exports — Retrospective

**Status:** Fixed and device-verified 2026-08-12 (guarded by `pnpm check:protofreeze` + a boot canary)
**Owner:** Wallet team
**Date:** 2026-08-12
**Related:** `pollyfills.ts` (TWV-2026-021), `scripts/check-proto-freeze-safety.sh`, `docs/dapp-bridge-spec.md`, `docs/post-unlock-freeze-retrospective.md`

---

## TL;DR

Opening a swap on tower.exchange in the dApp browser force-closed the app the instant the approval sheet appeared. After that, **every** visit to the dApps screen crashed — across app restarts — and only stopped after about five minutes.

Two independent defects, stacked:

1. **The crash.** `pollyfills.ts` calls `Object.freeze(Object.prototype)`. `ox` (viem 2.x's core) ships ESM modules that export a function literally named `toString`, which Metro compiles to `exports.toString = …`. Assigning through a frozen prototype throws in strict mode, and Metro's compiled ESM is always strict. Metro's `inlineRequires` deferred the module load to first use, so the throw landed inside the approval sheet's pre-sign simulation rather than at boot.
2. **The amplifier.** The approval intent behind that sheet was persisted to SecureStore and re-presented on every mount of `ApprovalHost` — which only the dApps screen mounts. One crash became a permanently unopenable screen until the intent aged past `STALE_MS` (5 minutes). That TTL, not any healing, is the "wait 5-8 minutes" behaviour.

Neither is chain-specific, dApp-specific, or memory-related.

---

## How to recognise this crash

```
FATAL EXCEPTION: mqt_v_native
com.facebook.react.common.JavascriptException:
  TypeError: Cannot assign to read-only property 'toString', stack:
anonymous@1:4858582
loadModuleImplementation@1:241134
guardedLoadModule@1:240613
metroRequire@1:240165
getSignatureHash@1:5007547
...
```

The signature to look for is **`Cannot assign to read-only property '<Object.prototype member>'` with `metroRequire` / `loadModuleImplementation` directly beneath it.** That combination means: a module was being loaded for the first time, and its top-level export assignment collided with a frozen prototype. The frames *above* `metroRequire` tell you which feature happened to touch it first — they are **not** the bug.

Replace `toString` with any of `hasOwnProperty`, `valueOf`, `toLocaleString`, `isPrototypeOf`, `propertyIsEnumerable`; all behave identically.

---

## The hazard, stated generally

`Object.freeze(Object.prototype)` (added for TWV-2026-021 to kill the prototype-pollution class, CVE-2019-10744 and friends) makes every `Object.prototype` member non-writable. A module's `exports` object is a plain object that inherits from it. So any module doing:

```js
exports.toString = someFunction   // i.e. `export function toString() {}`
```

is assigning to a property that is inherited and read-only. What happens next depends **entirely on strict mode**:

| Module kind | Strict? | Result |
| --- | --- | --- |
| CJS (`lib/foo.js`, no `"use strict"`) | No | Assignment **silently no-ops**. The export is missing at runtime; you find out much later, somewhere unrelated. |
| ESM (compiled by Metro/Babel) | Yes — Babel adds `"use strict"` | Assignment **throws `TypeError`**. Hard crash. |

This is why the same latent problem produced two very different outcomes across three packages, and why the first two were survivable.

**And it will not crash at boot.** Metro's `inlineRequires` (on by default in Expo release builds) rewrites top-level imports into lazy `require()` calls at first *use*. The module therefore loads on whichever screen first reaches it. Ours was reached only through:

```
EvmTransactionSheet simulation effect
  → simulateAssetChanges            (services/security/txSimulator.ts)
  → viem simulateCalls
  → ox AbiItem.from → getSignatureHash
  → Hex.fromString → require('ox/Hex')   ← first load, throws
```

so it presented as "the dApp approval sheet crashes", which is about as far from "a polyfill froze a prototype" as a symptom can get.

### Known instances

| Package | Shape | Mode | Outcome |
| --- | --- | --- | --- |
| `bn.js` | `BN.prototype.toString = …` | sloppy | Silent; pre-loaded in `pollyfills.ts` |
| `posthog-react-native` | `exports.hasOwnProperty = …` | sloppy | Silent; pre-loaded in `pollyfills.ts` |
| `ox` (`Hex`, `Bytes`, `Base58`, `Base64`) | `export function toString()` | **strict** | **Hard crash**; pre-loaded in `pollyfills.ts` |
| `qrcode` (`browser.js`, `server.js`, `core/mode.js`) | `exports.toString = …` | sloppy | **Still latent.** `QRCode.toString()` is silently undefined. Harmless today because `services/qrMatrixCache.ts` only patches `create()`. |

---

## Mistakes we made (so you don't repeat them)

### Mistake 1: Naming a root cause from reading code instead of from the crash log

The investigation started by reading `EvmTransactionSheet.tsx` and finding a real-looking bug: `{tx.value && tx.value > 0n && …}`. A token swap sends `value: "0x0"` → `0n`, and `{0n && …}` evaluates to the bigint `0n`, which React 19 renders as a text child. That is a genuine defect, and it was presented as the root cause with a confident native-crash mechanism attached.

It was wrong. The device log showed the failure in a **passive effect** (`commitHookEffectListMount`), which only runs *after* the render has committed — so the render was fine. Two plausible bugs lived in the same file and only the log distinguished them.

Cost: two rounds of the user pushing back before anyone plugged in a phone. This is the same lesson as Mistake 1 in `docs/post-unlock-freeze-retrospective.md` ("guessing before measuring"), relearned.

**Do this instead:** `adb logcat -c`, reproduce, `adb logcat -b crash,main -d -v time`. Two minutes, and it is dispositive.

### Mistake 2: Reading "it fixes itself after N minutes" as memory pressure

A crash that clears on its own after a wait invites an OOM / GC / "let it settle" story. It was neither: `lowmemorykiller` logged *"device has enough memory … disable killing"* throughout, the device had 5.2 GB free, and all three crashes were **byte-identical** — same bundle offsets, same frames. Deterministic crashes are not resource crashes.

Any self-healing interval should first be matched against **TTL constants in the code**. `STALE_MS = 5 * 60 * 1000` in `services/bridge/pendingIntents.ts` was sitting in plain sight and matched the reported "5-8 minutes" exactly.

### Mistake 3: Not separating "what crashed" from "why it keeps crashing"

These had different causes and needed different fixes. Fixing only the `ox` collision would have left a persisted-intent replay able to brick the dApps screen on the next unrelated sheet bug. Fixing only the replay would have left the crash.

### Mistake 4: Warming the wrong copy of the module

The first fix pre-loaded the offenders with `require("ox/Hex")`. It passed the guard, passed every check, and **did not work on device** — the `TypeError` kept appearing.

`ox` has a condition-split exports map:

```jsonc
"./Hex": { "import": "./_esm/core/Hex.js", "default": "./_cjs/core/Hex.js" }
```

`_cjs` and `_esm` are **separate Metro module entries**, so warming one does nothing for the other. Both are strict (tsc emits `"use strict"` into its CJS output), so both throw.

Which one the app loads is a resolution detail, and guessing it wrong is *silent*. This was guessed wrong twice, in both directions: first `require("ox/Hex")` warmed `_cjs` when `_esm` was assumed to be live, then the "fix" for that warmed only `_esm` — and Metro actually resolves ox through `main` → **`_cjs`**. The final answer is to pre-load **both builds of both copies** and stop predicting.

The tell was behavioural and easy to miss: *the first swap after a fresh JS context failed, and every swap after it succeeded.* That is the signature of a once-per-context module-init failure, not of a fix working.

**Rule: pre-load with the same syntax the consumer uses.** ESM `import` for a dependency reached via `import`.

That was still not enough, and the next two attempts also failed:

- **Subpaths only warm one path.** `import "ox/Hex"` fixed the `simulateCalls` route and nothing else. `WebAuthnP256` pulled `Base64`, `viem/ens` pulled another. Every new consumer found a different gap.
- **There are two copies of `ox` installed.** `@metamask/smart-accounts-kit` pins `ox@0.8.1`, viem pins `ox@0.9.6` — both *exact*, so pnpm cannot dedupe them. A bare `import "ox"` reaches only the hoisted 0.8.1; viem loads `node_modules/viem/node_modules/ox`, which stayed cold and kept throwing.
- **Barrels are not the answer either.** `import "ox"` would cover every module in one line, but it drags ~2.6 MB through startup, and a barrel's `export * as X from` re-exports can compile to lazy getters under `inlineRequires` — warming nothing. Enumerate the offending files instead: 16 files, ~184 KB.

### How to find the offender in seconds (do this FIRST)

Four attempts were spent guessing at specifiers. Two commands settle it.

**On the device**, LogBox collapses `node_modules` frames, so every stack points at whichever app function triggered the load and hides the real module. Get the raw stack (`pollyfills.ts` now hooks `ErrorUtils.reportFatalError` in `__DEV__` to print it), then hand the bundle offsets to Metro:

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"stack":[{"file":"<bundle-url>","lineNumber":<line>,"column":<col>,"methodName":"anonymous"}]}' \
  http://localhost:8081/symbolicate
→ node_modules/viem/node_modules/ox/_cjs/core/Hex.js:23
```

That names the file, the *copy*, **and the build**. It is the only method in this whole investigation that produced the right answer on the first try.

**In Node**, for a quick approximation of which packages are affected:

```
node -e 'Object.freeze(Object.prototype); require("viem/actions")'
```

Useful, but it only models the CJS graph — do not conclude which *build* the app loads from it.

### Mistake 5: Letting an approval surface fail into nothing

The error boundary added alongside the crash fix rendered `null` on failure. That converted a force-close into something arguably worse in a wallet: the user asked tower.exchange for a swap, the ERC-20 `approve` sheet threw while mounting, **no sheet appeared at all**, and the dApp moved on to the next step. The reporting user reasonably concluded the wallet had approved a spend allowance without asking.

It had not — `handleDecision` returns on `outcome: "reject"` before `adapter.executeApproval`, so nothing was signed and no allowance was granted. But *"nothing was signed"* is invisible. A silent rejection and a silent approval are indistinguishable from the outside, and on a spend-approval surface the user will assume the worse one.

**Rule: an approval surface must never fail into empty space.** It states the outcome, or it is a bug.

### Mistake 6: Letting an enrichment gate a safety-critical surface

The throw reached the boundary through `simulateAssetChanges`, which is *optional* — a nicety layered on top of the static predictor and the decoded calldata that actually carry the safety content. `simulateAssetChanges` is even documented "never throws" and has its own `try`/`catch`, but that does not cover the inlined `require` of its own module graph at the **call site**, which is where the module-init failure landed.

**Rule: the approval sheet must render even if every optional enrichment fails.** Simulation, AI summary, ENS lookup, clear-signing descriptors: all wrapped, all degradable, none load-bearing.

### Mistake 7: Trusting a guard that had never been seen to fail

The first version of `check-proto-freeze-safety.sh` passed — including when the fix was deliberately removed — because it grepped the raw file and matched the `require("ox/Hex")` occurrences inside the explanatory comments. A guard is not a guard until you have watched it fail on the real regression. It now strips comment lines before matching.

---

## Diagnosing the next one

1. **Capture the crash.** `adb logcat -c`; reproduce; `adb logcat -b crash,main -d -v time > crash.log`. Look for `FATAL EXCEPTION`.
2. **Classify before theorising.** JS `TypeError` / native C++ abort / `onRenderProcessGone` / lowmemorykiller all look completely different, and each rules out most hypotheses immediately.
3. **Check determinism.** Identical bundle offsets across repeats ⇒ logic bug, not resource pressure.
4. **For a self-healing symptom, grep for the interval.** `rg "60 \* 1000|STALE|TTL|MAX_AGE"` and compare against the reported wait.
5. **Design one falsifiable test.** Here, "wait 6 minutes with the app *fully closed*" separated a persisted-state TTL (wall-clock, so closing does not matter) from an uptime-scoped cause (closing resets it). One run, one answer.

---

## What fixed what

| Fix | File | Addresses |
| --- | --- | --- |
| Pre-load `ox/Hex`, `ox/Bytes`, `ox/Base58`, `ox/Base64` before the freeze, as **ESM `import`** (plus `require` twins) | `pollyfills.ts` | The crash |
| Simulation wrapped in `try` + `.catch`, degrades to "could not simulate" | `EvmTransactionSheet.tsx`, `EvmBatchCallsSheet.tsx` | Sheet no longer depends on an optional enrichment |
| Boundary renders a visible "Request declined" instead of `null` | `services/bridge/ApprovalHost.tsx` | Silent-rejection-looks-like-approval |
| Build guard for new strict-mode offenders | `scripts/check-proto-freeze-safety.sh`, `pnpm check:protofreeze` | Instance #4 |
| Discard the persisted queue on boot instead of re-presenting it | `services/bridge/pendingIntents.ts` | The "every visit, forever" escalation |
| Regression tests for cold-start queue handling | `services/bridge/pendingIntents.test.ts` | Same |
| Error boundary around the approval sheet | `services/bridge/ApprovalHost.tsx` | Any sheet throw taking down the whole app |
| Boolean JSX guards on `value` | `EvmTransactionSheet.tsx`, `EvmBatchCallsSheet.tsx` | The unrelated latent `0n` defect found en route |

---

## Rules for the next person

- **Adding a dependency?** `pnpm check:protofreeze` fails the build if it exports an `Object.prototype` member name. Fix by pre-loading the offending **files** in `pollyfills.ts` *above* the freeze, by exact path, one line per file per build (`_cjs` **and** `_esm`) per installed copy.
- **Retest only after `adb shell am force-stop`.** Fast Refresh does not re-run module-scope side effects, so `pollyfills.ts` keeps the *old* freeze and *old* pre-loads while showing your new component line numbers. Several rounds of this investigation were spent reading logs from code that was not running. The boot line `[TWV-2026-021] pre-load canary: N/N warmed` is the proof the new file executed; if it is absent, the test is void.
- **Do not trust the canary alone.** It proves the modules *it lists* are warm. It reported 10/10 while the build the app actually loads was still cold. Only "no `read-only property` error during a real swap" proves the fix.
- **Write pre-loads as literal specifiers, and match the consumer's syntax.** Metro resolves at bundle time, so `require(someVariable)` bundles nothing and leaves the guard silently dead. And for a condition-split exports map, `require("pkg/x")` and `import "pkg/x"` are *different modules* — pre-load with `import` when the consumer uses `import`, or you will warm a twin that was never on the failing path.
- **Verify a pre-load on device, not by re-running the guard.** The guard proves the entry exists; only the device proves it warmed the right module. "First attempt after a cold JS context fails, later ones succeed" means the pre-load missed.
- **Never remove the pre-loads to "clean up imports".** They look like dead code and are load-bearing. The comments in `pollyfills.ts` say so at each site.
- **Do not add state that re-presents a UI surface on mount from disk** without asking what happens when that surface cannot render. The "Persist pending intents" bullet in `docs/dapp-bridge-spec.md` permits "clean rejection on boot" precisely so this cannot recur.
- **`Object.freeze(Object.prototype)` stays for now.** It removes a real vulnerability class. The cost is this sharp edge, and the guard is how we pay it.

---

## Decisions

### Keep `Object.freeze`, do not switch to `preventExtensions`

Tempting, and rejected on the security merits.

Prototype pollution is usually framed as an attacker *adding* a key (`Object.prototype.isAdmin = true`), and `Object.preventExtensions(Object.prototype)` blocks exactly that while leaving existing members writable — which would make this entire class of breakage disappear. No pre-loads, no guard, no whack-a-mole.

The reason it loses: pollution gadgets write **arbitrary** keys, including ones that already exist. `preventExtensions` leaves `toString`, `valueOf`, `hasOwnProperty` and friends writable, so `{"__proto__":{"hasOwnProperty":…}}` through an unsafe merge still lands. `hasOwnProperty` in particular is a live gadget — any `obj.hasOwnProperty(k)` in the tree becomes an attacker-controlled call. That is not a narrow residual risk in a wallet whose dApp bridge parses JSON-RPC params from arbitrary web pages.

An accessor-based scheme (getter/setter on `Object.prototype.toString` that permits shadowing on other objects but rejects writes to the prototype itself) would satisfy both constraints, and was rejected as too clever: a bespoke prototype-hardening mechanism on the hot path of every object in the app, in a wallet, to save eight import lines.

**The breakage is now bounded and enforced**, which changes the trade. `check:protofreeze` fails the build per module per copy, and the boot canary catches a mis-resolved pre-load on device. Revisit only if the pre-load list starts growing on its own.

### Do not collapse `ox` to one version

`@metamask/smart-accounts-kit` pins `ox@0.8.1` and viem pins `ox@0.9.6`, both exact, so pnpm installs two copies. Deduping via `pnpm.overrides` would remove the nested-copy failure mode and ~1 MB of duplicate source.

Not worth it:

- ox is pre-1.0, so `0.8 → 0.9` is a potentially breaking bump, and the consumer is the **EIP-7702 delegation / smart-account signing path**. Trading a signing-path regression risk for build hygiene is a bad deal in a wallet.
- The problem it would solve is already solved and *enforced*. Deduping would remove eight import lines and one guard branch, not a class of bug.
- The duplicate costs bundle size, not correctness. The pre-load itself is ~184 KB (16 small modules), not the 2.6 MB a barrel import would have cost.

Revisit if `@metamask/smart-accounts-kit` relaxes its pin upstream, at which point the dedupe is free.

### Found on the way out: the queue was writing the seed to disk

Chasing the `Value being stored in SecureStore is larger than 2048 bytes` warning turned up a pre-existing security bug with nothing to do with the crash.

`pendingIntents.persist()` serialised the whole queue, and an `ApprovalIntent` carries `intent.wallet` — a `TWallet` with `privateKey` and `seedPhrase`. It wrote them with a bare `SecureStore.setItemAsync(key, value)`, **no options**. `services/security/walletSecureStore.ts` (TWV-2026-004) states the rule it broke outright: every write of wallet-credential material must go through that wrapper so `WHEN_UNLOCKED_THIS_DEVICE_ONLY` is never omitted, and "direct `SecureStore.setItemAsync(key, value)` on wallet-credential keys is a regression". Without that flag the item is eligible for iCloud-Keychain sync and Android backup — the seed-exfiltration path the flag exists to close. The canonical wallet copy had it; this shadow copy did not.

So every dApp approval left a second, weaker copy of the signing key on disk, and the 2048-byte warning meant the write might silently fail (and will throw in a future SDK).

`persist()` is deleted. Nothing is lost: `hydrate()` already discards a restored queue, so the write had no reader. `hydrate()` keeps its `deleteItemAsync` as a migration that purges what older builds left behind. Two tests lock it in, both verified to fail if the write returns.

**Rule: an approval intent is signing context, not persistable state.** If something ever needs approvals to survive a restart, persist a reference, never `intent.wallet`.

### Added instead: a boot canary

CI can only prove a pre-load *line* exists. It cannot prove the line resolved to the module the app actually loads — which is exactly how four fixes passed every check and failed on device.

`pollyfills.ts` now re-requires each pre-loaded module immediately after the freeze, under `__DEV__`. A warmed module is a cache hit and cannot throw; a missed one runs its factory under the frozen prototype and throws at boot, naming the specifier. Every one of the four failed attempts would have been caught in seconds instead of a user-reported crash.
