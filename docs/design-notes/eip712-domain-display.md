# EIP-712 domain display — audit + required UI contract

**Spec reference:** `wallet-security-vulnerabilities-spec.md`
TWV-2026-012 (task 45). Companion: TWV-2026-016 (task 7, registry
chainId), TWV-2026-008 (task 8, Permit/Permit2 decoding).

**Status:** Implemented 2026-08-11 (spec phase H of
`docs/wallet-standards-hardening-spec.md`). §1 below is preserved as the
2026-04-16 audit that motivated the contract; §6 records what shipped
and the two deviations.

A typed-data signature whose `domainSeparator` is reused across
contract deployments — or whose `chainId` doesn't match the chain
the user is signing on — is replayable in a different context. The
only robust defence on the wallet side is to show the user the full
`EIP712Domain` and refuse (not merely warn) a `chainId` that doesn't
match the registry-derived active chain.

## 1. Current-state audit — 2026-04-16

Source files inspected:

- `components/dapps-browser/approvals/EvmSignMessageSheet.tsx` — the
  sign-typed-data approval sheet.
- `services/decoders/erc2612.ts` — ERC-2612 `permit` typed-data
  decoder.
- `services/decoders/permit2.ts` — Uniswap Permit2 decoder.
- `services/bridge/inspectors/HeuristicInspector.ts` — the
  cross-cutting heuristic checks on payloads.

### 1.1 What the signer UI shows today

For `signTypedData` requests, `EvmSignMessageSheet` renders (in
order):

1. `DecodedPermitCard` if the payload matches an ERC-2612 or
   Permit2 template. Fields shown: spender, token, amount, deadline
   (or expiration for Permit2). Domain fields are NOT shown in this
   card.
2. `RawMessageCard` fallback when no decoder matches. Renders
   `JSON.stringify(typedData, null, 2)` — the domain fields appear
   as part of the JSON blob, buried below the fold on typical
   screens.

### 1.2 What is hidden today

- `domain.name` — visible only in the raw-JSON fallback; absent from
  the Permit cards.
- `domain.version` — visible only in the raw-JSON fallback; absent
  from the Permit cards.
- `domain.chainId` — visible only in the raw-JSON fallback; absent
  from the Permit cards. No cross-check against the active chainId.
- `domain.verifyingContract` — visible only in the raw-JSON fallback;
  absent from the Permit cards. No known-contract name lookup.

### 1.3 Existing cross-check gaps

- `HeuristicInspector.ts` flags SIWE domain-mismatch
  (`siwe.domain-mismatch`) and add-chain domain-mismatch
  (`addChain.domain-mismatch`). It does NOT flag an EIP-712
  `domain.chainId` that differs from the active chain — there is no
  `typedData.chainId-mismatch` annotation today.
