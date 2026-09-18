# Metropolis Monad Hackathon 2026 — Engineering Spec

**Status:** v0.3 — IMPLEMENTED 2026-09-16 across mobile-app, api, rpc-proxy, contract/evm and
landing-page (see §9 for the landed inventory). NOT device-verified: the passkey ceremony
(§3.4) and the end-to-end AUSD send still need a physical-device run on a dev/preview build.
**Author:** Claude (research + synthesis) · Owner: App
**Date:** 2026-09-14, updated 2026-09-16
**Submission window:** opens 2026-09-22, deadline 2026-10-14 11:59 GMT+8
**Source of truth for intent:** [`docs/monad-metropolis-2026-strategy.md`](./monad-metropolis-2026-strategy.md)
**Precedent we mirror:** [`docs/sui-overflow-2026-phase1-intent-engine-spec.md`](./sui-overflow-2026-phase1-intent-engine-spec.md), [`docs/defi-strategies-spec.md`](./defi-strategies-spec.md)
**External docs cited:** `docs.monad.xyz`, `docs.agora.finance`, `mera.category.xyz` / `github.com/category-labs/mera`, `platform.kimi.ai` — full citation list in Appendix A.

---

## 0. Goal & non-goals

### Goal

Ship a cross-border AUSD remittance flow inside the existing TakumiPay wallet:

1. A user onboards with a **passkey** (Face ID / Touch ID / Android biometric) via **Mera** — no
   seed phrase shown or required for this flow.
2. They hold/receive **AUSD** on **Monad**.
3. They send AUSD to another person — by hand through the existing send UI, or by telling the
   **Kimi-powered Takumi Agent** in plain language ("send $50 to my mom in Jakarta") — and it
   settles in roughly one Monad block (~600ms to "finalized").

This single flow is the submission for the Consumer Products & Payments track and both sponsor
bounties (see strategy doc §Judging criteria).

### Non-goals (this phase)

- **Not replacing the primary wallet.** The existing mnemonic-derived multi-chain wallet
  (`hooks/useWallet.helpers.ts`) is untouched. Mera is an additive, EVM-only onboarding path scoped
  to this flow.
- **Not integrating Agora's institutional API.** No fiat on/off-ramp, no org account registration,
  no KYC-gated mint/redeem. We only consume AUSD as a public ERC-20 contract. (Finding: that API
  has no P2P send endpoint — see §2.)
- **Not building Mera as a smart-contract / ERC-4337 account.** Confirmed Mera does not provide
  one — it derives a plain secp256k1 EOA. If account abstraction is wanted later, that's a
  separate, later effort layered on top of a Mera-derived EOA (e.g. via existing EIP-7702 delegator
  infra), not part of this scope.
- **Not chain-namespace branching in shared code.** Everything docks behind existing
  registries/capabilities; `pnpm check:chains` must stay green.
- **Not a general remittance network.** Fixed to Monad + AUSD for the hackathon; no multi-chain
  remittance routing.

---

## 1. Current state (what's already true, not hackathon work)

- **Monad (chainId `143`) is a live, active EVM chain** in the backend seed
  (`api/src/scripts/prisma/seed.ts`): `rpcUrl: "/evm/143"` (proxied), `blockExplorer:
  "https://monadvision.com"`, `isActive: true`, `isTestnet: false`. Native `MON` token row seeded
  (18 decimals, `isNativeCurrency: true`). Served to the app dynamically via the `/blockchains`
  feed — no static entry needed in `constants/configs/chainConfig.ts` (that file is documented as
  bootstrap-only defaults; real chains come from the backend feed, same pattern Solana already
  uses).
- **Monad is already in the 1Shot gas-abstraction default allowlist**
  (`services/gasAbstraction/supportedChains.ts`, `DEFAULT_ABSTRACTION_CHAIN_IDS` includes `143`).
- **`send_native` / `send_token` agent tools are chain-agnostic already**
  (`agent-api/src/agents/wallet/tools/capabilities.ts`) — the agent resolves a token by symbol via
  `get_wallet_assets` and never hardcodes contract addresses.
- **Kimi K2.6 is the live model** backing the Takumi Agent
  (`agent-api/src/agents/models.ts` → `moonshotProvider()`, `baseURL:
  "https://api.moonshot.ai/v1"`, model id `kimi-k2.6`). OpenAI-SDK-compatible, standard
  tool-calling. No changes needed here for this feature to work through the agent.
- **No existing Agora, AUSD, passkey, or WebAuthn code anywhere in this repo** — confirmed via
  repo-wide search. Everything in §3–§5 below is net new.

---

## 2. AUSD — what it is and what we actually integrate

### 2.1 Token facts

AUSD is a standard **ERC-20** on EVM chains, additionally implementing **EIP-712, ERC-1271,
ERC-2612 (permit), and ERC-3009 (`transferWithAuthorization` — gasless, signature-based
transfer)**. No custom token standard on EVM. Backed 1:1 by cash + short-term US Treasuries,
monthly third-party attestation. [docs.agora.finance/developer.md, .../developer/transparency.md]

