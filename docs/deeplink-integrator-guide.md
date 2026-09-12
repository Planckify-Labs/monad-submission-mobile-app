# TakumiPay deep-link integrator guide

**Status:** source for the public page `takumipay.xyz/developers/deep-links`
(deep-link spec §12, task 16). Everything here is what the wallet
*accepts*; the wallet never emits links to other wallets. Companion:
`docs/deeplink-wallet-interactions-spec.md`.

Two rules apply to every link in this document:

1. **Nothing executes without a sheet.** Every link opens a preview
   (the interstitial or the chain's approval sheet) that names the
   sender as well as the wallet can verify it. There is no auto-sign,
   auto-broadcast, auto-connect or auto-switch, on any transport.
2. **Prefer the universal link.** Custom schemes (`ethereum:`,
   `solana:`, `sui:`, `web+stellar:`, `wc:`, `takumiwallet:`) are
   contended on both platforms; on iOS the winner is undefined. The
   `https://takumipay.xyz/...` forms are verified (App Links / Universal
   Links) and reach only TakumiPay. They carry the chain's own URI
   unchanged, so nothing about your payload is TakumiPay-specific.

## 1. Entry points

| Purpose | Universal / App Link (exclusive) | Custom scheme (contended, accepted) |
|---|---|---|
| Any chain payment / signing URI | `https://takumipay.xyz/pay?uri=<encodeURIComponent(chain URI)>` | the chain's own scheme directly |
| WalletConnect pairing | `https://takumipay.xyz/wc?uri=<encodeURIComponent(wc URI)>` | `takumiwallet://wc?uri=<encoded>`, bare `wc:…` |
| Solana Mobile Wallet Adapter (Android) | `https://takumipay.xyz/mobilewalletadapter/v1/associate/local?…` (returned as `wallet_uri_base`) | `solana-wallet:/v1/associate/local?…` |
| Phantom-compatible encrypted links (Solana) | `https://takumipay.xyz/ul/v1/<method>` | `takumiwallet://ul/v1/<method>` (not recommended) |
| Open a page in the in-app browser | `https://takumipay.xyz/dapp/<url>` or `/dapp?url=<encoded>` | `takumiwallet://dapp?url=<encoded>` |
| Read-only screens | `https://takumipay.xyz/link/<wallet\|activities\|notification\|dapp-permissions\|about>` | `takumiwallet://link/<same>` |

Dev / preview builds use `takumiwallet-dev://` / `takumiwallet-preview://`
and the same host + paths.

Anything else on `takumipay.xyz` (including every in-app screen route)
is refused with "This link isn't something the wallet can open." Links
larger than 256 KB are refused. Links whose fragment contains
seed-shaped material (`seed`, `mnemonic`, `privatekey`, `pk`,
`signature`) are refused; on the chain schemes, query parameters are
validated by the protocol handler instead (SEP-0007 `signature=` is
fine).

## 2. Payment URIs (Class A)

### EVM: ERC-681 / ERC-831 (`ethereum:`)

Accepted: `ethereum:[pay-]<0x address>[@<decimal chainId>][/transfer]?<params>`

- `value=` in **wei**; scientific notation (`2.014e18`) accepted and
  expanded; a non-integer result is refused.
- ERC-20: `ethereum:<token>/transfer?address=<recipient>&uint256=<atomic amount>`.
- `@chainId` must be a network TakumiPay offers, else "Network not
  supported".
- `gas`, `gasLimit`, `gasPrice` are ignored (suggestions per the ERC).
- **Refused:** ENS names as target, any function other than `transfer`,
  the bare `eth:` alias, any `<prefix>-` other than `pay-`.
- The amount is a suggestion: the user lands on the send screen with the
  recipient and amount prefilled and can change both.

### Solana: Solana Pay (`solana:`)

Transfer request `solana:<recipient>?amount&spl-token&reference&label&message&memo`:

- `recipient` is a native SOL account (system-owned, not executable);
  associated token accounts are refused.
- `amount` in user units, decimal string, leading `0`, no exponent;
  SOL > 9 decimals refused; SPL decimals checked against the mint.
  Missing `amount` prefills the send screen for the user to enter it.
- `spl-token`: the recipient's associated token account must already
  exist (no auxiliary accounts, none created).
- `reference` (repeatable, base58 32 bytes each) is appended to the
  transfer instruction as read-only non-signer keys in URL order; `memo`
  becomes an SPL Memo instruction second to last; the transfer is last.
- `label` / `message` are shown in a separate "from the link" block.
- `cluster=devnet` is accepted as a wallet-side extension.

Transaction request `solana:<https link>` (`link` may be URL-encoded):

- `GET` for `{label, icon}` (icon must be SVG/PNG/WebP; a failed GET is
  non-fatal), then `POST {"account": "<pubkey>"}` for `{transaction, message}`.
- The transaction is treated as untrusted: unsigned → fee payer and
  blockhash are set by the wallet; partially signed → every signature is
  verified and any expected signer other than the account is refused as
  malicious; size ≤ 1232 bytes.
- `http:` links are refused.

### Sui: Mysten Payment Kit (`sui:pay?…`)

`sui:pay?receiver=&amount=&coinType=&nonce=[&registry=][&label=][&message=][&iconUrl=]`
exactly as `@mysten/payment-kit`'s `createPaymentTransactionUri`
produces it. `amount` is in the coin's smallest unit and must be > 0;
`nonce` ≤ 36 chars; `registry` is an object id or a registry name
(resolved through the Payment Kit namespace). The wallet calls
`payment_kit::process_ephemeral_payment` / `process_registry_payment`
on the pinned mainnet / testnet package, so `getPaymentRecord` resolves
on your side. Devnet has no Payment Kit deployment.

### Stellar: SEP-0007 `pay`

`web+stellar:pay?destination=&amount=&asset_code=&asset_issuer=&memo=&memo_type=&callback=&msg=&network_passphrase=&origin_domain=&signature=`

- `destination` must be a `G…` account id; federated `name*domain` and
  `M…` muxed accounts are not supported.
- For a non-native asset the wallet must already hold a trustline with
  enough balance; path payments are not built.
- Missing `amount` prefills the send screen. Otherwise the payment is
  built and shown on the Stellar transaction sheet.
- `callback=url:<https>` → the signed envelope is POSTed as
  `xdr=<urlencoded>` (`application/x-www-form-urlencoded`), query
  parameters preserved; no callback → signed **and submitted**.

## 3. Signing URIs (Class B)

### Stellar: SEP-0007 `tx`

`web+stellar:tx?xdr=&replace=&callback=&pubkey=&chain=&msg=&network_passphrase=&origin_domain=&signature=`

- `xdr` is a base64 `TransactionEnvelope` (v0, v1, fee-bump accepted).
- `replace` (Txrep) supports `sourceAccount` and
  `operations[n].sourceAccount` in this version; other fields are
  refused with copy. Reference identifiers must be balanced.
- `pubkey` pins the signing account; a key the wallet does not hold is
  refused.
- `chain` nesting deeper than 7 is refused. `msg` is capped at 300 chars
  and shown in a distinct font.

### Request signing (both SEP-0007 operations)

Follow the SEP exactly: `origin_domain` + `signature` (last parameter),
`URI_REQUEST_SIGNING_KEY` in `https://<origin_domain>/.well-known/stellar.toml`.
Wallet behaviour:

- `origin_domain` without `signature` → refused ("Unsigned request").
- toml missing, key missing, or signature invalid → refused.
- The signing key is pinned per domain the first time it verifies; a
  changed key blocks until the user explicitly trusts the new one.
- Neither parameter → allowed, but shown as "Unverified request" with an
  extra confirmation step. Sign your requests.

## 4. WalletConnect v2 (all four namespaces)

- Native link `takumiwallet://`, universal link `https://takumipay.xyz/wc`.
  AppKit opens `<link>/wc?uri=<encodeURIComponent(wcUri)>`; bare `wc:`
  URIs are also accepted.
- Namespaces / methods offered:
  - `eip155` (every network TakumiPay offers): the standard EIP-1193
    read + signing set (`personal_sign`, `eth_signTypedData(_v3|_v4)`,
    `eth_sendTransaction`, `wallet_switchEthereumChain`,
    `wallet_addEthereumChain`, `wallet_watchAsset`, `wallet_sendCalls`
    family, permissions family, reads). **Not offered:** `eth_sign`,
    `eth_signTransaction`, `eth_sendRawTransaction`.
  - `solana` (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`,
    `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`): `solana_signMessage`,
    `solana_signTransaction` (base64 `transaction` form only),
    `solana_signAllTransactions`, `solana_signAndSendTransaction`,
    `solana_getAccounts`, `solana_requestAccounts`.
  - `sui` (`sui:mainnet`, `sui:testnet`): `sui_signTransaction`,
    `sui_signAndExecuteTransaction`, `sui_signPersonalMessage`,
    `sui_getAccounts` (also in `sessionProperties.sui_getAccounts`).
  - `stellar` (`stellar:pubnet`, `stellar:testnet`): `stellar_signXDR`,
    `stellar_signAndSubmitXDR`, `stellar_signMessage`,
    `stellar_signAuthEntry`.
- Verify API: `isScam` and flagged domains are refused outright; a
  domain mismatch (`INVALID`) is blocked by default with an explicit
  "connect anyway" acknowledgement plus biometrics; `UNKNOWN` connects
  with an "Unverified app" banner. Register your domain.
- Redirect: the wallet returns to `redirect.native` only when the
  pairing arrived by deep link; QR pairings never redirect (vendor
  guidance). An `https` redirect is offered as a button, never opened
  automatically.
- A request not decided within 5 minutes is rejected with `USER_REJECTED`.
- Bringing the wallet to the front for a request: the standard
  sign-client redirect `<wallet link>/wc?requestId=<id>&sessionTopic=<topic>`
  is accepted on `takumiwallet://`, `https://takumipay.xyz/wc` and (for
  libraries that store the raw pairing URI as the link) `wc:<topic>@2`.
  It wakes the wallet and shows the request; nothing else happens from
  the link. Until TakumiPay is listed in WalletGuide, generic `wc:`
  pairings have no stored deep link, so the wallet also posts a local
  notification when a request arrives in the background.
- One-Click Auth (`session_authenticate`, SIWE) is supported for
  `eip155`: one connect sheet plus one signature per requested chain.
  Link Mode is implemented behind a release flag and is not yet enabled.

## 5. Solana Mobile Wallet Adapter (Android)

- Scheme `solana-wallet:` and `wallet_uri_base = https://takumipay.xyz/mobilewalletadapter`.
- Native dApps **must** launch with `startActivityForResult` and publish
  a Digital Asset Links statement for `identity.uri` that lists the
  calling package; a native caller that fails verification is declined
  with no prompt (`ERROR_AUTHORIZATION_FAILED`). Browser launches are
  allowed as "Unverified app".
- Methods: `authorize` (with `signInPayload`), `reauthorize`,
  `deauthorize`, `sign_messages`, `sign_transactions`,
  `sign_and_send_transactions` (sequential, one sheet per transaction).
  Up to 10 payloads per request; transaction versions `0` and `legacy`.
- Authorizations expire after 30 days; `reauthorize` rotates the scope.
- Web-dApp origin attestation (`ERROR_ATTEST_ORIGIN_ANDROID`) is
  available on an opt-in basis: list the feature `solana:attestOrigin`
  in `authorize.features`. The wallet then answers the first `authorize`
  with `ERROR_ATTEST_ORIGIN_ANDROID { context, challenge,
  attest_origin_uri: "https://takumipay.xyz/mwa/attest" }`; your client
  loads that page in an iframe, posts `{ m: "origin-attest", h, context }`
  (with `h = base64(SHA256("attest-origin" || challenge || session_secret))`,
  `session_secret` = HKDF-SHA256 of the ECDH secret with the association
  public key as salt and `info = "mwa-attest-origin"`), and retries
  `authorize` with the returned token as `attest_origin`. Attested dApps
  are shown as "Verified web app" and keyed by origin. The stock
  `@solana-mobile/mobile-wallet-adapter-protocol` client does not do this
  yet; the patch is in the wallet repo under
  `docs/upstream/mwa-origin-attestation/`. First use per dApp may need
  one tap inside the attestation frame (browser storage partitioning);
  if the page answers `storage_access_required` and you cannot show the
  frame, retry without the feature and accept the unverified path.
  Native dApps are unaffected: they keep Digital Asset Links.

## 6. Phantom-compatible encrypted deep links (Solana)

Base URL `https://takumipay.xyz/ul/v1/<method>`; swap Phantom's base
for it and keep every parameter name.

- `connect`: `app_url`, `dapp_encryption_public_key`, `redirect_link`,
  `cluster?`. Response redirect carries
  `phantom_encryption_public_key`, `nonce`, `data` (box of
  `{public_key, session}`), names kept verbatim for client
  compatibility. Rejections carry `errorCode`/`errorMessage` with
  Phantom's codes (`4001`, `4100`, `-32000`, `-32002`, `-32003`,
  `-32601`, `-32603`).
