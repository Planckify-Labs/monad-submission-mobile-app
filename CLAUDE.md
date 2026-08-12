# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
# Development
pnpm start                    # Start Expo dev server
pnpm android                  # expo run:android
pnpm ios                      # expo run:ios

# Code Quality
pnpm lint                     # expo lint (ESLint)
pnpm check:syntax             # tsc --noEmit --skipLibCheck
pnpm check:chains             # Guardrail: fails if shared code branches on chain namespace (see below)
pnpm biome:check              # Biome format + lint with --write
pnpm biome:check:unsafeFix    # Same + unsafe autofixes

# Tests
pnpm test                     # Runs test:vitest then test:node
pnpm test:vitest              # Vitest (see vitest.config.ts for the explicit include list)
pnpm test:node                # node --test for files importing "node:test" (uses custom resolver)
pnpm test:watch               # Vitest in watch mode

# Building (EAS)
eas build --platform android --profile development
eas build --platform ios --profile development
eas build --platform android --profile production
```

`test:node` runs through `scripts/run-node-tests.sh`, which loads
`services/walletKit/evm/_test-resolver.mjs` to stub RN-only modules
(`expo-secure-store`, `@/lib/storage/mmkv`) and rewrite `@/*` aliases +
extensionless TS imports. New `node:test` files should fit that harness —
if a test needs a module the resolver doesn't stub, extend the resolver
rather than reaching for a different runner. Vitest's `include` list is
explicit; new vitest files must be added there to run.

## Architecture Overview

### Tech Stack
- **Framework:** React Native + Expo 54 (Hermes, New Architecture)
- **Routing:** Expo Router (file-based, `/app`)
- **State:** TanStack Query v5 for server state; custom `useRQGlobalState` for shared client state
- **Styling:** NativeWind (Tailwind for RN)
- **Chains:** Viem (EVM), `@solana/kit` + `@solana/web3.js` (Solana), `@mysten/sui` (Sui)
- **AI Agent:** Vercel AI SDK (`@ai-sdk/react`, `@ai-sdk/anthropic`)
- **Forms:** react-hook-form + zod
- **Package manager:** pnpm (workspace)

### Multi-chain architecture (important)

The app supports EVM, Solana, and Sui. Chain-specific knowledge lives
behind a registry; shared code dispatches through it instead of
branching on namespace strings.

- `services/walletKit/` — `WalletKitAdapter` registry. `bootstrap.ts`
  wires per-namespace adapters; `registry.ts` exposes lookup; `chainInfo.ts`
  has the helpers shared code should use.
- `services/chains/{evm,solana,sui}/` — per-namespace implementations
  (derivation, codecs, transfer services, error mapping).
- `services/bridge/` — EIP-1193-style **dApp bridge**: `DappBridge`,
  `ApprovalHost`, `inspector`, `redact`, `pendingIntents`, `renderers`.
  This replaces the older `services/ethereumProvider.ts` approach.
- `services/agent-executors/`, `services/nanopay/`, `services/staking/`,
  `services/swap/`, `services/tokens/` — feature services that already
  dispatch via the registry.

**Hard rule, enforced by CI/local hook (`pnpm check:chains`):** files
under `components/`, `hooks/`, `app/` must not contain
`namespace === "eip155" | "solana" | "sui"`. Allowlist + reasons live in
`scripts/check-chain-agnostic.sh`. If you're tempted to branch on
namespace in shared code, add the capability to the adapter instead.

### DApp bridge isolation (memory feedback)

Every dApp-approval surface — sheets, signing flows, anything launched
from a `DappBridge` intent — must render and sign **using
`intent.wallet`** (and `intent.chain` where applicable). Do not read
`activeWallet` / `activeChain` from `useWallet` as a fallback. The
home-screen wallet and the wallet the dApp is talking to can be
different; mixing them is the exact bug class fixed in commit
`4828e91 fix(dapp-bridge): isolate dApp signing from home-screen wallet/chain state`.

Related rule: payment intent reads must use the **paying wallet's JWT**,
not the active wallet's — see `services/paymentIntent/` and
`hooks/usePaymentIntentInvalidator.ts`.

### State management defaults

TanStack Query global defaults:
- `staleTime: 60 * 1000`
- `retry: 1`
- `refetchOnWindowFocus: false`

Shared client state goes through `hooks/useRQGlobalState.ts` (React-Query-backed)
rather than ad-hoc context, so updates fan out through the same cache
the data hooks use.

### Core hooks

- `hooks/useWallet.ts` — multi-wallet + multi-chain wallet state.
  Persistence via `expo-secure-store`; viem clients created on demand.
  `useWallet.helpers.ts` is allowlisted to do per-namespace derivation
  (one mnemonic → one EVM + one Solana + one Sui wallet) — that's the
  one place namespace-awareness is the contract.
- `hooks/queries/` — feature-scoped query hooks (auth, blockchains,
  dapps, products, tokens, transactions).

### AI Agent

`components/home/TakumiAgent/` uses `@ai-sdk/react` `useChat`. Endpoint
is `EXPO_PUBLIC_AI_API_URL`. Tool calls, markdown, conversation history
supported. Agent-side executors live in `services/agent-executors/` and
must go through the wallet-kit registry like any other chain caller.

## Code Style & Conventions

- **Formatter:** Biome — spaces, double quotes (`biome.json`)
- **Lint:** ESLint (`eslint-config-expo`) + Biome rule set (recommended is OFF; explicit rules in `biome.json`)
- **TypeScript:** strict, path alias `@/*` → repo root, `allowImportingTsExtensions: true`
- **Tests excluded** from production tsconfig include

### User-facing errors (memory feedback)

**Hard rule:** end users must never see raw error text. That includes
`err.message`, `String(err)`, `JSON.stringify(err)`, server response
bodies, HTTP status codes/lines, RPC payloads, stack traces, and any
other machine-shaped string — regardless of whether the source is a
remote API or a local API (biometric, contacts, clipboard, OS, etc.).

This is enforced by past incident: the Takumi Agent voice transcription
alert leaked `Transcription failed: 500 {"code":"stt_not_configured","message":"STT_AI_API_KEY is not set on the server."}`
into a user-facing `Alert.alert` because `services/transcribeAudio.ts`
embedded the raw server body in the thrown `Error.message` and the
caller piped `err.message` straight into the dialog.

Apply the pattern uniformly:

- **UI strings are hand-written.** `Alert.alert`, `setError`,
  `setErrorMsg`, `setPaymentError`, on-screen error cards, banners,
  toasts, dApp `RiskBanner` annotation `detail`, biometric error
  labels — all use fixed friendly copy ("We couldn't … Please try
  again.").
- **Raw detail goes to logs only**, guarded by `if (__DEV__) console.warn(...)`
  / `console.error(...)`. Never to production users.
- **Curated server signals are OK**, passthrough is not. Detecting a
  known substring (e.g. `body.message.includes("no pegged currency")`)
  and swapping in *your own* friendly copy is fine; assigning
  `errorMessage = body.message` is not.
- **Don't embed external data in thrown `Error.message`.** API
  wrappers (e.g. `api/endpoints/*.ts`, `services/transcribeAudio.ts`)
  must `throw new Error("<short fixed label>")` and log the raw
  status/body separately — otherwise the message bubbles through
  React Query into UI that renders `error.message`.
- **`services/errors/paymentErrors.ts`** is the shared classifier for
  payment flows: `classifyPaymentError(err)` → `PaymentErrorCode`,
  paired with the `PaymentError` component which gates `devMessage`
  behind `__DEV__`. Reach for it before writing inline branches.

Already-sanitised surfaces to mirror when adding new ones:
`services/transcribeAudio.ts`, `hooks/useVoiceTranscription.ts`,
`hooks/deposit/useDepositState.ts`, `app/pay-merchant/receipt.tsx`,
`app/payment.tsx`, `components/wallet/create/{CreateWalletSheet,ImportSeedPhraseSheet}.tsx`,
`components/dapps-browser/approvals/useBiometricApproval.ts`,
`services/bridge/inspector.ts`, `services/walletKit/solana/SolanaWalletKit.ts`,
`api/endpoints/conversationsApi.ts`.

Internal RPC bridge/injected scripts under `services/chains/*/injectedScript.ts`,
`bundler.ts`, `paymaster.ts` are protocol wiring (EIP-1193) — those
`err.message` fields are part of the contract with the dApp, not user
UI, and are exempt.

## Environment Variables

See `.env.example`. Key ones:
- `EXPO_PUBLIC_API_URL` — backend API
- `EXPO_PUBLIC_AI_API_URL` — AI agent endpoint
- `EXPO_PUBLIC_SECRET_AI_KEY` — AI API key
- Provider IDs for mobile data / pulsa purchase flows

## Git Workflow

- **Branches:** `main` (release), `dev` (integration)
- **Commit format:** `type(scope): description`
  (e.g. `feat(wallet): add multi-sig`, `fix(dapp-bridge): …`)
- **Types:** feat, fix, refactor, chore, docs

## Distribution security (README, TWV-2026-065)

Official binaries ship only via Play Store
(`com.planckify.takumiwallet`) and takumipay.xyz. The signing-cert
SHA-256 shown in the in-app **About** screen comes from
`constants/about.ts` — treat that file as security-reviewed; updates
require security-team sign-off. The "About" runbook context lives in
`docs/distribution-discipline.md`.

## Specs and runbooks

`docs/` carries the long-form specs the code is implementing
(dApp-bridge, multisig, EIP-7702 allowlist, ERC-7562, paymaster, social
recovery, Sui/Solana chain support, UMKM USDC payout, generative UI,
etc.) plus operational runbooks (`docs/runbooks/`, `jwk_rotation_runbook.md`,
`mainnet_migration_runbook.md`, `refund_runbook.md`). When implementing
or changing one of these subsystems, the spec file is the source of truth
for intent — read it before refactoring.

## Frozen prototypes (TWV-2026-021) — read before adding a dependency

`pollyfills.ts` calls `Object.freeze(Object.prototype)`. Any module that
exports a binding named after an `Object.prototype` member (`toString`,
`hasOwnProperty`, `valueOf`, …) compiles to `exports.toString = …`, which
assigns through the frozen prototype:

- **CJS** (sloppy mode) → silently no-ops; the export is just missing.
- **ESM** (Metro adds `"use strict"`) → **throws**, hard crash.

Metro's `inlineRequires` defers the module to its *first use*, so the
crash appears on whatever screen touches it first, arbitrarily far from
boot. This has bitten three times (`bn.js`, `posthog-react-native`, and
`ox`, which shipped a force-close in the dApp approval sheet). Offenders
are pre-loaded in `pollyfills.ts` above the freeze, **by exact file path,
one line per build (`_cjs` and `_esm`) per installed copy** — those
imports look like dead code and are load-bearing.

Two traps that cost four failed fixes: `_cjs`/`_esm` are different Metro
modules (warming one does nothing for the other), and a package can be
installed twice (`node_modules/viem/node_modules/ox`) where a bare
specifier reaches only the hoisted copy.

`pnpm check:protofreeze` fails the build on a new offender, and a
`__DEV__` boot canary prints `pre-load canary: N/N warmed`. **Retest only
after `adb shell am force-stop`** — Fast Refresh does not re-run
`pollyfills.ts`, so a reload silently tests the old code. Full write-up,
including how to name the failing module via Metro's `/symbolicate`:
`docs/prototype-freeze-crash-retrospective.md`.

## Known Technical Debt

From `docs/todolist/technical-deb.md`:
1. `activeChain` chainId fetching is inefficient — should store `chainIdFromDb`
   directly in state instead of re-fetching all blockchains.
