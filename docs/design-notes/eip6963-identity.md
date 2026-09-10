# EIP-6963 identity — TWV-2026-031

**Owner:** mobile-app · **Spec ref:**
`docs/wallet-security-vulnerabilities-spec.md` TWV-2026-031.

## The invariants

1. **`uuid`** — UUIDv4, generated once per install via the OS CSPRNG
   (`crypto.getRandomValues` polyfill), persisted in MMKV. **NOT a
   build-time constant** — see "Why per-install" below.
2. **`rdns`** — pinned to `com.planckify.takumiwallet`, the iOS bundle
   ID / Android package / Play Store listing ID. Never drifts from the
   bundle ID. (Was `com.takumi.wallet` through 5.21.0 — a stale value
   that predated the `planckify` / `takumipay` naming; realigned under
   TWV-2026-031.)
3. **`name`** — `"TakumiPay"`. Bundled at build time, not
   user-editable, not fetched at runtime.
4. **`icon`** — `assets/images/takumipay-logo.png`, encoded inline as
   base64 (`takumipayLogoBase64`). No runtime fetch, no SVG.

## Why per-install (not build-time) UUID

A build-time constant would fingerprint every install of the wallet
to every dApp that records `info.uuid`. That's a privacy regression
the spec doesn't actually require — the impersonation defence is the
**`rdns`** value, which a malicious wallet would have to lie about
(and dApps that select by `rdns` catch the lie).

Per-install UUID + pinned `rdns` is the correct trade.

## What can change

- `uuid` may rotate ONLY on full reinstall (MMKV wipe).
- `name` and `icon` change with brand refreshes — coordinate with the
  rdns review to ensure no dApp's "remember my wallet" flow breaks.
- `rdns` MUST NEVER change — `assertOurRdns()` enforces this at
  runtime (logs in dev, ignored in prod to avoid bricking the user).

## "Announce-inbound" path (reserved)

If the agent or any in-app browser ever consumes EIP-6963 announces
from external providers (i.e. we operate as a dApp), provider
selection MUST be by `rdns`, never by `name` or `icon`. Any received
SVG icon MUST be sanitised before rendering — XSS via SVG inside an
icon URL has been seen in the wild.

## Review gate

Any PR that touches `services/chains/evm/eip6963.ts`, the `rdns`
value passed to `getEvmInjectedScript`, or the bundle ID in
`app.config.ts` MUST cite TWV-2026-031.
