# Wallet Security Vulnerabilities Specification

**Project:** TakumiAI Wallet (`/mobile-app`)
**Document status:** v1.0 — engineering reference
**Audience:** Engineering, security review, threat-model reviewers
**Last reviewed:** 2026-04-16

---

## 1. Purpose

This document catalogues known, publicly documented vulnerabilities and attack classes that have historically compromised EVM cryptocurrency wallets (both browser-extension and mobile form factors), and maps each one to concrete engineering mitigations for the TakumiAI Wallet stack:

- **Runtime:** React Native / Expo 54 (Hermes, New Architecture)
- **Key storage:** `expo-secure-store` (iOS Keychain / Android Keystore)
- **Chain I/O:** Viem clients, multi-chain EVM + Solana
- **DApp surface:** `react-native-webview` + EIP-1193 injected provider (`services/bridge/DappBridge.ts`, `services/chains/evm/injectedScript.ts`), EIP-6963 discovery, WalletConnect
- **AI agent:** Vercel AI SDK with tool-calling and on-chain executors (`services/agent-executors/*`)
- **Transport:** Deep links, SSE for agent sessions, direct RPC (`services/indexer/DirectRPCProvider.ts`)

Every entry is grounded in a CVE, GHSA, incident post-mortem, or published vulnerability class. Speculative items are explicitly marked.

## 2. Scope

**In scope:** EVM wallets (extension + mobile), signature phishing, key storage, dApp browser / EIP-1193 provider attacks, supply-chain, mobile-platform leaks, deep-link hijacking, RPC trust issues, and EIP-7702 delegation attacks.

**Out of scope:** Smart-contract bugs in third-party protocols (use SWC Registry), CEX custody breaches, purely social-engineering attacks that do not involve wallet software (e.g., OTC scams).

## 3. Numbering Scheme — `TWV-YYYY-NNN`

There is no central registry for cryptocurrency wallet vulnerability classes. Existing systems cover only a slice:

| Registry | Coverage | Gap for wallets |
| --- | --- | --- |
| **CVE / NVD** (MITRE) | Assigned to named wallet software (e.g. CVE-2022-32969 MetaMask, CVE-2023-31290 Trust Wallet Core). | Not assigned to design-level attack classes (e.g. approval phishing, address poisoning). |
| **GHSA** (GitHub Security Advisories) | OSS package advisories (e.g. GHSA-h9g9-j2c8-v8gv for MetaMask Demonic). | Only open-source projects with hosted repos. |
| **SWC Registry** | Smart-contract weakness taxonomy. | Does not cover client-side wallet software at all. |
| **Rekt.news / SlowMist / Immunefi** | Incident post-mortems. | Narrative, not normative; no IDs. |

We adopt a project-local prefix **`TWV`** (TakumiAI Wallet Vulnerability) with format `TWV-YYYY-NNN`:

