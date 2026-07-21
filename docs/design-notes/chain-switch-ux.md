# Chain switch UX — TWV-2026-017

**Owner:** mobile-app · **Spec ref:**
`docs/wallet-security-vulnerabilities-spec.md` TWV-2026-017.

## The rule

Every `wallet_switchEthereumChain` request renders a fresh approval
sheet. Grants for prior chains never short-circuit a fresh prompt —
there is **no** persisted "always approve switches for this origin"
state, anywhere in the codebase.

The signer UI shows the active chain (e.g. *"Signing on: Base"*) in the
header on every signature prompt. The chainId rendered in that header
comes from the registry — `services/chains/evm/signingChainId.ts` — not
from RPC `eth_chainId`. (See TWV-2026-016 / Task 07.)

## Audit (2026-04-16)

`grep -rn "switchChain.*approve\|wallet_switchEthereumChain"` against
`services/permissions/` and `services/bridge/` returned zero hits for
auto-approve / always-approve / cached-decision branches. The single
hit is the EVM adapter's `case "wallet_switchEthereumChain"` arm in
`services/chains/evm/EvmAdapter.ts`, which routes unconditionally to
`needsApproval(makeIntent(...))`.

The permission store
(`services/permissions/store.ts`,
`services/permissionGrantStore.ts`) only persists EIP-2255 grants for
account / chain access on connect; no "always approve switches" flag is
defined or referenced.

## Back-to-back switch + sign

A drainer pattern is `switchEthereumChain → signTypedData_v4` within
the same gesture. The signer sheet's header MUST always render the
chain banner — even when the immediately-prior approval was a switch
to that chain. Implementation lives in the chain-id pin
(`signingChainId.ts`); the sheet reads it on every render, so
the back-to-back case is covered by construction.

## Review gate

Any PR that touches the chain-switch approval flow MUST cite
TWV-2026-017 and re-confirm:

1. The approval is per-call (no caching).
2. The signer sheet header still renders the chain.
3. The chainId source is the registry, not RPC `eth_chainId`.

A `// TWV-2026-017` comment lives in `EvmAdapter.ts` next to the
`wallet_switchEthereumChain` arm — preserve it on refactors.

## API-driven networks: add / switch trust model (2026-07-20)

Networks are sourced from the backend `/blockchains` feed, which is the
sole authority for what a network *is*. dApp-supplied chain params
(`wallet_addEthereumChain` name / rpcUrls / explorer) are untrusted
hints, never authoritative. The RPC a request reads from feeds the
approval sheet's own trust inputs (gas, nonce, balance, pre-sign
simulation — all through the same `publicClient`), so RPC choice is part
of the trusted computing base.

Trust tiers, keyed off the feed (`resolveSupportedChain`), not the dApp:

- **Registered chain (in the feed).** First-class.
  `wallet_addEthereumChain` → no-op `null` (EIP-3085 for an
  already-known chain), never opens a sheet, never persists the dApp's
  RPC. `wallet_switchEthereumChain` → the chain is "known", switches on
  the **project RPC**. This is the fix for the Aave "Add network: RPC
  eth.merkle.io" prompt on mainnet.
- **Unregistered chain (custom).** Second-class and **scoped per-origin**
  (`UserChainStore.origin`): a network added by site A is not offered to
  site B. It is inherently unverified (it lives in `UserChainStore`
  precisely because it is absent from the feed). Add / switch sheets show
  an explicit "custom network, cannot be verified" warning.

EIP-3326 "cancel pending chain-specific confirmations on switch": on a
successful switch the bridge rejects + drops every other pending intent
for the same origin (`DappBridge.pushPostDecisionUpdate`), since they
were framed under the old chain.

## Phase 2 — full per-origin isolation + custom-chain serving (2026-07-20)

A dApp's chain is **fully per-origin** and never touches the home-screen
active chain: dApps have no access to the system chain state.
`changeActiveChain` is no longer called from the bridge at all.

- **Per-origin selection** (`OriginChainStore`, MMKV, keyed by origin
  URL) records which chain each origin is on; **custom chains**
  (`UserChainStore`) also moved to MMKV so reopening a dApp restores its
  network without a fresh `wallet_addEthereumChain`.
- **Resolution** is request-aware: `handleRequest` / `executeApproval`
  stamp `ctx.chainOverride = perOriginConfig(origin)` before dispatch;
  every internal read goes through `resolveConfig(ctx)` which prefers the
  override. `perOriginConfig`: selected custom → dApp RPC; selected
  registered → project RPC (feed); nothing selected → **default chain**
  (Ethereum mainnet from the feed, else first EVM feed row, on project
  RPC — a fresh origin never inherits the home chain).
- **Custom chains are served on the dApp's own RPC**, with the dApp's
  `Origin`/`Referer` forwarded (`buildCustomConfig` → `httpTransport`
  `fetchOptions.headers`) so an Origin-gated RPC proxy accepts the
  wallet's native fetch. Native context is not a browser, so `Origin` /
  `Cookie` are not forbidden headers.
- **Cookie-gated proxies (Option A)** — for RPCs behind the dApp's own
  login session (e.g. `app.idrx.co/api/rpc/bsc`), the dApp's cookies are
  forwarded too. `services/chains/evm/dappCookies.ts` reads the WebView's
  cookie store via `@react-native-cookies/cookies`
  (`CookieManager.get(origin, /*useWebKit*/ true)` — WKHTTPCookieStore on
  iOS / Android WebView store), which unlike `document.cookie` sees
  HttpOnly session cookies. The `Cookie` header is attached in the switch
  probe / add health-check (async read) and the serving path (sync cache,
  warmed by the probe). **STRICTLY same-origin**: cookies are forwarded
  only when the RPC URL's origin equals the dApp origin, never to a
  third-party RPC. Requires the native module in the binary — until the
  EAS rebuild lands, `dappCookies` degrades to no-cookie (nothing
  crashes). NOTE: the WebView currently has `sharedCookiesEnabled={false}`
  / `thirdPartyCookiesEnabled={false}`; if iOS reads come back empty, flip
  `sharedCookiesEnabled` on (WKHTTPCookieStore access is the reason it
  should still work with `useWebKit`, but verify on-device).
- **Reachability gate**: `execSwitchChain` probes a custom chain's RPC
  (`eth_chainId`, with forwarded Origin) before recording the selection;
  unreachable → `4902`, no dangling selection. Registered chains skip the
  probe (project RPC is trusted). The add-time health check is likewise
  Origin-aware.
- **Trust degradation on custom chains — decode stays, enrichment is
  capped.** Clear-signing DECODE (`EvmCalldataDecoderInspector`,
  ERC-8213 digest, AI summary) is RPC-independent and stays fully ON on
  every chain. Only RPC-derived enrichment is affected: the pre-sign
  **simulation still runs on the dApp RPC and is shown**, but every
  signing intent on a custom chain carries a `custom-chain.unverified`
  RiskBanner annotation (`annotateCustomChain`) so the simulation / token
  labels read as "estimated by an unverified network," never a trusted
  green result. Registered chains simulate on the project RPC → trusted.

The dApp-browser RPC isolation seam (a browser-scoped RPC key/quota
distinct from internal features, still on RPC the project trusts) lives
at `browserRpcForRow` in `app/dapps-browser.tsx` — one place to point at
a provisioned endpoint; today it returns the feed `rpcUrl` unchanged.
