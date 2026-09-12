# Deep-link wallet interactions — engineering spec

**Status:** IMPLEMENTED 2026-09-11/12 (Phases 0, 1, 2, 2b, 3 landed in one
series; Phase 2b's One-Click Auth is live, its Link Mode half stays behind
`FEATURE_WALLETCONNECT_LINK_MODE = false` until the universal link is
registered in the WalletConnect Dashboard; Phase 3b is **built on a
vendored walletlib fork + patched RN bridge + wallet-hosted script**,
opt-in via `MWA_ORIGIN_ATTESTATION`, see §18). Protocol + platform claims
source-verified, §17. **Not device-verified**: the Task 00 gates in §13.3
(warm `+native-intent`, App/Universal Link verification state, protofreeze
canary on device, MWA `getCallingPackage()` under the generated activity,
second React root on bridgeless) still need a preview build; `pnpm
check:protofreeze` is green and the canary list covers the four new
offenders. Implementation notes: §18.
**Author:** Claude (every protocol statement below was fetched directly
from the owning repository or vendor doc during this session — MWA
`spec/spec.md`, Solana Pay `spec/SPEC.md`, SEP-0007, ERC-681/831,
WalletConnect docs + AppKit source, Phantom docs, Mysten `payment-kit`
source, Expo/Android/Apple docs — not recalled from training data. Each
section that makes a protocol claim links its source.)
**Date:** 2026-09-11
**Tracking:** TWV-2026-024 (deep-link hijacking), TWV-2026-030 (WC session
storage), TWV-2026-054 (push-channel deeplinks), TWV-2026-035 (signing mode)
**Companion specs:**
- `docs/dapp-bridge-spec.md` — the two-port approval spine
  (`ChainAdapter` + `ApprovalHost`) every transport in this spec docks
  into **unchanged**. Its §8 "WalletConnect v2 as a second transport" open
  question is resolved here (§7).
- `docs/solana-adapter-spec.md` §"Future work" — explicitly deferred MWA,
  WalletConnect `solana:*`, and Solana Pay URI handling to "a dedicated
  transport-integration spec". This is that spec.
- `docs/wallet-security-vulnerabilities-spec.md` — TWV-2026-024/030/054/035
  are the threat entries this spec closes.
- `docs/umkm-usdc-payout-spec.md` §4.3/§4.5 — the `PaymentIntent` detector
  registry that Class-A payment URIs (§6) extend rather than replace.
- `docs/stellar-dapp-bridge-spec.md`, `docs/sui-dapp-bridge-spec.md` — the
  per-chain adapters whose `handleRequest` surface the session transports
  (§7, §8) call.

---

## 0. Goal & non-goals

### Goal

Make TakumiPay a first-class **deep-link wallet** on Android and iOS for
every chain family it supports today (`eip155`, `solana`, `sui`,
`stellar`) and for any family added later, without a single
`namespace === "…"` branch in shared code:

1. **Any external surface can hand the wallet a request by URL** — a QR
   code, an NFC tag, a link in a browser, a native dApp, a push (read-only
   only), another wallet's "open with" — and the wallet responds with the
   same approval sheets, inspectors, event bus, and telemetry that the
   in-app dApp browser already uses.
2. **Each chain's ecosystem standard is honored as written**, because
   dApps and merchants on each chain emit links in *their* format and will
   not adapt to ours: ERC-681 / ERC-831 and WalletConnect on EVM; Solana
   Pay and Mobile Wallet Adapter (MWA) on Solana; the Mysten Payment Kit
   `sui:pay` URI on Sui; SEP-0007 on Stellar; WalletConnect v2 sessions
   across all four.
3. **Production-grade security**: verified HTTPS entry (Universal / App
   Links) for every sensitive action, mandatory preview, provenance shown
   on every sheet, per-protocol signature verification where the standard
   defines one (SEP-0007 `origin_domain`, MWA Digital Asset Links,
   WalletConnect Verify), replay and lock-screen isolation, no
   auto-execution ever, no raw error text to users.
4. **Adding a chain family = adding one file**
   (`services/chains/<ns>/deeplinks.ts`) that registers its scheme
   handlers; the kernel, interstitial, approval host, WalletConnect
   namespace builder, and analytics never change.

### Non-goals (this spec)

- **Being the initiator.** This spec covers TakumiPay as the *wallet*
  endpoint (receiving requests). Emitting deep links to *other* wallets
  (e.g. paying from TakumiPay into Slush) is out of scope.
- **Push-delivered signing requests** (WalletConnect Notify / Echo). Every
  request still requires the app to be foregrounded by the user; pushes
  may only open read-only screens (TWV-2026-054). Tracked as future work
  (§16).
- **WalletConnect Link Mode.** It is EVM-only by the vendor's own
  statement (§2.5) and requires One-Click Auth; deferred to Phase 2b.
- **iOS MWA.** The MWA 2.0 spec states twice that "iOS support is planned
  for a future version of this specification" (§2.2.2); there is nothing
  to implement.
- **TakumiPay's own web build.** Expo Router can also emit a
  `react-native-web` bundle (the `web:` block in `app.config.ts`); we do
  not ship a browser/desktop wallet, and Expo's `+native-intent` hook
  does not exist on that target, so this spec covers Android and iOS
  only. This is **not** a gap in dApp coverage: desktop and web dApps
  reach the phone wallet through WalletConnect (QR or deep link, §7),
  which is how every mobile wallet handles that case.
- **Hardware-wallet signing** over any of these transports.
- **Custom chains added by dApps** (`wallet_addEthereumChain`) as
  deep-link targets. A payment URI whose `@chainId` is not a backend
  chain row is rejected with friendly copy.

---

## 1. Current state — verified in-repo, not assumed

### 1.1 What exists

| Surface | State | Notes |
|---|---|---|
| `app.config.ts` `scheme` | `takumiwallet` / `-dev` / `-preview` | Only our own scheme is registered. No `ethereum:`, `solana:`, `web+stellar:`, `sui:`, `wc:`, `solana-wallet:`. |
| iOS `associatedDomains` | `applinks:takumipay.xyz` | Verified Universal Link host exists (TWV-2026-024). |
| Android `intentFilters` | (a) `https://takumipay.xyz/*` `autoVerify` (b) generic `http(s)` no host, not verified | (b) is **dead on Android 12+** — see F1. |
| `hooks/useExternalDappLinking.ts` | Wired in `app/_layout.tsx` | The *only* live `Linking` listener. Acts on `classifyURI(...).type === "dapp"` and opens the sandboxed browser. Nothing else. |
| `services/deeplinks/router.ts` | `classifyURI` + `handleDeepLink` | `handleDeepLink` is **unwired**. `parseCustomScheme` uses `new URL(uri).hostname` (see F5). `wc` branch is a comment. |
| `services/deeplinks/eip681.ts` | `parseEIP681` | Duplicate of the richer parser in `services/paymentIntent/detectors/walletUri.ts`. |
| `services/security/deeplinkGate.ts` | `inspectDeeplink` | **Unwired** (only its test references it). `SENSITIVE_PATHS` = `/send /sign /wc /add-chain`. `FRAGMENT_DENY` = `/(seed|mnemonic|privatekey|pk|signature)/i` applied to **query and fragment** (see F4). |
| `services/paymentIntent/detectors/walletUri.ts` | `ethereum:` + `solana:` transfer parsing | Priority 40 detector. Produces `PayChannel{kind:"wallet"}` with `target` hint. Only reached from the QR scanner (`app/scan-to-pay.tsx`) and gallery pick; `PaymentIntent.source` already admits `"deeplink"`. |
| `services/walletconnect/{caipMapping,sessionStore}.ts`, `components/walletconnect/SessionList.tsx` | Scaffold | `caipMapping` is used by the bridge/agent for CAIP-2 translation and is correct for all four namespaces. `sessionStore` (expo-sqlite) and `SessionList` are orphaned — **no `@walletconnect/*` or `@reown/*` package is installed**. |
| `services/bridge/*` | Live | `DappBridge`, `ApprovalHost`, `InspectorRegistry`, `pendingIntentsStore`, `PermissionStore`. `submitAgentIntent` already proves a non-WebView caller can drive the spine (`app/approvals.tsx` uses it). |
| `services/bridge/boot.ts` `bootBridge` + `<ApprovalHost/>` | Mounted **only inside `app/dapps-browser.tsx`** | See F3. |
| `Origin.via` | `"webview" \| "agent"` | Consumed by `services/chains/*/agentContext.ts` and the event bus. |
| `services/security/signingMode.ts` | Live | "no deeplinks routed to action screens" is its stated contract; nothing enforces it for deep links today because nothing routes them. |
| `app/_layout.tsx` `AppLockedContext` | Live | LockScreen is a plain `View` overlay; approval sheets are RN `Modal`s (`SheetModal.tsx`) which render **above** it. See F6. |
| `app/send.tsx` | Reads `recipientAddress`, `namespace`, `amount`, `token`, `chainId`, `cluster`, `network` from `useLocalSearchParams` | Reachable by URL. See F2. |
| `ios/`, `android/` | Untracked prebuild output, stale (`5.1.1`, host `takumi.wallet`) | Ignore; `app.config.ts` is the source of truth. |

### 1.2 Findings this spec must fix (F1–F8)

- **F1 — The generic `http(s)` intent filter does not do what its comment
  says on Android 12+.** Android 12 (API 31) changed web-intent
  resolution: *"a generic web intent resolves to an activity in your app
  only if your app is approved for the specific domain contained in that
  web intent. If your app isn't approved for the domain, the web intent
  resolves to the user's default browser app instead."* (Android 12
  behavior changes, §17). The chooser the comment describes only appears
  on Android ≤ 11 or when the user manually adds a domain under "Open
  supported links". Consequence: **an unverified `https` link is not a
  transport.** Every https deep link into the wallet must be on our
  verified host. The filter can stay (harmless, helps Android ≤ 11) but
  the comment is corrected and nothing may depend on it.
