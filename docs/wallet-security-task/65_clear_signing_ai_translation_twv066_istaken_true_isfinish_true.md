# Task 65 — Chain-agnostic clear-signing decode + digest + AI plain-English summary

**Status:** Implemented (2026-07-20)
**Owner:** Mobile (mobile-app)

**Implementation map (2026-07-20):**
- Phase A: `services/decoders/calldata.ts` (roundtrip gate,
  `decodeCalldataAgainst`), `services/bridge/inspectors/EvmCalldataDecoderInspector.ts`
  (priority 15, registered in `services/bridge/boot.ts`).
- Phase B: capability types in `services/walletKit/types.ts`; per-kit
  resolvers in `services/walletKit/{evm,solana,sui,stellar}/clearSigning.ts`
  (+ `evm/erc7730Snapshot.ts` pinned registry compile); orchestrator
  `services/decoders/clearSigning.ts`; Stellar Stage-1 extended to carry
  Soroban invocation identity (`services/chains/stellar/xdrDecode.ts`);
  Solana Stage-1 patches `rawInstructions` for the IDL leg.
- Phase C: `computeSigningDigest` on all four kits (EVM byte-matched
  against Cyfrin `clearsig` vectors; Sui against the SDK's own
  `getDigestFromBytes`; Stellar against `tx.signatureBase()` SHA-256);
  shared `components/dapps-browser/approvals/ClearSigningSection.tsx`
  wired into every sign sheet (AgentCardRenderer reuses the EVM
  sheets); dev-log digests in `sendUserOpWithUsdcPaymaster.ts`,
  `signTransferWithAuthorization.ts`, `signX402SvmPayment.ts`.
- Phase D: `services/decoders/summarize.ts` (fail-silent, descriptor
  input only) + `POST /summarize/clear-signing` in the sibling
  `agent-api` (`src/summarize.controller.ts`).
- Phase E: `services/agent-executors/defi/submitTx.ts#buildClearSigningPreview`
  runs pre-sign inside `submitEvmCall` (+ `onClearSigningPreview` seam).
- Phase F: `services/security/claimLabelDelta.ts` accepts
  `resolvedIntent` (leading-verb match, closed claim class); live
  banner in `EvmTransactionSheet` via `onDescriptorResolved`.

**Spec reference:** `../wallet-security-vulnerabilities-spec.md` `TWV-2026-066`
(new Category 14 entry). Builds on already-shipped `TWV-2026-008`
(task 08, Permit/Permit2 decoding), `TWV-2026-011` (task 17,
simulation preview), `TWV-2026-012` (task 45, EIP-712 domain display).
Constrained by `../design-notes/reproducible-signer-ui.md` §3 (no
remote/untrusted decode as a trust source) and §7 (cross-device digest
verification). Architecture follows `feedback_space_docking` — optional
`WalletKitAdapter` capabilities, presence-checked, never a namespace
branch in shared code (`pnpm check:chains`-enforced).

**This app is chain-agnostic (EVM, Solana, Sui, Stellar) and this task
covers every one of them, not just EVM.** ERC-7730/ERC-8213 are
EVM-specific standards; §1 below documents what each other chain
actually has today so the mitigation is grounded per-chain rather than
assumed to generalize.

## 1. Cross-chain standards landscape (verified against primary sources)

