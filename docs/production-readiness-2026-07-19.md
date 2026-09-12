# Production readiness review — 2026-07-19 (pre-ship)

Full sweep across `mobile-app`, `api`, and `agent-api` the day before the
end-user release. Everything fixable in code was fixed in this pass (see
"Fixed in this pass"); the items below are the findings that are NOT code
changes — config, process, and accepted-risk notes. Work through the
ship-day checklist before release.

## Ship-day checklist (must verify before release)

1. **Confirm which branch ships.** The Stellar-only client lockdown
   (`services/walletKit/chainSupport.ts`, commit `c732da3`) exists ONLY
   on the `stellar-hackathon` branch. `main` — this branch — is the full
   multi-chain app with all four kits registered and chain visibility
   driven by the `/blockchains` API `isActive` rows. If tomorrow's build
   is meant to be Stellar-only, ship from `stellar-hackathon` (or merge
   it); if it's the multi-chain release, verify the production DB's
   `isActive` blockchain rows match exactly the chains you intend to
   expose.
2. **api DB migration ordering.** The `walletAddressLower` column drop /
   canonical-`walletAddress` dedup (expand/contract) backfill script has
   not been run on prod. Run the expand step + backfill BEFORE deploying
   the code that assumes the contracted schema.
3. **Push notifications.** `NotificationLog.deliveryStatus` /
   `expoTicketIds` are queryable — after the first prod sends, check that
   table for `error` tickets (DeviceNotRegistered prune loop is in place,
   but confirm the "strategies" Android channel exists on fresh installs
   of THIS build).
4. **Agent keep-alive module** (`modules/agent-keep-alive`) requires an
   EAS build that includes it AND the Google Play Foreground-Service
   (dataSync) declaration in the Play Console. Confirm the submitted
   binary + Play declaration match, or in-flight agent turns will die in
   the background.
5. **Signing-cert SHA-256** in `constants/about.ts` must match the Play
   App Signing key for the uploaded release (distribution discipline,
   TWV-2026-065).

## Security posture notes (accepted risk / follow-ups, no code change now)

- **Prompt-injection: approval UI is now facts-first** (fixed in this
  pass — see below). Remaining residual risks:
  - `sanitizeApiResponse` (mobile) is a regex blocklist — a tripwire,
    not a boundary. Fine as defense-in-depth now that approval surfaces
    render facts, but do not add new trust on top of it.
  - The x402 `tool_overrides: "silent"` path lets an authorized x402
    micropayment execute with no card. Bounded by the pre-signed
    allowance; keep the allowance small and monitor
    `agent_tool_completed` events for anomalous frequency.
  - The 6 s run-down veto on authorized writes is a product decision;
    consider requiring an explicit tap above a USD threshold
    (`meta.amount_usd` is already on the wire).
  - Truncated addresses (`0x1234…abcd`) on approval cards are honest but
    prefix/suffix-collision phishing is theoretically possible; the full
    address is visible on the per-namespace receipt cards.
- **agent-api** already builds `meta.human_summary` server-side from
  Zod-validated args (deterministic template) and instructs models that
  tool-result text is data, not instructions, with the `leakFilter`
  structural backstop. No change needed.

## Deep security audit — agent prompt-injection + wallet vulns (2026-07-19)

Second, deeper pass specifically targeting (a) the "a prompt-injected agent
moves user funds" class (the Grok-style incident) and (b) the classic crypto-
wallet vulnerability classes. Scope: `mobile-app`, `agent-api`, `api`.

### Fixed in this pass