- **F2 — Expo Router auto-routes every file route from any URL on the
  scheme or verified host.** `https://takumipay.xyz/send?recipientAddress=0x…&namespace=eip155`
  and `takumiwallet://send?…` land on `app/send.tsx` with the recipient
  prefilled, bypassing `inspectDeeplink` entirely. This is exactly the
  residual `production-readiness-2026-07-19.md` flagged ("if anyone later
  wires `handleDeepLink`…") except it is live *today* through the router,
  not through `handleDeepLink`. The user still has to confirm and pass
  biometrics, so it is a prefill-phishing vector, not an auto-execute
  one — but TWV-2026-024 requires a preview with provenance, and
  `send.tsx` shows none. Fix: `app/+native-intent.tsx` (§4.2) rewrites
  every incoming URL before the router sees it; sensitive routes are
  never reachable by URL.
- **F3 — The approval spine only exists while the dApp browser screen is
  mounted.** `bootBridge()` and `<ApprovalHost/>` live in
  `app/dapps-browser.tsx`. A WalletConnect request, SEP-0007 `tx`, or MWA
  association arriving on the home screen has nowhere to render. Fix:
  boot the bridge at app boot and mount `ApprovalHost` in the root layout;
  the browser screen keeps rebinding `getWebView`/`getContext` via
  `updateOpts` (already supported by the singleton).
- **F4 — `FRAGMENT_DENY` would block a *valid* SEP-0007 request.**
  SEP-0007 carries `&signature=…` as a required query parameter for signed
  requests, and its `replace` values routinely contain the word "account".
  The regex `(seed|mnemonic|privatekey|pk|signature)` applied to the query
  string rejects the *most* secure Stellar link shape. Fix: apply the
  denylist to the **fragment** unconditionally, and to query **keys**
  only for our own `takumiwallet://` / `https://takumipay.xyz` routes;
  protocol schemes own their own parameter validation (§6).
- **F5 — `new URL()` in RN is a regex shim** (memory
  `feedback_rn_url_is_regex_shim`; `walletUri.ts` already documents that
  Hermes treats `ethereum:`/`solana:` as opaque). `parseCustomScheme` and
  `inspectDeeplink` both rely on `URL.hostname`/`pathname`/`protocol` for
  non-http schemes. Fix: one strict, dependency-free URI splitter
  (`services/deeplinks/uri.ts`, §4.3) shared by every handler; `URL` is
  used only for `https:` URLs and only for `hostname`.
- **F6 — An approval `Modal` can render above the lock screen.** Nothing
  gates `ApprovalHost` on `AppLockedContext`. Once the spine is
  root-mounted (F3), a cold-start deep link would present a signing sheet
  on top of the PIN screen. Fix: `ApprovalHost` renders nothing while
  locked and the pending queue is frozen (§4.8, invariant S-9).
- **F7 — Android "recents" replay.** `Linking.getInitialURL()` returns the
  launch intent's data every time the task is resumed from recents until a
  new intent replaces it. A payment link opened once can re-present after
  the user backs out and re-enters from recents. Fix: consumed-link ledger
  (§4.8, invariant S-10).
- **F8 — Two parsers for ERC-681.** `services/deeplinks/eip681.ts` and
  `walletUri.ts` disagree (the former lacks `@chainId` hex tolerance and
  `/transfer`). Fix: delete `eip681.ts`; the detector is the single parser
  and the EVM deep-link handler delegates to it.

---

## 2. Protocol reference — what each ecosystem actually standardizes

Every claim in this section is quoted from the source linked in §17.
Where a vendor says "planned", "alpha", or "under review", it is repeated
here verbatim so that scheduling decisions in §15 rest on the vendor's
words, not ours.

### 2.0 The four interaction classes

Chains differ in *what* their standard link can ask a wallet to do. Four
classes cover everything found across the four families:

| Class | Shape | Wallet action | Return channel | Examples |
|---|---|---|---|---|
| **A — Payment request** | Non-interactive URI; all parameters in the link | Wallet *composes* a transfer, user confirms, wallet broadcasts | None (payee watches chain / `reference` / `nonce`) | ERC-681 `ethereum:`, Solana Pay transfer `solana:<pubkey>`, SEP-0007 `web+stellar:pay`, Mysten `sui:pay` |
| **B — Signing request** | Interactive URI; payload in the link or fetched from an HTTPS endpoint | Wallet decodes, shows, user signs | Broadcast, HTTPS callback, or OS redirect | SEP-0007 `web+stellar:tx`, Solana Pay transaction request `solana:https://…`, Phantom-style `…/ul/v1/signTransaction` |
| **C — Session transport** | Link bootstraps an encrypted bidirectional channel | Wallet answers a JSON-RPC-ish method stream (connect, sign, …) | The channel itself | WalletConnect v2 `wc:`, MWA `solana-wallet:` (local WebSocket), Phantom-style encrypted deep-link sessions |
| **D — Navigation** | Link opens a screen | None | None | `…/dapp/<url>` (open in in-app browser), `…/wallet`, push taps |

Only Class A and D exist in the codebase today (A via the QR scanner, D
via `useExternalDappLinking`). Class B and C are new.

### 2.1 EVM (`eip155`)

**ERC-681 — "URL Format for Transaction Requests" (Final).** Syntax
(quoted):

```
request        = schema_prefix target_address [ "@" chain_id ] [ "/" function_name ] [ "?" parameters ]
schema_prefix  = "ethereum" ":" [ "pay-" ]
target_address = ( "0x" 40*HEXDIG ) / ENS_NAME
chain_id       = 1*DIGIT
key            = "value" / "gas" / "gasLimit" / "gasPrice" / TYPE
number         = [ "-" / "+" ] *DIGIT [ "." 1*DIGIT ] [ ( "e" / "E" ) [ 1*DIGIT ] ]
```

Semantics that bind the wallet: `chain_id` is **decimal**; if absent
"the client's current network setting remains effective"; native amount
is `value` in **wei**, scientific notation "strongly encouraged"
(`?value=2.014e18`); ERC-20 is `<token>/transfer?address=<to>&uint256=<atomic>`;
hex addresses always take precedence over ENS; **"the indicated amount is
only a suggestion … the user is free to change"**; `gas`/`gasLimit`/`gasPrice`
are suggestions. Our `walletUri.ts` already implements the hex-address
subset; §6.1 lists the deltas (`pay-` prefix, scientific notation, ENS
refusal, unknown function refusal).

**ERC-831 — "URI Format for Ethereum" (Stagnant).** Defines the outer
grammar `"eth"["ereum"] ":" [prefix "-"] payload`; when no prefix, `pay-`
is assumed and payload must start with `0x`. We accept `ethereum:` and
`ethereum:pay-`; we do **not** accept the bare `eth:` alias (Stagnant
ERC, no wallet in the field emits it).

**WalletConnect pairing URI (EIP-1328 schema, WC spec).** Quoted:
`uri = "wc" ":" topic [ "@" version ][ "?" parameters ]`; required params
`symKey`, `methods`, `relay-protocol`; optional `relay-data`,
`expiryTimestamp` ("should be generated 5 minutes in the future").
**How a dApp opens a wallet with it** (AppKit source,
`CoreHelperUtil.formatUniversalUrl`/`formatNativeUrl`): the wallet's
registered link plus `wc?uri=<encodeURIComponent(wcUri)>`, i.e.
`takumiwallet://wc?uri=…` or `https://takumipay.xyz/wc?uri=…`. Bare
`wc:` URIs are also delivered when the wallet registers the `wc` scheme
(MetaMask, Trust do).

**There is no ratified EVM "sign this payload" URI.** Signing on mobile
EVM goes through WalletConnect (Class C). MetaMask SDK's
`metamask://connect?channelId=…` is proprietary transport, not a
standard; not implemented.

### 2.2 Solana

#### 2.2.1 Solana Pay (Class A + B) — `anza-xyz/solana-pay`, `spec/SPEC.md`

*"This spec is currently alpha and subject to change."* and *"Mobile
wallets should register to handle the URL scheme to provide a seamless
yet secure experience when Solana Pay URLs are encountered in the
environment."*

**Transfer request** (`solana:<recipient>?amount&spl-token&reference&label&message&memo`).
Binding rules, quoted:
- `recipient` "must be the base58-encoded public key of a native SOL
  account. Associated token accounts must not be used."
- `amount` is in **user units** ("For SOL, that's SOL and not lamports");
  "`0` is a valid value"; decimals < 1 need a leading `0`; "Scientific
  notation is prohibited"; missing amount → "the wallet must prompt the
  user"; too many decimals → "the wallet must reject the URL as
  **malformed**."
- `spl-token` → "the Associated Token Account convention must be used, and
  the wallet must include a `TokenProgram.Transfer` or
  `TokenProgram.TransferChecked` instruction as the last instruction";
  else `SystemProgram.Transfer` last. "Transfers to auxiliary token
  accounts are not supported."
- `reference` (repeatable) "must be base58-encoded 32 byte arrays … the
  wallet must include them in the order provided as read-only, non-signer
  keys" on the transfer instruction.
- `label`, `message` are URL-encoded UTF-8 the wallet "should display";
  `memo` "must be included in an SPL Memo instruction … as the second to
  last instruction".

**Transaction request** (`solana:<link>`, link is a conditionally
URL-encoded **absolute HTTPS URL**; otherwise "reject it as
**malformed**"). Flow, quoted:
- `GET` (should) → `{"label","icon"}`; "The request should not identify
  the wallet or the user"; icon "must be an SVG, PNG, or WebP image, or the
  wallet must reject it as **malformed**"; "The wallet should display the
  domain of the URL as the request is being made."
- `POST {"account":"<base58 pubkey>"}` → `{"transaction":"<base64>","message"?}`.
  "The wallet must validate the transaction as **untrusted**."
- If `signatures` empty: wallet "must ignore the `feePayer` … and set the
  `feePayer` to the `account`", same for `recentBlockhash`. If non-empty:
  "the wallet must verify the signatures, and if any are invalid, the
  wallet must reject the transaction as **malformed**"; wallet "must not
  set" feePayer/blockhash.
- "The wallet must only sign the transaction with the `account` in the
  request … If any signature except a signature for the `account` in the
  request is expected, the wallet must reject the transaction as
  **malicious**."

#### 2.2.2 Mobile Wallet Adapter 2.0 (Class C) — `solana-mobile/mobile-wallet-adapter`, `spec/spec.md` v2.0.0

- Local association URI: `solana-wallet:/v1/associate/local?association=<token>&port=<49152–65535>&v=<major>`;
  wallet "should start a WebSocket server on port `port_number` and begin
  listening for connections to `/solana-wallet` for no less than 10
  seconds. This websocket server should only accept connections from the
  localhost."
- Android intent: action `VIEW`, category `BROWSABLE`, scheme
  `solana-wallet`. Native dApps must start it with
  `startActivityForResult` so the wallet can call `getCallingPackage()`;
  web dApps launch via `startActivity` with no caller identity.
- **iOS:** *"iOS support is planned for a future version of this
  specification"* (stated under Local URI and again under Identity
  verification).
- Session crypto: P-256 ECDH + HKDF, `AES-128-GCM`, `HELLO_REQ`/`HELLO_RSP`.
- Endpoint-specific URI: the wallet may return `wallet_uri_base` (must be
  `https:`; "A dapp should reject URI prefixes with schemes other than
  `https:`"), e.g. `https://solanaexamplewallet.io/mobilewalletadapter`,
  so a dApp can target *this* wallet through an App Link instead of the
  contended `solana-wallet:` scheme.
- Methods: mandatory `authorize`, `deauthorize`, `get_capabilities`,
  `sign_messages`, `sign_and_send_transactions`; optional
  `sign_transactions` (deprecated), `clone_authorization`; `reauthorize`;
  chain ids `solana:mainnet|testnet|devnet` (legacy `mainnet-beta`… still
  accepted).
- Identity verification: "the wallet endpoint should check the Digital
  Asset Link for the `identity` element URI and ensure that the calling
  package is signed with a certificate listed in an `android_app`
  statement"; if not verifiable "it is recommended that wallet endpoints
  decline to issue an authorization token … and return
  `ERROR_AUTHORIZATION_FAILED`." Web dApps use a wallet-hosted attestation
  script over Trusted Web Activity (`ERROR_ATTEST_ORIGIN_ANDROID`
  challenge).
- Wallet-side RN library: `@solana-mobile/mobile-wallet-adapter-walletlib`
  **1.4.5**, README: *"This package is still in alpha and is not
  production ready. However, the API is stable and will not change
  drastically"*; `peerDependencies: react-native >0.74`; **Android
  sources only** (no `ios/` directory in the package). The reference RN
  wallet hosts MWA in a **separate `ReactActivity`**
  (`MobileWalletAdapterBottomSheetActivity`, `launchMode="singleTask"`)
  that renders a **second registered root component**
  (`AppRegistry.registerComponent('MobileWalletAdapterEntrypoint', …)`).
  The walletlib reads the association URI from
  `reactContext.getCurrentActivity()?.intent`.

#### 2.2.3 Phantom-compatible encrypted deep links (Class C, de facto) — `docs.phantom.com`

Not a Solana Foundation standard, but the only wallet-agnostic *shape* a
native iOS Solana dApp can use today besides WalletConnect, and copied by
other wallets. Quoted essentials:
- Base `https://phantom.app/ul/<version>/<method>`; custom scheme
  `phantom://…` "not recommended". "Currently only Solana is supported for
  deeplinks."
- `connect` params: `app_url` (stored in session for blocklist
  validation), `dapp_encryption_public_key` (x25519), `redirect_link`
  (URL-encoded; **used to fetch app metadata and for trusted-app
  management**), `cluster`. Response: `phantom_encryption_public_key`,
  `nonce`, `data` (nacl box, base58) → `{public_key, session}`.
- Redirect types: HTTPS `redirect_link` shows metadata but "opens in the
  mobile browser instead of redirecting back to your app"; custom-scheme
  redirects return to the app but show no metadata.
- Session token: base58 of `nacl.sign(JSON, walletKeypair)`; "Sessions do
  not expire"; validated on every request (signature + chain/cluster
  match; blocklist on `app_url`).
- Subsequent methods carry `dapp_encryption_public_key`, `nonce`,
  `redirect_link`, `payload` (nacl box of JSON with `session` and method
  args). Errors are returned as `errorCode`/`errorMessage` query params.
- Limits: Android "500kb transaction limit … `TransactionTooLarge`";
  iOS ~1 MB.

### 2.3 Sui

- **Mysten Payment Kit URI (Class A)** — `MystenLabs/ts-sdks`
  `packages/payment-kit/src/uri.ts`: protocol constant
  `SUI_PAYMENT_KIT_PROTOCOL = 'sui:pay'`; `parsePaymentTransactionUri`
  requires `uri.startsWith('sui:pay?')` and the params `receiver`
  (`isValidSuiAddress`), `amount` (**smallest unit**, `BigInt`, `> 0`),
  `coinType` (`isValidNamedType`), `nonce` (`length <= 36`); optional
  `registry` (object id → `registryId`, else `registryName`), `label`,
  `message`, `iconUrl`. A `sui:pay` payment is **not a plain transfer**:
  the payee looks it up with `getPaymentRecord({registry, nonce, amount,
  receiver, coinType})`, so the wallet must call the Payment Kit Move
  package (`processEphemeralPayment` / `processRegistryPayment`; mainnet
  package `0xbc126f…69bc6`, testnet `0x7e069a…71497`, from
  `constants.ts`). Slush also accepts `https://my.slush.app/pay?…` and a
  Slush-only `slush:pay` alias.
- **No Sui signing/session URI standard exists.** The Slush deep-link
  route reference (`packages/docs/content/slush-wallet/deep-linking.mdx`)
  lists `browse`, `swap`, `claim`, `tokens`, `suime`, `strategies`,
  `staking`, `send-coins`, `pay` — all navigation or payment; none lets a
  third party request a signature. Sui's Wallet Standard is an in-page
  (`window`) protocol, which our WebView bridge already implements.
- **WalletConnect `sui` namespace** (Class C) exists with `sui_getAccounts`,
  `sui_signTransaction` → `{signature, transactionBytes}`,
  `sui_signAndExecuteTransaction` → `{digest}`, `sui_signPersonalMessage`
  → `{signature}`; the page carries the warning *"The SUI RPC standard is
  still under review and specifications may change."*

### 2.4 Stellar — SEP-0007 "URI Scheme to facilitate delegated signing" (Status: Active, v2.1.0)

Quoted essentials:
- Scheme `web+stellar:` ("no forward-slashes"), operations `tx` and
  `pay`: `web+stellar:<operation>?<params>`.
- `tx`: `xdr` (required, base64 `TransactionEnvelope`, URL-encoded);
  `replace` (Txrep field replacement `field:ref,…;ref:hint,…`, "considered
  invalid unless the `reference_identifier`s are balanced"); `callback`
  ("If this value is omitted then the URI handler should sign the given
  XDR and submit it to the network"; `url:` prefix → POST
  `application/x-www-form-urlencoded` with `xdr=<signed>`); `pubkey`;
  `chain` ("no more than 7 nested levels"); `msg` ("should not be longer
  than 300 characters"); `network_passphrase`; `origin_domain`;
  `signature`.
- `pay`: `destination` (required), `amount`, `asset_code`,
  `asset_issuer`, `memo`, `memo_type` (`MEMO_TEXT|MEMO_ID|MEMO_HASH|MEMO_RETURN`),
  `callback`, `msg`, `network_passphrase`, `origin_domain`, `signature`.
  Missing amount → "the wallet should ask the user to enter the amount".
- **Request signing:** payload = 35 zero bytes, then byte `4`, then
  UTF-8 of `"stellar.sep.7 - URI Scheme"` + the URI with the trailing
  `&signature=…` removed; verify with `URI_REQUEST_SIGNING_KEY` from
  `https://<origin_domain>/.well-known/stellar.toml`. Wallet rules:
  missing `signature` when `origin_domain` present → "**do not** allow the
  user to sign"; `origin_domain` not an FQDN → do not sign; toml missing
  or key missing → do not sign; "wallets **do not** cache `stellar.toml`
  files" but "should cache the last used `URI_REQUEST_SIGNING_KEY` for a
  given domain" and "**must** alert the user" on change; verification
  failure → do not sign; success → display `origin_domain` "in a prominent
  position on the same page/view where the user is signing".
- Security best practices (numbered threats 1–7): unsigned request = "a
  **red flag** … equivalent to using `http`" → extra confirmation step;
  hijacking → show `origin_domain`, "alert the user if they are
  transacting with an `origin_domain` for the first time"; tampered `msg`
  → display tx details; compromised toml → pin key per domain; new
  destination → "alert the user if they are trying to pay to an address
  that they have not seen before"; default-handler theft → if the wallet
  was default last time and no longer is, alert once; homograph → distinct
  font.
- WalletConnect `stellar` namespace: CAIP-2 `stellar:pubnet|testnet`,
  CAIP-10 `stellar:pubnet:G…` (G-StrKey only, never `M…`/`T…`/`X…`);
  methods `stellar_signXDR{xdr,chain,account}` → `{signedXDR,signerAddress}`,
  `stellar_signAndSubmitXDR` → `{tx_hash,signedXDR,successful?}`,
  `stellar_signMessage`, `stellar_signAuthEntry`; "Wallet MUST reject
  signing if the encoded `network_id` inside the tx does not match this
  chain."

### 2.5 WalletConnect v2 (Class C, all four namespaces) — `docs.walletconnect.com`

- Wallet SDK: `@reown/walletkit` (1.5.6 at time of writing) +
  `@walletconnect/react-native-compat` (2.24.0), plus
  `@react-native-async-storage/async-storage`,
  `@react-native-community/netinfo`, `react-native-get-random-values`,
  `fast-text-encoding`; Expo adds `expo-application`.
  `import "@walletconnect/react-native-compat"` must precede any `@reown/*`
  import.
- `Core({ projectId, storage?, keychain?, customStoragePrefix? })` —
  `CoreTypes.Options` accepts `storage?: IKeyValueStorage` and
  `keychain?: IKeyChain` (verified in `walletconnect-monorepo`
  `packages/types/src/core/core.ts`). `WalletKit.init({ core, metadata:
  { name, description, url, icons, redirect: { native, universal,
  linkMode } } })`.
- Events: `session_proposal` (+ `buildApprovedNamespaces({ proposal,
  supportedNamespaces })` → `approveSession({ id, namespaces })` /
  `rejectSession({ id, reason: getSdkError("USER_REJECTED") })`),
  `session_request` (`{ topic, params: { request, chainId }, id,
  verifyContext }` → `respondSessionRequest({ topic, response })`),
  `session_delete`, `session_update`. `pair({ uri })`.
- Verify API: `verifyContext.verified.validation ∈ VALID|INVALID|UNKNOWN`,
  `verified.origin`, `verified.isScam`. "Verify API is not designed to be
  bulletproof."
- Mobile Linking: redirect back with `Linking.openURL(session.peer.metadata.redirect?.native)`;
  vendor guidance: **"Redirect metadata should only be used when the
  session proposal is initiated through a deep link. QR code scans should
  not trigger app redirects."** and "Developers should prefer Deep Linking
  over Universal Linking" for the redirect.
- Best practice: "make sure that WalletKit is initialized immediately
  after your app launch, especially if launched via a WalletConnect Deep
  Link."
- **Link Mode:** "This feature is compatible only with EVM blockchains, so
  if you decide to include non-EVM blockchains Link Mode mechanism is
  going to be disabled internally." Requires One-Click Auth and a
  universal link registered in the WalletConnect Dashboard.
- Chain pages exist for `eip155`, `solana` (§2.2, method shapes in §7.4),
  `sui` (§2.3), `stellar` (§2.4).

### 2.6 Summary matrix

| Family | Class A (pay URI) | Class B (sign URI) | Class C (session) | Android | iOS |
|---|---|---|---|---|---|
| `eip155` | ERC-681/831 `ethereum:` | — (none ratified) | WalletConnect v2 (`wc:`, `wc?uri=`) | scheme contended (MetaMask/Trust) → chooser | scheme winner undefined → use Universal Link |
| `solana` | Solana Pay transfer `solana:<pubkey>` | Solana Pay tx request `solana:https://…` | WalletConnect `solana`; **MWA** (`solana-wallet:`); Phantom-compatible `…/ul/v1/*` | all three | WC + Phantom-compatible only (MWA: "planned") |
| `sui` | Mysten `sui:pay?…` | — (none) | WalletConnect `sui` ("under review") | scheme contended (Slush) | Universal Link |
| `stellar` | SEP-0007 `web+stellar:pay` | SEP-0007 `web+stellar:tx` | WalletConnect `stellar` | scheme contended (Lobstr etc.) | Universal Link |
| future | one `deeplinks.ts` file per family (§4.4) | same | WalletConnect namespace entry via `WalletKitAdapter` (§7.3) | — | — |

---

## 3. Platform reference — what is exclusive, what is contended, what is dead

| Mechanism | Android | iOS | Exclusive to us? | Verdict for sensitive actions |
|---|---|---|---|---|
| Custom scheme (`takumiwallet:`, `ethereum:`, `solana:`, `web+stellar:`, `sui:`, `wc:`) | Any app can claim; chooser if several | Any app can claim; Apple: "there is currently no process for determining which app will be given that scheme" | **No** | Accept as *input* only through the mandatory preview; never trust the scheme as provenance. |
| Verified App Link / Universal Link (`https://takumipay.xyz/*`) | `autoVerify` + `assetlinks.json` (`package_name` + `sha256_cert_fingerprints`) | `applinks:` entitlement + AASA | **Yes** | The only entry allowed to carry sensitive intent *without* the "unverified scheme" warning. |
| Unverified `https` intent filter (no host) | Android ≤ 11: chooser; **Android 12+: browser** (§1.2 F1) | n/a | No | Dead as a transport. |
| Universal Link opened from *our own* app | n/a | Opens Safari, not us (same-app universal links are not routed back) | — | Never rely on it for internal navigation. |
| Intent extra size | ~500 KB (`TransactionTooLarge`, per Phantom docs) | ~1 MB | — | Cap accepted URL length at 256 KB; reject larger with copy. |
| `Linking.canOpenURL` | API 30+: needs `<queries>` for the scheme | needs `LSApplicationQueriesSchemes` (max 50) | — | Do not use `canOpenURL` for dApp return links (schemes are unbounded); call `openURL` inside try/catch. |
| Cold vs warm start | `getInitialURL` replays from recents (F7) | `getInitialURL` + `url` event | — | Consumed-link ledger (S-10). |
| Caller identity | `getCallingPackage()` only for `startActivityForResult` into a **`singleTask` activity that is not the launcher** (MWA pattern); browser launches carry none | None (no caller identity API) | — | Only MWA (Android, native dApps) gets OS-attested identity; everything else is protocol-level (SEP-0007 signature, WC Verify) or unverified. |

Expo config facts used in §12 (verified in `@expo/config-plugins`):
`scheme` accepts `string | string[]` at top level and under `ios`/`android`;
Android `intentFilters[].data[]` entries serialize any key as `android:<key>`
(so `pathPrefix`/`pathPattern`/`host` work); iOS adds the bundle
identifier as an extra scheme automatically; `ios.infoPlist` carries
`LSApplicationQueriesSchemes`. `app/+native-intent.tsx`'s
`redirectSystemPath({ path, initial })` receives **every** native URL
("All URLs provided to your App will be evaluated"), may be async, is
"processed outside the context of your app" (no auth/lock state), and
must never throw (return a fallback route instead).

---

## 4. Architecture

### 4.1 Principles

1. **One spine.** Every Class B/C request becomes an `ApprovalIntent` and
   goes through `InspectorRegistry` → `pendingIntentsStore` →
   `ApprovalHost` → `ChainAdapter.executeApproval`, exactly like a WebView
   request. Transports are *dumb*: they translate wire messages to
   `ChainRequest`s and translate results back. No transport signs.
2. **Space-docking, not branching.** Chain knowledge lives in
   `services/chains/<ns>/deeplinks.ts` (scheme handlers) and in optional
   `WalletKitAdapter` capabilities (§4.5). `app/`, `hooks/`, `components/`
   never contain a scheme string or a namespace comparison;
   `pnpm check:chains` stays green with **no** new allowlist entries.
3. **Provenance is a first-class field.** Every intent produced from a
   link carries `Origin.via` and a `Provenance` record (§4.3) that the
   sheets render as a banner. "Unverified" is a normal, visible state,
   never a silent one.
4. **Preview, never execute.** No link, of any class, from any source,
   results in a signature, a broadcast, a chain switch, a session grant,
   or a trustline without a sheet the user taps. (TWV-2026-024 "always
   open a preview screen — never auto-execute".)
5. **Verified host for anything that carries intent.** Custom-scheme
   entry is accepted (the ecosystems require it) but is labelled and
   never treated as identity. Our own universal link is the only path we
   *advertise* (WalletGuide, MWA `wallet_uri_base`, docs).
6. **Fail closed, say why, say it kindly.** Every rejection is a typed
   `DeepLinkRejectCode` mapped to hand-written copy; raw URIs, server
   bodies, and exception text go to `__DEV__` logs only
   (`feedback_user_facing_errors`). No em-dashes in copy.

### 4.2 Pipeline

```
 OS (cold/warm)          push tap            QR / gallery / paste
      │                     │ (read-only          │ (existing classify())
      ▼                     │  routes only)        ▼
 app/+native-intent.tsx     │            services/paymentIntent/*
   redirectSystemPath ──────┼───────────────┐
      │ raw string          │               │
      ▼                     ▼               │
 services/deeplinks/intake.ts  ─ envelope (raw, source, initial, receivedAt)
      │  size cap · fragment denylist · consumed-ledger · signing-mode
      ▼
 services/deeplinks/schemeRegistry.ts  ─ parseDeepLink(envelope)
      │  scheme → handler (registered per namespace / per transport)
      │  https://takumipay.xyz/<path> → paths/*.ts (namespace-agnostic)
      ▼
 DeepLinkIntent  ──(kind:"navigate"|"open-dapp")──► router (allowlisted hrefs only)
      │
      └─(anything with intent)──► services/deeplinks/inbox.ts (in-memory hold)
                                         │  returns "/link-inbox" to expo-router
                                         ▼
                                app/link-inbox.tsx  (interstitial; under lock)
                                         │ user taps Continue
                                         ▼
                   ┌─────────────────────┼──────────────────────────┐
                   ▼                     ▼                          ▼
        Class A payment          Class B signing              Class C session
   PaymentIntent{source:        build ApprovalIntent       TransportAdapter.pair()
   "deeplink"} → /send          via handler.build()        (WC / MWA / EncryptedLink)
   (prefilled + provenance      → DappBridge                      │ ChainRequest stream
    banner)                       .submitExternalIntent()          ▼
                                         │              DappBridge.dispatchExternal()
                                         ▼                        │
                              InspectorRegistry → pendingIntentsStore → ApprovalHost (root)
                                         │
                                         ▼
                              ChainAdapter.executeApproval → ReturnChannel.deliver()
```

### 4.3 Types (`services/deeplinks/types.ts`)

```ts
export type DeepLinkSource = "cold" | "warm" | "push" | "scan" | "paste" | "internal";

export interface DeepLinkEnvelope {
  raw: string;            // never logged in production; hashed for the ledger
  source: DeepLinkSource;
  initial: boolean;       // expo-router's `initial`
  receivedAt: number;
  platform: "android" | "ios";
}

/** Who is (claimed to be) asking, and how strongly we believe it. */
export interface Provenance {
  /** What the link says. Displayed only when `verification !== "none"` or clearly labelled. */
  claimedOrigin?: string;                // "https://shop.example", "app.example.com"
  /** How we know. */
  verification:
    | { kind: "none" }                                              // custom scheme, nothing to check
    | { kind: "universal-link" }                                    // arrived on our verified host: proves the link targeted US exclusively, says nothing about who sent it
    | { kind: "sep7-signature"; domain: string; keyPinned: boolean } // §6.4
    | { kind: "digital-asset-links"; package: string }              // §8
    | { kind: "wc-verify"; validation: "VALID" | "INVALID" | "UNKNOWN"; isScam: boolean } // §7
    | { kind: "failed"; reason: DeepLinkRejectCode };
  firstSeen: boolean;     // origin never seen before (SEP-0007 threat 2; WC "unverified")
  transport: "os-link" | "walletconnect" | "mwa" | "encrypted-link";
}

export type ReturnChannel =
  | { kind: "none" }
  | { kind: "broadcast" }                                   // Class A/B: result is the chain
  | { kind: "http-callback"; url: string; form: "sep7-xdr" } // SEP-0007 `callback=url:`
  | { kind: "os-redirect"; url: string; encrypted: true }   // Phantom-compatible
  | { kind: "os-redirect"; url: string; encrypted: false }  // WC `redirect.native` (no payload)
  | { kind: "transport" };                                  // answered on the session

export type DeepLinkIntent =
  | { kind: "navigate"; href: AllowlistedHref }
  | { kind: "open-dapp"; url: string }
  | { kind: "payment"; namespace: Namespace; intent: PaymentIntent; provenance: Provenance }
  | {
      kind: "signing";
      namespace: Namespace;
      summary: SigningSummary;                 // what the interstitial shows before any network call
      build: (wallet: TWallet) => Promise<ExternalApprovalDraft>; // may fetch (Solana Pay POST, stellar.toml)
      returnChannel: ReturnChannel;
      provenance: Provenance;
    }
  | { kind: "pair"; transport: "walletconnect"; uri: string; provenance: Provenance }
  | { kind: "associate"; transport: "mwa"; uri: string; provenance: Provenance }
  | { kind: "encrypted-link"; method: EncryptedLinkMethod; params: Readonly<Record<string, string>>; provenance: Provenance }
  | { kind: "reject"; code: DeepLinkRejectCode };

export type DeepLinkRejectCode =
  | "too_large" | "fragment_blocked" | "malformed" | "unsupported_scheme"
  | "unsupported_chain" | "unsupported_operation" | "not_https"
  | "signature_missing" | "signature_invalid" | "signing_key_changed"
  | "network_mismatch" | "wrong_account" | "replayed" | "signing_mode"
  | "expired" | "no_wallet_for_namespace" | "route_not_allowed";
```

`ExternalApprovalDraft` = `Omit<ApprovalIntent, "annotations" | "id" | "createdAt">`
plus `provenance`. `Origin.via` gains `"deeplink" | "walletconnect" | "mwa"`
(`services/chains/types.ts`); the three `agentContext.ts` copies of the
union are updated in the same PR (they are type mirrors, not logic).

`services/deeplinks/uri.ts` — the F5 fix — is a ~60-line pure module:

```ts
export interface SplitUri { scheme: string; ssp: string; query: URLSearchParams; fragment: string | null; }
export function splitUri(raw: string): SplitUri | null;   // scheme = /^[a-z][a-z0-9+.-]*$/i, lowercased
export function isAbsoluteHttpsUrl(s: string): boolean;   // explicit, no `new URL`
export function hostnameOfHttps(s: string): string | null; // ASCII-only; IDN → inspectUrl() from idnHomograph.ts
```

Every handler in §6–§9 uses it. `new URL` appears only in `paths/*.ts`
for `https://takumipay.xyz/...` and only to read `pathname`/`searchParams`.

### 4.4 Scheme registry (the chain-agnostic dock)

`services/deeplinks/schemeRegistry.ts` mirrors
`services/paymentIntent/detectorRegistry.ts` (same `register()` +
priority sort + `__resetForTest`):

```ts
export interface DeepLinkSchemeHandler {
  id: string;                        // "eip681" | "solana-pay" | "sui-pay" | "sep7" | "walletconnect" | "mwa" | …
  namespace: Namespace | null;       // null = transport-level (wc:)
  schemes: readonly string[];        // lowercase; e.g. ["solana"]; "web+stellar" is fine
  platforms?: readonly ("android" | "ios")[]; // omit = both; MWA sets ["android"]
  priority: number;                  // lower first, for schemes shared by two handlers ("solana" → pay vs tx-request)
  parse(split: SplitUri, envelope: DeepLinkEnvelope): DeepLinkIntent | null;
}
export function registerSchemeHandler(h: DeepLinkSchemeHandler): void;
export function parseDeepLink(envelope: DeepLinkEnvelope): DeepLinkIntent;
```

Registration lives in per-namespace files and is imported once from
`services/deeplinks/boot.ts` (same shape as
`services/paymentIntent/detectors/index.ts`):

| File | Registers | Class |
|---|---|---|
| `services/chains/evm/deeplinks.ts` | `eip681` (`ethereum`) | A |
| `services/chains/solana/deeplinks.ts` | `solana-pay-transfer`, `solana-pay-transaction` (`solana`), `mwa-associate` (`solana-wallet`, android) | A, B, C |
| `services/chains/sui/deeplinks.ts` | `sui-pay` (`sui`) | A |
| `services/chains/stellar/deeplinks.ts` | `sep7` (`web+stellar`) | A, B |
| `services/transports/walletconnect/deeplinks.ts` | `walletconnect` (`wc`) | C |
| `services/transports/encryptedLink/deeplinks.ts` | (path-based, see below) | C |

Universal-link paths (`https://takumipay.xyz/<path>`) are
namespace-agnostic and live in `services/deeplinks/paths/`:

| Path | Handler | Produces |
|---|---|---|
| `/pay?uri=<encoded chain URI>` | `paths/pay.ts` → `parseDeepLink` on the inner URI with `verification: universal-link` | A/B (any namespace) |
| `/wc?uri=<encoded wc URI>` | `paths/wc.ts` | C |
| `/ul/v1/<method>?…` | `paths/ul.ts` (Phantom-compatible) | C |
| `/mobilewalletadapter/v1/associate/local?…` | `paths/mwa.ts` (android) | C |
| `/dapp/<url>` or `/dapp?url=` | `paths/dapp.ts` | D (`open-dapp`) |
| `/link/<route>` | `paths/navigate.ts` — allowlist: `wallet`, `activities`, `notification`, `dapp-permissions`, `about` | D |
| anything else on the host, incl. `/send`, `/sign`, `/add-chain`, bare file routes | **rejected** (`route_not_allowed`) → `/link-inbox` shows "This link isn't something the wallet can open." | — |

`/pay?uri=` exists so that a merchant or dApp targeting *this* wallet on
iOS (where a custom scheme's winner is undefined, §3) has an exclusive
entry that still carries the chain's own standard URI unchanged.

**Pass-through (never touched by the kernel).** `+native-intent` sees
*every* URL, including ones that are not ours to interpret. `intake`
returns the path unchanged, with no ledger entry and no analytics, for:
`exp+takumiwallet*://` and `expo-development-client://` (dev client),
`takumiwallet*://expo-development-client/*`, the Google Sign-In callback
scheme (`com.googleusercontent.apps.*`), any `openAuthSessionAsync`
redirect we register in the future, and `https://takumipay.xyz/` with an
empty path (plain app open). Anything else that is not a registered
scheme or an allowlisted path is `unsupported_scheme` /
`route_not_allowed`. The pass-through list is a single constant in
`services/deeplinks/intake.ts` with a test that fails when a new
`scheme` is added to `app.config.ts` without a decision.

**Legacy custom-scheme routes.** `takumiwallet://send?to=&amount=&chain=`,
`takumiwallet://dapp?url=`, `takumiwallet://connect?uri=` (from
`parseCustomScheme`) keep working: `send` becomes a Class-A EVM payment
with `verification: none` through the inbox (never the direct `/send`
push it had), `dapp` → `open-dapp`, `connect` → `pair`. No other
`takumiwallet://<route>` opens a file route.

### 4.5 `WalletKitAdapter` optional capabilities

Added to `services/walletKit/types.ts` (presence-checked, never
namespace-checked; `feedback_space_docking`):

```ts
/** CAIP-2 chains + WalletConnect method/event lists this kit will advertise in a session. */
walletConnectNamespace?(args: { wallets: TWallet[]; chains: ChainConfig[] }): {
  chains: string[]; methods: string[]; events: string[]; accounts: string[]; // CAIP-10
} | null;
/** Translate a WalletConnect JSON-RPC request into the adapter's `ChainRequest` method/params, and back. */
walletConnectCodec?: {
  toChainRequest(method: string, params: unknown, chainId: string): { method: string; params: unknown } | null;
  fromChainResult(method: string, value: unknown): unknown;
};
/** Build the Class-A payment transaction for this kit's payment URI (Solana Pay, sui:pay, SEP-0007 pay). */
buildPaymentRequest?(args: { wallet: TWallet; chain: ChainConfig; payment: PaymentIntent }): Promise<ExternalApprovalDraft>;
```

EVM's `walletConnectCodec` is the identity mapping (WC and EIP-1193 share
method names); Solana/Sui/Stellar codecs are small tables (§7.4). The
`chains` a kit advertises are **CAIP-2 as the WalletConnect ecosystem
uses them**, which for Solana is the genesis-hash form (§7.3), not the
`solana:mainnet` alias the app uses internally; the kit owns that
translation. A
future chain that omits `walletConnectNamespace` is simply absent from
`supportedNamespaces` — `buildApprovedNamespaces` then rejects proposals
that *require* it, which is correct.

### 4.6 Bridge changes (`services/bridge/DappBridge.ts`)

- `submitExternalIntent(draft: ExternalApprovalDraft, via)` — generalises
  `submitAgentIntent` (which becomes a one-line wrapper with
  `via: "agent"`). Stamps `id`, `createdAt`, `annotations: []`, and a
  **`provenance` annotation** (`code: "link_provenance"`,
  `source: "local"`, `data: Provenance`) so every sheet renders the
  banner through the existing `RiskBanner` path with zero per-sheet code.
- `dispatchExternal(req: ChainRequest & { via })` — the Class-C entry:
  runs `HARD_REJECT_METHODS`, `isFlaggedHost`, then
  `ChainAdapterRegistry.get(ns).handleRequest(req, ctx)`; a
  `needs-approval` result enqueues exactly like the WebView path; the
  Promise resolves with the terminal value or `{code,message}`. The
  WebView-only steps (`trackedTopOrigin` pin, session-nonce ring,
  `pushPostDecisionUpdate` injection) are skipped when `via !== "webview"`
  — they are already null-safe (`getWebView()` returns `null`).
- `getContext()` at root boot returns `{ activeWallet: null, wallets,
  getAccount, chainOverride: undefined }`. For every external request the
  bridge then **overrides `ctx.activeWallet` with the transport-bound
  wallet** (§4.7) and `ctx.chainOverride` with the request's chain before
  calling `handleRequest`. This matters because `EvmAdapter.scopeCtxToOrigin`
  (verified, `EvmAdapter.ts:556-563`) rewrites `ctx.activeWallet` to the
  per-origin granted wallet and, for an origin with **no** grant, falls
  back to "global or first EVM wallet". That fallback is fine for a
  WebView page but would silently pick a wallet for a WalletConnect peer;
  with the bound wallet stamped by the bridge and the grant keyed per
  §4.9, the fallback branch is never reached for external transports
  (invariant S-4, `feedback_dapp_bridge_isolation`). **Decided (D-12):**
  the fallback is also closed at the source: `pickEvmWalletForOrigin`
  (and any future per-adapter equivalent) returns "disconnected" instead
  of a fallback wallet when `req.origin.via !== "webview"` and no grant
  exists, so an unbound external request can only ever produce a
  `connect` sheet. The dev-only assertion in `dispatchExternal` stays as
  the tripwire for future adapters.
- `bootBridge()` moves to `app/_layout.tsx` right after `bootWalletKits()`
  (its `booted` guard already makes the browser screen's later call a
  pure `updateOpts`). `<ApprovalHost/>` moves to the root layout, wrapped
  in the lock gate (§4.8). `app/dapps-browser.tsx` drops its own mount.

### 4.7 Wallet binding — which wallet signs

Deep-link requests do not have a "current" wallet. Rules, in order:

1. **Namespace presence** — `resolveNamespaceAccess` from
   `services/walletPresence` decides whether the user can act on the
   request's namespace at all. No wallet → `no_wallet_for_namespace`
   copy: "You don't have a {Chain} wallet yet. Create or import one to
   continue." (with the existing add-wallet CTA). Never derive one
   silently.
2. **Protocol-pinned account** — SEP-0007 `pubkey`, Solana Pay tx-request
   `account` (chosen by us before POST), WC `account` (CAIP-10), MWA
   `authorizationScope`, Phantom-compatible `session.public_key`: if the
   request names an account we hold, that wallet is bound; if it names one
   we do not hold → `wrong_account`: "This request is for an account that
   isn't in this wallet."
3. **Prior grant / session** — `PermissionStore.listByOriginForNamespace`
   (Class C) binds the wallet the user connected earlier for that origin.
4. **Otherwise the user picks** in the `ConnectSheet` / interstitial —
   list of wallets for the namespace, defaulting to the most recently used
   one for that namespace (`walletPresence.getWalletForNamespace`).
5. **`intent.wallet` is the bound wallet, full stop.** No sheet, inspector,
   or adapter reads `useWallet().activeWallet` for a deep-link intent
   (`feedback_dapp_bridge_isolation`). Payment-intent reads use that
   wallet's JWT (`feedback_payment_jwt_binding`).

### 4.8 Lifecycle: lock, signing mode, background, replay

- **Lock.** `+native-intent` cannot see lock state, so it never navigates
  into content: sensitive intents are placed in
  `services/deeplinks/inbox.ts` (in-memory, max 3, FIFO, 5-minute TTL) and
  the router is pointed at `/link-inbox`, which renders beneath
  `LockScreen`. `ApprovalHost` subscribes to `AppLockedContext` and renders
  `null` while locked; `pendingIntentsStore` gains `pause()/resume()` so
  transport requests queue but never present. On unlock the inbox drains
  one item at a time.
- **Signing mode** (`getSigningModeSync()`): Class A/B/C intents are
  dropped at intake with `signing_mode` copy ("Signing mode is on. Links
  can't open payment or signing requests."); Class D navigation to
  read-only screens is still allowed; `open-dapp` is dropped (the browser
  is disabled in that mode).
- **Push** (TWV-2026-054): `services/push/index.ts` continues to navigate
  only to read-only screens and never calls the kernel with Class A/B/C
  payloads; the kernel's `source: "push"` is accepted only for
  `kind: "navigate"` and rejected otherwise (invariant S-12).
- **Background / timing.** Nothing signs while the app is not foregrounded.
  WalletConnect's relay socket may deliver a request while backgrounded;
  it is queued (paused) and presented on foreground behind the lock.
  Solana Pay tx-request `POST` and SEP-0007 `stellar.toml` fetches happen
  only after the user taps Continue on the interstitial (no network on
  link receipt — S-6). MWA's local WebSocket must be listening within 10 s
  of launch (spec) — the MWA host activity (§8) is dedicated so the main
  app's boot does not race it.
- **Replay ledger** (F7): `services/deeplinks/ledger.ts` keeps
  `sha256(raw)` → `receivedAt` in MMKV for 24 h. A cold-start URL whose
  hash is present is dropped as `replayed`; warm `url` events are exempt
  (a user can legitimately tap the same QR twice — the on-chain nonce /
  blockhash / sequence number is the real replay guard for those).
- **Consumption.** An envelope is marked consumed when the user taps
  Continue or Dismiss on the interstitial, when the inbox TTL expires, or
  when intake rejects it.

---

### 4.9 Origin keys per transport (grant isolation)

`PermissionStore` grants are keyed by an origin string, and every adapter
resolves silent connects from it (`SolanaAdapter.ts:141,295`,
`StellarAdapter.ts:155-363`, `SuiAdapter.ts:186,351`,
`EvmAdapter.ts:606`). For the WebView the origin is the tracked
top-frame URL and is trustworthy. For external transports the "origin"
is **peer-supplied metadata** (`proposer.metadata.url`, MWA
`identity.uri` from a browser launch, Phantom-style `app_url` /
`redirect_link`). If those were used as grant keys verbatim, a malicious
WalletConnect peer could set `metadata.url = "https://app.uniswap.org"`
and inherit the browser grant the user gave the real Uniswap, and
`eth_accounts` / `connect` would resolve **without a sheet**.

Rule: `originKeyFor(transport, identity)` in `services/deeplinks/originKey.ts`
is the only way an external request gets an origin, and it never
collides with a WebView origin:

| Transport | Identity verified? | Origin key used for grants and `pendingByOrigin` |
|---|---|---|
| WebView | tracked top frame | `https://<host>` (unchanged) |
| WalletConnect | Verify `VALID` for `verified.origin` | `wc+https://<verified.origin host>#<pairing topic>` |
| WalletConnect | `UNKNOWN` / `INVALID` | `wc+unverified://<pairing topic>` |
| MWA | Digital Asset Links verified package | `mwa+https://<identity host>#<package>` |
| MWA | browser launch / unverifiable | `mwa+unverified://<sha256(identity.uri ?? "")>` |
| Phantom-compatible | never (no verifier exists) | `ul+unverified://<base58(dapp_encryption_public_key)>` |
| OS link (Class A/B) | SEP-0007 signature verified | `sep7+https://<origin_domain>` (used only for the first-seen check; Class A/B never create grants) |

`Origin.url` shown to the user stays the human string (`metadata.url`),
labelled per `Provenance`; the *key* is what the stores use. Verified and
unverified keys for the same peer are distinct on purpose: a peer that
was `UNKNOWN` yesterday and `VALID` today re-asks. Grants under
`wc+…`/`mwa+…`/`ul+…` are listed in the dApp-permissions screen under
their transport section and are revoked when the session ends (§7.5).

## 5. The public contract — links TakumiPay accepts

Advertised (WalletGuide, MWA `wallet_uri_base`, Phantom-compatible base,
docs):

| Purpose | Universal / App Link (exclusive) | Custom scheme (contended, accepted) |
|---|---|---|
| Any chain payment/sign URI | `https://takumipay.xyz/pay?uri=<encoded>` | the chain's own scheme directly |
| WalletConnect pairing | `https://takumipay.xyz/wc?uri=<encoded>` | `takumiwallet://wc?uri=<encoded>`, bare `wc:…` |
| Solana MWA (Android) | `https://takumipay.xyz/mobilewalletadapter/v1/associate/local?…` (returned as `wallet_uri_base`) | `solana-wallet:/v1/associate/local?…` |
| Phantom-compatible (Solana) | `https://takumipay.xyz/ul/v1/<connect\|disconnect\|signMessage\|signTransaction\|signAllTransactions\|signAndSendTransaction>` | `takumiwallet://ul/v1/<method>` (not recommended, mirrors Phantom) |
| Open a dApp in the in-app browser | `https://takumipay.xyz/dapp/<url>` | `takumiwallet://dapp?url=<encoded>` (exists) |
| Read-only screens | `https://takumipay.xyz/link/<wallet\|activities\|notification\|dapp-permissions\|about>` | `takumiwallet://link/<same>` |

Chain-native schemes registered at OS level (§12): `ethereum`, `solana`,
`sui`, `web+stellar`, `wc` on both platforms; `solana-wallet` on Android
only (dedicated activity).

Dev/preview variants use `takumiwallet-dev://` / `takumiwallet-preview://`
and the same host with the same paths; `assetlinks.json` lists all three
package names + fingerprints, AASA lists all three App IDs.

---

## 6. Class A / B handlers per chain

Common contract for every handler: `parse()` is pure and synchronous
(no network, no keystore); `build()` runs only after the interstitial's
Continue; all amounts are converted to base units by the kit
(`parseNativeAmount` / token decimals) and re-displayed by the sheet from
the *built* transaction, never from the URL string (SEP-0007 threat 3:
what you sign is what you see).

### 6.1 EVM — `services/chains/evm/deeplinks.ts` (`eip681`)

Delegates parsing to `walletUriDetector.detect()` (single parser, F8)
after the following pre-normalisation, then wraps the result in
`{ kind: "payment", … }`:

| Input | Handling |
|---|---|
| `ethereum:pay-0x…` (ERC-831 prefix) | strip `pay-`; `ethereum:<other>-…` → `unsupported_operation` |
| `value=2.014e18` (scientific) | expand to integer wei before `BigInt`; non-integer result → `malformed` |
| ENS name as `target_address` | `unsupported_operation` ("Names aren't supported in payment links yet.") — future work §16 |
| `/transfer` | existing ERC-20 path (token = target, recipient = `address`, amount = `uint256`) |
| any other `function_name` | `unsupported_operation` ("Contract calls aren't supported in payment links.") |
| `@chainId` not among backend chain rows for `eip155` | `unsupported_chain` |
| `gas`, `gasLimit`, `gasPrice` | ignored (our fee estimator owns fees; the ERC calls them suggestions) |

Routing: `switchToScannedTarget` unchanged → `/send` with
`source: "deeplink"` and the provenance banner. Sending uses the existing
`sendNativeTransfer` / `sendTokenTransfer`; no new signing path.

### 6.2 Solana — `services/chains/solana/deeplinks.ts`

**`solana-pay-transfer` (priority 10, Class A).** `parse` extends the
existing `parseSolana` in `walletUri.ts` (which keeps QR behaviour
byte-for-byte) with the fields the QR path ignored: repeated `reference`
(each must decode to exactly 32 bytes, else `malformed`), `label`,
`message`, `memo` (URL-decoded, length-capped at 256 chars for display,
memo bytes ≤ 566 per SPL Memo). Amount rules per spec: decimal string,
leading `0`, no exponent; SOL > 9 decimals → `malformed`; SPL decimals are
checked in `build()` after `getMint`. `build()` is the new
`SolanaWalletKit.buildPaymentRequest`:

1. `getAccountInfo(recipient)` must exist, be owned by the System Program
   and not be executable (the reference `@solana/pay` `createTransfer`
   checks); else copy "This address can't receive a payment."
2. SPL: derive recipient ATA (`getAssociatedTokenAddress`), require it to
   exist (reference behaviour: "recipient not found"); build
   `TransferChecked` (decimals bound) as the **last** instruction, Memo as
   **second to last** if present, `reference` keys appended
   `{ isSigner: false, isWritable: false }` in URL order.
3. Emit `{ kind: "signAndSendTransaction", namespace: "solana", payload:
   <base64 versioned tx>, origin: { url: label ? … : "link://solana-pay",
   via: "deeplink" } }` → `SolanaTransactionSheet` with
   `SolanaProgramDecoderInspector` + `SolanaSimulationInspector` running
   as they do for the browser. `label`/`message` render in the sheet's
   counterparty block, plainly marked "from the link".

Note: `cluster=` is **not** in the Solana Pay spec; the existing
detector accepts it as a wallet-side extension (Phantom's connect param
uses the same name) and it stays accepted, defaulting to `mainnet-beta`.

**`solana-pay-transaction` (priority 20, Class B).** Matches when the
scheme-specific part, URL-decoded, is an absolute `https://` URL (else
`malformed`/`not_https`). `summary` = the hostname. `build(wallet)`:

1. `GET <link>` with `Accept: application/json`, `Accept-Encoding`, no
   auth, no wallet-identifying headers, 10 s timeout, follow ≤ 3
   same-scheme redirects. (The spec says the GET "should not identify the
   wallet"; RN's default `User-Agent` on iOS embeds the bundle name and
   cannot be replaced per request, so we set a generic `User-Agent` where
   the platform honours it and accept the residual on iOS.) Response must be JSON `{label, icon}`; `icon`
   must be an absolute http(s) URL ending in `.svg|.png|.webp` (or
   `Content-Type` of those) else `malformed`. A failed GET is
   non-fatal (spec: "should") — the sheet shows the domain only.
2. `POST <link>` body `{"account": <bound wallet pubkey>}` →
   `{transaction, message?}`.
3. Validate as untrusted, per spec (§2.2.1): deserialize; if no
   signatures → overwrite `feePayer` = account and `recentBlockhash` =
   latest; if signatures present → verify every one (`nacl.sign.detached.verify`
   over the message bytes), reject `malformed` on failure, do not touch
   feePayer/blockhash; compute required signers from the message header;
   if any required signer other than `account` is still unsigned →
   **`malicious`** (copy: "This request asks for a signature the wallet
   can't provide."); tx size ≤ 1232 bytes.
4. Emit `signAndSendTransaction` intent as above, with `origin.url =
   "https://<host>"`, `label`/`icon` from GET, `message` from POST. The
   simulation inspector runs on the *exact* bytes to be signed.

**`mwa-associate` (Class C, android)** — see §8.

### 6.3 Sui — `services/chains/sui/deeplinks.ts` (`sui-pay`, Class A)

`parse` is a hand-rolled mirror of Mysten `parsePaymentTransactionUri`
(§2.3) so the app does not have to take `@mysten/payment-kit` (which
peer-requires `@mysten/sui ^2.30.0`; the repo is on `^2.16.0` — see §16):
`ssp` must start with `pay?`; `receiver` valid Sui address; `amount`
integer `> 0` in base units; `coinType` valid struct tag; `nonce` ≤ 36
chars; optional `registry` (object id vs name), `label`, `message`,
`iconUrl` (https only, else dropped). `build()` =
`SuiWalletKit.buildPaymentRequest`: a PTB that splits `amount` of
`coinType` from the sender's coins and calls (verified in Mysten
`contracts/payment_kit/payment_kit.ts` + `calls.ts` + `utils.ts`):
- `<pkg>::payment_kit::process_ephemeral_payment<CoinType>(nonce: 0x1::string::String, payment_amount: u64, coin: Coin<CoinType>, receiver: address, clock: 0x2::clock::Clock)`, or
- `<pkg>::payment_kit::process_registry_payment<CoinType>(registry: &mut Registry, nonce: String, payment_amount: u64, coin: Coin<CoinType>, receiver: Option<address>, clock: Clock)` when `registry` is present, where a registry *name* resolves to an object id via `deriveObjectID(namespaceId, "0x1::ascii::String", bcs.String.serialize(name))` and a registry object id is used as-is;
with the Clock at `0x6`, the coin from `coinWithBalance({ type: coinType, balance: amount })`, and `<pkg>`/`namespaceId` pinned per network from Mysten `constants.ts` (mainnet `0xbc126f…69bc6` / `0xccd3e4…3ae7c2`, testnet `0x7e069a…71497` / `0xa50168…878db`). Package ids live in `constants/configs/suiPaymentKit.ts` with a test that re-derives the default registry id. Emits
`sui:signAndExecuteTransaction` → `SuiTransactionSheet` with the PTB
decoder + `SuiSimulationInspector`. Network is the wallet's bound
`ChainConfig.network`; a `registry` object id that does not exist on that
network → simulation failure surfaces as the existing friendly copy.

### 6.4 Stellar — `services/chains/stellar/deeplinks.ts` (`sep7`, Class A + B)

`parse` (pure): `ssp` = `<op>?<query>`, `op ∈ {tx, pay}` else
`unsupported_operation`. Shared query rules:
- `msg` URL-decoded, truncated to 300 chars (spec) for display, rendered
  in the app's monospace-distinct font (threat 7).
- `network_passphrase`, if present, is resolved to a backend Stellar chain
  row by passphrase; absent → pubnet. A passphrase that matches no chain
  row → `unsupported_chain`.
- `origin_domain` present without `signature` → `signature_missing` (spec:
  "not a valid URI request"). `origin_domain` present must be an FQDN
  (`^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$`, ASCII; IDN → run through
  `inspectUrl` and refuse `confusable`). Neither present → allowed,
  `provenance.verification = { kind: "none" }`, and the interstitial shows
  the "unsigned request" warning with an extra confirmation checkbox
  (spec threat 1: "make it harder … additional steps").
- `chain` accepted and ignored except depth counting (> 7 nested `chain`
  params → `malformed`).
- `callback` must start with `url:` and the remainder must be an absolute
  `https://` URL, else `malformed`; becomes
  `ReturnChannel{ kind: "http-callback" }`.

`build(wallet)` — verification first, then construction:
1. If `origin_domain`: fetch `https://<origin_domain>/.well-known/stellar.toml`
   (no cache, 10 s, ≤ 3 redirects, same host only), parse
   `URI_REQUEST_SIGNING_KEY` (must be a valid `G…` StrKey). Compare with
   the pinned key in `services/deeplinks/sep7KeyPins.ts` (MMKV, per
   domain): a different pinned key → `signing_key_changed` — the sheet
   **blocks** with copy "The signing key for {domain} has changed since you
   last used it. For your safety this request was not opened." and a
   "Trust the new key" action that requires biometrics
   (`requiresPerActionAuth("sign")`). Verify Ed25519 over
   `Buffer.concat([Buffer.alloc(35, 0), Buffer.from([4]), utf8("stellar.sep.7 - URI Scheme" + uriWithoutSignature)])`
   with `Keypair.fromPublicKey(key).verify(payload, base64(urlDecode(signature)))`
   (`@stellar/stellar-base`, already a dependency); `uriWithoutSignature`
   is the raw URI with the trailing `&signature=…` (or `?signature=…`)
   removed **byte-for-byte**, no re-serialisation. Failure →
   `signature_invalid` (blocks). Success → pin the key,
   `provenance.verification = { kind: "sep7-signature", domain,
   keyPinned }`, `firstSeen` from the pin store.
2. **`pay`:** `destination` must be a `G…` StrKey (federated `name*domain`
   and `M…` muxed → `unsupported_operation` with copy; matches
   `stellar-chain-support-spec.md` §0 non-goals); `asset_code`/`asset_issuer`
   → the wallet must *hold* that asset (a trustline with balance ≥ amount)
   else copy "You don't hold {code} in this wallet." (path payments are a
   non-goal); missing `amount` → sheet with editable amount; `memo` +
   `memo_type` mapped to `Memo.text|id|hash|return` (hash/return are
   base64 then URL-decoded per spec). Build via `assetTransferService`
   into an unsigned envelope → `signTransaction` intent → the existing
   `StellarTransactionSheet` + `StellarXdrDecoderInspector` +
   `StellarPreflightInspector` (destination exists / trustline present),
   which also implements threat 5 ("address you have not seen before")
   through the address-book/first-seen check already used by the send
   flow.
3. **`tx`:** base64-decode `xdr` → `TransactionEnvelope` (v0, v1, fee-bump
   all accepted; decode failure → `malformed`). The envelope's network id
   must equal the resolved chain's passphrase hash → else
   `network_mismatch` ("This request is for a different Stellar
   network."). `replace`: parse Txrep pairs; v1 supports only
   `sourceAccount` and `operations[<n>].sourceAccount` references
   (resolved to the bound wallet's account, re-serialised through
   `TransactionBuilder`); any other field → `unsupported_operation`
   ("This request needs details this version can't fill in."). `pubkey`
   → wallet binding rule 2 (§4.7). Emit `signTransaction` intent; the
   sheet already decodes operations (Soroban envelopes decode as generic
   with the existing plain warning).
4. **Return.** No `callback` → sign **and submit** through the adapter's
   submit path (spec default), sheet button reads "Sign and send".
   `callback` → sign only, then `POST` form `xdr=<urlencoded signed
   envelope>` to the callback URL (query params preserved), 10 s,
   result toast "Sent to {domain}." / "Couldn't reach {domain}. Your
   signed transaction was not submitted." The signed XDR is never opened
   as an OS URL.
5. Default-handler check (threat 6): on Android, `intake` records whether
   the wallet received a `web+stellar:` link via a chooser or directly
   (`Intent` has no such flag; we approximate with "did we receive at
   least one SEP-7 link in the last 30 days"): not implementable
   faithfully on either OS — logged as a deliberate gap (§16), no fake
   alert.

### 6.5 Interstitial (`app/link-inbox.tsx`)

**Decided (D-10): what goes through the interstitial.**

| Class | From an OS link (`+native-intent`) | From the in-app QR scanner / gallery / paste |
|---|---|---|
| A payment URI | interstitial → `/send` | direct `/send` with `ProvenanceBanner` ("From a QR code"), as today |
| B signing URI | interstitial (it is also the consent gate for the network fetches S-6 requires) | interstitial, same reason |
| C session (`wc:`, MWA, `/ul/v1`) | interstitial → `ConnectSheet` | straight to `ConnectSheet` (the sheet is the consent) |
| D navigation | direct | n/a |

Rationale: the interstitial exists to show provenance the user did not
choose and to gate network calls the user has not consented to. A QR the
user pointed the camera at already carries the first; Class A needs no
network before the send screen, Class B does. Class C's sheet already
renders provenance.

One screen for every held intent. Shows, top to bottom: source chip
("From a link" / "From a QR code"), verification badge (from
`Provenance`), the claimed origin **only** when verification is not
`none` (unverified origins are shown as "Unverified sender" with the
domain in a muted secondary line, never as a headline — SEP-0007 rule 8
and WC Verify guidance), the parsed summary (chain badge via
`chainBadgeLabel`, amount + asset for Class A, operation names for `tx`,
"Connection request from {name}" for Class C), the wallet picker when
binding rule 4 applies, and two buttons: "Continue" / "Not now". Copy
uses periods and colons, never em-dashes.

---

## 7. WalletConnect v2 transport (`services/transports/walletconnect/`)

### 7.0 Naming and credentials (verified 2026-09-11)

- **Reown** is the company ("Reown (formerly WalletConnect)" per
  `docs.reown.com`); it owns **AppKit** (dApp side) and publishes the wallet
  SDK package **`@reown/walletkit`**. **WalletConnect** is the
  network/protocol brand; the wallet-side product is "WalletConnect Wallet
  SDK" (WalletKit) and its docs live at `docs.walletconnect.com`. Reown's
  own migration note: WalletKit pages "have been migrated from Reown Docs
  to the WalletConnect Docs", and the **WalletConnect Dashboard**
  (`dashboard.walletconnect.com`) "replaces the Reown Cloud dashboard" for
  wallet teams; "Your existing Project ID will remain the same."
  Everywhere in this spec: protocol/dashboard/docs = WalletConnect,
  package = `@reown/walletkit`.
- **The one credential is the Project ID** (`projectId`), created once per
  project on the WalletConnect Dashboard (New Project → type **Wallet**).
  It is embedded in the client, so it is an identifier, not a secret; it
  still lives in EAS env (`EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID`) rather
  than source.
- Dashboard hardening to enable on each project: **App ID** ("whitelist
  your iOS Bundle ID and Android Package Name to protect your project from
  impersonation") for the bundle IDs of that project's build profile;
  **Domain verification** for `takumipay.xyz`.
- Two projects: **production** (App ID-locked to
  `com.planckify.takumiwallet`; submitted to **WalletGuide**, the
  discovery directory formerly called Explorer, carrying the Mobile
  Linking fields `takumiwallet://` and `https://takumipay.xyz/wc`) and
  **dev/preview** (locked to the `.dev`/`.preview` bundle IDs, never
  submitted). WalletGuide submission is "recommended but optional" for
  relay usage, but it is what makes dApps' AppKit modal list us and deep
  link into us; its review checklist requires the EVM and Solana signing
  flows on AppKit Lab (§14 device matrix).

### 7.1 Dependencies and boot

`@reown/walletkit`, `@walletconnect/react-native-compat`,
`@walletconnect/utils` (for `buildApprovedNamespaces`, `getSdkError`,
`parseUri`), `@react-native-community/netinfo`, `fast-text-encoding`
(others already present). **Before merging:** `pnpm check:protofreeze`
must pass and the `__DEV__` canary must print all warmed; the WC stack
pulls `bn.js`/`elliptic`-class packages — expect at least one new
`pollyfills.ts` pre-load line per installed copy, and retest only after
`adb shell am force-stop` (`docs/prototype-freeze-crash-retrospective.md`).

`WalletKitTransport.start()` runs from `app/_layout.tsx` after
`bootBridge()`, **eagerly when** the launch envelope is a `pair` intent or
`getActiveSessions()` is non-empty, **lazily otherwise** (first `pair()`).
`projectId` from `EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID` (WalletConnect
Dashboard, §12). Metadata: `name` per variant, `url: "https://takumipay.xyz"`,
`redirect: { native: "<scheme>://", universal: "https://takumipay.xyz/wc" }`
(`linkMode` absent until Phase 2b).

### 7.2 Storage (TWV-2026-030)

`Core({ storage, keychain })` with `services/transports/walletconnect/storage.ts`:
an `IKeyValueStorage` over a dedicated MMKV instance `wc.v1` created with
`encryptionKey` = 32 random bytes generated once via
`react-native-quick-crypto` and kept in `expo-secure-store`
(`walletSecureStore`); `keychain` (session symmetric keys) uses the same
instance under a separate prefix. Nothing WalletConnect-related touches
AsyncStorage. `services/walletconnect/sessionStore.ts` (expo-sqlite) and
`components/walletconnect/SessionList.tsx` are deleted; the sessions
screen (§7.6) reads `walletKit.getActiveSessions()`.

### 7.3 Pairing and proposals

`pair(uri)` is reached from `parseDeepLink` (`wc:` scheme, `/wc?uri=`,
`takumiwallet://wc?uri=`) and from the QR scanner (a new `wc:` detector at
priority 15 in `services/paymentIntent/detectors/walletConnect.ts` that
returns a `PaymentIntent`-shaped `{ channel: { kind: "wc", uri } }`; the
scan screen routes it into the inbox instead of `/send`). Pre-checks:
`parseUri` succeeds, `version === 2`, `expiryTimestamp` (if present) in
the future else `expired` ("This connection link has expired. Ask the app
for a new one."), `relay-protocol === "irn"`.

On `session_proposal`:
1. `supportedNamespaces` is assembled by iterating
   `walletKitRegistry.getAll()` and calling each kit's
   `walletConnectNamespace({ wallets, chains })` (§4.5) — no namespace
   literal in the transport. EVM advertises every backend `eip155` chain
   row and the methods `EvmAdapter` dispatches (§1 table) **minus**
   `eth_sign`/`eth_signTransaction`/`eth_sendRawTransaction`; Solana
   **`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`** (mainnet),
   **`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`** (devnet),
   **`solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z`** (testnet): the CAIP-2
   Solana namespace is `truncate(genesisHash, 32)` (ChainAgnostic
   `solana/caip2.md`, §17) and that is what AppKit sends; the app's
   internal `solana:mainnet` keys (MWA style, `PermissionStore`,
   `caipMapping.ts`) are an alias. `services/walletconnect/caipMapping.ts`
   gains the genesis-hash ⇄ cluster table and accepts **both** forms on
   input (`solana-adapter-spec.md` §"cluster" already notes legacy dApps
   emit the hash form). Sui is `sui:mainnet|testnet|devnet` and Stellar
   `stellar:pubnet|testnet` per their CAIP-2 namespaces, unchanged.
   Methods: `solana_signMessage`,
   `solana_signTransaction`, `solana_signAllTransactions`,
   `solana_signAndSendTransaction`, `solana_getAccounts`,
   `solana_requestAccounts`; Sui `sui:mainnet|testnet` with the four
   `sui_*` methods; Stellar `stellar:pubnet|testnet` (via
   `stellarNetworkToCaipReference`) with the four `stellar_*` methods.
2. A `connect` `ApprovalIntent` per requested namespace group is
   submitted through `submitExternalIntent` with
   `origin: { url: proposal.proposer.metadata.url, title: …name, icon:
   …icons[0], via: "walletconnect" }` and
   `provenance.verification = { kind: "wc-verify", … }` from
   `verifyContext`. **Decided (D-14):** `isScam === true` or
   `isFlaggedHost(metadata.url)` → hard block, no override (existing
   `block` verdict path, approve button absent, copy "This app is
   flagged as malicious. The wallet will not connect to it."); `INVALID`
   (domain mismatch, the phishing signature) → blocked by default, with
   a "Connect anyway" path that requires the explicit-risk checkbox
   **and** biometric/PIN regardless of the per-action-auth setting;
   `UNKNOWN` → allowed with the "Unverified app" banner and the
   first-seen note; `VALID` → normal. The same three-tier rule applies
   to `session_request` events (a session that turns `INVALID` mid-life
   is blocked for signing until reconnected).
3. User approves in `ConnectSheet` (wallet picker per §4.7) →
   `approveSession({ id, namespaces: buildApprovedNamespaces(...) })`,
   `PermissionStore.grant` per (origin, wallet, chainKey) so the existing
   dApp-permissions screen and revoke flows show WC sessions like browser
   grants; reject → `rejectSession(USER_REJECTED)`.
4. Redirect back **only if the pairing arrived by deep link** (vendor
   guidance, §2.5): `Linking.openURL(metadata.redirect.native)` inside
   try/catch, custom scheme only; an `https` redirect is shown as a
   "Return to {name}" button, never auto-opened.

### 7.4 Requests → `ChainRequest`

`session_request` → `dispatchExternal({ namespace, method, params,
origin, id, via: "walletconnect" })` after `walletConnectCodec.toChainRequest`:

| WC method | `ChainRequest.method` | Result mapping (`fromChainResult`) |
|---|---|---|
| `eip155` any | identity | identity |
| `solana_signMessage {message: base58, pubkey}` | `solana:signMessage` (bytes) | `{ signature: base58 }` |
| `solana_signTransaction {transaction: base64}` | `solana:signTransaction` | `{ signature: base58(sig), transaction: base64(signed) }` (both fields, per doc) |
| `solana_signAllTransactions {transactions[]}` | `signAllTransactions` | `{ transactions: base64[] }` |
| `solana_signAndSendTransaction {transaction, sendOptions?}` | `solana:signAndSendTransaction` | `{ signature: base58 }` |
| `solana_getAccounts` / `solana_requestAccounts` | answered by the transport from the session's accounts (no sheet) | `[{ pubkey }]` |
| `sui_signTransaction {transaction, address?}` | `sui:signTransaction` | `{ signature, transactionBytes }` |
| `sui_signAndExecuteTransaction` | `sui:signAndExecuteTransaction` | `{ digest }` |
| `sui_signPersonalMessage {message, address}` | `sui:signPersonalMessage` | `{ signature }` |
| `sui_getAccounts` | transport | `[{ pubkey, address }]` (also serialised into `sessionProperties.sui_getAccounts` at approval, per doc) |
| `stellar_signXDR {xdr, chain, account}` | `signTransaction` (sign-only) | `{ signedXDR, signerAddress }` |
| `stellar_signAndSubmitXDR` | `signTransaction` with submit | `{ tx_hash, signedXDR, successful? }` |
| `stellar_signMessage` | `signMessage` | per doc |
| `stellar_signAuthEntry` | `signAuthEntry` | per doc |

Request lifecycle details (verified in `walletconnect-monorepo`
`packages/types/src/sign-client/client.ts`): both `session_proposal` and
`session_request` events carry `verifyContext`; `session_request.params.request`
may carry `expiryTimestamp`, and the SDK emits `session_request_expire
{ id }` when it lapses. The transport rejects an intent whose
`expiryTimestamp` has passed before the sheet renders, and removes the
pending intent on `session_request_expire`. Requests are queued per
origin key (§4.9) through the existing `pendingByOrigin` one-at-a-time
rule rather than rejected, so a dApp that fires two requests gets two
sheets in order. `solana_signTransaction`'s deprecated
`feePayer`/`instructions`/`recentBlockhash` param shape is not accepted
(`-32602`); only the base64 `transaction` form is. For `eip155` the
request's `chainId` becomes `ctx.chainOverride` (registered chains only;
an unknown chain is `4901`).

Chain binding: the request's `chainId` (CAIP-2) must be one of the
session's approved chains **and** match the bound wallet's namespace;
Stellar additionally checks the envelope's network id against `chain`
(doc: "MUST reject"). A request for a chain the session did not approve →
JSON-RPC error `4901` (same code the adapters use for "chain not
connected"). Every JSON-RPC error message sent to the peer is a fixed
string from `services/chains/evm/errors.ts` shapes; user-facing copy is
separate. Timeouts: an intent not decided in 5 minutes is rejected with
`USER_REJECTED` and removed (mirrors `QUEUE_*` semantics).

### 7.5 Events and lifecycle

`chainChanged` / `accountsChanged` are emitted only for sessions whose
bound wallet changes through the dApp-permissions screen (never because
the home-screen active wallet changed — isolation). `session_delete` →
`PermissionStore.revoke(origin, namespace)` (namespace-scoped,
`project_permission_revoke_namespace_scoping`). App-side disconnect →
`disconnectSession(USER_DISCONNECTED)`. Sessions expire per relay (7
days); `extendSession` on each successful request.

### 7.6 UI

`app/dapp-permissions.tsx` gains a "Connected apps (WalletConnect)"
section listing `getActiveSessions()` with peer icon/name/url (rendered
as plain text, never auto-opened — TWV-2026-030 note), chains, bound
wallet, and Disconnect. The scanner's existing "Scan a WalletConnect QR
code to connect" empty-state copy is reused.

### 7.7 Phase 2b — Link Mode (EVM only)

Requires One-Click Auth (`auth_request` → SIWE via `EvmAdapter`
`signIn`), `redirect.linkMode: true`, and registering
`https://takumipay.xyz/wc` in the WalletConnect Dashboard. Because the
vendor disables Link Mode internally when non-EVM namespaces are present
in a session, sessions that include Solana/Sui/Stellar simply fall back
to relay — no code branch on our side. Deferred until after Phase 2
ships and is measured.

---

## 8. Solana Mobile Wallet Adapter transport (Android only)

### 8.1 Host activity and second root

Following the reference RN wallet (§2.2.2), MWA is hosted in a dedicated
`MobileWalletAdapterActivity extends ReactActivity` (`launchMode="singleTask"`,
own `taskAffinity`, bottom-sheet theme, `exported="true"`) declared by a
new config plugin `plugins/withSolanaMobileWalletAdapter.ts`, with the
two intent filters from the reference manifest (`VIEW`+`BROWSABLE`
`solana-wallet`, and the uncategorised `solana-wallet` fallback at
`order="0"`) **plus** an `autoVerify` filter for
`https://takumipay.xyz/mobilewalletadapter` so we can return
`wallet_uri_base = "https://takumipay.xyz/mobilewalletadapter"` in
`authorize` (spec: dApps must reject non-`https:` prefixes). Its
`getMainComponentName()` is `"TakumiMwaEntrypoint"`, registered from a
custom entry (`index.ts` replacing `expo-router/entry`, which still calls
`registerRootComponent` for the main app) as a minimal tree:
`pollyfills` → `bootWalletKits()` → providers (QueryClient, SafeArea,
`AppLockedContext`) → `<MwaHost/>` (§8.2) → `<ApprovalHost/>`. It does
**not** mount the router, the home screen, or the WebView.

Why a separate activity: `getCallingPackage()` (the only OS-attested
identity in this whole spec) returns `null` unless the dApp used
`startActivityForResult` into an activity that is not the task root —
the reference wallets and the walletlib's `verifyCallingPackage` are
built around this. Hosting MWA in `MainActivity` would silently downgrade
every native dApp to "unverified".

### 8.2 `MwaHost` and `services/transports/mwa/`

`initializeMWAEventListener` then `initializeMobileWalletAdapterSession("TakumiPay", config)`
with `supportsSignAndSendTransactions: true`,
`maxTransactionsPerSigningRequest: 10`, `maxMessagesPerSigningRequest: 10`,
`supportedTransactionVersions: [0, "legacy"]`,
`noConnectionWarningTimeoutMs: 3000`,
`optionalFeatures: ["solana:signInWithSolana"]`. Request mapping:

| MWA request | Identity check | `ChainRequest` |
|---|---|---|
| `AuthorizeDappRequest` (`appIdentity`, `cluster`, `signInPayload?`) | `SolanaMobileDigitalAssetLinks.verifyCallingPackage(identityUri)` when `getCallingPackage()` is non-null → `provenance { kind: "digital-asset-links", package }`; browser launch → `{ kind: "none" }` + "Unverified app" | `connect` (+ `solana:signIn` when `signInPayload`) → on approve `resolve(req, { publicKey, accountLabel, walletUriBase: "https://takumipay.xyz/mobilewalletadapter", authorizationScope })` |
| `ReauthorizeDappRequest` | scope lookup | no sheet if the grant is live; else `UserDeclined` |
| `DeauthorizeDappRequest` | — | `PermissionStore.revoke(identityUri, "solana")` |
| `SignMessagesRequest` | scope | `solana:signMessage` ×N |
| `SignTransactionsRequest` | scope | `signAllTransactions` |
| `SignAndSendTransactionsRequest` | scope | `solana:signAndSendTransaction` ×N (sequential, one sheet each, or the batch sheet when N > 1) |

`authorizationScope` is 32 random bytes; the grant row is
`PermissionStore.grant({ origin: identityUri ?? "mwa://unverified/<hash>",
walletAddress, chainId: "solana:<cluster>" })` plus an MMKV map
`scope → { origin, walletAddress, cluster, issuedAt }` with 30-day expiry;
`reauthorize` rotates the scope. Failure responses use the walletlib's
`MWARequestFailReason` values; the user never sees them.

**Decided (D-8): identity policy.** Native callers
(`getCallingPackage() !== null`) **must** pass Digital Asset Links
verification of `identity.uri` against the calling package; failure
returns `ERROR_AUTHORIZATION_FAILED` with no sheet, exactly as the MWA
spec recommends. `MWA_REQUIRE_DAL` is therefore `true` and not
configurable in production. Browser launches
(`getCallingPackage() === null`) carry no OS identity at all; they are
allowed with the "Unverified app" banner and the first-seen note, keyed
`mwa+unverified://…` (§4.9), which is the posture every shipping Android
wallet has today. The attestation-script path
(`ERROR_ATTEST_ORIGIN_ANDROID`, wallet-hosted signed HTML on a
Digital-Asset-Linked `takumipay.xyz` page) is Phase 3b (§18): web dApps
that opt in with the `solana:attestOrigin` feature and attest get a
verified key `mwa+https://<host>#web` with `verification:
origin-attestation` ("Verified web app"); unattested ones keep the
unverified path.

### 8.3 Vendor caveat

`@solana-mobile/mobile-wallet-adapter-walletlib` is "alpha and not
production ready" by its README while stating the API is stable. Phase 3
gates MWA behind `FEATURE_MWA` (default off in production), ships to
preview first, and re-checks the README status before the production
flip. The library has no iOS sources; the plugin is a no-op on iOS and
`solana-wallet` is **not** added to `CFBundleURLSchemes`.

---

## 9. Phantom-compatible encrypted deep-link transport (Phase 3)

`services/transports/encryptedLink/` implements the Phantom deep-link
protocol shape at `https://takumipay.xyz/ul/v1/<method>` so that Solana
native apps built against that protocol can target TakumiPay by swapping
the base URL (this is the only iOS path for native Solana dApps other
than WalletConnect). Chain-agnostic by construction: the session JSON
already carries `chain` and `cluster` ("Sessions can't be used across two
different chains"), so a later EVM/Sui/Stellar variant is a new
`namespace` value in the session and a new method table, not a new
transport.

- **Keys.** Per-install x25519 wallet keypair in SecureStore
  (`encryptedLink.x25519.v1`); per-install Ed25519 session-signing keypair
  (`encryptedLink.sessionSign.v1`). Neither is a chain key. Shared secret
  per `dapp_encryption_public_key` cached in encrypted MMKV.
- **`connect`** (`app_url`, `dapp_encryption_public_key`, `redirect_link`,
  `cluster?`): `redirect_link` decoded; metadata (title/icon) fetched
  from its origin **only** when it is `https` (Phantom behaviour) with the
  same fetch discipline as §6.2; `isFlaggedHost(app_url)` and
  `isFlaggedHost(redirect origin)` checked; `connect` ApprovalIntent with
  `origin.url = redirect origin`, `provenance { kind: "none" }` +
  "Unverified app". Approve → session JSON `{ app_url, timestamp, chain:
  "solana", cluster, public_key }` signed with the session key, base58;
  response `{ public_key, session }` boxed with `nacl.box` (random 24-byte
  nonce) → redirect `redirect_link?phantom_encryption_public_key=…&nonce=…&data=…`
  (parameter names kept verbatim for client compatibility). Reject →
  `redirect_link?errorCode=4001&errorMessage=User%20rejected`.
- **Method payloads** (verified from `docs.phantom.com`): `signMessage`
  `{ message: base58, session, display?: "utf8"|"hex" }` → `{ signature:
  base58 }`; `signTransaction` `{ transaction: base58(serialized tx),
  session }` → `{ transaction: base58(signed) }` (Phantom "will not
  submit"); `signAllTransactions` `{ transactions: base58[], session }` →
  `{ transactions: base58[] }`; `disconnect` `{ session }` → no data;
  `signAndSendTransaction` is **deprecated by Phantom** ("Use
  signAllTransactions or signTransaction instead") and is accepted for
  compatibility only, mapped to `solana:signAndSendTransaction`. Reject
  responses use Phantom's codes verbatim so clients' error handling
  works: `4001` User Rejected Request, `4100` Unauthorized (bad or
  mismatched session), `-32000` Invalid Input, `-32002` Requested
  resource not available (an approval sheet is already open), `-32003`
  Transaction Rejected (undecodable tx), `-32601` Method Not Found,
  `-32603` Internal Error; `errorMessage` is a fixed string per code.
- **Subsequent methods**: open the
  box with the cached secret + `nonce`; `nacl.sign.open` the `session`
  with our public key, then check `chain`/`cluster`/`public_key` against
  a wallet we hold (Phantom's "pubkey A vs pubkey B" rule) → bound wallet;
  translate to `solana:*` `ChainRequest`s exactly as §7.4; result boxed
  into `data` on the redirect.
- **Redirect rules.** `redirect_link` must be a custom scheme **or** an
  `https` URL on the same origin as `app_url`; anything else →
  `malformed`. Custom-scheme redirects are opened with `Linking.openURL`
  in try/catch; `https` redirects are shown as a "Return to {name}"
  button (vendor: they open the browser). Payload size is capped so the
  final URL stays under 256 KB (Android `TransactionTooLarge`).
- **Sessions do not expire** in Phantom's design; ours carry `timestamp`
  and are refused after 30 days (`expired` → "Reconnect from the app to
  continue."), and are revoked from the dApp-permissions screen like any
  grant.

---

## 10. Security invariants

Each is testable; §14 names the test file.

- **S-1 No auto-execute.** No `DeepLinkIntent` of any kind results in
  `executeApproval`, a broadcast, `PermissionStore.grant`, a chain switch,
  or a trustline without an `ApprovalDecision{outcome:"approve"}` from a
  rendered sheet. `handleDeepLink`'s direct `router.push("/send")` is
  deleted.
- **S-2 Sensitive routes are unreachable by URL.** `+native-intent`
  returns only `/link-inbox`, `/dapps-browser?url=`, or an allowlisted
  read-only href; `/send`, `/payment`, `/pay-*`, `/withdraw`, `/deposit`,
  `/approvals`, `/agent-permissions`, `/gas-settings` are never returned
  for an external URL, on any scheme or host.
- **S-3 Provenance is always rendered.** Every intent created from a link
  carries the `link_provenance` annotation; `RiskBanner` renders it; an
  unverified origin is never shown as a headline.
- **S-4 Wallet isolation.** `intent.wallet` is bound per §4.7;
  `AdapterContext.activeWallet` is `null` for `via ∈ {deeplink,
  walletconnect, mwa}`; a dev assertion throws if an adapter reads it on
  that path.
- **S-5 Verified host for advertised entries.** `wallet_uri_base`, the
  WalletGuide universal link, and the Phantom-compatible base are all
  `https://takumipay.xyz/...`; custom-scheme arrivals are labelled
  "opened from a link" and never treated as identity.
- **S-6 No network on receipt.** `parse()` is pure; every fetch (Solana
  Pay GET/POST, `stellar.toml`, redirect metadata) runs after the user's
  Continue, with 10 s timeouts, ≤ 3 redirects, no wallet-identifying
  headers, and JSON body limits (64 KB).
- **S-7 Protocol signatures gate signing.** SEP-0007: missing/invalid
  signature or changed key blocks; Solana Pay: invalid existing
  signatures → `malformed`, foreign expected signer → `malicious`; WC:
  `isScam` blocks; MWA: unverifiable native caller is shown unverified
  (and, per the spec's recommendation, gets no token when the config flag
  `MWA_REQUIRE_DAL` is on).
- **S-8 Fragment denylist scoped correctly.** `FRAGMENT_DENY` runs on the
  fragment for every URL and on query keys only for `takumiwallet://` and
  `https://takumipay.xyz` routes; a SEP-0007 URI with `signature=` passes
  intake (regression test for F4).
- **S-9 Nothing presents above the lock.** `ApprovalHost` returns `null`
  and `pendingIntentsStore` is paused while `AppLockedContext` is true;
  the inbox drains only after `handleUnlocked`.
- **S-10 Replay.** Cold-start URLs are deduplicated by hash for 24 h;
  Phantom-compatible requests require a fresh `nonce` per request
  (`nacl.box` nonce reuse with the same secret is refused via a 1 000-entry
  ring); WC/MWA replay is handled by their session crypto.
- **S-11 Size and shape caps.** URL > 256 KB → `too_large`; > 3 held
  intents → oldest dropped; `msg` ≤ 300, `label`/`message` ≤ 256 display
  chars; `chain` nesting ≤ 7.
- **S-12 Push never carries intent.** `source: "push"` envelopes are
  accepted only for `kind: "navigate"` to the read-only allowlist.
- **S-13 Signing mode wins.** With signing mode on, Class A/B/C are
  rejected at intake before parsing.
- **S-14 Secrets never in URLs we open.** Outbound OS redirects carry
  either nothing (WC) or `nacl.box` ciphertext (Phantom-compatible);
  signed XDR goes over HTTPS POST, never a URL.
- **S-15 No raw error text.** Every `DeepLinkRejectCode` maps to
  hand-written copy in `services/deeplinks/copy.ts`; raw URIs are logged
  only under `__DEV__` and are redacted through `redactParams` on the
  event bus.
- **S-17 Grant isolation across transports.** No external transport can
  read or create a grant under a WebView origin key; `originKeyFor`
  (§4.9) is the only producer of external keys and every key it emits
  carries a transport prefix. Regression test: a WalletConnect proposal
  with `metadata.url` equal to a granted browser origin still renders a
  `ConnectSheet`.
- **S-18 Unverified signing needs a second factor.** A Class B or C
  intent whose `Provenance.verification` is `none`, `failed`, or WC
  `INVALID` cannot be approved without biometric/PIN, independent of the
  user's per-action-auth setting (D-15).
- **S-16 Chain-agnostic guard.** `pnpm check:chains` passes with no new
  allowlist entries; a new lint (`scripts/check-deeplink-schemes.sh`)
  fails if a scheme literal (`"ethereum:"`, `"solana:"`, `"web+stellar"`,
  `"sui:pay"`, `"wc:"`, `"solana-wallet"`) appears under `app/`, `hooks/`,
  `components/`, or `services/deeplinks/` outside `paths/` and the
  registry itself.

---

## 11. UX contract

- Interstitial is mandatory for Class A/B/C; Class D navigates directly.
- Sheet titles name the transport: "Payment request", "Signing request",
  "Connection request", followed by the verified origin or "Unverified
  app".
- First-seen origin (any transport) adds "First time connecting to
  {origin}." (SEP-0007 threat 2; mirrors the browser's existing
  first-connect note).
- After approval: Class A/B show the existing success screen
  (`/send-success`) with the explorer link; Class C shows a toast "Sent
  back to {app}." and, when a return link exists and was not auto-opened,
  a "Return to {app}" button.
- Errors: one line of friendly copy and, where actionable, one CTA
  ("Create a Solana wallet", "Ask the app for a new link"). Never the
  URI, never a status code, never `err.message`.
- No em-dashes anywhere in these strings.

### 11.1 Copy per reject code (`services/deeplinks/copy.ts`)

| Code | Title | Body | CTA |
|---|---|---|---|
| `too_large` | Link too long | This link is too long for the wallet to open. | Close |
| `fragment_blocked` | Link blocked | This link contains data the wallet will not accept. | Close |
| `malformed` | Can't read this link | The wallet couldn't understand this link. Ask the sender for a new one. | Close |
| `unsupported_scheme` | Not supported | The wallet doesn't support this kind of link yet. | Close |
| `unsupported_chain` | Network not supported | This request is for a network the wallet doesn't support yet. | Close |
| `unsupported_operation` | Not supported yet | This request asks for something the wallet can't do from a link yet. | Close |
| `not_https` | Insecure link | This request points to an insecure address, so it was not opened. | Close |
| `signature_missing` | Unsigned request | This request claims to come from {domain} but isn't signed. It was not opened. | Close |
| `signature_invalid` | Signature check failed | This request's signature doesn't match {domain}. It was not opened. | Close |
| `signing_key_changed` | Signing key changed | The signing key for {domain} has changed since you last used it. For your safety this request was not opened. | Trust the new key (biometric) / Close |
| `network_mismatch` | Wrong network | This request is for a different {Chain} network than this wallet uses. | Close |
| `wrong_account` | Account not found | This request is for an account that isn't in this wallet. | Close |
| `replayed` | Already opened | You've already opened this link. | Close |
| `signing_mode` | Signing mode is on | Links can't open payment or signing requests while signing mode is on. | Open settings |
| `expired` | Link expired | This link has expired. Ask the app for a new one. | Close |
| `no_wallet_for_namespace` | No {Chain} wallet | You don't have a {Chain} wallet yet. Create or import one to continue. | Add wallet |
| `route_not_allowed` | Can't open this | This link isn't something the wallet can open. | Close |
| (unsigned SEP-0007) | Unverified request | This request isn't signed, so the wallet can't confirm who sent it. Only continue if you trust the source. | I understand, continue / Not now |

---

## 12. Configuration changes

`app.config.ts`:
```ts
scheme: [getScheme(), "ethereum", "solana", "sui", "web+stellar", "wc"],
ios: {
  …,
  infoPlist: {
    // Only schemes we *query* with canOpenURL (none today); dApp return
    // links are opened with openURL inside try/catch, so this stays empty
    // on purpose (50-entry cap, unbounded dApp schemes).
    LSApplicationQueriesSchemes: [],
  },
},
android: {
  intentFilters: [
    { action: "VIEW", autoVerify: true, category: ["BROWSABLE","DEFAULT"],
      data: [{ scheme: "https", host: "takumipay.xyz", pathPrefix: "/" }] },   // unchanged
    // F1: comment corrected; filter retained for Android ≤ 11 only.
    { action: "VIEW", category: ["BROWSABLE","DEFAULT"], data: [{ scheme: "https" }, { scheme: "http" }] },
  ],
},
plugins: [ …, "./plugins/withSolanaMobileWalletAdapter" ],   // Android-only; adds the MWA activity + solana-wallet filters + /mobilewalletadapter autoVerify filter
```
`android.scheme` is not used for `solana-wallet` (the plugin owns it).
Expo's Android scheme plugin attaches every `scheme` entry to
`MainActivity`'s `VIEW/BROWSABLE` filter, which is what we want for the
five shared schemes.

Server side (web repo, coordinate): `/.well-known/apple-app-site-association`
adds `components` for `/pay*`, `/wc*`, `/ul/*`, `/dapp/*`, `/link/*`,
`/mobilewalletadapter*` for all three App IDs; `/.well-known/assetlinks.json`
already lists the three packages (no change unless the MWA plugin adds a
new activity — it does not change the package or cert);
`/.well-known/stellar.toml` is **not** required for us as a wallet.
Optional but recommended: a fallback web page at each path that says
"Open in TakumiPay" for users without the app (Universal Links fall
through to the web when the app is missing). Caveat to document for
integrators: iOS does **not** open the app for a Universal Link tapped
on a page that is itself on `takumipay.xyz` (same-domain navigation
stays in Safari) or typed into the address bar; links from other
domains and other apps do open it.

Deliverable outside this repo: a public **integrator guide**
(`takumipay.xyz/developers/deep-links`) listing the §5 table, the
per-chain URI formats we accept, the WalletConnect metadata, and the
Phantom-compatible base URL, so dApps and merchants can target TakumiPay
without reading this spec.

Env: `EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID` (WalletConnect Dashboard;
`.env.example` updated; EAS secrets for preview/production).

Flags (`services/deeplinks/flags.ts`, compile-time constants in the
style of `FEATURE_STELLAR_DAPP_BRIDGE` in `services/bridge/boot.ts`; a
flag flips in a release, never remotely): `FEATURE_DEEPLINK_KERNEL`
(Phase 0, on from the first release), `FEATURE_DEEPLINK_PAY_URIS` and
`FEATURE_DEEPLINK_SIGN_URIS` (Phase 1), `FEATURE_WALLETCONNECT`
(Phase 2), `FEATURE_MWA` (Phase 3, android), `FEATURE_ENCRYPTED_LINK`
(Phase 3). `MWA_REQUIRE_DAL` is a constant `true` (D-8), not a flag.
Each flag is `false` in production until the phase's exit criteria pass
on a preview build (§15); when `false`, the scheme is still registered
at the OS level so that the interstitial can say "not enabled in this
version" instead of the OS bouncing the link to another wallet silently.

---

## 13. Files

### 13.1 New

| File | Purpose |
|---|---|
| `app/+native-intent.tsx` | `redirectSystemPath` → `intake` → inbox/route (§4.2). Never throws; fallback `/link-inbox?error=1`. |
| `app/link-inbox.tsx` | Interstitial (§6.5). |
| `services/deeplinks/types.ts`, `uri.ts`, `intake.ts`, `schemeRegistry.ts`, `inbox.ts`, `ledger.ts`, `copy.ts`, `flags.ts`, `boot.ts` | Kernel. |
| `services/deeplinks/paths/{pay,wc,ul,mwa,dapp,navigate}.ts` | Universal-link path handlers. |
| `services/deeplinks/sep7KeyPins.ts` | Per-domain `URI_REQUEST_SIGNING_KEY` pins (MMKV). |
| `services/chains/evm/deeplinks.ts`, `services/chains/solana/deeplinks.ts`, `services/chains/sui/deeplinks.ts`, `services/chains/stellar/deeplinks.ts` | Scheme handlers (§6). |
| `services/chains/solana/solanaPay.ts`, `services/chains/stellar/sep7.ts`, `services/chains/sui/suiPay.ts` | Pure parsers + builders (node-testable). |
| `services/walletKit/{solana,sui,stellar}/paymentRequest.ts` | `buildPaymentRequest` implementations. |
| `services/walletKit/{evm,solana,sui,stellar}/walletConnect.ts` | `walletConnectNamespace` + `walletConnectCodec`. |
| `services/transports/types.ts` | `TransportAdapter` interface (`start`, `stop`, `pair`/`associate`, `sessions`, `disconnect`, `onRequest`). |
| `services/transports/walletconnect/{index,storage,deeplinks,codec}.ts` | §7. |
| `services/transports/mwa/{index,MwaHost.tsx,deeplinks}.ts` | §8 (android). |
| `services/transports/encryptedLink/{index,crypto,session,deeplinks}.ts` | §9. |
| `plugins/withSolanaMobileWalletAdapter.ts` | MWA activity + filters (android). |
| `index.ts` (app entry) | Registers `TakumiMwaEntrypoint` alongside the router root. |
| `components/deeplinks/ProvenanceBanner.tsx` | Renders the `link_provenance` annotation (used by `RiskBanner`). |
| `scripts/check-deeplink-schemes.sh` | S-16 lint; wired into `pnpm test` like `check:chains`. |
| `services/paymentIntent/detectors/walletConnect.ts` | `wc:` QR detector (priority 15). |

### 13.2 Modified

| File | Change |
|---|---|
| `app/_layout.tsx` | `bootBridge()` after `bootWalletKits()`; root `<ApprovalHost/>` under the lock gate; remove `useExternalDappLinking()`; drain inbox on unlock; start WalletConnect transport. |
| `app/dapps-browser.tsx` | Remove its `<ApprovalHost/>`; keep `bootBridge()` call (now a rebind). |
| `services/bridge/DappBridge.ts` | `submitExternalIntent`, `dispatchExternal`; `submitAgentIntent` delegates. |
| `services/bridge/ApprovalHost.tsx` | Lock gate; `pause/resume` on `pendingIntentsStore`. |
| `services/bridge/pendingIntents.ts` | `pause()/resume()`. |
| `services/chains/types.ts` (+ 3 `agentContext.ts` mirrors) | `Origin.via` union. |
| `services/walletKit/types.ts` | Three optional capabilities (§4.5). |
| `services/security/deeplinkGate.ts` | Scope `FRAGMENT_DENY` (F4); `inspectDeeplink` called from `intake` for our-host URLs. |
| `services/deeplinks/router.ts` | Reduced to `classifyURI` for `open-dapp`/legacy; `handleDeepLink` deleted; `parseCustomScheme` on `splitUri`. |
| `services/deeplinks/eip681.ts` | Deleted (F8). |
| `hooks/useExternalDappLinking.ts` | Deleted (folded into kernel). |
| `services/walletconnect/sessionStore.ts`, `components/walletconnect/SessionList.tsx` | Deleted; `caipMapping.ts` stays. |
| `services/paymentIntent/detectors/walletUri.ts` | Export `parseSolana`/`parseEthereum` for reuse; `source` threaded. |
| `services/paymentIntent/switchToScannedTarget.ts` | `wc` channel → inbox; `source` forwarded to `/send` params. |
| `app/send.tsx` | Render `ProvenanceBanner` when `source === "deeplink"`; no other change. |
| `app/dapp-permissions.tsx` | WalletConnect + MWA + encrypted-link sessions section. |
| `services/analytics/events.ts` | `deeplink_received {class, transport, verification, namespace}`, `deeplink_rejected {code}`, `deeplink_approved {class, transport}`. No raw URLs. |
| `app.config.ts`, `.env.example`, `pollyfills.ts` (if the canary demands) | §12. |
| `docs/production-readiness-2026-07-19.md` | Close the "inspectDeeplink not wired" residual with a pointer here. |

---

## 13.3 Task 00 — on-device gates (run before any phase lands)

Each has a pass/fail written into this file, like
`stellar-dapp-bridge-spec.md` §10.1:

| # | Gate | Why | Pass condition |
|---|---|---|---|
| 00-A | `+native-intent` fires for **warm** URLs on both OSes with expo-router 6 / SDK 54 | The whole kernel assumes it; the Expo doc example only shows `initial` | Log line from `redirectSystemPath` on a warm `takumiwallet://link/about` on Android and iOS |
| 00-B | Current App Link / Universal Link verification state | `/pay`, `/wc` are only exclusive if verification actually passes for all three package ids | `adb shell pm get-app-links com.planckify.takumiwallet` shows `verified`; iOS `swcutil`/Console shows the AASA applied |
| 00-C | `@reown/walletkit` + compat under the frozen prototype | Three prior deps broke here | `pnpm check:protofreeze` green and boot canary `N/N warmed` after `am force-stop` |
| 00-D | MWA `getCallingPackage()` under the reference manifest (`singleTask` + `taskAffinity`) | Android normally cancels results into a new task; the reference wallet relies on it anyway; unverifiable from docs | `fakedapp` → our host activity logs a non-null calling package |
| 00-E | Second React root (`TakumiMwaEntrypoint`) boots cleanly on RN 0.81 bridgeless with the main activity dead | Risk #9 | Cold `solana-wallet:` launch renders `MwaHost` with the protofreeze canary printed |

## 13.4 Task breakdown

| Task | Phase | Depends on | Deliverable |
|---|---|---|---|
| 01 | 0 | 00-A | `services/deeplinks/{types,uri,intake,schemeRegistry,inbox,ledger,copy,flags,originKey}.ts` + unit tests |
| 02 | 0 | 01 | `app/+native-intent.tsx`, pass-through list, legacy `takumiwallet://` routes |
| 03 | 0 | 01 | `app/link-inbox.tsx` interstitial + `ProvenanceBanner` |
| 04 | 0 | — | Root `bootBridge` + `ApprovalHost` under lock gate; `pendingIntentsStore.pause/resume`; browser screen rebinding |
| 05 | 0 | 04 | `DappBridge.submitExternalIntent` / `dispatchExternal`; `Origin.via`; bound-wallet stamping; S-4 assertion |
| 06 | 0 | 01 | F1 comment, F4 gate scoping, F8 parser removal, delete `useExternalDappLinking` + `handleDeepLink`; `scripts/check-deeplink-schemes.sh` |
| 07 | 1 | 02, 03 | EVM handler (`pay-`, sci-notation, ENS/function refusal) |
| 08 | 1 | 02, 05 | Solana Pay transfer + transaction request; `SolanaWalletKit.buildPaymentRequest` |
| 09 | 1 | 02, 05 | `sui:pay` parser + Payment Kit PTB builder + package constants |
| 10 | 1 | 02, 05 | SEP-0007 `pay`/`tx`, toml fetch + key pins, callback POST |
| 11 | 1 | 07–10 | `app.config.ts` schemes + `/pay?uri=` path; device matrix rows 1, 3, 4, 5 |
| 12 | 2 | 00-C, 05 | WalletKit install, encrypted storage/keychain, boot wiring |
| 13 | 2 | 12 | `walletConnectNamespace` + codec on four kits; `caipMapping` genesis-hash table |
| 14 | 2 | 12, 13 | Proposal/request/expiry handling, Verify → banner, `originKeyFor`, redirect rules |
| 15 | 2 | 14 | Sessions UI in `dapp-permissions.tsx`; delete `sessionStore.ts`/`SessionList.tsx`; `wc:` QR detector |
| 16 | 2 | 14 | Dashboard projects, WalletGuide submission, AASA/assetlinks updates, integrator guide |
| 17 | 3 | 00-D, 00-E | MWA config plugin, second root, `MwaHost`, DAL verification, scope store |
| 18 | 3 | 05 | Phantom-compatible transport (keys, sessions, methods, redirects) |
| 19 | 2b | 14 | One-Click Auth + Link Mode |

## 14. Testing

Unit (node:test through `scripts/run-node-tests.sh`, pure modules):
- `services/deeplinks/uri.test.ts` — `splitUri` on every example URI in
  §2 verbatim (ERC-681 examples, both Solana Pay examples, SEP-0007
  examples 1–2 for `tx` and `pay` including the signed example, the
  Mysten `sui:pay` example, the WC pairing URI example).
- `services/chains/stellar/sep7.test.ts` — signature verification against
  the SEP's worked example (private key `SBPOVR…`, signature `tbsLtlK…`);
  tamper one byte → `signature_invalid`; missing signature with
  `origin_domain` → `signature_missing`; `replace` balanced/unbalanced;
  `network_passphrase` mismatch; `chain` depth 8 → `malformed`.
- `services/chains/solana/solanaPay.test.ts` — amount decimal rules
  (`0`, `.5` rejected, `1e9` rejected, 10 decimals rejected), `reference`
  length, instruction ordering (memo second-to-last, transfer last,
  reference keys read-only non-signer in order), tx-request validation
  matrix (empty vs present signatures; foreign signer → `malicious`).
- `services/chains/sui/suiPay.test.ts` — mirrors Mysten `uri.test.ts`
  cases.
- `services/chains/evm/deeplinks.test.ts` — `pay-` prefix, scientific
  notation, ENS refusal, unknown function refusal, chain row check.
- `services/deeplinks/intake.test.ts` — S-8 (SEP-7 `signature=` passes;
  `#seed=` blocked), S-11 caps, S-12 push, S-13 signing mode, S-10 ledger.
- `services/deeplinks/schemeRegistry.test.ts` — priority ordering,
  platform filtering, unknown scheme → `unsupported_scheme`, and a
  **negative docking test**: a fake namespace registered at runtime is
  routed with zero kernel changes.
- `services/transports/walletconnect/codec.test.ts` — every row of the
  §7.4 table round-trips; unapproved chain → 4901.
- `services/transports/encryptedLink/crypto.test.ts` — box/open
  round-trip against `tweetnacl` vectors; session sign/open; nonce reuse
  refused.
- `services/security/deeplinkGate.test.ts` — extended for F4.

Vitest (RN-stubbed, add to `vitest.config.ts` include list):
- `app/+native-intent.test.tsx` — returns only allowlisted hrefs (S-2),
  never throws on garbage input.
- `services/bridge/DappBridge.external.test.ts` — `submitExternalIntent`
  stamps provenance; `dispatchExternal` skips WebView-only checks;
  `activeWallet === null` assertion (S-4).
- `services/bridge/ApprovalHost.lock.test.tsx` — S-9.

Guards: `pnpm check:chains`, `scripts/check-deeplink-schemes.sh`,
`pnpm check:protofreeze` (after adding WalletConnect and walletlib), and
the existing registry-parity tests.

Device matrix (manual, both variants, **after `adb shell am force-stop`**
on Android and a fresh install on iOS):
- Cold start from each scheme + from the universal link for each path in
  §5; warm start; recents replay; locked app; signing mode on.
- WalletConnect: `https://appkit-lab.reown.com/library/wagmi/` and
  `/library/solana/` via "Custom Wallet" (vendor's test harness);
  `react-app.walletconnect.com`; the vendor's malicious demo app
  (`isScam`) must show a blocked sheet.
- Solana Pay: a transfer QR and a transaction-request QR from the
  reference point-of-sale; verify `reference` shows up in
  `getSignaturesForAddress`.
- SEP-0007: the SEP's worked signed `pay` example (fails on toml fetch for
  `someDomain.com`, which is the expected block), plus a self-hosted
  `origin_domain` with a real `stellar.toml` on testnet; a `tx` with
  `callback` against a local echo server.
- `sui:pay`: a URI generated with Mysten `createPaymentTransactionUri` on
  testnet; confirm `getPaymentRecord` resolves.
- MWA (Android, preview build): `fakedapp` from the MWA repo (native,
  DAL-verified) and a mobile-web dApp (unverified path).
- Phantom-compatible: `phantom-labs/deep-link-demo-app` with the base URL
  swapped to `https://takumipay.xyz/ul`.

---

## 15. Rollout

| Phase | Scope | Flag | Exit criteria |
|---|---|---|---|
| **0 — Hardening** | Kernel, `+native-intent`, interstitial, root spine + lock gate, F1–F8, ledger, analytics, remove dead code. No new schemes registered. | `FEATURE_DEEPLINK_KERNEL` | S-1/2/3/8/9/10/12/13 tests green; `/send?recipientAddress=` via URL lands on the inbox, not the form. |
| **1 — Pay + sign URIs** | ERC-681 deltas, Solana Pay (transfer + tx request), `sui:pay`, SEP-0007 (`pay` + `tx`), `/pay?uri=`, OS scheme registration, WalletGuide-independent. | `FEATURE_DEEPLINK_PAY_URIS`, `FEATURE_DEEPLINK_SIGN_URIS` | Device matrix rows 1, 3, 4, 5 pass on both OSes. |
| **2 — WalletConnect v2** | WalletKit across four namespaces, encrypted storage, Verify, sessions UI, Dashboard project + WalletGuide submission. | `FEATURE_WALLETCONNECT` | AppKit lab EVM + Solana connect/sign/redirect on both OSes; protofreeze canary clean. |
| **2b — Link Mode (EVM)** | One-Click Auth + `linkMode`. | same | Measured latency win on the lab dApp. |
| **3 — Solana native transports** | MWA (android, dedicated activity) + Phantom-compatible `/ul/v1`. | `FEATURE_MWA`, `FEATURE_ENCRYPTED_LINK` | `fakedapp` DAL-verified authorize; demo app connect/sign on iOS; MWA production flip additionally needs D-1's review-or-status change plus 30 days preview soak. |
| **3b — MWA web attestation** | Wallet-hosted attestation script on `takumipay.xyz`; web dApps that attest get verified keys. | `FEATURE_MWA` + `MWA_ORIGIN_ATTESTATION` | A mobile-web dApp that opts in authorizes with `verification: origin-attestation`. |
| **4 — Future** | §16. | — | — |

Each phase is one PR series; flags default off in production until the
phase's exit criteria are met on a preview build. The Play Store build
currently predates Stellar (`project_playstore_build_predates_stellar`);
Stellar deep links ship dark until that build is superseded.

---

## 16. Decisions (all former open questions closed 2026-09-11)

Closed in favour of production readiness and wallet-security best
practice. Where a decision trades convenience for safety, the safer
option wins and the convenience is listed as future work.

| # | Question | Decision | Where it lands |
|---|---|---|---|
| D-1 | MWA walletlib is "alpha and not production ready" | Ship Phase 3 with `FEATURE_MWA = false` in production binaries; enable in preview first; production flip requires (a) the README status changing **or** an internal review of the walletlib native module signed off by the security team, and (b) 30 days of preview soak with zero MWA crashes in PostHog. MWA runs in its own activity + React root, so its blast radius is bounded to that flow. | §8.3, §15 |
| D-2 | Frozen-prototype crash from new deps | Merge gate: `pnpm check:protofreeze` + boot canary after `am force-stop`, on both the main root and the MWA root (00-C, 00-E). | §7.1, §13.3 |
| D-3 | `@mysten/payment-kit` peer range | Hand-roll the `sui:pay` parser and Move calls from pinned package ids (§6.3); a test re-derives the default registry id so drift is caught. Revisit only when `@mysten/sui` is bumped for other reasons. | §6.3 |
| D-4 | Contended custom schemes on iOS | Cannot be fixed by us. Custom-scheme arrivals are labelled and never treated as identity (S-5); the integrator guide leads with the universal-link forms. Class B via custom scheme additionally shows the "opened from an unverified link" line on the sheet. | §5, §12 |
| D-5 | SEP-0007 threat 6 (default-handler theft) | Not faithfully implementable on either OS; no fake alert. Mitigation is structural: the sheet always shows provenance, so a hijacking wallet cannot make *our* UI lie, and our universal link is the advertised entry. Logged as a known gap in the integrator guide. | §6.4 |
| D-6 | ENS names in ERC-681 | Refused in v1 with copy (`unsupported_operation`). Future work needs a mainnet resolver and a "resolved from a name" warning. | §6.1 |
| D-7 | Push-delivered WalletConnect requests (Notify/Echo) | Not in scope and not enabled. A push may only open the read-only inbox; any dApp request still requires the user to foreground the app. Requires a signed-push design first (TWV-2026-054). | §4.8, S-12 |
| D-8 | MWA identity policy | Native callers must pass Digital Asset Links or get `ERROR_AUTHORIZATION_FAILED` (spec recommendation); browser launches allowed as unverified unless they opt into Phase 3b origin attestation (`MWA_ORIGIN_ATTESTATION`). | §8.2, §18 |
| D-9 | Second React root on RN 0.81 bridgeless | Gated by 00-E; if it fails, MWA hosting falls back to `MainActivity` with `getCallingPackage()` unavailable, which under D-8 means native dApps are declined and only browser dApps work until the root issue is fixed. | §13.3 |
| D-10 | QR scans through the interstitial? | Class A from QR stays direct `/send` with a provenance banner; Class B always goes through the interstitial (it is the consent gate for network fetches); Class C goes straight to the sheet. | §6.5 |
| D-11 | WalletConnect Dashboard / WalletGuide ownership | The security team owns the WalletConnect Dashboard organisation under the same vault conventions as `docs/ops_credential_provisioning.md` (role-based access, no personal accounts). Two projects: production (App ID-locked, domain-verified, WalletGuide-submitted) and dev/preview (locked to the `.dev`/`.preview` ids, never submitted). WalletGuide metadata: name "TakumiPay", homepage `https://takumipay.xyz`, chains = every family the registry advertises, native link `takumiwallet://`, universal link `https://takumipay.xyz/wc`. Project IDs go into EAS env per profile. | §7.0, §12 |
| D-12 | `EvmAdapter` unconnected-origin fallback | Closed at the source for non-WebView origins (returns disconnected); assertion kept as tripwire. | §4.6 |
| D-13 | Attacker-supplied text (`label`, `message`, `msg`) | Rendered in a separate "from the link" block, length-capped, homograph-checked, never used as the counterparty label. | §6.2, §6.4, §11 |
| D-14 | WalletConnect Verify tiers | `isScam`/flagged → hard block; `INVALID` → blocked with biometric-gated override; `UNKNOWN` → allowed with banner; applies to proposals and requests. | §7.3 |
| D-15 | Per-action authentication for external transports | External intents inherit `requiresPerActionAuth` exactly like WebView intents; in addition, any Class B/C signing intent whose provenance is `none`, `failed`, or `INVALID` requires biometric/PIN even when the user has per-action auth off. Class A is unchanged (the send flow's own auth applies). | §10 (S-18) |
| D-16 | Session and grant lifetimes | WalletConnect: relay default (7 days), extended on each successful request, revoked on `session_delete`; MWA scopes 30 days, rotated on `reauthorize`; Phantom-compatible sessions 30 days despite the vendor's "never expire"; SEP-0007 signing-key pins never expire but a changed key blocks (§6.4). All are visible and revocable in `dapp-permissions.tsx`. | §7.5, §8.2, §9 |
| D-17 | Storage class for transport state | Encrypted MMKV for WalletConnect storage + keychain, MWA scopes, encrypted-link shared secrets and sessions; SecureStore for the x25519 and session-signing keypairs and the MMKV encryption key. Nothing transport-related in AsyncStorage. | §7.2, §9 |
| D-18 | Custom-scheme Class B on iOS | Allowed (the ecosystems require it) but the sheet shows "Opened from an unverified link" and D-15's auth rule applies. | §6.5 |

### Residual risks (accepted, tracked)

- MWA library maturity (D-1) and the second-root architecture (D-9) are
  the two items most likely to move Phase 3's date.
- The Phantom-compatible transport has no identity verification by
  design (no verifier exists in that protocol); it is the only iOS path
  for native Solana dApps besides WalletConnect, so it ships with the
  unverified banner rather than not at all.
- SEP-0007 threat 6 and the iOS scheme-winner problem (D-4, D-5) are
  platform limits shared by every wallet.

## 17. Sources (fetched during this session)

Protocol:
- MWA 2.0 spec: https://raw.githubusercontent.com/solana-mobile/mobile-wallet-adapter/main/spec/spec.md
- MWA RN walletlib README + `package.json` (1.4.5, alpha, Android-only), reference manifests (`android/fakewallet`, `examples/example-react-native-wallet`), `SolanaMobileWalletAdapterWalletLibModule.kt`, `SolanaMobileDigitalAssetLinksModule.kt`: https://github.com/solana-mobile/mobile-wallet-adapter
- Solana Pay spec: https://raw.githubusercontent.com/anza-xyz/solana-pay/main/typescript/packages/solana-pay/spec/SPEC.md
- SEP-0007 v2.1.0: https://raw.githubusercontent.com/stellar/stellar-protocol/master/ecosystem/sep-0007.md
- ERC-681: https://raw.githubusercontent.com/ethereum/ERCs/master/ERCS/erc-681.md ; ERC-831: https://raw.githubusercontent.com/ethereum/ERCs/master/ERCS/erc-831.md
- WalletConnect pairing URI: https://github.com/WalletConnect/walletconnect-specs/blob/main/docs/specs/clients/core/pairing/pairing-uri.md
- WalletConnect wallet docs (RN installation, usage, mobile linking, link mode, verify, best practices, chains: solana / sui / stellar): https://docs.walletconnect.com/llms.txt and the `wallets/react-native/*.md`, `wallets/chains/*.md` pages it indexes
- Reown docs migration note + AppKit RN Link Mode page (EVM-only statement): https://github.com/reown-com/reown-docs (`advanced/walletkit-migration.mdx`, `appkit/react-native/core/link-mode.mdx`)
- AppKit `CoreHelperUtil.formatNativeUrl` / `formatUniversalUrl` (`wc?uri=` convention): https://raw.githubusercontent.com/reown-com/appkit/main/packages/controllers/src/utils/CoreHelperUtil.ts
- WalletConnect `CoreTypes.Options` (`storage`, `keychain`): https://raw.githubusercontent.com/WalletConnect/walletconnect-monorepo/v2.0/packages/types/src/core/core.ts
- Phantom deep links (overview, connect, signMessage, handling sessions, encryption, redirects, limitations): https://docs.phantom.com/llms.txt and the `phantom-deeplinks/*` pages
- CAIP-2 namespaces (Solana genesis-hash refs, Sui `sui:<network>`): https://github.com/ChainAgnostic/namespaces/blob/main/solana/caip2.md , https://github.com/ChainAgnostic/namespaces/blob/main/sui/caip2.md
- WalletConnect `session_proposal`/`session_request` event shapes (`verifyContext`, `expiryTimestamp`, `session_request_expire`): https://raw.githubusercontent.com/WalletConnect/walletconnect-monorepo/v2.0/packages/types/src/sign-client/client.ts
- Phantom method pages (signTransaction, signAllTransactions, disconnect, signAndSendTransaction deprecation) and error codes: https://docs.phantom.com/phantom-deeplinks/provider-methods/* , https://docs.phantom.com/solana/errors
- Mysten Payment Kit URI + constants + transactions + `calls.ts` + `contracts/payment_kit/payment_kit.ts` + `utils.ts` (Move targets, arg types, registry-id derivation): https://github.com/MystenLabs/ts-sdks/tree/main/packages/payment-kit/src ; Slush deep-link route reference: `packages/docs/content/slush-wallet/deep-linking.mdx` in the same repo; https://docs.sui.io/onchain-finance/asset-custody/wallets/slush

Platform:
- Android 12 web-intent resolution: https://developer.android.com/about/versions/12/behavior-changes-all (Web intent resolution)
- Android App Links verification + `pm get-app-links` / `verify-app-links`: https://developer.android.com/training/app-links/verify-android-applinks
- Expo Router `+native-intent` / `redirectSystemPath`: https://raw.githubusercontent.com/expo/expo/main/docs/pages/router/advanced/native-intent.mdx
- Expo config `scheme` / `intentFilters` behaviour: `node_modules/@expo/config-types/build/ExpoConfig.d.ts`, `@expo/config-plugins/build/{android,ios}/Scheme.js`, `android/IntentFilters.js` (installed versions)
- Apple: Defining a custom URL scheme (undefined winner for duplicate schemes), Supporting associated domains, TN3155 Debugging Universal Links — https://developer.apple.com/documentation/xcode/defining-a-custom-url-scheme-for-your-app , https://developer.apple.com/documentation/xcode/supporting-associated-domains , https://developer.apple.com/documentation/technotes/tn3155-debugging-universal-links

In-repo (read this session): `app.config.ts`, `app/_layout.tsx`,
`app/send.tsx`, `app/scan-to-pay.tsx`, `app/approvals.tsx`,
`hooks/useExternalDappLinking.ts`, `services/deeplinks/*`,
`services/security/{deeplinkGate,signingMode,scamDomainFeed,idnHomograph,appLock}.ts`,
`services/paymentIntent/*`, `services/walletconnect/*`,
`services/bridge/{DappBridge,ApprovalHost,approval,boot,inspector,renderers,pendingIntents}.ts(x)`,
`services/chains/types.ts`, `services/chains/*/{EvmAdapter,SolanaAdapter,SuiAdapter,StellarAdapter}.ts`,
`services/walletKit/{types,chainInfo}.ts`, `services/walletPresence/index.ts`,
`services/permissions/{store,caip}.ts`, `components/dapps-browser/approvals/*`,
`docs/production-readiness-2026-07-19.md`, `docs/wallet-security-vulnerabilities-spec.md`,
`docs/solana-adapter-spec.md`, `docs/dapp-bridge-spec.md`, `package.json`.


## 18. Implementation notes (2026-09-11)

What landed, and where it deviates from the text above. Every deviation
is a narrowing toward the safer reading; nothing widened.

- **Kernel** (`services/deeplinks/`): `types`, `uri`, `intake`,
  `schemeRegistry`, `inbox`, `ledger`, `copy`, `flags`, `originKey`,
  `binding`, `chainResolve`, `execute`, `safeFetch`, `notices`,
  `sep7KeyPins`, `paths/*`, `boot`. `+native-intent` is a five-line
  adapter over `intake()`; the pass-through list is a constant with a
  test. Two extra reject codes exist beyond §11.1: `recipient_invalid`
  (Solana Pay "This address can't receive a payment.") and
  `insufficient_asset` (SEP-0007 `pay` for an asset the wallet does not
  hold).
- **Chain-row checks in `parse()`** use the on-device `/blockchains`
  cache through the kit registry (`chainResolve.ts`), so `parse()` stays
  pure. With no cached rows the check is deferred to `build()`
  ("cannot verify" ≠ "unsupported").
- **Amount-less Class A** (Solana Pay without `amount`, SEP-0007 `pay`
  without `amount`) routes to the send screen with the recipient
  prefilled: the send screen *is* the amount prompt the specs ask for.
- **Class A on non-EVM chains** (Solana Pay transfer, `sui:pay`, SEP-0007
  `pay` with amount) executes through the chain's own approval sheet via
  `kit.buildPaymentRequest`, never through `/send`; EVM has no builder
  and keeps `/send` + `ProvenanceBanner`.
- **`Origin` gained `displayUrl`.** `origin.url` is the permission key
  (transport-prefixed for every external transport, §4.9); `displayUrl`
  is the peer's human string. `services/permissions/caip.ts#originKey`
  no longer uses `new URL` (the RN shim reads every non-http host as
  empty, which would have collapsed all WalletConnect grants into one
  bucket on device while passing under Node).
- **D-12** is implemented in `EvmAdapter.scopeCtxToOrigin` /
  `pickEvmWalletForOrigin` (`allowFallback` only for WebView/agent
  origins). `DappBridge.dispatchExternal` forces `ctx.activeWallet = null`
  and `handleDecision` does the same for external intents.
- **`submitAgentIntent`'s promise never settled before** (its in-flight
  entry was only ever posted into a WebView). `InFlight.channel`
  distinguishes WebView from external entries; both agent and external
  promises now settle.
- **WalletConnect**: proposals are answered by dispatching each kit's own
  `connectRequest` (`eth_requestAccounts`, `standard:connect`,
  `REQUEST_ACCESS`) through the bridge, so the grant lands under the
  transport origin key exactly as a WebView connect would. Solana chains
  are advertised in the genesis-hash CAIP-2 form (`caipMapping.ts`).
  Sessions live in encrypted MMKV `wc.v1` (`storage.ts`); the four new
  prototype-freeze offenders the SDK pulls (`uint8arrays`,
  `multiformats`, `es-toolkit`, a third `ox` copy under
  `@metamask/smart-accounts-kit`) are pre-loaded in `pollyfills.ts`.
- **MWA**: `plugins/withSolanaMobileWalletAdapter.js` generates
  `MobileWalletAdapterActivity.kt` + theme + manifest entries;
  `index.js` registers `TakumiMwaEntrypoint`; the root is
  `services/transports/mwa/MwaEntrypoint.tsx`. D-8 is enforced in
  `mwaTransport.authorize` (`MWA_REQUIRE_DAL` constant).
- **Phantom-compatible**: `nacl.box` / `nacl.sign` semantics on
  `@noble/*` (`crypto.ts`, round-trip tested); sessions expire after 30
  days; redirect rules per §9.
- **S-18** holds structurally: every sheet's approve path is
  biometric-gated by `useBiometricApproval`, and `ConnectSheet` adds
  `provenanceRequiresStrongAuth` for external peers plus the D-14
  acknowledgement for `INVALID`.
- **Phase 2b (2026-09-12)**: `session_authenticate` (One-Click Auth,
  SIWE / CAIP-122) is handled in `walletConnectTransport.onAuthenticate`:
  `populateAuthPayload` narrows the request to the EVM chains/methods we
  offer, the adapter's own connect request binds the wallet under the
  transport origin key, one `personal_sign` sheet per requested chain
  produces the cacaos, `approveSessionAuthenticate` creates the session.
  Link Mode: `redirect.linkMode` is emitted only when
  `FEATURE_WALLETCONNECT_LINK_MODE` is on; the SDK then registers its own
  `Linking` listener for `…/wc?wc_ev=…&topic=…` envelopes, and the kernel
  routes such URLs through the interstitial invisibly
  (`paths/wc.ts` → `pair{linkMode:true}` → auto-continue). Flipping the
  flag additionally needs `https://takumipay.xyz/wc` registered in the
  Dashboard (D-11) and the latency measurement §15 asks for.
- **Phase 3b (2026-09-12) is built in-house because
  `@solana-mobile/mobile-wallet-adapter-walletlib` 1.4.5 has no
  attestation surface** (no `-100` emission, no `attest_origin`, no
  session-secret accessor; verified in the Java, Kotlin and TS sources).
  Pieces: (1) `native/mwa-walletlib/`, a vendored fork of upstream
  `android/{common,walletlib}` v2.0.2 (Apache-2.0) that parses
  `attest_origin`, raises `ERROR_ATTEST_ORIGIN_ANDROID` with
  `{context, challenge, attest_origin_uri}`, and derives the binding
  `session_secret` (HKDF of the ECDH secret with `info =
  "mwa-attest-origin"`, since the spec leaves it undefined); the config
  plugin includes it as `:mwa-walletlib` and substitutes the published
  Maven coordinates with it. (2) `patches/@solana-mobile__mobile-wallet-adapter-walletlib@1.4.5.patch`
  (pnpm) adds `attestOrigin` to `AuthorizeDappRequest`,
  `MWARequestFailReason.AttestOriginRequired`, and
  `computeAttestOriginBinding(request, challenge)`. (3) Wallet side:
  `services/transports/mwa/attestation.ts` (key provisioning through
  `expo-web-browser` to `https://takumipay.xyz/mwa/attest?m=provision`
  with a nonce-bound return on the MWA activity's private
  `<app scheme>-mwa://attest/return` scheme, challenge issue/take,
  per-session attested cache) and `attestationToken.ts` (pure ES256
  compact-JWS verification, tested); `mwaTransport.authorize` challenges
  browser launches (`callingPackage == null`) and verifies the retry.
  (4) Web side, landing-page repo: `public/mwa/attest.html` served at
  `/mwa/attest` with `frame-ancestors *` (provisioning + iframe signing
  of `{ origin: event.origin, h, context }`). (5) dApp-client patch and
  the upstream proposal (session-secret definition, `solana:attestOrigin`
  opt-in feature, iframe reply format) in
  `docs/upstream/mwa-origin-attestation/`. Flag
  `MWA_ORIGIN_ATTESTATION = "opt-in"`: only dApps listing
  `solana:attestOrigin` in `features` are challenged, so unpatched
  clients keep today's unverified path. Known limitation, inherent to
  the spec's design: third-party storage partitioning hides the
  provisioned key from the dApp's iframe until the Storage Access API is
  granted (one tap inside the frame on first use per dApp); see the
  README there. Not device-verified: the fork compiles under `javac`,
  the patch applies, but the Gradle substitution, `-100` round trip and
  Custom Tab return still need the preview build (Task 00 gates).
- **Preview-build findings (2026-09-12, first device pass)**, each with
  the fix that landed:
  1. *"Not supported yet" after a WalletConnect connect.* PostHog showed
     `deeplink_rejected{unsupported_operation}` three seconds after every
     pairing and before every signing approval. Cause: the sign-client's
     request redirect (`<WALLETCONNECT_DEEPLINK_CHOICE.href>/wc?requestId=&sessionTopic=`)
     where RainbowKit stores `href` as the raw pairing URI cut at `?`, so
     the wallet received `wc:<topic>@2/wc?requestId=…` and read it as a
     pairing URI with version `2/wc`. The kernel now classifies every
     carrier of `requestId`+`sessionTopic` (our scheme, our universal
     link, a formatted redirect, the bare `wc:` head) as a `wake` intent:
     no inbox, no ledger, `walletConnectTransport.wake()` (start + relay
     reconnect), `redirectSystemPath` returns `""`.
  2. *In-app browser flows treated as external.* A page navigating to
     `wc:`/`ethereum:`/our link left the WebView through the OS and came
     back as a warm OS link (Android wallet chooser, later "return to
     caller"). `onShouldStartLoadWithRequest` now feeds kernel links to
     `intakeFromWebView` (`source: "internal"`); MWA's `solana-wallet:`
     stays OS-owned (`osOwned` on the handler).
  3. *Connection sheet said "Not connected" for a WalletConnect-connected
     site.* Transport grants are keyed `wc+https://<host>#<topic>`, never
     the WebView origin. `useDappConnections` now joins transport sessions
     to the open site by peer URL, labels the rows with the transport,
     and disconnects them through the transport.
  4. *No return to the browser after approving.* Web dApps carry no
     `redirect` metadata. `services/deeplinks/returnToCaller.ts`: the
     dApp's `redirect.native` when present, else Android
     `moveTaskToBack` (`modules/app-minimizer`, the same primitive
     MetaMask and Rainbow use), else an iOS "Return to {app}" notice.
     Applied to deep-link pairings (approve and decline) and to requests
     the dApp deep-linked us for (`wakeTopics`).
  5. *Requests did not bring the wallet up.* A dApp that has no deep link
     for us (not in WalletGuide, or paired through the generic `wc:`
     chooser) cannot; the request still lands over the relay. The
     transport now posts a local notification ("{app} is waiting for
     you") when a request arrives while the app is not active, and kicks
     `relayer.restartTransport()` on foreground. The complete fix is the
     WalletGuide listing (§18 ops) or Link Mode.
- **Integrator guide** lives in-repo as
  `docs/deeplink-integrator-guide.md` (source for
  `takumipay.xyz/developers/deep-links`) and carries the AASA
  `components` / `assetlinks.json` statements the web host must serve.
- **Still outside this repo**: WalletGuide submission and the Dashboard
  App-ID lock (ops, D-11); publishing the guide and the well-known files
  (web repo); ENS in ERC-681 (D-6).
