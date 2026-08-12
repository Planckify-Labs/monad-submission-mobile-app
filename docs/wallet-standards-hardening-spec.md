# Wallet standards hardening — engineering spec

**Status:** Phases A–K implemented 2026-08-11. See §16 for what shipped,
the four places the spec was wrong, and what was deliberately left out.
NOT device-verified.
**Round 2 (§17): phases L–R implemented 2026-08-12.** They come from
auditing the shipped bridge against `MetaMask/test-dapp`, whose malicious
and malformed suites defeat several controls phases A–K landed. Phase L
is the most severe finding in either round. Phase R is the one addition
that is not a defect fix, and §17.8.2 records why it carries its own
risk. **See §17.14 for what shipped, the two places §17 was wrong, and
what the implementation added beyond it.** NOT device-verified.
**Author:** Claude, from a team research document
(`Production-Grade Multi-Chain Wallet Standard & Feature Coverage.md`)
audited against the shipped codebase. Protocol details for EIP-5792 were
fetched from `eips.ethereum.org/EIPS/eip-5792` directly rather than
recalled — the research doc describes the *withdrawn* 1.0 draft in
places, and this spec follows the finalized text.
**Date:** 2026-08-11
**Companion specs:**
- `docs/dapp-bridge-spec.md` — the `ChainAdapter` + `ApprovalHost` ports
  every phase below docks into unchanged.
- `docs/eip7702-delegator-allowlist-spec.md` — already landed; phase A's
  `atomic: { status: "ready" }` reporting depends on its delegation
  state model.
- `docs/clear-signing-task65.md` context (TWV-2026-066) — phases C and D
  extend the same decode-then-render pipeline.

---

## 0. Goal & non-goals

### Goal
Close the conformance gaps that stop third-party dApps from working
against TakumiPay's bridge, and remove the blind-signing surfaces that
remain across all four namespaces. The target is *ecosystem
compatibility*: a dApp written against the published standards should
work in our in-app browser with zero dApp-side changes, and every action
it asks the user to authorise should be legible on the approval sheet.

### Non-goals
- **Any third-party custody platform.** AWS Nitro / TEE / MPC-TSS from the
  research doc's key-management section is explicitly out of scope.
- **RAM zeroization.** The research doc recommends `buffer.fill(0)` in a
  `finally` block. Under Hermes the mnemonic already crosses through
  immutable JS strings in BIP-39 derivation and in the `expo-secure-store`
  API surface, so zeroizing one `Uint8Array` while several string copies
  remain resident is *false assurance*, not a control. Deliberately skipped.
- **A generic `IChainAdapter<TTransaction, TSimulation, TFeeEstimate>`.**
  The research doc proposes this; it is a regression from the shipped
  `WalletKitAdapter` registry because it reintroduces per-chain generic
  branching in shared code — exactly what `pnpm check:chains` exists to
  prevent. The existing registry stays.
- **First-party NFT product surface.** The app does not show NFTs to users
  and this spec does not add that. Phases C/D/F/G harden the *dApp
  browser* path only, where NFT traffic already arrives whether we render
  it or not.
- **Building NFT or deployment payloads.** The wallet decodes and signs
  what dApps construct. The research doc's `buildKioskPurchasePTB` example
  belongs to a marketplace, not a wallet, and is not implemented.

### Already shipped — no work required
Audited and confirmed present, listed here so the research doc's
checklist is not re-litigated:

| Research doc item | Shipped as |
| :---- | :---- |
| RPC failover + circuit breaker | `services/rpc/MultiProvider.ts`, `solanaRpcPool.ts`, `rateLimiter.ts` |
| EIP-7702 chain scoping + delegate allowlist | `services/chains/evm/eip7702Guard.ts` |
| Solana offline ALT expansion | `services/chains/solana/altResolver.ts` → `SolanaProgramDecoderInspector` |
| Solana `partialSign` preservation | `services/chains/solana/partialSigner.ts` |
| EIP-6963 multi-provider discovery | `services/chains/evm/eip6963.ts` |
| Solana / Sui Wallet Standard registration | `__wallet-standard-lint.ts` + `injectedScript.ts` per namespace |
| Pre-execution balance-delta risk engine | `services/security/txSimulator.ts` → `EvmTransactionSheet` |
| Soroban two-phase simulate → assemble | `services/chains/stellar/sorobanInvoke.ts` |
| Argon2id + AES-GCM at-rest seed encryption | `docs/encrypted-seed-backup-spec.md` |

---

## 1. Phase A — EIP-5792 to the finalized 2.0.0 spec

### 1.1 The defect

`normalizeSendCalls` (`services/chains/evm/EvmAdapter.ts`) pins the
withdrawn draft:

```ts
const version = (raw.version as string) ?? "1.0";
if (version !== "1.0")
  return { error: PROVIDER_ERRORS.invalidParams("version") };
```

viem's `sendCalls`, wagmi's `useSendCalls` and the MetaMask SDK all emit
`version: "2.0.0"`. **Every batched-call request from a current dApp is
rejected outright**, so the feature reads as implemented but is dead in
the field.

### 1.2 Beyond the version string

Four further deviations, in severity order:

1. **`atomicRequired` is never read.** The spec requires the wallet to
   reject the batch when the flag is set and atomicity cannot be
   guaranteed. Today a plain EOA falls through to the sequential path and
   the dApp is told it got a batch. A dApp requesting an atomic
   approve-then-swap can end up with the approve mined and the swap
   reverted, leaving a **live allowance** — this is a safety defect, not
   only a conformance one.
2. **`wallet_getCapabilities` returns the draft key.** Ships
   `atomicBatch: { supported: boolean }`; the spec is
   `atomic: { status: "supported" | "ready" | "unsupported" }`. The
   `ready` value is the one that matters here — a 7702-capable EOA that
   has not yet delegated on the requested chain is precisely "ready", and
   there is no way to express that in the boolean.
3. **`wallet_getCapabilities` ignores its second parameter.** The spec
   passes an optional array of chain ids to filter on; we always answer
   for the active chain only.
4. **Status codes are incomplete.** `wallet_getCallsStatus` emits only
   100/200/500 and labels the response `version: "1.0"` with no `id`.
   The sequential path's partial-failure case is spec code **600**
   ("batch reverted partially"), which we currently report as 500
   ("reverted completely") — actively misleading, because 600 is the
   signal that tells a dApp on-chain state *did* change.

### 1.3 Design

**Version handling — accept both, answer 2.0.0.** `normalizeSendCalls`
accepts `"1.0"` and `"2.0.0"` (defaulting to `"2.0.0"` when absent) and
normalizes into a single internal payload. Every *response* is emitted in
2.0.0 shape regardless of what came in. Rationale: a hard cutover buys
cleaner code but breaks any dApp still on the draft, and the response
shape is what dApp client libraries actually parse.

`EvmBatchCallsPayload.version` widens from the literal `"1.0"` to
`"1.0" | "2.0.0"` and records what the dApp sent, for the sheet and for
telemetry.

**Atomicity.** `normalizeSendCalls` reads `atomicRequired: boolean`.
Atomic capability is already computed in `execSendCalls`:

```ts
wallet.type === "Smart4337" ||
  (wallet.type === "Smart7702" &&
    wallet.smart7702?.authorizationByChain?.[payload.chainId] !== undefined)
```

That predicate is lifted into a shared helper so the *request* path can
use it too, and `wallet_sendCalls` fails fast with an
`invalidParams`-class error before an approval sheet is ever raised when
`atomicRequired === true` and the predicate is false. Failing at request
time rather than execution time matters: the user should not be asked to
approve a batch that cannot legally be executed.

**Return shape.** `execSendCalls` returns `{ id: bundleId }` instead of a
bare string. `executeApproval` is typed `Promise<unknown>`, so this is
not a breaking type change.

**Status mapping.** `BundleStatusRecord.status` gains
`"FAILED_PARTIAL"`. The sequential path sets `FAILED_PARTIAL` when at
least one call was confirmed before the failure and `FAILED` when the
first call failed. Mapping at the RPC boundary:

| Record status | Spec code |
| :---- | :---- |
| `PENDING` | 100 |
| `CONFIRMED` | 200 |
| `FAILED` with zero confirmed receipts | 500 |
| `FAILED_PARTIAL` | 600 |

400 ("not included on-chain, wallet will not retry") is reserved for a
batch rejected before broadcast.

**Capabilities.** New shape, honouring the chain filter:

```ts
{ [address]: { [chainIdHex]: {
    atomic: { status: "supported" | "ready" | "unsupported" },
    paymasterService: { supported: boolean },
} } }
```

`ready` is returned for a `Smart7702` wallet with no authorization
recorded for that chain. Chains are the intersection of the requested
filter (when present) and the chains we can actually serve.

### 1.4 Files
- `services/chains/evm/EvmAdapter.ts` — `normalizeSendCalls`,
  `wallet_sendCalls` / `wallet_getCallsStatus` / `wallet_getCapabilities`
  handlers, `execSendCalls`
- `services/chains/evm/payloads.ts` — `EvmBatchCallsPayload`
- `services/bridge/bundleStatus.ts` — `FAILED_PARTIAL`

### 1.5 Acceptance
- `wallet_sendCalls` with `version: "2.0.0"` raises an approval sheet.
- `version: "1.0"` still works and still gets a 2.0.0-shaped response.
- `atomicRequired: true` on a non-smart wallet is rejected **without**
  showing a sheet.
- A sequential batch whose second call reverts reports status 600 with
  the first call's receipt present.
- `wallet_getCapabilities(addr, ["0x…"])` answers only for the requested
  chains and uses the `atomic: { status }` key.

---

## 2. Phase B — contract deployment across namespaces

### 2.0 Current state

Deployment is not one gap but four different ones:

| Chain | Can deploy today | Rendered as |
| :---- | :---- | :---- |
| **EVM** | **No** — hard-rejected | n/a |
| **Sui** | Yes | `Publish: N modules, M dependencies` — no package identity; `Upgrade` never names the `UpgradeCap` it consumes |
| **Stellar** | Yes | **Blind** — a bare `invokeHostFunction` row |
| **Solana** | Technically; not practically | **Blind** — `kind: "unknown"` |

Only EVM is *blocked*. The other three are signable but under-described,
which for deployment is its own hazard: publishing code and upgrading
someone's existing package are among the highest-consequence actions a
wallet can authorise, and two of the three give the user nothing to read.

### 2.1 The EVM defect

`normalizeTx` (`services/chains/evm/EvmAdapter.ts`) rejects any
transaction without a recipient:

```ts
const to = raw.to as `0x${string}` | undefined;
if (!to || !isAddress(to))
  return { error: PROVIDER_ERRORS.invalidParams("to") };
```

A contract-creation transaction is defined by having **no** `to`. Remix,
Hardhat, Foundry's browser flows and thirdweb deploys therefore all fail
with `invalid params: to`. `EvmTxCommon.to` is also a non-optional
`` `0x${string}` `` in `payloads.ts`, so the constraint is enforced at
type level all the way to the approval sheet.

### 2.2 Design

`to` becomes optional across `EvmTxCommon` and the batch-call entries.
`normalizeTx` accepts a missing/null `to` **only when `data` is
non-empty** — a transaction with neither recipient nor calldata is
malformed and keeps returning `invalidParams`, which also prevents a
missing-`to` bug in a dApp from silently becoming a value-burning
deployment.

The approval sheet must not render a deployment as a transfer to a blank
address. `EvmTransactionSheet` gains a distinct deployment presentation:
the "To" row is replaced with a **Contract deployment** row, the
init-code size is shown, and — because a deployment's calldata is
constructor init-code, not a function call — the calldata decoder is
skipped rather than being allowed to mis-hit a selector. Copy is
hand-written per the user-facing-errors rule; no raw payload text is
surfaced.

`services/security/txSimulator.ts` returns `coverage: "partial"` with an
empty delta list for deployments (a deployment moves no assets beyond
gas), which is already its default branch — verify, do not special-case.

### 2.3 Stellar — label the deploy host functions

`decodeInvokeHostFunction` (`services/chains/stellar/xdrDecode.ts`) bails
on anything that is not a contract invocation:

```ts
if (func.switch().name !== "hostFunctionTypeInvokeContract") {
  return { kind: "invokeHostFunction" };
}
```

That silently swallows the two deployment host functions. Add explicit
branches:

- `hostFunctionTypeUploadContractWasm` → surface the WASM byte length and
  its SHA-256 hash (the hash *is* the on-chain identity of the code, and
  is the only value a user could meaningfully verify against a
  publisher's release notes).
- `hostFunctionTypeCreateContract` / `…V2` → surface the referenced WASM
  hash, the deployment salt, and the resulting contract id where it is
  derivable offline.

### 2.4 Sui — deepen Publish and Upgrade

`Publish` and `Upgrade` already decode structurally. Two additions:

- `Publish` — surface the module **names** rather than only a count, and
  the dependency package ids.
- `Upgrade` — surface the package being upgraded and, critically, the
  `UpgradeCap` object being consumed. Consuming an `UpgradeCap` is an
  irreversible authority action; a count of modules does not convey it.

### 2.5 Solana — decode the loader, do not pretend to support deploys

Register a `BPFLoaderUpgradeab1e11111111111111111111111` decoder in
`services/chains/solana/programDecoders.extras.ts` covering `Write`,
`DeployWithMaxDataLen`, `Upgrade`, `SetAuthority` and `Close`. `Upgrade`
and `SetAuthority` are the security-relevant ones — they replace live
program code and move upgrade authority.

Full deploy-from-browser is **not** a goal: Loader-v3 chunks the binary
across hundreds of `Write` transactions, which is not a sane approval
flow and no dApp drives it that way. The value here is that when one of
these instructions *does* appear, it is named rather than blind-signed.

### 2.6 Files
- `services/chains/evm/EvmAdapter.ts` — `normalizeTx`
- `services/chains/evm/payloads.ts` — `EvmTxCommon.to`, batch call entries
- `components/dapps-browser/approvals/EvmTransactionSheet.tsx`
- `services/bridge/inspectors/EvmCalldataDecoderInspector.ts` — skip
  decode when `to` is absent
- `services/chains/stellar/xdrDecode.ts` + `payloads.ts`
- `services/bridge/inspectors/SuiPtbDecoderInspector.ts` + `sui/payloads.ts`
- `services/chains/solana/programDecoders.extras.ts`

### 2.7 Acceptance
- EVM: a no-`to` transaction with init-code raises a sheet labelled as a
  contract deployment; with no `data` it is still rejected; transfers and
  contract calls are unchanged.
- Stellar: a WASM upload shows byte length + hash; a create-contract
  shows the WASM hash it instantiates.
- Sui: a publish lists module names; an upgrade names the `UpgradeCap`.
- Solana: a loader `Upgrade` / `SetAuthority` renders named, not `unknown`.

---

## 3. NFT coverage across namespaces (phases C, D, F, G)

The app has no first-party NFT product surface and this spec does not add
one. But NFT traffic reaches the bridge regardless, and it carries the
highest-value phishing patterns in the ecosystem. Current state:

| Surface | Chain | State |
| :---- | :---- | :---- |
| ERC-721 / 1155 transfers | EVM | ✅ selectors decoded |
| `setApprovalForAll` | EVM | ✅ decoded **and** risk-flagged; revoke screen exists (`app/approvals.tsx`) |
| `approve` on an NFT | EVM | ❌ collides with ERC-20 → **phase D** |
| Marketplace order signing | EVM | ❌ only ERC-2612 / Permit2 decoded; no Seaport, and `knownSpenders.ts` names no marketplace, so approving OpenSea's conduit looks like approving a drainer → **phase F** |
| NFT delegation (delegate.xyz) | EVM | ❌ undecoded and unflagged; grants standing rights without looking like an approval → **phase F** |
| EIP-712 signing domain | EVM | ❌ **no domain display, no chainId check, no refusal** → **phase H**, which phase F depends on |
| Kiosk purchase / listing | Sui | ❌ undecoded → **phase C** |
| Metaplex asset operations | Solana | ❌ name-only → **phase G** |
| SEP-41 token calls | Stellar | ⚠️ decode generically as contract fn + args. Thin, but not *wrong* — a `transfer` on an NFT contract does render as a transfer call. No phase; revisit if Soroban NFT traffic materialises. |

The ordering insight: **phase F outranks phase C**. Kiosk decoding fixes
blind signing on a purchase the user initiated and expects to pay for.
Order-signature decoding fixes blind signing on an *off-chain signature*
that moves assets with no transaction to inspect — the pattern behind
most NFT drains. Volume on EVM marketplaces also dwarfs Sui kiosk volume.

---

## 4. Phase C — Sui Kiosk / TransferPolicy decoding

### 4.1 The defect

`SuiPtbDecoderInspector` decodes PTB command *structure* (`MoveCall`,
`SplitCoins`, `TransferObjects`, `Publish`, …) but has no semantic layer
for the Kiosk standard. Its fallback annotation is:

```ts
if (c.kind === "MoveCall" && c.package !== SUI_FRAMEWORK_PACKAGE) {
  … title: `MoveCall to package ${c.package}`
```

A `0x2::kiosk::purchase` is *in* the framework package, so an NFT
purchase renders with no item, no price and no royalty rule. Buying an
NFT on Sui through the dApp browser is blind signing.

### 4.2 Design — what the Hot Potato actually buys us

`0x2::kiosk::purchase` returns a `TransferRequest`, a struct with neither
`drop` nor `store`. It **must** be consumed by
`transfer_policy::confirm_request` before the PTB ends or the whole block
aborts. That is a decoding gift: within a single PTB the full economic
picture is statically present, because it has to be. The decoder does not
need to simulate — it reads the command list.

A `kiosk` semantic pass runs after structural decode and recognises:

| Target | Surfaced |
| :---- | :---- |
| `0x2::kiosk::purchase` | item type, item id, price (from the linked `SplitCoins`) |
| `0x2::kiosk::list` / `place_and_list` | item + ask price |
| `0x2::kiosk::take` / `delist` | item leaving the kiosk |
| `0x2::transfer_policy::confirm_request` | which policy gates the trade |
| any `*::*_rule::pay` between purchase and confirm | a **rule payment** — royalty or fee |

Price attribution uses PTB result forwarding: the `paymentCoin` argument
to `purchase` is a `Result` reference back to a `SplitCoins` command
whose amount is a `pure` u64, so the amount is resolvable offline. When
the amount is not a literal (forwarded from another command) the decoder
reports the item and rules but marks the price **unresolved** rather than
guessing.

Rule payments are summed and surfaced as a separate line so the user sees
total cost, not just the listing price. A purchase whose `TransferRequest`
is never confirmed in the same PTB is annotated as a warning — it cannot
succeed on-chain, and a PTB shaped that way is a signal worth showing.

Sui Kiosk decoding is **display only**. This phase does not build kiosk
PTBs; the dApp builds them and we sign. The research doc's
`buildKioskPurchasePTB` example is therefore not implemented — it belongs
to a marketplace, not a wallet.

### 4.3 Files
- `services/bridge/inspectors/SuiPtbDecoderInspector.ts`
- `services/chains/sui/payloads.ts` — decoded-kiosk annotation type
- the Sui approval sheet under `components/dapps-browser/approvals/`

### 4.4 Acceptance
- A kiosk purchase PTB shows item type, price, and each rule payment.
- A purchase with a royalty rule shows the royalty separately from price.
- A purchase with no matching `confirm_request` is flagged.
- Non-kiosk PTBs decode exactly as before (no regression in existing tests).

---

## 5. Phase D — ERC-721 `approve` disambiguation

### 5.1 The defect

`services/decoders/calldata.ts` maps selector `0x095ea7b3` to a single
signature:

```ts
"0x095ea7b3": ["function approve(address spender, uint256 amount)"],
```

ERC-721's `approve(address to, uint256 tokenId)` has the identical
selector *and* identical ABI encoding, so the file's roundtrip gate —
which trusts a candidate only when re-encoding reproduces the calldata
byte-for-byte — **cannot** disambiguate them. Two consequences:

1. An NFT approval renders as "approve \<tokenId\> tokens", which is
   simply wrong copy.
2. `classifyRisk` computes `isUnlimited` from the second argument. For an
   NFT that argument is a token id, so a token id at or above
   `type(uint256).max / 2` **false-flags as an unlimited allowance**, and
   an NFT approval is scored on a scale that does not apply to it.

### 5.2 Design

Disambiguation cannot come from the calldata; it has to come from the
contract. Resolution order, first hit wins:

1. **Token registry.** If the target address is already known to
   `services/tokens/` as an ERC-20, it is an ERC-20 `approve`. Free, no
   network call, covers the overwhelming majority of traffic.
2. **ERC-165.** `supportsInterface(0x80ac58cd)` (ERC-721) via `eth_call`,
   behind the same bounded timeout pattern `eth_sendTransaction` already
   uses for gas estimation (`raceTimeout`, `GAS_ESTIMATE_TIMEOUT_MS`). An
   RPC that is slow or rate-limited must degrade, never stall the sheet.
3. **Unknown.** Neither resolved → render the approval as
   **indeterminate**: show spender and the raw second argument without
   claiming it is either an amount or a token id, and do not compute
   `isUnlimited`.

`DecodedCalldata["risk"]` gains an `approveNft` variant carrying
`{ operator, tokenId }`, and the existing `approve` variant is only
emitted once the target is confirmed ERC-20. The unlimited-allowance
threshold logic is untouched — it just stops being applied to things that
are not allowances.

Note the sharp edge: step 3's "unknown" case must not silently fall back
to the ERC-20 reading. Defaulting to ERC-20 is what produces the wrong
copy today, and defaulting to ERC-721 would suppress a genuine unlimited
approval warning. Indeterminate is the only safe default.

### 5.3 Files
- `services/decoders/calldata.ts` — signature candidates, `classifyRisk`
- `services/chains/evm/` — an ERC-165 probe helper
- `services/bridge/inspectors/EvmCalldataDecoderInspector.ts` — pass the
  probe result into the decode
- `components/dapps-browser/approvals/EvmTransactionSheet.tsx` — the
  three render cases

### 5.4 Acceptance
- `approve` on a known ERC-20 is unchanged, including unlimited detection.
- `approve` on an ERC-721 renders as a single-token approval and never
  reports "unlimited".
- A token id ≥ `2^255` on an ERC-721 does not trigger the unlimited path.
- An unreachable RPC yields the indeterminate render within the timeout.

---

## 6. Phase E — Soroban `restorePreamble`

### 6.1 The defect

`restorePreamble` appears **nowhere** in the repository.
`SimulateResult` (`services/chains/stellar/sorobanRpcClient.ts`) models
only `transactionData` and `minResourceFee`.

Soroban ledger entries have a TTL. Once archived, an invocation touching
them fails at consensus. `simulateTransaction` reports this by returning
a `restorePreamble` — `{ transactionData, minResourceFee }` describing a
`RestoreFootprint` operation that must run *first*. Because we neither
parse nor act on it, a dApp call against archived state fails with an
opaque error and no recovery path, and the user is given no way forward.

### 6.2 Design

`SimulateResult` gains an optional `restorePreamble`. When present,
`invokeSorobanContract` submits a `RestoreFootprint` transaction built
from the preamble's `transactionData` and `minResourceFee`, waits for it
to confirm, then re-simulates the original invocation — re-simulation is
required because the footprint and resource fee are computed against
pre-restore ledger state.

Two constraints:

- **A restore is a separate, separately-priced transaction.** It cannot
  be injected silently. The user approves the restore explicitly, with
  hand-written copy explaining that on-chain storage for this contract
  expired and must be renewed before the action can proceed, and with its
  own fee shown. Per `docs/clipboard-policy.md`-adjacent conventions and
  the user-facing-errors rule, no XDR or RPC text reaches the UI.
- **One restore attempt per invocation.** If re-simulation still reports
  a preamble, fail with a curated error rather than looping.

### 6.3 Files
- `services/chains/stellar/sorobanRpcClient.ts` — `SimulateResult`
- `services/chains/stellar/sorobanInvoke.ts` — restore-then-retry flow
- `services/chains/stellar/errorCodes.ts` — an archived-state code
- the Stellar approval sheet — restore approval step

### 6.4 Acceptance
- A simulation returning a preamble triggers a restore approval.
- Declining the restore aborts cleanly with friendly copy.
- Accepting restores, re-simulates and proceeds to the original approval.
- A second consecutive preamble fails with a curated error, no loop.
- Invocations with no preamble are byte-for-byte unchanged.

---

## 7. Phase F — EVM marketplace order signing

### 7.1 The defect

`services/decoders/permit2.ts` decodes Permit2 typed data and gates
strictly on `domain.name === "Permit2"`. Nothing decodes marketplace
orders. A Seaport `OrderComponents` — the structure behind OpenSea,
and structurally mirrored by most EVM NFT marketplaces — renders as an
undifferentiated typed-data blob.

This is the most consequential NFT surface in the spec. An order
signature is not a transaction: there is no calldata to decode, no
simulation to run, and nothing appears on-chain until the counterparty
submits it. The user's signature *is* the authorisation to move the
asset. A malicious order signed today can be executed days later.

### 7.2 Design

A `tryDecodeSeaportOrder` decoder alongside `permit2.ts`, matched on
`domain.name === "Seaport"` plus a recognised `primaryType`
(`OrderComponents`, `BulkOrder`). It extracts and surfaces:

- **`offer`** — what leaves the user. Each item's token, id and amount.
- **`consideration`** — what returns, and **to whom**. The recipient
  addresses are the tell: a legitimate sale sends the bulk of
  consideration back to the signer.
- **`zone` / `conduitKey`** — who is permitted to execute the order.
- **`startTime` / `endTime`** — how long the authorisation lives.

Two risk annotations, both hand-written copy per the user-facing-errors
rule:

1. **Consideration does not return to the signer** — the offer leaves and
   nothing meaningful comes back. This is the shape of a drain order.
2. **Zero or near-zero consideration** for a non-empty offer.

`BulkOrder` (a Merkle tree of orders behind one signature) is decoded to
the extent of reporting **how many orders** the signature covers; a bulk
signature covering an unbounded set is itself worth surfacing even when
the leaves are not all present in the payload.

Where a marketplace is not recognised, the existing generic typed-data
render stands — this phase adds a decoder, it does not add a blocklist.

### 7.3 The rest of the marketplace surface

Seaport is the largest single template but not the only gap. In priority
order, cheapest first:

**a. `knownSpenders.ts` has no marketplace addresses.** It currently
lists Uniswap Universal Router, Permit2, 1inch v6 and CoW VaultRelayer.
Nothing else. So `setApprovalForAll` to OpenSea's Seaport conduit renders
as a bare hex address — **visually identical to approving a drainer**.
This is a data-table entry with no new decoder and is the highest
value-per-line change in this spec. Add Seaport 1.5/1.6, the
`ConduitController` and its canonical conduit, Blur's execution delegate,
and the LooksRare v2 transfer manager.

**b. delegate.xyz** (`delegateForAll`, `delegateForContract`,
`delegateForERC721`) — **calldata**, not typed data, so it belongs in
`calldata.ts` rather than a typed-data decoder. It grants another address
standing rights over the signer's NFTs. It is heavily used legitimately
(cold vault delegating to a hot wallet for claims and airdrops), which is
exactly why it is abused, and critically **it does not look like an
approval** — no `approve`, no `setApprovalForAll` — so nothing in the
current `classifyRisk` catches it. It should be risk-flagged at the same
weight as `setApprovalForAll`.

**c. ERC-4494** — `permit` for ERC-721, the NFT analogue of the ERC-2612
decoder that already ships. Same `services/decoders/` shape as
`erc2612.ts`; discriminate on the presence of `tokenId` rather than
`value` in the `Permit` struct.

**d. Blur and LooksRare v2 `MakerOrder`** — non-Seaport order formats.
Lower volume than Seaport, same structural risk. Do these last, and only
after phase H makes the domain trustworthy.

### 7.4 Files
- `services/decoders/seaport.ts` (new, mirroring `permit2.ts`)
- `services/decoders/erc4494.ts` (new, mirroring `erc2612.ts`)
- `services/decoders/knownSpenders.ts` — marketplace + conduit addresses
- `services/decoders/calldata.ts` — delegate.xyz selectors + `classifyRisk`
- `services/decoders/clearSigning.ts` — probe the new typed-data decoders
- the typed-data approval sheet

### 7.5 Acceptance
- A Seaport listing shows offer, consideration and expiry.
- An order whose consideration recipient is not the signer is flagged.
- A `BulkOrder` reports the number of orders covered.
- `setApprovalForAll` to the Seaport conduit renders the conduit's name.
- `delegateForAll` is risk-flagged at `setApprovalForAll` weight.
- Permit2, ERC-2612 and unrecognised typed data are unchanged.

---

## 8. Phase G — Solana Metaplex instruction decoding

### 8.1 The defect

`services/chains/solana/programDecoders.extras.ts` registers
mpl-token-metadata, mpl-core and mpl-bubblegum as **presence rows only**:

```ts
// Metaplex instruction decoding needs Borsh + per-program IDLs;
// during P1c we expose instruction-presence rows and leave per-ix
// detail to the next pass.
return { program: pid, kind: `${name}:ix`, programName: name };
```

The sheet renders "MPL: mpl-core". Transfer, burn, approve-delegate and
plugin-update are therefore **indistinguishable from one another**. This
is the next pass that comment defers to.

### 8.2 Design

Discriminate on the leading instruction-discriminator byte(s) and decode
arguments for the security-relevant instructions only. Full IDL coverage
is not the goal; naming the dangerous operations is.

| Program | Instructions to decode |
| :---- | :---- |
| mpl-core | `Transfer`, `Burn`, `AddPlugin`, `UpdatePlugin`, `ApprovePluginAuthority` |
| mpl-token-metadata | `Transfer`, `Burn`, `Delegate`, `Revoke`, `Update` |
| mpl-bubblegum | `Transfer`, `Burn`, `Delegate` |

The plugin instructions on Core matter most: Core enforces royalties and
freeze/transfer delegation through its plugin system, so
`ApprovePluginAuthority` is Solana's structural equivalent of
`setApprovalForAll` — it hands a third party standing authority over the
asset. It should carry the same risk weight the EVM path already gives
`setApprovalForAll`.

Anything not in the table keeps the current presence row. That is a
deliberate floor: an unrecognised Metaplex instruction must not silently
render as a benign one.

`spl-token` `Approve` against an NFT mint (decimals 0, supply 1) is
already decoded by the existing SPL decoder; verify it is risk-flagged
rather than shown as a plain token approval.

### 8.3 Files
- `services/chains/solana/programDecoders.extras.ts`
- `services/chains/solana/payloads.ts` — decoded-instruction variants
- the Solana approval sheet

### 8.4 Acceptance
- An mpl-core transfer renders as a transfer with the asset id.
- `ApprovePluginAuthority` is risk-flagged like `setApprovalForAll`.
- An unrecognised Metaplex instruction still renders as a presence row.

---

## 9. Phase H — EIP-712 signing-domain hardening (TWV-2026-012)

### 9.1 The defect

`docs/design-notes/eip712-domain-display.md` specifies a required UI
contract for typed-data signing. It was written 2026-04-16, still reads
`**Status:** Audit + design contract`, and **none of its eight
requirements shipped**. Re-audited for this spec:

| Requirement | Status |
| :---- | :---- |
| `domain.name` above the fold | Missing |
| `domain.version` above the fold | Missing |
| `domain.chainId` above the fold | Missing |
| `domain.verifyingContract` above the fold | Missing |
| chainId-mismatch **detection** | Missing |
| chainId-mismatch **refusal** (not merely warn) | Missing |
| Known-contract name lookup for `verifyingContract` | Missing |
| Regression tests | Missing |

The only domain checks in the codebase (`HeuristicInspector.ts:62`,
`:112`) are for **SIWE** — a plaintext message format — and for
`wallet_addEthereumChain`. Neither touches `EIP712Domain`.

### 9.2 Why this outranks every decoder

A typed-data signature is only as trustworthy as its domain. The domain
binds a signature to a specific `chainId` and `verifyingContract`; if the
wallet does not check that binding, a beautifully decoded Seaport order
can still be signed against the wrong chain or a look-alike contract
deployment and replayed there.

Phase F therefore **depends** on this one. Shipping a marketplace decoder
first would render an order in perfect detail and still sign it for the
wrong deployment — arguably worse than the status quo, because the rich
render implies a verification that did not happen.

### 9.3 Design

Implement the design note's §2 contract as written; it is already
specified and does not need redesign here. Three points worth restating
because they are where an implementation is likely to soften:

- **Refusal, not a warning.** A `domain.chainId` that does not match the
  registry-resolved active chain must block signing outright. The
  existing "hold to sign" warning affordance is not sufficient — a
  chainId mismatch has no legitimate reading.
- **`verifyingContract` name lookup reuses `knownSpenders.ts`**, which
  phase F is extending anyway. An unknown contract renders as an address
  with no name, never as a guess.
- **Domain block renders above the decoded card**, including for
  ERC-2612 and Permit2, which today show spender/token/amount with the
  domain buried in the raw JSON fallback below the fold.

Copy is hand-written per the user-facing-errors rule; no raw domain JSON
reaches the refusal message.

### 9.4 Files
- `components/dapps-browser/approvals/EvmSignMessageSheet.tsx`
- `services/bridge/inspectors/HeuristicInspector.ts` — mismatch detection
- `services/decoders/knownSpenders.ts` — `verifyingContract` lookup
- `docs/design-notes/eip712-domain-display.md` — flip Status when done

### 9.5 Acceptance
- All four domain fields render above the fold on every typed-data sheet.
- A `chainId` mismatch **blocks** signing; the sheet cannot be confirmed.
- A known `verifyingContract` renders its name; an unknown one does not.
- Regression tests cover the mismatch path.
- ERC-2612 and Permit2 sheets gain the domain block without losing their
  existing decoded fields.

---

## 10. Phase I — Stellar `signAuthEntry` is a dead capability

### 10.1 The defect

`StellarAdapter.ts:230` handles `SUBMIT_AUTH_ENTRY`. The approval path,
the signer and the error mapping are all built.

`services/chains/stellar/injectedScript.ts` exposes exactly nine methods
on `window.freighterApi`: `isConnected`, `getAddress`, `requestAccess`,
`getNetwork`, `getNetworkDetails`, `signTransaction`, `signMessage`,
`isAllowed`, `setAllowed`. **`signAuthEntry` is not among them** — zero
occurrences in the entire file.

So the wallet implements auth-entry signing and no dApp can reach it. The
capability is complete on the inside and invisible from the outside.

### 10.2 Why it matters

SEP-43 defines `signAuthEntry` as part of the standard wallet interface,
and Soroban needs it structurally. `sorobanAuthorizedInvocation` entries
are how a contract call proves authorisation for sub-invocations —
contract-to-contract calls, multi-party authorisation, and any invocation
where the signer is not the transaction source. A Soroban dApp that needs
one gets `undefined is not a function` and cannot proceed.

This is the cheapest fix in the spec relative to what it unblocks: the
expensive half already exists.

### 10.3 Design

Add `signAuthEntry(entryXdr, opts)` to the injected API, dispatching
`SUBMIT_AUTH_ENTRY` through the same `bridgeRequest` transport every
other method uses, with a `pickSignAuthEntry` response mapper returning
`{ signedAuthEntry, signerAddress }` to match Freighter's shape.

Verify the adapter's existing handler against the current SEP-43 text
before wiring — it was written when nothing called it, so its response
shape has never been exercised against a real dApp. Fetch the SEP text
directly rather than working from the handler's assumptions.

### 10.4 Files
- `services/chains/stellar/injectedScript.ts`
- `services/chains/stellar/StellarAdapter.ts` — verify the handler
- the Stellar approval sheet — confirm an auth-entry render exists

### 10.5 Acceptance
- `window.freighterApi.signAuthEntry` is callable from a dApp.
- It raises an approval sheet that describes the invocation being
  authorised, not raw XDR.
- Declining returns the standard user-rejected error.

---

## 11. Phase J — Solana priority fees on first-party sends

### 11.1 The defect

`services/chains/solana/agentContext.ts:211-222` **decodes**
`setComputeUnitLimit` / `setComputeUnitPrice` out of dApp-built
transactions, so the approval sheet can show what a dApp chose.

Our own send path never **sets** them. `transferService.ts`,
`splTransferService.ts` and `broadcast.ts` contain no `ComputeBudget`
reference, and `getRecentPrioritizationFees` appears nowhere in the
repository.

Every first-party Solana send therefore goes out at default compute
pricing with no priority fee. Under congestion those transactions are
deprioritised and can fail to land, which surfaces to the user as a send
that silently does nothing.

### 11.2 Design

Prepend two `ComputeBudgetProgram` instructions in the shared Solana send
path:

- `setComputeUnitLimit` — from the simulated unit consumption
  (`services/chains/solana/simulate.ts` already runs a simulation) plus a
  margin, rather than the 200k default. A tight limit is also cheaper.
- `setComputeUnitPrice` — micro-lamports per unit, from
  `getRecentPrioritizationFees`.

The research doc's point about scoping is correct and worth implementing:
`getRecentPrioritizationFees` accepts the writable accounts a transaction
locks, so the fee should be derived from contention on *those* accounts,
not from a global network figure. A transfer touching an uncontended
account should not pay a hot account's premium.

Bound it: a hard ceiling on the priority fee, and a degrade-to-default
path when the RPC is slow or unavailable, using the same `raceTimeout`
pattern the EVM gas estimate already uses. A fee oracle that hangs must
not block a send.

This is a **first-party** change. dApp-built transactions keep whatever
compute budget the dApp set; we decode and display it, we do not rewrite
it.

### 11.3 Files
- `services/chains/solana/transferService.ts`, `splTransferService.ts`
- `services/chains/solana/broadcast.ts`
- a new priority-fee helper alongside `simulate.ts`

### 11.4 Acceptance
- A first-party send carries both compute-budget instructions.
- The unit limit tracks simulation, not a hardcoded default.
- An unavailable fee RPC degrades to a default within the timeout.
- dApp-built transactions are not modified.

---

## 12. Phase K — Stellar fee-bump transactions

### 12.1 The defect

`services/chains/stellar/signer.ts:89` states the constraint outright:
the signer handles `Transaction`, **never** `FeeBumpTransaction`.

Two consequences. We cannot sponsor a user's fees the way the network
natively supports, and a dApp that hands us a fee-bump envelope to sign
is refused.

### 12.2 Design

Fee-bump is Stellar's sponsorship primitive: the user signs an inner
envelope describing intent, a sponsor wraps it in an outer envelope,
signs as fee source, and submits. Scope this phase to the **signing**
half — accept and correctly render a `FeeBumpTransaction` envelope,
distinguishing inner-transaction intent from outer fee-source
responsibility on the sheet so the user understands they are not paying.

Building fee-bump envelopes as a sponsor is a first-party product
decision, not a wallet-standard conformance gap, and is out of scope
here.

The sheet must make the distinction legible: a fee-bump envelope has two
source accounts, and showing only one is how a user misreads who pays.

### 12.3 Files
- `services/chains/stellar/signer.ts`
- `services/chains/stellar/xdrDecode.ts` — fee-bump envelope branch
- the Stellar approval sheet

### 12.4 Acceptance
- A fee-bump envelope is accepted and signed.
- The sheet shows inner source, outer fee source, and who pays.
- Plain `Transaction` envelopes are unchanged.

---

## 13. Sequencing

A and B(EVM) are both EVM request-path changes touching `normalizeTx` /
`normalizeSendCalls` and the same sheet; do them together to avoid
conflicting edits. **H blocks F** (§9.2). The rest are independent.

| Phase | Priority | Rationale |
| :---- | :---- | :---- |
| A — EIP-5792 2.0.0 | P0 | Batching is dead in the field today; `atomicRequired` is a safety defect |
| B — contract deployment | P0 | EVM deploy tooling cannot be used at all; Stellar/Solana deploys are blind-signed |
| H — EIP-712 domain | P0 | Eight required controls, none shipped; every typed-data decoder rests on it |
| I — Stellar `signAuthEntry` | P0 | Best effort-to-value ratio in the spec: the handler exists, only the injected method is missing, and without it Soroban dApps cannot proceed at all |
| F — marketplace orders | P1 | Highest-value NFT drain vector, and an off-chain signature has no other safety net. **Blocked by H** |
| D — ERC-721 approve | P1 | Wrong security copy on a live phishing surface |
| J — Solana priority fees | P1 | First-party sends can silently fail to land under congestion |
| C — Sui Kiosk | P2 | Blind signing, but on a purchase the user initiated |
| G — Metaplex decoding | P2 | Blind signing across all Solana NFT operations |
| E — Soroban restore | P2 | Opaque failure; no asset loss |
| K — Stellar fee-bump | P2 | Refuses a valid envelope shape; no asset loss |

Phase F's item (a) — marketplace addresses in `knownSpenders.ts` — is the
exception to the blocking rule. It is a data-table change, it makes
`setApprovalForAll` legible immediately, and it is a prerequisite for H's
`verifyingContract` lookup. Land it with H rather than with the rest of F.

## 14. Verification

Unit tests alongside the existing suites (`EvmAdapter.test.ts`,
`calldata.test.ts`, `permit2.test.ts` as the model for `seaport.test.ts`,
`SuiPtbDecoderInspector`'s neighbours, `StellarAdapter.test.ts`). New
vitest files must be added to `vitest.config.ts`'s explicit `include`
list; new `node:test` files must fit the `_test-resolver.mjs` harness.
Cap worker parallelism when running locally — the full suite is known to
freeze this machine.

On-device verification uses the public dApp list in the handover notes;
every phase here has a live dApp that exercises it.

---

## 15. Appendix — full research-document coverage

Every section of `Production-Grade Multi-Chain Wallet Standard & Feature
Coverage.md`, mapped to a phase or to evidence that it already ships.
Nothing in the source document is unaccounted for.

### 15.1 Discovery protocols (doc §1)

| Item | Verdict |
| :---- | :---- |
| EVM EIP-6963 announce/request | ✅ `services/chains/evm/eip6963.ts` |
| EVM EIP-5792 capability negotiation | ❌ **phase A** |
| Solana Wallet Standard registration + features | ✅ complete: `standard:connect/disconnect/events` + `solana:signIn`, `signMessage`, `signTransaction`, `signAndSendTransaction`, with `supportedTransactionVersions`. **Exceeds the doc**, which omits `solana:signIn` (SIWS) entirely |
| Sui Wallet Standard registration + features | ✅ complete: modern `sui:signTransaction` / `signAndExecuteTransaction` (v2.0.0) **and** legacy `*Block` aliases (v1.0.0) + `signPersonalMessage` + `reportTransactionEffects`. **Exceeds the doc**, which lists only the deprecated `*Block` names and omits `reportTransactionEffects` |
| Stellar provider methods | ⚠️ 9 of 10 present; `signAuthEntry` missing → **phase I** |
| Sui key schemes (Ed25519 / Secp256k1 / Secp256r1) | ⚠️ Ed25519 only. `sui/codec.ts:69` rejects other schemes deliberately. Not a conformance gap for a wallet that derives its own keys; it would only bite on **importing** a Secp256k1/r1 Sui key. Logged, not scheduled |

### 15.2 Execution paradigms (doc §2)

| Item | Verdict |
| :---- | :---- |
| EIP-5792 batching | ❌ **phase A** |
| EIP-7702 set-code + delegate allowlist | ✅ `eip7702Guard.ts` |
| ERC-4337 bundler / paymaster | ✅ `evm/bundler.ts`, `evm/paymaster.ts` |
| Solana v0 versioned transactions | ✅ + `txVersionGuard.ts` catches a v0 wire declared as legacy, which the doc does not mention |
| Solana ALT offline expansion | ✅ `altResolver.ts` |
| Solana `partialSign` preservation | ✅ `partialSigner.ts` |
| Solana preflight simulation | ✅ `simulate.ts`, `broadcast.ts` |
| Sui PTB decoding | ✅ structural; kiosk semantics ❌ **phase C** |
| Sui 1024-command limit | ⏭️ not guarded client-side. The network rejects an over-long PTB anyway, so a local guard buys only a faster error. Logged, not scheduled |
| Stellar two-phase simulate → assemble | ✅ `sorobanInvoke.ts` |
| Stellar archived-state restore | ❌ **phase E** |

### 15.3 Digital asset management (doc §3)

Covered by **phases C, D, F, G** and the §3 matrix. Stellar SEP-41 is the
one row with no phase: Soroban token calls already decode generically as
contract function + args, which is thin but not wrong. Revisit if Soroban
NFT traffic materialises.

### 15.4 Deployment lifecycle (doc §4)

Covered by **phase B** across all four namespaces (§2.0 table).

### 15.5 Gas engineering (doc §5)

| Item | Verdict |
| :---- | :---- |
| EVM EIP-1559 fee params | ✅ `normalizeTx` type 0/1/2 handling |
| EVM paymaster sponsorship | ✅ `evm/paymaster.ts`, surfaced via phase A capabilities |
| Solana compute budget / priority fees | ⚠️ decode-only → **phase J** |
| Sui dual fee accounting | ✅ gas budget/price decoded and rendered |
| Sui sponsored transactions | ✅ detected (`gasOwner !== sender` → `sponsored`, sheet annotation). *Building* sponsored PTBs is a first-party product decision, not a conformance gap |
| Stellar Soroban resource fees | ✅ `minResourceFee` from simulation |
| Stellar fee-bump sponsorship | ❌ **phase K** |

### 15.6 Key management (doc §6)

| Item | Verdict |
| :---- | :---- |
| EVM `m/44'/60'/0'/0/x` | ✅ viem `mnemonicToAccount` default |
| Solana `m/44'/501'/x'/0'` | ✅ `DEFAULT_SOLANA_PATH` |
| Sui `m/44'/784'/x'/0'/0'` | ✅ `DEFAULT_SUI_PATH` |
| Stellar `m/44'/148'/x'` | ✅ `DEFAULT_STELLAR_PATH` (SEP-0005) |
| Argon2id / AES-256-GCM at rest | ✅ `docs/encrypted-seed-backup-spec.md` |
| OS keystore binding | ✅ `expo-secure-store` |
| RAM zeroization | ⏭️ deliberate non-goal (§0) |
| TEE / MPC-TSS | ⏭️ out of scope per the user |

All four derivation paths match the doc's table exactly. No curve or path
isolation defect was found.

### 15.7 Codebase extensions (doc §7, items 1-6)

| Doc item | Verdict |
| :---- | :---- |
| 1. RPC failover + circuit breaker | ✅ shipped |
| 2. EIP-7702 set-code verification | ✅ shipped |
| 3. Solana ALT resolution | ✅ shipped |
| 4. Sui PTB builder + kiosk | ⚠️ builder rejected as a non-goal (§0); kiosk **decoding** is **phase C** |
| 5. Stellar two-phase assembly | ✅ shipped; restore is **phase E** |
| 6. Balance-delta risk engine | ✅ `txSimulator.ts` |
| `IChainAdapter` interface | ⏭️ rejected — a regression from the shipped registry (§0) |

### 15.8 Production hardening checklist (doc §8)

| Doc row | Verdict |
| :---- | :---- |
| Volatile RAM leakage | ⏭️ non-goal (§0) |
| At-rest extraction | ✅ shipped |
| RPC provider downtime | ✅ shipped |
| Unchecked EIP-7702 | ✅ shipped |
| Solana ALT blind signing | ✅ shipped |
| Sui kiosk hot-potato failure | **phase C** (decode, not build) |
| Stellar state archival | **phase E** |
| Malicious approvals | ✅ partly shipped; hardened by **phases D, F, H** |

### 15.9 Found by this audit, absent from the research document

The document did not raise these; they came out of reading the code:

- EVM contract deployment hard-rejected (**phase B**)
- EIP-712 signing-domain controls specified in April 2026 and never built
  (**phase H**)
- Stellar `signAuthEntry` handler built but never exposed (**phase I**)
- ERC-721 `approve` colliding with ERC-20 `approve` (**phase D**)
- `knownSpenders.ts` naming no marketplace, so approving OpenSea's conduit
  is visually identical to approving a drainer (**phase F**)
- delegate.xyz granting NFT rights without looking like an approval
  (**phase F**)

---

## 16. Implementation record — 2026-08-11

All twelve phases landed. Typecheck, `pnpm check:chains`, the full vitest
suite (61 files / 634 tests) and the `node:test` suite are green. **Not
device-verified** — nothing below has been exercised against a live dApp
on a real build.

### 16.1 The extensibility work (space docking)

Four new dock points, so the next wallet standard is a new file plus one
`register` call rather than an edit to shared code:

| Dock | Registers | Replaces |
| :---- | :---- | :---- |
| `services/chains/evm/walletCapabilities.ts` | EIP-5792 capability providers | a literal object inside the RPC handler |
| `services/chains/sui/ptbSemantics.ts` | PTB semantic passes (kiosk, package) | nothing — new layer |
| `services/decoders/typedDataRegistry.ts` | EIP-712 decoders (Seaport, ERC-4494, ERC-2612, Permit2) | the hardcoded probe chain in `clearSigning.ts#bespokeFallback` |
| `services/chains/solana/programDecoders.extras.ts` | already a registry; decoders now also declare `fields` + `risk` | per-program branching in the sheet |

The generic-output rule is what makes these work. A Sui semantic pass
emits `{ code, title, fields[] }`; a Solana decoder emits `fields` and
`risk`; a typed-data decoder emits a `ClearSigningDescriptor` with
`warnings[]`. None of the approval sheets know a standard's name, so
adding one touches no UI.

### 16.2 Where this spec was wrong

Four claims above did not survive contact with the code. Left in place
above rather than edited, so the record shows what was assumed:

1. **Phase I's premise was backwards.** §10.1 says the `SUBMIT_AUTH_ENTRY`
   handler exists and "the expensive half already exists", making it the
   best effort-to-value ratio in the spec. In fact `StellarAdapter.ts`
   held a **fixed decline** (`"Soroban signing is not supported."`) —
   a stub, not an implementation. Phase I therefore required building
   the entire capability: normalization, the auth-entry decoder, the
   approval intent + sheet, the signer, an `ARCHIVED_STATE`-adjacent
   error code, and the injected method. It was one of the larger phases,
   not the smallest.

2. **Sui `Publish` module names are not in the PTB.** §2.4 asks to
   "surface the module names rather than only a count". The PTB carries
   compiled *bytecode*, not names, so this needed a Move binary-format
   reader (`services/chains/sui/moveBytecode.ts`). It ships with strict
   validation and returns `undefined` unless every module parses
   cleanly — a partial list would imply the missing modules don't exist,
   and a mis-parsed name on a publish sheet is worse than no name.

3. **The `UpgradeCap` is not on the `Upgrade` command.** §2.4 implies it
   is. It is consumed by a `0x2::package::authorize_upgrade` call
   earlier in the same PTB, which mints the ticket the upgrade redeems.
   The `package` semantic pass follows that link.

4. **Phase D's "indeterminate" default silently dropped a warning.**
   §5.2 is right that neither ERC-20 nor ERC-721 is a safe default. But
   indeterminate *also* suppresses the unlimited-allowance warning, and
   the unresolved case is exactly the flaky-RPC path where an ERC-20 max
   approve is most likely to slip through. `approveUnknownAsset`
   therefore carries `looksUnlimited`, rendered as conditional copy
   ("if this contract is a token…"). Strictly better than both the
   pre-phase-D behaviour and what §5.2 specified.

### 16.3 Deliberately not shipped

- **Blur and LooksRare v2 in `knownSpenders.ts`** (§7.3 items a/d). Their
  addresses could not be confirmed against a primary source. A wrong
  entry prints a trusted marketplace name next to an address that is not
  that marketplace — the exact attack the table defends against, so the
  gap is safer than the guess. Seaport 1.5/1.6, the ConduitController
  and the OpenSea conduit **are** in, verified against
  `ProjectOpenSea/seaport`'s README and `seaport-js` `constants.ts`.
- **Blur / LooksRare `MakerOrder` decoders** (§7.3 item d) — same reason,
  and the spec already ranked them last.
- **mpl-core plugin *type* and grantee address.** `ApprovePluginAuthorityV1`
  is named and risk-flagged, but the `PluginType` and `PluginAuthority`
  enums were not verified from source, so the decoder does not claim to
  know which plugin or which grantee. Naming the instruction and raising
  the banner is the security-relevant half.
- **EVM contract creation from a smart account.** `execViaBundler` cannot
  express a bare CREATE, so `execSendTransaction` now refuses it
  explicitly rather than submitting a UserOp that does something other
  than what was approved.
- **The "Fresh contract" badge** from `eip712-domain-display.md` §2.3 —
  that section sources it from an indexer at signing time, contradicting
  its own "NEVER fetches at signing time" rule. See that note's §6.

### 16.4 Verification notes

- Discriminators for mpl-core, mpl-token-metadata and mpl-bubblegum were
  read from each program's source, not recalled. Worth stating because
  the first recalled attempt had mpl-core's `Transfer` at ordinal 9; it
  is 14. A wrong ordinal here mislabels a burn as a transfer on a
  signing sheet.
- The two safety-critical assertions in the new tests were
  mutation-checked: inverting `canExecuteAtomically` so `ready` counts
  as atomic, and pinning `approveTargetKind` to `"erc20"`, each fail the
  suite. A guard that has never been seen to fail is not a guard.
- `services/tokens/tokenList.ts` is now stubbed in both test harnesses
  (`_test-resolver-hook.mjs` and a vitest alias to `tokenList.mock.ts`).
  `EvmAdapter` imports `isDefaultToken` from it for phase D, and the
  real module pulls in `expo-sqlite`, whose build output ships JSX.

---

# Round 2 — audit against `MetaMask/test-dapp`

## 17. Phases L–R

**Status: implemented 2026-08-12. See §17.14 for the delta.**

### 17.0 Why this round exists

Phases A–K were written from a research document and an audit of our own
code. That is a blind spot: it can only find gaps we already suspected.
`MetaMask/test-dapp` is the ecosystem's shared conformance harness, and
its `src/components/ppom/` and `src/components/signatures/malformed-*`
suites are an adversarial corpus — payloads specifically shaped to defeat
wallet security controls, contributed as real bypasses were found.

Running our bridge against it produced findings that are *worse* than
round 1's, because several of them **void controls phases A–K just
shipped**. Phase D built five approve/delegate risk banners; phase L
below shows every one of them is skipped when the same bytes arrive via
`wallet_sendCalls`.

All 56 source files under `src/` were read. Findings are ranked by
severity, not by the order they appear in the dapp.

### 17.1 Conformance baseline

`MetaMask/api-specs/openrpc.yaml` is MetaMask's machine-readable method
list and the right baseline — docs prose lags it. It declares **24
methods**. We implement 18, refuse 2 deliberately, and 3 are ERC-7715
(§17.9). `wallet_registerOnboarding` is extension-only and
`wallet_scanQRCode` is MetaMask-proprietary.

Two methods carry an explicit `Deprecated` tag:

```yaml
- name: eth_decrypt          # and eth_getEncryptionPublicKey
  tags: [ $ref: '#/components/tags/Deprecated' ]
  description: This method is deprecated and may be removed in the future.
```

Corroborated by `@metamask/providers` `messages.mjs`, which emits
`ethDecryptDeprecation` at runtime. MetaMask's own deprecation notice
adds that they implement **EIP-1024, which "has since been abandoned"**.
**Not implementing them is the correct posture** and needs no work item.
Same for `eth_sign` (deprecated per MIP-3, absent from the spec, already
hard-rejected at our bridge) and `eth_sendRawTransaction`.

Note the spec declares only `personal_sign` and `eth_signTypedData_v4`
for signing. `eth_signTypedData` v1 and `_v3` are **not in it** — we
already support more of that surface than MetaMask specifies.

---

### 17.2 Phase L — `wallet_sendCalls` bypasses the entire risk engine

**Severity: highest of either round. Do this first.**

#### 17.2.1 The defect

`EvmBatchCallsSheet.tsx` renders each call as the function name and its
**parameter names**:

```tsx
{decoded?.signature && (
  <Text>{decoded.functionName}({decoded.args?.map(a => a.name).join(", ")})</Text>
)}
```

It never reads `decoded.risk`. Grep the file for `risk` and there are no
hits. There is no `RiskBanner`, and `simulateAssetChanges` is not called.

`EvmTransactionSheet.tsx` has the full set — `setApprovalForAll`,
`delegate`, `approveNft`, `approveUnknownAsset`, and `approve` +
`isUnlimited` — plus simulation.

So identical bytes produce opposite outcomes:

| Delivery | `approve(attacker, 2²⁵⁶-1)` on USDC renders as |
| :---- | :---- |
| `eth_sendTransaction` | "High risk — unlimited allowance", spender shown, simulated |
| `wallet_sendCalls`, one call | `approve(spender, amount)` |

This is not an exotic bypass. It requires no malformed encoding and no
trickery — an attacker just calls the batch method. Every control from
phases D and F is optional at the attacker's discretion.

`src/components/ppom/eip5792.js` tests exactly this: it wraps each
malicious payload from `sharedConstants.js` in `wallet_sendCalls` with
`atomicRequired: true`, plus a three-malicious-transaction case. Line 145
does `calls.push(...DEFAULT_CALLS)` — a malicious call **hidden among
benign ones**, which is the harder rendering problem.

#### 17.2.2 Design

`EvmCalldataDecoderInspector` already computes `decodedCalls` per entry
and hands them to the payload. Nothing needs re-decoding; the risk is
already sitting there unread.

1. **Extract the risk-rendering block from `EvmTransactionSheet` into a
   shared component** taking a `DecodedCalldata`. Both sheets render it.
   Extraction, not duplication: two copies of a security banner drift,
   and the copy that drifts is the one nobody is looking at.
2. **Batch verdict = worst call's verdict.** A batch is exactly as
   dangerous as its most dangerous entry. Surface that at the top of the
   sheet, before the per-call list, so a risky call buried at index 7 of
   9 cannot be scrolled past. This is the `DEFAULT_CALLS` case.
3. **Show argument *values*, not just names.** `approve(spender, amount)`
   tells the user nothing. The single-tx sheet already resolves these.
4. **Run simulation over the batch** where the wallet type supports it,
   or state plainly that it was not simulated. Silence currently reads
   as safety.
5. **`atomicRequired: true` does not lower risk.** Atomicity guarantees
   all-or-nothing execution, not that the outcome is benign. Do not let
   the existing "Atomic batch" green pill imply otherwise when a call in
   the batch is flagged.

#### 17.2.3 Files

- `components/dapps-browser/approvals/CalldataRiskSection.tsx` — new,
  extracted from `EvmTransactionSheet.tsx:350-460`
- `components/dapps-browser/approvals/EvmTransactionSheet.tsx` — consume it
- `components/dapps-browser/approvals/EvmBatchCallsSheet.tsx` — consume it,
  add batch-level verdict
- `services/bridge/inspectors/EvmCalldataDecoderInspector.ts` — raise
  annotations for risky entries instead of always `verdict: "allow"`

#### 17.2.4 Acceptance

- A one-call batch of `approve(spender, MAX)` renders the same banner as
  the same call sent via `eth_sendTransaction`. **This is the test that
  matters; write it first.**
- A batch of nine benign calls plus one `setApprovalForAll(op, true)`
  shows a batch-level warning above the list.
- A test asserts the two sheets render risk through the same component,
  so the next risk kind cannot land in one and miss the other.

---

### 17.3 Phase M — JSON-RPC encoding validation at the boundary

#### 17.3.1 The defect

`normalizeTx` (`EvmAdapter.ts:1850`) takes `raw.data` as a **cast, not a
check**: `const data = (raw.data ?? raw.input) as Hex | undefined`. No
`isHex`, no length rule. Three consequences, all in the test dapp.

**(a) Odd-length calldata erases the approve warning.** Verified against
our own decoder:

```
0x095ea7b3…  (136 hex digits) → "approve(address,uint256)"  risk: approveUnknownAsset
0x95ea7b30…  (135 hex digits) → signature: null             risk: undefined
```

Same allowance, same attacker. Strip one leading zero and
`decodeCalldata` slices `0x95ea7b30`, misses `SELECTOR_DB`, and renders
"contract interaction". This is `maliciousApproveERC20WithOddHexData`,
and the file's own name says what it is: a **bypass**. The scanner sees
garbage; the chain sees an approve.

**(b) Unsupported transaction types are silently coerced.**
`EvmAdapter.ts:1901-1914` accepts `type` 0/1/2 and lets everything else
fall through to `type = 2`. So `0x5` (their invalid-type case), `0x76`
(Tempo, which carries a `feeToken` field we would drop — the user pays
gas in the wrong asset), `0x3` (blob) and `0x4` (EIP-7702, whose
`authorizationList` we would strip) all become a plain type-2 that we
sign. **We execute different semantics than the dApp requested.**

**(c) QUANTITY without `0x`.** `safeBigint` has a dead branch
(`if (v.startsWith("0x")) return BigInt(v); return BigInt(v);`).
`BigInt("ffffffffffffff")` throws and is caught, so their bypass case is
rejected today — but by accident. `BigInt("100")` succeeds and is read as
**100 wei decimal**, where a hex-minded dApp may have meant `0x100`.

#### 17.3.2 Design

The [JSON-RPC spec](https://ethereum.org/en/developers/docs/apis/json-rpc/)
settles all three, which makes this enforcement rather than a judgment
call:

> **Unformatted data:** "encode as hex, prefix with `0x`, **two hex
> digits per byte**"
> **Quantity:** "encode as hex, prefix with `0x`, the most compact
> representation"

Add `services/chains/evm/rpcEncoding.ts`:

- `parseRpcData(v)` — requires `0x` prefix, `[0-9a-f]*`, **even length**.
  Well-formed calldata is always even (4-byte selector + 32-byte words),
  so nothing legitimate is rejected.
- `parseRpcQuantity(v)` — requires `0x` prefix. Removes the
  decimal/hex ambiguity entirely.
- `parseTxType(v)` — allow 0/1/2, **reject everything else** rather than
  coercing. Rejecting a type we cannot faithfully build is the whole
  point; silently downgrading is the bug.

Reject, do not repair. Left-padding odd calldata to recover the "real"
approve is tempting and wrong: it guesses at what the node would do, and
if that guess is off we show a confident decode of a transaction that
executes differently.

Applies to `wallet_sendCalls` entries too — otherwise phase M lands with
the same hole phase L is fixing.

#### 17.3.3 Files

- `services/chains/evm/rpcEncoding.ts` — new
- `services/chains/evm/EvmAdapter.ts` — `normalizeTx`, `normalizeSendCalls`,
  retire `safeBigint`

#### 17.3.4 Acceptance

- All five `ppom/bypasses.js` cases and all five
  `malformed-transactions.js` cases return `invalidParams` and open no
  sheet.
- The odd-length approve is rejected, **not** decoded as an approve.
- `type: '0x5'` and `type: '0x76'` are rejected, not sent as type 2.

---

### 17.4 Phase N — the unlimited-approval threshold is decimals-blind

#### 17.4.1 The defect

`UNLIMITED_APPROVE_THRESHOLD = UINT256_MAX / 2n` (`calldata.ts:224`).
The test dapp's malicious approval uses `0xffffffffffffffff`:

```
value             18446744073709551615
threshold         578960446186580977117854925043439539266349923328…
flagged?          False
as USDC (6 dec)   18,446,744,073,710 USDC   ← more than will ever exist
as an 18-dec token            18.45 tokens  ← unremarkable
```

The same integer is a rounding error or an infinite allowance depending
entirely on `decimals()`. An absolute threshold cannot express that, and
their payload sits precisely in the gap: **we say nothing.**

#### 17.4.2 Design

Phase D already probes the contract over RPC for ERC-165. Add
`totalSupply()` and `decimals()` to that probe and the heuristic becomes
a fact: **an allowance above total supply is unbounded in practice**, no
threshold required.

Keep `UNLIMITED_APPROVE_THRESHOLD` as the offline fallback for when the
probe fails, under the phase-D rule that a failed probe must never
*remove* a warning. Three states, phrased differently:

| Probe | Rule | Copy |
| :---- | :---- | :---- |
| supply known, `amount ≥ supply` | fact | "unlimited allowance" |
| supply unknown, `amount ≥ 2²⁵⁵` | fallback | "looks like an unlimited allowance" |
| supply known, `amount < supply` | fact | show the human-readable amount |

The third row is a gain in its own right: with `decimals` we can render
"18,446,744,073,710 USDC" instead of a raw integer, which is what makes
the attack legible without any warning at all.

#### 17.4.3 Files

- `services/chains/evm/erc165.ts` — extend the probe
- `services/decoders/calldata.ts` — supply-aware classification
- `components/dapps-browser/approvals/CalldataRiskSection.tsx` — the three copies

#### 17.4.4 Acceptance

- `approve(spender, 0xffffffffffffffff)` on USDC is flagged unlimited.
- The same value on an 18-decimal token with a large supply is **not**
  flagged, and renders as `18.45`.
- With the probe stubbed to fail, the fallback still fires above 2²⁵⁵.

---

### 17.5 Phase O — EIP-712 structural validation and address coercion

#### 17.5.1 The defect

`EvmAdapter.ts:634-673` validates the signer address and stamps
`activeChainId`, then casts: `typedData as EvmSignTypedDataPayload["typedData"]`.
No structural check. `malformed-signatures.js` supplies six payloads that
reach the sheet unvalidated, and `bypasses.js` two more:

- `domain: {}` — no chain binding at all
- `primaryType: 'Non-Existent'` — not present in `types`
- a type referencing `'ConsiderationItem[+'` — unparseable
- no `primaryType` defined
- **`extraData` in `message` but not in `types`** — we render `message`
  keys directly, so we would display a field that **is not in the signed
  hash**. Display/sign mismatch, in both directions.
- **`verifyingContract` as a decimal integer string.** Their payload
  sends `"917551056842671309452305380979543736893630245704"`, which is
  `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` — **real USDC**. Our
  `isKnownSpender` lookup misses, and the user sees a 48-digit number
  where a token name belongs.
- `chainId` as a 64-digit hex-padded string. `Number()` happens to
  handle this today, but by luck rather than by a parser.

The malformed cases are not fund-loss bugs — viem throws at sign time.
They are *approve-then-fail*, which trains users that rejection is noise.

#### 17.5.2 Design

Validate at the adapter boundary, before an intent exists, so a
structurally invalid payload never opens a sheet:

1. `types[primaryType]` must exist; every referenced type must resolve;
   `domain` must be an object.
2. **Coerce address-typed fields.** Walk `types`, and for any field
   declared `address` whose value is all decimal digits and fits uint160,
   normalise to a checksummed `0x` address. Do the same for `chainId` via
   a strict parser (reject `1e3`, whitespace, and other `Number()`
   surprises). Coercion here is safe in a way that repairing calldata is
   not: the EIP-712 type system tells us the field *is* an address, so
   there is no guessing.
3. **Render only fields declared in `types[primaryType]`**, and warn when
   `message` carries undeclared keys — that is a signal in itself.

The address coercion belongs in the `typedDataRegistry` dock (§16.1) so
every decoder — current and future — sees normalised input.

#### 17.5.3 Files

- `services/decoders/typedDataValidate.ts` — new
- `services/decoders/typedDataRegistry.ts` — normalise before dispatch
- `services/chains/evm/EvmAdapter.ts` — validate before `makeIntent`
- `components/dapps-browser/approvals/EvmSignMessageSheet.tsx` — undeclared-key warning

#### 17.5.4 Acceptance

- All six `malformed-signatures.js` payloads return `invalidParams`; no
  sheet opens.
- `maliciousPermitIntAddress` resolves to USDC and renders "USD Coin".
- `signExtraDataNotTyped` warns; `extraData` is not rendered as signed.

---

### 17.6 Phase P — marketplace order decoders, round 2

#### 17.6.1 The defect

Two order standards in the dapp render as raw typed data, and our Seaport
decoder has a logic hole.

**(a) 0x / ZeroEx `ERC721Order`** (`maliciousTradeOrder`). Domain
`ZeroEx` v1.0.0, verifyingContract `0xdef1c0ded9bec7f1a1670819833240f027b25eff`.
The payload sells NFT `#2516` for `42000000000000` WETH (0.000042) to a
named `taker`. Undecoded today.

**(b) Blur `Order`** (`signBlurOrder`). Domain `Blur Exchange` v1.0,
verifyingContract `0xb2ecfe4e4d61f8790bbb9de2d1259b9e2410cea5`, with
`MakerFee` and an `Order` type carrying `collection`, `listingsRoot`,
`numberOfListings`, `orderType`, `trader`.

§16.3 pulled Blur from `knownSpenders` because its address could not be
sourced. **That reasoning does not extend to a decoder.** A decoder gates
on `domain.name`, which is self-describing and needs no trust: if the
domain says `Blur Exchange`, decoding it as a Blur order is correct
regardless of what address it names. The address table makes the opposite
claim — "this address *is* Blur" — which is what required a source.
Decode without adding an address entry.

`listingsRoot` is a Merkle root, so like Seaport's `BulkOrder` the decoder
reports scope (`numberOfListings`) and must not imply it enumerated the
items.

**(c) Seaport 1.1 missing.** `0x00000000006c3852cbef3e08e8df289169ede581`
is what `maliciousSeaport` signs against; we carry 1.5 and 1.6 only, so
it renders as a bare address.

**(d) The "nothing comes back to you" check tests the wrong address.**
`seaport.ts` compares consideration recipients against `message.offerer`.
An attacker who sets `offerer` to an address they control **and** lists it
as a recipient satisfies `returnsToSigner`, suppressing the warning —
while the person signing still receives nothing. The check must compare
against the **signing address**, and `offerer !== signer` deserves a
warning of its own.

#### 17.6.2 Design

Both new decoders dock into `typedDataRegistry` — one file, one
`register` call, no shared-code edit. That dock (§16.1) is what makes
this phase cheap, and this is its first real test.

Emit the same `ClearSigningDescriptor` shape with `warnings[]`, so the
existing "nothing comes back to you" and "you are being paid nothing"
logic generalises across all three marketplaces rather than being
re-implemented per venue.

#### 17.6.3 Files

- `services/decoders/zeroExOrder.ts` — new (`ERC721Order`, `ERC1155Order`)
- `services/decoders/blurOrder.ts` — new
- `services/decoders/typedDataDecoders.ts` — register both
- `services/decoders/seaport.ts` — signer-based recipient check
- `services/decoders/knownSpenders.ts` — Seaport 1.1 (verify against
  `ProjectOpenSea/seaport` releases before adding, per §16.3)

#### 17.6.4 Acceptance

- `maliciousTradeOrder` renders the NFT, the price and the taker.
- `signBlurOrder` renders collection, listing count and expiry, and does
  **not** claim to know which items are listed.
- A Seaport order whose `offerer` is not the signer warns, even when
  `offerer` appears among the consideration recipients.

---

### 17.7 Phase Q — approval queue is unbounded and undisclosed

#### 17.7.1 The defect

> **Correction, added at implementation time.** The first bullet below
> overstates the defect. `DappBridge.enqueue` already keeps a
> `pendingByOrigin` map and answers a second concurrent request from the
> same origin with `-32002`, so `batching.js`'s loop never reaches the
> store ten deep. The caps still shipped, as defence in depth for the
> paths that guard does not cover, but the substance of this phase is
> the other three bullets and above all the input lock. Full reasoning
> in §17.14(a).

`ppom/batching.js` fires **ten un-awaited** `eth_sendTransaction` calls in
a loop, and ten more `eth_signTypedData_v4`. Against our bridge:

- `pendingIntentsStore.push` has **no cap**. Ten, or ten thousand.
- `ApprovalHost` renders `intents[0]` with no queue depth. The user sees
  a sheet with no idea another nine are behind it.
- Rejecting one paints the next **instantly, in the same place**. The
  reject button of sheet *n* is under the finger that is about to
  approve sheet *n+1*.

That last point is the actual attack: not a crash, a mis-tap. Nine
rejections train the muscle; the tenth is a drain.

#### 17.7.2 Design

1. Cap pending intents per origin. Beyond it, reject with
   `resourceUnavailable` — a dApp with a legitimate need for a dozen
   simultaneous approvals does not exist, and `wallet_sendCalls` is the
   supported way to ask for many actions at once.
2. Show depth: "1 of 10" when more than one is queued.
3. **Reject all remaining**, so the escape is one tap rather than ten.
4. A short input-lock on newly-presented sheets when a queue is draining,
   so an approve tap cannot land on a sheet the user has not seen.

#### 17.7.3 Files

- `services/bridge/pendingIntents.ts` — cap + per-origin accounting
- `services/bridge/ApprovalHost.tsx` — depth, reject-all, input lock
- `components/dapps-browser/approvals/ApprovalShell.tsx` — depth UI

#### 17.7.4 Acceptance

- Ten queued requests show "1 of 10" and offer reject-all.
- Exceeding the cap rejects further requests without unbounded growth.
- Approve cannot fire on a sheet displayed for less than the lock window.

---

### 17.8 Phase R — ENS names on approval surfaces

#### 17.8.1 The defect

`services/ens/resolver.ts` predates this spec: forward + reverse +
avatar + CCIP-read, cached 24h in SQLite, wired into the address book
(`AddContactModal`, `ContactPickerModal`) through `hooks/queries/useENS.ts`.
Unstoppable Domains too, for non-`.eth`.

**The dApp approval sheets use none of it.** `EvmTransactionSheet`
renders `to` as raw hex, as does `EvmBatchCallsSheet`.

The asymmetry is backwards: a user sending to a saved contact sees a
name, while the same user approving a dApp transaction to the same
address sees 42 hex characters. The screen with the higher stakes carries
the less legible label.

#### 17.8.2 Why this is not a free win

Anyone can register an ENS name. Rendering `uniswap-app.eth` beside an
attacker's address puts a **trusted-looking label on the exact screen
where consent is given** — the same failure mode that removed Blur from
`knownSpenders` in §16.3: a name the user trusts, attached to an address
that does not own it. The difference is that here the attacker supplies
the name themselves, deliberately, for the price of a registration.

The existing resolver is sound in the two ways that are easy to get wrong:

- Forward resolution uses viem's `normalize`, i.e. ENSIP-15 via
  `@adraffy/ens-normalize`.
- Reverse resolution uses viem's `getEnsName`, which delegates to the
  UniversalResolver's `reverseWithGateways`. Per ENS's documentation,
  `reverse` "internally checks that the name forward resolves to the
  address you're looking up, so your implementation doesn't need to do
  any additional checks". An attacker therefore **cannot** point a
  reverse record at a name they do not control. Verified from the ENS
  docs and viem's source, not assumed.

What normalization does **not** solve, because it decides validity rather
than similarity:

- **Whole-script confusables.** ENSIP-15 forbids mixing scripts inside a
  label, but a label that is *entirely* Cyrillic is valid and normalizes
  cleanly.
- **Same-script visual confusables.** `rn` against `m`, `i` against `l`.
  Note `vitaIik.eth` normalizes to `vitaiik.eth` — capital I maps to
  lowercase i — which is a distinct, perfectly valid name that reads as
  `vitalik.eth` in most sans-serif faces at sheet size.

#### 17.8.3 Design

1. **The name is additive, never a replacement.** The full address stays
   on screen. A sheet showing only a name is worse than one showing only
   an address.
2. **Reverse only, never dApp-supplied.** Resolve from the address we are
   about to sign for. A name arriving in a dApp payload is never rendered.
3. **Script gate via `ens_split`.** `@adraffy/ens-normalize` exports
   `ens_split(name): Label[]`, and each `Label` carries a script `type`.
   Anything not ASCII/Latin gets no friendly rendering — the address
   shows alone. Offline, cheap, and it closes the whole-script class
   outright.
4. **`ens_beautify` for display**, so the rendered form is canonical.
5. **No trust vocabulary.** No check mark, no "verified", no green. An
   ENS name means somebody paid a registration fee and nothing more.
   This constraint is the point of the phase, not decoration on it.
6. **Best-effort, off the approval path.** A slow or failed lookup
   renders the address and never delays the sheet. Reuse the 24h cache.
7. **Same-script confusables are out of scope, deliberately.**
   Distinguishing `rn` from `m` needs a similarity model whose
   false-positive cost lands on legitimate names. Constraint 1 is the
   mitigation: the address is always present to check against.

#### 17.8.4 Files

- `components/dapps-browser/approvals/CounterpartyLabel.tsx` — new
- `services/ens/displaySafety.ts` — new; `ens_split` script gate +
  `ens_beautify`
- `components/dapps-browser/approvals/EvmTransactionSheet.tsx`,
  `EvmBatchCallsSheet.tsx` — consume it

#### 17.8.5 Acceptance

- An address with a valid reverse record shows the name **and** the full
  address.
- An all-Cyrillic name that normalizes cleanly renders as address only.
- Failed or slow resolution renders the address; the sheet never waits.
- No surface renders a dApp-supplied name.
- No "verified" affordance or check mark exists anywhere near the label.
  Worth an explicit test — this is the constraint most likely to be
  softened later by someone treating the label as a feature.

---

### 17.9 ERC-7715 execution permissions — deferred, with reasons

MetaMask's spec declares three methods we do not implement:

```
wallet_requestExecutionPermissions
wallet_getGrantedExecutionPermissions
wallet_getSupportedExecutionPermissions
```

[ERC-7715](https://eips.ethereum.org/EIPS/eip-7715) ("Request Permissions
from Wallets") lets a dApp request a scoped, revocable permission for a
delegate to act for the user. MetaMask's own example:
`native-token-periodic`, `periodAmount: 0.001 ETH`, `periodDuration: 86400`,
with an `expiry` rule.

**This is the standardised form of the agent permission layer we already
designed** — scoped grants plus hard-deny for agent write tools. Same
primitive, different caller. Worth building the two on one substrate
rather than twice.

Deferred from this round for one reason: **ERC-7715 is `Draft`**, and
MetaMask tags these `Experimental`. Implementing a Draft ERC against a
moving shape is a poor use of the slot while phases L–M represent live
bypasses of shipped controls. When it is picked up it belongs behind the
capability dock (§16.1), never in shared code.

### 17.10 Not fixable in-wallet: address reputation

`maliciousRawEth` (a plain value transfer) and
`maliciousContractInteraction` (`0xef5cfb8c`, confirmed as
`claimRewards(address)` via 4byte) are **well-formed, correctly encoded,
and perfectly decodable**. Nothing about their structure is wrong. They
are malicious only because of *who* the counterparty is.

No amount of decoding reaches them. They need an address reputation feed,
which is what MetaMask's PPOM/Blockaid integration provides and we have
no equivalent of. This is a **build-or-accept decision, not a defect**,
and it is recorded here so it is not rediscovered as a bug:

- **Accept:** document that we detect malformed and over-permissioned
  requests, not malicious counterparties.
- **Build:** integrate a reputation feed, accepting a network dependency
  on the signing path and the privacy cost of sending counterparty
  addresses off-device.

Do not split the difference by hardcoding a small list of bad addresses.
It gives the appearance of coverage with none of the substance, and an
address absent from the list reads as endorsed.

### 17.11 Claims retracted from the round-1 gap list

Named because a wrong gap wastes a slot as surely as a missed one:

- **ENS is not a *test-dapp conformance* gap.**
  `resolutions/ens-resolution.js` resolves through the dapp's own ethers
  provider and never calls the wallet. Round 1 stated this as "ENS is not
  a wallet gap", which was too broad and misleading in two directions:
  we already ship ENS (`services/ens/`, in the address book), and the
  approval sheets still do not use it. Corrected by **phase R** (§17.8),
  which exists because a reader would otherwise conclude from this bullet
  that there is nothing here.
- **`personal_ecRecover` is not a standard to bring.** Absent from
  MetaMask's spec.
- **`eth_signTypedData` v1 is not a gap.** Absent from MetaMask's spec,
  and it carries no domain separator, which conflicts with phase H's
  binding requirement. Its params are also reversed (`[data, from]`),
  which is why it currently fails as "invalid address" — worth returning
  `unsupportedMethod` instead, so the refusal reads as deliberate.

### 17.12 Test-case coverage map

Every interactive case in the dapp, and where it lands. This is the
"nothing left behind" checklist.

| Test-dapp case | Status |
| :---- | :---- |
| `ppom/eip5792.js` — all 6 malicious batch cases | **Phase L** |
| `bypasses.js` — odd hex data ×2, no-`0x` value | **Phase M** |
| `malformed-transactions.js` — all 5 | **Phase M** |
| `ppom/transactions.js` — malicious ERC-20 approval | **Phase N** |
| `bypasses.js` — int address, hex-padded chainId | **Phase O** |
| `malformed-signatures.js` — all 6 | **Phase O** |
| `ppom/transactions.js` — malicious trade order | **Phase P** (ZeroEx) |
| `signTypedData-variants.js` — Blur order | **Phase P** |
| `ppom/transactions.js` — malicious Seaport | **Phase P** (1.1 + signer check) |
| `batching.js` — batch/queue of 10 ×2 | **Phase Q** |
| `ppom/transactions.js` — malicious raw ETH, contract interaction | **§17.10** (reputation) |
| `batching.js` — malicious deeplinks ×3 | N/A — MetaMask deeplink scheme |
| `tempo-transactions.js` — `0x76` | **Phase M** (reject unknown type) |
| `encryption/encrypt-decrypt.js` | **§17.1** — deprecated, deliberately unsupported |
| `signatures/eth-sign.js` | Already hard-rejected (TWV-2026-007) |
| `signatures/siwe.js` — all 5 incl. bad domain/account | ✅ shipped |
| `signatures/permit-sign.js`, `signTypedDataV3/V4` | ✅ shipped |
| `signTypedData-variants.js` — Permit2 single/batch, Seaport bulk | ✅ shipped |
| `transactions/erc721.js` — approve, setApprovalForAll, transferFrom, watchNFT | ✅ shipped |
| `transactions/erc721.js` — ERC-4494 permit | ✅ shipped (phase F) |
| `transactions/erc1155.js` — batch mint/transfer, setApprovalForAll, watchAsset | ✅ shipped |
| `transactions/eip747.js` — watchAsset ERC-20/721/1155 | ✅ shipped |
| `transactions/eip5792/*` — sendCalls, getCallsStatus, getCapabilities | ✅ shipped (phase A) |
| `connections/*` — permissions, add/switch chain | ✅ shipped |
| `resolutions/ens-resolution.js` | N/A as conformance — dapp-side; see **phase R** for the separate sheet-display gap (§17.8, §17.11) |
| `ppom/transactions.js` — mint ERC-20 (`0x40c10f19`) | Minor: add to `SELECTOR_DB` |

### 17.13 Recommended order

**L → M → N → O → P → Q → R.** L and M are live bypasses of controls that
already shipped, so they rank above any new standard. N is a one-line
threshold today that a probe turns into a fact. O and P are decode
breadth. Q is UX-shaped but is the one an attacker reaches for after L
and M close.

R is independent of the security phases and could be sequenced freely,
with one constraint: **it must not land before L.** Phase R adds a label
to the same two sheets phase L restructures, and adding a
trusted-looking name to a sheet that still renders `approve(spender,
amount)` with no values and no risk banner makes that sheet more
persuasive without making it more informative. Order matters here for a
reason that is not merely merge conflicts.

### 17.14 What shipped, and where §17 was wrong

Implemented 2026-08-12, phases L through R, in the order §17.13
recommended. 68 regression cases in
`services/decoders/walletStandardsRound2.test.ts`; `pnpm check:syntax`,
`pnpm check:chains` and `pnpm lint` clean. **Not device-verified** — no
run against the live test-dapp on a device.

#### The two places the spec was wrong

**(a) §17.7.1's first bullet overstated the queue defect.** It says
"`pendingIntentsStore.push` has **no cap**. Ten, or ten thousand." That
is true of the store in isolation and **false of the path an attacker
actually has**. `DappBridge.enqueue` already keeps a `pendingByOrigin`
map and answers the second concurrent request from an origin with
`-32002`, releasing the slot in `handleDecision`. The check-and-set is
synchronous at function entry, so it is atomic against the event loop:
`batching.js`'s ten un-awaited calls get one sheet and nine errors
today, and did before this round.

What survives that guard, and what phase Q was therefore actually built
for, is the rest of §17.7.1 — no depth indicator, no reject-all, and
above all **no input lock**. That last one is the real finding and the
guard does nothing about it: rejecting sheet *n* paints sheet *n+1* in
the same place under the same finger, whether the queue is two deep or
ten, and whether the requests share an origin or not. The caps still
landed, as defence in depth for the paths the origin guard does not
cover (several origins, the `runOnDemandInspector` re-push, a restored
queue), but they are the smaller half.

Worth stating plainly because the spec's framing would have sent an
implementer to build the cap and stop.

**(b) §17.8.2 described the `vitaIik.eth` mechanism loosely.** An earlier
draft said the name "passes ENSIP-15". What actually happens is that
capital `I` **normalizes to** lowercase `i`, producing `vitaiik.eth` — a
different, perfectly valid name that reads as `vitalik.eth` at sheet
size. The conclusion was right, the mechanism as written was not. The
shipped §17.8.2 text carries the corrected version, and
`displaySafety.ts` asserts the real behaviour.

A related detail the spec did not have, found while building the gate:
ENSIP-15 **already disallows** `ǀ` (U+01C0, Latin dental click) and `ı`
(U+0131, dotless i), the two worst Latin-block homoglyphs for `l` and
`i`. That is why the script gate accepts `Latin` alongside `ASCII`
rather than cutting to ASCII for safety — cutting it would cost every
user with an accented name their label and buy almost nothing.

#### What the implementation added beyond the spec

- **Phase L, per-call approve resolution.** §17.2 assumed the decode
  sitting in `EvmCalldataDecoderInspector` was enough. It was not: the
  ERC-165 approve-target probe ran only on the `eth_sendTransaction`
  path, so a one-call batch would still have degraded to
  `approveUnknownAsset` while a standalone call named the token — the
  same asymmetry one layer down, and it would have failed §17.2.4's
  first acceptance test. `resolveApproveTarget` moved onto the adapter
  and both paths call it.
- **Phase L, batch simulation is whole-batch.** Simulating each entry
  independently would evaluate every call against current state, so the
  swap in an approve-then-swap batch would trace against a world where
  its own approve never happened and report a revert that will not
  occur. `simulateBatchAssetChanges` passes the whole array to
  `simulateCalls`; a batch containing a contract creation declines to
  simulate rather than dropping the entry.
- **Phase O, `message` is filtered, not just flagged.** §17.5 asked for
  a warning on undeclared keys. The payload now carries only fields
  declared in `types[primaryType]`, so what a sheet renders is by
  construction what the hash covers. The warning stayed as well:
  silently dropping a field the dApp sent is its own surprise.
- **Phase Q, `key={intent.id}` on the rendered sheet.** Not in the spec
  and load-bearing. Two consecutive requests of the same kind render the
  same element type in the same position, so React was reusing the
  instance and the new sheet inherited the previous one's state,
  including the last transaction's simulated asset movement. It is also
  what re-arms the input lock.
- **Seaport 1.1 added, Blur still absent.** `0x00000000006c3852cbEf3e08E8dF289169EdE581`,
  verified 2026-08-12 against ProjectOpenSea/seaport's deployment table,
  per §16.3's rule. Blur gets a decoder and no address entry, which is
  §17.6.1's distinction made concrete.
- **`@adraffy/ens-normalize` is now a declared dependency.** It was
  already installed as viem's transitive dep and already resolvable, but
  importing it without declaring it means a viem upgrade could remove it
  and break the build. Pinned to `1.11.1`, the version already in the
  lockfile, so nothing new was fetched.
- **`expo-secure-store` stubbed for vitest** (`lib/storage/expoSecureStore.mock.ts`),
  which is what makes the phase-Q queue caps testable at all. In-memory
  rather than a no-op: a store that silently forgets makes round-trip
  behaviour pass by accident.

#### Deliberately not done

- **ERC-7715** stays deferred for the reason in §17.9: it is `Draft`.
- **Address reputation** stays a build-or-accept decision (§17.10). The
  wallet detects malformed and over-permissioned requests, not malicious
  counterparties, and nothing in this round changes that.
- **Same-script ENS confusables** (§17.8.3 rule 7), with the structural
  mitigation in place instead and a test asserting the gap is a choice.

#### The three tests to keep

If this file is ever trimmed, these are the ones that encode a decision
rather than a behaviour:

1. *"classifies a one-call batch of `approve(spender, MAX)` exactly as
   `eth_sendTransaction` does"* — phase L's whole point, asserted as an
   equality between the two paths rather than a property of one.
2. *"keeps both EVM sheets rendering risk through the one component"* —
   structural, because the failure mode is a **copy** of the banner
   block and a copy passes every behavioural test.
3. *"carries no trust vocabulary anywhere near the label"* — the phase-R
   constraint most likely to be softened later by someone who reads the
   ENS name as a feature rather than a legibility aid.

---

## 18. Conformance follow-up (2026-08-12)

Driven by running the app against the live `MetaMask/test-dapp` rather
than reading its source. Everything here is implemented and tested;
**none of it is device-verified.**

### 18.1 EIP-5792 was returning the wrong error codes

The finalized EIP defines its own code range and we answered `-32602`
for all of it. Not cosmetic: a dApp reads these codes to decide what to
do next, and "invalid params" tells it the request was malformed, so the
only recovery it can attempt is the one that cannot work.

| Condition | Was | Now |
| :---- | :---- | :---- |
| `atomicRequired` on a wallet that cannot | `-32602` | **5760** |
| Unsupported chain in `wallet_sendCalls` | `4901` | **5710** |
| Unknown bundle in `getCallsStatus` / `showCallsStatus` | `-32602` / silent | **5730** |
| Non-optional capability we lack | *ignored* | **5700** |
| Batch beyond `MAX_BATCH_CALLS` (25) | *accepted* | **5740** |

**5760 is the one that made the dapp's EIP-5792 panel look broken.** Its
`sendCalls` button sends `atomicRequired: true`, which an EOA genuinely
cannot satisfy — the refusal is correct, but a dApp told `-32602` cannot
tell "re-send without atomicity" from "your JSON is wrong".

**5700 was a real gap, not just a code.** We ignored `capabilities`
entirely. EIP-5792 requires rejecting any capability not marked
`optional`, and ignoring one means executing a batch under different
terms than were authorised — a paymaster the dApp expected to sponsor
gas that we never applied. The enforced set is derived from the same
provider registry `wallet_getCapabilities` advertises from, so the two
cannot drift into rejecting something we announce.

### 18.2 `gasLimit` was dropped on the floor

`normalizeTx` read only `raw.gas`. The dapp's own "Send ETH to Multisig
Address" sends a **raw** `eth_sendTransaction` carrying
`gasLimit: '0x5208'`, so we discarded the dApp's explicit limit and
re-estimated — signing a transaction with a different gas limit than the
request specified. Same class as phase M's transaction-type coercion:
executing something other than what was asked. `gas` now accepts
`gasLimit` as an alias, on both the single-transaction and per-call
paths, and `gas` wins when both are present.

Relatedly, `execSendTransaction` now falls back to the wallet's own
estimate (`gas: payload.gas ?? useEstimate?.wallet.gas`) instead of
letting viem re-estimate on the signing path. Contract deployment is the
case that needed it: init-code costs far more than a bare send.

### 18.3 EIP-747 was a façade

`execWatchAsset` called an `onWatchAsset` hook that **nothing ever
wired**, then returned a hardcoded `true`. The user approved a sheet,
the dApp was told the token had been added, and nothing was recorded
anywhere. That is worse than not supporting the method: a wallet that
answers honestly lets the dApp tell the user to add the token manually,
while ours sent them looking for something that would never appear.

`services/tokens/watchedAssets.ts` is the durable record a future
token-list UI reads. Design notes that matter more than the storage:

- **Chain + address is the identity; symbol, decimals and image are
  labels the site chose.** A dApp can call any contract "USDC" with 6
  decimals. Any UI reading this must show the address alongside the
  symbol, for the same reason `CounterpartyLabel` never lets an ENS name
  stand alone.
- **`addedBy` is kept from the first request, not the most recent.**
  When a token turns out to be hostile, "which site introduced this" is
  the first question and it cannot be reconstructed later.
- **The return value is what actually happened.** A storage failure that
  reports success is the exact dishonesty being replaced.
- Removal is the user's alone; EIP-747 has no un-watch.

### 18.4 Contract deployment: not reproduced

The reported failure (ERC-20 / ERC-721 / ERC-1155 / multisig deploys and
NFT minting failing against the live dapp) **could not be reproduced
statically, and is not explained by anything above.** Every deploy button
in the dapp goes through ethers v5 `ContractFactory.deploy()`, which puts
`{from, data, gas}` on the wire with no `to` key at all. That shape, plus
`to: null`, plus the no-gas variant, all pass `normalizeTx` and produce a
correct deployment payload — asserted now so a future regression is
caught. The sheet, the signing path and viem's serializer all handle an
absent recipient.

Two things are worth checking before looking further at our code:

1. **Smart-account wallets refuse deployment by design**
   (`execSendTransaction`, `Smart4337` / `Smart7702`): a 4337 UserOp can
   only express "call this address", so a bare `CREATE` is rejected
   rather than submitted as something else. If the connected wallet is a
   smart account, every deploy in the dapp fails and always will.
2. **On-chain failure looks identical from the dapp's side.** The dapp
   wraps `deploy()` + `wait()` in one `try`, so insufficient gas
   currency, a chain the RPC cannot serve, or a reverted deploy all
   render as the same "Deployment Failed!" string.

What would settle it: the error object the dapp logs to the browser
console (`console.log('error', error)` in its catch), or the bridge
event log for the failing request. Until then this section is an open
question, not a fixed defect.

### 18.5 The actual cause: dApp reads went to the proxy unauthenticated

§18.4 left contract deployment as an open question. The device log
settled it:

```
eth_chainId      ok    5ms     ← answered locally, never touches the network
eth_blockNumber  FAIL  168ms   ← 401 unauthorized from rpc.takumipay.xyz
```

`EvmAdapter.httpTransport` built its viem transport with `http(rpcUrl,
…)` and **never attached the rpc-proxy bearer**. `utils/clients.ts` and
`MultiProvider` had always applied `rpcFetchOptions`; the dApp bridge
never did. Every proxied read a dApp made came back 401.

The shape of the symptom is why this hid for so long. Methods we answer
from config — `eth_chainId`, `net_version`, `eth_accounts` — never touch
the network, so **connecting and signing looked completely healthy**.
Only the methods that need a real read failed, and ethers polls exactly
those around a deployment (`eth_blockNumber` before send,
`eth_estimateGas`, then `eth_getTransactionByHash` /
`eth_getTransactionReceipt` to resolve `deploy()` and `wait()`). The
dapp wraps all of it in one `try`, so it printed "Deployment Failed!".
Minting failed downstream of that, having no contract to mint from.

**Every other adapter had the same gap**, which is the more important
finding: the defect was not EVM-specific, it was that each namespace
builds its own transport and only two of them went through the helper.

| Site | Was | Now |
| :---- | :---- | :---- |
| `EvmAdapter.httpTransport` | no auth | `proxyAuthHeaders` |
| `EvmTransactionSheet` / `EvmBatchCallsSheet` simulation client | no auth | `rpcFetchOptions` |
| `stellar/horizonClient` (2 `fetch` sites) | no auth | `proxyAuthHeaders` |
| `stellar/sorobanRpcClient` | no auth | `proxyAuthHeaders` |
| `rpc/solanaRpcPool` (`createSolanaRpc`) | no auth | transport with headers |
| `bridge/boot.ts` Sui client | public fullnodes | routed through the helper anyway |

Stellar is a confirmed second instance: its Soroban URL **is** the feed's
`rpcUrl`, so it is a registered proxy origin. Sui currently points at
public fullnodes and was never affected; it goes through the helper so
that repointing it at our proxy is a config change rather than a silent
401.

`proxyAuthHeaders` stays origin-gated on the set `buildChainConfigFromBlockchain`
registers, and that is load-bearing: a blanket header would break
direct-to-provider calls (Alchemy answers 401 to an unexpected bearer)
and leak our token into third-party logs. A dApp-added custom RPC can
never receive it.

`services/rpc/proxyAuth.test.ts` now asserts each construction site
routes through the helper. It is a structural test because the defect
was a *missing call*, and no behavioural test of the adapter can catch a
header that was never attached.

### 18.6 "Contract deployment" told the user nothing

Every deployment rendered one label, so an NFT collection, a token and
an arbitrary program were indistinguishable on the sheet.

`services/decoders/deployedContractKind.ts` reads the standard off the
init-code being signed. No RPC call: Solidity compiles each public
function's 4-byte selector into the runtime dispatcher, and
`supportsInterface` embeds the ERC-165 id as a literal, so both signals
are already in the bytes.

The two signals check each other for free. An ERC-165 interface id **is**
the XOR of its members' selectors, so the selector lists must XOR to the
published ids — `0x80ac58cd` for ERC-721, `0xd9b67a26` for ERC-1155.
A test asserts it, which means a typo'd selector cannot survive. (ERC-20
predates ERC-165 and has no id, so selectors are its only signal.)

ERC-1155 is checked before ERC-721 before ERC-20: the first two overlap
with the third on `balanceOf` / `approve` / `transferFrom`, and the more
specific reading should win.

**This is a legibility aid, not a verification**, and the copy is hedged
in every branch ("This looks like an NFT collection (ERC-721)"). Byte
matching proves the selectors are present, not that the code behaves —
nothing stops a contract embedding an interface id while doing something
else. A test asserts every string starts with "This looks like" and
contains no verification vocabulary, the same constraint phase R put on
ENS labels. The "not reviewed by TakumiPay" line stays regardless.

The exposure is low enough to justify a heuristic: a deployment moves no
assets but gas, and the user is deploying their own code. The value runs
the other way — telling someone who did **not** expect a deployment that
a token contract is what they are being asked to sign.

### 18.7 Phase M was too strict, and it broke a live swap

`parseRpcQuantity` originally required the `0x` prefix on every QUANTITY
and rejected everything else. tower.exchange sends a token approval as

```
{ gas: "100000", maxFeePerGas: "0x9a997bf00", nonce: "0x20", value: "0x0" }
```

decimal for one field, hex for the others, and we answered
`invalidParams: gas` — killing the swap before any sheet appeared.

**The ambiguity that rule defended against is not real.** Nobody writes
bare hex without `0x` in JSON-RPC; a decimal-looking string is what
`String(someBigInt)` produces, which is exactly how dApps generate these
fields. Being stricter than every wallet a dApp is tested against is
indistinguishable, from the dApp's side, from being broken.

What survives, and it is the part that carried the weight all along:

| Input | Reading |
| :---- | :---- |
| `"0x18e0"` | hex |
| `"100000"` | **decimal** |
| `"0x"` | zero |
| `"ffffffffffffff"` | **rejected** (`bypasses.js`) |
| `"1e3"`, `"-1"` | **rejected** |

Bare hex digits stay rejected because there is no reading of them we can
defend, and guessing hex is the dangerous direction: interpreting a
decimal value as hex *inflates* it, since `"1000000000000000000"` is 1
ETH read as decimal and 4722 ETH read as hex. Decimal is simultaneously
the intended reading and the conservative one, which is what makes this
loosening safe rather than merely convenient.

The same over-strictness was swept out of `parseRpcData`: a missing `0x`
on DATA is now tolerated and normalised, because DATA is always hex and
there is nothing to disambiguate. **The even-length rule is untouched**
and applies with or without a prefix, so the odd-hex approve bypass is
still refused either way — asserted directly. A bare `"0x"` QUANTITY now
reads as zero, which cannot make a transaction larger than the dApp
asked for.

`parseTxType` is deliberately *not* loosened. Rejecting `0x3` / `0x4` /
`0x76` is not strictness for its own sake: those types carry fields we
would drop, so accepting them means signing different semantics than
were requested. That is a different thing from refusing a number over
punctuation.

The lesson worth keeping: a validation rule justified by a hypothetical
ambiguity, rather than by an observed payload, is a rule that will meet
a real dApp before it meets an attacker.