- No refusal path: even when a mismatch is detected via other
  channels, the signing sheet shows a warning banner ("Hold to
  sign") rather than refusing outright.

### 1.4 Summary of gaps

| Requirement                                        | Status today |
|----------------------------------------------------|--------------|
| `domain.name` above the fold                       | Missing      |
| `domain.version` above the fold                    | Missing      |
| `domain.chainId` above the fold                    | Missing      |
| `domain.verifyingContract` above the fold          | Missing      |
| chainId-mismatch detection                         | Missing      |
| chainId-mismatch refusal (not just warn)           | Missing      |
| Known-contract name lookup for `verifyingContract` | Missing      |
| Regression tests covering chainId-mismatch         | Missing      |

Follow-up tickets are filed separately (this is a design note, not a
feature PR).

## 2. Required UI contract

Any future signer-UI change that touches typed-data signing MUST
satisfy:

### 2.1 Above-the-fold domain block

A dedicated "Signing domain" card renders ABOVE the Permit /
fallback sections, with all four fields visible without scrolling
or expanding any disclosure:

- `name` — full string, not truncated.
- `version` — full string.
- `chainId` — decimal, plus the human name (e.g., `1 — Ethereum
  Mainnet`) resolved from the chain registry (cross-link task 7 /
  TWV-2026-016).
- `verifyingContract` — full address, plus a known-contract badge
  (e.g., "Uniswap Permit2", "Safe") from the bundled lookup table.

No disclosure toggle gates these fields. "Details" expanders may
exist for additional metadata (types, message body), but the four
domain fields are unconditional.

### 2.2 chainId-mismatch refusal

If `domain.chainId` differs from the registry-derived active
chainId:

- Preferred: the signing sheet **refuses** the signature. The sheet
  shows a full-card error: "This signature is for chain N (Polygon),
  but you are connected to chain M (Ethereum). Switching context
  for a signature can be replay bait. Takumi won't sign until the
  active chain matches."
- Pre-merge fallback (if refusal ships after the warning path):
  prominent red banner + long-press hold-to-sign.
- Registry chainId is per task 7 / TWV-2026-016 — NEVER use the RPC
  `eth_chainId` for this comparison. That is the whole point of
  task 7.

### 2.3 Known-contract name lookup

`verifyingContract` is resolved from a **bundled-at-build-time**
list. Initial seed:

- Uniswap Universal Router.
- Uniswap Permit2.
- 1inch AggregationRouter.
- 0x Proxy.
- Safe (per-chain Safe deployment addresses).

Unknowns render as the full address plus a "Fresh contract" badge
if the deployment is < 30 days old (queried via the on-chain
history indexer, `services/indexer/`).

The lookup NEVER fetches at signing time — the dataset ships in
the bundle, updates are code PRs, offline-safe.

### 2.4 Regression tests

CI runs tests covering:

- **`RegressionTest-chainIdMismatch`:** a typed-data payload with
  `domain.chainId: 137` while the active chain is `1`. Assert the
  signer UI refuses (or, fallback, surfaces the hold-to-sign banner
  with the refusal copy).
- **`RegressionTest-minimumFields`:** render a typed-data sheet
  with a payload containing all four domain fields. Assert all four
  are rendered above the Permit / fallback block.
- **`RegressionTest-missingDomainField`:** payload whose
  `domain.verifyingContract` is missing. Assert the UI surfaces
  "missing contract" explicitly rather than silently defaulting.
- **`RegressionTest-knownContract`:** `verifyingContract` matches a
  bundled Permit2 address. Assert the "Uniswap Permit2" badge
  renders.

## 3. Review gate

- `components/dapps-browser/approvals/EvmSignMessageSheet.tsx` —
  any PR touching this file MUST cite TWV-2026-012.
- `services/bridge/inspectors/HeuristicInspector.ts` — adding a
  `typedData.chainId-mismatch` annotation is the companion change
  to §2.2; cite TWV-2026-012 when it lands.
- `services/decoders/` — when the Permit cards are extended, the
  domain block from §2.1 must appear above them.
- PR template prompt: "touches EIP-712 signer UI? cite
  TWV-2026-012."

## 4. Cross-links

- Task 7 / TWV-2026-016 — use registry chainId, not RPC
  `eth_chainId`, for mismatch checks.
- Task 8 / TWV-2026-008 — Permit/Permit2 decoding sits on top of
  the domain block specified here.
- Task 48 / TWV-2026-034 — reproducible signer UI; domain display
  is part of the reproducibility surface.

## 5. Follow-up tickets (not blocking this note)

All four landed — see §6.

- ~~Add `DomainCard` to `EvmSignMessageSheet`~~ → `SigningDomainCard`.
- ~~Extend `HeuristicInspector` with `typedData.chainId-mismatch`~~.
- ~~Ship a known-contract lookup table~~ → reused
  `services/decoders/knownSpenders.ts` rather than a new table in
  `constants/`; see §6.
- ~~Wire the regression tests into CI~~ → `eip712Domain.test.ts`.

## 6. What shipped — 2026-08-11

| §2 requirement | Shipped as |
| :---- | :---- |
| Domain block above the fold | `SigningDomainCard` in `EvmSignMessageSheet.tsx`, rendered before the SIWE / permit / raw cards, no disclosure toggle |
| chainId-mismatch detection | `typedData.chainId-mismatch` in `HeuristicInspector.ts` |
| chainId-mismatch refusal | `chainMismatch` in the sheet: refusal card + `disabled` approve button. Not a hold, not a confirmation |
| Known-contract lookup | `isKnownSpender(verifyingContract, chainId)` |
| Regression tests | `services/decoders/__tests__/eip712Domain.test.ts` |

Two deliberate deviations from §2:

1. **Lookup table location.** §2.3 called for a new bundled table in
   `constants/`. It ships as an extension of
   `services/decoders/knownSpenders.ts` instead — that table was already
   bundled-at-build-time, offline-safe and reviewer-gated, so a second
   one would have been two lists to keep honest rather than one. Phase F
   extended it with the Seaport addresses at the same time.

   The "Fresh contract" badge for deployments under 30 days old is
   **not** implemented: §2.3 sources it from `services/indexer/` at
   signing time, which contradicts the same section's "NEVER fetches at
   signing time" rule. Left out pending a resolution of that conflict.

2. **Chain resolution.** §2.2 says to use the registry-derived active
   chain. The implementation uses the **per-origin** chain the adapter
   resolved for this dApp session (`activeChainId` stamped onto
   `EvmSignTypedDataPayload`), which is stricter: the home-screen active
   chain and the chain a dApp is on can differ, and comparing against
   the home-screen one would produce false mismatches. This follows the
   dApp-bridge isolation rule.
