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