- `YYYY` = catalogue year (this document's revision year — 2026).
- `NNN` = zero-padded monotonic counter, grouped by category block.

Every entry carries a **Known Incidents / CVE / GHSA** field that maps it to upstream identifiers where they exist. When no identifier exists, the row reads `No CVE — tracked via <source>`.

## 4. Executive Summary

**Total entries:** 65, spanning thirteen categories.

| # | Category | Count | Examples |
| --- | --- | --- | --- |
| 1 | Key Management & Storage | 6 | MetaMask Demonic (CVE-2022-32969), Slope Sentry logging, iCloud backup theft, Trust Wallet entropy (CVE-2023-31290) |
| 2 | Signature Phishing & Approvals | 6 | `eth_sign` blank check, Permit2/EIP-2612, `setApprovalForAll` ice phishing, EIP-7702 delegator |
| 3 | DApp Browser / EIP-1193 | 5 | WebView UXSS (CVE-2020-6506), Red Pill simulation evasion, Chain ID spoofing |
| 4 | Supply Chain | 4 | Ledger Connect Kit (Dec 2023), `event-stream`/Copay, fake extensions, malicious React Native deps |
| 5 | Mobile Platform | 5 | Clipboard hijacking, screenshot/OCR theft, deep-link hijacking, Frida/jailbreak, keyboard cache |
| 6 | RPC / Network | 3 | MyEtherWallet BGP, malicious RPC node, EIP-155 replay |
| 7 | Session / Protocol | 3 | WalletConnect session hijack (CVE-2022-28843), EIP-6963 collision, Electrum-style server phishing |
| 8 | Major 2024–2025 Incidents (Signer UI Integrity & Operational) | 8 | Bybit $1.4B Safe{Wallet}, WazirX $230M Liminal, Radiant $50M macOS malware, DMM $305M, Phemex $85M, Penpie $27M, Orbit $82M, Wintermute/Profanity $160M |
| 9 | Account Abstraction (ERC-4337 & EIP-7702) | 5 | Paymaster griefing, bundler censorship/MEV, social-recovery guardian takeover, UserOp signature malleability, gas griefing |
| 10 | Hardware Wallet & HW Pairing | 3 | Dark Skippy nonce exfiltration, Ledger Nano X BLE/voltage-glitch, Ledger Recover custody controversy |
| 11 | Additional Signature / Protocol | 6 | EIP-3085 explorer abuse, pending-tx MEV leak, airdrop drainer farms, IDN homograph, Uniswap v4 hook confusion, push-notification phishing |
| 12 | Mobile / Expo / React Native Platform (Extended) | 8 | EAS Update OTA attack, Hermes bytecode extraction, JSC memory dump, RN bridge Frida hooking, `allowBackup=true`, iOS Keychain accessibility misuse, biometric rebinding, StrongBox attestation bypass |
| 13 | Extension / Desktop Pair (Informational) | 3 | MetaMask clipboard auto-paste, fullscreen-dApp UI spoofing, fake Ledger Live / Trezor Bridge |

## 5. Severity Rubric

Severity is wallet-impact-specific, roughly mapped to CVSS v3.1 base score bands.

| Severity | Wallet-specific definition | CVSS band |
| --- | --- | --- |
| **Critical** | Full private key / seed phrase exfiltration or silent total drain of all assets, reachable remotely or at scale, without user interaction beyond normal usage. | 9.0–10.0 |
| **High** | Unbounded asset drain requiring one user misclick or signature (e.g. approval phishing), OR partial key compromise, OR remote code execution in wallet process. | 7.0–8.9 |
| **Medium** | Bounded asset loss (single tx, one token/NFT), user confusion attacks (address poisoning), session hijack with limited blast radius. | 4.0–6.9 |
| **Low** | Information disclosure without direct asset impact (metadata, analytics leaks), UX weaknesses not yet exploitable without additional bugs. | 0.1–3.9 |

A "Critical" finding triggers release-block; "High" triggers must-fix in next release; "Medium/Low" tracked in the backlog.

---

## 6. Vulnerability Catalogue

### Category 1 — Key Management & Storage

---

#### TWV-2026-001: Browser "Restore Session" Leaks Seed Phrase to Disk (Demonic)
- **Severity:** Critical
- **Category:** Key Management
- **Affected Wallet Types:** Extension (primary), Mobile (if any WebView form ever hosts seed input)
- **Known Incidents / CVE / GHSA:** CVE-2022-32969, GHSA-h9g9-j2c8-v8gv — MetaMask <10.11.3, Phantom, Brave, xDefi. Disclosed by Halborn ("Demonic").
- **Description:** Firefox/Chromium persist contents of non-password `<input>` fields to disk as part of session restore. Wallets that rendered the BIP-39 mnemonic as plain text in a standard textarea left the seed phrase decrypted on disk, recoverable by anyone with file-system access or post-exploitation malware.
- **Root Cause:** Using `type="text"` for seed entry; relying on browser memory hygiene instead of marking the field as sensitive (`type="password"`, `autocomplete="off"`, and clearing on blur).
- **Mitigation:**
  - Never render the mnemonic in any text input. Use split-word inputs with `secureTextEntry={true}` and `autoComplete="off"` on every `TextInput` (React Native defaults).
  - On Android set `FLAG_SECURE` on any screen that displays seed phrase (see TWV-2026-021).
  - Zero out JS strings after hashing to seed (`mnemonic.split(' ').fill('')` — note JS cannot guarantee erasure; minimise dwell time).
  - Never paste/auto-fill the seed; block iOS QuickType / Android suggestions with `autoCorrect={false}` `spellCheck={false}` `textContentType="none"`.
- **TakumiAI Applicability:** Applies. Seed-generation and import flows render into native `TextInput`. Audit `components/` for any seed-entry UI missing `secureTextEntry` and `autoComplete="off"`. No WebView renders the seed today, but the dApp-browser `WebView` must never be allowed to load an origin that asks for it.
- **References:**
  - https://www.halborn.com/disclosures/demonic-vulnerability
  - https://nvd.nist.gov/vuln/detail/CVE-2022-32969
  - https://github.com/advisories/GHSA-h9g9-j2c8-v8gv

---

#### TWV-2026-002: Weak Entropy for Mnemonic Generation (Mersenne Twister)
- **Severity:** Critical
- **Category:** Key Management
- **Affected Wallet Types:** Both (any wallet that seeds from a non-CSPRNG)
- **Known Incidents / CVE / GHSA:** CVE-2023-31290, GHSA-pm4f-pggw-8jwc — Trust Wallet Core <3.1.1 used mt19937 seeded with a 32-bit value. $6M+ exploited late 2022/early 2023. Also see the "Milk Sad" disclosure for Libbitcoin Explorer.
- **Description:** A 32-bit seed limits the keyspace to 4 billion — brute-forceable within minutes. Any address observed on-chain can be reverse-searched.
- **Root Cause:** Use of a non-cryptographic PRNG (mt19937) and/or a CSPRNG seeded with a 32-bit value, typically in Wasm/browser environments where `crypto.getRandomValues` wasn't wired up.
- **Mitigation:**
  - On React Native, seed all wallet creation with `expo-crypto` `getRandomBytesAsync(16|32)` which delegates to iOS `SecRandomCopyBytes` / Android `SecureRandom`.
  - If using Viem, rely on `generatePrivateKey()` (calls `crypto.getRandomValues` — already seeded correctly in RN + Hermes polyfill).
  - Include a unit test that asserts entropy source is `react-native-get-random-values`/`expo-crypto`, not `Math.random` or mt19937.
  - Never reimplement BIP-39 entropy; use `@scure/bip39` + OS randomness.
- **TakumiAI Applicability:** Applies directly. Verify `services/walletService.ts` seed generation uses OS CSPRNG. Check `pollyfills.ts` for `react-native-get-random-values` import at app entry (required before any Viem call).
- **References:**
  - https://nvd.nist.gov/vuln/detail/CVE-2023-31290
  - https://milksad.info/disclosure.html
  - https://www.ledger.com/blog/funds-of-every-wallet-created-with-the-trust-wallet-browser-extension-could-have-been-stolen

---

#### TWV-2026-003: Seed Phrase Exfiltrated Via Crash/Analytics Telemetry (Slope/Sentry)
- **Severity:** Critical
- **Category:** Key Management
- **Affected Wallet Types:** Mobile
- **Known Incidents / CVE / GHSA:** No CVE — tracked via Slope Wallet post-mortem & Sentry disclosure (Aug 2022). ~9,200 wallets drained, ~$4.1M. Mnemonics broadcast in clear text to `o7e.slope.finance`.
- **Description:** Slope's iOS/Android apps forwarded every interaction event to a self-hosted Sentry instance without PII scrubbing. Seed phrases entered in import screens were captured in breadcrumbs/transaction payloads and uploaded plaintext.
- **Root Cause:** Default Sentry breadcrumb capture of input state, plus no `beforeSend` scrubber, plus no denylist of sensitive screens. A single misconfigured observability SDK exfiltrated keys silently.
- **Mitigation:**
  - Disable all breadcrumb + default integrations on screens that touch seed phrase, private key, PIN, or signature material.
  - Configure `beforeSend` / `beforeBreadcrumb` to drop any event whose route matches `/seed*`, `/import*`, `/backup*`, or contains 12/24 BIP-39 words (regex: `\b(?:\w+\s+){11,23}\w+\b` — coarse but failsafe).
  - Tag sensitive components with a boundary that calls `Sentry.withScope(s => s.setTag('sensitive', true))` and drop in `beforeSend`.
  - Never log the raw redux/state slice containing wallet material. Add a lint rule against `console.log(wallet`, `console.log(mnemonic`, etc.
  - Apply the same rules to PostHog, Datadog, Firebase Crashlytics, and any future observability SDK.
- **TakumiAI Applicability:** Applies. Audit whether Sentry/PostHog/any logger is configured. Even if not today, bake in scrubbers now before someone adds observability later. Check `services/bridge/redact.ts` — this redaction layer should be used everywhere sensitive material could leak.
- **References:**
  - https://blog.sentry.io/slope-wallet-solana-hack/
  - https://slope-finance.medium.com/slope-wallet-sentry-vulnerability-digital-forensics-and-incident-response-report-d7a5904e5a39
  - https://ackee.xyz/blog/2022-solana-hacks-explained-slope-wallet/

---

#### TWV-2026-004: Seed Phrase Leaked Via Unencrypted iCloud / Google Drive Backup
- **Severity:** High
- **Category:** Key Management / Mobile Platform
- **Affected Wallet Types:** Mobile
- **Known Incidents / CVE / GHSA:** No CVE — tracked via MetaMask 2022 iOS warning (≥$655k stolen in one incident).
- **Description:** iOS full-device backups (iCloud) and Android Auto Backup capture app-private storage by default. If a wallet stores the seed in `UserDefaults`, plain `AsyncStorage`, or loosely-configured keychain, the seed is replicated to the cloud, where an Apple-ID or Google-account phish becomes a seed compromise.
- **Root Cause:** Incorrect `kSecAttrAccessible` / missing `ThisDeviceOnly` accessibility; Android Auto Backup enabled on sensitive data; use of non-secure storage.
- **Mitigation:**
  - Only store seed/private keys in `expo-secure-store` with `SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY` (iOS) — this keychain class is **not** copied via iCloud.
  - On Android, set `android:allowBackup="false"` in `AndroidManifest.xml` and add `android:dataExtractionRules` (API 31+) excluding the secure-store keystore prefs.
  - Never store seed in `AsyncStorage`, `MMKV` (without encryption), Redux Persist, or plain files.
  - Document in-app that the user's Apple ID / Google account is NOT a backup path.
- **TakumiAI Applicability:** Applies. Verify every `SecureStore.setItemAsync` call passes `{ keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY }`. Check `app.json` / `app.config.ts` for `android:allowBackup`. Audit `useWallet.ts` persistence paths.
- **References:**
  - https://www.bleepingcomputer.com/news/security/hackers-steal-655k-after-picking-metamask-seed-from-icloud-backup/
  - https://docs.expo.dev/versions/latest/sdk/securestore/
  - https://medium.com/zengo/demystifying-icloud-security-wallets-e348516914d9

---

#### TWV-2026-005: Keyboard Cache / Predictive Text Retains Seed Words
- **Severity:** High
- **Category:** Key Management / Mobile Platform
- **Affected Wallet Types:** Mobile
- **Known Incidents / CVE / GHSA:** No CVE — long-documented OWASP MASVS-STORAGE-2 class.
- **Description:** iOS QuickType and Android GBoard/Samsung Keyboard can learn words typed into non-secure fields. A later victim typing into Mail/Notes can see seed words appear in suggestions, and some third-party keyboards (including malicious ones installed by the user) upload keystrokes to remote servers.
- **Root Cause:** Seed input field not flagged as non-learnable.
- **Mitigation:**
  - On every seed-input `TextInput`: `autoCorrect={false}`, `spellCheck={false}`, `autoCapitalize="none"`, `textContentType="none"` (iOS), `keyboardType="visible-password"` (Android disables suggestions), `importantForAutofill="no"` (Android), `secureTextEntry` where practical.
  - Recommend in onboarding: "Use the system keyboard, not a third-party keyboard, when restoring."
  - Consider a custom in-app keyboard for seed entry (ultimate defense, high UX cost).
- **TakumiAI Applicability:** Applies. Audit every seed-import component for the exact prop set above.
- **References:**
  - https://zimperium.com/glossary/mnemonic-phrase
  - https://owasp.org/www-project-mobile-app-security/

---

#### TWV-2026-006: Third-Party Wallet Software Exfiltrates Keys via Malware/Insider
- **Severity:** Critical
- **Category:** Key Management / Supply Chain
- **Affected Wallet Types:** Both
- **Known Incidents / CVE / GHSA:** No CVE — Atomic Wallet $100M (Jun 2023, attributed to Lazarus); root cause never fully disclosed. Probable trojanised build, infrastructure breach, or malware code injection.
- **Description:** A wallet binary or build pipeline is compromised; shipped versions contain code that exfiltrates keys or signs malicious txs. Users are fully patched yet fully exposed.
- **Root Cause:** Weak release integrity (unsigned releases, no reproducible builds, compromised developer machines, no hardware-signing of release artefacts).
- **Mitigation:**
  - Use EAS Build with protected secrets and review every build's source commit.
  - Enforce hardware-backed code-signing keys (Apple: ADP cert in hardware, Android: Play App Signing).
  - Reproducible builds where possible; publish SHA-256 of store binaries.
  - Developer laptops in a managed/hardened posture; no seed material ever on developer machines.
  - SBOM generation (`pnpm audit`, `npm-audit-report`) gated in CI.
- **TakumiAI Applicability:** Applies. Validate EAS build pipeline; never inject mnemonics into test builds; add a pre-publish checklist that includes a clean `pnpm install --frozen-lockfile` and lockfile diff review.
- **References:**
  - https://www.halborn.com/blog/post/explained-the-atomic-wallet-hack-june-2023
  - https://www.trmlabs.com/resources/blog/inside-north-koreas-crypto-heists

---

### Category 2 — Signature Phishing & Approvals

---

#### TWV-2026-007: `eth_sign` Blank-Check Signature Phishing
- **Severity:** Critical
- **Category:** Signature Phishing
- **Affected Wallet Types:** Both
- **Known Incidents / CVE / GHSA:** No CVE — tracked via SlowMist "Blank Check eth_sign" writeups. Class of drain responsible for tens of millions in cumulative losses.
- **Description:** `eth_sign` signs an arbitrary 32-byte hash. An attacker can compute the hash of a fully-formed transaction (e.g., an ERC-20 `transfer` of the user's USDC to the attacker) and trick the user into signing that hash. The signature can then be used by the attacker to broadcast the tx, effectively letting them sign arbitrary transactions as the user.
- **Root Cause:** `eth_sign` exposes raw hash signing with no structured data, so the UI cannot show the user what they are actually authorising.
- **Mitigation:**
  - Reject `eth_sign` entirely. Return `{ code: 4200, message: 'eth_sign is deprecated and unsupported' }`.
  - Only allow `personal_sign` (with ASCII-only payloads, render as string) and `eth_signTypedData_v4` (structured display).
  - For `personal_sign`, render the message exactly as bytes+UTF-8, warn if it contains hex that looks like a txhash/selector.
- **TakumiAI Applicability:** Applies directly to `services/bridge/DappBridge.ts` — ensure `eth_sign` is not routed. Add a unit test asserting the bridge returns an error on `eth_sign`.
- **References:**
  - https://slowmist.medium.com/slow-mist-blank-check-eth-sign-phishing-analysis-741115bd0b1f
  - https://support.metamask.io/privacy-and-security/what-is-eth_sign-and-why-is-it-a-risk/

---

#### TWV-2026-008: ERC-2612 `permit()` / Permit2 Off-Chain Signature Phishing
- **Severity:** High
- **Category:** Signature Phishing
- **Affected Wallet Types:** Both
- **Known Incidents / CVE / GHSA:** No CVE — tracked via ScamSniffer/SlowMist. ~$35M single incident; ongoing drainer category (Inferno, Pink, Angel).
- **Description:** EIP-2612 and Uniswap's Permit2 allow an off-chain signature to grant spending allowance without an on-chain `approve`. Wallet UIs historically showed these as "just a signature" with no gas fee, so users underestimated the impact. An attacker submits the signed permit and drains the balance.
- **Root Cause:** Wallet displays of EIP-712 signatures were insufficiently decoded; users could not see `spender`, `value`, and `deadline`.
- **Mitigation:**
  - Fully decode EIP-712 `Permit` and Permit2 `PermitSingle`/`PermitBatch`/`PermitTransferFrom` structures. Show: token symbol, spender (with contract-known-name lookup), amount (with `Unlimited` warning for `2^256-1`), deadline.
  - Warn in red if `spender` is not in a known-safe list (Uniswap/1inch/etc.) and is freshly deployed (< 30 days).
  - Show a "This signature acts like an approval — the site can move the full amount at any time before the deadline" banner.
  - Maintain a `permit` revocation flow: surface active permits via indexer and let the user front-run with `approve(0)` or Permit2 `invalidateNonces`.
- **TakumiAI Applicability:** Applies directly. `services/decoders/erc2612.ts` and `services/decoders/permit2.ts` exist — validate they cover all Permit2 variants and are called unconditionally before displaying any `eth_signTypedData_v4`. `hooks/queries/useTokenApprovals.ts` should also index Permit2 allowances.
- **References:**
  - https://slowmist.medium.com/examining-permit-signatures-is-phishing-of-tokens-possible-via-off-chain-signatures-bfb5723a5e9
  - https://www.veritasprotocol.com/blog/permit-signature-risk-scanner-eip-2612-checks
  - https://github.com/Uniswap/permit2

---

#### TWV-2026-009: `setApprovalForAll` Ice Phishing (NFT & Token)
- **Severity:** High
- **Category:** Signature Phishing
- **Affected Wallet Types:** Both
- **Known Incidents / CVE / GHSA:** No CVE — tracked via Microsoft MSRC "Ice Phishing" (Feb 2022), ongoing class. Monkey/Venom/Inferno drainers.
- **Description:** ERC-721/1155's `setApprovalForAll(operator, true)` grants an operator the right to transfer **every** NFT held by the wallet on that collection, including future ones. Similar to `approve(uint256 max)` for ERC-20. Attackers present this as a "mint" or "claim" on a spoofed site.
- **Root Cause:** Overly broad approval semantics built into the token standards, combined with wallets that display these txs generically ("Contract Interaction").
- **Mitigation:**
  - Decode calldata selector-by-selector. For `setApprovalForAll`, show an explicit red banner: "This gives CONTRACT permission to move ALL your NFTs in COLLECTION. It is almost never required for a legitimate mint."
  - For `approve(uint256)`, warn on `>= type(uint256).max / 2`.
  - Integrate a simulator (see TWV-2026-014 Red Pill awareness) to show the net asset delta.
  - Maintain an in-app "Approvals" screen (analogous to revoke.cash) to one-click revoke.
- **TakumiAI Applicability:** Applies. `services/decoders/calldata.ts` must decode ERC-721/1155 `setApprovalForAll`. The approvals screen should be a first-class view.
- **References:**
  - https://www.microsoft.com/security/blog/2022/02/16/ice-phishing-on-the-blockchain/
  - https://medium.com/coinmonks/wallet-drainers-a-300-million-crypto-scam-as-a-service-industry-09aa1d44172e

---

#### TWV-2026-010: EIP-7702 Delegation Authorization Phishing
- **Severity:** Critical
- **Category:** Signature Phishing
- **Affected Wallet Types:** Both (post-Pectra)
- **Known Incidents / CVE / GHSA:** No CVE — tracked via arXiv 2512.12174 "EIP-7702 Phishing Attack" and SunSec's DeFiHackLabs analysis. Multiple malicious delegator contracts already deployed with high authorization counts.
- **Description:** EIP-7702 lets an EOA sign a single `authorization tuple` binding the account to a delegate smart-contract. Once signed, every subsequent call to the EOA routes through the delegate. A malicious delegate can sweep assets automatically on every incoming transfer, or expose arbitrary functions an attacker can call.
- **Root Cause:** The authorization is expressed as a tuple (`chainId, address, nonce`) signed outside normal tx flow; wallets that display it as a generic signature do not convey the "this rewires your entire account" semantics.
- **Mitigation:**
  - Implement an EIP-7702 authorization UI that explicitly says "This REWIRES your wallet. All future calls to your address will run code at CONTRACT."
  - Maintain a signed allowlist of known-good delegator contracts (MetaMask's, Safe's, OpenZeppelin's). Hard-block others or demand a typed confirmation phrase.
  - Refuse authorizations for contracts whose bytecode contains `SELFDESTRUCT` in the prologue or calls an unknown fallback.
  - Show the current delegation status on the wallet home screen; offer one-click "revoke delegation" (set to zero address).
- **TakumiAI Applicability:** Applies. The project already ships `docs/eip7702-delegator-allowlist-spec.md` — cross-reference it and ensure the allowlist is enforced at the signing boundary, not only at UI.
- **References:**
  - https://arxiv.org/abs/2512.12174
  - https://defihacklabs.substack.com/p/top-7702-delegator-revealed-as-phishing
  - https://www.halborn.com/blog/post/eip-7702-security-considerations

---

#### TWV-2026-011: Blind-Signing of Complex Transactions (Radiant Capital)
- **Severity:** High
- **Category:** Signature Phishing / Display Integrity
- **Affected Wallet Types:** Both (hardware integrations particularly)
- **Known Incidents / CVE / GHSA:** No CVE — Radiant Capital, Oct 2024, ~$50M. Safe{Wallet} front-end tampering + Ledger display unable to parse Gnosis Safe calldata.
- **Description:** Attacker malware swaps transaction parameters between the dApp front-end and the signing device. The signer sees only the generic summary ("Contract Interaction, $0 ETH") and approves; the actual call is `transferOwnership(attacker)` or equivalent.
- **Root Cause:** Wallet does not independently parse/simulate/display the real calldata; trusts the dApp front-end presentation.
- **Mitigation:**
  - Server-independent transaction simulation using `eth_call` / `debug_traceCall` against a trusted public RPC (Alchemy/Infura/Quicknode) OR locally via a forked node. Compare state delta to what the dApp claims.
  - Decode every top-level and internal function call (incl. Safe `execTransaction`, multicall, aggregator routes).
  - Display **asset changes** (ETH/ERC-20/ERC-721 net in/out) as the primary UX element, not the opaque calldata.
  - For multisig/Safe flows, fetch the Safe tx hash from the Safe API and verify it client-side.
  - Integrate a risk engine (Blockaid / GoPlus / Forta) as a non-authoritative second opinion.
- **TakumiAI Applicability:** Applies. `services/agent-executors/simulate.ts` exists — verify it runs before every user-signed and agent-signed tx, and that the UI blocks signature on simulator error.
- **References:**
  - https://medium.com/@RadiantCapital/radiant-post-mortem-fecd6cd38081
  - https://www.halborn.com/blog/post/explained-the-radiant-capital-hack-october-2024

---

#### TWV-2026-012: Typed-Data Domain Separator Confusion / Cross-Dapp Replay
- **Severity:** Medium
- **Category:** Signature Phishing
- **Affected Wallet Types:** Both
- **Known Incidents / CVE / GHSA:** No CVE — class described in EIP-712 rationale and many audit reports.
- **Description:** If a dApp's contract reuses a signature scheme whose `domainSeparator` is reused across deployments (same `name, version, chainId, verifyingContract` not fully bound), a signature signed for one context can be replayed in another.
- **Root Cause:** Misimplemented `EIP712Domain` on the contract side AND wallet UIs that don't show `verifyingContract`/`chainId` to the user.
- **Mitigation:**
  - Wallet MUST display `domain.verifyingContract`, `domain.chainId`, `domain.name`, `domain.version` to the user.
  - Reject typed data where `chainId` doesn't match the currently selected chain (or show a loud warning).
  - Never allow a dApp's injected provider to silently switch chain then immediately request a signature; enforce a user-visible chain-switch confirmation (see TWV-2026-017).
- **TakumiAI Applicability:** Applies. Decoder in `services/decoders/` should surface full EIP-712 domain to the UI, and the signer UI should block if `chainId` != active chain.
- **References:**
  - https://eips.ethereum.org/EIPS/eip-712
  - https://www.cyfrin.io/blog/understanding-ethereum-signature-standards-eip-191-eip-712

---

### Category 3 — DApp Browser / EIP-1193

---

#### TWV-2026-013: Android WebView Universal XSS (Cross-Origin Iframe)
- **Severity:** High
- **Category:** DApp Browser
- **Affected Wallet Types:** Mobile
- **Known Incidents / CVE / GHSA:** CVE-2020-6506 — universal XSS in Android WebView <83.0.4103.106 affecting `react-native-webview` apps that navigate to arbitrary URLs.
- **Description:** A cross-origin iframe could execute JS in the top-level document. In a wallet context, a phishing page embedding a legitimate-looking site could read the injected EIP-1193 provider's state, call `eth_requestAccounts`, and trigger signatures as if it were the legitimate origin.
- **Root Cause:** Defective origin enforcement in `android.webkit.WebView`; the wallet assumed top-frame origin is the requester but message-bridge calls could come from any frame.
- **Mitigation:**
  - Pin a minimum Android WebView version at runtime; refuse to load dApps if the system WebView is below 83.0.4103.106 (use `WebSettings.getDefaultUserAgent` or a runtime check).
  - Keep `react-native-webview` ≥ 11.0.0 and pass `setSupportMultipleWindows={false}`, `allowsInlineMediaPlayback={false}`, `originWhitelist={['https://*']}` (no `http`, no `file`).
  - Only accept injected-provider calls whose message frame origin matches the top frame. Implement origin tracking via `onShouldStartLoadWithRequest` and `onNavigationStateChange`; bind every EIP-1193 request to the current top origin at call time.
  - Disable third-party cookies, block `file://` navigation, disable mixed content.
- **TakumiAI Applicability:** Applies directly to the dApp browser at `components/dapps-browser/`, `services/chains/evm/injectedScript.ts`, `services/bridge/DappBridge.ts`. The inspector classes under `services/bridge/inspectors/` should enforce the origin pin.
- **References:**
  - https://github.com/react-native-webview/react-native-webview/security/advisories/GHSA-36j3-xxf7-4pqg
  - https://security.snyk.io/vuln/SNYK-JS-REACTNATIVEWEBVIEW-1011954
  - https://alesandroortiz.com/articles/uxss-android-webview-cve-2020-6506/

---

#### TWV-2026-014: "Red Pill" Simulation Evasion
- **Severity:** High
- **Category:** DApp Browser / Signature Display
- **Affected Wallet Types:** Both
- **Known Incidents / CVE / GHSA:** No CVE — ZenGo disclosure to Coinbase Wallet and several dapps (2022). Bug bounties awarded.
- **Description:** A malicious contract detects it is being run inside a simulation (`block.difficulty == 0` pre-merge, or `prevrandao`/`coinbase`/`gasprice` heuristics) and returns benign-looking state changes. When actually mined, it drains funds.
- **Root Cause:** Wallet transaction simulators used default node RPC `eth_call`/`trace_call` semantics with predictable context, which the attacker contract can fingerprint.
- **Mitigation:**
  - Simulator must randomise `block.prevrandao`, `block.timestamp` (slight jitter), `tx.origin`, `msg.value` context to match realistic production values.
  - Simulate against multiple RPC providers and compare deltas — mismatches imply evasion.
  - Flag any contract whose simulated behaviour differs from its recent mined behaviour (Blockaid/GoPlus-style reputation).
  - Never use the simulation as the *sole* safety signal; combine with calldata decoding and allowlist checks.
- **TakumiAI Applicability:** Applies. `services/agent-executors/simulate.ts` should be reviewed for red-pill resistance. If relying on a third-party simulation service, confirm it implements context randomisation.
- **References:**
  - https://www.bleepingcomputer.com/news/security/coinbase-wallet-red-pill-flaw-allowed-attacks-to-evade-detection/

---

#### TWV-2026-015: EIP-1193 Provider Injection from Untrusted WebView Frames
- **Severity:** High
- **Category:** DApp Browser
- **Affected Wallet Types:** Mobile
- **Known Incidents / CVE / GHSA:** No CVE — class documented by Zellic, Android Developer docs, and OWASP MASVS.
- **Description:** RN's `RNCWebViewBridge.postMessage` is accessible from every frame inside the WebView by default. A sandboxed third-party ad iframe could call `postMessage` with a forged EIP-1193 payload and cause the wallet to display a signature prompt that the user attributes to the top-level dApp.
- **Root Cause:** No origin information is passed with `postMessage`; the app can't tell which frame sent the request.
- **Mitigation:**
  - Inject the provider only via `injectedJavaScript` into the top frame; emit a nonce per page-load and require messages to carry it.
  - Wrap all provider calls with `window.location.origin` (captured at page-load) and sign it with a per-session HMAC the native side can verify.
  - On native side, reject messages whose declared origin doesn't match what `onNavigationStateChange` reports for the top frame at the moment of send.
  - Disable third-party frames entirely where practical (`setBlockNetworkImage` / `setMixedContentMode=NEVER_ALLOW`), or use `sandbox` iframes that cannot postMessage across.
- **TakumiAI Applicability:** Applies. `services/chains/evm/injectedScript.ts` and the message handler in `services/bridge/` should enforce a per-session nonce + origin pin.
- **References:**
  - https://www.zellic.io/blog/webview-security/
  - https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges
  - https://haxoris.com/haxoris-wiki/mobile-owasp-top-10/m4-insufficient-input-output-validation/webview-javascript-bridge

---

#### TWV-2026-016: Malicious `wallet_addEthereumChain` RPC Injection
- **Severity:** High
- **Category:** DApp Browser / RPC Trust
- **Affected Wallet Types:** Both
- **Known Incidents / CVE / GHSA:** No CVE — class described in EIP-3085 and EIP-3326 security considerations.
- **Description:** A dApp calls `wallet_addEthereumChain({chainId, rpcUrls, ...})` with a chain that claims `chainId=1` but whose RPC is attacker-controlled. If the wallet uses the `chainId` returned from the RPC (via `eth_chainId`) rather than the one supplied / user-confirmed, transactions signed for "mainnet" are actually broadcast to a fork. Worse, the RPC can proxy all `eth_call` reads to real mainnet to look legitimate, then replay or drop the user's tx.
- **Root Cause:** Trusting RPC-reported chain-id; not validating rpcUrl against a known public chain registry (chainid.network).
- **Mitigation:**
  - Never use RPC-reported `eth_chainId` for signing; always use the user-confirmed `chainId` (set at add-chain time).
  - Validate the requested `chainId` against an embedded copy of the chainid.network registry; warn loudly if `rpcUrls` don't match the known public endpoints.
  - Require an explicit user tap to switch chains; show both old + new chain names, logos, and rpcUrl host.
  - Maintain an internal list of known-safe chains and mark all others as "Custom — proceed with caution."
- **TakumiAI Applicability:** Applies. `services/chains/evm/chainStore.ts` and `services/chains/registry.ts` govern this; confirm the chainId used for signing is pulled from the registry, not the RPC.
- **References:**
  - https://eips.ethereum.org/EIPS/eip-3085
  - https://eips.ethereum.org/EIPS/eip-3326
  - https://chainid.network/

---

#### TWV-2026-017: Silent Chain Switch Before Signature Prompt
- **Severity:** Medium
- **Category:** DApp Browser
- **Affected Wallet Types:** Both
- **Known Incidents / CVE / GHSA:** No CVE — EIP-3326 security considerations; exploited in multiple drainer flows.
- **Description:** A dApp calls `wallet_switchEthereumChain` immediately followed by a signature request. If the wallet auto-approves the switch (e.g. previously whitelisted that origin), the user sees a signature prompt for a chain they don't realise they're on.
- **Root Cause:** "Remember this choice" UX on chain switches without re-prompting on subsequent signatures.
- **Mitigation:**
  - Never silently approve a chain switch. Every switch requires a fresh user tap, even for previously-seen origins.
  - Show the current chain in the signature prompt header ("Signing on: Base").
  - Rate-limit back-to-back switch+sign flows (> 2s between switch and next signature request, else reshow chain banner).
- **TakumiAI Applicability:** Applies. Review dApp-bridge approvals flow in `services/permissions/store.ts`.
- **References:**
  - https://eips.ethereum.org/EIPS/eip-3326
  - https://ethereum-magicians.org/t/eip-3326-wallet-switchethereumchain/5471

---

### Category 4 — Supply Chain

---

#### TWV-2026-018: NPM Package Compromise Targeting Wallet Dependencies
- **Severity:** Critical
- **Category:** Supply Chain
- **Affected Wallet Types:** Both
- **Known Incidents / CVE / GHSA:** No CVE — `event-stream` / `flatmap-stream` targeting Copay (Nov 2018, ~$unknown); `@ledgerhq/connect-kit` Dec 2023 ($600k via Angel Drainer); ongoing `@solana/web3.js` typosquats and eslint-scope-style takeovers.
- **Description:** A trusted transitive dep is taken over (maintainer phish, session token theft, typosquat, NPM-account hijack) and a malicious version is published. Installed app code exfiltrates keys or signs malicious txs at runtime.
- **Root Cause:** Loose version ranges (`^`, `~`), no lockfile enforcement, NPM 2FA bypassable via session tokens, no signed publishing.
- **Mitigation:**
  - Enforce `pnpm install --frozen-lockfile` in CI and in EAS Build.
  - Review every `pnpm-lock.yaml` diff in code review; dangerous pattern: transitive version bump without a direct dep change.
  - Pin critical deps (`viem`, `@scure/bip39`, `react-native-webview`, `expo-secure-store`, all `@walletconnect/*`, any dApp connector) to exact versions with SRI-style integrity hashes.
  - Run `pnpm audit --prod` and `socket.dev` / `snyk test` gated in CI.
  - Use `@lavamoat/allow-scripts` (or equivalent) to prevent install-time scripts on untrusted packages.
  - Subscribe to `security-announce` from core deps (Expo, Viem, WalletConnect, Ledger).
- **TakumiAI Applicability:** Applies. Harden `package.json` scripts, enable pnpm hooks for lockfile validation, add GitHub Dependabot + Socket monitoring.
- **References:**
  - https://snyk.io/blog/a-post-mortem-of-the-malicious-event-stream-backdoor/
  - https://www.ledger.com/blog/security-incident-report
  - https://checkmarx.com/blog/npm-account-takeover-results-in-crypto-supply-chain-attack/

---

#### TWV-2026-019: Compromised Third-Party SDK Loaded at Runtime (Ledger Connect Kit)
- **Severity:** Critical
- **Category:** Supply Chain
- **Affected Wallet Types:** Extension (primary), Mobile (if loading remote JS in WebView)
- **Known Incidents / CVE / GHSA:** No CVE — `@ledgerhq/connect-kit-loader` Dec 2023. Dynamic CDN-loaded script was swapped for an Angel Drainer payload; affected SushiSwap, Kyber, Revoke.cash, Zapper.
- **Description:** A wallet or dApp integrates an SDK that loads additional JS at runtime from a CDN/NPM unpkg-style URL. Compromise of that script replaces the wallet interaction flow with drainer logic.
- **Root Cause:** Dynamic code loading at runtime without SRI; no pinned version; no content-signing.
- **Mitigation:**
  - Never load remote JS at runtime inside the wallet process. Bundle everything at build time.
  - If a dApp inside the WebView does this, it's the dApp's problem — but the wallet can protect by simulating every tx and refusing unusual approvals.
  - When shipping SDKs to third-party dApps (we are not, but the bridge client is embedded JS), host at a fixed version with SRI hashes, never `-latest`.
- **TakumiAI Applicability:** Partial. The app itself should not load remote JS. The injected provider script in `services/chains/evm/injectedScript.ts` is bundled at build time — confirm no `fetch` + `eval` patterns exist.
- **References:**
  - https://www.ledger.com/blog/security-incident-report
  - https://slowmist.medium.com/supply-chain-attack-on-ledger-connect-kit-analyzing-the-impact-and-preventive-measures-1005e39422fd
  - https://thehackernews.com/2023/12/crypto-hardware-wallet-ledgers-supply.html

---

#### TWV-2026-020: Fake/Malicious Wallet Apps in App Stores and Chrome Web Store
- **Severity:** Critical (for victims), Medium (for our product directly — brand/reputation)
- **Category:** Supply Chain / Distribution
- **Affected Wallet Types:** Both
- **Known Incidents / CVE / GHSA:** No CVE — 40+ malicious Firefox add-ons impersonating MetaMask/Coinbase/Phantom/Trust (Jul 2025). Trust Wallet Chrome Extension malicious code Dec 2025 ($7M). Ongoing.
- **Description:** Attacker publishes a lookalike extension/app that either (a) contains a drainer, or (b) is a clean version initially then pushes a malicious update.
- **Root Cause:** Weak store review, brand-hijack, update-key compromise.
- **Mitigation:**
  - Publish official links (Play Store, App Store) prominently and sign all communications with them.
  - Register brand across stores (including Microsoft Store, Firefox AMO) preemptively to prevent typosquats.
  - Build in anti-impersonation: the app shows its own SHA-256 signature hash in the About screen so savvy users can verify.
  - Consider certificate-transparency-style pinning between the backend and the client (signed build metadata endpoint).
- **TakumiAI Applicability:** Applies. Ensure iOS bundle ID and Android package name are registered; add a release checklist step to monitor for copycats.
- **References:**
  - https://cybersrcc.com/2025/07/23/over-40-malicious-firefox-extensions-steal-crypto-wallet-secrets-in-widespread-campaign/
  - https://thehackernews.com/2025/12/trust-wallet-chrome-extension-bug.html

---

#### TWV-2026-021: Prototype Pollution / Content-Script Isolation Bypass
- **Severity:** High
- **Category:** Supply Chain (indirect)
- **Affected Wallet Types:** Extension (primary)
- **Known Incidents / CVE / GHSA:** Multiple CVEs across JS libraries (e.g. CVE-2019-10744 lodash); MetaMask historically depended on affected versions.
- **Description:** Prototype pollution in a shared lib lets an attacker modify `Object.prototype` globally. In a wallet, this can mutate the EIP-1193 provider's behaviour mid-request (e.g. swap recipient address before signing).
- **Root Cause:** Unsafe `Object.assign`-style merges in utility libs, no `Object.freeze(Object.prototype)`, no realm isolation.
- **Mitigation:**
  - `Object.freeze(Object.prototype)` early at app init (in `pollyfills.ts`).
  - Use LavaMoat / Compartments for realm isolation where available.
  - Keep deps current; run `snyk` for prototype-pollution-class advisories.
  - Never read tx parameters via dynamic keys from untrusted objects without schema validation (use Zod).
- **TakumiAI Applicability:** Applies. All EIP-1193 request payloads should be parsed through a Zod schema. Add `Object.freeze(Object.prototype)` to `pollyfills.ts`. Current use of `services/chains/evm/payloads.ts` types should be Zod-validated at the bridge boundary.
- **References:**
  - https://github.com/advisories/GHSA-jf85-cpcp-j695
  - https://cheatsheetseries.owasp.org/cheatsheets/Prototype_Pollution_Prevention_Cheat_Sheet.html

---

### Category 5 — Mobile Platform

---

#### TWV-2026-022: Clipboard Hijacking of Addresses
- **Severity:** High
- **Category:** Mobile Platform
- **Affected Wallet Types:** Mobile (primary), Extension
- **Known Incidents / CVE / GHSA:** No CVE — class tracked via Trust Wallet / Halborn blog posts. "Laplas Clipper" and successors; attacker revenue $560k+ from a single campaign.
- **Description:** Malware on the device monitors the system clipboard, and when it detects a 0x-prefixed address or a base58 address, replaces it with an attacker-owned lookalike (same prefix/suffix via vanity generation).
- **Root Cause:** Clipboard is a shared OS resource readable by any foreground app (iOS < 14) or any app with clipboard permission (Android 10+).
- **Mitigation:**
  - Never encourage clipboard-paste flows for addresses. Prefer QR code scanning or ENS/contact book.
  - When pasted, render the address as `0x1234…abcd` **and** display characters 5-8 and -8:-4 in the middle (middle-4 display) — attackers typically match only first/last 4.
  - On paste, compare clipboard content against recent tx recipients and contacts; if slight Levenshtein distance to a known address, warn loudly.
  - Show a "Review full address" modal that displays the complete 40 hex chars in groups of 4, user must scroll and tap confirm.
  - Clear clipboard after copy from the app (`Clipboard.setStringAsync('')` after 30s) to reduce residue.
- **TakumiAI Applicability:** Applies. Address book hook exists at `hooks/useAddressBook.ts`; `services/security/addressPoisoning.ts` should be audited to also cover clipboard-swap (not only on-chain zero-value poisoning).
- **References:**
  - https://trustwallet.com/blog/security/clipboard-hijacking-attacks-how-to-prevent-them
  - https://www.halborn.com/blog/post/clipper-malware-how-hackers-steal-crypto-with-clipboard-hijacking
  - https://www.bleepingcomputer.com/news/security/new-clipboard-hijacker-replaces-crypto-wallet-addresses-with-lookalikes/

---

#### TWV-2026-023: Screenshot / Screen-Recording OCR Theft of Seed Phrase
- **Severity:** High
- **Category:** Mobile Platform
- **Affected Wallet Types:** Mobile
- **Known Incidents / CVE / GHSA:** No CVE — SpyAgent Android malware (IBM/Kaspersky 2024), ongoing campaigns using OCR over screenshot albums and live screen recordings.
- **Description:** Malware with photo-library access runs OCR over screenshots and extracts seed phrases. Alternatively, screen-recording infra (MediaProjection on Android, ReplayKit on iOS) streams live frames including the seed-display screen.
- **Root Cause:** Wallet allows screenshots on sensitive screens.
- **Mitigation:**
  - **Android:** Set `window.setFlags(FLAG_SECURE, FLAG_SECURE)` on all screens that display seed phrase, private keys, or signature material. This blocks screenshots and screen recording. Use a library such as `expo-screen-capture` (`preventScreenCaptureAsync`).
  - **iOS:** `UIScreen.isCaptured` observation to blur the UI during recording; also respond to `UIApplicationUserDidTakeScreenshotNotification` to warn/rotate seeds if detected.
  - Recommend in onboarding: "Never take a photo of this phrase."
  - Blur seed phrase by default, require long-press-to-reveal with haptic; auto-hide after 30s.
- **TakumiAI Applicability:** Applies. `services/security/screenshotGuard.ts` exists — confirm it wraps every seed, private-key, and import screen, plus signature-display screens.
- **References:**
  - https://www.ibm.com/think/insights/spyagent-malware-targets-crypto-wallets-stealing-screenshots
  - https://cryptonews.com/news/kaspersky-warns-new-crypto-malware-steals-seed-phrase-screenshots-from-ios-and-android/
  - https://docs.expo.dev/versions/latest/sdk/screen-capture/

---

#### TWV-2026-024: Deep-Link / Custom URL-Scheme Hijacking
- **Severity:** High
- **Category:** Mobile Platform
- **Affected Wallet Types:** Mobile
- **Known Incidents / CVE / GHSA:** No CVE — class documented in USENIX 2017 "Measuring the Insecurity of Mobile Deep Links" (2.2% of app-links correctly verified). Ongoing exploitation in WalletConnect flows.
- **Description:** Custom URL schemes (e.g. `takumiai://`) are not exclusively registrable — another app can register the same scheme and intercept links. A phishing app installed alongside our wallet can receive WalletConnect pairing URIs, tx-request deeplinks, and OAuth callbacks, and forward them to an attacker-controlled relay.
- **Root Cause:** Custom schemes lack origin verification; only Android App Links and iOS Universal Links (HTTPS) with a domain-verification file (`.well-known/assetlinks.json` / `apple-app-site-association`) are exclusive.
- **Mitigation:**
  - Use **Universal Links (iOS) and App Links (Android)** for every sensitive deep-link target — not custom schemes. Host `assetlinks.json` with SHA-256 cert fingerprint; host AASA with App ID.
  - For WalletConnect URIs, verify the pairing URI against an allowlist of relay hosts; never pair with a URI arriving from an unknown source (e.g. from a push or SMS — always require the user to have initiated from a dApp).
  - For intra-app deeplinks (e.g. `/send?to=...&amount=...`), always open a preview screen — never auto-execute.
  - Strip URL fragments that could encode signature material; reject deeplinks carrying raw private keys or seed material outright.
  - Use Expo Router's type-safe routing to ensure only declared routes are reachable.
- **TakumiAI Applicability:** Applies. Review `app.json` / `app.config.ts` for associated domains and Android App Link verification. Every Expo Router route must have an explicit handler; fallback to home with a warning, never silently accept arbitrary params.
- **References:**
  - https://developer.android.com/privacy-and-security/risks/unsafe-use-of-deeplinks
  - https://www.usenix.org/system/files/conference/usenixsecurity17/sec17-liu.pdf
  - https://0xn3va.gitbook.io/cheat-sheets/android-application/intent-vulnerabilities/deep-linking-vulnerabilities

---

#### TWV-2026-025: Root/Jailbreak + Frida Dynamic Instrumentation
- **Severity:** High (for keys), Medium (for UX-only defenses)
- **Category:** Mobile Platform
- **Affected Wallet Types:** Mobile
- **Known Incidents / CVE / GHSA:** No CVE — general attack class. Frida `codeshare` scripts publicly bypass almost all app-layer root-detection.
- **Description:** On a rooted/jailbroken device, Frida (or Objection) hooks JS runtime functions, intercepts Keychain/Keystore calls, bypasses biometric gates, and silently signs attacker txs after the user unlocks.
- **Root Cause:** Device compromise defeats any app-level defense that lives in the same process.
- **Mitigation:**
  - Hardware-backed keys: `expo-secure-store` on iOS uses Secure Enclave; on Android uses StrongBox where available (`setIsStrongBoxBacked(true)`). Keys never leave the TEE/SE.
  - Enforce biometric authentication *at the TEE level* for every signing operation — not a JS `if (biometricsOk) sign()` check, but `authentication-required` key attribute so the TEE blocks sign until biometrics succeed (`kSecAccessControlBiometryCurrentSet` on iOS; `setUserAuthenticationRequired(true)` on Android).
  - Detect root/jailbreak (`expo-device` `isRootedExperimentalAsync` or `jail-monkey`); in that state, show a warning on launch but do not rely on it — assume bypass.
  - Avoid storing anything decrypted-sensitive in JS heap longer than needed.
  - Monitor for known Frida ports (`27042`) and standard hooks; again, treat as a signal not a gate.
- **TakumiAI Applicability:** Applies. Audit `services/walletService.ts` to confirm private keys are used via Keychain-gated operations rather than decrypted into a JS variable per-use. Consider `expo-local-authentication` with `requireAuthentication: true` on every SecureStore read.
- **References:**
  - https://www.corellium.com/blog/ios-jailbreak-detection-bypass
  - https://www.redfoxsec.com/blog/android-root-detection-bypass-using-frida
  - https://docs.expo.dev/versions/latest/sdk/securestore/

---

#### TWV-2026-026: SSL / Certificate Pinning Bypass (MitM of Wallet APIs)
- **Severity:** Medium
- **Category:** Mobile Platform / Network
- **Affected Wallet Types:** Mobile
- **Known Incidents / CVE / GHSA:** No CVE — generic MASVS-NETWORK-2 class; widely bypassed via Frida.
- **Description:** On rooted/proxied devices or when users install a corporate/malicious root CA, TLS can be decrypted. Any plain HTTPS traffic between our app and backend/RPC/agent API is inspectable and modifiable.
- **Root Cause:** Default trust store trusts user-installed CAs; no certificate pinning.
- **Mitigation:**
  - Implement certificate / public-key pinning for:
    - `EXPO_PUBLIC_API_URL` (TakumiPay API)
    - `EXPO_PUBLIC_AI_API_URL` (Agent API)
    - Primary RPC endpoints (Alchemy/Infura)
  - Use `react-native-ssl-pinning` or native config; pin to a public-key SPKI hash (`sha256//...`) with at least one backup pin for rotation.
  - On Android 7+, configure `network_security_config.xml` to exclude user CAs (`<certificates src="system"/>`).
  - Never send wallet secrets in API bodies or logs; design APIs so that even a MitM leak is bounded (no seed, no privkey ever on the wire).
- **TakumiAI Applicability:** Applies. Add pinning to all `EXPO_PUBLIC_*` API hosts and the RPC URLs in `services/rpc/MultiProvider.ts`.
- **References:**
  - https://cheatsheetseries.owasp.org/cheatsheets/Pinning_Cheat_Sheet.html
  - https://www.appknox.com/blog/bypass-ssl-pinning-in-ios-app

---

### Category 6 — RPC / Network

---

#### TWV-2026-027: DNS / BGP Hijack of Wallet Frontend (MyEtherWallet)
- **Severity:** Critical
- **Category:** Network / Distribution
- **Affected Wallet Types:** Both (affects any wallet loaded from a domain)
- **Known Incidents / CVE / GHSA:** No CVE — MyEtherWallet DNS/BGP hijack via AWS Route 53, Apr 2018 (~$150k stolen in 2 hours).
- **Description:** Attacker announces a more-specific BGP prefix to hijack AWS Route 53 traffic and serves a phishing site under the victim domain with a self-signed cert. Users who accepted the cert warning lost funds.
- **Root Cause:** BGP has no built-in authentication; DNS resolvers trusted the hijacked route.
- **Mitigation (applies to any web surface, including the AI agent endpoint and TakumiPay API):**
  - RPKI sign all prefixes used by infrastructure (for self-hosted pieces).
  - Use DNSSEC for wallet-owned domains.
  - HSTS with preload on all wallet-owned domains; app validates via pinned cert (TWV-2026-026).
  - For the mobile app specifically: compile-time-pinned backend hosts + cert pins. The app should NOT fall back to a hijacked DNS response since its cert pin would fail.
  - For web frontends (if any): integrate Certificate Transparency monitoring (crt.sh), Subresource Integrity (SRI) for all scripts.
- **TakumiAI Applicability:** Applies to the agent/payment API backends and any web deliverables. Mobile app is partially protected via SSL pinning from TWV-2026-026 if adopted.
- **References:**
  - https://www.internetsociety.org/blog/2018/04/amazons-route-53-bgp-hijack/
  - https://www.thousandeyes.com/blog/amazon-route-53-dns-and-bgp-hijack

---

#### TWV-2026-028: Malicious RPC Node (`eth_call` Lies, Nonce/Chain Manipulation)
- **Severity:** High
- **Category:** RPC / Network
- **Affected Wallet Types:** Both
- **Known Incidents / CVE / GHSA:** No CVE — documented imToken-targeting incidents, plus EtherHiding malware family using custom RPC.
- **Description:** An attacker-controlled RPC returns fake balances/allowances, lies about chain-id, forges `eth_estimateGas`, or front-runs the user's tx (extracts it from `eth_sendRawTransaction` and broadcasts a competing one with higher fee).
- **Root Cause:** Trusting a single RPC that was added via `wallet_addEthereumChain` or attacker-social-engineered into settings.
- **Mitigation:**
  - Curated list of default RPCs; custom RPCs are opt-in and carry a persistent banner.
  - Multi-provider reads (`services/rpc/MultiProvider.ts` pattern): fan out reads to ≥ 2 independent providers and compare; flag mismatches.
  - For writes (`eth_sendRawTransaction`), use a private-mempool-compatible relay where available (Flashbots Protect on mainnet).
  - Never use a custom RPC for the very first read of any critical value (balance shown at send-confirm); cross-check against a trusted provider.
  - Validate `chainId` from registry, not RPC (see TWV-2026-016).
- **TakumiAI Applicability:** Applies. Confirm `MultiProvider.ts` fans out reads; confirm no user-settable RPC can override the trusted path for signing.
- **References:**
  - https://crypto.news/scammers-leverage-malicious-eth-rpc-nodes-to-target-imtoken-wallet/
  - https://cymulate.com/blog/simulating-etherhiding-blockchain-as-a-malware/

---

#### TWV-2026-029: Cross-Chain Signed-Transaction Replay (Pre-EIP-155 / Fork Replay)
- **Severity:** Medium
- **Category:** RPC / Network
- **Affected Wallet Types:** Both
- **Known Incidents / CVE / GHSA:** No CVE — class addressed by EIP-155. Re-emerges at every fork (ETH/ETC 2016, ETH/ETHW merge 2022).
- **Description:** A tx signed without chain-id binding can be replayed on a forked chain that shares history up to the fork, moving the same funds (plus forked-chain airdrops) on both networks.
- **Root Cause:** Old signing paths (`tx.type == 0` without chain-id) remain legal; EIP-712 without `domain.chainId` set.
- **Mitigation:**
  - Always sign EIP-1559 (type-2) or EIP-2930 (type-1) transactions — both mandate chain-id. Reject legacy un-chained txs at the signer.
  - Always populate `domain.chainId` in EIP-712 payloads.
  - At fork events, rotate nonces on affected chains or instruct user to send a same-nonce-different-data tx on one chain to invalidate replay.
- **TakumiAI Applicability:** Applies. Viem defaults to EIP-1559 — verify no code path still calls `signTransaction` with `type: 'legacy'` unless explicitly chosen, and always sets `chainId`.
- **References:**
  - https://eips.ethereum.org/EIPS/eip-155
  - https://quantstamp.com/blog/preventing-replay-attacks-post-ethereum-merge
  - https://eips.ethereum.org/EIPS/eip-3788

---

### Category 7 — Session / Protocol

---

#### TWV-2026-030: WalletConnect Session Storage XSS / Hijack
- **Severity:** High
- **Category:** Session / Protocol
- **Affected Wallet Types:** Both
- **Known Incidents / CVE / GHSA:** CVE-2022-28843 — WalletConnect session storage in HTML5 localStorage vulnerable to XSS-based session theft.
- **Description:** Historical WalletConnect v1 stored session keys in localStorage. An XSS in any page sharing that storage (or a compromised iframe) could steal the session and issue signature requests via the paired wallet.
- **Root Cause:** Storing session material in DOM-accessible storage; no XSS mitigation at the hosting surface.
- **Mitigation:**
  - Use WalletConnect v2 (`@walletconnect/sign-client`) which stores session state in isolated native storage via the wallet side.
  - On the wallet side (we are the wallet), persist sessions in `expo-secure-store`, never `AsyncStorage`.
  - Cap session expiry (< 24h by default) and require re-approval.
  - Display active sessions, dApp name/icon/URL, per-chain scope; one-tap revoke.
- **TakumiAI Applicability:** Applies. If/when WalletConnect is integrated, use v2 and persist via SecureStore. Current bridge uses in-app pairing; confirm session state storage location.
- **References:**
  - https://github.com/WalletConnect/walletconnect-monorepo/issues/5400
  - https://www.certik.com/blog/uncovering-and-resolving-a-cross-site-scripting-attack-in-a-popular-wallet
  - https://ndlabs.dev/is-walletconnect-safe

---

#### TWV-2026-031: EIP-6963 Provider UUID Collision / Spoofing
- **Severity:** Medium
- **Category:** Session / Protocol
- **Affected Wallet Types:** Extension (primary), Mobile dApp browser
- **Known Incidents / CVE / GHSA:** No CVE — class described in EIP-6963 security considerations.
- **Description:** A malicious wallet extension impersonates a legitimate one by announcing the same `EIP6963ProviderInfo.name/icon`. dApps that naively pick by name may surface the attacker's provider; transactions signed there go through attacker control.
- **Root Cause:** EIP-6963 relies on event announcement; no cryptographic authenticity for `(uuid, name, icon, rdns)`.
- **Mitigation (as wallet):**
  - Always set a stable, unique `uuid` and a reverse-DNS `rdns`. Ours is pinned to `com.planckify.takumiwallet` (the iOS bundle ID / Android package / Play Store listing ID) via `OUR_RDNS` in `services/chains/evm/eip6963.ts`.
  - If ever operating as a dApp (agent calling out), pick providers by `rdns` over user-visible `name`.
  - If ever rendering an SVG icon from another provider, sanitise it (SVG XSS via embedded scripts is a documented risk).
- **TakumiAI Applicability:** Applies. `services/chains/evm/eip6963.ts` — `OUR_RDNS` is the single source of truth (`EvmAdapter` imports it; `eip6963.test.ts` pins it); confirm provider info is stable; if the injected provider accepts inbound announcements, sanitise.
- **References:**
  - https://eips.ethereum.org/EIPS/eip-6963
  - https://reown.com/blog/eip6963-is-now-approved

---

#### TWV-2026-032: Server-Induced UI Message Injection (Electrum-Class Phishing)
- **Severity:** Medium
- **Category:** Session / Protocol
- **Affected Wallet Types:** Both
- **Known Incidents / CVE / GHSA:** No CVE — Electrum 3.3.3, Dec 2018 (~$937k). Sybil-attack servers sent RPC error messages rendered as rich HTML, linking to malware "updates."
- **Description:** A server/relay/backend returns error or info strings that the client renders as rich text with clickable links. The user is phished in-app.
- **Root Cause:** Client trusts server-supplied strings and renders them in a rich context (HTML, Markdown, URL-autolinking).
- **Mitigation:**
  - Never render server-supplied strings as HTML/Markdown in critical UI. Use plain-text `<Text>` only.
  - If displaying an error, replace any URL with "[link hidden]" or require user to explicitly reveal it; domain-allowlist before making it tappable.
  - For the AI agent: the model may produce URLs in chat output. Strip/allowlist them before `Linking.openURL`. Implement a "open external link" confirmation showing the full URL + domain warning for non-allowlisted hosts.
  - Same for push notifications, WalletConnect metadata (`peerMeta.name`, `peerMeta.url` — render as plain text, never auto-open).
- **TakumiAI Applicability:** Applies, especially to:
  - `components/home/TakumiAgent/` — agent output rendering must sanitise URLs and never auto-open.
  - dApp browser URL bar — never pre-fill from push/deeplink without a confirmation tap.
  - `services/bridge/redact.ts` likely has a role; extend to cover outbound-rendered strings.
- **References:**
  - https://cointelegraph.com/news/electrum-bitcoin-wallet-still-plagued-by-known-crypto-phishing-attack
  - https://quadrigainitiative.com/casestudy/electrummassphishingattacks.php

---

### Category 8 — Major 2024–2025 Incidents (Signer UI Integrity & Operational)

---

#### TWV-2026-033: Bybit $1.4B Safe{Wallet} UI Supply-Chain Compromise (Feb 2025)
- **Severity:** Critical
- **Category:** Supply Chain / Signer UI Integrity
- **Affected Wallet Types:** Both (any wallet that trusts a dApp frontend for tx display)
- **Known Incidents / CVE / GHSA:** No CVE — tracked via Bybit / Safe / Sygnia / Mandiant post-mortems. ~$1.46B ETH/stETH/cmETH moved from a Bybit multisig cold wallet; attribution to DPRK TraderTraitor / Lazarus. Compromised Safe{Wallet} developer's AWS session via malware on the developer's macOS workstation; a malicious JS bundle was pushed to the Safe{Wallet} frontend that targeted only the Bybit Safe address and mutated the tx payload shown to signers so they approved a `delegatecall` upgrade to an attacker contract.
- **Description:** The attack is a signer-UI-integrity compromise delivered through a trusted third-party frontend. Signers used Ledger hardware wallets and saw what they believed was a routine transfer; the Safe{Wallet} UI injected attacker calldata for those specific signers while rendering benign parameters. Because the Ledger screen only showed a `delegatecall` + opaque hash (Safe multisig blind-signing), there was no independent reproduction of the actual state change.
- **Root Cause:** (a) Safe{Wallet}'s frontend was the single source of truth for what signers saw. (b) Developer laptop breach gave attacker write access to the hosted frontend bucket. (c) Hardware wallets cannot parse Gnosis Safe calldata meaningfully, so signers relied on the compromised UI. (d) No out-of-band tx-hash verification step.
- **Mitigation:**
  - Treat every dApp-front-end-rendered tx as untrusted. Before signing, re-derive the Safe tx hash client-side from the raw `(to, value, data, operation, safeTxGas, ...)` tuple and compare to what the signer device displays.
  - Decode Safe `execTransaction` calldata in the wallet itself; show asset deltas from an independent simulation (`services/agent-executors/simulate.ts`) against a second, pinned RPC, not the dApp-provided one.
  - Surface a "second-screen" manual verification path: print the computed Safe tx hash and require the operator to compare it to a value obtained from an independent source (Safe Transaction Service REST API, queried from the mobile app directly).
  - Hard-warn on any `operation == 1` (`delegatecall`) in Safe payloads — those are implementation upgrades and are almost always the actual attack surface.
  - Ban signing from a device that cannot independently decode the calldata it is signing; require typed-data decoding UX at minimum.
  - For operational wallets (if we ever add multisig features), enforce clock-synchronised ceremony: signers compare hashes over an out-of-band channel before any approval.
- **TakumiAI Applicability:** Applies indirectly (we are not a Safe UI) but the lesson is direct: the mobile wallet must not trust a dApp-supplied tx payload for display. Extend `services/bridge/DappBridge.ts` to always re-fetch the tx target contract's bytecode + ABI from a pinned RPC and re-decode, rather than trusting `params[0]` verbatim.
- **References:**
  - https://www.bybit.com/en/newsroom/article/bybit-security-breach-post-mortem
  - https://www.sygnia.co/blog/bybit-hack-analysis/
  - https://blog.safe.global/safe-incident-update/
  - https://www.fbi.gov/news/press-releases/fbi-identifies-north-korean-cyber-actors-behind-theft-of-1-5-billion-from-bybit

---

#### TWV-2026-034: WazirX $230M Liminal Multisig UI Spoofing (Jul 2024)
- **Severity:** Critical
- **Category:** Signer UI Integrity
- **Affected Wallet Types:** Both (custody-UI dependent signing)
- **Known Incidents / CVE / GHSA:** No CVE — tracked via WazirX / Liminal / Mudrex post-mortems. ~$230M drained from a 5/6 Gnosis Safe multisig on Ethereum. Signers used Ledger hardware wallets; the Liminal custody UI displayed a benign tx while the actual signed payload rewrote the Safe's implementation.
- **Description:** Parallel to Bybit but earlier. Liminal's custody interface — a whitelisted-address service wrapping Safe — displayed one transaction to signers while the backend submitted a different payload for signature. The discrepancy was invisible on Ledger screens because Safe calldata cannot be meaningfully rendered on those devices (blind-sign).
- **Root Cause:** Any single UI layer between the signing device and the raw tx is a single point of compromise. Liminal's UI was that layer; whether via intrusion or insider, it could substitute payloads.
- **Mitigation:**
  - Identical to TWV-2026-033: re-derive and independently verify Safe tx hashes; never trust a custody UI's "what you see is what you sign" claim unless it is reproduced by at least one independent client.
  - For our own wallet, keep calldata decoding fully in-process, sourced from on-chain bytecode of the target contract, not from the requesting dApp.
  - Document in operational runbooks: any tx involving `changeImplementation`, `upgradeTo`, `setGuard`, or `setFallbackHandler` on a Safe must be hash-matched against Safe Transaction Service.
- **TakumiAI Applicability:** Applies as a principle — our signer UI must be reproducible. If a future enterprise/multisig feature ships, the UI must render the exact same tx hash that gets signed, and that hash must be verifiable from a pinned RPC call against the deployed Safe.
- **References:**
  - https://wazirx.com/blog/wazirx-cyber-attack-preliminary-report
  - https://www.chainalysis.com/blog/wazirx-hack-july-2024/
  - https://www.elliptic.co/blog/wazirx-hack-north-korea-lazarus

---

#### TWV-2026-035: Radiant Capital $50M — macOS Signer-Machine Malware (Oct 2024)
- **Severity:** Critical
- **Category:** Key Management / Signer Environment
- **Affected Wallet Types:** Both (desktop/hw-paired signers particularly)
- **Known Incidents / CVE / GHSA:** No CVE — tracked via Radiant / Mandiant / SlowMist. ~$50M. DPRK-linked (UNC4736/CryptoCore). Malware planted on multiple Radiant developer macOS machines via a social-engineered Telegram PDF ("request for audit"), installing `InletDrift` / custom AppleScript droppers. The malware targeted the Safe{Wallet} frontend in-browser: it showed the operator a benign tx while signing a malicious payload.
- **Description:** Distinct from "blind signing" (TWV-2026-011) because the signer devices (Ledger) worked correctly and displayed what they were told to display — but the host machine's browser rendered a lie. MFA on Safe-adjacent systems was bypassed because the malware sat inside the authorised session.
- **Root Cause:** Trusted compute environment (signer's laptop) compromised. Signer UI is not reproducible from an independent source. Hardware-wallet defense-in-depth does not help when the displayed tx itself is the attack.
- **Mitigation:**
  - Signing must happen on a **dedicated, minimal-surface** device (air-gapped preferred; or a clean mobile device that is not used for email/browsing).
  - For the mobile wallet: ship a "signing-mode" profile that disables the dApp browser, deeplinks, and push notifications, so the device cannot receive the malware-delivery vectors that compromised Radiant signers.
  - Re-derive tx hashes from raw payload in wallet code (see TWV-2026-033) — do not rely on an external UI rendering the payload.
  - Encourage (for power users) a second-device verification: display a QR of the full signed-hash on the signing device so a second device can scan and independently decode + display asset deltas.
  - Include macOS-specific guidance in operator runbooks: no PDFs/DMG from Telegram/Discord on signing laptops; use a hardened MDM profile (Gatekeeper, XProtect up-to-date, Santa/blocking unsigned binaries).
- **TakumiAI Applicability:** Applies to any operator-signed tx class (treasury, contract upgrades, allowlist updates). The mobile app's agent-executor, if used on a treasury, must run the simulation + hash-verification path — it cannot trust agent input.
- **References:**
  - https://medium.com/@RadiantCapital/radiant-post-mortem-fecd6cd38081
  - https://cloud.google.com/blog/topics/threat-intelligence/unc4736-radiant-hack
  - https://www.halborn.com/blog/post/explained-the-radiant-capital-hack-october-2024

---

#### TWV-2026-036: DMM Bitcoin $305M Private-Key Compromise (May 2024)
- **Severity:** Critical
- **Category:** Key Management / Operational
- **Affected Wallet Types:** Both (exchange custody; relevant to any hot-wallet architecture)
- **Known Incidents / CVE / GHSA:** No CVE — tracked via DMM Bitcoin / Chainalysis / Elliptic / FBI attribution (Dec 2024). 4,502.9 BTC (~$305M). Attack vector attributed to supply-chain compromise of Ginco's wallet-management software used by DMM, with DPRK's TraderTraitor group tricking a Ginco developer into running a malicious Python script via LinkedIn recruitment social engineering, yielding session-token access that let them substitute a legitimate withdrawal tx.
- **Description:** An engineer working on the custodian's wallet software was compromised via social engineering ("pre-employment test" containing malware). The attacker rode the engineer's authenticated session to replace a legitimate tx with a drain, submitted to signing infrastructure without out-of-band verification.
- **Root Cause:** Developer's workstation/session was part of the signing trust boundary. No out-of-band attestation of tx contents before signing.
- **Mitigation:**
  - Developer endpoints holding signing sessions must be hardened (MDM, no third-party IDE plugins without review, no external package managers without allowlist).
  - Out-of-band attestation: any tx above a threshold requires a secondary channel confirmation (phone call, secondary device, HSM-displayed hash) independent of the workstation.
  - Session lifetime for signing-capable portals: minutes, not hours. Re-auth with biometrics per tx class.
  - Take-home lesson for consumer wallet design: never let any single device hold both "enters password" and "reads from clipboard / network" trust roles simultaneously if the signing key is hot.
- **TakumiAI Applicability:** Applies to the team's own operational posture (dev machines must not hold any keys to production signing infrastructure) and to any future treasury features. Document explicitly in runbooks.
- **References:**
  - https://www.chainalysis.com/blog/dmm-bitcoin-hack-may-2024/
  - https://www.fbi.gov/news/press-releases/fbi-joint-statement-on-dmm-bitcoin-crypto-theft
  - https://www.elliptic.co/blog/dmm-bitcoin-305m-hack-tradertraitor

---

#### TWV-2026-037: Phemex $85M Hot-Wallet Drain (Jan 2025)
- **Severity:** Critical
- **Category:** Key Management / Operational
- **Affected Wallet Types:** Both (exchange custody)
- **Known Incidents / CVE / GHSA:** No CVE — tracked via Phemex disclosure / PeckShield / Cyvers monitoring. ~$85M across Ethereum, Solana, BSC, Polygon, Base, Optimism, Arbitrum in a single coordinated draining wave; hot-wallet private key compromise is the working theory (multi-chain parallelism suggests a shared key or key-material exfil).
- **Description:** Simultaneous multi-chain drain strongly indicates that the attacker held the private key or seed to a hot-wallet cluster, rather than exploiting any per-chain smart contract. Within minutes funds were swapped for ETH/BTC and routed.
- **Root Cause:** Likely hot-wallet key exfiltration via malware / supply-chain / insider; the multi-chain breadth implies a BIP-32 seed rather than per-chain isolated keys.
- **Mitigation:**
  - Architectural: do NOT derive production hot-wallet keys for multiple chains from a single seed where compromise of any one endpoint can drain everywhere. Partition by chain and by purpose.
  - Anomaly detection on withdrawal volume / velocity per chain with automatic pause if thresholds exceeded.
  - For consumer wallets: structural reminder that a single mnemonic protects all derived addresses; emphasise the backup/security properties this implies and consider account abstraction with per-chain keys for higher-value users.
- **TakumiAI Applicability:** Applies to operational hot wallets (if any) the project runs. For end-user wallets, feeds into the education screen around BIP-39 multi-chain blast radius.
- **References:**
  - https://phemex.com/blogs/phemex-security-incident-statement
  - https://www.peckshield.com/blog/phemex-hack-jan-2025
  - https://cyvers.ai/blog/phemex-85m-hack-analysis

---

#### TWV-2026-038: Penpie $27M — Rewards-Claim Signature UX Exposure (Sep 2024)
- **Severity:** High
- **Category:** Signature Phishing (UX adjacent)
- **Affected Wallet Types:** Both
- **Known Incidents / CVE / GHSA:** No CVE — tracked via SlowMist / Penpie / PeckShield. $27M. Root cause is a smart-contract reentrancy, but the wallet-relevant lesson is that user-initiated "claim rewards" flows hide complex calldata (nested calls, `batchHarvest`, aggregator routes) that a user cannot realistically validate.
- **Description:** Users typically click "Claim" on yield dashboards and sign without scrutiny because the mental model is "I'm getting money, nothing can go wrong." In Penpie's case the contract was attacker-controlled; in general, malicious "claim" flows are a rising phishing primitive because users self-select to sign quickly.
- **Root Cause:** UX asymmetry — protocol UIs treat reward claims as one-click flows; wallets do not flag them differently from other txs; users develop low-friction signing habits.
- **Mitigation:**
  - Increase signer friction for tx categories that historically carry high loss per event. Even for "claim" flows, show expected asset inflow from the simulator and warn if the inflow value is zero or negative net (ETH-equivalent) even when the label is "Claim Rewards."
  - Add a "claim-like" heuristic: if the inbound dApp-supplied label is `claim|harvest|collect|redeem` but simulated net delta is negative, flag red.
  - Show the destination contract's age and audit status (via GoPlus / DefiLlama adapters).
- **TakumiAI Applicability:** Applies. Signer UI should display simulator-derived asset delta and label-vs-delta mismatch warnings.
- **References:**
  - https://medium.com/@penpiexyz/official-post-mortem-penpie-exploit-093424b4b817
  - https://slowmist.medium.com/slowmist-analysis-of-the-penpie-exploit-08c94e5bc8cd

---

#### TWV-2026-039: Orbit Chain $82M Validator Key Compromise (Jan 2024)
- **Severity:** Critical
- **Category:** Key Management / Protocol
- **Affected Wallet Types:** Both (bridge validators; same class as multi-sig cold custody)
- **Known Incidents / CVE / GHSA:** No CVE — tracked via Orbit Chain disclosure / Theori / Chainalysis. ~$81.7M. 7-of-10 multisig bridge with 7 validator keys compromised simultaneously — suggesting correlated compromise (shared custody tooling or insider) rather than independent phishing of 7 parties.
- **Description:** Validator keys are functionally identical to multisig-signer keys. When quorum is compromised, the attacker can move any asset through the bridge. The incident highlights that "multi-sig" is security theater if the underlying keys are held by correlated processes.
- **Root Cause:** Independence assumption failed. Signers' operational environments shared attack surface (same KMS, same deployment, same backup snapshots, or same admin).
- **Mitigation:**
  - Enforce independence: signers on different hardware, different networks, different administrators, different cloud providers. Threshold schemes only add security if signer environments are truly independent.
  - Periodic ceremony to rotate validator keys; monitor for simultaneous key-derivation events.
- **TakumiAI Applicability:** Applies to any future multisig / social-recovery feature the wallet ships. The guardian-set design (see TWV-2026-045) must explicitly test the independence assumption.
- **References:**
  - https://medium.com/@orbitchain/hacking-incident-report-abbe194f57f2
  - https://www.chainalysis.com/blog/orbit-chain-hack-january-2024/
  - https://theori.io/research/orbit-bridge-hack

---

#### TWV-2026-040: Wintermute $160M — Profanity Vanity-Address Weak Entropy (Sep 2022)
- **Severity:** Critical
- **Category:** Key Management
- **Affected Wallet Types:** Both
- **Known Incidents / CVE / GHSA:** No CVE assigned to Profanity directly; tracked via 1inch disclosure (Sep 2022) and Wintermute post-mortem. ~$160M drained from a hot wallet whose `0x0000000fe6a514a32a...`-style vanity address was generated by `johguse/profanity`.
- **Description:** Profanity used a 32-bit random seed for key brute-forcing. All keys it produced are brute-forceable in hours on a consumer GPU. Wintermute's 1-inch-style gas-optimised hot wallet was generated by Profanity; once attackers recognised the vanity prefix, they recovered the key.
- **Root Cause:** Same class as TWV-2026-002 (mt19937-like low-entropy seeding), but in a separately-distributed tool that users explicitly ran to generate vanity addresses.
- **Mitigation:**
  - Never rely on third-party vanity-address tools unless their entropy source is audited and sourced from OS CSPRNG.
  - In-app "vanity address" features (if ever offered) must derive from OS randomness and search via repeated full-entropy tries, never by seed-rolling a deterministic PRNG.
  - Flag user-imported keys whose address matches a known Profanity prefix pattern (a heuristic list of observed brute-forceable prefixes) and show a critical warning to migrate funds.
- **TakumiAI Applicability:** If a "choose your address prefix" feature is ever added, ensure the implementation uses `expo-crypto` `getRandomBytesAsync(32)` per attempt. Also add a one-time check on import that warns on known-vulnerable vanity patterns.
- **References:**
  - https://blog.1inch.io/a-vulnerability-disclosed-in-profanity-an-ethereum-vanity-address-tool/
  - https://wintermute.com/blog/wintermute-hack-update
  - https://github.com/johguse/profanity/issues/61

---

### Category 9 — Account Abstraction (ERC-4337 & EIP-7702)

---

#### TWV-2026-041: Paymaster Griefing / DoS in ERC-4337
- **Severity:** High
- **Category:** Account Abstraction / Protocol
- **Affected Wallet Types:** Both (smart-account wallets)
- **Known Incidents / CVE / GHSA:** No CVE — documented in ERC-4337 spec security considerations and in audit reports (OpenZeppelin, ChainLight) of paymaster implementations.
- **Description:** A paymaster that sponsors gas for user operations can be griefed by attackers crafting UserOps that pass `validatePaymasterUserOp` (returning `validationData`) but then intentionally fail at execution, consuming paymaster gas repeatedly. Variants include: (a) storage-slot access pattern violations that the bundler cannot detect pre-bundle, (b) reverts in `postOp` that force the paymaster to still pay, (c) sponsoring flows that allow unlimited user-controlled calldata.
- **Root Cause:** The validation-execution separation in 4337 means the paymaster commits before execution succeeds. Naive paymasters sponsor any UserOp that passes validation, without caps or per-sender limits.
- **Mitigation:**
  - Paymaster integrations MUST enforce: per-sender rate limits, per-sender cumulative gas caps, and a "recently-seen abuse" denylist synced from the bundler.
  - Use a signature-based paymaster (off-chain signer co-signs each approved UserOp) instead of a permissive on-chain-only paymaster; this shifts authorisation to our infrastructure.
  - Restrict callable targets: paymasters should only sponsor UserOps whose `callData` targets an allowlist of contract addresses relevant to the wallet's use cases (e.g., our own account contract, known DEX routers).
  - Monitor bundler logs for reverting-at-execution-but-validating UserOps from the same sender; alert + deny.
  - Enforce ERC-7562 validation-phase storage rules (no forbidden opcodes, restricted storage access) on any custom paymaster we ship.
- **TakumiAI Applicability:** Applies if/when the agent or the wallet introduces a sponsored-gas flow (common for onboarding UX). Build a paymaster policy module co-located with `services/agent-executors/` that gates sponsorship.
- **References:**
  - https://eips.ethereum.org/EIPS/eip-4337
  - https://www.openzeppelin.com/security-audits/account-abstraction
  - https://blog.chain.link/account-abstraction-4337-security/

---

#### TWV-2026-042: Bundler Censorship and UserOp Front-Running (ERC-4337)
- **Severity:** Medium
- **Category:** Account Abstraction / Protocol
- **Affected Wallet Types:** Both (smart-account wallets)
- **Known Incidents / CVE / GHSA:** No CVE — documented in ERC-4337 threat model and various academic/industry analyses.
- **Description:** ERC-4337 bundlers sit between the user's UserOp and the mempool. A malicious bundler can: (a) drop UserOps ("censorship"), (b) front-run a UserOp by extracting its intent and submitting a competing tx, (c) reorder UserOps within a bundle for MEV (e.g., sandwiching a swap), (d) selectively delay UserOps to induce slippage-driven MEV. Unlike the public mempool, the private bundler relationship creates a unique trust surface.
- **Root Cause:** Bundlers have full visibility into UserOp contents before inclusion and can choose which to include. There is no cryptographic commitment that forces a bundler to submit every valid UserOp it receives.
- **Mitigation:**
  - Use multiple independent bundlers; implement a client-side fallback strategy (submit to bundler A; if not included in N blocks, retry with bundler B).
  - Prefer bundlers that expose inclusion guarantees (e.g., Pimlico/Alchemy with SLA) and that integrate with private-mempool solutions (Flashbots-like builders for 4337).
  - For swap-heavy workloads, use commit-reveal patterns where possible, or rely on the dex protocol's own anti-MEV (e.g., CoW Protocol batching).
  - Monitor UserOp inclusion latency; alert if a particular bundler systematically excludes our UserOps.
- **TakumiAI Applicability:** Applies if we adopt smart accounts. `services/rpc/` architecture should generalise to handle multiple bundler URLs as first-class, not just RPCs.
- **References:**
  - https://notes.ethereum.org/@yoav/unified-erc-4337-mempool
  - https://hackmd.io/@zgzz/aa-bundler-specification
  - https://docs.pimlico.io/infra/bundler

---

#### TWV-2026-043: Social-Recovery Guardian Quorum Takeover
- **Severity:** Critical
- **Category:** Account Abstraction / Recovery
- **Affected Wallet Types:** Both (smart-account wallets with social recovery)
- **Known Incidents / CVE / GHSA:** No CVE — documented in Argent / Soul Wallet / Ambire threat models and in multiple audits of recovery modules (e.g., OpenZeppelin audits of social-recovery extensions).
- **Description:** A social-recovery smart account delegates account-takeover authority to M-of-N guardians. If attacker compromises ≥ M guardians — by phishing them individually, compromising a cloud service they all share (e.g. same email provider + weak 2FA), or exploiting a vulnerability in how guardian addresses are verified (e.g., ENS expiry leading to guardian address replacement) — the attacker triggers recovery and substitutes the signing key.
- **Root Cause:** Guardians are addresses; address ownership can change (ENS re-registration after expiry, EOA key leak), and M/N thresholds assume independence that rarely holds for social graphs.
- **Mitigation:**
  - Require a minimum time-lock (e.g., 48–72h) between recovery initiation and execution, with push + email + SMS notifications to the original key-holder.
  - Do NOT resolve guardians via ENS at recovery time; pin guardian addresses at enrollment. If the user wants to rotate a guardian, require current-key-signed tx.
  - Require at least one "hardware-rooted" guardian (Ledger/Yubikey-backed EOA) whose compromise pattern is distinct from phone-/cloud-based guardians.
  - Rate-limit recovery attempts; show an on-device "recovery pending" banner the user cannot dismiss.
  - Monitor guardian address code-size / bytecode: warn if a guardian address transitions from EOA to a contract (possible EIP-7702 or self-destruct-redeploy hijack).
- **TakumiAI Applicability:** Applies if a social-recovery feature ships. Design notes should be captured in a dedicated `docs/social-recovery-spec.md` before implementation.
- **References:**
  - https://vitalik.eth.limo/general/2021/01/11/recovery.html
  - https://docs.argent.xyz/social-recovery
  - https://eips.ethereum.org/EIPS/eip-4337 (security considerations on recovery)

---

#### TWV-2026-044: UserOp Signature Malleability / Cross-EntryPoint Replay
- **Severity:** High
- **Category:** Account Abstraction / Protocol
- **Affected Wallet Types:** Both (smart-account wallets)
- **Known Incidents / CVE / GHSA:** No CVE — tracked via ERC-4337 spec revisions and ChainLight / OpenZeppelin audits that identified cross-entrypoint replay in early account implementations.
- **Description:** A smart account's `validateUserOp` typically hashes the UserOp with the EntryPoint address, chainId, and UserOp fields. Accounts that omit any of these from the hash (or that use a weak `ecrecover` path without chainid binding) allow a signature collected for EntryPoint v0.6 to be replayed against the same account on EntryPoint v0.7, or across chains. Separately, malleability in ECDSA (s-value) was historically exploited pre-EIP-2 normalisation.
- **Root Cause:** Mis-implemented `getUserOpHash()` or direct ECDSA without `s` normalisation; multiple EntryPoint versions exist in the wild.
- **Mitigation:**
  - All account contracts we ship / recommend must include `entryPoint`, `chainId`, and the full UserOp struct (including `paymasterAndData` and `signature` length) in the hash.
  - Normalize ECDSA `s` to the low half of `N` (EIP-2) and reject high-`s` sigs.
  - Wallet client: when signing for a smart account, always include the EntryPoint address in the signed preimage; reject any signing request that omits it.
  - Deprecate support for old EntryPoint versions once new one is stable; account contracts should hard-code a single EntryPoint and reject calls from others.
- **TakumiAI Applicability:** Applies when/if smart accounts are supported. Validate the target account contract's `getUserOpHash` binding at account-creation time (read-only call against known test vectors).
- **References:**
  - https://eips.ethereum.org/EIPS/eip-4337 ("UserOperation hash" section)
  - https://eips.ethereum.org/EIPS/eip-2 (ECDSA s normalisation)
  - https://blog.chain.link/account-abstraction-4337-security/

---

#### TWV-2026-045: Gas Griefing on ERC-4337 (`postOp` and Verification-Gas Drain)
- **Severity:** Medium
- **Category:** Account Abstraction / Protocol
- **Affected Wallet Types:** Both (smart-account wallets)
- **Known Incidents / CVE / GHSA:** No CVE — ERC-4337 spec and audit literature (OpenZeppelin, Sherlock contests on 4337 account modules).
- **Description:** Attackers submit UserOps that maximise `verificationGasLimit` or `postOpGasLimit` usage without achieving their stated work, forcing the bundler or paymaster to absorb gas that exceeded pre-computed estimates. In some implementations, the account's `validateUserOp` can be made to revert after consuming near-limit gas, causing the bundler to pay for the failed simulation.
- **Root Cause:** Gas-estimation mismatch between pre-bundle simulation and real execution under adversarial mempool conditions.
- **Mitigation:**
  - Enforce tight gas bounds in the paymaster's `validatePaymasterUserOp` — reject any UserOp whose `verificationGasLimit + preVerificationGas + callGasLimit` exceeds category-specific maxima.
  - Monitor per-sender gas-usage vs. gas-estimate delta; throttle senders with high deltas.
  - Use ERC-7562 validation rules which explicitly forbid `GAS` opcode in restricted phases; bundlers that enforce ERC-7562 reject many griefing UserOps pre-inclusion.
- **TakumiAI Applicability:** Applies to the bundler/paymaster integration layer, not to end-user wallet code directly; still, include in architecture notes.
- **References:**
  - https://eips.ethereum.org/EIPS/eip-7562
  - https://github.com/eth-infinitism/account-abstraction/blob/main/docs/security.md

---

### Category 10 — Hardware Wallet & HW Pairing

---

#### TWV-2026-046: Dark Skippy — Malicious Firmware Exfiltrating Seeds via Low-Entropy Nonces (Aug 2024)
- **Severity:** Critical
- **Category:** Hardware Wallet / Signer Environment
- **Affected Wallet Types:** Both (mobile wallets that pair with HW)
- **Known Incidents / CVE / GHSA:** No CVE — disclosed Aug 2024 by Lloyd Fournier, Nick Farrow, Robin Linus. Tracked via Frostsnap / anchorwatch disclosure.
- **Description:** Malicious firmware flashed onto a hardware wallet does not exfiltrate the seed directly. Instead, it replaces ECDSA/Schnorr signing-nonce generation with values deterministically derived from chunks of the seed itself. Two or three transactions signed with such firmware leak enough nonce data to reconstruct the master seed via standard lattice attacks. The victim observes normal-looking signatures; only post-signing on-chain analysis by the attacker reveals the seed.
- **Root Cause:** Users flash untrusted firmware (e.g., via a phishing "update" app, or via a pre-tampered device bought from a secondary seller). Hardware wallets often accept firmware signed by vendor keys, but a compromised supply chain or a convinced user installing unsigned firmware bypasses this.
- **Mitigation:**
  - Verify device attestation at pairing time: perform a vendor-specific attestation challenge (Ledger: `GET_ATTESTATION`; Trezor: secret-PIN-shared attestation) before trusting any signature produced by the device.
  - Show a persistent banner when paired with a device whose firmware version is not a vendor-signed release from an allowlist.
  - Prefer deterministic nonces (RFC 6979 / BIP-340 `k = HMAC-DRBG(d || m)`) *and* add vendor-provided auxiliary entropy; a compromised firmware can still backdoor both, but combined public-nonce schemes (MuSig2, anti-exfil protocols like Blockstream's "anti-klepto") make Dark Skippy detectable.
  - Where supported, use "nonce-grinding detection": the wallet supplies random extra entropy to the HW device and verifies the device incorporated it (public-nonce commitment scheme).
- **TakumiAI Applicability:** Applies if/when HW-wallet pairing is added. Even without HW pairing, the lesson — never trust signing-side entropy alone — informs our own signing code: on-device deterministic nonces (RFC 6979) plus an auxiliary entropy leg.
- **References:**
  - https://darkskippy.com/
  - https://blog.anchorwatch.com/darkskippy-nonce-exfiltration-attack
  - https://github.com/frostsnap/frostsnap-docs

---

#### TWV-2026-047: Ledger Nano X BLE & Voltage-Glitching Research (Kraken Security Labs)
- **Severity:** Medium (physical-access), High (BLE surface)
- **Category:** Hardware Wallet / Side Channel
- **Affected Wallet Types:** Both (mobile wallets that pair with HW)
- **Known Incidents / CVE / GHSA:** No CVE — tracked via Kraken Security Labs research posts (Donjon / Ledger disclosures for voltage glitching on ST31 chips; BLE-pairing confusion research on Nano X).
- **Description:** Research has shown: (a) voltage-glitching attacks against certain chip families can extract PIN or secure-element state with physical access + specialist equipment; (b) BLE pairing on Ledger Nano X adds a wireless attack surface — if pairing is initiated in an attacker-controlled BLE environment, malicious companion apps could spoof the Ledger Live channel. Ledger's mitigations include the SE's own attestation and display-verification-on-device, but pairing-confusion in the mobile companion app remains a risk.
- **Root Cause:** Physical-security bounds of secure-element chips; BLE pairing protocols that do not strongly bind the paired mobile app identity to the device.
- **Mitigation:**
  - For mobile wallet pairing with HW: always require the user to confirm on-device that the displayed fingerprint / pairing code matches our app; never auto-accept.
  - Use BLE "numeric comparison" or "OOB" pairing, never "Just Works."
  - Detect multi-pairing: if a HW device is simultaneously paired with our app and another app, warn.
  - Physical-security guidance for high-value users: use HW wallets only with trusted companion apps; treat devices with an unclear supply chain (open-box, secondary seller) as compromised.
- **TakumiAI Applicability:** Applies to any future HW pairing feature. Bake numeric-comparison pairing into the pairing UX spec.
- **References:**
  - https://blog.kraken.com/security-labs/
  - https://donjon.ledger.com/
  - https://www.ledger.com/academy/ledger-nano-x-security

---

#### TWV-2026-048: Ledger Recover Key-Shard Custody Controversy (May 2023)
- **Severity:** Medium (design risk, not a live exploit)
- **Category:** Hardware Wallet / Custody Model
- **Affected Wallet Types:** Both
- **Known Incidents / CVE / GHSA:** No CVE — tracked via Ledger Recover launch controversy (May 2023) and subsequent firmware-signing disclosures.
- **Description:** Ledger introduced an opt-in service ("Recover") that uses the Ledger device's firmware to encrypt and split the seed into three shards sent to three custodians (Ledger, Coincover, Escrowtech). The controversy: the mere existence of firmware capable of exporting seeds under any condition contradicts user expectations that a HW wallet's seed never leaves the device. The technical risk is not the service itself but that firmware updates can introduce such export paths; users who do not opt in may still receive firmware capable of the export.
- **Root Cause:** Closed-source secure-element firmware + firmware-update mechanism that can change the trust model of the device without a clear user-visible distinction.
- **Mitigation:**
  - Educate users: firmware updates on any HW wallet are a trust event. Review release notes.
  - Offer users the option to use open-source HW (e.g., Trezor with open firmware, Passport, Foundation) if seed-export resistance is a requirement.
  - For this wallet's own pairing UX: at pairing time, display the device's firmware version and a link to the vendor's release notes; warn if the firmware is non-release / developer mode.
- **TakumiAI Applicability:** Applies to HW-pairing UX copy and to education content.
- **References:**
  - https://www.ledger.com/recover
  - https://www.coindesk.com/policy/2023/05/16/ledger-recover-backup-seed-phrases-crypto-controversy/
  - https://www.theregister.com/2023/05/17/ledger_recover_backlash/

---

### Category 11 — Additional Signature / Protocol

---

#### TWV-2026-049: Malicious Block Explorer / RPC URLs via `wallet_addEthereumChain` (EIP-3085 Abuse)
- **Severity:** High
- **Category:** Signature Phishing / DApp Browser
- **Affected Wallet Types:** Both
- **Known Incidents / CVE / GHSA:** No CVE — class documented in EIP-3085 security considerations and numerous phishing reports (ScamSniffer, Blockaid).
- **Description:** A dApp calls `wallet_addEthereumChain` not only with an attacker RPC (see TWV-2026-016) but also with an attacker-controlled `blockExplorerUrls`. The wallet stores these and displays "View on Explorer" links throughout the tx history UI. Those links point to the attacker's phishing site, which renders a convincing Etherscan-clone that recommends "claim your reward" / "approve this signature" prompts back to the wallet via deeplink.
- **Root Cause:** Trusting dApp-supplied metadata for any UI surface.
- **Mitigation:**
  - Reject `blockExplorerUrls` unless the host matches a pinned allowlist per chain (built from chainid.network + our own overrides).
  - If a custom chain is added, mark its explorer links as "Custom explorer — not verified"; require long-press before opening in a browser; open in an in-app WebView with strict `originWhitelist`.
  - Same rules for `iconUrls`, `nativeCurrency.name`, and any other `wallet_addEthereumChain` field we render: treat as untrusted strings (no HTML, no URL autolinking).
- **TakumiAI Applicability:** Applies. `services/chains/evm/chainStore.ts` + any "View on explorer" UI. Add a registry of trusted explorers keyed by chainId.
- **References:**
  - https://eips.ethereum.org/EIPS/eip-3085
  - https://chainid.network/
  - https://scamsniffer.io/research/fake-chain-explorer-phishing

---

#### TWV-2026-050: Pending-Tx Leak via Default RPC Enabling MEV Sandwich
- **Severity:** Medium
- **Category:** RPC / Network / Protocol
- **Affected Wallet Types:** Both
- **Known Incidents / CVE / GHSA:** No CVE — class tracked via Flashbots research, Chainalysis MEV reports, and Eden Network analyses. Cumulative MEV extraction from retail wallets estimated in the hundreds of millions per year.
- **Description:** When a wallet submits via a public RPC that forwards to the public mempool, searchers observe the pending tx (especially large swaps) and sandwich it (front-run with a buy, user's swap moves the price, searcher sells into the user's slippage). The user sees worse execution than expected but no explicit attack.
- **Root Cause:** Default RPC endpoints (Infura, Alchemy public, node providers) broadcast to the public mempool. Pending-tx visibility is a feature for normal validators and an exploit surface for searchers.
- **Mitigation:**
  - Offer a default "Protect My Swaps" setting that routes swap-like txs via a private-mempool relay:
    - **Mainnet:** Flashbots Protect RPC (`https://rpc.flashbots.net`), MEV Blocker (`https://rpc.mevblocker.io`), or Beaverbuild RPC.
    - **L2s:** Most L2 sequencers are single-operator; MEV surface is different but not zero (Base's sequencer forwards to block builder). Use L2-specific protected endpoints where they exist.
  - Detect "swap-like" calldata (Uniswap universal-router, 1inch, CoW) and auto-opt the user in unless they disable.
  - For any tx > threshold (e.g. $1k), show an inline "Use private relay" toggle defaulting to ON.
  - Display a post-send "Execution quality" card comparing expected vs actual price; if sandwiched, recommend enabling private relay for next time.
- **TakumiAI Applicability:** Applies. `services/rpc/MultiProvider.ts` should route writes (`eth_sendRawTransaction`) separately from reads; swaps from `services/agent-executors/` should default to Flashbots Protect on mainnet.
- **References:**
  - https://docs.flashbots.net/flashbots-protect/overview
  - https://mevblocker.io/
  - https://research.chain.link/whitepapers/mev-minimization

---

#### TWV-2026-051: Airdrop / Signature-Harvesting Farms (Fake Claim Sites)
- **Severity:** High
- **Category:** Signature Phishing
- **Affected Wallet Types:** Both
- **Known Incidents / CVE / GHSA:** No CVE — tracked via ScamSniffer / PeckShield / Blockaid. Industrial-scale "drainers-as-a-service" (Inferno, Pink, Angel) harvest Permit / PermitForAll signatures through fake airdrop claim sites.
- **Description:** Attackers register lookalike domains (e.g., `arbitrumfoundation.claim-airdrop.xyz`), impersonate an upcoming airdrop, and prompt users to "verify wallet" — which is actually a Permit2 signature granting the drainer spender rights on every valuable token the user holds. The signature is collected but not immediately broadcast; drainers pool signatures and batch-execute during high-gas periods so that on-chain monitoring is lagging.
- **Root Cause:** Off-chain signature UX lacks visceral cost signal (no gas fee, just "sign"). Combined with domain-spoofing (see also TWV-2026-052) and time-lagged execution, users have no feedback loop.
- **Mitigation:**
  - All Permit / Permit2 signatures run through `services/decoders/{erc2612,permit2}.ts` and show explicit spender + amount (see TWV-2026-008).
  - Integrate a live scam-domain feed (ScamSniffer API, Blockaid, GoPlus) into the dApp-browser origin check; hard-block signatures on flagged origins.
  - Maintain an in-app "pending permits" view: list all active Permit2 allowances with one-tap revoke (`invalidateNonces`). Refresh on app open.
  - At any Permit2 signature prompt, show a 3-second cool-down timer during which the Sign button is disabled — trains users to actually read the prompt.
- **TakumiAI Applicability:** Applies. Signer UI should integrate with a scam-domain feed and display live pending-permits state.
- **References:**
  - https://scamsniffer.io/research/wallet-drainers-report
  - https://www.blockaid.io/blog/drainers-as-a-service
  - https://slowmist.medium.com/slowmist-2024-blockchain-security-annual-report-f1ae11bf3d1a

---

#### TWV-2026-052: Punycode / IDN Homograph Attacks on dApp URLs
- **Severity:** High
- **Category:** DApp Browser / Signature Phishing
- **Affected Wallet Types:** Both (dApp browser)
- **Known Incidents / CVE / GHSA:** No CVE — class documented since Unicode-in-domains (IDN) introduction; cryptocurrency-specific incidents include `xn--uniswap-...` homographs reported by ScamSniffer repeatedly in 2023–2025.
- **Description:** Attacker registers a domain whose Unicode rendering is visually indistinguishable from a legitimate one (e.g., Cyrillic `а` `е` `о` for Latin `a` `e` `o`), or mixes scripts to spoof `uniswap.org` as `ùniswap.org`. Wallet URL bars that render punycode-decoded Unicode show the attacker's site as legitimate; users sign Permit2 / `setApprovalForAll` believing they are on the real dApp.
- **Root Cause:** URL bars render display-form Unicode by default; IDNA2008 rules do not prevent all homographs, especially across script-mixed domains.
- **Mitigation:**
  - Render URL bar in **punycode form** (ASCII) for any domain containing non-ASCII characters, OR display a warning banner "This URL contains unusual characters that may impersonate another site" with the ASCII form shown.
  - Restrict to IDNA2008 "single-script" domains (Chromium's rule); flag multi-script.
  - Cross-check the rendered origin against a known-dApp registry at signature time; if the user is about to sign on a domain that was never visited before AND whose Unicode-normalised form matches a known top-1000 dApp, hard-warn.
  - For any Permit / setApprovalForAll signature, display the origin in ASCII-normalised form alongside the decoded version.
- **TakumiAI Applicability:** Applies to `components/dapps-browser/` URL bar and to any signer-UI display of origin. Add a punycode-aware renderer helper.
- **References:**
  - https://www.icann.org/en/system/files/files/sac-115-en.pdf
  - https://www.xudongz.com/blog/2017/idn-phishing/
  - https://chromium.googlesource.com/chromium/src/+/main/docs/idn.md

---

#### TWV-2026-053: Uniswap v4 Hook Approval Confusion
- **Severity:** High
- **Category:** Signature Phishing / Protocol
- **Affected Wallet Types:** Both
- **Known Incidents / CVE / GHSA:** No CVE yet — emerging class post-Uniswap v4 launch (Jan 2025); tracked via audit discussions (OpenZeppelin, Cyfrin, Spearbit) of v4 hooks and early observations of ambiguous hook-authorisation UX in wallets.
- **Description:** Uniswap v4 introduces hooks — contracts invoked at specific pool lifecycle events. Some hooks request token approvals or perform custom logic (fee claims, JIT liquidity, directed LP). Wallet UIs show "Approve Uniswap v4 PoolManager" but may not convey that the *hook attached to this particular pool* is a third-party contract that may call arbitrary other logic. Users understand "Uniswap" as trusted; hooks might not be.
- **Root Cause:** The authorisation pattern at the wallet UI level elides the hook-address identity. Risk accumulates where users approve PoolManager thinking they've approved vanilla Uniswap, while the pool they're interacting with has a malicious hook.
- **Mitigation:**
  - When decoding calls to PoolManager, extract the `PoolKey` from calldata and display the hook address prominently; resolve the hook's name/reputation via a curated registry.
  - Distinguish "Uniswap v4 pool with a hook" from "Uniswap v4 pool without a hook" in signer UI copy.
  - Maintain a hook allowlist (audited hooks from Uniswap Labs and known partners); hook contracts outside the list trigger a "Custom hook — the pool logic is provided by a third party" warning.
  - Simulate the full swap including hook calls (`beforeSwap`, `afterSwap`) and display the asset delta; a legitimate pool should have a predictable delta, malicious hooks often surface as token transfers to unknown addresses during simulation.
- **TakumiAI Applicability:** Applies when/if Uniswap v4 support is added. Extend `services/decoders/calldata.ts` to parse PoolKey and resolve hook identity.
- **References:**
  - https://docs.uniswap.org/contracts/v4/concepts/hooks
  - https://blog.openzeppelin.com/uniswap-v4-hooks-security-considerations
  - https://www.cyfrin.io/blog/uniswap-v4-hooks-security-101

---

#### TWV-2026-054: Notification / Push-Channel Phishing ("Security Alert" Deeplinks)
- **Severity:** High
- **Category:** Mobile Platform / Signature Phishing
- **Affected Wallet Types:** Mobile
- **Known Incidents / CVE / GHSA:** No CVE — class tracked via MetaMask / Trust Wallet phishing reports (2023–2025) and Apple/Google's own guidance on push-channel abuse.
- **Description:** Attackers send push notifications (via compromised push-service credentials, or via a separate malicious app the user has installed that requests notification permission, or via SMS/email rendered on a lockscreen that looks like an app notification) styled as security alerts: "Suspicious activity detected on your wallet. Tap to verify." Tapping follows a deeplink into a phishing dApp or a spoofed in-app page that solicits a signature.
- **Root Cause:** Notifications are a trusted UI surface but have no cryptographic provenance; users cannot distinguish legitimate from spoofed.
- **Mitigation:**
  - Every notification the wallet handles must be cryptographically signed by the wallet backend with a key pinned in the app; the app verifies signature before displaying any in-app content.
  - Never embed a signature-request or sensitive-action deeplink in a push. Notifications should only navigate to read-only screens; any action requires the user to separately open the app and repeat their intent.
  - Onboarding copy: "We will never push you to sign something via a notification."
  - For push-notification deeplinks, show a full-screen "You came from a notification — review carefully" interstitial.
- **TakumiAI Applicability:** Applies. Establish a signed-notification design before enabling push; any deeplink-handled route reachable from a push must be a preview screen, never a one-tap signature.
- **References:**
  - https://developer.apple.com/design/human-interface-guidelines/notifications
  - https://developer.android.com/develop/ui/views/notifications/safety
  - https://support.metamask.io/privacy-and-security/how-to-spot-a-phishing-notification

---

### Category 12 — Mobile / Expo / React Native Platform (Extended)

---

#### TWV-2026-055: Expo Updates / EAS Update OTA Code-Push Attack
- **Severity:** Critical
- **Category:** Mobile Platform / Supply Chain
- **Affected Wallet Types:** Mobile
- **Known Incidents / CVE / GHSA:** No CVE — class documented in Expo Updates Security docs; similar attacks observed in Microsoft CodePush (2019 research). General OTA channel compromise risk.
- **Description:** EAS Update delivers JS bundles over-the-air after the native app is installed. If the EAS signing key is compromised, or if updates are not cryptographically signed (default projects), an attacker who gains write access to the update server can push a malicious JS bundle that runs with all the app's permissions — including access to `expo-secure-store` for every existing user.
- **Root Cause:** (a) Unsigned manifests trust the HTTPS connection to the update server as the only integrity layer. (b) Signing keys, if used, stored in environment variables on CI; compromise of CI yields signing capability. (c) Rollback-protection weak or absent (older signed bundles can be replayed).
- **Mitigation:**
  - **Enable code signing**: `expo.updates.codeSigningCertificate` + `codeSigningMetadata` in `app.config.ts`. Ship the public key in the binary; sign every bundle with the corresponding private key held in a hardware security module (HSM) or cloud KMS — NOT on a CI machine.
  - Key ceremony: the signing key should require two-person authorisation to use (e.g., AWS KMS with IAM policy requiring a second approver).
  - Enforce monotonic `runtimeVersion` and publish-time in the manifest; the client rejects manifests older than the currently-installed bundle (no rollback).
  - Disable `fallbackToCacheTimeout: 0` if a malicious bundle is detected in testing — force re-check.
  - Restrict EAS Update channels: production channel is push-protected; pre-release / beta channels are explicit opt-in inside the app (Settings screen, not a deeplink).
  - For wallet specifically: consider moving key storage code to native modules (separately packaged expo-module) so that a malicious JS bundle cannot redefine `expo-secure-store` — JS is still the execution layer, but certain critical ops (e.g. sign-with-biometric) live in native module with a narrow callable surface.
  - Monitor OTA: every bundle push triggers a signed Slack/Pager alert; publish manifest hashes to a transparency log (similar to Sigstore).
- **TakumiAI Applicability:** Applies directly. Audit `app.config.ts` for `updates.codeSigningCertificate`; verify keys live in cloud KMS, not CI env vars. Add a launch-time runtime-integrity check that asserts the loaded JS bundle's hash matches what the signed manifest claims.
- **References:**
  - https://docs.expo.dev/eas-update/code-signing/
  - https://expo.dev/blog/eas-update-and-code-signing
  - https://learn.microsoft.com/en-us/appcenter/distribution/codepush/ (legacy, demonstrates failure modes)

---

#### TWV-2026-056: Hermes Bytecode Extraction from APK/IPA (Reverse-Engineering Wallet Internals)
- **Severity:** Medium
- **Category:** Mobile Platform
- **Affected Wallet Types:** Mobile (RN with Hermes)
- **Known Incidents / CVE / GHSA:** No CVE — class documented via `hermes-dec` / `hbctool` research; various write-ups of RN app reverse-engineering (2022–2024).
- **Description:** Hermes compiles JS to `.hbc` bytecode (hbc version-specific) shipped inside the APK/IPA. Attackers use `hermes-dec` and `hbctool` to disassemble bytecode into pseudo-JS, recovering logic for: key-derivation code paths, hidden feature flags, API endpoints, embedded secrets (e.g., analytics tokens left in config). While this does not directly leak user keys, it lowers attacker cost for crafting targeted exploits and undermines any "security through obscurity" protections.
- **Root Cause:** Compiled bytecode is reversible; any secret shipped in the app binary is not secret.
- **Mitigation:**
  - Never ship secrets in the JS bundle: no API keys, no admin endpoints, no feature-flag secrets.
  - Use `EXPO_PUBLIC_*` env vars only for values that can be safely public; keep backend secrets on the server.
  - Move sensitive logic (key derivation, signing preamble) to a native module where applicable; native code is still reversible but raises the bar and prevents the attacker from easily modifying behaviour with a JS OTA bundle.
  - Obfuscate the bundle (Metro's minifier + an optional obfuscator like `javascript-obfuscator` for critical modules) — treat as speed-bump, not security.
  - Runtime integrity checks: assert that the loaded bundle's SHA-256 matches what the signed manifest advertises; refuse to run a tampered bundle.
  - ProGuard/R8 rules for native components; Apple's ATS and Swift Strict Concurrency for native Swift.
- **TakumiAI Applicability:** Applies. Audit the bundle for any hard-coded secret; move sensitive ops (mnemonic generation, signing) to native modules where feasible.
- **References:**
  - https://github.com/P1sec/hermes-dec
  - https://github.com/bongtrop/hbctool
  - https://www.mend.io/blog/reverse-engineering-a-react-native-application/

---

#### TWV-2026-057: JavaScriptCore Memory-Dump Leaks on Jailbroken iOS
- **Severity:** Medium
- **Category:** Mobile Platform
- **Affected Wallet Types:** Mobile (iOS, JSC-backed RN — less relevant with Hermes default, but applicable where JSC is still used)
- **Known Incidents / CVE / GHSA:** No CVE — general class; documented in iOS security research (Project Zero, OBTS).
- **Description:** On a jailbroken device (or a device running a mach-inject-capable process), an attacker can read the memory of the running wallet process. Any secret held plaintext in JS heap — a freshly-decrypted private key held in a closure variable, a signature just computed, a session token — is recoverable.
- **Root Cause:** iOS process memory is protected from other apps under normal sandboxing, but that protection is void on jailbroken devices or in debug builds with task-port access.
- **Mitigation:**
  - Minimise dwell time of sensitive material in JS: pass secrets through to native code as early as possible; zero-out references immediately after use (acknowledging GC timing unpredictability).
  - Prefer Hermes over JSC (default since Expo 49; assert in `app.config.ts`).
  - Do all signing in a native module that receives only a handle to the Keychain entry, not the plaintext key; the Keychain API returns the key directly to the signing call and the JS layer never sees it.
  - For agent-session tokens, rotate frequently (short-lived) so memory-dumped material expires quickly.
  - Detect jailbreak (`expo-device` + custom indicators) and show a "your device appears modified; use at your own risk" warning; do not rely on this detection.
- **TakumiAI Applicability:** Applies. Audit `services/walletService.ts` — no code path should return the decrypted private key to JS; it should return a signature from a native-layer signing call. Review that Hermes is on via `jsEngine: "hermes"` in `app.config.ts`.
- **References:**
  - https://googleprojectzero.blogspot.com/2020/01/remote-iphone-exploitation-part-1.html
  - https://www.objective-see.org/blog.html
  - https://reactnative.dev/docs/hermes

---

#### TWV-2026-058: React Native Bridge Message Interception (Frida Hooking `RCTBridge`)
- **Severity:** High (on compromised devices)
- **Category:** Mobile Platform
- **Affected Wallet Types:** Mobile
- **Known Incidents / CVE / GHSA:** No CVE — class documented in Frida codeshare (`frida-ios-dump`, `objection`, numerous RN-targeting scripts).
- **Description:** On a rooted/jailbroken device, Frida hooks can attach to the RN bridge (`RCTBridge` on iOS, `ReactContext` / `CatalystInstance` on Android) and observe every message crossing JS↔Native: tx payloads, signing requests, Keychain reads. With the New Architecture (Fabric/TurboModules), hooking shifts to JSI-exposed methods but remains similarly feasible.
- **Root Cause:** The JS-native bridge is a well-known surface; dynamic-instrumentation frameworks have mature tooling for it. App-layer anti-instrumentation can be bypassed by more advanced Frida scripts.
- **Mitigation:**
  - Hardware-gated signing (TEE): ensure that the critical ops (fetching the private key from SecureStore, signing) happen behind a biometric gate enforced at the OS level — Frida hooks can observe the bridge but cannot unlock the TEE.
  - Encrypt bridge payloads for sensitive ops: JS side encrypts with a key shared only with the native module (derived at launch from a value stored in the TEE). Frida sees opaque blobs on the bridge.
  - Detect Frida: common ports (`27042`), loaded frameworks (`frida-agent`, `gum-js-loop` thread names), well-known strings in memory. Treat as warning only.
  - SafetyNet / Play Integrity (Android) and App Attest (iOS) for high-value operations — refuse to sign if device attestation fails.
  - Include a "this device is compromised" banner triggered by any root/jailbreak or Frida indicator; remind user that assets on compromised devices are at high risk.
- **TakumiAI Applicability:** Applies. Integrate Play Integrity / App Attest (via `expo-app-integrity` or a small native module) as a prerequisite for any sign-above-threshold operation.
- **References:**
  - https://frida.re/docs/ios/
  - https://www.redfoxsec.com/blog/android-root-detection-bypass-using-frida
  - https://developer.android.com/google/play/integrity

---

#### TWV-2026-059: Android `allowBackup=true` Leaks AsyncStorage / DBs via `adb backup`
- **Severity:** High
- **Category:** Mobile Platform
- **Affected Wallet Types:** Mobile (Android)
- **Known Incidents / CVE / GHSA:** No CVE — OWASP MASVS-STORAGE-1 class. Repeatedly observed in mobile app audits (NowSecure, HackerOne reports against various wallets pre-2020).
- **Description:** If `android:allowBackup="true"` (default on older API levels), `adb backup -f backup.ab` extracts the app's entire `/data/data/<pkg>/` directory — including `AsyncStorage` SQLite DBs, SharedPreferences, MMKV files, Expo FileSystem dirs. Any non-hardware-backed storage is exfiltrated. Attacker needs only USB + developer mode on the victim phone, or an unlocked device.
- **Root Cause:** Android's backup framework backs up app-private data by default unless explicitly opted out.
- **Mitigation:**
  - Set `android:allowBackup="false"` in `AndroidManifest.xml` (via Expo's `app.config.ts` `android.allowBackup: false`).
  - Additionally define `android:dataExtractionRules` (API 31+) and `android:fullBackupContent` (older APIs) XML with an explicit exclude list to belt-and-suspenders protect specific files.
  - Never store wallet material in `AsyncStorage` / SharedPreferences / plain files. SecureStore only.
  - For device-transfer UX (user migrating phones), implement an explicit export/import path with user-chosen passphrase encryption — do not rely on OS backup.
- **TakumiAI Applicability:** Applies directly. Verify `app.config.ts` has `android.allowBackup: false` and `android.blockedPermissions`-style exclusions where relevant; audit codebase for any `AsyncStorage.setItem` calls touching wallet material.
- **References:**
  - https://developer.android.com/guide/topics/data/autobackup
  - https://owasp.org/www-project-mobile-app-security/
  - https://infosecwriteups.com/android-allowbackup-vulnerability-a-security-concern-94a2c1e0f5e3

---

#### TWV-2026-060: iOS Keychain Accessibility Flag Misuse (`kSecAttrAccessibleAfterFirstUnlock` vs `WhenUnlockedThisDeviceOnly`)
- **Severity:** High
- **Category:** Mobile Platform / Key Management
- **Affected Wallet Types:** Mobile (iOS)
- **Known Incidents / CVE / GHSA:** No CVE — class documented in Apple Platform Security Guide and Zengo "Demystifying iCloud Security" series.
- **Description:** iOS Keychain items have an **accessibility** class controlling (a) when they are readable (`WhenUnlocked` vs `AfterFirstUnlock` vs `Always`) and (b) whether they're included in iCloud/device backups (`ThisDeviceOnly` suffix). Using a non-`ThisDeviceOnly` class makes the item eligible for iCloud Keychain sync or encrypted backups, where a compromised Apple ID or an attacker with access to the user's Mac can extract it. Using `AfterFirstUnlock` instead of `WhenUnlocked` means the item is readable whenever the device is in the "warm" state after the first post-boot unlock — a process running in background (including one launched by a jailbreak or a vulnerable app) can read it without the current user typing a passcode.
- **Root Cause:** Default `expo-secure-store` uses `kSecAttrAccessibleAfterFirstUnlock` unless configured otherwise — seeds remain readable in background.
- **Mitigation:**
  - Always set `keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY` on every `SecureStore.setItemAsync` / `getItemAsync` call touching seed, private key, signing key, or session token.
  - For the absolute highest-value items, add an Access Control object: `SecAccessControlCreateWithFlags(..., kSecAccessControlBiometryCurrentSet, ...)` — the TEE then refuses reads unless biometric auth just succeeded. `expo-secure-store` supports this via `requireAuthentication: true`.
  - Never use the default accessibility without explicit justification; add a linter rule against bare `SecureStore.setItemAsync(key, value)` (require the options object).
- **TakumiAI Applicability:** Applies directly. Grep the codebase for every `SecureStore.*Async` call and verify the options.
- **References:**
  - https://support.apple.com/guide/security/keychain-data-protection-secb0694df1a/web
  - https://docs.expo.dev/versions/latest/sdk/securestore/
  - https://medium.com/zengo/demystifying-icloud-security-wallets-e348516914d9

---

#### TWV-2026-061: Face ID / Touch ID Rebinding After Device Theft
- **Severity:** High
- **Category:** Mobile Platform / Key Management
- **Affected Wallet Types:** Mobile
- **Known Incidents / CVE / GHSA:** No CVE — class documented in iOS Local Authentication docs and Apple-device-theft writeups (Wall Street Journal "The iPhone Setting Thieves Use" Feb 2023).
- **Description:** If an attacker physically steals an unlocked phone (or observes the passcode via shoulder-surfing before snatching it), they can: (a) navigate to Settings → Face ID/Passcode and enroll their own biometric, (b) change the device passcode, (c) then use the wallet with biometric-gated operations now bound to the attacker's biometric. The seed and signing key remain in Keychain, but the biometric gate no longer protects against the attacker because *their* face is now the authorised face.
- **Root Cause:** Biometric bindings in iOS/Android are tied to the **biometric set** on the device, not a specific enrolled biometric. When the set changes, apps default to either: (a) losing access to biometric-protected Keychain items (good), or (b) silently accepting the new biometric (bad) — depending on flags.
- **Mitigation:**
  - **iOS:** Use `kSecAccessControlBiometryCurrentSet` (not `BiometryAny`). This flag invalidates the Keychain item when any biometric is added or removed, forcing the user to re-enter their app-level password to re-enroll it. `expo-secure-store`'s `authenticationPrompt` + `requireAuthentication: true` defaults to current-set binding; verify.
  - **Android:** Use `setInvalidatedByBiometricEnrollment(true)` on the key at generation; `BiometricPrompt.AuthenticationCallback` will fail if biometrics changed since key creation, forcing re-enrollment with the app's own password.
  - Add an app-level password (independent of device passcode) for high-value operations. The app password unlocks biometric re-enrollment after device biometric change.
  - On detection of biometric-set change (callback failure), wipe any cached session and show "biometrics changed — enter app password to continue" screen.
- **TakumiAI Applicability:** Applies directly. Audit SecureStore config for `requireAuthentication: true` with current-set semantics; implement an app password for re-enrollment flow.
- **References:**
  - https://developer.apple.com/documentation/localauthentication/lapolicy/2867589-deviceownerauthenticationwithbio
  - https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec.Builder#setInvalidatedByBiometricEnrollment(boolean)
  - https://www.wsj.com/articles/apple-iphone-security-theft-passcode-data-privacy-a-basic-iphone-feature-helps-criminals-steal-your-entire-digital-life-cbf14b1a

---

#### TWV-2026-062: Android StrongBox / Keystore Attestation Bypass on Rooted Devices
- **Severity:** High (on rooted), Medium (overall)
- **Category:** Mobile Platform / Key Management
- **Affected Wallet Types:** Mobile (Android)
- **Known Incidents / CVE / GHSA:** Multiple CVEs for specific Android Keystore / TEE bypasses (e.g., CVE-2022-20465 keyguard bypass; TrustZone attacks on various OEMs by NCC Group, Check Point Research, Tencent Blade). General class documented in Google's Verified Boot docs.
- **Description:** Android's Keystore provides hardware-backed keys via TEE (Trusted Execution Environment) or StrongBox (dedicated secure chip, Pixel + some Samsung). On a rooted or `/system`-modified device, the boot integrity chain is broken; Play Integrity reports "UNVERIFIED" or "BASIC" instead of "MEETS_STRONG_INTEGRITY," and in some cases the Keystore attestation certificate chain is invalid (issued from non-stock hardware keys). Malicious ROMs can even ship attacker-controlled attestation keys, making the cryptographic attestation itself untrustworthy without cross-verification.
- **Root Cause:** TEE/StrongBox is only as trustworthy as the boot chain; root defeats that; and some OEM keystore implementations have had direct TEE bypasses (OEM bootloader bugs, TA-authentication issues).
- **Mitigation:**
  - At app start, perform **Key Attestation** on every wallet-signing key: `KeyStore.getCertificateChain(keyAlias)` and validate that the chain roots in Google's hardware-attestation root CA (pinned in the app). Reject devices whose attestation chain doesn't match.
  - Combine with **Play Integrity API** to verify device integrity before allowing any signing over a threshold amount.
  - Prefer StrongBox where available: `setIsStrongBoxBacked(true)` (falls back to TEE if unavailable).
  - Bind every signing key with `setUserAuthenticationRequired(true)` + `setInvalidatedByBiometricEnrollment(true)` + `setUnlockedDeviceRequired(true)`.
  - On detected bypass (attestation failure, Play Integrity `MEETS_BASIC_INTEGRITY` missing), degrade to read-only mode for high-value ops; allow small amounts but gate large ones.
  - Log attestation failure events (without PII) to our backend to track device-ecosystem risk.
- **TakumiAI Applicability:** Applies. Add a native-module wrapper that performs Key Attestation at app launch and gates signing above threshold on a passing attestation. Integrate Play Integrity via `expo-play-integrity` or equivalent.
- **References:**
  - https://source.android.com/docs/security/features/keystore/attestation
  - https://developer.android.com/google/play/integrity
  - https://research.nccgroup.com/2022/01/13/android-keystore-security-analysis/

---

### Category 13 — Extension / Desktop Pair (Informational)

---

#### TWV-2026-063: MetaMask Clipboard Auto-Paste Detection (Older Versions)
- **Severity:** Medium
- **Category:** Mobile Platform / Key Management
- **Affected Wallet Types:** Extension (primary); mobile inherits lesson
- **Known Incidents / CVE / GHSA:** No CVE — tracked via MetaMask GitHub issues and 2020–2022 UX disclosures around clipboard reading.
- **Description:** Older MetaMask versions auto-read the clipboard on certain screens (to pre-fill address fields), which (a) triggered iOS 14+ clipboard-access banners alarming users and (b) in worst-case interacted with malicious keyboards that logged clipboard reads. The UX confusion led users to copy-paste seed phrases out of password managers into the wrong fields.
- **Root Cause:** Auto-reading clipboard is convenient for addresses but semantically wrong for seeds. Users conflate the two.
- **Mitigation:**
  - Never auto-read the clipboard on any screen. Always require an explicit "Paste" button tap.
  - When the user taps "Paste" on a seed-import screen, scan the pasted content: if it looks like BIP-39 words, warn ("Pasting a seed phrase exposes it to clipboard malware — consider typing instead").
  - Clear clipboard after any paste of sensitive material (see TWV-2026-022).
- **TakumiAI Applicability:** Applies. Grep for `Clipboard.getStringAsync` / `Clipboard.addListener` in the codebase; ensure none run silently.
- **References:**
  - https://github.com/MetaMask/metamask-mobile/issues/1735
  - https://support.metamask.io/privacy-and-security/clipboard-access

---

#### TWV-2026-064: Wallet-Connect Prompt UI Spoofing via Fullscreen dApp
- **Severity:** High
- **Category:** DApp Browser / Signature Phishing
- **Affected Wallet Types:** Both (especially mobile dApp browser)
- **Known Incidents / CVE / GHSA:** No CVE — class documented in OWASP "Tapjacking" (Android) + research on fullscreen-dApp UI spoofing in wallet contexts.
- **Description:** A dApp inside the in-app WebView requests fullscreen (`requestFullscreen`), then renders a pixel-perfect replica of the wallet's connect/signature prompt. The user believes they are interacting with the wallet's trusted UI but every tap is captured by the dApp. The dApp can then drive a real signature prompt underneath, or phish details (e.g., PIN entry).
- **Root Cause:** WebView content can occupy the full screen; trusted-UI indicators are not visually distinguishable from rendered HTML.
- **Mitigation:**
  - Disable fullscreen in the WebView entirely (`allowsFullscreenVideo={false}`, `allowsInlineMediaPlayback={true}`).
  - Render all wallet prompts as **native** modals (React Native components), not as HTML overlays. Native modals include system chrome (status bar, safe area) that WebView content cannot replicate.
  - Show a persistent, unfakeable trusted-UI indicator on every wallet prompt: a small status-bar element rendered from native code (e.g., a coloured strip with the wallet icon drawn in native), that the WebView cannot overlay.
  - Require a hardware button or system gesture (iOS swipe-up edge) to close a wallet prompt, not a WebView-rendered button.
- **TakumiAI Applicability:** Applies. Ensure all signer UIs are native RN modals over the WebView, not HTML inside. Add `allowsFullscreenVideo={false}` and disable JS fullscreen API via injected script.
- **References:**
  - https://owasp.org/www-community/attacks/Tapjacking
  - https://developer.apple.com/documentation/webkit/wkpreferences
  - https://developer.android.com/reference/android/webkit/WebSettings

---

#### TWV-2026-065: Fake Ledger Live / Trezor Bridge Desktop Apps
- **Severity:** Critical (for victims)
- **Category:** Supply Chain / Distribution
- **Affected Wallet Types:** Both (desktop signer ecosystem; mobile inherits lesson for HW pairing UX)
- **Known Incidents / CVE / GHSA:** No CVE — tracked via Ledger / Trezor fraud-alert pages. Google Ads delivering fake Ledger Live (2022–2024), fake Trezor Bridge, fake "Phantom" Solana wallet desktop apps. Hundreds of thousands stolen cumulatively.
- **Description:** Attackers pay for search ads that appear above the legitimate result for "Ledger Live download" or "Trezor Bridge." The downloaded installer looks identical, even signs with a (different) Developer ID cert, but exfiltrates the seed at first pairing or replaces signed txs en-route to the HW device.
- **Root Cause:** App distribution via web downloads has no user-enforceable authenticity check. Even signed binaries only prove the signer's identity, not that the signer is the real Ledger/Trezor.
- **Mitigation:**
  - For our own wallet (primarily mobile): distribute only via Apple App Store and Google Play Store. Publish the Bundle ID / Package name prominently; in-app "About" screen shows the expected SHA-256 signature.
  - If we ever ship a desktop companion, distribute via signed .dmg / .pkg / Windows MSIX with the signer identity pinned in our mobile app, which verifies the desktop companion identity on pairing.
  - In-app education: "Never download any TakumiAI desktop / browser component from search results. Official links: [list]."
  - For HW-wallet pairing UX: warn if user tries to pair a HW wallet via a previously-unseen channel; nudge to official flows.
- **TakumiAI Applicability:** Applies to the team's distribution discipline. Publish official store URLs, monitor Google/Bing/DuckDuckGo ads for takedown, register trademark.
- **References:**
  - https://www.ledger.com/fraud-and-phishing-alerts
  - https://trezor.io/learn/a/scam-resources
  - https://krebsonsecurity.com/2023/10/crypto-exchange-users-hit-by-ads-for-fake-ledger-live-app/

---

### Category 14 — Clear-Signing Standards Adoption (2026)

#### TWV-2026-066: Raw Hex/Calldata Remains Opaque Despite Structured Decoders
- **Severity:** High
- **Category:** Signature Phishing / Display Integrity
- **Affected Wallet Types:** Both
- **Known Incidents / CVE / GHSA:** No CVE — this is the residual gap behind TWV-2026-011 (Radiant Capital), TWV-2026-034 (WazirX), and every "Contract Interaction" blank-check UI incident. The ecosystem-level fix now shipping is ERC-7730 "Structured Data Clear Signing Format" (finalized text at https://eips.ethereum.org/EIPS/eip-7730; de facto community registry at github.com/ethereum/clear-signing-erc7730-registry, adopted by Ledger/Trezor/MetaMask/Safe/WalletConnect) and ERC-8213 "Wallet Signature and Calldata Digest Display" (Cyfrin-authored; still a draft ERC — spec text at the Ethereum Magicians thread below, tracked as `ethereum/ERCs` PR #1639, not yet a merged `eips.ethereum.org` page). Cyfrin's `clearsig` (github.com/Cyfrin/clearsig) is the reference CLI implementing both.
- **Description:** `TWV-2026-008` (Permit/Permit2), `TWV-2026-012` (EIP-712 domain display), and `TWV-2026-011` (simulation + asset-delta preview) closed the highest-frequency drain vectors, but each is a bespoke, hand-written decoder for one payload shape. Any contract call outside that hand-written set — most third-party dApp calldata, most agent-initiated DeFi calls — still renders as a raw hex blob or an untyped parameter dump the user cannot evaluate. That gap is exactly the "generic summary, approve anyway" failure mode from Radiant/WazirX, just without a hardware-wallet screen in the loop.
- **Root Cause:** Decoding coverage is bounded by how many payload shapes engineers have hand-written a decoder for. Per the ERC-7730 abstract, "raw data, even with ABI descriptions, lacks sufficient context for proper user review" — developer-oriented naming, ambiguous field representation, and missing token metadata all obscure intent even when a generic ABI decode succeeds. There was no standardized, audited, machine-readable source of "what does selector X on contract Y mean" that a wallet could consume generically — until ERC-7730's descriptor format.
- **Mitigation:**
  - Resolve an ERC-7730 descriptor as the **first** decode path. Per the finalized spec's wallet-resolution procedure: take the human-readable ABI fragment in a descriptor's `display.formats` key (e.g. `"transfer(address to,uint256 value)"`), drop parameter names to get the type-only signature, compute `keccak256(<type-only signature>)[:4]`, and match against the calldata's first 4 bytes (or, for EIP-712, match `keccak256(encodeType(typeOf(s)))` against the descriptor key per EIP-712's own `encodeType`). Bundle/pin a snapshot of the de facto community registry (the spec itself says "curation and registry of ERC-7730 files are out of scope," so pin the same registry `clearsig` uses, for output parity) — never fetch it live at sign time. Fall back to the existing bespoke decoders (`services/decoders/erc2612.ts`, `permit2.ts`, `safeTxHash.ts`) when no descriptor matches; fall back to raw hex when neither matches. This mirrors `docs/design-notes/reproducible-signer-ui.md` §3, which already bans remote/dApp-supplied decoding as a trust source.
  - Follow the spec's own fallback rules exactly: unmatched selector → "wallets SHOULD display a safe fallback (e.g. 'Unknown function' alongside raw arguments) and MUST NOT attempt to apply any unrelated format specification"; a matched descriptor whose field interpolation fails → "MUST fall back to displaying the regular `intent` field."
  - Compute and display an ERC-8213 digest next to every sign sheet: **Domain Hash** = `hashStruct(eip712Domain)` (= `domainSeparator`), **Message Hash** = `hashStruct(message)`, **EIP-712 Digest** = `keccak256("\x19\x01" ‖ domainSeparator ‖ hashStruct(message))` for typed data; **Calldata Digest** = `keccak256(len(calldata) ‖ calldata)` for transactions. A user can independently reproduce these with `clearsig eip712` / `clearsig calldata-digest` / `clearsig translate` on a second device before approving — the cross-device verification model `docs/design-notes/reproducible-signer-ui.md` §7 already specifies for the (not-yet-shipped) multisig case, applied here to ordinary signing.
  - **AI/LLM natural-language phrasing is a presentation layer over the already-decoded structured fields, never a substitute for the decode itself.** The Takumi Agent may turn `{spender: "Universal Router", token: "USDC", amount: "unlimited"}` into "This lets Universal Router spend unlimited USDC from your wallet" — it must never receive raw hex and be trusted to produce the field values themselves. If no descriptor/decoder matches, no AI summary is shown (no hallucinated gloss on unparseable bytes); the structured fields (or the explicit "unrecognized" state) are always rendered alongside/beneath any AI sentence, never AI-text-only. This mirrors the existing `err.message`-to-user ban in `CLAUDE.md` "User-facing errors": don't pipe an untrusted/unverifiable string straight to the user just because it's more readable.
- **TakumiAI Applicability:** Applies across every signing surface on every supported chain — this wallet is chain-agnostic (EVM, Solana, Sui, Stellar), and ERC-7730/8213 are EVM-only, so the mitigation must generalize. Solana/Sui/Stellar have no ratified clear-signing standard, but each already exposes a native on-chain interface spec (Solana: Anchor on-chain IDL account; Sui: `sui_getNormalizedMoveFunction`; Stellar: Soroban contract spec) and, for the digest side, each already computes its own native transaction digest as part of normal protocol operation (Sui: `blake2b256` tx digest; Stellar: `SHA-256` signature-payload hash) — no new digest scheme needs inventing outside EVM, just surfacing pre-signature. Implemented as two optional `WalletKitAdapter` capabilities (`resolveClearSigningDescriptor`, `computeSigningDigest`), presence-checked per the project's "space docking" convention — never a `namespace ===` branch in shared code. Covers dApp-bridge sheets (`EvmTransactionSheet`, `EvmBatchCallsSheet`, `EvmSignMessageSheet`, `SolanaTransactionSheet`, `SolanaSignAllTransactionsSheet`, `SolanaSignMessageSheet`, `StellarTransactionSheet`, `StellarSignMessageSheet`, `SuiTransactionSheet`, `SuiSignPersonalMessageSheet`, `AgentCardRenderer`), agent-executor-constructed txs (`services/agent-executors/defi/submitTx.ts`), and native gas-abstracted signing (`sendUserOpWithUsdcPaymaster.ts`, `signTransferWithAuthorization.ts`, `signX402SvmPayment.ts`). See task 65.
- **References:**
  - https://eips.ethereum.org/EIPS/eip-7730 (finalized ERC text — resolution algorithm, fallback rules, descriptor schema)
  - https://github.com/ethereum/clear-signing-erc7730-registry (de facto community registry)
  - https://ethereum-magicians.org/t/erc-8213-wallet-signature-and-calldata-digest-display/24295 (ERC-8213 draft spec text)
  - https://erc8213.eth.limo/#/implement (ERC-8213 implementation guide — reference viem/Rust/Swift/Solidity code, display rules, named pitfalls; verified primary source)
  - https://github.com/ethereum/ERCs/pull/1639 (ERC-8213 draft PR — track for finalization status before implementation)
  - https://github.com/Cyfrin/clearsig (reference CLI implementation + registry auto-download)
  - https://www.cyfrin.io/blog/blind-signing-solved

---

## 7. Implementation Principles — Non-Regression & Feature Preservation

Every mitigation in Section 6 and every item in the Roadmap (§8) **MUST** be implemented without breaking existing, working functionality. Security fixes that regress the product are not fixes — they are trade-downs that push users toward worse alternatives or cause them to disable the feature entirely. The following rules are binding on any PR that cites this spec.

### 7.1 Behaviour-preservation contract

A security change is only acceptable when all of the following hold:

1. **No feature removal without replacement.** If a mitigation requires removing a code path (e.g. deprecating `eth_sign`, stripping a permissive deeplink), ship the secure replacement in the *same* release. Users must never see a feature simply disappear.
2. **Public API / prop / hook signature preserved.** Changes to `useWallet`, `useChains`, the dApp bridge (`services/bridge/DappBridge.ts`), injected-provider surface, deeplink schema, or agent tool I/O shapes are considered breaking. If a change is unavoidable, ship both shapes behind a feature flag for at least one release and update every consumer in the repo in the same PR.
3. **Stored-state migration, not reset.** Any schema change to `expo-secure-store`, AsyncStorage, SQLite, MMKV, or chain/wallet registry requires a forward migration. Never force users to re-import seed phrases, re-connect dApps, or re-grant approvals as a side-effect of a security fix.
4. **Signable-tx parity.** Every transaction shape that worked before the fix must still sign successfully after it — including legacy (pre-EIP-1559) txs, EIP-2930, EIP-1559, EIP-7702 (when enabled), and raw `personal_sign`/`eth_signTypedData_v4`. Added warnings or cool-downs are acceptable; hard blocks on previously-working flows are not, unless the flow is itself the vulnerability (e.g. raw `eth_sign` — which gets an explicit deprecation path, not silent removal).
5. **dApp compatibility parity.** Any change to the EIP-1193 provider, EIP-6963 announcer, or WalletConnect session handling must preserve compatibility with the dApp corpus exercised by the existing integration tests. Run the dApp smoke suite (`components/dapps-browser/` test fixtures) before merge.
6. **Agent behaviour preserved.** The Vercel-AI-SDK agent's tool-call contract (`services/agent-executors/*`, tool names, argument shapes, result shapes) is part of the public surface. Security changes cannot silently drop tool outputs, rename tools, or rewrite argument keys — the agent's model has been tuned against the current schema.
7. **Chain list preserved.** Any hardening of `wallet_addEthereumChain` or chain-registry validation must leave every chain currently active in `services/chains/evm/chainStore.ts` working; grandfather user-added chains rather than removing them.
8. **Performance budget.** Mitigations must not regress: app cold-start by >100 ms on a mid-range Android device, send-tx end-to-end latency by >200 ms, or dApp browser TTI by >150 ms. Heavy checks (simulation, address-poisoning lookups, SPKI pinning handshake) must run asynchronously with a visible skeleton, not block the UI.
9. **Offline degradation preserved.** Features that worked offline (viewing balances from cache, reading last-known approvals, drafting txs) must continue to work offline. No mitigation can add a mandatory online check to a previously-offline-capable path.

### 7.2 Process gates

Every PR that implements a `TWV-*` mitigation must include:

- **Linked TWV ID(s)** in the PR description and commit message, e.g. `fix(security): TWV-2026-011 — require explicit tap for wallet_switchEthereumChain`.
- **Scope statement**: what changed, what did NOT change, what was intentionally deferred and why.
- **Regression evidence**, proportional to blast radius:
  - Unit tests on the changed module (`pnpm run test -- --testPathPattern=<file>`).
  - Integration exercise of every existing feature that touches the changed code path — minimum set: seed generation, seed import, send native token, send ERC-20, sign typed data, connect to a dApp via injected provider + WalletConnect, chain switch, agent send-tx, agent swap, deeplink open.
  - Manual verification on both iOS (simulator + device) and Android (emulator + device) when the change touches native modules (`expo-secure-store`, `react-native-webview`, deep-link intent filters, keychain/keystore accessibility, biometrics).
  - For network-path changes (RPC, SPKI pinning, explorer URLs): verify on at least mainnet + one L2 from the active chain list.
- **No-op on disabled flag**: if gated behind a feature flag, the flag-off path must be byte-for-byte equivalent to the pre-change behaviour.
- **Rollback plan**: one-commit revert or a runtime kill-switch (remote config / EAS Update channel rollback) where the change is large enough that a revert would itself be risky.

### 7.3 Explicit anti-patterns (reject at review)

- Deleting a tool, hook, or prop "because nothing should use it" without ripgrep-proving zero in-repo consumers AND shipping a shim for external consumers (dApps, agent).
- Tightening a Zod schema mid-release such that previously-valid stored payloads fail to parse — migrations must widen-then-narrow, never narrow-then-migrate.
- Forcing a re-authentication, re-pair, or re-approval on app launch after an update. Biometric invalidation on enrollment change (TWV-2026-061) is the sole permitted exception, and even then a recovery path (app password) must exist first.
- Silently switching RPC endpoints, default slippage, default gas policy, or default privacy-relay routing. Any change to defaults requires an in-app notice + opt-out toggle in Settings.
- Hard-blocking a legacy feature based on a heuristic (e.g. "looks like `eth_sign`"). Heuristics produce false positives; block with a precise predicate or warn-only.
- Shipping two mitigations in one PR when they are independently revertable. Split them so regressions can be bisected to the right TWV.

### 7.4 Acceptance sign-off

A security PR is not merge-ready until:

- [ ] Existing test suite is green (`pnpm run test`, `pnpm run test:e2e` where applicable).
- [ ] `pnpm check:syntax` and `pnpm biome:check` pass.
- [ ] Manual regression list (§7.2) completed and attached.
- [ ] Feature-flag default and rollback plan documented.
- [ ] One reviewer from wallet-core and one from platform (iOS/Android) have signed off when the change touches native surface.
- [ ] Change Log (§10) updated with the TWV ID(s) closed and any user-visible behaviour notes.

**Tl;dr — the bar is "secure AND unchanged from the user's POV, or secure AND with a strictly-better UX." Anything that is "secure but worse" gets sent back for redesign.**

---

## 8. Prioritised Remediation Roadmap for TakumiAI

Prioritised by (severity × applicability to current code) with effort heuristics. "Fix-first" means within 1 release; "Next" within 1 quarter; "Track" in backlog / policy.

### 7.1 Fix-first (block next release)

| ID | Title | Primary code location | Effort |
| --- | --- | --- | --- |
| TWV-2026-007 | Block `eth_sign` at bridge | `services/bridge/DappBridge.ts` | XS |
| TWV-2026-002 | Verify OS CSPRNG in wallet gen | `services/walletService.ts`, `pollyfills.ts` | XS |
| TWV-2026-004 | `WHEN_UNLOCKED_THIS_DEVICE_ONLY` + `allowBackup=false` | `services/walletService.ts`, `app.config.ts` | S |
| TWV-2026-023 | `FLAG_SECURE` on all sensitive screens | `services/security/screenshotGuard.ts` (extend) | S |
| TWV-2026-005 | Secure `TextInput` props on seed screens | seed import/backup components | S |
| TWV-2026-003 | Logger/Sentry scrubbers for seed-like strings | `services/bridge/redact.ts` extended | S |
| TWV-2026-016 | Use registry chain-id, not RPC `eth_chainId`, for signing | `services/chains/evm/chainStore.ts` | S |
| TWV-2026-008 | Full Permit/Permit2 decoding surfaced in UI | `services/decoders/{erc2612,permit2}.ts` + signer UI | M |
| TWV-2026-055 | EAS Update code signing (KMS-backed key, not CI env var) | `app.config.ts`, CI / KMS config | M |
| TWV-2026-059 | `android:allowBackup=false` + `dataExtractionRules` excludes | `app.config.ts` | XS |
| TWV-2026-060 | SecureStore `WHEN_UNLOCKED_THIS_DEVICE_ONLY` + `requireAuthentication: true` everywhere | `services/walletService.ts`, all SecureStore calls | S |
| TWV-2026-061 | Current-biometric-set binding on signing keys + app password | `services/walletService.ts`, `services/security/*` | M |
| TWV-2026-049 | Explorer-URL allowlist; reject dApp-supplied `blockExplorerUrls` | `services/chains/evm/chainStore.ts` | S |
| TWV-2026-064 | Native RN modals for all signer UI (no HTML overlays); disable WebView fullscreen | `components/dapps-browser/`, signer UI | S |

### 7.2 Next quarter

| ID | Title | Notes |
| --- | --- | --- |
| TWV-2026-009 | `setApprovalForAll` red-flag UI + revoke screen | Build revoke-list from indexer |
| TWV-2026-010 | EIP-7702 authorization UI + delegator allowlist enforcement | Already specced in `docs/eip7702-delegator-allowlist-spec.md` |
| TWV-2026-011 | Transaction simulation before every signature (user + agent) | Hook `services/agent-executors/simulate.ts` into all signing paths |
| TWV-2026-013 | WebView hardening: min system version check, origin pin | `services/bridge/DappBridge.ts` |
| TWV-2026-015 | Per-session nonce + origin check on injected provider | `services/chains/evm/injectedScript.ts` |
| TWV-2026-022 | Clipboard-swap detection + middle-char address display | Extend `services/security/addressPoisoning.ts` |
| TWV-2026-024 | Universal/App Links for all sensitive deeplinks | `app.config.ts`, Apple AASA & Android assetlinks.json |
| TWV-2026-018 | Lockfile-enforced CI + Socket/Snyk gate | CI config |
| TWV-2026-026 | SSL pinning on all backend + RPC | `network_security_config.xml`, RN pinning lib |
| TWV-2026-032 | Agent output URL sanitisation + confirm-external-link dialog | `components/home/TakumiAgent/` |
| TWV-2026-033 | Independent Safe-tx-hash re-derivation + `delegatecall` hard-warn | `services/bridge/DappBridge.ts`, signer UI (if Safe support added) |
| TWV-2026-035 | Signing-mode profile (dApp browser/deeplinks/push disabled) for high-value users | Settings, `services/security/*` |
| TWV-2026-038 | Claim-label vs simulated-delta mismatch warning | Signer UI + simulator integration |
| TWV-2026-050 | Flashbots Protect / MEV Blocker default for swap txs | `services/rpc/MultiProvider.ts`, swap-like calldata heuristic |
| TWV-2026-051 | Live scam-domain feed (ScamSniffer/Blockaid) + pending-permits screen | dApp browser + approvals screen |
| TWV-2026-052 | Punycode rendering + IDN-homograph warning in URL bar | `components/dapps-browser/` URL bar |
| TWV-2026-054 | Signed push notifications; no signature deeplinks from push | Push backend + mobile handler |
| TWV-2026-056 | Bundle-integrity runtime check (manifest SHA-256 vs loaded bundle) | `pollyfills.ts` / launch shim |
| TWV-2026-058 | Play Integrity / App Attest on sign-above-threshold | Native module + signer gate |
| TWV-2026-062 | Android Key Attestation chain validation at launch | Native module + key-use gate |

### 7.3 Track / policy

| ID | Title | Notes |
| --- | --- | --- |
| TWV-2026-006 | Release integrity, SBOM, reproducible builds | Ongoing |
| TWV-2026-017 | No silent chain switches | UX review |
| TWV-2026-020 | App-store impersonation monitoring | Operations |
| TWV-2026-021 | `Object.freeze(Object.prototype)` + Zod at bridge boundary | Low cost, do in next refactor |
| TWV-2026-025 | Biometric-gated SecureStore reads (TEE-enforced) | UX trade-off |
| TWV-2026-027 | DNSSEC / RPKI for our infra | Platform team |
| TWV-2026-028 | Multi-RPC consensus read | Verify `MultiProvider.ts` enforces |
| TWV-2026-029 | EIP-1559 only, verify chainId in every signed payload | Viem defaults OK, add tests |
| TWV-2026-030 | WalletConnect v2 via SecureStore if integrated | Future feature |
| TWV-2026-031 | Stable uuid/rdns for EIP-6963 | `services/chains/evm/eip6963.ts` audit |
| TWV-2026-012 | Always show EIP-712 `verifyingContract`, `chainId` | Signer UI |
| TWV-2026-014 | Red-pill-resistant simulator (or disclose reliance on 3rd party) | Simulator vendor review |
| TWV-2026-019 | No runtime remote JS loading in app process | Confirm via audit |
| TWV-2026-034 | Reproducible signer UI (any future multisig feature) | Spec at design time |
| TWV-2026-036 | Dev-machine posture; out-of-band tx attestation for any operational signing | Operational runbook |
| TWV-2026-037 | Partition hot-wallet keys per chain (if/when we run hot wallets) | Architecture |
| TWV-2026-039 | Independence property for multisig/guardian sets | Design-time property |
| TWV-2026-040 | Flag known Profanity vanity-prefix patterns on import | `services/walletService.ts` import path |
| TWV-2026-041 | Paymaster allowlist + per-sender caps (if sponsored-gas feature ships) | `services/agent-executors/` |
| TWV-2026-042 | Multi-bundler fallback for UserOp submission | `services/rpc/` generalisation |
| TWV-2026-043 | Social-recovery: time-lock, pinned guardian addrs, hw-rooted guardian | `docs/social-recovery-spec.md` (future) |
| TWV-2026-044 | UserOp hash binds EntryPoint + chainId; ECDSA-s normalisation | Smart-account audit checklist |
| TWV-2026-045 | ERC-7562 validation rules enforced on paymaster / bundler | Integration acceptance criteria |
| TWV-2026-046 | HW pairing: attestation + anti-klepto auxiliary entropy | HW-pairing UX spec (future) |
| TWV-2026-047 | HW pairing: numeric-comparison BLE; warn on multi-pair | HW-pairing UX spec (future) |
| TWV-2026-048 | HW pairing: show firmware version + release-notes link | HW-pairing UX spec (future) |
| TWV-2026-053 | Uniswap v4 hook address + allowlist display | `services/decoders/calldata.ts` (when v4 supported) |
| TWV-2026-057 | Hermes-only RN engine; native-layer signing; zero JS-heap dwell | `app.config.ts`, `services/walletService.ts` |
| TWV-2026-063 | No clipboard auto-read; explicit "Paste" with seed-detection warning | Import/paste UI |
| TWV-2026-065 | Official distribution discipline; SHA-256 in About screen | Release / brand-protection ops |

## 9. Defense-in-Depth Checklist

A minimum-viable set of controls that cover 80% of the catalogue. All must be true before a production release.

### Key custody
- [ ] Seed & private keys only in `expo-secure-store` with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.
- [ ] `SecureStore.setItemAsync` / `getItemAsync` always passes `requireAuthentication: true` for signing material.
- [ ] `android:allowBackup="false"` and `dataExtractionRules` set; legacy `fullBackupContent` also configured.
- [ ] CSPRNG (`expo-crypto` / `react-native-get-random-values`) imported in `pollyfills.ts` before any Viem use.
- [ ] No seed material ever in logs, analytics, Redux state, `AsyncStorage`, or files.
- [ ] TEE-enforced biometric gate on every read of signing material.
- [ ] Android signing keys generated with `setInvalidatedByBiometricEnrollment(true)` + `setUnlockedDeviceRequired(true)` + `setIsStrongBoxBacked(true)` where available.
- [ ] iOS signing items use `kSecAccessControlBiometryCurrentSet`; biometric changes invalidate.
- [ ] App-level password independent of device passcode for biometric-rebinding recovery.
- [ ] Key Attestation (Android) / App Attest (iOS) validated at launch; failure gates high-value signing.
- [ ] Private key plaintext never returned to JS; signing happens via native module with Keychain handle.
- [ ] Import flow flags known Profanity-class vanity-prefix patterns and warns to migrate funds.

### Seed / sensitive-screen UX
- [ ] All seed `TextInput`s: `autoCorrect=false`, `spellCheck=false`, `autoCapitalize="none"`, `keyboardType="visible-password"` (Android), `textContentType="none"` (iOS), `importantForAutofill="no"` (Android).
- [ ] `FLAG_SECURE` / `expo-screen-capture` on every seed, private-key, and signature-prompt screen.
- [ ] Copy-to-clipboard prohibited for seed; paste-from-clipboard also prohibited.
- [ ] No auto-clipboard-read anywhere; explicit "Paste" button required; paste detects BIP-39-shaped input and warns.

### Signatures
- [ ] `eth_sign` is hard-rejected.
- [ ] `personal_sign` renders message as plain UTF-8 only.
- [ ] `eth_signTypedData_v4` fully decoded: `domain.{name,version,chainId,verifyingContract}` shown.
- [ ] Permit / Permit2 decoded with spender, amount (with unlimited warning), deadline.
- [ ] `setApprovalForAll` and `approve(max)` show explicit red warning.
- [ ] Every signature runs through a pre-sign simulation; UI shows asset delta, not just calldata.
- [ ] EIP-7702 authorizations routed through allowlist (`docs/eip7702-delegator-allowlist-spec.md`).
- [ ] Safe / multisig `execTransaction`: tx hash re-derived from raw params client-side; `operation == 1` (`delegatecall`) triggers hard warning.
- [ ] Claim-label heuristic: if dApp-declared label is claim/harvest/redeem but simulated net delta is zero/negative, hard-warn.
- [ ] Signer UI rendered as native RN modals, never HTML overlays; WebView JS fullscreen API disabled.
- [ ] 3-second cool-down timer on Permit / Permit2 / `setApprovalForAll` sign button.
- [ ] Live scam-domain feed integrated; flagged origins hard-block signatures.

### DApp browser / EIP-1193
- [ ] `react-native-webview` ≥ 11.0.0.
- [ ] `originWhitelist` restricts to `https://*`.
- [ ] Injected provider binds every request to the top-frame origin at call time.
- [ ] Chain-ID used for signing is from the internal registry, never RPC-reported.
- [ ] Chain switches always require explicit user tap.
- [ ] `wallet_addEthereumChain`: `blockExplorerUrls` / `iconUrls` / `rpcUrls` validated against chainid.network registry; non-matching values display "Custom — unverified" banner.
- [ ] URL bar renders non-ASCII domains in punycode form with IDN-homograph warning.
- [ ] WebView fullscreen API disabled (`allowsFullscreenVideo={false}` + JS override).

### Network
- [ ] SSL / SPKI pinning on all backend + RPC hosts (with backup pins).
- [ ] Android `network_security_config.xml` excludes user-installed CAs.
- [ ] Multi-RPC consensus for balance/allowance reads.
- [ ] All txs EIP-1559 with explicit `chainId`.
- [ ] Swap-like calldata routed through private mempool (Flashbots Protect / MEV Blocker) by default on mainnet; opt-out only with user warning.
- [ ] Post-send execution-quality card compares expected vs. actual price; recommends private relay if sandwiched.

### Supply chain
- [ ] `pnpm install --frozen-lockfile` in CI and EAS Build.
- [ ] Lockfile diffs reviewed in PR.
- [ ] `pnpm audit --prod` and Socket/Snyk gate.
- [ ] No runtime-loaded remote JS (`eval`, `Function(string)`, dynamic `<script>`).
- [ ] Zod schema validation on every inbound bridge / RPC / deeplink payload.
- [ ] **EAS Update code signing** enabled (`expo.updates.codeSigningCertificate`); signing key lives in cloud KMS / HSM, not CI env vars; two-person approval on key use.
- [ ] Monotonic `runtimeVersion` + publish-time; client rejects older-than-installed manifests (no rollback).
- [ ] Production channel push-protected; pre-release channels require in-app Settings opt-in, never a deeplink.
- [ ] Launch-time bundle SHA-256 compared against signed manifest; mismatch refuses to run.
- [ ] Bundle audited for hardcoded secrets (no API keys or backend admin URLs in JS).
- [ ] Sensitive logic (key derivation, signing preamble) moved to native modules; obfuscation treated as speed-bump only.

### Platform
- [ ] Universal Links (iOS) + App Links (Android) for every sensitive deeplink; AASA/assetlinks.json hosted.
- [ ] Custom-scheme deeplinks open preview screen, never auto-execute.
- [ ] Root/jailbreak detection shown as warning (not as the sole gate).
- [ ] `Object.freeze(Object.prototype)` at app init.
- [ ] Hermes (not JSC) confirmed via `app.config.ts` `jsEngine: "hermes"`.
- [ ] Play Integrity (Android) + App Attest (iOS) checked before sign-above-threshold operations.
- [ ] Frida / debugger presence check as warning surface; treat as advisory.
- [ ] "Signing-mode" profile disables dApp browser, deeplinks, and push for high-value users.
- [ ] Push notifications signed by backend with key pinned in app; signature verified before rendering; notifications never deep-link into a signature request.

### Observability
- [ ] Sentry/PostHog/logger configured with `beforeSend` scrubber that drops events containing BIP-39-word-run regex, 0x-prefixed 64-char hex, or 32-byte base58.
- [ ] No `console.log` of wallet state in production (lint rule).

### AI agent specific
- [ ] Agent tool-call outputs sanitised for URLs before rendering or `Linking.openURL`.
- [ ] External-link confirmation dialog for any non-allowlisted host.
- [ ] Agent-signed txs pass the same simulation + decoding gate as user-signed txs.
- [ ] Agent never sees raw seed or private key material; it only requests signatures via the same bridge.
- [ ] Per-tool spend caps / allowlisted contract destinations.

### Account abstraction (if/when adopted)
- [ ] Paymaster policy enforces per-sender rate + cumulative-gas caps; signature-based (off-chain co-signer) preferred over permissive on-chain-only.
- [ ] Paymaster `callData` target allowlist (only our account contract + audited routers).
- [ ] Multi-bundler fallback strategy with inclusion-SLA monitoring; private-mempool-compatible bundlers preferred.
- [ ] ERC-7562 validation rules enforced (no forbidden opcodes, restricted storage access).
- [ ] Account contract's `getUserOpHash` includes EntryPoint + chainId + full struct; ECDSA `s` normalised (EIP-2); reject cross-EntryPoint replay.
- [ ] Social recovery (if shipped): ≥ 48–72h time-lock, push+email+SMS on initiation, pinned guardian addresses (no ENS resolution at recovery), at least one hardware-rooted guardian.
- [ ] Guardian address bytecode monitored: EOA→contract transition (possible EIP-7702 hijack) triggers alert.

### Hardware wallet pairing (if/when adopted)
- [ ] Device attestation challenge at pairing time; firmware version + release-notes shown.
- [ ] BLE pairing uses numeric-comparison or OOB, never "Just Works."
- [ ] Anti-klepto / auxiliary-entropy scheme for signing nonces where vendor supports.
- [ ] Warn on multi-pair (same HW device paired with multiple apps).

## 10. Change Log

| Version | Date | Notes |
| --- | --- | --- |
| v1.0 | 2026-04-16 | Initial catalogue — 32 entries across 7 categories. |
| v1.1 | 2026-04-16 | Added 33 entries (TWV-2026-033 … TWV-2026-065) across 6 new categories: 2024–2025 major incidents (Bybit $1.4B, WazirX $230M, Radiant $50M, DMM $305M, Phemex $85M, Penpie $27M, Orbit $82M, Wintermute/Profanity $160M), ERC-4337 account abstraction, hardware wallet pairing, extended signature/protocol attacks (EIP-3085 explorer abuse, MEV pending-tx leak, airdrop drainer farms, IDN homograph, Uniswap v4 hooks, push phishing), extended mobile/Expo/RN platform (EAS Update OTA, Hermes bytecode, JSC memory dump, RN-bridge Frida, `allowBackup` leak, Keychain accessibility, biometric rebinding, Android StrongBox attestation), and extension/desktop pair (clipboard auto-paste, fullscreen-dApp spoof, fake Ledger Live). Total: 65 entries across 13 categories. Roadmap + Defense-in-Depth checklist extended (EAS code signing, biometric invalidation-on-enrollment-change, ERC-4337 paymaster allowlist, Safe tx-hash re-derivation, IDN punycode, Flashbots Protect default, signed push notifications, HW-pairing attestation). |
| v1.2 | 2026-04-16 | Added §7 **Implementation Principles — Non-Regression & Feature Preservation**: behaviour-preservation contract (9 rules), PR process gates, explicit anti-patterns, acceptance sign-off checklist. Renumbered: Roadmap →§8, Defense-in-Depth →§9, Change Log →§10. No entries added; governs how every existing TWV-* mitigation must be implemented so security fixes do not regress working features, break stored-state, change public APIs, or degrade performance/offline behaviour. |