- `signMessage`, `signTransaction`, `signAllTransactions`, `disconnect`
  as documented by Phantom; `signAndSendTransaction` is accepted for
  compatibility only (Phantom deprecates it).
- `redirect_link` must be a custom scheme or an `https` URL on the same
  origin as `app_url`. Custom-scheme redirects return to your app;
  `https` redirects are offered as a "Return to {app}" button.
- Sessions expire after 30 days (Phantom's do not); reconnect when you
  receive `4100`. Every request needs a fresh 24-byte nonce.
- There is no verifier in this protocol: every request is shown as
  "Unverified app". Use WalletConnect if you need a verified origin.

## 7. What the web host must serve (web repo)

`/.well-known/apple-app-site-association` — add the deep-link paths for
all three App IDs (replace `TEAMID`):

```json
{
  "applinks": {
    "details": [
      {
        "appIDs": [
          "TEAMID.com.planckify.takumiwallet",
          "TEAMID.com.planckify.takumiwallet.preview",
          "TEAMID.com.planckify.takumiwallet.dev"
        ],
        "components": [
          { "/": "/pay*" },
          { "/": "/wc*" },
          { "/": "/ul/*" },
          { "/": "/dapp/*" },
          { "/": "/dapp" },
          { "/": "/link/*" },
          { "/": "/mobilewalletadapter*" }
        ]
      }
    ]
  }
}
```

`/.well-known/assetlinks.json` — one statement per package with the
signing-cert SHA-256 from `constants/about.ts` (the production value is
the Play App Signing key, not the upload key):

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.planckify.takumiwallet",
      "sha256_cert_fingerprints": ["<production SHA-256>"]
    }
  },
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.planckify.takumiwallet.preview",
      "sha256_cert_fingerprints": ["<preview SHA-256>"]
    }
  },
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.planckify.takumiwallet.dev",
      "sha256_cert_fingerprints": ["<dev SHA-256>"]
    }
  }
]
```

The MWA activity uses the same package + certificate, so no extra
statement is needed for `/mobilewalletadapter`. `/.well-known/stellar.toml`
is not required for the wallet side of SEP-0007.

Recommended: a fallback page at each path that says "Open in TakumiPay"
for users without the app.

Caveat for integrators: iOS does **not** open the app for a Universal
Link tapped on a page that is itself on `takumipay.xyz`, or typed into
the address bar; links from other domains and other apps do open it.

## 8. WalletConnect Dashboard / WalletGuide (ops)

- Two projects, both type **Wallet**: production (App ID-locked to
  `com.planckify.takumiwallet`, domain-verified for `takumipay.xyz`,
  submitted to WalletGuide) and dev/preview (locked to the `.dev` /
  `.preview` ids, never submitted). Project IDs go into EAS env as
  `EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID` per profile.
- WalletGuide metadata: name "TakumiPay", homepage `https://takumipay.xyz`,
  chains = every family above, native link `takumiwallet://`, universal
  link `https://takumipay.xyz/wc`. The review checklist exercises the
  EVM and Solana flows on AppKit Lab.
