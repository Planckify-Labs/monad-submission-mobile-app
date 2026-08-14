# rpc-proxy device credential

**Owner:** mobile-app + rpc-proxy + api · **Landed:** 2026-08-14

How the app authenticates to rpc-proxy, why it stopped shipping a key in the
bundle, and what is still missing.

## What changed

The app used to send `EXPO_PUBLIC_RPC_PROXY_API_KEY` as its data-plane bearer.
Expo inlines `EXPO_PUBLIC_*` at build time, so that key was a string literal in
the bundle. Two consequences, and only the second one drove this work:

1. **Extractable.** Unavoidable for anything a client holds. Not the problem.
2. **Unrotatable.** Revoking it breaks every installed build that has not
   updated, and mobile update tails run for months. So it could never actually
   be rotated, which made it a permanent public grant on our upstream RPC quota.

The device now mints its own token at runtime. rpc-proxy serves three tiers:

| Tier | Credential | Held by | Metered |
| --- | --- | --- | --- |
| server | `PROXY_API_KEY` | api (payment verification) | no |
| device | minted via `POST {origin}/token` | mobile app | yes, per device |
| admin | `PROXY_ADMIN_KEY` | operators | n/a |

`PROXY_API_KEY` survives, but as a genuine server-side secret rather than a
value shared with every install.

## Why not put the key in the RPC URL

The obvious alternative was embedding a key in the `rpcUrl` that `/blockchains`
already serves, so the backend could rotate it. Rejected:

- `GET /blockchains` is `@Public()` and sets `Cache-Control: public`
  (`api/src/blockchains/rpc-endpoint.ts` documents why: an Alchemy key was
  previously published this way). A credential in that response is one `curl`
  away, and rotating does not help when the attacker can just refetch.
- URLs leak where headers do not. viem's `HttpRequestError` prints the request
  URL, so a URL-borne credential lands in error strings, logs, and any
  telemetry that captures them. `rpcUrl` is threaded through `bridge/boot.ts`,
  the agent executors, `useWallet`, and the chain configs; each is a place it
  could escape.

Rotation and transport are orthogonal. Serving the credential from the backend
does not require putting it in the URL.

## Where things live

- `rpc-proxy/src/auth/deviceToken.ts` — mint, resolve, revoke. Tokens are
  opaque, stored as SHA-256 in Valkey, resolved on every request.
- `rpc-proxy/src/middleware/auth.ts` — `authorizeDataPlane` returns the tier.
- `rpc-proxy/src/middleware/rateLimit.ts` — per-device call ceiling, per-IP
  mint ceiling.
- `mobile-app/services/rpc/proxyToken.ts` — the client cache. MMKV, not
  SecureStore, because `proxyAuthHeaders()` is called from ~12 synchronous
  transport constructors and this is not key material.
- `mobile-app/services/rpc/proxyAuth.ts` — origin gating. The bearer is only
  attached to origins the `/blockchains` feed named as ours.

Revocation: `DELETE /admin/devices/:deviceId`. Instant, because tokens are
resolved against Valkey per request rather than being self-describing.

## What this does NOT prove

**Anyone can call `POST /token`.** There is no evidence the caller is a genuine
install of our app. The honest description is that this converts an anonymous
*permanent* grant into an anonymous *metered, revocable* one.

Specifically, today:

- `deviceId` is caller-supplied and unverified, so a banned device can mint a
  new identity. Clearing app data does it; so does one `curl`.
- The client's device id is a random UUID in MMKV, not IDFV / ANDROID\_ID.
  Deliberate: hardware ids would buy reinstall-survival that the proxy cannot
  rely on anyway while the field is unattested, at the cost of a native-module
  dependency in a module that must stay testable. When attestation lands, the
  attested identity replaces it and the durability arrives with it.

### The per-device limit does not bind a determined caller

`DEVICE_MINT_LIMIT_PER_HOUR` is per IP, but tokens live for
`DEVICE_TOKEN_TTL_SECONDS`. So minting **accumulates** rather than being merely
paced, and the two settings compose badly:

| Elapsed | Tokens held by one IP | Effective budget |
| --- | --- | --- |
| 1 hour | 20 | 12,000 req/min |
| 1 day | 480 | 288,000 req/min |
| 7 days (ceiling) | ~3,360 | ~2,000,000 req/min |

Do not read `DEVICE_RPC_LIMIT_PER_MINUTE` as a cost ceiling. It brakes casual
abuse and it makes abuse attributable and revocable, which is a real gain over
the unrotatable bundle key. It is not a defence against someone who is trying.

**Considered and deferred (2026-08-14):** a per-IP RPC budget alongside the
per-device one. Once a ceiling exists per IP, farming tokens buys nothing.
Deferred because sizing it is the hard part, not implementing it: Indonesian
mobile users sit behind carrier CGNAT, so thousands of legitimate users can
share one public IP and a tight per-IP cap would cut them off. It needs real
traffic data to set, and attestation makes it largely unnecessary by making
`deviceId` unforgeable. Revisit if upstream spend moves before attestation
lands.

Two things hold regardless of credential design, and neither exists yet:

- A spend alarm on the upstream providers. This is the only control that works
  no matter what shape the client credential takes.
- Attestation, which is the actual fix. While `deviceId` is free-form, every
  limit stacked on top of it only slows an attacker down.

## Closing the gap: attestation

The fix is Play Integrity (Android) and App Attest (iOS), which the repo
already specs for a different consumer — signing above the fiat threshold, see
`docs/design-notes/play-integrity-app-attest.md` (TWV-2026-058). **This is a
second consumer of that same capability, not separate work.** Do them together;
the native modules and the backend verifier are the expensive parts and both
are shared.

Seams already in place, so wiring it is additive:

- `MintRequest.attestation` (`rpc-proxy/src/auth/deviceToken.ts`) is accepted
  and ignored today. The mint route already validates it as an optional field,
  so the client contract does not change when verification lands.
- `mintDeviceToken()` is the single place verification would go.
- The planned `services/security/attestation.ts` from TWV-2026-058 exposes
  `requestAttestationToken(nonce)`; `proxyToken.ts#mint` is the one call site
  that would need it.

### Android — Play Integrity

- Native module (`react-native-google-play-integrity` or equivalent). Requires
  a development build; not available in Expo Go.
- Cloud project number + the Play Integrity API enabled, linked to the Play
  Console entry for `com.planckify.takumiwallet`.
- Server verifies the token against Google's decode endpoint, checking
  `appRecognitionVerdict == PLAY_RECOGNIZED` and the package name.
- **Standard requests are quota-limited.** Minting once per token TTL is well
  inside that; do not move attestation onto a per-RPC-call path.

### iOS — App Attest

- `DCAppAttestService`: `attestKey` on first use, `generateAssertion` after.
  Needs a thin native bridge.
- The App Attest entitlement in the EAS build profile, plus the Apple
  environment split (`development` vs `production` attestation servers). A
  build attesting against the wrong environment fails with a generic error and
  is easy to misdiagnose.
- The server stores the per-install public key from the initial attestation and
  verifies assertions against it, which means mint becomes stateful per install.

### Sequencing note

Attestation cannot be a hard requirement on day one. Devices legitimately fail
it: no Play Services, a rooted developer handset, an Apple environment
mismatch. Land it as an *unforgeable tier upgrade* first — attested mints get
the normal quota, unattested mints get a much smaller one — and only consider
hard-failing once the attested share is measured in production. A flat
rejection ships as "the wallet does not work on my phone."

## Operational notes

- The two keys that previously sat in `mobile-app/.env` shipped in bundles and
  must be considered burned. Rotate `PROXY_API_KEY` in the rpc-proxy
  deployment; nothing client-side depends on it any more.
- First launch after a fresh install has a short window between learning the
  proxy origin and the mint completing, during which RPC calls go out
  unauthenticated and the proxy answers 401. React Query's `retry: 1` covers
  the common case. Subsequent launches rehydrate the token from MMKV
  synchronously, so the window does not recur.
- Verify on device with `adb shell am force-stop` before retesting: Fast
  Refresh does not re-run module-scope side effects, so a reload will silently
  exercise the previous credential path.