- **Mobile now cross-checks tool capability instead of blindly trusting the
  wire.** `authorizeToolCall` (the single gate deciding silent-vs-approval)
  keyed its decision off `payload.meta.capability`, a label produced by the
  server and sent over the network, with NO independent mobile check. A
  compromised / buggy / MITM'd stream that labeled a real write (e.g.
  `send_token`) as `"read"` would have run it silently — no card, no user in
  the loop: the exact agent-drain class. Fix: a wire-independent
  `MOBILE_WRITE_TOOLS` set (`services/agent-executors/expectedMobileTools.ts`)
  lists every server `capability: "write"` mobile tool; `authorizeToolCall`
  now coerces any known-write labeled `read` up to `write` (approval required)
  and logs the mismatch in `__DEV__`. Drift is prevented by a new
  `registryParity.test.ts` assertion that the set equals the server registry's
  write tools exactly (fails CI if a new write tool isn't mirrored). Only the
  dangerous direction is hardened (write-as-read); a read-as-write is not a
  fund hole and is left to the wire.

### Verified SAFE (no change needed — for the record)

- **Agent write path, by default, cannot drain silently.** The default
  `HOT_WALLET_POLICY.write` is `confirm` — every agent write is a two-step
  explicit approval unless the *user* has granted standing permission. The 6 s
  run-down auto-execute only applies after such a grant, and even then renders
  a facts-first card (fixed in the first pass). Server capability is stamped
  from the static `TOOL_REGISTRY` keyed on tool name (unknown tools default to
  `write`), so the model cannot relabel its own call.
- **Key custody.** Seed / private keys live only in `expo-secure-store` with
  `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (no cloud backup, no device transfer). Never
  logged; the chain codecs explicitly refuse to `console.log` secret
  `Uint8Array`s; `sanitize-messages.ts` redacts `seed_phrase`/`private_key`/
  `mnemonic`/`otp`/… from agent transcripts.
- **Key-generation entropy.** Mnemonic keygen uses `crypto.getRandomValues` +
  `entropyToMnemonic` with a hard CSPRNG-presence check; `pollyfills.ts`
  enforces CSPRNG-first import order (TWV-2026-002) with a self-check. Every
  `Math.random` in the tree is a non-security id (idempotency keys, request
  ids); the one relayer-salt fallback is unreachable in the RN runtime and is
  replay-protection, not key material. Imported addresses are screened for
  Profanity-class vanity patterns (TWV-2026-040).
- **dApp WebView bridge.** `eth_sign` (blind 32-byte hash) hard-rejected
  (TWV-2026-007); `eth_sendRawTransaction` rejected; every signing method
  (`personal_sign`, `eth_signTypedData_v1..v4`, `eth_sendTransaction`) routes
  through an approval intent — nothing signs without a sheet. Origin pinning
  against the tracked top-frame (TWV-2026-013) blocks sub-frame/iframe
  impersonation; session-nonce isolation silently drops replayed / foreign-
  session messages (TWV-2026-015); one pending approval per origin. The
  injected WebView script never touches key material — signing stays in RN.
- **Encrypted seed backup.** Argon2id + AES-256-GCM, fresh CSPRNG salt and
  96-bit IV per encryption (no GCM nonce reuse), and the KDF params are bound
  into the GCM AAD so a malicious Drive can't downgrade Argon2 without failing
  the auth tag.
- **Deep links.** The only wired `Linking` listener
  (`useExternalDappLinking`) acts solely on bare `dapp` URLs, opening them in
  the sandboxed browser — it never auto-executes a send. `personal_sign`-style
  or `takumiwallet://send` links are not wired to any auto-execute path.

### Residual / latent (no live exploit; track)

- ~~**`inspectDeeplink` (the TWV-2026-024 mandatory-preview gate) is not wired
  in.**~~ **Closed 2026-09-11** by `docs/deeplink-wallet-interactions-spec.md`
  (Phase 0): `handleDeepLink` and its direct `/send` push are deleted;
  every native URL now passes through `app/+native-intent.tsx` →
  `services/deeplinks/intake.ts`, which applies the gate's policies
  (verified host, seed-material denylist scoped per F4) and routes
  anything that carries intent to the `/link-inbox` interstitial. The
  file routes themselves (`/send?recipientAddress=…` included) are no
  longer reachable by URL at all (invariant S-2, `intake.test.ts`).
- x402 silent path, 6 s run-down, and truncated-address phishing — unchanged
  from the notes above; all bounded, all product decisions.

## Known non-blocking debt (unchanged)

- 66 ESLint warnings remain (unused vars, `import/no-named-as-default`,
  hook deps). Zero errors. Not release-blocking.
- `app/_dev/` screens (sui-compat, stellar-compat, sui-ptb-decode) are
  not routable (underscore-prefixed = excluded from Expo Router) and are
  referenced nowhere in product code.
- Debug dev-client builds crash on navigation (RN 0.85 Fabric assert) —
  debug-only, release builds unaffected (`development-release` EAS
  profile is the workaround).
- `activeChain` chainId re-fetch inefficiency (docs/todolist).

## Fixed in this pass (for the record)

Mobile (`mobile-app`, uncommitted):
- **Prompt-injection hardening of every agent write-approval surface.**
  New `components/home/TakumiAgent/StructuredUI/approvalSummary.ts`;
  `UnifiedPendingTxCard`, `PendingTxCard`, `SolanaPendingTxCard`,
  `SuiPendingTxCard`, `StellarPendingTxCard`, `SpendingApprovalCard`,
  `AgentMode` (ApprovalSheet), `showPreviewCard` now derive the approval
  line from the tool's actual args (to/amount/asset); model-authored
  `human_summary`/`description`/`spender_name` can no longer replace the
  facts a user approves.
- **dApp-bridge isolation bug in `SwitchChainSheet`**: the "From" network
  came from the home screen's `useWallet().activeChain` instead of the
  dApp session's chain. The EVM adapter now stamps
  `fromChainId`/`fromChainName` into the switch-chain payload and the
  sheet renders only intent data. Its `check:chains` allowlist entry was
  removed (namespace branch deleted).
- 8 JSX unescaped-apostrophe lint errors; em-dash-in-UI-copy violations
  in `NewDeviceSheet`, `PendingTxCard`, `StrategyConfigCard`,
  `RebalancePreviewCard`, `StellarTransactionSheet`, `agentErrorCopy`,
  `StellarXdrDecoderInspector`, `suilendSui` withdraw message.
- `biome.json`: excluded `services/agent-executors/agentManifests.json`
  from Biome so formatting can never break byte-parity with agent-api's
  manifest copy (`check:agents`).

api (uncommitted):
- 3 jest suites (`pay/intents.service.spec`, `pay/intents.service.svm.spec`,
  `payout/webhook.controller.spec`) were silently dead — expo-server-sdk
  6.x ships ESM-only and Jest can't parse it; added the repo-standard
  `jest.mock("expo-server-sdk", ...)` stub to each. This unblocked 106
  tests, which exposed one drifted fixture on the idempotent-replay path
  (replay now delegates to `getIntent`'s serializer); fixture updated to
  the real `include` shape. Production code was correct (the `merchant`
  relation is required in the schema).

Verification: mobile `tsc`, `check:chains`, `check:agents`, `check:defi`,
Biome all green; vitest 358/358, node:test 1503/1503; agent-api tsc +
273/273; api tsc + 890 passed / 6 skipped.
