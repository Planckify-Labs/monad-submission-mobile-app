# MWA origin attestation for web dApps: upstream proposal

Status: implemented in the TakumiPay wallet (2026-09-12) as a vendored
walletlib fork + a patched React Native bridge + a wallet-hosted script,
with the dApp-side client change kept here as a patch. Nothing in this
directory is applied to the app build; `native/mwa-walletlib/` and
`patches/` are.

The Mobile Wallet Adapter spec ("Identity verification" > Android)
describes how a wallet can verify the origin of a **web** dApp on
Android through `ERROR_ATTEST_ORIGIN_ANDROID` (`-100`), a challenge, and
a wallet-hosted attestation script. As of `solana-mobile/mobile-wallet-adapter`
v2.0.2 no side of the reference implementation carries it:

| Component | Upstream state | Patch here |
|---|---|---|
| `android/common`, `android/walletlib` (Java) | `handleAuthorize` never emits `-100`, never reads `attest_origin`; no session-secret accessor | `0001-walletlib-origin-attestation.patch` |
| `js/packages/mobile-wallet-adapter-walletlib` (React Native bridge, Kotlin + TS) | no `attestOrigin` on `AuthorizeDappRequest`, no way to answer with the challenge | `0002-react-native-walletlib-origin-attestation.patch` (against the published `1.4.5` package, which is newer than the `v2.0.2` tag's copy) |
| `js/packages/mobile-wallet-adapter-protocol` (web dApp client) | `decryptJsonRpcMessage` drops `error.data`; no retry with `attest_origin`; the AES session key is non-extractable so `session_secret` cannot be read | `0003-js-client-origin-attestation.patch` |
| Wallet-hosted attestation script | "implementation detail of wallet endpoints" | `attest.example.html` (served by TakumiPay at `https://takumipay.xyz/mwa/attest`) |

## Spec gaps this fills

1. **`session_secret` is undefined.** The spec binds the challenge with
   `h = base64(SHA256("attest-origin" || challenge || session_secret))`
   but never says what `session_secret` is, and the web client keeps the
   AES-GCM session key non-extractable. Definition used here:

   ```
   session_secret = HKDF-SHA256(
       ikm  = ECDH shared secret (the same input as the AES key),
       salt = X9.62 association public key (the same salt as the AES key),
       info = "mwa-attest-origin",
       L    = 32 bytes)
   ```

   Both endpoints can derive it after `HELLO_REQ`/`HELLO_RSP`; the AES
   key is never exported on either side. Java: `HKDF.hkdfSHA256(...)` +
   `MobileWalletAdapterSessionCommon.getSessionSecret()`. Web:
   `parseHelloRsp` returns `{ sharedSecret, attestBindingSecret }`
   (`deriveBits` on the same HKDF base key).

2. **Opt-in.** Existing dApp clients would break on an unexpected
   `-100`. A web dApp asks for attestation by listing the feature
   `solana:attestOrigin` in `authorize.features`
   (`ProtocolContract.FEATURE_ID_ATTEST_ORIGIN`, `SolanaAttestOrigin` in
   the JS client). Wallets that do not implement attestation ignore it;
   TakumiPay challenges only opted-in dApps while its
   `MWA_ORIGIN_ATTESTATION` flag is `"opt-in"`.

3. **Iframe exchange.** The spec defines the request
   `{ m: "origin-attest", h, context }` and says the response "message
   contents" become `attest_origin`. Here the success reply is the token
   string itself, and a failure is `{ m: "origin-attest-error", error }`.

4. **Token format** (wallet-defined; the dApp treats it as opaque):
   compact JWS, `ES256` (WebCrypto ECDSA P-256 / SHA-256, raw `r||s`),
   header `{ alg, typ: "JWT", kid: <context> }`, payload
   `{ typ: "mwa-origin-attest", origin: <event.origin>, h, context, iat }`.
   `origin` is set by the browser from the `postMessage` event, never by
   the dApp. The wallet verifies the signature against the public key it
   provisioned under `context`, recomputes `h` from its own session
   secret, and compares `origin` with the claimed `identity.uri`.

5. **Key provisioning** (non-normative in the spec): the wallet opens
   `attest_origin_uri?m=provision&nonce=<hex>&return=<private scheme>`
   in a Custom Tab; the page mints a non-extractable P-256 keypair in
   its own IndexedDB and redirects to
   `<return>?nonce=&context=&jwk=<base64url public JWK>`. The wallet
   only accepts a return echoing the nonce it minted, so a page opened
   by anyone else cannot plant a key.

## Known limitation: third-party storage partitioning

Current Android browsers partition third-party storage by top-level
site, so a key created in the wallet's Custom Tab (first-party
`takumipay.xyz`) is not visible to a `takumipay.xyz` iframe inside
`dapp.example`. The reference script handles this with the Storage
Access API: it asks for unpartitioned IndexedDB silently when access
was granted before, and otherwise answers
`{ m: "origin-attest-error", error: "storage_access_required" }`. The
patched dApp client then reveals the frame (a small bottom panel) so
the user can tap **Verify**, which is the user activation the API
needs; after the first grant the flow is silent again for that
(dApp, wallet-domain) pair. Browsers without the extended Storage
Access API (`requestStorageAccess({ indexedDB: true })`) cannot
complete attestation; the dApp should retry `authorize` without the
`solana:attestOrigin` feature and accept the unverified path. This is
a property of the spec's design, not of this implementation, and is
worth raising alongside the patches.

## Files

- `0001-walletlib-origin-attestation.patch`: `git apply -p1` at the
  repository root (`android/common`, `android/walletlib`). Verified to
  apply cleanly on `v2.0.2` and to compile with `javac` against
  `android.jar` 37.
- `0002-react-native-walletlib-origin-attestation.patch`: Kotlin bridge
  + `src/resolve.ts` of `js/packages/mobile-wallet-adapter-walletlib`
  (`AuthorizeDappRequest.attestOrigin`, `MWARequestFailReason.AttestOriginRequired`,
  `AttestOriginRequiredResponse`, `computeAttestOriginBinding(request, challenge)`).
  Generated from the published `1.4.5` package; the `lib/` build
  outputs are omitted.
- `0003-js-client-origin-attestation.patch`: `js/packages/mobile-wallet-adapter-protocol`
  (`attestOrigin.ts`, `parseHelloRsp` binding secret, `transact` retry,
  `error.data` forwarding, `SolanaAttestOrigin`, `ERROR_ATTEST_ORIGIN_FAILED`).
  Applies cleanly on `v2.0.2`; type-checks apart from a pre-existing
  `encryptedMessage.ts` typing error under current TypeScript.
- `attest.example.html`: the wallet-hosted script as deployed by
  TakumiPay (`landing-page/public/mwa/attest.html`).

Wallet-side verification lives in the app repo:
`services/transports/mwa/attestationToken.ts` (pure, tested) and
`services/transports/mwa/attestation.ts` (provisioning, challenges,
session cache), wired in `services/transports/mwa/index.ts#attestOrigin`.
