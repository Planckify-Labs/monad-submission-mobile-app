# Task 09 — EVM injected script + EIP-6963 announce

**Status:** Not taken
**Owner:** Mobile (mobile-app)
**Spec reference:** `dapp-bridge-spec.md` §2 principle 5 + 6, §3 audit
row "No EIP-6963 announce", §10.2 EIP-6963 row.

## Why this matters

Today `services/ethereumProvider.ts` clobbers `window.ethereum` as the
only provider. Any modern dApp that supports multiple wallets (via
EIP-6963) will pick a competing provider if one is injected later.
Announcing correctly from day one also makes Solana / Sui co-existence
painless when those adapters land.

## Scope

- Create `services/chains/evm/injectedScript.ts` exporting a
  `getInjectedScript(ctx: AdapterContext): string` that returns the
  JS source to inject into the WebView. Move the existing
  `window.ethereum` proxy from `services/ethereumProvider.ts`. Keep
  the dual `postMessage` / `_handleEthereumResponse` paths (§4.4
  matches today's behavior).
- Create `services/chains/evm/eip6963.ts` exporting a
  `buildAnnounceScript({uuid, name, icon, rdns}): string` that emits:
  - On initial inject: a `window.dispatchEvent(new
    CustomEvent("eip6963:announceProvider", {detail: {info, provider}}))`.
  - A listener for `eip6963:requestProvider` that re-announces.
  - Concatenate with the `window.ethereum` proxy for backwards-compat.
- Wire `EvmAdapter.getInjectedScript(ctx)` to return the concatenated
  script. `DappBridge` / the screen concatenates across adapters.
- App-level config for the 6963 `info`:
  - `name: "TakumiPay"`.
  - `rdns: "com.planckify.takumiwallet"` (stable reverse-DNS — the iOS
    bundle ID / Android package / Play Store listing ID).
  - `uuid`: generate once per install, persist in `SecureStore`.
  - `icon`: base64 PNG of the app icon.

## Rules (non-negotiable)

- **Backwards compat.** `window.ethereum` must still be set. EIP-6963
  is additive. Legacy dApps that only read `window.ethereum` keep
  working.
- **UUID is stable per install.** Not per session. Changing it every
  boot breaks dApp pairings / "remember me" flows.
- **`rdns` is reverse-DNS.** Lowercase, no trailing slash. Must match
  across platforms.
- **No inline secrets in the injected script.** No API keys, no
  private data. The script runs in a dApp's JS context.

## Acceptance

- [ ] `services/chains/evm/injectedScript.ts` and `eip6963.ts` exist.
- [ ] `EvmAdapter.getInjectedScript` returns the concatenated source.
- [ ] Manual QA: open a dApp that uses EIP-6963 (e.g. the Rainbow
      test page) and confirm "TakumiPay" appears in its wallet
      picker.
- [ ] Manual QA: open a legacy dApp that reads `window.ethereum`
      directly; it still detects us.
- [ ] UUID persists across app relaunches.
- [ ] `pnpm check:syntax` passes.

## Out of scope

- Injection for non-EVM chains (Phase 3).
- WalletConnect pairing (Phase 8 open question).