**Verified contract addresses** (fetched as raw markdown to avoid transcription errors — **still
verify against `monadvision.com` + an on-chain `symbol()`/`decimals()` read before seeding into the
DB**, per this repo's own established discipline for cross-chain address pairings — see
`api/src/strategies/targets/centrifuge.resolver.ts`'s comment on never guessing a chain-id pairing):

| Network | Address |
|---|---|
| Monad Mainnet | `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` |
| Monad Testnet | `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC` |

[docs.agora.finance/developer/contract-deployments.md] Both addresses are the same across every
EVM mainnet/testnet respectively — Agora deploys deterministically.

**Decimals, symbol, name — verified on-chain 2026-09-14**, not assumed and not taken from docs
(Agora's own docs never state decimals). Read directly via `eth_call` against the public Monad RPC
(`decimals()`/`symbol()`/`name()`/`totalSupply()` selectors) on both addresses in the table above,
matching the established "verify, don't guess" pattern already used for Stellar's native-asset
decimals (`docs/stellar-chain-support-spec.md`):

| Field | Value | Notes |
|---|---|---|
| `decimals()` | **6** | Same on mainnet + testnet |
| `symbol()` | **`"AUSD"`** | ABI-decoded, confirmed |
| `name()` | **`"AUSD"`** | Also literally `"AUSD"` on-chain — not "Agora Dollar" despite that being the docs' informal name |
| `totalSupply()` (mainnet) | **≈172,600,327 AUSD** | Live figure as of verification, will drift — don't hardcode as current, just as evidence this is a real, liquid stablecoin and not a testnet-only token |
| `eth_getCode` | non-empty on both addresses | Confirms real deployed contracts, not typos/unclaimed addresses |
| Logo/brand asset URL | **`https://dsvxs4ecepqgj.cloudfront.net/tokens/AUSD/logo.svg`** | Not published in Agora's own docs (`contract-overview`, `developer.md` both checked) — provided by the user 2026-09-16, verified live: `HTTP 200`, `image/svg+xml`, 256×256, served via CloudFront/S3, last-modified 2025-11-20 (matches AUSD's Monad launch window) |

### 2.2 What Agora's API actually is (and why we don't call it)

`https://api.agora.finance` is an **institutional treasury / on-off-ramp API**, not a payments
orchestration layer:

- **Accounts** — register your org's own bank accounts + blockchain wallets; wallets get
  `mint`/`redeem`/`instant_settlement`/`rewards` entitlements gated by an automated compliance
  scan.
- **Routes** — persistent fiat↔AUSD or stablecoin↔AUSD mint/redeem paths (wire memo or on-chain
  deposit address).
- **Transactions** — read-only settled history.
- **No endpoint sends AUSD from one end-user to another.** [docs.agora.finance/api.md,
  .../api/endpoints/accounts/overview.md, .../api/endpoints/routes/overview.md]

There is also a separate **"Instant Settlement Protocol"** — a fixed-price AMM (Uniswap-v2
interface) for stablecoin↔AUSD swaps, **gated to KYC-whitelisted addresses**
(`instant-settlement.md`). Not relevant to a wallet-to-wallet send.

**Conclusion:** "instant settlement" for our P2P send comes from **Monad's own block time**, not
from an Agora API. Our integration surface with Agora is: the AUSD ERC-20 contract, full stop. No
API key, no org registration, no KYC gate on our critical path.

### 2.3 Backend work

Add an AUSD token row to `api/src/scripts/prisma/seed.ts`, following the exact pattern already
used for other EVM tokens (see the MON native-token upsert nearby for style):
`blockchainId: evmChain(143).id`, `contractAddress: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a"`
(mainnet, §2.1), `decimals: 6`, `symbol: "AUSD"`, `name: "AUSD"` (all verified on-chain, §2.1),
`isStablecoin: true`, `isNativeCurrency: false`. `logoUrl:
"https://dsvxs4ecepqgj.cloudfront.net/tokens/AUSD/logo.svg"` (verified live, §2.1). This single seed row is what
makes AUSD show up in `get_wallet_assets`, the send UI's token picker, and the agent's
`send_token` tool — no other backend change required.

---

## 3. Mera passkey onboarding

### 3.1 What Mera actually is

Open-source, client-side TypeScript library by Category Labs (`@category-labs/mera`, npm, v0.2.0,
"preview"/pre-1.0). **Not** a hosted wallet service, **not** an ERC-4337 smart-account provider —
confirmed zero references to bundler/entrypoint/account-factory anywhere in the repo. It derives 32
bytes of deterministic entropy from a passkey's **WebAuthn PRF extension**, and hands you low-level
primitives to build a standard key on top yourself (the docs' own example: `@scure/bip39`/`bip32` →
mnemonic → secp256k1 key). **No Mera-operated backend, no network calls at any step** — purely
on-device crypto. [github.com/category-labs/mera — getting-started.mdx, security-model.mdx]

Monad's own docs host a dedicated guide for this integration, including a **React-Native-specific**
page — this pairing is explicitly expected by the Monad ecosystem, not just a hackathon-bounty
coincidence. [docs.monad.xyz/guides/mera, docs.monad.xyz/guides/mera/react-native]

### 3.2 Passkey → key flow

1. `createPasskeyWithPrfOutput()` — creates the platform passkey (Face ID/Touch ID/Android
   biometric via the platform authenticator) and returns deterministic `prfOutput` bytes in one
   call.
2. On any later sign-in, `getPasskeyPrfOutput()` **reproduces the same bytes** from the same
   passkey — meaning **the derived key never needs to be stored**; every session/device re-derives
   it from the passkey itself. This is the mechanism that lets us honestly claim "no seed phrase."
3. App code derives an actual signing key from those bytes (mnemonic → secp256k1, per the docs'
   own recipe) and opens a `createSecp256k1SigningSession` — `session.signDigest()` /
   `session.end()`. `getEvmAddress()` / `toViemAccount()` give the address / a viem-compatible
   account object.

[github.com/category-labs/mera — getting-started.mdx]

### 3.3 React Native integration — real, but has real costs

Confirmed first-class RN support (not browser-only): a dedicated docs recipe
(`recipes/use-mera-with-react-native.md`) and a shipped Expo demo app (Expo 57 / RN 0.86).

- **Install:** `@category-labs/mera` + `react-native-passkey` (third-party native module) +
  import `reactNativeWebAuthnClient` from `@category-labs/mera/react-native-webauthn-client`.
- **Requires a native module → Expo prebuild/dev-client, not Expo Go.** Not a new constraint for
  this project — TakumiPay already ships via EAS dev-client builds (`expo-secure-store`, MMKV,
  etc. already require this), so this is a non-issue here, unlike for a from-scratch Expo Go app.
- **Hermes has no `crypto.getRandomValues`** — but this app already polyfills it:
  `pollyfills.ts` installs `react-native-get-random-values` as its very first import (enforced —
  the file has a fail-loud self-check if `crypto.getRandomValues` isn't a function by the end of
  the file), plus `react-native-quick-crypto` for native-JSI secp256k1/SHA-256/keccak256, which
  directly accelerates the kind of key-derivation math Mera's docs example does. **No new polyfill
  needed** — confirmed by reading `pollyfills.ts` directly, not assumed. The one thing to respect:
  `pollyfills.ts` documents a strict *load-order* contract (CSPRNG polyfill first, then native
  crypto install, then everything else) because viem/`@scure`/`@noble` read
  `globalThis.crypto.getRandomValues` at call time — any Mera/`react-native-passkey` import must
  land after this file's polyfills the same way viem's does (`app/_layout.tsx` already guarantees
  `pollyfills.ts` is the first import app-wide), not before.
- **Requires domain-association files** tying the passkey RP domain to the app: iOS needs a
  `webcredentials` block in `apple-app-site-association`; Android needs
  `delegate_permission/common.get_login_creds` in `assetlinks.json`. **Both files already exist and
  are already deployed** — `landing-page/public/.well-known/{apple-app-site-association,
  assetlinks.json}` — wired to the real bundle IDs
  (`com.planckify.takumiwallet`/`.preview`/`.dev`) and signing cert fingerprints (verified
  2026-09-14). Concretely:
  - **Android is likely already done:** the main `com.planckify.takumiwallet` entry in
    `assetlinks.json` already carries `delegate_permission/common.get_login_creds` alongside
    `handle_all_urls` — that's the exact relation Android Credential
    Manager/passkeys require. (The `.preview`/`.dev` entries only have `handle_all_urls` — add
    `get_login_creds` to those too only if passkey testing on those build variants is needed.)
  - **iOS needs one addition:** `apple-app-site-association` currently only has an `applinks`
    block (for the existing universal-link deep-linking). Passkeys need a sibling
    `webcredentials: { apps: ["TEAM_ID.com.planckify.takumiwallet", ...] }` key added to the same
    file. Small diff to an existing, already-deployed file — not new domain infrastructure.
  [github.com/category-labs/mera — recipes/use-mera-with-react-native.md, demos/mobile/]

### 3.4 Coverage risk — verify on real hardware

The authenticator-support compatibility table is granular and evidence-based for **browser**
authenticator combos, but native-app support is a single unqualified sentence — *"Native apps can
use PRF on iOS 18+ and Android 9+"* — with no per-OEM/provider breakdown.
[github.com/category-labs/mera — authenticator-support.md] Given this team's own standing rule to
get on-device evidence before trusting a claim (`feedback_get_crash_log_before_naming_root_cause`,
`feedback_rn_device_debugging_traps` in memory), **treat Android PRF support as unverified until
tested on real hardware early in the build**, not assumed from the docs.

### 3.5 Where this docks in the codebase

Mera is EVM-only and self-contained — it does not implement the `WalletKitAdapter` interface (it
has nothing to do with Solana/Sui/Stellar) and should **not** be forced into that registry. Proposed
shape: a new module (e.g. `services/walletKit/evm/mera/`) that:

- Wraps passkey creation + PRF reproduction + secp256k1 session into a small, testable interface
  (mirrors how `signTransferWithAuthorization.ts` wraps a signing primitive today).
- Produces a viem-compatible `Account` that the existing `EvmAdapter` can sign with — from
  `EvmAdapter`'s perspective, a Mera-derived account should look like any other signer it already
  knows how to use, not a special case threaded through shared code (keeps `pnpm check:chains`
  and the broader "space docking" convention intact).
- Is invoked from a **new, additive onboarding entry point** for this flow specifically — not
  wired into the existing `useWallet.helpers.ts` mnemonic-derivation path.

**Where this ships — resolved 2026-09-14.** Ship the Mera-only onboarding entry point through the
existing **`.preview`** build/bundle variant (`com.planckify.takumiwallet.preview` —
already-established as a separate channel from the Play Store production app, per
`landing-page/public/.well-known/apple-app-site-association`'s existing `applinks` entries), not
the production release. This is the judged "Live Product Link" build; it shows Mera as the only
onboarding path for this flow with no seed-phrase/import fallback, satisfying the Mera bounty's
"entire account layer" framing, without touching what real Play Store users see or forcing a
premature production commitment to pre-1.0 Mera / unverified Android PRF coverage (§3.4). State
this plainly in the README/pitch ("this build showcases Mera-first onboarding for the new
cross-border flow") rather than implying the shipped production app changed its auth model — same
honesty discipline this team already applies to Stellar's repo-vs-store gap.

**This makes two `.well-known` gaps load-bearing, not optional (§3.3 flagged them
conditionally — now they're required):**
- `assetlinks.json`'s `.preview` entry only has `handle_all_urls` today — it needs
  `delegate_permission/common.get_login_creds` added too, or Android passkeys won't associate on
  this specific build variant even though the main package is fine.
- The new `webcredentials` block being added to `apple-app-site-association` (§3.3) must list
  `TEAM_ID.com.planckify.takumiwallet.preview`, not just the main bundle ID, or iOS passkeys won't
  work on this build either.

---

## 4. Send pipeline

Two tiers. **Decided 2026-09-16: Tier 1 (native MON gas) is the default and the demo path;
Tier 2 (gasless) is a nice-to-have that is already wired app-wide and only needs the user to
opt in on the Gas Settings screen.** Paying gas in MON is perfectly acceptable for this hackathon;
gasless is not what wins it.

### 4.1 Tier 1 (default): plain on-chain ERC-20 transfer, gas paid in MON

Reuse the existing send pipeline end to end: `app/send.tsx`'s address-book-backed recipient
picker → `kit.validateAddress` → the `EvmAdapter`'s existing transfer path, with the Mera-derived
account as the signer and AUSD as the selected token (once seeded per §2.3, it appears in the
token list like any other EVM token). Settlement is "instant" for demo purposes purely because
Monad's own finality is ~600ms [docs.monad.xyz/developer-essentials/summary] — no new
infrastructure required for this tier.

**Gas quirk to handle explicitly:** Monad bills `gas_bid * gas_limit`, not `gas_used`
[docs.monad.xyz/developer-essentials/gas-pricing]. If any fallback path pads the gas limit after an
`eth_estimateGas` revert (a documented MetaMask-style anti-pattern the Monad docs explicitly warn
about), the user overpays for unused gas. Use an explicit, known-good fixed gas limit for this
specific AUSD-transfer call shape rather than trusting a padded simulation fallback.

**MON funding — demoted to manual/ops, decided 2026-09-14.** A freshly-onboarded Mera wallet needs
a small amount of MON to pay for this transfer. **No automated top-up feature is part of this
submission** — fund the demo wallet(s) by hand, one-time, same posture as acquiring AUSD (§6.5).
An automated mechanism (app-funded treasury or faucet-style endpoint) is nice-to-have, built only
after Mera/AUSD/the send flow are all clear. Paying gas in MON is the intended default for this
submission (decided 2026-09-16); the existing USDC-gas option (§4.2) already covers "user would
rather not hold MON" for anyone who flips it in Gas Settings.

### 4.2 Tier 2 — gasless AUSD via MetaMask smart account + 1Shot (nice-to-have; **already wired, opt-in via Gas Settings**)

**Third correction, 2026-09-16, and the one that closes this section: the "new bundle-assembly
function" this section asked for already exists.** Read from the code, not remembered:

- `services/gasAbstraction/oneShot/oneShotRelayerProvider.ts` is the non-x402 assembler. Its own
  header documents the two shapes it picks automatically: sending USDC itself (one delegation
  scoped to fee + work), or **sending any other token, e.g. IDRX (work token != fee token): a
  USDC fee delegation to `feeCollector` plus a work-token delegation to the recipient, batched as
  two bundle entries the relayer merges into one `redeemDelegations`**. That second shape *is*
  the AUSD case. It also carries the EIP-7702 authorization in-flight on the first abstracted send
  of an un-upgraded EOA (`kit.signEip7702Authorization`), so there is no separate "upgrade step".
- `services/gasAbstraction/resolveGasPayment.ts` is the single policy every onchain write goes
  through, and it's already called from both `app/send.tsx` and the agent's transfer executor
  (`services/agent-executors/wallet/writes.ts`). Policy: preference `"native"` → native gas;
  `"usdc"` → quote via the provider, and if the chain/token isn't eligible, fall back to native;
  if eligible but the wallet can't cover `amount + fee` in USDC, **block** rather than silently
  spend native.
- `app/gas-settings.tsx` + `hooks/usePreferredGasToken.ts` are the user-facing switch, persisted
  in MMKV, **default `"native"`**. The same preference is read off-tree by the agent executor.
- Monad `143` is in `DEFAULT_ABSTRACTION_CHAIN_IDS`, and USDC is an accepted 1Shot fee token on
  Monad (verified live 2026-09-14, below). So the provider will not decline for Monad.

**Net-new work for Tier 2: none in the send pipeline.** The only Mera-specific requirement is
that the Mera-derived signer (§3.5) plugs into `EvmWalletKit` the same way the mnemonic-derived
one does, so `signEip7702Authorization` and delegation signing work off it. That's a §3.5
requirement regardless of Tier 2, not extra Tier 2 work. Ops-only: if the recording shows the
gasless path, the demo wallet needs a few dollars of USDC on Monad for the fee leg (manual,
one-time, same posture as MON funding). If it doesn't, nothing to do.

**Demo posture:** default is MON gas (Tier 1). Gasless is shown, if at all, as "and if you'd
rather not hold MON, switch gas to USDC in settings" — a settings toggle, not a headline feature.

---

**Historical record — the two earlier corrections, kept because the verification they produced
is still what makes the wiring above trustworthy on Monad:**
First pass proposed reusing `signTransferWithAuthorization.ts` (Circle-Gateway-specific, not a
generic ERC-3009 signer) and treated `rails/RelayerBroadcastRail.ts` (x402-scoped, fee leg hardcoded
to `challenge.asset`) as a drop-in — both wrong, and the tier was dropped entirely. That undersold
what's actually here: `@metamask/smart-accounts-kit@^1.6.0` is a real, already-wired dependency
(`services/walletKit/evm/delegations.ts`, `EvmWalletKit.ts`), and its delegation-building code is
**generic**, not x402-specific. Verified live, not from docs alone:

- **Called `getSmartAccountsEnvironment(143)` directly** (the same function `EvmWalletKit.ts` already
  calls by raw `chainId`) and got real implementation/enforcer addresses back:
  `EIP7702StatelessDeleGatorImpl` `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B`, `DelegationManager`
  `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3`, `ERC20TransferAmountEnforcer`
  `0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc` (exactly the enforcer needed to scope a delegation
  to "transfer up to X AUSD"), ERC-4337 `EntryPoint` `0x0000000071727De22E5E9d8BAf0edAc6f37da032`.
- **Confirmed each has real deployed bytecode on Monad mainnet** via `eth_getCode` against the
  public RPC — not just present in the SDK's config, actually live on-chain.
- **Called `relayer_getCapabilities` live for chain `"143"`** and got a real response:
  `feeCollector: 0xfb6644ef5f13f27acb2bcceb3a91be6d31557c4d`,
  `targetAddress: 0xf99fe307e51cdf9ed58367b9e9f073f9c068fd0b`, accepted fee tokens **USDC** and
  **USDT0** (both 6 decimals). **Monad testnet (10143) is not served** — the same call against the
  mainnet host returned an empty result, and 1Shot's own testnet host only routes Sepolia/Base
  Sepolia (per this repo's own `TESTNET_CHAIN_IDS` in `relayer.ts`). **This tier is mainnet-only.**
- **AUSD is not an accepted fee token — but that only constrains the fee leg, not the transfer
  itself.** The relayer bundle's "work" execution can call anything the signed delegation's caveats
  permit; there's no whitelist on what the work leg moves. A working bundle: fee leg = small USDC
  or USDT0 transfer to `feeCollector`, work leg = AUSD `transfer` to the recipient, both authorized
  by an `erc20TransferAmount`-scoped delegation (`delegations.ts`'s `mapScopeToSdk`, first case,
  already handles this scope type).
- **What's genuinely reusable vs. genuinely new:** `delegations.ts` (delegation creation) and
  `EvmWalletKit.ts`'s `getSmartAccountsEnvironment`/smart-account wiring are chain-agnostic and
  already tested (`delegations.test.ts`) — real reuse. `relayer.ts`'s client functions
  (`relayerEstimate7710Transaction`, `relayerSend7710Transaction`, etc.) take raw
  `chainId`/`transactions`/`executions` and are not x402-specific either. What's **not** directly
  reusable is `rails/RelayerBroadcastRail.ts`'s `attempt()` wrapper (x402 challenge-shaped, fee leg
  hardcoded to the transfer asset) — a new bundle-assembly function should follow its pattern
  (estimate → lock `context` → send → poll) rather than call it as-is.

*(The "(3) a new, non-x402 bundle-assembly function" step that used to sit here was wrong: that
function is `oneShotRelayerProvider.ts`, see the top of this section. The `RelayerBroadcastRail`
analysis above is still correct; it's just not the module the send pipeline uses.)*

---

## 5. Agent (Kimi) wiring

**No new agent-api code is required for the core loop.** Once AUSD exists as a token row (§2.3):

- `get_wallet_assets` returns it like any EVM token.
- `send_token({ to, symbol: "AUSD", amount })` resolves the contract address + decimals itself
  (agent never handles the raw address) and executes through the existing write-approval gate.
- The Kimi-powered agent (`agent-api`, `kimi-k2.6`) already has tool-calling wired for exactly this
  shape of call.

**Demo script:** user types *"send $50 to my mom in Jakarta"* (or similar) → agent resolves the
recipient (via saved address-book contact, or asks for the address if none saved) → calls
`send_token` with AUSD on the active Monad wallet → existing write-approval sheet renders the facts
(amount, recipient, token) per `approvalSummary.ts` → user confirms → same Tier 1/Tier 2 pipeline as
§4 executes.

This is the concrete answer to the KIMI bounty's bar — *"meaningfully driving a core feature, not a
chatbot widget"* — because the agent is doing the actual payment execution, not narrating a
separately-built UI flow.

---

## 6. Compliance note (non-blocking for the hackathon)

Agora's compliance scanning applies to **org-level accounts registering for mint/redeem
entitlements** [docs.agora.finance/api/endpoints/accounts/overview.md] — not documented as gating
ordinary wallet-to-wallet ERC-20 `transfer()` calls, and we never call that part of Agora's API.
Nothing in our critical path is KYC-gated for the hackathon demo. **Flag for a real legal/compliance
review before any production launch beyond the hackathon** — this spec covers a demo, not a
regulatory posture.

---

## 6.6. QRIS-spend completion: "send from abroad, spend at any QRIS merchant" (added 2026-09-14)

**Discovered while scoping the pitch, not originally planned — genuinely low-cost given what
already exists.** Separate from the Circle-Gateway-locked nanopayment rail (Path B —
`signTransferWithAuthorization.ts`, USDC-hardcoded, §4.2), this repo has a second, **already
token-agnostic and chain-agnostic** merchant-settlement rail:

- **Mobile:** `services/nanopay/pathOnchainSettlement.ts` — calls `processMerchantPayment(quote,
  backendSignature)` on a per-chain TakumiPay contract. The `quote` struct carries an arbitrary
  `tokenAddress` (not hardcoded to any asset), `fiatAmountMinor`/`fiatCurrency`/`exchangeRateId` —
  the backend computes conversion to whatever fiat the merchant needs. Guard is
  `chain.namespace === "eip155"` — the module's own docstring: "any EVM chain with the TakumiPay
  contract deployed is eligible."
- **Backend:** `api/src/pay/settlement/providers/onchain.settlement.provider.ts`
  (`key: "takumipay"`) looks up the deployed contract via `(blockchainId, name: "takumi_pay")` —
  the exact same per-chain `SmartContract` registry pattern already used for Solana and Stellar —
  and resolves the payment token via `intent.sourceTokenId` against the generic `Token` table.
  Already "exercised live end-to-end (createTransaction, depositPoints, processMerchantPayment,
  both sweeps) against real testnet USDC" on Arc Testnet, per the seed's own comment; also deployed
  on Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia.

**AUSD plugging into this rail costs nothing beyond the token registration already planned in §2.3
— no new settlement logic, no new mobile code, no new backend code.** What's net-new is entirely
data/deployment, not application code:

1. Seed Monad **testnet** (`10143`) as a new `Blockchain` row (`isActive: true`, `isTestnet:
   true`, `type: "EVM"`) — confirmed via direct grep that no Monad testnet row exists in the seed
   today, unlike mainnet (§1). Seed a MON testnet native-token row, same pattern as mainnet's.
2. Seed an AUSD **testnet** token row — **but not Agora's testnet contract (decided 2026-09-16,
   see below).** Deploy our own open-mint 6-decimal ERC-20 (`symbol: "AUSD"`, `name: "AUSD"`) to
   Monad testnet and seed *that* address, decimals 6, `isStablecoin: true`.

   **Why — verified 2026-09-16, not assumed.** Agora's testnet AUSD
   (`0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC`, chain `10143`) is a real EIP-1967 proxy (impl
   `0xc1e3c7d486d6a92fbe920232e439eec2ceb112da`, ~302M supply) but **mint is gated**: an
   `eth_call` to `mint(address,uint256)` from an arbitrary EOA reverts with custom error
   `0xdfcadb5b`; `owner()`, `isMinter()`, `paused()` all revert (no public admin interface).
   There is no Agora faucet, and §6.5 already rules out Agora's KYC-gated acquisition path. So
   there is no permissionless way to get testnet AUSD into a demo wallet, and the QRIS-spend leg
   can't depend on it.

   **The mock is honest here, not a shortcut.** The rail under test (§6.6 bullets above) is
   token-agnostic by design; what the QRIS demo proves is `processMerchantPayment` settling an
   arbitrary registered ERC-20 on Monad. The *real* AUSD contract is exercised on mainnet in the
   remittance leg (§4). Say so in the pitch: "QRIS spend is demonstrated on Monad testnet with a
   stand-in AUSD, because Agora's testnet token has a permissioned mint; the mainnet leg uses the
   real one." If Agora hands out testnet AUSD on request (ask in Discord, non-blocking), swap the
   seeded address to theirs — zero code change.

   **Implementation:** `../contract/evm/test/*.t.sol` already carries a `MockERC20 is ERC20` with
   an open `mint(address,uint256)` — promote a copy to `src/MockAUSD.sol` with `decimals()`
   overridden to `6` (the test mock uses OpenZeppelin's default 18 — the 6 matters because the
   backend's fiat conversion and the mobile amount parsing both read `decimals` from the token
   row, and the row must match the contract), plus a one-line deploy script alongside
   `script/DeployTakumiPay.s.sol`. Record the deployment in `deployments/10143.json` like the
   other chains.
3. Redeploy the existing `takumi_pay` Solidity contract to Monad testnet — reuse the same
   `contract/evm` deployment scripts already used for Base Sepolia / Arbitrum Sepolia / Ethereum
   Sepolia (sibling repo, `../contract/evm/deployments/<chainId>.json` convention per the seed's
   own comments). Not a new contract — a new chain deployment of an existing one.
4. Register the deployment as a new `SmartContract` row (`name: "takumi_pay"`, `type: "payment"`,
   `blockchainId` = the new Monad testnet row, the deployed address).
5. **No app code changes.** `pathSelector.ts` dispatches on `walletKit.sendContractTransaction`
   presence (already true for the EVM kit) and `pathOnchainSettlement.ts`'s own mainnet gate
   (`!chain.isTestnet && !FEATURE_EVM_ONCHAIN_SETTLEMENT_MAINNET`) only fires for **non-testnet**
   chains — Monad testnet clears it automatically, no flag needed.

**Deliberately not pursuing Monad mainnet for this piece — this is a real security decision, not
a scope-cutting shortcut.** `FEATURE_EVM_ONCHAIN_SETTLEMENT_MAINNET` defaults off because, per its
own code comment: *"`backendSigner` derives from a private key committed in the API's
`.env.example`, so anyone can forge a quote the contract accepts,"* and contract ownership hasn't
been transferred off the deploying EOA either. Both are described as real, already-understood
release blockers with an existing fix path (`rotateBackendSigner()` already exists as a function),
not code that needs to be written from scratch — but rotating a production signer key and
transferring contract ownership under hackathon time pressure, for a **global** flag that would
also affect every other EVM mainnet chain the moment it gets a contract deployed, is not a
decision to make lightly for a demo. Testnet gives a fully real, live, judge-verifiable
demonstration of the exact same code path without touching that gate at all.

**Pitch framing:** state the environment split plainly rather than let a judge discover it —
*"remittance settlement is live on Monad mainnet; the QRIS-merchant-spend rail is proven
end-to-end on testnet, with mainnet activation gated behind a known, already-scoped security step
we're deliberately not rushing."* This reads as engineering maturity, not a limitation.

---

## 6.5. Acquiring real mainnet AUSD for the demo (ops step, not code)

Since the demo now targets mainnet (strategy doc, resolved 2026-09-14), AUSD for testing/demo is
**real money**, not a faucet token — there is no AUSD faucet, and it shouldn't be treated like one.
**Do not use Agora's own "Instant Settlement Protocol" AMM to acquire it** — re-checked the exact
docs language: *"available exclusively to verified platform users through a protected whitelist"*
— this gates **every** swap through that pool, not just large trades, and requires going through
Agora's KYC/compliance onboarding, which is not fast enough for a hackathon timeline and is a
different thing entirely from the institutional API question already ruled out in §2.2.

**Open, permissionless path instead:** AUSD has real independent liquidity on Monad outside
Agora's own gated pool — supply on Monad has grown to ~$184M (the largest deployment of AUSD on
any chain), and it trades on **Kuru Exchange** (a CLOB DEX on Monad with a MON/AUSD pool — Kuru's
own liquidity, unrelated to Agora's whitelist) and reportedly Curve. Acquisition path: get a small
amount of real MON (tradeable on exchanges since Monad's mainnet launch, or from wherever the team
already holds crypto), swap a few dollars of it for AUSD on Kuru, done. Trivial amounts — a demo
needs a few dollars, not meaningful capital. [Source: web search, not Agora's own docs — verify
Kuru's pool is live and has sufficient depth before relying on it, same "verify before trusting"
discipline as everything else in this spec.]

---

## 7. Kimi bounty deliverable: the article

Separate work item from code — plan for it explicitly, don't leave it to the last day. Suggested
angle: how Takumi Agent uses Kimi K2.6's tool-calling to let a non-crypto user execute a real
cross-border stablecoin payment with a sentence, tying concretely to this demo (the exact tool
call shape in §5) rather than writing generically about "AI + crypto." Publish wherever TakumiPay
already publishes technical content; link it from the submission.

---

## 8. Verification checklist (do these before/while building, don't assume)

**Design questions: none left open as of 2026-09-16.** Every item below that is still unchecked
is a *build-time verification or ops step* that can only be closed by doing it (a device test, a
Discord ask, a dependency install), not a decision awaiting a call. Submission-repo setup and the
Community Team Project eligibility check are explicitly parked until the implementation is done
(strategy doc, "Parked until after the build").

- [x] Testnet AUSD mint path — verified 2026-09-16 via `eth_call` on chain `10143`: mint is
      permissioned (custom error `0xdfcadb5b`), no faucet. Resolution: deploy our own open-mint
      6-decimal stand-in for the QRIS testnet leg (§6.6 step 2). Real AUSD stays on the mainnet leg.

- [x] AUSD `decimals()` — verified on-chain via `eth_call` against public Monad RPC 2026-09-14:
      **6**, both mainnet + testnet. Not assumed, not from docs (Agora's docs don't state it).
- [x] AUSD contract addresses (§2.1) — verified via `eth_getCode` (non-empty on both) +
      `symbol()`/`name()` reads (both decode to `"AUSD"`) directly against the deployed contracts,
      2026-09-14. Not just cross-checked against a block explorer — read straight from the chain.
- [ ] Mera PRF support on real Android hardware (not just docs) — **still open, needs a physical
      device test.** Code is in place (`services/walletKit/evm/mera/`, login screen entry
      point); build a development or preview EAS binary and run create + sign-in on a real
      phone. Retest only after `adb shell am force-stop` (Fast Refresh skips `pollyfills.ts`).
- [x] `pnpm check:protofreeze` after adding Mera/`react-native-passkey`/`@noble`/`@scure` deps —
      run 2026-09-16 after `pnpm add @category-labs/mera@0.2.0 react-native-passkey@3.6.1`:
      OK, no new `Object.prototype`-shadowing package. Mera pulls nested
      `@noble/curves@2.2.0` / `@noble/hashes@2.2.0` copies (app pins 1.x); neither offends.
- [x] Hermes `crypto.getRandomValues` — already polyfilled (`react-native-get-random-values` +
      `react-native-quick-crypto` in `pollyfills.ts`); confirmed 2026-09-14, no new work needed —
      just respect the existing import-order contract for any Mera/`react-native-passkey` import
- [x] iOS/Android passkey domain-association files — already exist and are already deployed
      (`landing-page/public/.well-known/`), confirmed 2026-09-14. Android's `assetlinks.json`
      already carries the `get_login_creds` relation needed for passkeys on the main
      `com.planckify.takumiwallet` package. iOS's `apple-app-site-association` still needs a
      `webcredentials` block added (small diff to an existing file) — that remaining piece is
      tracked in §3.3, not a full unknown.
- [x] 1Shot `relayer_getCapabilities` for Monad — **verified live, 2026-09-14, reversing an earlier
      same-day "drop it" call.** Called it directly for chain `"143"`: real `feeCollector`,
      `targetAddress`, accepted fee tokens **USDC + USDT0** (not AUSD — fee leg only, doesn't
      restrict the work leg). Chain `"10143"` (testnet) returned empty — mainnet-only. Also called
      `getSmartAccountsEnvironment(143)` from `@metamask/smart-accounts-kit` directly and confirmed
      via `eth_getCode` that `EIP7702StatelessDeleGatorImpl`, `DelegationManager`,
      `ERC20TransferAmountEnforcer`, and the ERC-4337 `EntryPoint` are all really deployed on Monad
      mainnet. See §4.2 for the full corrected plan.
- [ ] Kimi hackathon credit redemption process (ask in Discord — not found in docs) — ops ask,
      no self-serve path discoverable in Kimi's own docs; doesn't block building (prod Kimi keys
      already live)
- [ ] Written confirmation from organizers on the Agora "staging environment" discrepancy (optional,
      non-blocking since we don't call the API) — low priority; bundle it with the Discord ask
      above, and while there ask Agora whether they hand out testnet AUSD (§6.6 step 2)

Add to the same list:

- [x] Mera-derived signer plugs into `EvmWalletKit` like the mnemonic-derived one (§3.5) —
      resolved 2026-09-16 by NOT using Mera's signing session at all after derivation:
      `services/walletKit/evm/mera/derive.ts` turns the PRF output into a standard
      BIP-39/44 secp256k1 key (Mera's own documented recipe) and the row is stored as
      `type: "Passkey"` with a `privateKey`, so `walletService.getAccountForWallet` builds
      the same viem `privateKeyToAccount` every other EVM row uses. `signAuthorization`,
      delegations, dApp bridge and gasless therefore work unchanged. Trade-off, stated
      plainly: the derived key IS persisted in the auth-gated SecureStore bundle like any
      other wallet (Mera's "never needs to be stored" is a capability we do not exercise);
      the passkey is still the only thing the user ever sees, and re-deriving on a new
      device reproduces the same address.
- [ ] (Only if the recording shows gasless) one USDC-gas AUSD send on Monad mainnet from the demo
      wallet via the existing Gas Settings toggle, to confirm the two-delegation shape in
      `oneShotRelayerProvider.ts` works on Monad the way it does on the chains it was built
      against. Nice-to-have, zero code either way.
- [x] `MockAUSD` deploys to Monad testnet with `decimals() == 6`, and the seeded token row matches
      (§6.6 step 2) — deployed 2026-09-16 at `0x1aC593085Fa34c651E805085da4b2cabAC676F99`,
      `decimals()`/`symbol()`/`name()` read back via `cast` as 6 / AUSD / AUSD; 1,000,000 AUSD
      minted to the deployer. `takumi_pay` 2.1.0 proxy at
      `0x9EEC5aD4FC092fD468A8114007e541238F4Ba5ee` (same address as Arc testnet: same deployer,
      same nonce sequence, genuine CREATE match), MockAUSD allowlisted + 1000 AUSD sweep cap
      applied and verified on-chain. Record: `../contract/evm/deployments/10143.json`.

---

## 9. Landed inventory (2026-09-16)

Everything below is written and typechecks / passes its tests; none of it has been run on a
device yet. Uncommitted at time of writing.

**mobile-app**
- deps: `@category-labs/mera@0.2.0`, `react-native-passkey@3.6.1` (`pnpm check:protofreeze` OK)
- `services/walletKit/evm/mera/{derive,passkeyWallet,errors}.ts` + `derive.test.ts` (node:test)
- `constants/types/walletTypes.ts` — `WalletType` gains `"Passkey"`, `TWallet.passkey` metadata
- `services/walletService.ts` — `Passkey` rows sign via the existing `privateKeyToAccount` dwell
  site; save-tripwire counts them as secret-bearing
- `hooks/usePasskeyOnboarding.ts` — ceremony → wallet placement → switch to Monad 143 → silent
  SIWE handshake; mirrors `useGoogleWalletAuth`'s host/hook split
- `app/login.tsx` — ONE "Continue with fingerprint / Face ID" button (2026-09-16, user's call;
  briefly split into create/sign-in for diagnosis on 2026-09-17, then restored); passkey-only
  in dev and preview (Google / seed / private-key hidden). The hook's `continue` path asserts
  first (any TakumiPay passkey on the device / Google account → same wallet) and creates a new
  passkey only when the OS reports `NoCredentials`. Verified against Mera's docs before
  collapsing the buttons: PRF output is a function of (credential, rpId, salt), the biometric
  is only user verification, and `createPasskeyWithPrfOutput` "creates a new passkey" on every
  call, so a blind create-on-any-failure would silently mint a second wallet. Mera's own RN
  demo keeps two buttons; ours is the same two ceremonies behind one tap.
- **Device finding 2026-09-16 (NOT an app bug): sign-in after create kept offering "use
  another device" / re-creating.** Root-caused from logcat on the user's OPPO phone (8 Google
  accounts): every GPM enumeration (`ListPasskeyCredentialsOperation`) returns `Result size: 0`
  for `takumipay.xyz` although GPM's own UI lists the passkeys, and Chrome + webauthn.io fails
  the same way (`ListChromeSyncKeysForAccountOperation Result size: 0` for 7 of 8 accounts,
  `keyHandle didn't fit localKeyHandle format`). GPM cannot unlock that account's passkey keys
  on that phone, so creation works but assertion sees nothing. Demo/test on a phone with one
  Google account, or fix the account's on-device encryption in GPM. The app's chain (pinned →
  discoverable-immediate → create) behaved correctly at every step in the logs. Confirmed
  2026-09-17 with a third-party control: DANA's own `dana.id` passkey get on the same phone also
  got `Result size: 0` three times and DANA fell back to its PIN; a dev-only probe (long-press
  "I already have an account") showed a plain WebAuthn `get` with no PRF gets the same
  `NoCredentials`, so PRF is ruled out too. Google's DAL API reports the `.dev` package linked.
- **First device failure 2026-09-16: `Passkey creation failed`** on the `.dev` build. Root
  cause: live `assetlinks.json` lacked `get_login_creds` for `com.planckify.takumiwallet.dev`
  (the landing-page change was uncommitted). Pushed as landing-page `cfba128`, live. Mera's
  demo warns react-native-passkey reports this as `RequestFailed` with a misleading
  "missing credentials" message; the `__DEV__` log now prints the native code chain.
- `constants/configs/featureFlags.ts` — `FEATURE_PASSKEY_ONLY_ONBOARDING` defaults **true on
  this branch** (2026-09-16: the dev build was rendering the old login because the flag only
  lived in `eas.json`, which a local `pnpm start` bundle never reads); `eas.json` pins it `true`
  for `development`/`preview` and `false` for `production`, so the Play Store build is untouched
  until the production login gets its own Mera variant later. Flip the default back before
  merging to `main`.
- `app.config.ts` — iOS `webcredentials:takumipay.xyz` associated domain
- `components/wallet/WalletInfoDisplay.tsx` — `Passkey` case (no secret reveal, by design)
- `services/chains/evm/monad.ts` — chain ids, AUSD address, pinned 80k gas for AUSD `transfer`
  (measured 72,918 cold / 55,850 warm); wired into `EvmWalletKit.sendTokenTransfer` and the
  agent's `transfer_erc20` executor
- `services/analytics/events.ts` — `passkey_onboarding_completed` / `_failed`
- `docs/monad-metropolis-2026-kimi-article.md` — Kimi bounty article draft (§7)

**landing-page** — `.well-known/apple-app-site-association` gains `webcredentials` for all three
bundle ids (still carries the pre-existing `TEAM_ID` placeholder — iOS was never wired);
`assetlinks.json` `.preview` and `.dev` entries gain `get_login_creds`.

**contract/evm** — `src/MockAUSD.sol`, `script/DeployMockAUSD.s.sol`, `test/MockAUSD.t.sol`,
`foundry.toml` `monad_testnet` RPC/verifier entries, `deployments/10143.json`, broadcast logs.

**api** — seed: Monad Testnet (10143) blockchain row, MON testnet native token, AUSD mainnet
token (`0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`, 6 dec), MockAUSD testnet token,
`smart-contract-payment-monad-testnet`; `DEFAULT_COUNTRY_ALLOWLIST.ID` adds 10143 (spec test
updated). **Applied to the live dev api DB directly (SQL, not the seed script) on 2026-09-17**,
plus `minConfirmations = 1` on both Monad rows (MonadBFT finality; the demo's "settles in under
a second"). The api process caches its per-chain RPC clients at boot, so a chain added to the DB
was invisible to point-deposit / settlement verification until restart — fixed in api `db532ae`
(refresh on chain create/update/delete + 5-minute cron).

**api — merchant settlement verification (found + fixed 2026-09-17, api `8dc5f43` → `9fc5b62` →
`036bf9e`).** `POST /pay/intents/:id/onchain` only verified Stellar; EVM/Solana were blind-trusted
(any txHash → SETTLED). First fix verified inline, which held the user on a spinner for our side of
the work and stranded real payments when the read raced the chain. Final shape is **non-blocking**:
the endpoint records the hash, moves the intent QUOTED→SIGNED (sweeper-proof), opens the Activity
row as PENDING, enqueues on the `onchain-settlement` BullMQ queue and answers `SETTLING` at once;
`GET /pay/intents/:id` reports `settling` while the worker runs. `OnchainSettlementProcessor`
does Phase A (receipt at `Blockchain.minConfirmations`, Monad = 1; success; `takumi_pay`
recipient; the `MerchantPaymentProcessed` log binding the tx to this intent and naming the real
payer) then Phase B (contract record vs. the signed quote), and applies the shared outcome rule
in `settlement-policy.ts` — also adopted by the point-deposit worker:

| outcome | status | user is told |
|---|---|---|
| verified | SETTLED, payout once (guarded flip), activity COMPLETED | push "Payment sent" |
| chain reverted | FAILED, activity FAILED | "didn't go through, you weren't charged" |
| mined but mismatched | stays SIGNED, row `NEEDS_REVIEW` (ops) | "we're checking" |
| transient (RPC down, no receipt yet, chain client missing, DB) | retried 5s→10min-capped, ~24h | **nothing** |
| retry budget spent | row `NEEDS_REVIEW` | "we're checking" (never "failed") |

Only "reverted or failed" and "mismatch / did not process" count as chain verdicts; everything
else is transient by design. Mobile (`app/pay-merchant.tsx`, `pathOnchainSettlement.ts`,
`useIntentStatus.ts`): real-phase progress card (prepare → sent → confirming), hash handed over
right after broadcast, retried with the same hash and never re-signed, "You can leave this
screen" + Done once the server has it, 1 s polling while `settling`. Point deposits
(`useDepositState.ts`) no longer wait for the receipt client-side; "Deposit sent, we'll let you
know" and the user is free. Activity: the payment row exists as "Confirming" from submit,
`usePaymentDetail` polls while PENDING, `MerchantPaymentHeading` shows the live strip, and the
push handler refreshes Activity / deep-links "checking" and "didn't go through" pushes to the
activity detail. **Needs a new preview build + api redeploy.**

**rpc-proxy** — seed: `/evm/10143` upstream pair (Alchemy `monad-testnet` + public fallback).
**Applied to the live proxy DB directly on 2026-09-17** (live-verified: `eth_chainId` →
`0x279f`).

**Still ops, not code:** run `api` + `rpc-proxy` seeds; fund a demo passkey wallet with MON +
AUSD on mainnet (§6.5); device-test the passkey ceremony (§3.4); record the demo; Discord asks
(Kimi credits, Agora testnet AUSD); submission repo mirror.

---

## Appendix A — Source citations by topic

**Monad chain:** `docs.monad.xyz/developer-essentials/network-information`,
`.../developer-essentials/testnet`, `.../developer-essentials/gas-pricing`,
`.../developer-essentials/differences`, `.../developer-essentials/summary`,
`.../monad-arch/execution/parallel-execution`, `.../monad-arch/transaction-lifecycle`,
`.../tooling-and-infra/rpc-providers`, `.../tooling-and-infra/wallet-infra/account-abstraction`,
`.../guides/mera`, `.../guides/mera/react-native`, `.../guides/brale`, `.../reference/mpp/overview`.
(`developers.monad.xyz` redirects to a marketing page — all real technical docs are under
`docs.monad.xyz`.)

**Agora / AUSD:** `docs.agora.finance/contract-overview`, `.../developer.md`,
`.../developer/contract-deployments.md`, `.../developer/security-and-compliance.md`,
`.../developer/transparency.md`, `.../developer/other-information.md`, `.../api.md`,
`.../api/authentication.md`, `.../api/errors.md`, `.../api/endpoints/accounts/overview.md`,
`.../api/endpoints/routes/overview.md`, `.../api/endpoints/transactions/overview.md`,
`.../instant-settlement.md`, `.../instant-settlement/protocol-deployments.md`,
`.../whitelabels.md`.

**Mera:** `mera.category.xyz`, `github.com/category-labs/mera` (`getting-started.mdx`,
`recipes/use-mera-with-react-native.md`, `demos/mobile/`, `authenticator-support.md`,
`concepts/security-model.mdx`, `reference/index.md`), `monad.xyz/blog/introducing-mera`,
`npmjs.com/package/@category-labs/mera`.

**Kimi / Moonshot:** `platform.kimi.com/docs/overview`, `platform.kimi.ai`,
`platform.kimi.ai/docs/guide/use-kimi-api-to-complete-tool-calls`,
`platform.kimi.ai/docs/pricing/promotion`, `platform.kimi.ai/docs/pricing/limits`,
`monad.xyz/developers/hackathons/metropolis`.

**1Shot / ERC-7710 relayer:** `.claude/skills/public-relayer/SKILL.md` (this repo's own integration
skill — order of operations, `relayer_getCapabilities`/`relayer_estimate7710Transaction`/
`relayer_send7710Transaction` schemas, EIP-7702 + delegation prerequisites, error catalog).

**MetaMask Smart Accounts Kit:** `docs.metamask.io/smart-accounts-kit/get-started/supported-networks/`
(lists Monad mainnet + testnet as supported across SDK v1.5.0–v2.0.0).

**Repo facts (verified directly, not via subagent):** `api/src/scripts/prisma/seed.ts` (Monad
blockchain + MON token rows), `services/gasAbstraction/supportedChains.ts`,
`agent-api/src/agents/models.ts` (`moonshotProvider`, `kimi-k2.6`),
`agent-api/src/agents/wallet/tools/capabilities.ts` (`send_native`/`send_token`),
`app/send.tsx`, `services/walletKit/evm/signTransferWithAuthorization.ts` (Circle
Gateway-specific, not a generic ERC-3009 signer), `services/walletKit/evm/relayer.ts` (generic
1Shot JSON-RPC client, chainId/transactions/executions-shaped — not x402-specific),
`services/walletKit/evm/delegations.ts` (generic ERC-7710 delegation builder, real reuse for
Tier 2 — §4.2), `services/walletKit/evm/EvmWalletKit.ts` (`getSmartAccountsEnvironment` already
called generically by chainId), `services/walletKit/evm/rails/RelayerBroadcastRail.ts`
(x402-settlement-specific wrapper — not directly reusable, but its pattern is — see §4.2),
`services/walletKit/evm/rails/Erc7710FacilitatorRail.ts` (disabled by default, buyer SDK not yet a
dependency), `services/walletKit/evm/sendUserOpWithUsdcPaymaster.ts` (Circle Paymaster,
Base/Arbitrum + USDC only — not Monad-applicable), `constants/configs/chainConfig.ts`,
`landing-page/public/.well-known/{apple-app-site-association,assetlinks.json}`.

Direct on-chain reads (public Monad RPC, `eth_call`/`eth_getCode`, 2026-09-14): AUSD `decimals()`,
`symbol()`, `name()`, `totalSupply()` on both mainnet
(`0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`) and testnet
(`0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC`) contract addresses; MetaMask smart-accounts-kit's
`EIP7702StatelessDeleGatorImpl`, `DelegationManager`, `ERC20TransferAmountEnforcer`, and the
ERC-4337 `EntryPoint` bytecode on Monad mainnet. Direct live JSON-RPC calls: 1Shot
`relayer_getCapabilities` for chain `"143"` (`relayer.1shotapi.com/relayers`).