**EVM — has ratified/draft standards, needs an external registry:**
- ERC-7730 "Structured Data Clear Signing Format" is **finalized**
  (https://eips.ethereum.org/EIPS/eip-7730). Descriptor resolution
  algorithm and fallback rules are documented in §2 below.
- ERC-8213 "Wallet Signature and Calldata Digest Display" is **still
  draft** (`ethereum/ERCs` PR #1639; spec text at
  https://ethereum-magicians.org/t/erc-8213-wallet-signature-and-calldata-digest-display/24295).
  Re-check finalization status before implementation.
- Because EVM calldata is an opaque byte blob with no on-chain
  "what does this mean" source, closing the gap requires consulting an
  **external** registry (the de facto community one:
  `github.com/ethereum/clear-signing-erc7730-registry`).

**Solana — no ratified standard; the digest question is an open
discussion, not a spec:**
- The closest thing is `solana-foundation/solana-improvement-documents`
  Discussion #513 ("Calldata and EIP-712 digest equivalent SIMD"),
  raised after the Drift protocol incident. **This is a GitHub
  Discussion, not an accepted SIMD** — do not treat it as a standard to
  implement against; treat it as "worth watching."
- Solana doesn't need an ERC-7730-style external registry to the same
  degree EVM does: Anchor-built programs (the large majority of
  Solana's app-layer programs) publish an **on-chain IDL account**
  (fetchable via `@coral-xyz/anchor`'s `Program.fetchIdl(programId,
  provider)`) that is a self-describing, on-chain interface spec — the
  same trust category `reproducible-signer-ui.md` §3 already blesses
  ("on-chain bytecode via pinned RPC call"), just for Solana's own
  program-metadata convention instead of EVM bytecode.
- Sign-In With Solana (SIWS) already covers the off-chain
  message-signing side and is already implemented
  (`SolanaSiwsInspector`).
- Instructions are structurally typed already (`programId` + `accounts`
  + `data`) and already structurally decoded by
  `SolanaProgramDecoderInspector` — the gap this task closes is turning
  a decoded instruction's raw `data` args into named, human fields.

**Sui — no ERC-7730-equivalent; PTBs are structurally safer than EVM
calldata by construction:**
- No clear-signing-specific standard found. Sui's own docs frame the
  problem as "present a human-readable transaction intent" without
  proposing a descriptor format.
- Programmable Transaction Blocks are a typed command list
  (`MoveCall` / `TransferObjects` / `SplitCoins` / …), not a raw byte
  blob — already structurally decoded by `SuiPtbDecoderInspector`. The
  gap is `MoveCall` **argument values**: today the inspector only
  reports `argumentCount`, not named/typed fields.
- Sui closes that gap natively: `sui_getNormalizedMoveFunction` /
  `sui_getNormalizedMoveModule` RPC returns the on-chain function's
  parameter types directly from the deployed package — no external
  registry needed at all, and it's a **pinned RPC call against the
  chain itself**, the same trust category as EVM's `eth_getCode`
  approach, not the "remote decode-for-me service" `reproducible-signer-ui.md`
  §3 bans.
- Sui already computes its own transaction digest as part of the
  protocol (`blake2b256` of the BCS-serialized `TransactionData`) —
  this is the same value shown as the tx digest on any Sui explorer.
  No new digest scheme needs inventing; it just needs to be surfaced
  **before** signing instead of only after.

**Stellar — no clear-signing SEP found; same "native ABI, native
digest" shape as Sui:**
- No SEP addressing blind-signing/clear-signing was found. XDR
  operations are already typed and already structurally decoded by
  `StellarXdrDecoderInspector`.
- The one call `StellarXdrDecoderInspector` already flags as opaque —
  `invokeHostFunction` (Soroban) — has a native fix: Soroban contracts
  publish a **contract spec** (an ABI-equivalent embedded in the
  deployed WASM's custom section), fetchable on-chain per contract ID.
  Same trust category as Sui's normalized-module RPC: a pinned read
  against the chain itself, not a third-party registry.
- Stellar's native transaction hash (`SHA-256` of the XDR
  `TransactionSignaturePayload`) is exactly the "calldata digest"
  concept ERC-8213 had to invent for EVM — Stellar already has it. It
  just needs to be computed and shown pre-signature.

**Net effect on this task's design:** EVM is the one chain that
genuinely needs the two-part ERC-7730 (external registry) + ERC-8213
(new digest math) machinery. Solana/Sui/Stellar can close the same gap
mostly by *surfacing what the chain itself already knows* — on-chain
IDL/normalized-module/contract-spec for the "what does this mean"
side, and the chain's own native tx-digest for the "verify
independently" side. §3 below designs one chain-agnostic shape that
each namespace docks into on those terms.

## 2. ERC-7730 wallet resolution algorithm (EVM path — implement exactly this)

From the finalized spec:
1. Read the human-readable ABI fragment in the descriptor's
   `display.formats` key, e.g. `"transfer(address to,uint256 value)"`.
2. Drop parameter names → type-only signature: `"transfer(address,uint256)"`.
3. `selector = keccak256(<type-only signature>)[:4]`.
4. Match against the transaction calldata's first 4 bytes. On match,
   decode args using the canonical type vector and the matched
   entry's `fields` array for display formatting.
5. For EIP-712: the descriptor key is matched by computing
   `keccak256(encodeType(typeOf(s)))` (per EIP-712's own `encodeType`)
   against `keccak256(TYPE_KEY)`. `context.eip712.domain` /
   `deployments` / `domainSeparator` further constrain which
   descriptor is allowed to bind to a given message.
6. **No match:** SHOULD show "Unknown function" + raw arguments; MUST
   NOT apply an unrelated descriptor's format spec.
7. **Field interpolation fails on an otherwise-matched descriptor:**
   MUST fall back to displaying the descriptor's plain `intent` field.

**ERC-8213 digest formulas + implementation guidance (EVM path — draft
spec; primary source https://erc8213.eth.limo/#/implement, confirmed
against `clearsig`'s reference implementation):**
- Domain Hash = `hashStruct(eip712Domain)` (i.e. `domainSeparator`)
- Message Hash = `hashStruct(message)`
- EIP-712 Digest = `keccak256("\x19\x01" ‖ domainSeparator ‖ hashStruct(message))`
- Calldata Digest = `keccak256(len(calldata) ‖ calldata)` — length is a
  **32-byte big-endian `uint256`**, not a varint, not 4 bytes, not the
  hex-string length.

**Two flows, not one — implement both, per the spec's own decision
axis:**
- **Flow A — EIP-712 typed data** (`eth_signTypedData_v4` and
  friends): compute `domainHash`, `messageHash`, `digest`. Display the
  digest alone or all three.
- **Flow B — raw transaction calldata** (`eth_sendTransaction`,
  `eth_signTransaction`): compute `calldataDigest` only. Display as a
  `0x`-prefixed hex string. `chainId` is deliberately excluded from the
  preimage — same calldata, same digest, across forks; `chainId` is
  already covered by the domain hash where it applies.
- **Pitfall "both, never one":** our EVM sign sheets cover both flows
  (`EvmSignMessageSheet` for typed data, `EvmTransactionSheet`/
  `EvmBatchCallsSheet` for raw calldata) — implementing only Flow A
  would make Flow B look comparatively unverified. Both are in scope.

**Reference implementation — the spec ships a viem snippet, and this
repo already depends on viem, so port it directly rather than
reimplementing the hashing by hand:**
```ts
import {
  keccak256, toBytes, hashTypedData,
  hashDomain, hashStruct, concat, numberToHex,
} from "viem";

// Flow A — EIP-712 digests (strip `EIP712Domain` from `types` before
// calling hashStruct for the message — see pitfall below)
const domainHash = hashDomain({ domain, types });
const messageHash = hashStruct({ data: message, types, primaryType });
const digest = hashTypedData({ domain, types, primaryType, message });

// Flow B — calldata digest; chainId intentionally NOT mixed in
function calldataDigest(calldata: `0x${string}`): `0x${string}` {
  const bytes = toBytes(calldata);
  const lenWord = numberToHex(bytes.length, { size: 32 });
  return keccak256(concat([toBytes(lenWord), bytes]));
}
```

**Named pitfalls (spec §02.D) — encode each as a rule/test, don't
rediscover these the hard way:**
1. **Stripping `EIP712Domain`:** when computing `messageHash`, the
   `EIP712Domain` entry must be removed from the `types` map first, or
   the hash silently comes out wrong (or the library refuses).
2. **Length-prefix encoding:** 32-byte big-endian `uint256`, exactly —
   not a varint, not the raw byte length, not the hex string's length.
3. **`chainId` omitted from the calldata preimage:** deliberate, not a
   bug — don't "fix" it by adding chainId back in.
4. **Hex case:** pick one (lowercase, matching viem's default output)
   and never re-case it anywhere in the pipeline — mixed case turns a
   byte-equality check into a "looks about right" check.
5. **Display, not log:** `console.log`/`__DEV__` output does not
   satisfy this spec. The digest must render on the same screen as the
   approve button.
6. **Both, never one:** see above — a wallet must implement both
   digest flows it's capable of triggering, or the unimplemented one
   reads as suspicious by omission.

**Display rules (spec §02.B) — apply to every sheet in Phase C below:**
- Always `0x`-prefixed; don't invent a custom encoding.
- Never truncate without a reveal — if space forces an ellipsis, give
  the user a tap to see the full 32-byte value before approving.
- Monospace font for the digest text (digit/hex comparison is harder
  in a variable-width face).
- Group bytes in 4- or 8-byte chunks for scanability (optional, but
  cheap and it materially helps eyeballed comparison against
  `clearsig`'s output on a second device).
- Label every value — an unlabelled hex string is just a number; a
  labelled one is evidence.
- **Placement: "not three taps deep."** The digest must be somewhere
  the signer reads it before tapping approve on the primary sheet —
  not nested behind a settings screen or a separate details route. A
  single-tap "reveal full value" affordance on the primary sheet is
  fine (see the truncate-with-reveal rule above); burying the whole
  digest feature behind extra navigation is not.

**`clearsig` CLI surface used to cross-check the EVM path** (from
`github.com/Cyfrin/clearsig`; install via `uv tool install clearsig` /
`pipx install clearsig` / `pip install clearsig`; registry
auto-downloads to `~/.clearsig/registry`, or pin via
`ERC7730_REGISTRY_PATH`):
- `clearsig translate <calldata> --to <address> --chain-id <N>` — must
  match our EVM Stage-2 descriptor resolution for the same input.
- `clearsig calldata-digest <calldata>` (alias `cdg`) — must byte-match
  our EVM digest output.
- `clearsig eip712 <typed-data.json>` — Domain Hash / Message Hash /
  Digest; must byte-match our EVM digest output for typed data.
- `clearsig safe-hash` (alias `sh`) — cross-checks
  `services/decoders/safeTxHash.ts` specifically.
- `clearsig sig` / `clearsig calldata` — selector/calldata construction
  for building test vectors.

There is no equivalent CLI for Solana/Sui/Stellar; cross-check those
paths against each chain's own explorer (tx digest matches what
`solscan.io` / `suiscan.xyz` / `stellar.expert` show post-broadcast)
and against `Program.fetchIdl` / `sui_getNormalizedMoveFunction` /
Soroban spec output directly.

## 3. Architecture — space docking

Two new **optional** `WalletKitAdapter` capabilities
(`services/walletKit/types.ts`), wired per-namespace in
`services/walletKit/bootstrap.ts` exactly like every other optional
capability on that interface (`signTransferWithAuthorization`,
`checkAssetReceivable`, etc.) — a chain that can't do something leaves
the method `undefined`; shared code presence-checks, never branches on
`namespace`.

```ts
/**
 * Resolves a human-readable "what does this call mean" descriptor for
 * an already structurally-decoded call. Input is whatever this kit's
 * own Stage-1 structural decoder already produced (an EVM {to, data,
 * chainId} / decoded selector; a SolanaDecodedInstruction; a
 * SuiDecodedCommand; a StellarDecodedOperation) — never raw
 * undifferentiated bytes. Returns null when no descriptor/on-chain
 * spec is found; callers fall back to the existing bespoke decoders,
 * then to raw. EVM resolves via a bundled/pinned ERC-7730 registry
 * snapshot; Solana via Program.fetchIdl (on-chain IDL account) +
 * a small bundled well-known-program map; Sui via
 * sui_getNormalizedMoveFunction; Stellar via the on-chain Soroban
 * contract spec. Chains without a program/contract layer (a plain
 * Stellar Payment op, a Solana System Program transfer) don't need
 * this — Stage-1 structural decode is already fully legible.
 */
resolveClearSigningDescriptor?(
  args: ResolveClearSigningDescriptorArgs,
): Promise<ClearSigningDescriptor | null>;

/**
 * Computes a reproducible pre-signature digest for independent
 * verification (ERC-8213 on EVM; each chain's own native tx-digest
 * primitive elsewhere — see §1). Deterministic, in-process, no
 * network call for EVM; Sui/Stellar compute the same hash the chain
 * itself would assign as the tx digest, just before signing instead
 * of after.
 */
computeSigningDigest?(
  args: ComputeSigningDigestArgs,
): Promise<SigningDigest>;
```

- `services/decoders/clearSigning.ts` is the **chain-agnostic
  orchestrator**: `resolveClearSigningSummary(ns, args)` calls
  `walletKitRegistry.get(ns).resolveClearSigningDescriptor?.(args)`,
  falls back to the existing per-chain bespoke decoders
  (`erc2612`/`permit2`/`safeTxHash` on EVM) when `undefined` or
  `null`, then to the explicit "unrecognized" state. This file must
  not contain a `namespace ===` branch — it only presence-checks.
- The existing priority-15 structural-decode inspectors
  (`SolanaProgramDecoderInspector`, `SuiPtbDecoderInspector`,
  `StellarXdrDecoderInspector`) are Stage 1 and already dock correctly
  via `InspectorRegistry`'s `namespaces` filter — no changes to that
  pattern. EVM needs a new **Stage-1** inspector
  (`EvmCalldataDecoderInspector`, priority 15, `namespaces: ["eip155"]`)
  since today `services/decoders/` only has typed-data decoders
  (`erc2612`, `permit2`), not a general calldata→selector+args
  structural decoder.
- Both new capabilities are called from Stage-2 code that already runs
  per-namespace-filtered (inspectors or sheets) — the capability
  itself lives on the adapter precisely because resolving an IDL /
  normalized module / contract spec needs an RPC client bound to that
  chain, which is exactly what `WalletKitAdapter` implementations
  already own.
- New chain support "docks" this feature the same way it docks every
  other capability: implement the two methods (or leave them
  `undefined` and get raw-fallback behavior for free), register in
  `bootstrap.ts`. No shared file needs editing.

## 4. Scope — phased, every signing surface

**Phase A — Stage-1 structural decode parity**
- **Not net-new for EVM — wire up what already exists.**
  `services/decoders/calldata.ts` already does bundled
  selector→signature ABI decoding (`decodeCalldata`, small hand-rolled
  `SELECTOR_DB`) with a `risk` tag for `approve`/`setApprovalForAll`
  and an `ambiguous: true` flag when multiple candidate signatures
  share a 4-byte selector. It just isn't wired into a priority-15
  `InspectorRegistry` inspector the way Solana/Sui/Stellar's decoders
  are. Add `EvmCalldataDecoderInspector` (priority 15,
  `namespaces: ["eip155"]`) that calls it — matching the existing
  pattern, not duplicating it.
- **Decode-fidelity roundtrip check (new, closes a real gap in the
  existing `ambiguous` handling).** `decodeCalldata` currently returns
  the *first* candidate signature that doesn't throw during
  `decodeFunctionData` — but "didn't throw" isn't the same as "decoded
  the true, intended function." A 4-byte selector collision between
  two differently-typed functions can both decode without error while
  only one is actually correct. Fix: after decoding, re-encode the
  args with viem's `encodeFunctionData` using the same candidate
  signature and compare byte-for-byte against the original calldata.
  Only a candidate whose re-encoding round-trips exactly is trusted;
  if none round-trips, treat it as `ambiguous`/unresolved rather than
  silently keeping the first guess. Apply the same roundtrip principle
  to the ERC-7730-descriptor decode path in Phase B: **a structured/AI
  translation is only rendered when `encode(decode(bytes)) === bytes`
  holds**; on mismatch, silently fall back to the raw view with a
  "couldn't confidently verify our own decoding of this call" note —
  same posture as an unresolved/no-match case, never a block on
  signing. This is a decoder self-consistency gate, not a security
  gate: it defends against *our own* decode bugs producing a
  confidently-wrong English summary, not against a compromised UI
  substituting the payload (that's what Phase C's digest is for — see
  Rules below for why these are different threat models and neither
  substitutes for the other).

**Phase B — Stage-2 semantic descriptor (the new adapter capability)**
- Implement `resolveClearSigningDescriptor` per kit:
  EVM (bundled ERC-7730 registry snapshot, §2 algorithm) → Solana
  (`Program.fetchIdl` + bundled well-known-program map) → Sui
  (`sui_getNormalizedMoveFunction`) → Stellar (on-chain Soroban
  contract spec).
- `services/decoders/clearSigning.ts` orchestrator + fallback chain to
  existing bespoke decoders, per §3. Every descriptor-driven decode
  goes through the Phase A roundtrip check before it's trusted enough
  to display.

**Phase C — digest display (all sign sheets, all chains)**
- Implement `computeSigningDigest` per kit (§1/§2 formulas). On EVM,
  compute **both** flows where applicable — `domainHash`/`messageHash`/
  `digest` for typed data, `calldataDigest` for raw transactions (§2
  "both, never one" pitfall).
- Every sheet in `components/dapps-browser/approvals/` that signs
  (`Evm{Transaction,BatchCalls,SignMessage}Sheet`,
  `Solana{Transaction,SignAllTransactions,SignMessage}Sheet`,
  `Stellar{Transaction,SignMessage}Sheet`,
  `Sui{Transaction,SignPersonalMessage}Sheet`, `AgentCardRenderer`)
  renders a labelled, monospace, `0x`-prefixed digest **on the primary
  sheet surface, before the approve button** — not behind a settings
  screen or a separate route ("not three taps deep," §2 display
  rules). It's still advisory/power-user and must not block the
  primary flow (same posture as `reproducible-signer-ui.md` §7): a
  single-tap "show full value" affordance is fine if space forces
  truncation, but the labelled digest itself must be visible without
  extra navigation. Group hex in 4/8-byte chunks for scanability.
- Native gas-abstracted signing (`sendUserOpWithUsdcPaymaster.ts`,
  `signTransferWithAuthorization.ts`, `signX402SvmPayment.ts`) computes
  and logs the digest even though these are first-party UIs with no
  dedicated approval sheet today — defense-in-depth against a
  compromised UI layer, not blind-signing prevention (the payload is
  app-authored, not dApp-authored).

**Phase D — AI plain-English summary layer (one implementation, all chains)**
- `services/decoders/summarize.ts`: input is the **chain-agnostic
  `ClearSigningDescriptor`** from Phase B — never raw hex/BCS/XDR,
  never the dApp's own description. Output: one sentence of plain
  English. Because Phase B already normalized every chain's shape into
  one descriptor type, this layer needs no per-chain branching at all.
- Wire into the same sheets as Phase C. Rendered as a labeled "AI
  summary" line, with the structured fields (or explicit "couldn't
  identify this contract call" state) always shown too — never
  AI-text-only. No descriptor → no AI line; don't let the model guess
  at unparseable bytes.
- Failures follow the standard user-facing-errors rule (`CLAUDE.md`):
  hide the AI line, fall back silently — never surface the raw API
  error in the sheet.

**Phase E — agent-executor coverage**
- `services/agent-executors/defi/submitTx.ts`: run the same Phase B/D
  pipeline before an agent-constructed tx reaches the user's approval
  card, same as any dApp-initiated one.

**Phase F — generalize claim-vs-delta beyond the keyword heuristic**
- `services/security/claimLabelDelta.ts` (task 27 / `TWV-2026-038`,
  already shipped) is the actually-independent cross-check this whole
  task should lean on more, not a self-hash gate: it compares a
  *claimed* label against the simulator's independently-computed
  `AssetDelta[]` — two genuinely different origins (declared intent
  vs. real execution semantics), which is exactly the property a
  same-source hash comparison can't provide (see Rules below). Today
  `looksLikeClaim` only fires on a regex over free-text labels
  (`claim|harvest|collect|redeem`) matched against `dappLabel` /
  `functionName`.
- Once Phase B gives every recognized call a structured `intent`
  (not just claim-shaped ones — "Supply", "Approve", "Transfer",
  "Swap", …), extend `ClaimMismatchInput` to accept the resolved
  `intent` as an additional, more reliable label source alongside
  `functionName`/`dappLabel` — structured, not regexed off free text,
  so it's harder to evade than string matching. Keep the existing
  regex path as a fallback for calls Phase B doesn't resolve.
- Scope the generalization to intents with a well-defined delta
  invariant (start with the existing claim/harvest/collect/redeem
  class — "should be net-positive inflow"); don't invent invariants
  for intent classes where "correct" delta shape isn't obvious (e.g.
  arbitrary multicalls) — a wrong invariant produces false-positive
  fatigue, which is worse than the narrower heuristic it replaces.
- This phase depends on Phase B (structured intent) and the existing
  simulator (task 17) being wired for the chain in question; where
  simulation isn't available, fall back to today's behavior (heuristic
  disabled, not silently assumed-safe — task 27's existing rule).

## 5. UI layout — sign sheet, conclusion

**No manual "decode" trigger.** Everything in Phases B/C/D runs
automatically on sheet mount, same as today's SIWE/Permit2/ERC-2612
cards (no button today, none added here). Requiring a tap before
translation defeats the purpose for exactly the users this task
protects — the ones who don't dig into raw JSON today won't tap a
button either. The only user-facing affordance is *revealing* more of
something already computed, never *triggering* computation:

1. **Origin / domain info** — unchanged (`ApprovalShell`, EIP-712
   domain fields from task 45).
2. **Structured "what this does" card — automatic, no button.**
   Whichever of SIWE / Permit2 / ERC-2612 / a resolved ERC-7730
   descriptor matched (Phase A/B), rendered as labelled English
   fields. If nothing matched: an explicit "Unrecognized contract
   call — review the raw data below before signing" card, not a blank
   space and not a guess.
3. **AI one-line summary — automatic, progressive, no button.** Starts
   as a small loading shimmer the height of one line; swaps in the
   sentence when the call resolves. If Phase B found nothing, or the
   AI call fails, this row simply never appears — no error text, no
   retry button, no blocking of the rest of the sheet (Phase D's
   existing fail-silent rule).
4. **Digest block — automatic, truncated-with-reveal.** Labelled,
   monospace, byte-grouped, visible on this screen without navigating
   away ("not three taps deep," §2). If the full 32-byte value doesn't
   fit, a truncated form shows by default with a single tap to reveal
   the full value — that tap reveals, it does not (re)compute.
5. **"View raw data" — the one real toggle, always present.** Same
   `showRaw`-style expand already shipped on the Solana/Sui sheets.
   Available regardless of whether (2)/(3) resolved, so a power user
   can always inspect the actual bytes even when a friendly
   translation is showing. This is inspection, not a decode trigger —
   the raw bytes are already in memory either way.
6. **Existing risk banners** (unlimited-approval, unknown-spender,
   claim/delta mismatch from Phase F, SIWE domain-mismatch, etc.) —
   unchanged position/behavior, still drive the existing hold-to-sign
   gating.
7. **Approve / Reject** — unchanged. Never gated on whether (3) the AI
   line loaded or (2) resolved a descriptor — a fully-unresolved,
   raw-only sheet must remain signable exactly as it is today
   (§7.1 non-regression contract).

One deliberately excluded feature: an "ask AI to explain anyway" button
for the fully-unresolved case. It's tempting — the raw-fallback case is
where users most want help — but it would mean running the AI directly
against unverified raw bytes, which is precisely what the "AI never
decodes raw bytes" rule exists to prevent (an unverifiable, possibly
wrong, confidently-worded guess is worse than an honest "we don't
know"). Not in scope for this task; would need its own explicit,
heavily-caveated design if ever pursued.

## Rules (non-negotiable)

- **No namespace branching in shared code.** `clearSigning.ts`,
  `summarize.ts`, and every sheet component call adapter methods
  through presence-checks only. `pnpm check:chains` enforces this.
- **Decoders are pure and deterministic.** Same input in, same
  structured fields out.
- **AI never decodes raw bytes.** It only phrases an already-built
  `ClearSigningDescriptor`. If Phase B returns nothing, Phase D does
  not run.
- **Digest (Phase C) is unconditional; descriptor resolution (Phase B)
  is not — these are orthogonal, don't couple them.** ERC-8213 answers
  "is this exactly the bytes I think it is," not "what does this
  mean" — computing `domainHash`/`messageHash`/`digest` only needs
  `domain` + `types` + `message` + `primaryType`, which are present in
  *every* `signTypedData` payload whether or not `resolveClearSigningDescriptor`
  found a match. Same for Flow B: `calldataDigest` only needs the raw
  calldata bytes. **Render the digest block even when Phase B returns
  `null` and the sheet is showing raw/unresolved JSON.** That's the
  case where the digest matters most — it can't make the raw JSON
  readable, but it lets the signer (or a second device via `clearsig
  eip712`) independently verify the exact bytes about to be signed
  weren't swapped by a compromised UI, even when legibility fails.
  Scope boundary: this only covers `signTypedData` (Flow A) and raw
  transaction calldata (Flow B) — a `personal_sign`/`eth_sign` message
  that isn't valid UTF-8 has no `domain`/`types`/`message` struct and
  isn't calldata either, so ERC-8213 defines nothing for it; it stays
  a real, undocumented gap (see task's "Why this matters" follow-up).
- **Digest must be independently reproducible.** EVM: byte-match
  `clearsig`. Sui/Stellar: byte-match the chain's own post-broadcast
  tx digest. Solana: byte-match `sha256` of the serialized message.
- **Never treat same-source hash agreement as a security gate.**
  Hashing our own decode and comparing it to a hash of the bytes we
  decoded *from* is tautological when both sides originate from the
  same untrusted channel — a compromised bridge/UI that swaps a
  payload before decode will produce a decode, an English summary,
  and a digest that all self-consistently agree with each other and
  with the (already-swapped) payload. This is precisely the WazirX
  failure mode; self-hashing cannot detect it by construction. Two
  patterns in this task are exceptions, and they're exceptions for a
  specific, checkable reason — an independent second origin exists to
  compare against:
  - The Phase A/B **roundtrip fidelity check**
    (`encode(decode(bytes)) === bytes`) is legitimate because it
    verifies *our own decoder's correctness*, not the payload's
    trustworthiness — it can only gate whether we *display* a
    translation, never whether we *sign*.
  - The Phase F **claim-vs-simulated-delta check** is legitimate
    because the simulator executes real, independent EVM semantics
    against a trusted RPC — a genuinely different origin from the
    static decode it's being compared against.
  - The Phase C **digest** is legitimate only when compared *outside*
    this app (second device, `clearsig`, a chain explorer) — inside
    the app it is a display value, never a self-verifying gate.
- **"No live fetch at sign time" applies to third-party registries,
  not to pinned reads of the chain itself.** EVM's ERC-7730 registry
  snapshot must be bundled/pinned (never fetched live — a
  compromised/MITM'd registry endpoint must not be able to change what
  a user sees at the moment of signing, same rationale as the Permit2
  address book in task 21). Solana's IDL fetch, Sui's
  `sui_getNormalizedMoveFunction`, and Stellar's contract-spec read are
  **pinned RPC calls against the deployed program/package/contract
  itself** — the same trust category `reproducible-signer-ui.md` §3
  already allows for EVM on-chain-bytecode decoding, not the "remote
  decode-for-me service" it bans. Don't flatten this distinction.
- **Digest/AI-summary UI is additive, never blocking.** Existing raw
  fallback view must keep working for unknown payloads on every chain
  — this task cannot regress signable-tx parity (§7.1 of the spec).

## Acceptance

- [x] `EvmCalldataDecoderInspector` wraps the existing
      `services/decoders/calldata.ts#decodeCalldata` (not a
      reimplementation); unit tests cover the wiring.
- [x] Roundtrip fidelity check: unit test with a synthetic selector
      collision (two candidate signatures, only one of which
      round-trips) asserts the non-round-tripping candidate is never
      shown as a trusted decode; `decodeCalldata`'s existing
      `ambiguous` flag is resolved by the roundtrip check where
      possible instead of "first candidate that didn't throw."
- [x] `resolveClearSigningDescriptor` implemented + unit-tested for
      all four kits (known-descriptor hit, bespoke-decoder fallback,
      no-match → null), wired in `bootstrap.ts`.
- [x] `computeSigningDigest` implemented + unit-tested for all four
      kits; EVM vectors byte-match `clearsig`; Sui/Stellar vectors
      byte-match a real broadcast tx's on-chain digest.
- [x] EVM digest pitfall regression tests (ERC-8213 §02.D): (a)
      `EIP712Domain` stripped from `types` before `messageHash` —
      assert output differs from the naive not-stripped computation;
      (b) calldata length prefix is a 32-byte big-endian `uint256` —
      assert a >255-byte calldata vector still round-trips correctly
      (catches an accidental single-byte/varint length encoding);
      (c) `calldataDigest` output is identical across two different
      `chainId` contexts for the same calldata bytes; (d) both Flow A
      and Flow B are implemented and tested, not just one.
- [x] `clearSigning.ts` and `summarize.ts` contain zero
      `namespace ===` branches — `pnpm check:chains` passes.
- [x] At least one sheet per chain (Evm, Solana, Stellar, Sui) renders
      the labelled, monospace digest visibly on the primary sheet
      (not behind extra navigation) and, when a descriptor matches,
      the AI summary line.
- [x] Unknown-call case on every chain: no AI line, structural/raw
      fallback unchanged from current behavior.
- [x] AI-summary-call failure: sheet renders exactly as if Phase D
      were absent (no raw error leaks — `CLAUDE.md` user-facing-errors
      rule).
- [x] Phase F: `ClaimMismatchInput` accepts a resolved Stage-2 `intent`
      alongside `dappLabel`/`functionName`; a synthetic "Claim" intent
      with non-positive simulated delta still triggers the existing
      mismatch banner (task 27 regression), and now also triggers when
      only the structured `intent` (not the free-text label) indicates
      a claim-shaped call.
- [x] `pnpm check:syntax` and `pnpm biome:check` pass.

## Out of scope

- Live-updating the bundled ERC-7730 registry snapshot on a schedule
  (separate infra task — build-time pin is sufficient here).
- Implementing anything against Solana Foundation Discussion #513 — it
  is not an accepted standard; revisit if/when it becomes a SIMD.
- Second-device QR verification flow (`reproducible-signer-ui.md` §7)
  — gated on the multisig/custody feature landing; this task only
  makes the underlying digest computable and visible per chain.
- Full ERC-7730 v2 cross-chain descriptor format if the bundled
  registry snapshot at implementation time is still v1 — decode
  whatever the pinned snapshot's schema version is.
