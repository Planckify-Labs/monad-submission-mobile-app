# Task 03 — `injectedScript.ts` — Wallet Standard announce + shim

**Status:** Not taken
**Owner:** Mobile (mobile-app)
**Spec reference:** `solana-adapter-spec.md` §4.2, §4.2a–f, §10.4 inv 13/14/17/18, §10.6.

## Why this matters

This is the single most compliance-sensitive file in the adapter.
Every modern Solana dApp auto-detects wallets via the Wallet Standard
`wallet-standard:register-wallet` / `wallet-standard:app-ready`
handshake. Mis-specifying `publicKey` as base58 (not `Uint8Array(32)`),
or publishing `supportedTransactionVersions` as a getter, or firing
only half the handshake makes TakumiAI **invisible** to Jupiter,
MagicEden, Drift, and every other `@solana/wallet-adapter-wallet-standard`
consumer.

## Scope

- `services/chains/solana/injectedScript.ts` — single IIFE that:
  1. **Idempotent install gate** — `if (window.__takumi_solana_installed) return;`.
  2. **Build `takumiSolanaWallet: Wallet`** per §4.2b:
     - `version: "1.0.0"` literal.
     - `name: "TakumiPay"`.
     - `icon` — embedded SVG data URL ≤ 100 KB, one of
       `svg+xml|webp|png|gif`.
     - `chains` — `IdentifierArray` of all 6 entries (3 short + 3
       genesis-hash).
     - `accounts: []` pre-connect; populated on approve.
     - `features` — full record per §4.2c (standard:connect /
       disconnect / events + solana:signIn / signMessage /
       signTransaction / signAndSendTransaction + takumi:switchCluster
       / watchToken).
  3. **`supportedTransactionVersions`** — literal `["legacy", 0] as const`
     on both `solana:signTransaction` and `solana:signAndSendTransaction`.
     **Not a getter.** (Invariant 14.)
  4. **Stable feature-function identity** — functions defined once per
     install; identity does not change across `onLoadEnd` re-injections.
     (Invariant 18.)
  5. **Handshake — both halves** per §4.2a:
     - Dispatch `wallet-standard:register-wallet` `Event` with
       `event.detail = (api) => api.register(takumiSolanaWallet)`.
     - `addEventListener('wallet-standard:app-ready', ...)` calling
       `e.detail.register(takumiSolanaWallet)`.
  6. **`window.solana` + `window.phantom.solana` shim** per §4.2f:
     - `isPhantom: false`, `isTakumi: true`.
     - `publicKey` duck-type (`toBytes`, `toBase58`, `toString`).
     - `connect`, `disconnect`, `signMessage`, `signTransaction`,
       `signAllTransactions` (→ variadic `solana:signTransaction`),
       `signAndSendTransaction`, `request({method,params})`, `on/off`.
     - `signIn` rejects `4200` — force dApps to the WS path.
     - `window.phantom = { ...existing, solana: shim }` — never clobber.
  7. **Wire-format conversion** — every method translates dApp inputs
     (`Uint8Array` / `PublicKey`-like) into the `bridge_request`
     envelope using base64/base58 strings; translates bridge responses
     back into `Uint8Array` / base58 `PublicKey` duck-type. Solana wire
     types: `publicKey: Uint8Array(32)`, `signature: Uint8Array`,
     `signedTransaction: Uint8Array` (Invariant 13).
  8. **Session nonce stamp** — every outbound `bridge_request` carries
     the TWV-2026-015 nonce (read from the same globals the EVM
     injected script uses).
  9. Script size ≤ 3 KB gzipped.
- `services/chains/solana/SolanaAdapter.ts::getInjectedScript(ctx)` —
  return the IIFE string with ctx.origin / ctx.nonce interpolated.

## Rules (non-negotiable)

- **Both handshake halves or nothing.** Shipping only `register-wallet`
  dispatch leaves a race where the dApp bound its listener first;
  shipping only `app-ready` breaks first-load.
- **`publicKey` is `Uint8Array(32)` on the WebView side, always.**
  Passing base58 there silently breaks `@solana/wallet-adapter-wallet-standard`
  at its shape validator.
- **`supportedTransactionVersions` is a frozen literal.** Never a
  getter. Never `process.env.*`. Jupiter snapshots it once at connect.
- **No direct RPC, ever.** Every method routes through
  `bridge_request`. Zero `fetch()` calls in this file.
- **Re-injection is idempotent.** The install gate must short-circuit;
  every exported function identity stable.
- **`window.solana.signIn` rejects `4200`.** Silent fallback to
  `connect + signMessage` would skip SIWS domain pinning — P0 bug.

## Acceptance

- [ ] Script size ≤ 3 KB gzipped (measure with `gzip -c | wc -c`).
- [ ] `pnpm check:syntax` clean.
- [ ] Manual: load Phantom's `wallet-standard-dapp` demo in the in-app
      browser; "TakumiPay" appears in picker without a manual
      adapter.
- [ ] Manual: `__takumi_solana_installed` short-circuit verified by
      logging inside the IIFE on `onLoadEnd` re-inject (no second
      install).
- [ ] Manual: `wallet.features["solana:signTransaction"].signTransaction`
      reference captured on first connect, still === after SPA route
      change (re-inject).
- [ ] Manual: `window.solana.signIn({domain:"x"})` rejects with 4200.

## Out of scope

- Adapter routing (Task 04).
- `takumi:watchToken` / `takumi:switchCluster` backing logic (Tasks 18, 19).
