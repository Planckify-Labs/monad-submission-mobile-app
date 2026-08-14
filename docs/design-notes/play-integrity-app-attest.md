# Play Integrity / App Attest on sign-above-threshold — TWV-2026-058

**Owner:** mobile-app + backend · **Spec ref:** TWV-2026-058.

> **Status:** Native attestation work + backend verifier. Both sides
> are needed; one alone is theatre.

## Hard rule

For any signature ABOVE the configured fiat-equivalent threshold
(default $500, configurable per-user under transfer-thresholds),
the wallet MUST collect a fresh attestation token before producing
the signature:

- **Android:** Play Integrity API (`requestIntegrityToken`).
- **iOS:** App Attest (`DCAppAttestService.attestKey` for first call,
  `generateAssertion` thereafter).

The backend verifies the token (Google Play Integrity / Apple
App Attest verification) and ONLY THEN considers the signed
transaction submittable. Reject quietly: a failed attestation looks
identical to a transient network blip from the user's POV; the
backend records the failure for fraud triage.

## Attack defended

Detects:
- Rooted / jailbroken devices running a tampered app binary.
- Emulator / VM execution (drainer farms operate at scale on these).
- Repackaged binaries (sideloaded malicious clones).

## JS hooks

Once the native modules ship:

- `services/security/attestation.ts` exposes
  `requestAttestationToken(nonce)` returning an opaque base64 blob.
- The signer flow calls this immediately before invoking the signing
  function, includes the token in the request to the
  takumipay-api submit endpoint, and treats a non-200 response from
  the verifier as a hard rejection (no retry without re-attestation).

## Pre-implementation checklist

- [ ] Choose native modules: `react-native-google-play-integrity` for
      Android, a thin `DCAppAttestService` bridge for iOS.
- [ ] Backend `/v1/attest/verify` endpoint provisioned with the
      Google service-account key + Apple App Attest decryption.
- [ ] `services/security/attestation.ts` shipped + wired into the
      sign-above-threshold path.
- [ ] Threshold configurable via `services/transferThresholdStore.ts`
      (already present).

## Second consumer: rpc-proxy device tokens

Signing-above-threshold is not the only caller that needs this. The
rpc-proxy device credential (`docs/rpc-proxy-device-credential.md`)
mints an unattested token today, which means anyone can obtain one and
a banned device can mint a fresh identity. Attesting the mint is what
closes that.

Do the two together. The expensive parts — the native modules and the
backend verifier — are shared; only the call sites differ. The seams on
the RPC side already exist (`MintRequest.attestation`,
`mintDeviceToken()`), so it is additive there.

One difference worth carrying into the design: the RPC mint runs about
once per token TTL, not per request, which keeps it inside Play
Integrity's standard-request quota. Do not let attestation drift onto a
per-RPC-call path.

## Review gate

Any PR that adds a signing path MUST cite TWV-2026-058 and confirm
attestation is invoked above the configured threshold.
