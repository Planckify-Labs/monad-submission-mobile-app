# mwa-walletlib (TakumiPay fork)

Vendored copy of `android/common` + `android/walletlib` from
`solana-mobile/mobile-wallet-adapter` at tag **v2.0.2** (the version
`@solana-mobile/mobile-wallet-adapter-walletlib` 1.4.5 pins), Apache-2.0,
with one feature added: the MWA spec's **origin attestation** for web
dApps (`ERROR_ATTEST_ORIGIN_ANDROID` + `attest_origin`).

Upstream defines the error code and never emits it; the dApp retry path
does not exist in any published client either. This fork adds the wallet
half, `docs/upstream/mwa-origin-attestation/` carries the client half and
the proposal. Every added line is marked `TakumiPay fork`.

Wiring: `plugins/withSolanaMobileWalletAdapter.js` includes this module in
`settings.gradle` and substitutes the Maven coordinates
`com.solanamobile:mobile-wallet-adapter-walletlib` /
`mobile-wallet-adapter-common` with it, so the RN bridge compiles against
the fork without being modified.

Changed files (diff against v2.0.2 in `docs/upstream/mwa-origin-attestation/walletlib.patch`):

- `common/ProtocolContract.java` — attestation parameter/data names, feature id.
- `common/protocol/SessionSecretProvider.java` (new) and
  `MobileWalletAdapterSessionCommon.java` — expose the session secret.
- `walletlib/protocol/JsonRpc20Server.java` — `getSender()`, `handleRpcErrorWithData()`.
- `walletlib/protocol/MobileWalletAdapterServer.java` — parse `attest_origin`,
  `AttestOriginRequiredException`, `computeAttestOriginBinding()`.
- `walletlib/scenario/AuthorizeRequest.java` — `getAttestOrigin()`,
  `computeAttestOriginBinding()`, `completeWithAttestOriginRequired()`.
- `walletlib/scenario/LocalScenario.java` — pass the server request through.
