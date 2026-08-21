# Onboarding a new DeFi protocol / pool resolver — runbook

**Owner:** DeFi Strategies (mobile-app + `api/` + `agent-api/`).
**Spec ref:** `docs/defi-pool-level-deposits-spec.md` (design & rationale),
`docs/defi-strategies-spec.md` §7 (adapter pattern), §11 (executors).

> **Status:** Operational runbook. Read this when a **new `project`
> slug shows up in DeFiLlama `/pools`** (often as several "duplicate"
> rows for the same asset — that's a multi-vault protocol) and you want
> users to deposit into it **in-app** instead of the "manual" fallback.
> The spec explains *why*; this file is the *how*, step by step.

> ### ⚠️ Turning a DeFi tier ON? Go straight to [§12](#12-turning-a-tier-on--requirements-and-how-to-test).
>
> The `FEATURE_DEFI_EVM_TIER*` flags default OFF **on purpose**. That is a
> review gate, not unfinished work — everything is present and testable.
>
> - **Testing on a device**: §12.2. Env-only and JavaScript-only — no native
>   rebuild. Both sides must be on, and a **full reload** is required because
>   Fast Refresh will not re-read the flags.
> - **Enabling in production**: §12.3. Eight requirements, one of which
>   (security sign-off on the pinned address book) cannot be automated and is
>   the one most likely to be skipped. Its first full run found **three wrong
>   addresses in 125**, all invisible to the test suite — procedure, evidence
>   and the standing record live in
>   [`defi-address-book-security-signoff.md`](./defi-address-book-security-signoff.md).
> - **What is still blocking**: §12.4.
>
> ### Pinning a new address? [§11.5c Step 5](#step-5--security-sign-off-on-every-address-you-pinned-mandatory) is not optional.
>
> Adding a line to `address-book/` adds a `tx.to` for user funds. A fork test
> proves the calldata is well-formed *for whatever address you gave it*, so a
> wrong address is a green test and a wrong deposit. Nothing downstream catches
> it: a wrong pin fails closed and reads as "a pool that was never ours".
>
> ### Adding a protocol? Start at [§11.5c Step 0](#step-0--decide-what-kind-of-job-this-actually-is).
>
> Step 0 exists because **not every protocol is an extraction**. A
> `protocols.ts` entry supplies an address; it does not teach the system how to
> build a deposit. An LP, a dated market or an async vault needs a new execution
> kind — adapter, validator, Layer-4 decode, Layer-5 pause — which is weeks, not
> hours. And a resolving dry run is **not** a release: production needs §12.3,
> including a **human running it end to end on a real device with real funds**
> (§12.3 #9).

---

## 0. The one thing to internalise

A DeFiLlama `pool` id is an **opaque UUID, not an on-chain address.**
"Matching" = turning `(project, chain, underlyingTokens, poolMeta)` from
`/pools` into the real **on-chain deposit target** (EVM contract / Solana
program id / Sui package+object id). You almost never have to reverse the
UUID — you look the address up from the protocol's own source and match.

**Fail closed.** If you can't resolve *and validate* an address with
confidence, return `null` → the pool degrades to the **manual deep-link**
path automatically. Never guess an address that routes user funds.

## 1. Decide how much work it actually is

| The new protocol is… | What you need | Effort |
|---|---|---|
| **Single market per asset/chain** (one deposit contract, e.g. Aave/Lido-style) | one **protocol adapter** with the static address baked in | low — no resolver |
| **Multi-vault & ERC-4626** (Morpho/Yearn-style — the "duplicate rows" case) | a **resolver** returning `{ kind: "erc4626", vault, asset }`; reuse the generic `Erc4626Adapter` | medium — resolver only, no new adapter |
| **Multi-market bespoke** (Morpho Blue marketId, Curve LP, Pendle) | resolver **+** a family adapter for the new `kind` | high |
| **Non-standard / not worth it** | nothing — leave it on manual deep-link (optionally add a homepage URL) | none |

> Quick classifier: if the same `(protocolSlug, assetSymbol, chainId)`
> yields **more than one** `OpportunityCache` row, it's multi-vault →
> you need a resolver. One row → single-market → an adapter is enough.

## 2. Find the protocol's API — the yield-server shortcut

**Do not hunt blind.** DeFiLlama's own yield-server repo is the map:

- The `/pools` `project` slug **==** the folder name at
  `github.com/DefiLlama/yield-server/src/adaptors/{slug}/`.
- That `index.js` *is* how DeFiLlama fetches the protocol — it shows the
  endpoint(s) and where the on-chain address lives. **Read it as
  documentation, not as code to copy: the repo ships no LICENSE file**
  (verified 2026-08-19 — `LICENSE` 404, GitHub reports no license). Take the
  endpoint and the field name from it, then write our own fetch.

Verified references:

| Slug | Endpoint | Address field |
|---|---|---|
| `morpho-blue` | `https://api.morpho.org/graphql` | vault `address`; market `uniqueKey` (marketId); `loanAsset.address` |
| `yearn-finance` | `https://ydaemon.yearn.fi/{chainId}/vaults/all` | vault = `p.address` (DeFiLlama poolId is derived from it) |

No clean API in the adapter? Fall back to **on-chain factory
enumeration** (read the protocol's factory/registry via RPC — see spec
§3.0 path 3). RPC-only, no third party.

> **Prefer the protocol's plain HTTPS config/address endpoint over
> pulling its SDK.** The shipped, tested Scallop adapter dropped
> `@scallop-io/sui-scallop-sdk` (sui-kit → Pyth → axios bloat) — the SDK
> only resolved the package + shared-object ids, which Scallop serves
> over HTTPS anyway. Pattern (**config not constants**): pin the immutable
> identity (coinType/decimals), *fetch* the mutable deployment ids
> (upgradable package) with a TTL cache + pinned fallback.
> `services/defi/adapters/scallop.config.ts` is the canonical Sui/Move
> reference — copy its shape for a new Move venue.

## 3. Confirm the matching keys are present

The resolver matches on fields captured from `/pools`
(`defillama.client.ts` → `OpportunityCache`):

- `poolMeta` — the vault/market **name** ("Steakhouse USDC"). The primary
  disambiguator between siblings. **If this is `null`**, matching degrades
  to `(asset + chain)` + a tvl/apy heuristic, or factory enumeration.
- `underlyingTokens[0]` → `assetContract` — the deposited asset.
- `chainName` / `chainId` / `namespace`.

If any are missing, first make sure the DeFiLlama client actually
captures them (Phase 0 of the spec) — don't work around a dropped field.

## 4. Write the resolver

Location: `api/src/strategies/targets/` (one file per family).

```ts
// api/src/strategies/targets/morpho.resolver.ts
export const MorphoResolver: PoolTargetResolver = {
  family: "morpho",
  aliases: ["morpho-blue", "morpho-aave", "morpho"], // DeFiLlama project slugs
  async resolve(pool) {
    const vaults = await fetchMorphoVaults(pool.chain); // api.morpho.org/graphql
    const match = vaults.find(
      (v) =>
        v.name === pool.poolMeta &&                       // poolMeta == vault name
        eqAddr(v.asset.address, pool.underlyingTokens?.[0]) &&
        v.chainId === resolveChainId(pool.chain),
    );
    if (!match) return null;                              // fail closed → manual
    return { kind: "erc4626", vault: match.address, asset: match.asset.address };
  },
};
```

Then **register it** (never a `switch` on slug — space-docking):

```ts
// api/src/strategies/targets/registry.ts
registerResolver(MorphoResolver);
```

The `score-opportunities` worker calls `resolveTarget(pool)` and writes
`depositTarget` on the `OpportunityCache` row.

## 5. Validate on-chain before trusting it (mandatory)

Add/extend validation for the `kind` (spec §3.2). For `erc4626`:

- `vault.asset()` **==** expected underlying, and
- `vault.totalAssets()` within a tolerance band of DeFiLlama `tvlUsd`, and
- the address answers the 4626 selector set.

Any mismatch → treat as unresolved (`depositTarget = null`). This is the
last line before funds move.

## 6. Map the target to an adapter

- `kind: "erc4626"` → **already handled** by the generic `Erc4626Adapter`
  (`services/defi/adapters/`). Nothing to write — the resolver output +
  registry lookup by `kind` is enough.
- A **new** `kind` → add a family adapter and register it
  (`services/defi/registry.ts`); resolution is by `DepositTarget.kind`
  alongside `slug`/`externalSlugs`. Keep it chain-agnostic — no
  `namespace ===` branches (CI `pnpm check:chains`).

`BuildDepositArgs.target` carries the concrete target into
`buildDeposit`. Adapters that ignore it keep their canonical market
(backward compatible).

## 7. Wire the manual deep-link (optional, cheap)

Even if in-app deposit isn't ready, give the manual path a precise link:

- **Deep-link:** add a per-protocol URL template (client-side registry,
  like `PROTOCOL_DISPLAY_NAMES`) filled from `depositTarget.address` +
  asset + chain. No storage.
- **Homepage fallback:** persist `ProtocolScoreCache.appUrl` from
  DeFiLlama `/protocol/{slug}.url` (already fetched in
  `getProtocolMetadata`, currently dropped). Protocol-level, **not**
  `OpportunityCache`.

## 8. Test before shipping

1. Pick a real `poolId` for the new slug from `OpportunityCache`.
2. Run `resolveTarget(pool)` → assert the expected vault address.
3. Run the on-chain validation (§5) against a live RPC.
4. Dry-run `buildDeposit` with a tiny amount; confirm the `to`/data.
5. Confirm a **wrong** poolMeta / stale vault resolves to `null` and the
   UI shows manual (fail-closed regression check).

## 9. Invariants (do not break)

- **LLM never passes an address.** `defi_deposit` carries `pool_id`; the
  executor re-fetches the authoritative `depositTarget` server-side
  (mirror `resolveAndGuard` in `writes.ts`). Reject address-shaped inputs.
- **Fail closed to manual**, never guess.
- **Resolvers are one isolated file each**; adding a protocol is a
  registration, never a branch in shared code.
- **User-facing errors stay friendly** (CLAUDE.md); raw resolver/API
  detail is `__DEV__`-only.
- **Cache** resolved targets in the DB; re-resolve on the poll schedule,
  not per request.

## 10. File map (where things live)

| Concern | Path |
|---|---|
| DeFiLlama fetch + field capture | `api/src/strategies/external/defillama.client.ts` |
| Scoring worker (calls `resolveTarget`) | `api/src/strategies/workers/score-opportunities.processor.ts` |
| Resolver registry + resolvers | `api/src/strategies/targets/` |
| **Which chains exist** (data, not code) | `api/src/strategies/targets/chain-directory.ts` ← `Blockchain` table |
| **Pinned contract constants** (reviewed) | `api/src/strategies/targets/address-book/` |
| Per-kind on-chain validators | `api/src/strategies/targets/validation.ts` |
| Tier / family flags + kill-switch | `api/src/strategies/targets/feature-flags.ts` |
| Router-calldata proxy (Pendle) | `api/src/strategies/router-quote.service.ts` |
| `OpportunityCache` / `ProtocolScoreCache` schema | `api/prisma/schema.prisma` |
| Mobile adapter registry + adapters | `services/defi/registry.ts`, `services/defi/adapters/` |
| **Safety pipeline** (layers + providers) | `services/defi/safety/` |
| Slippage policy | `services/defi/slippage.ts` |
| `BuildDepositArgs` / `DepositTarget` | `services/defi/types.ts` |
| Deposit executor + guards | `services/agent-executors/defi/writes.ts` |
| Grouping + card rendering | `services/defi/opportunityDisplay.ts`, `components/home/TakumiAgent/StructuredUI/cards/OpportunityListCard.tsx` |

---

## 11. EVM protocol expansion — the family model

`docs/defi-evm-protocol-expansion-spec.md` reorganised EVM coverage around
**execution families**. Read §13 of that spec before adding an EVM protocol;
the short version is the decision tree:

```
Is deposit/withdraw ERC-4626 (deposit/redeem)?      → resolver only, kind "erc4626".
Is it an Aave-v3-fork Pool (supply/withdraw)?       → resolver only, kind "aave-v3".
Does an existing kind already fit its ABI?          → resolver only, emit that kind.
   (compound-v3 / compound-v2 / morpho-blue /
    curve-lp / solidly-lp / balancer-lp /
    lst-stake / router-call / async-vault)
Genuinely new ABI shape?                            → new kind in BOTH union files
                                                      + family adapter + validator
                                                      + resolver. Register all three.
```

**~90% of new protocols are resolver-only.** A new adapter is required only for
a genuinely new on-chain calling convention.

### 11.1 Chains are data; contract addresses are not

- **Which chains we support** comes from the `Blockchain` table via
  `chain-directory.ts`. Onboarding a chain for DeFi is a seeded row plus an
  rpc-proxy route — no code change, no redeploy, no edit to any resolver. If
  DeFiLlama's chain name doesn't match the row, add an alias to
  `STRATEGIES_CHAIN_ALIASES` (JSON env), not to a map in code.
- **Deployment addresses** are the opposite: they are the trust anchor, so they
  live in `address-book/` as reviewed constants with **no env or API override**.
  A chain missing from a family's book simply means that protocol isn't
  available there, and the resolver fails closed to Manual.

### 11.2 Before you register a family (the §11.3 minimum bar)

A family goes live **only** when all of these exist and are fork-tested:

- [ ] Resolver, failing closed on any ambiguity.
- [ ] Layer-1 validator in `validation.ts` (there is no `default: true` for EVM
      kinds — a kind without a validator is rejected).
- [ ] Layer-4 decoded-intent case in `safety/providers/eip155.ts`.
- [ ] Layer-5 pause read.
- [ ] Deposit + partial withdraw + `"MAX"` withdraw round-trip, dust ≈ 0.
- [ ] Slippage enforced where the family can be sandwiched (never a zero min).
- [ ] Approvals scoped to the exact amount.
- [ ] Union updated in **both** files (`services/defi/unionParity.test.ts` is
      the CI guard).
- [ ] Pinned addresses security-reviewed (§12 Q7).
- [ ] Exit terms answerable: the chain's `readExitTerms` returns something other
      than `unknown` for the family's kind, or the family stays Manual (§12 Q2a).
      A lockup nobody can read is a lockup nobody consented to.
- [ ] Runbook entry appended.

Tier flags default **OFF** on both sides (`FEATURE_DEFI_EVM_TIER1..4` /
`EXPO_PUBLIC_FF_DEFI_EVM_TIER1..4`). Enabling one is a deliberate act. Per-family
sub-flags (`..._FAMILY_<NAME>`) let a single family be dark-launched, and
`DEFI_FAMILY_KILL_SWITCH` / `EXPO_PUBLIC_DEFI_FAMILY_KILL_SWITCH` disables one
instantly during an incident.

### 11.3 Families deliberately NOT registered

These are implemented and fork-testable but withheld, each for a stated reason.
Read the reason before turning one on.

| Family | Why it is off |
|---|---|
| `balancer-lp` (v3 only) | v2 shipped 2026-08-19. v3 has no `joinPool`/`exitPool`/`BalancerQueries` at all — liquidity moves through a Router — so v3 pools stay Manual until that path is built. The adapter refuses to build against a non-v2 Vault. |
| `router-call` (Uniswap v3/v4) | A concentrated-liquidity position needs a tick range — a different product decision from "supply this asset". Pendle ships; Uniswap waits for that UX. |
| `async-vault` (ERC-7540) | §7: no resolver until the two-phase request→claim flow is proven end to end. The kind, validator, adapter and claim-watcher exist; the resolver is the last piece. |
| Convex / Aura | Boosting is a two-leg flow (acquire the LP, then stake it) that one-shot `UnsignedCall` cannot express. Ships on the Tier-4 two-phase machinery. |
| Avalon (Aave fork) | One `Pool` per market, so there is no single address to pin. Its book is empty on purpose. |
| Curve classic pools | `curveLp.ts:lpTokenOf` returns `target.pool`, i.e. it assumes the pool IS its LP token. True for Curve NG, false for the classic pools (3pool mints a separate ERC-20). The resolver now refuses a pool that is not its own LP token, so classic pools fail closed to Manual. Supporting them means adding `lpToken` to the shared union — a change to both repos and the parity test. |
| StakeWise, cbETH, LsETH, LBTC, Renzo | Each needs either a permissionless mint that does not exist (cbETH), a KYC-gated one (LsETH), a Bitcoin-side flow (LBTC), a per-vault entry contract that wants its own resolver (StakeWise), or an unreviewed dual-overload stake plus a mint cap (Renzo). Listed in `address-book/lst.ts` as `LST_VENUES_DEFERRED`. **Kelp and Mantle mETH have SHIPPED** — both were min-out venues, and in both cases the blocker turned out to be having a quote to floor against, not the min-out itself. |

### 11.3a Morpho Blue markets that stay Manual (by design)

`morpho-blue` is registered, but the oracle-provenance gate (§12 Q6) admits only
part of the family — measured live on 2026-08-19, 23 markets / ~$2.44B of
supply, which is ~80% of curated TVL on Base and ~36% on Ethereum. The rest fail
closed, and the resolver logs which check refused them. The four reasons, in
order of how much TVL they hold:

| `reason` | What it means | To widen it |
|---|---|---|
| `feed-not-reviewed` | The oracle reads a real feed nobody has reviewed — a protocol's own rate adapter, or an RWA/NAV feed with a 27-hour heartbeat. | Review it and add one line to `CHAINLINK_FEEDS`. That admits every market reading it. |
| `routes-through-erc4626-vault` | The oracle prices through a vault's `convertToAssets` (e.g. sUSDS, sUSDe collateral), which is a second trust assumption on a contract the book has not vetted. | Needs a reviewed 4626 allowlist plus a decision on share-price manipulation. Not a one-liner. |
| `not-factory-deployed` | A bespoke oracle contract, not a `MorphoChainlinkOracleV2`. Includes some large markets (USDC/USDe on Base, $352M). | Only by reviewing that specific contract. There is no generic answer here. |
| `irm-not-allowlisted` | A market on a non-`AdaptiveCurveIRM` model. | Pin the IRM after review. |

**Do not "fix" a Manual Morpho pool by loosening the gate.** Each reason above is
a distinct risk decision; the honest Manual badge is the correct output until
someone makes it.

> **The oracle gate is not the main reason Morpho pools are Manual, and a
> resolving Morpho pool is not necessarily correct.** Measured 2026-08-21: only
> one refusal in a full run came from this gate, while 25 pools that DO resolve
> were routing to the wrong vault. See [§11.6b](#116b-morpho-measured-2026-08-21-and-a-live-mis-route-found)
> before spending time here.

### 11.3b Exit terms: what "in-app" promises about getting out

Badging a pool "Deposit in-app" is a claim about BOTH directions. `ExitTerms`
(§12 Q2a) makes that claim explicit, and the EVM provider answers it per kind:

| Kind | Verdict | Where it comes from |
|---|---|---|
| `aave-v3`, `compound-v2/v3`, `morpho-blue`, `curve-lp`, `solidly-lp`, `balancer-lp`, `router-call` | `instant` | By construction. A money market at full utilisation is an *illiquidity* problem for Layer 2, not a lockup |
| `lst-stake` | `queued` when the venue's `exit` is `"queue"`, else `instant` | The venue book, reviewed when the venue was pinned. `dex` costs slippage, not time |
| `async-vault` | `queued` | ERC-7540 is a request/claim machine by definition |
| `erc4626` | probed | `supportsInterface(0x620ee8e4)` → queued; `cooldownDuration()` → delayed; else instant |

**Consent is required only for lockups we did NOT already review.** A `source:
"declared"` verdict comes from a pinned venue book, i.e. a decision taken under
review when the venue was added (§12 Q2 ships queue-exit LSTs deposit-only on
purpose). A `source: "onchain"` verdict was discovered at deposit time, hidden
behind an interface nobody could distinguish from a liquid vault, and is the
case `ExitTermsConsentCheck` exists to stop. Requiring per-deposit consent for
the declared ones would have blocked ether.fi and Rocket Pool, which are live
and in-app, while telling the user nothing new.

**The one soft spot, stated plainly.** That final `else instant` for `erc4626`
rests on the family allowlist, not on proof: only vaults a reviewed family
resolver admitted ever reach it. A vault with a bespoke lockup and neither a
7540 interface nor a `cooldownDuration()` getter would be mischaracterised as
liquid. **If a generic "any 4626 that validates" path is ever added, that
default MUST become `unknown` outside a reviewed family** — the comment in
`providers/eip155.ts` says so at the line itself.

### 11.4 Adding a new CHAIN (not a protocol)

Implement and register one `ChainSafetyProvider`
(`services/defi/safety/providers/`, all seven primitives) plus that chain's
adapters/resolvers. **Every provider-backed safety check then covers the chain
with zero edits to any check or the runner.** A partial provider registers
read-only/Manual until its `simulate` and `decodeIntent` are trustworthy —
never as "in-app".

### 11.5 Verification tooling

Four tools, each answering a different question. Their order matters: a family
that fails an earlier one cannot pass a later one.

| Tool | Question it answers | Needs |
|---|---|---|
| `pnpm defi:dry-run` (api) | Would this pool resolve if the flag were on, and if not, why? | DB + RPC. Read-only |
| `DRIFT_CHECKS=1 npx jest src/strategies/targets/address-book/address-book-drift` | Is every pinned address still the contract we think it is? | Per-chain RPC |
| `DRIFT_CHECKS=1 npx jest src/strategies/targets/external-api-drift` | Do the third-party APIs the resolvers depend on still have the shape we send? | Network |
| `FORK_TESTS=1 npx vitest run services/defi/__fork__` (mobile) | Does the calldata the DEVICE builds actually move the position? | anvil + an **archive** RPC |

Run the dry run first: a family whose pools all refuse has nothing for a fork
test to execute. Run the drift checks nightly, not in CI — a failure there means
"a family has gone dark", which is not the same as "the build is broken", and
gating merges on third-party uptime trains people to ignore red.

**The fork suite needs an archive endpoint.** `FORK_BLOCKS` pins a block per
chain so a failure is reproducible; fetching state at an old block is an archive
request, which free endpoints refuse. `FORK_LATEST=1` forks the head instead and
warns loudly every run: results then depend on live market state (an Aave
reserve at ~100% utilisation makes a *correct* `MAX` withdraw revert), so a
green head run is **not** evidence a family is safe to enable.

Two environment quirks the harness handles, both found the hard way:
`~/.foundry/bin` is not on a test runner's PATH, and anvil 1.7.1's default
`--hardfork latest` (Osaka) fails a plain `balanceOf` against forked mainnet
state with `EVM error OpcodeNotFound` — it pins `prague`, overridable with
`FORK_HARDFORK`.

#### The tooling itself was lying, until 2026-08-21

Three of the four tools above reach the network, and only the API server had
the outbound-network settings that make that reliable. Fixed in
`api/src/config/egress-network.ts`, which all three now import. Read this before
concluding a protocol has no coverage, because every symptom below looks
exactly like "this protocol is not ours".

**1. Node abandons a healthy IPv4 connection.** `ydaemon.yearn.fi` is answered
by a DNS64 resolver with both an A record and a NAT64 `AAAA`. The IPv6 form is
`ENETUNREACH` here, and the IPv4 handshake takes **364ms** — longer than Node's
`autoSelectFamilyAttemptTimeout`, which defaults to **250ms**. So happy-eyeballs
drops the good address mid-flight, `fetch` throws, every resolver swallows it as
"no candidate", and the pool degrades to Manual. **`curl` succeeds throughout**,
which is why this reads as the remote API being down. Yearn went **0/30 → 6/30**
with no resolver change; the full run went 397 → 408.

`main.ts` had carried the fix since an earlier incident. The dry run and the
jest processes did not, because neither boots through `main.ts` — the fix was
one file away from the tools whose entire job is to tell you the truth.

**2. Jest had no environment at all.** There is no `--env-file` for jest, so
networked specs saw no credentials. The address-book drift check was reporting
`checked something: 0` — not "no endpoints", but "no `.env`". Note that
`process.loadEnvFile()` **cannot** fix this and fails silently when tried: it is
a native binding that writes to the real process env, while jest hands each test
file a copy. Parse and assign instead (`config/jest-setup.ts`).

**3. The drift check could not reach our own RPC.** Its only endpoint mechanism
was `STRATEGIES_RPC_URL_<chainId>`, a bare URL — and this repo's `rpc-proxy`
authenticates with a **Bearer header**, which a URL cannot carry. Following the
runbook therefore meant going and finding public endpoints first, which is a
large part of why the check "is not scheduled anywhere" (§12.4) and why its
first-ever run was during the security sign-off. It now defaults to Alchemy:
one key already in `.env`, all ten pinned chains.

**That includes chains with no `Blockchain` row (56, 43114).** A pin has to be
verifiable *before* its chain is seeded, or the addresses go live unreviewed on
the day someone adds the row. First real run: 73s of on-chain reads, **zero
drift** — the first independent confirmation that the 2026-08-21 sign-off holds.

**4. A permanently-red check is a disabled check.** The `/poolsOld` drift tests
asserted free-tier reachability, which has been HTTP 402 since 2026-08-19 for a
source we do not register without `DEFILLAMA_PRO_API_KEY`. They are now gated on
that key. A suite that is always red about something deliberate is exactly the
"trains people to ignore red" failure this section warns about, and it would
have buried a real drift in a family we do use.

### 11.5b Discovery: `/poolsOld` is gone, and what replaced it

`https://yields.llama.fi/poolsOld` answers **HTTP 402** on the free tier
(verified 2026-08-19). It was the only protocol-agnostic way to turn a pool UUID
into an address, so when it went behind the paywall **seven families stopped
resolving anything, silently** — a missing candidate is indistinguishable from
"this pool is not ours".

It is no longer registered at all unless `DEFILLAMA_PRO_API_KEY` is set. A source
we know answers nothing does not belong in the fallback chain: it sits there
looking like coverage.

**The free replacement is `/poolsEnriched?pool=<uuid>`** (`PoolUrlCandidateSource`).
It carries a field `/pools` does not — `url`, the protocol's own deep link — and
for a large slice of the catalog that link contains the contract address:

```
yearn-finance   https://yearn.fi/v3/1/0xBe53A109…             → the vault
euler-v2        https://app.euler.finance/earn/0x2C803c8C…    → the EVault
morpho-blue     https://app.morpho.org/base/vault/0xbeef0e…   → the MetaMorpho vault
```

Measured on 2026-08-21: Euler 1/8 → 7/9, Yearn 0/13 → 4/15, Morpho +13 pools.

Two ways it could hand back a wrong address, and the guards that exist:

1. **A bytes32 that looks like an address.** Morpho's *market* links carry a
   32-byte market id, and a naive `0x[0-9a-fA-F]{40}` happily matches its first
   40 hex characters — producing a well-formed address that is not one. The
   regex requires hex boundaries on **both** sides, so a 64-hex id matches
   nothing rather than matching its own prefix.
2. **A link naming several contracts.** Which one is the vault would be a guess,
   so more than one distinct address is a refusal.

It is still only a **candidate**: §12 Q7 forbids it from ever becoming a `tx.to`
for a singleton kind, and Layer-1 validation is what admits it.

**When the link is the wrong contract.** Curve LlamaLend's deep link points at
the market's **Controller**, not its ERC-4626 vault, so all 20 candidates
reverted on `asset()` and were refused. The fix generalises: fetch the
protocol's own list, then **join on the thing the link does name**. Curve's API
publishes `controllerAddress` next to the vault, so the two sources have to
agree, and the returned address always comes from Curve. That took LlamaLend
from 0/21 to 11/22 — with the other 11 being borrow-side rows that must never
resolve.

**Protocols whose link has no address** (Spark, Concrete, Fluid, Venus, Vesper,
Origin) need their own source. That is §11.6, and it is the better answer anyway.

### 11.5c Adding a protocol — the extraction recipe

**This is the section to follow.** One protocol is one entry in
`api/src/strategies/targets/protocols.ts`. Registration, feature-flag gating and
the kill-switch are derived from that entry, so a protocol cannot ship
half-wired — the mistake §11.3 warns about is now structurally impossible rather
than documented.

#### Step 0 — decide what kind of job this actually is

**Extraction is not the whole job for every protocol.** A `protocols.ts` entry
supplies an ADDRESS. It does not teach the system how to build a deposit. If the
protocol's execution shape is one we already implement, the entry is the whole
change; if it is not, the entry is the smallest part of it.

| What you found | What it needs | Size |
|---|---|---|
| ERC-4626 vault, single asset | one `protocols.ts` entry (`kind: "erc4626"`) | **hours** |
| cToken fork (Venus/Benqi/Moonwell lineage) | one entry (`kind: "compound-v2"`), Comptroller pinned | **hours** |
| Aave-v3 fork | one entry + the `Pool` pinned per chain | **hours** |
| Vaults with a small fixed set | one entry (`kind: "erc4626-pinned"`) + address book + drift-spec coverage | **hours** |
| **LP / AMM position** (paired symbol) | new `DepositTarget` kind, mobile adapter, Layer-1 validator, Layer-4 decode case, Layer-5 pause read, union updated in BOTH repos, fork test | **weeks** |
| **Dated / maturity market** (Pendle-shaped) | as above, plus expiry handling and quote staleness | **weeks** |
| **Async / withdrawal-queue vault** | Tier-4 two-phase machinery (§7) — request → claim, pending-position state, agent copy | **not yet built** |
| **Leveraged / borrow position** | out of scope by design (§1 non-goals) | — |

`pnpm defi:dry-run --queue` tags every row with its likely shape
(`single-asset` / `LP pair — needs kind` / `dated market`) so this decision is
made before the work starts, not during it. The heuristic reads the pool symbol,
so **confirm it against the protocol's own docs** — it orders the work, it does
not decide anything.

The largest entry in the queue today (`fluid-dex`, ~$16.7B) is an AMM. It is at
the top because of TVL, and it is the one row an engineer should *not* start
with.

#### Is this an EVM protocol?

**The manifest and the discovery layer are EVM-only.** `CandidateSource` returns
`Address` (`0x${string}`), which a Sui object id or a Solana pubkey is not, so a
non-EVM protocol declared through `protocols.ts` would resolve nothing. It fails
loudly rather than silently — the conformance spec rejects a non-EVM execution
kind, and `protocolApiSource` warns by name if a non-EVM chain reaches it.

Non-EVM protocols resolve through their **own resolver** today
(`scallop.resolver.ts`, `navi.resolver.ts`, `ember.resolver.ts`,
`suilst.resolver.ts`), each calling the protocol's API directly. Copy one of
those, not a manifest entry.

What IS already chain-agnostic, and needs nothing per namespace:

| Layer | Status |
|---|---|
| Safety pipeline (§11) | Agnostic. A chain implements `ChainSafetyProvider`; optional capabilities are presence-checked, and a namespace with no provider no-ops rather than blocking |
| `DepositTarget` union | Agnostic. Already carries `scallop-market`, `navi-pool`, `ember-vault`, `sui-lst`, `solana-reserve` |
| Adapter registry | Agnostic. Routes by `kind`; `pnpm check:chains` forbids namespace branches in shared code |
| **Discovery / manifest** | **EVM-only.** Docking means widening the candidate identifier to a namespace-neutral string, never a `namespace ===` branch |

#### Step 1 — find the protocol's own address source

`DefiLlama/yield-server`'s `src/adaptors/<slug>/index.js` names the endpoint and
the field the address lives in. Every adaptor just calls the protocol's public
API; that is the map.

> ⚠️ **Read it as documentation, not as code to copy.** That repo ships **no
> LICENSE file** (verified 2026-08-19: `LICENSE` 404, GitHub reports no
> license). Take the endpoint and the field name, then write our own fetch.

#### Step 2 — cross-check the endpoint against the protocol's own docs

Adding a row means treating that domain as **authoritative for where user funds
go**. This is the one judgement no test can make for you.

This is also the line that rules out aggregators. Measured 2026-08-19: searching
Zerion for `yoUSD` returned YieldFi's `yUSD` — a different protocol's vault
sharing the same `asset()`, which therefore **passes** `validateErc4626`.
Coverage was 2/12 and one of the two was wrong. A protocol is authoritative
about its own vaults; a third-party search is not (§12 Q7).

#### Step 3 — write one entry

```ts
registerProtocol({
  slug: "yo-protocol",
  aliases: ["yo-protocol", "yo", "yo-finance"],
  tier: "tier1",
  execution: { kind: "erc4626" },        // picks adapter + validator
  minTvlUsd: 250_000,                    // RPC budget, NOT a safety control
  discovery: {
    via: "protocol-api",
    url: () => "https://api.yo.xyz/api/v1/vault/stats?secondary=true",
    rows: (payload, chainId) => /* → { address, asset, symbol, name }[] */,
  },
});
```

The `execution.kind` options:

| kind | Use when | Registers |
|---|---|---|
| `erc4626` | Vaults discovered per market | `Erc4626Adapter` path |
| `erc4626-pinned` | Small, stable vault set in the address book | pinned resolver, no discovery |
| `compound-v2` | cToken fork (Venus, Benqi, Moonwell lineage) | `CompoundV2Adapter` path |
| `bespoke` | Identity needs custom logic; resolver lives elsewhere | discovery only |
| `reserved` | Claim a slug so a look-alike cannot take it | a resolver that always refuses |

The `discovery.via` options:

| via | Use when | Notes |
|---|---|---|
| `protocol-api` | The API returns address **and** asset | The common case |
| `protocol-api-addresses` | The API lists addresses but **no asset** | `asset`/`symbol`/`name` are read on chain. Concrete is the example: its payload has no asset because DeFiLlama's adaptor multicalls `asset()` itself. Never infer an asset instead |
| `registered-source` | An on-chain registry already registered elsewhere | e.g. `compound-v2-comptroller` |
| `source` | You need pool-level logic before the lookup | e.g. Curve LlamaLend joining on `controllerAddress` |

**If DeFiLlama publishes more than one row per market**, the non-deposit rows
must be refused **before a candidate is requested** — pass `skipPool` to the
resolver. Curve LlamaLend emits a borrow-side row per vault whose
`underlyingTokens` is the *collateral*, and the collateral of one market is very
often the borrowed asset of another, so a borrow row can find a real, validating
vault belonging to a **different** market. Letting it through and relying on
"the candidate we happen to get is not 4626" is the same reasoning that let
`aave-v4` route onto the v3 Pool.

#### Step 4 — run the dry run

```bash
pnpm defi:dry-run --protocol <slug>          # resolved counts + a named reason per refusal
pnpm defi:dry-run --queue                    # what is still Manual, biggest TVL first
```

The dry run also prints **discovery health**. A source marked `<< DARK`
answered nothing at all across every lookup — which is indistinguishable from
"these pools are not ours" unless someone looks. That is precisely how the
`/poolsOld` outage went unnoticed, and it is not hypothetical: the Pendle entry
above shipped with `limit=500`, the API caps it at 100 and returns HTTP 400, and
the source yielded zero rows. It read as "Pendle has no pools of ours" until the
health line reported `0 hits / 72 lookups`. Fixing the limit took it to **62/84**.

#### Step 5 — security sign-off on every address you pinned (MANDATORY)

**If your entry added a line to `api/src/strategies/targets/address-book/`, you
are not done.** A pinned address is a `tx.to` for user funds, and it is the one
thing in this pipeline that no test can validate — a fork test proves the
calldata is well-formed *for the address you gave it*, so a wrong address
produces a green test and a wrong deposit.

Procedure, evidence format and the standing record:
**`docs/runbooks/defi-address-book-security-signoff.md`**.

The bar (from `address-book/README.md`) is three things, and the third is the
one people skip:

1. The address comes from the protocol's **own** deployment registry or docs.
2. It is cross-checked against a **second official source**.
3. **The label matches.** An address can be real, official, and still be the
   wrong contract.

> **This is not a formality that has never caught anything.** The first full
> run (2026-08-21) reviewed 125 pinned addresses and found **three wrong ones**:
> Ethereum `cWETHv3` pinned to an address with **no code on mainnet**; Radiant
> pinned to a pool that reverts, for a protocol that has been **winding down
> since June 2026** after a $50M exploit; and Origin `wOUSD` pinned to
> **Origin's governance token**. All three were fail-closed, which is precisely
> why nobody noticed — see below.

**Why the safety layers do not cover this.** Every one of those three failed
closed to Manual. Nothing went red, no dry run reported an error, and the
checksum guard in `address-book.spec.ts` passed on all of them — a mistyped
address that is re-checksummed produces a *valid* checksum, so the guard cannot
fail on this class of bug. A wrong pin does not look like a bug; it looks like
**a pool that was never ours**. Fail-closed is a safety net, not a detector.

**Ask the venue question too.** "Is this the right address?" is the easy half.
"Should we be sending user funds here at all?" is the half that needs a person:
the Radiant finding could not have been caught by any address diff, and
"fixing" the address without asking would have enabled deposits into a
protocol in maintenance mode.

**Do not trust a `do not re-investigate` comment in the book** until sign-off
has confirmed the constants it is defending. One of those comments is exactly
what hid the Origin finding.

#### Resolving is NOT shipping

A green `--protocol <slug>` line means the backend can produce a validated
target. It does **not** mean users can deposit. Between there and production:

1. The family's tier + sub-flag must be on **in both repos** — a half-flagged
   family badges "Deposit in-app" for a target the device cannot build (§8.6).
2. Fork tests must show the calldata **the device builds** actually moves the
   position (§11.7).
3. Pinned addresses need **security sign-off** (§12 Q7, Step 5 above) — the one
   step no test replaces. Procedure + record:
   `docs/runbooks/defi-address-book-security-signoff.md`.
4. A human must run it **end to end on a real device with real funds** (§12.3
   #9).

Full list: **§12.3**. Do not treat a resolved dry run as a release.

#### The three signals the dry run gives you

Every recurrence of a bug this system has actually had is now something the
tooling *tells* you, rather than something you discover:

**1. `!! Slugs that reached a resolver only by SUBSTRING`**
Nobody claims the slug outright, so a family that merely looks like it answered.
This has mis-routed funds twice — `spark-savings` → SparkLend's lending Pool,
`aave-v4` → the Aave v3 Pool — and **both validated cleanly**. Review every row:
if it is not the same protocol, add a `reserved` entry. Eight slugs were closed
this way on 2026-08-21 (`sparkdex-*`, `fluid-dex`, `fluid-lite`, `velodrome-v3`,
`beets-dex-v3`, `origin-arm`, `compound-v2`, `venus-flux`), none of which had
resolved yet — but relying on the validator to keep catching them is relying on
luck, which is precisely what `aave-v4` ran out of.

**2. `Discovery health … << DARK`**
A source that answered nothing across every lookup. Indistinguishable from "no
pools of ours" unless someone looks. A protocol-API source also now warns by
name when its endpoint returns nothing, or returns an error body with HTTP 200
(the GraphQL case).

**3. `Onboarding queue`**
What is still Manual, biggest TVL first, with the chains and example pools. This
is the worklist; take it top-down, but read the execution shape first — the
largest entry (`fluid-dex`, ~$16.8B) is an AMM, not a supply-side vault, so it
needs a new `kind`, not an extraction.

#### Traps that have already cost a session each (2026-08-21)

Every one of these looked like "this protocol has no coverage" and was
something else. Check them before concluding a protocol cannot be onboarded.

**It answers `symbol()` but it is not ERC-4626.** Vesper's `VPool` reverts on
`asset()`, `totalAssets()`, `maxDeposit()` and `convertToShares()` and answers
`token()` instead — the older `deposit(uint256)` / `withdraw(uint256)` shape.
Discovery found the right vault for 4 of 7 pools and the validator refused every
one, exactly as designed. Unlocking it needs a `vault-v2` execution kind, not a
discovery fix. **Probe `asset()` on one vault before writing the entry.**

**It is 4626 and a deposit still reverts.** Maple's `syrupUSDC`/`syrupUSDT` pass
every structural check and return `maxDeposit == 0` for anyone not allowlisted,
because the pools are permissioned. `validateErc4626` now probes `maxDeposit`
with an ordinary address and refuses a hard zero — a supply-capped vault is
caught by the same check, and correctly so, since the deposit really would fail.

**A bespoke resolver's own fetch is invisible to discovery health.** Those
counters only track registered `CandidateSource`s. `ydaemon.yearn.fi` publishes
a NAT64 `AAAA` record that Node's happy-eyeballs fails against while `curl`
succeeds; the fetch threw, the catch returned `[]`, and Yearn resolved 0/13 with
no signal anywhere. An empty registry now warns once, by name. If you add a
resolver that fetches its own list, warn on empty — do not rely on the health
table seeing it.

**DeFiLlama's `underlyingTokens` can disagree with the contract's `asset()`.**
Fluid Lite's ETH vault (~$170M) is real 4626 whose `asset()` is **stETH**, while
DeFiLlama publishes the native sentinel normalised to the zero address. Origin
is the same shape: `origin-ether` says `0x0` and `origin-dollar` says USDC,
while the deposit Origin wants is a Vault `mint(asset, amount, minimumAmount)`.
Both stay Manual, correctly. When a pool refuses despite an obviously right
vault, compare the row's underlying against `asset()` before assuming a bug.

**Ambiguity is often DeFiLlama's, not yours.** Curve LlamaLend labels two
distinct crvUSD markets `"sfrxUSD collateral"`, and IPOR ships two Base vaults
both named `"TAU cbETH Dynamic Looping"`. Fuzzy matching cannot fix a
non-unique label — find an exact key (LlamaLend joins on `controllerAddress`)
or accept the refusal. Do not loosen the uniqueness rule.

#### What you do NOT have to remember

The safety layers are not opt-in, so a wrong entry degrades rather than
endangers:

- a resolver that cannot be confident returns `null` → **Manual**
- `validateTarget` has **no** `default: return true` for EVM kinds, so a kind
  without a validator is rejected rather than trusted
- `matchVault` refuses to pick between siblings; ambiguity is a refusal
- the deposit-time safety pipeline (§11) runs regardless
- `protocol-manifest.spec.ts` fails CI on a duplicate slug, an alias two
  protocols both claim, an execution kind with no target kind, a non-pinned
  protocol with no discovery, or a withheld entry with no stated reason

**The worst outcome of a bad entry here is a pool that stays Manual.** Not funds
sent somewhere they should not go.

#### Reserved slugs, and why they exist

Found by the dry run on 2026-08-21: nothing claimed `aave-v4` exactly, so the
registry's substring fallback matched `aave` and every v4 pool resolved to the
**Aave v3 Pool** — and validated, because wstETH, WBTC and weETH are genuinely
listed v3 reserves. Five pools, ~$168M, all silently pointing at the wrong
protocol version. An exact claimant beats a substring one, so
`execution: { kind: "reserved" }` is the fix that uses the existing rule instead
of special-casing it. Reach for it whenever a protocol ships a new major version
we do not support yet.

### 11.6 Candidate addresses come from the protocol, not an aggregator

Turning a DeFiLlama pool UUID into an address used to go through exactly one
place: DeFiLlama's `/poolsOld`. When that moved behind a paid plan, **seven
resolver families silently stopped resolving anything** — a missing candidate is
indistinguishable from "this pool is not ours".

Candidates now come from `targets/candidates/registry.ts`, which tries the
protocol's OWN on-chain registry first (Euler's `GenericFactory`, Fluid's
`getAllFTokens`, Curve's MetaRegistry, a Solidly factory's `getPool`) and falls
back to `/poolsOld` only if one is reachable. Prefer adding an on-chain source
over relying on the fallback: it cannot be paywalled, cannot go stale, and is
the same trust model as the validator that runs immediately after.

The registry contract each source reads is **pinned** in
`address-book/registries.ts` under the same rule as any Pool or router — a
registry chooses which vault a deposit routes into, so whoever can swap the
registry can swap the destination.

### 11.6a Onboarding pass, 2026-08-21 — what the queue actually contained

A full sweep of the EVM onboarding queue, taken top-down. Recorded here because
the useful output was not the code: it was learning that **most of the queue is
not extractable, and each row is unusable for a different, specific reason.**
Anyone re-running this should read the refusals before repeating the work.

**Shipped (resolves today, on chains we have seeded):**

| Protocol | Shape | Where the address came from |
|---|---|---|
| `lido` (~$23.0B) | `lst-stake`, new `payable-submit-referral` shape | the stETH token IS the entry contract; DeFiLlama's own adaptor names it |
| `autofinance` (6 pools, ~$34M) | `erc4626` + `protocol-api` | `autopools-api.tokemaklabs.com/api/{chainId}/gen3` |
| `avantis` (~$18M) | `erc4626-pinned` | `ADDRESSES.base.AvantisVault` |
| `forty-acres` (~$7.2M Base) | `erc4626-pinned` | four constants in the adaptor |
| `lista-lending` (3 Ethereum vaults) | `erc4626` + `protocol-api` | `api.lista.org/api/moolah/vault/list` |
| `meth-protocol` (~$562M) | `lst-stake`, new `payable-stake-minout` shape | DeFiLlama's own `stakingAbi.json`, verified on chain |
| `kelp` (~$1.10B) | `lst-stake`, new `payable-deposit-eth-minout-referral` shape | Kelp's own registry, walked on chain: `pool.lrtConfig()` → `getContract(keccak("LRT_ORACLE"))` |

Lido had been Manual the whole time for a reason worth naming: the device has
shipped a complete Lido adapter (`services/defi/adapters/lido.ts`, submit +
withdrawal queue + claim) since Phase 1, but **`in_app` is driven by
`depositTarget`, not by whether an adapter exists.** No resolver claimed the
`lido` slug, so the largest pool in the entire catalog rendered as a deep link.
An adapter with no resolver is invisible.

**Refused, with the evidence, so nobody re-derives it:**

| Protocol | Why |
|---|---|
| `gains-network` | Real 4626, but `withdrawEpochsTimelock() == 3` — redeem needs a request and a three-epoch wait, and **neither exit probe can see it**. This is §11.3b's "one soft spot" occurring in the wild |
| `pareto-credit` | `AA_FalconXUSDC` is an Idle-lineage tranche token; `asset()` reverts |
| `zerobase-cedefi`, `bitway-earn` | Vault reverts on every 4626 selector; separate receipt / per-asset LP tokens |
| `native-credit-pool` | `totalUnderlying()` shape |
| `usd-ai` | Labelled "30d unlock" — an unreadable lockup, same failure mode as gains |
| `cian-yield-layer` | The only true discovery failure: CIAN's APY endpoints publish no vault address |
| `renzo` | `RestakeManager` has `depositETH()` and `depositETH(uint256)` — a stake shape we lack — plus a mint cap and a queue exit |
| `centrifuge-protocol` (~$1.19B) | ERC-7540 async. Reserved, not withheld, so no 4626 family answers for it |
| `avant` | Pinned, correct, deposits fine — and `redeem()` **reverts** with `OperationNotAllowed()` while `cooldownDuration` is 86400. Found by the fork run, after every structural check had passed |

**The pattern to take away:** of ten protocols investigated, exactly one was
blocked on finding an address. Discovery is mostly solved; **execution shape and
exit readability are what actually gate a protocol now.** Probe `asset()` and
then probe how the money gets OUT before writing an entry — an epoch-gated
redeem passes every structural check and still makes the card lie.

A third gate showed up once Morpho was measured properly (§11.6b): **`maxDeposit`
is doing more work than anything else in this system.** It is what refuses
Maple's syrup pools, every one of Morpho's 80 Vault V2s, and the $324.9M
`sirloinUSDC` that looked for a while like a coverage bug. When a large,
conforming, correctly-identified vault refuses, check `maxDeposit(<any
address>)` before assuming the resolver is at fault — a permissioned or capped
vault is a correct Manual, not a miss.

#### Sky, measured 2026-08-21: 2/14, and twelve correct refusals

`sky-lending` reads like a large gap and is very nearly not one. Recorded per
row so nobody re-derives it:

| Rows | Why they refuse | Verdict |
|---|---|---|
| ETH-A/B/C, WSTETH-A/B, WBTC-A/C (7 rows, ~$1.7B) | Maker **ilks** — CDP collateral types. The `underlyingTokens` is what you LOCK to borrow USDS, not something you supply for yield | Correct. Leveraged/borrow positions are a §1 non-goal |
| SKY Staking Engine (~$638M) | A different product; not a 4626 supply vault | Correct |
| Arbitrum + OP `sUSDS` (~$367M) | **Verified on chain**: answers `symbol()` → `"sUSDS"` and REVERTS on `asset()`, `totalAssets()`, `convertToShares()`, `maxDeposit()`. A bridged token, 160 bytes of code | Correct — and the exact §11.5c trap ("answers `symbol()` but is not 4626") |
| USDS "GROVE Farming Pool" (~$166M) | Its deep link names `0x4E41488C…`, whose `stakingToken()` is USDS and `rewardsToken()` is GROVE — a **Synthetix-style rewards farm**, not a vault. `asset()`/`totalAssets()` revert | Correct. A farm is `stake`/`getReward`, a different kind |
| STUSDS "Expert Mode" (~$204M) | Its deep link carries **no address at all** (`widget=expert&expert_module=stusds`), so no candidate source could ever answer for it | **SHIPPED** — see below. The address came from Sky's own on-chain registry instead |

Two things generalise. The GROVE row is another **"the link is the wrong
contract"** case (§11.5b): the deep link is real, official, and points at a
farm. Only Layer-1 validation stops it becoming a `tx.to`.

And the ilk rows are refused today only because the `sky` book happens to pin no
WETH/WBTC vault — `pinnedVaultResolver` has no `skipPool`. That is the
`aave-v4` reasoning exactly: it holds until someone pins a vault for one of
those assets, at which point a **borrow-side row would resolve into a supply
vault**. Worth closing before it bites.

#### stUSDS: when the deep link has no address, look for an on-chain registry

`stUSDS` (~$204M) was the only Sky row that was a real gap, and the reason is
worth generalising: **its deep link names no contract**, so every
candidate-source strategy in §11.5b is dead on arrival for it.

The answer was Sky's own **dss-chain-log** (`0xdA0Ab1e0…`), an on-chain registry
of 515 named addresses. `getAddress("STUSDS")` returns the vault. That is
better provenance than any deep link: it cannot be paywalled, cannot go stale,
and is the same trust model as the validator that runs immediately after
(§11.6). It also **cross-checks the existing book** — the same registry returns
`SUSDS` and `USDS` matching constants reviewed independently in the first
sign-off pass.

**Ask whether the protocol has an on-chain registry before concluding it has no
address source.** Maker/Sky, Kelp (`LRTConfig`), Euler (`GenericFactory`) and
Curve (MetaRegistry) all do.

##### It also needed the pinned book to hold two vaults over one asset

`pinnedVaultResolver` matched on `(chain, underlying)` and refused on anything
but exactly one candidate. Sky ships **both** `sUSDS` and `stUSDS` over USDS, so
naively pinning the second would have made the asset ambiguous and refused
BOTH — taking the ~$4.66B `sUSDS` pool down with it. A coverage change that
silently removes the largest pool in a family is the kind that gets noticed in
production.

The discriminator is the vault's own **ticker**, matched **exactly** against the
row's `symbol`/`poolMeta` and required to be unique. Deliberately not fuzzy:
bidirectional `includes()` on a shared symbol is what mis-routed 25 Morpho pools
(§11.6b), and `sUSDS` vs `stUSDS` is precisely the near-miss pair that would
feed on it. With one vault per asset the field is still not consulted at all, so
nothing else in any book changed behaviour.

##### The round trip returned MORE than went in, and that was correct

The fork case failed on an invariant that reads as obviously right: a round trip
must never return more than went in, or the withdraw took someone else's assets.

But a yield vault accrues every block and a round trip spans several. `stUSDS`
is the first vault here with a large enough balance and a real enough rate to
show it: **+6.8e12 wei on 1000 USDS, or 0.000068bp**, reproducible across runs.
The invariant now takes a `maxGainBps` (default 1bp — still ~15,000x the
observed accrual, so "drained a neighbour" remains impossible to slip through).

Two process notes from the same run. The first execution failed with a genuine
`redeem` revert that **did not reproduce**; re-running is the documented first
move for a fork failure, and it was the right one here. And a debug `console.log`
of a receipt threw `Do not know how to serialize a BigInt`, which read as a chain
revert and sent this investigation down a blind alley for a while — **simulate
with `eth_call` BEFORE sending** when you want a revert reason, and never infer
one from your own logging.

#### What the fork run changed (and why the dry run was not enough)

Six of the seven onboarded protocols were dry-run green before any fork test
existed. `services/defi/__fork__/onboarding.fork.test.ts` then executed the
bytes the DEVICE builds against forked mainnet, and the result was not a
formality:

- **Lido's new `payable-submit-referral` encoder works** — stakes ETH, mints
  stETH, no approval, and the queue-exit refusal fires. That is the only new
  calling convention in the pass, so it is the one thing a unit test could not
  have covered.
- **Avant failed, and had to be withheld.** Deposit succeeded; the MAX withdraw
  reverted with `OperationNotAllowed()` (`0xf50a3b52`). savETH follows Ethena's
  `StakedUSDeV2` pattern: while `cooldownDuration != 0`, `withdraw`/`redeem`
  revert outright and the only exit is `cooldownShares()` → wait → `unstake()`.
  Every earlier signal said ship it — the vault is conforming 4626, and because
  `cooldownDuration()` is readable the exit probe reported an honest `delayed`.
  **An honest label on a button that always reverts is still a broken button.**
  That is why §11.2 asks for a ROUND TRIP and not a deposit.
- **Four cases failed on a copied assertion, not a bug.** The Tier-1 helper
  asserts the round trip returns all but 2 units, which is true of sDAI and of
  nothing that charges to leave. Measured at the pin: 40 Acres 0.0008bp (pure
  4626 rounding), Auto Finance 1.3–5.3bp, **Avantis ~50bp**. The helper now
  takes a `maxLossBps` per case, so an exit fee is recorded rather than
  absorbed, and a vault that starts charging 10× fails.

The generalisable one: **`readExitTerms` answers "how long", never "will this
call succeed".** Any cooldown-convention vault (Ethena, Avant, and whatever
copies them next) deposits cleanly and cannot be exited by the generic 4626
adapter. Probe the exit by EXECUTING it.

#### Fork hygiene: pin near the head, and let the pin complain

A fork is only evidence if it resembles the chain people are actually
depositing into.

- `FORK_BLOCKS` (23,000,000 / 28,000,000) stays put — every existing case is
  reproducible there, and moving it silently re-dates results nobody
  re-checked. It is also **too old for new protocols**: Avant's `savETH` and
  Tokemak's `baseUSD` have zero code at those blocks.
- `FORK_BLOCKS_RECENT` is the near-head pin for newly onboarded families,
  set a few hundred blocks behind the head **at the time it was set**. Close
  enough to be representative, far enough back to survive a reorg and an
  archive endpoint's indexing lag.
- **The harness now tells you when a pin has aged**: `warnIfPinIsStale` reads
  the upstream head and warns past roughly a day of blocks (7,200 Ethereum /
  43,200 Base), because a pin that quietly drifts is a suite quietly testing
  history. Same idea as the dry run's `<< DARK` line.
- `FORK_BLOCK_<chainId>=N` forks any block without editing code. Still a
  number, never `latest`, so the run stays reproducible.
- `FORK_LATEST=1` exists and still warns loudly. Use it to ask "does this work
  against the chain right now"; do not use it as evidence a family is safe.

One environment fact to add to the three already in §11.7: **anvil's fork
bootstrap fails on a transient upstream hiccup** (`failed to get fork block …
connection closed`) and the harness's retry only covers port collisions. A Base
run that dies at startup is usually worth simply re-running before
investigating.

#### The substring report caught this session's own mistake

Worth recording because it is the check working on a hole opened five minutes
earlier, not an inherited one. The `lista-lending` entry shipped with a bare
`"lista"` alias, and the next dry run said:

```
  lista-cdp                          served by: lista-lending
  lista-liquid-staking               served by: lista-lending
```

Both are different products — a CDP that mints lisUSD, and slisBNB liquid
staking — and neither is a curated 4626 supply vault. Fixed twice over: the
bare brand alias is gone (nothing in the feed uses a plain `lista` slug, so it
bought nothing), and both look-alikes are now `reserved`.

**Never give a family a bare brand alias.** `lista`, `spark`, `origin`, `venus`
are product LINES, not protocols, and a one-word alias makes every future
product in that line resolve to whichever one shipped first.

#### The slipstream mis-claim

`aerodrome-slipstream` and `velodrome-slipstream` were **explicit aliases** of
the Solidly-fork families — worse than the substring fallback, because the
family asserted it handled them. Slipstream is the concentrated-liquidity
generation: a position needs a tick range, and the Router `addLiquidity` the
adapter builds addresses the v2 pair instead. 11 Aerodrome pools (~$139M) were
Manual only because a CL pool has no `stable()` for `readPoolIdentity` to read.
`velodrome-v3` had already been reserved for exactly this; the slipstream slugs
were missed. Both are now `reserved`.

**When reserving a slug, grep the resolver ALIAS lists too**, not just the dry
run's substring report — the report cannot flag a claim the family made openly.

#### The address-book collision check needed widening

`address-book.spec.ts` pinned a vault's underlying with a per-family owner, so
"two protocols hold a vault over Base USDC" read as a copy-paste between books.
40 Acres and Avantis were the first pair to collide, and the pairing is
completely normal. Underlyings now share one owner, the same carve-out the
Chainlink feeds already had; vault-to-vault and vault-to-underlying collisions
are still caught.

#### Chains are the binding constraint, not resolvers

Measured against the live feed: **BNB Chain and Avalanche resolve 0 of 27
pools (~$1.6B)** purely because neither has a `Blockchain` row. That is not a
resolver gap — `AAVE_V3_POOLS` already pins both, Venus and Benqi have their
Comptroller sources, and `lista-lending` resolves its Ethereum vaults through
the same API that serves its 11 BNB ones. Optimism is the same story for the
40 Acres OP vault. Per §11.1 those are a seeded row plus an rpc-proxy route,
and the resolvers light up with no further code change.

> **Re-confirmed 2026-08-21, because this keeps being read as a worklist.**
> `venus-core-pool` (0/23, ~$1.23B), `benqi-lending` (0/5), `benqi-staked-avax`,
> `lista-cdp`, `lista-liquid-staking` and the BSC/Avalanche `aave-v3` rows need
> **no resolver, no adapter and no address**. Venus's BSC Comptroller
> (`0xfD36E2c2…`), Benqi's Avalanche Comptroller (`0x486Af395…`) and both Aave
> v3 Pools are already pinned and reviewed; `VenusResolver`, `Venus4626Resolver`
> and `BenqiLendingResolver` are all registered and claim the slugs exactly.
> There is nothing to build. Seed the two rows and they resolve.
>
> As of the drift fix above, those pins are also **verified on chain every drift
> run**, ahead of the seed rather than after it.

### 11.6c Compound III: a resolver with a chain's markets half-pinned reads as a family half-working

Measured 2026-08-21, chasing why `compound-v3` refused ~$824M of WBTC/wstETH
pools on Ethereum despite the family being live and the same resolver already
serving cUSDCv3/cWETHv3/cUSDTv3 cleanly. `CompoundV3Resolver` iterates every
`COMET_MARKETS[chainId]` entry and validates `baseToken()` against each — so a
missing market reads exactly like the family failing, when it is really the
`address-book/` entry being incomplete.

`compound-finance/comet`'s own `deployments/<chain>/` directory listing is the
full answer, the same shortcut §11.5b describes for other families: Ethereum
mainnet ships SIX markets (`usdc`, `usds`, `usdt`, `wbtc`, `weth`, `wsteth`);
this book had three. Base ships five (`aero`, `usdbc`, `usdc`, `usds`, `weth`);
this book had three. Arbitrum's four were already complete — worth checking
before assuming every chain has the same gap.

**Check a family's book against its own deployment list, not just against
which of its markets happen to have a DeFiLlama pool already.** Base's two new
markets (`aero`, `usds`) have no pool yet — pinned anyway, so the resolver
claims either the moment DeFiLlama indexes it, with zero further code.

### 11.6d Fluid Vaults share the `fluid-lending` slug with Fluid's lending fTokens

`fluid-lending`'s Ethereum rows include `SUSDAI`, `WBTC`, `REUSD`, `PST`,
`WEETH`, `WEETHS`, `CBBTC`, `PAXG`, `WSTUSR`, `XAUT`, `TBTC`, `SUSDE` — none of
which match any of the seven addresses `LendingResolver.getAllFTokens()`
actually returns (`fUSDC`, `fWETH`, `fUSDT`, `fwstETH`, `fGHO`, `fsUSDS`,
`fUSDtb`). All refuse, correctly: they are collateral rows from **Fluid
Vaults** — Instadapp's separate leveraged-borrow product — sharing the
`fluid-lending` DeFiLlama slug with the plain lending markets. `getCode` on
Fluid's `VaultResolver.getAllVaultsAddresses()` confirms real vault-shaped data
sits behind these symbols.

Same category as Sky's CDP ilks and Curve LlamaLend's borrow-side rows: a
leveraged/collateral position is a §1 non-goal, not a discovery bug. Fluid's
own `ETH` rows (asset = native sentinel vs `fWETH`'s real WETH `asset()`) are
the already-documented fluid-lite mismatch, occurring again under a different
slug. Nothing here needed a code change — only recognising the shape before
spending time on it.

### 11.6b Morpho: measured 2026-08-21, and a live mis-route found

Two things were established by measurement rather than reasoning, and both
contradicted a confident prior. **Read this before touching the Morpho
resolver** — the obvious improvements have already been tried and reverted.

#### Morpho Vault V2 is invisible to us, and it does not matter yet

`erc4626.resolver.ts` queries `vaults(...)`. Morpho's schema also has a
**separate `vaultV2s` / `vaultV2ByAddress` type**, so every Morpho Vault V2 is
structurally unreachable — which is why a $324.9M vault looked like it was "not
in Morpho's API at all" until someone asked the right question.

Before building that path, it was measured. 273 morpho-blue pools on chains the
directory can reach, TVL ≥ $1M:

| | count |
|---|---|
| deep link carries no single address (market rows — a 32-byte market id, correctly rejected by the boundary regex) | 140 |
| deep link is not a Morpho vault at all | 53 |
| **confirmed Vault V2** | **80** |
| └─ **depositable** | **0** |
| └─ `maxDeposit == 0` (caller-gated) | 80 |

**All 80 refuse a deposit.** Verified as a genuine zero rather than a revert
miscounted as one: eight were re-probed by hand across both chains and a 500×
TVL range ($542.8M down to $1.2M), and every one answers `totalAssets()` and
`convertToShares()` normally while returning `maxDeposit(<ordinary address>) ==
0`. Morpho V2 vaults are caller-gated, the same shape as Maple's syrup pools —
and `validateErc4626`'s `maxDeposit` gate would refuse all 80 even if the
resolver could see them.

**So do not build the V2 path for coverage.** It resolves zero pools today. If
it is ever built, make it an ADDRESS-keyed lookup (`vaultV2ByAddress` on the
deep-link candidate), never a list fetch: V2 vaults are permissionlessly
deployable and `vaultV2s` on Base returns 200+ entries including `Test`,
`SDFSDF` and dozens unnamed, all with `asset: USDC`. Merging that into the
candidate set makes every USDC label ambiguous, and ambiguity is a refusal — it
would *reduce* coverage while adding mis-match risk.

#### The real finding: 25 pools, ~$478M, deposit into the wrong vault

Cross-referencing those 80 against what actually resolves:

**25 of the 69 resolving Morpho pools route to a different vault than the pool
row describes.** Worked example, Ethereum `STEAKUSDC`, whose DeFiLlama row says
$92.0M:

| | picked by label (V1) | named by DeFiLlama's deep link (V2) |
|---|---|---|
| name | Steakhouse **USDC** | Steakhouse **Prime** USDC |
| `totalAssets` | **$75.0M** — 18% off the row | **$93.9M** — 2% off the row |
| `maxDeposit` | open | 0 |

The row is about the Prime vault; the deposit goes into a different Steakhouse
vault. Corroborated by the matcher collapsing distinct products onto shared V1
vaults: `0xbeefff2092…` serves both `BBQUSDC` and `GROVE-BBQUSDC`,
`0x2371e134e3…` serves both `GTWETHP` and `GTWETHB`.

**The safety net does not catch this.** `asset()` matches — both are USDC
vaults — and the TVL band tolerates an 18% gap. This is the `spark-savings →
SparkLend` class one level down: same brand, same asset, different product,
different APY, different risk.

Root cause is ordering. `labelMatches` is bidirectionally fuzzy
(`hay.includes(needle) || needle.includes(hay)`), so `3F-steakUSDC` matches
plain `steakUSDC`; and `pickByCandidateAddress` — which knows the exact address
the protocol's own deep link names — only runs as a FALLBACK after the label
pass has already produced a wrong answer.

**The fix is to try the address BEFORE the label.** An address is a far stronger
identity claim than a shared symbol, and §11.5b already says the deep link
"only ever selects, never supplies". Reversing the order fixes both halves: a
mis-routed pool goes to the vault its row names, and a pool naming a gated V2
vault correctly becomes Manual.

**It costs coverage, and that is the point.** Morpho is expected to drop from
~69 to ~44 resolving pools, because most of those 25 rows point at V2 vaults
that will not accept a deposit. That is ~$478M moving from apparent coverage to
honest Manual.

**APPLIED 2026-08-21.** `claimByCandidateAddress` replaces
`pickByCandidateAddress` and returns three states rather than two — the missing
one being `"unvouched"`: *the protocol named an address, and it is not one of
our candidates*. That is now a refusal instead of an invitation for the label
matcher to have a second opinion. Applied to **Morpho and Yearn** both; Yearn
needs it more, since its rows carry `poolMeta: null` and `symbol` = the ASSET
("USDC") while mainnet has four distinct USDC vaults, so the label there is
nearly worthless.

Pinned by three tests in `evm-resolvers.spec.ts` ("deep-link address outranks
the label"): the link wins over an ambiguous label, an unvouched link refuses
outright, and a pool with NO link still falls back to labels — that last one
matters, because "no address available" and "an address that contradicts the
label" are different situations and only the second is a refusal.

**Re-measured 2026-08-21 (post-fix): 53 resolved of 330 rows at TVL ≥ $1M**,
of which ~291 are on chains the directory can reach (Ethereum 207, Base 54,
Monad 17, Arbitrum 12, Polygon 1; the rest are Katana / Hyperliquid / Robinhood
/ Tempo / Stable / OP, which have no `Blockchain` row). The prediction above
was "~69 down to ~44", so the address-first reorder cost less coverage than
expected while doing what it was for. The feed also grew — the earlier
measurement saw 273 reachable rows against ~291 now — so the two counts are
close but not the same denominator.

Do not read the ~277 refusals as a backlog. The four §11.3a oracle reasons, the
80 caller-gated Vault V2s and the `maxDeposit == 0` gate account for the bulk
of them, and each is a decision rather than a gap.

#### Two matching changes that were tried and REVERTED

Both were plausible, both were measured, both are recorded so nobody re-derives
them:

- **`listed` as a preference rather than a hard filter** (+8 pools). Morpho's
  `listed` is a UI-curation flag, not a risk property, and §12 Q1 says the
  on-chain validator is the verification for a discovered vault. But the case
  that motivated it — `sirloinUSDC`, $324.9M — turned out to be a **correct**
  refusal (`maxDeposit == 0`), and widening the candidate set enlarges exactly
  the pool of same-symbol namesakes that the mis-route above feeds on. Base has
  a $10K `sirloinUSDC` sitting next to the $325M one.
- **Exact-normalised label match before the fuzzy one** (+2 pools). Sound in
  isolation, but it only gained 2 because the fuzzy matcher was mostly
  *succeeding wrongly* rather than refusing — which is the mis-route, not a
  coverage problem.

Neither is wrong on its own terms. Both are the wrong thing to do **first**:
tuning the label matcher while the address is available and unused is
optimising the weaker signal. Do the address-first reorder, re-measure, and
only then decide whether either of these still earns its place.

#### mETH: the min-out shape, and what actually blocked it

`meth-protocol` (~$562M) sat in `LST_VENUES_DEFERRED` because
`stake(uint256 minMETHAmount)` takes a caller-supplied minimum. The note said
that needed "the slippage policy wired into the stake shape plus a verified
preview view", and only the second half turned out to be the work: the policy
already existed in `services/defi/slippage.ts`, serving Curve, Solidly and
Balancer. **The blocker was never the min-out, it was having a quote to derive
the floor from.**

`ethToMETH(uint256)` is that quote, on the Staking contract itself. Verified on
chain 2026-08-21 alongside the rest: `stake`, `ethToMETH`, `mETHToETH` and
`unstakeRequest(uint128,uint128)` all present in the implementation behind
`0xe3cBd06D…`; `totalControlled()` reads 237,128 ETH, matching DeFiLlama's TVL;
`minimumStakeBound()` is 0.02 ETH.

Three things a future min-out venue should copy:

- **LST/native is a CORRELATED pair**, so it draws the `stable` slippage budget
  (25bp conservative / 50bp balanced), not the volatile one. Using the wrong
  branch is invisible until someone is sandwiched.
- **A zero quote is a refusal, never a `stake(0)` fallback.** §12 Q4 forbids a
  zero minimum outright, and the adapter throws instead — asserted in both the
  unit and fork suites.
- **Declare the on-chain minimum** (`minStakeWei`). Catching a sub-minimum
  stake in the adapter costs the user nothing; letting it reach the chain costs
  them gas for a guaranteed revert.

**Kelp rsETH shipped on 2026-08-21 and it was not quite a config row.** The
preview view confirmed immediately — `getRsETHAmountToMint(0xEeee…, 1e18)`
reads 927271688944689890, and `getTotalAssetDeposits` matches DeFiLlama's TVL —
but two things made it a new shape rather than a reuse of `payable-stake-minout`:

- the referral is a **string**, not an address, so the calldata is head+tail
  encoded and the min-out is the first word rather than the only one;
- the preview view takes `(address asset, uint256 amount)`, and the asset it
  wants is the `0xEeee…` **native sentinel** — the zero address reverts
  (`0x762798e1`). A mocked unit test would never have shown that.

Both are declared as config (`previewTakesAsset`, and a `MIN_OUT_STAKE_SHAPES`
set) rather than branched on, for the reason the `getPooledAvaxByShares`
name-branch already taught: a literal comparison is correct right up until a
second venue shares the convention. **Generalise the moment there are two.**
Missing one of those sets is quiet in the worst way — `buildDeposit` builds
with `minOut: undefined`, the encoder refuses, and a correctly configured venue
looks broken. The fork run caught it; nothing else would have.

**Its valuation view is the trap worth copying down.** `getRsETHAmountToMint`
is the MINT direction. Using it as the rate view would have been backwards
*and* the wrong arity, so it would have reverted, been swallowed by the
existing `.catch(() => null)`, and silently valued 1 rsETH as 1 ETH — a ~7.8%
understatement with nothing anywhere to flag it. The right view is the
LRTOracle's `rsETHPrice()`, which reads 1.078433, **exactly the inverse of the
mint quote** — that inversion is the check that proves it is the rate. When a
venue's rate view lives on neither the entry nor the receipt, pin it
(`rateViewAt`) rather than reaching for whatever view the entry does expose.

**One name-branch removed on the way.** `lstStake.ts` decided whether a rate
view took an argument by comparing it to the literal string
`"getPooledAvaxByShares"` — a branch on one venue's function NAME, in the file
whose whole purpose is to be config-driven. mETH's `mETHToETH` is the second
view with that convention, so it would have been silently mis-valued. It is now
a declared `rateTakesAmount`, with `rateViewOn` alongside it because
`mETHToETH` lives on the Staking contract rather than on the receipt token.

### 11.7 Fork-test status

**31 cases, all passing** (2026-08-21) — 27 plus Kelp's three and Sky's stUSDS. Tiers 1-3 run at `FORK_BLOCKS`
(Ethereum 23,000,000 / Base 28,000,000); the onboarding suite runs at the
near-head `FORK_BLOCKS_RECENT` because two of its vaults did not exist at the
older pin. What each tier proved:

| Tier | Proven on a fork |
|---|---|
| 1 | ERC-4626 (sDAI) and Aave v3 deposit + `MAX` withdraw round trip; SparkLend executes through the SAME adapter with only a different pinned Pool, which is the §5.3b claim; a declared asset that contradicts the target's underlying is refused |
| 2 | Comet, cToken and Morpho Blue round trips — chosen because they cover the three ways a position is represented (the market IS the receipt / a separate exchange-rate receipt / shares inside a singleton). A Morpho params struct with one field altered cannot supply, which is §5.2's hole closed on-chain |
| 3 | Rocket Pool and ether.fi stake ETH and receive their receipt with NO approval; a queue-exit venue REFUSES an in-app withdraw (§12 Q2); an unpinned venue key refuses; Aerodrome's two-sided add emits BOTH approvals, each scoped to the router and never infinite |
| Onboarding (§11.6a) | Lido's new `payable-submit-referral` encoder stakes ETH and mints stETH with no approval, and refuses a queue exit; the pinned Avantis and 40 Acres vaults and two Auto Finance autopools round-trip within a MEASURED fee band; Avant deposits and then **cannot** be exited — `redeem()` reverts under cooldown, which is what withheld it |
| mETH min-out | `stake(minMETHAmount)` mints mETH against a floor the tier policy computed from `ethToMETH`, asserted non-zero **from the calldata** rather than from the helper that built it, and the contract honours at least that minimum; a sub-`minimumStakeBound` stake is refused before it reaches the chain |
| Kelp min-out | `depositETH(minOut, "")` stakes ETH and mints rsETH with no approval, against a floor read from `getRsETHAmountToMint` and asserted from the calldata; a sub-`minAmountToDeposit` stake is refused before the chain, and the **`MAX` withdraw is refused** because the exit is a queue (§12 Q2) — the assertion that would have caught Avant |

Passing here is necessary, not sufficient. It says the bytes are right and the
position moves. It does not say the pinned addresses have been reviewed (§12 Q7)
or that a family's economics suit the product.

Three environment facts the harness encodes, each found by a failing run rather
than by reading docs:

- `~/.foundry/bin` is not on a test runner's PATH.
- anvil 1.7.1's default `--hardfork latest` (Osaka) fails a plain `balanceOf`
  against forked mainnet state with `EVM error OpcodeNotFound`; it pins `prague`.
- vitest runs each test FILE in its own process, so a module-level port counter
  collides across workers. Ports are seeded from the pid and retried.

---

## 12. Turning a tier ON — requirements and how to test

> **Read this before flipping any `FEATURE_DEFI_EVM_TIER*` flag.** The flags
> default OFF and that is a deliberate gate, not an unfinished state. Everything
> below exists because turning one on routes real user funds to an address.

### 12.1 "It is off" does NOT mean "it cannot be tested"

The flags are env vars read at boot. Nothing is stubbed out, deleted or
compiled away — the resolvers, adapters and safety pipeline are all present and
fully exercisable. Turning a tier on for a test build is a config change.

**Both sides must be on, with the same family name.** A family live on one side
only is the failure the twin flags exist to prevent: the backend resolves a
target, the card badges "Deposit in-app", and the device has no adapter to build
it (§8.6).

| Side | Variable | Read by |
|---|---|---|
| Backend | `FEATURE_DEFI_EVM_TIER1/2/3` | `targets/feature-flags.ts` → `bootstrap.ts` registers resolvers |
| Mobile | `EXPO_PUBLIC_FF_DEFI_EVM_TIER1/2/3` | `constants/configs/featureFlags.ts` → `services/defi/bootstrap.ts` registers adapters |

Per-family sub-flags ride under each tier and default ON within an enabled tier,
so one family can be dark-launched or killed alone:
`FEATURE_DEFI_EVM_FAMILY_<NAME>` and `EXPO_PUBLIC_FF_DEFI_EVM_FAMILY_<NAME>`
(name upper-cased, non-alphanumerics → `_`; e.g. `compound-v3` →
`COMPOUND_V3`).

Tier 1 registers **no** mobile adapter by design — Family A routes to the
already-registered `Erc4626Adapter` and Family B to the Aave adapters — so its
mobile flag exists only so the two sides read symmetrically.

### 12.2 Testing on a device

1. **Backend**: set the tier flags, restart the API. `onApplicationBootstrap`
   fires a poll immediately, so `OpportunityCache.depositTarget` is populated
   within ~30s. Without a restart you wait out the 30-minute cron, because a
   resolver that was not registered at boot never wrote a target.
2. **Confirm the backend side first** with `pnpm defi:dry-run`. If a pool
   refuses there it will refuse on the device too, and debugging it on a phone
   is strictly harder.
3. **Mobile**: set `EXPO_PUBLIC_FF_DEFI_EVM_TIER*` in `.env`, then do a **full
   reload** of the app (shake → Reload, or `r` in the Metro terminal).

   This is a **JavaScript-only change — no native rebuild.** The flags gate
   nothing but `registerDefiAdapter` calls. Two details decide what is enough:

   - `EXPO_PUBLIC_*` is *inlined at bundle time*, not read at runtime, so the
     bundle has to be re-served. Expo CLI re-reads `.env` on the fly:
     [the docs](https://docs.expo.dev/guides/environment-variables/) say
     variables "can be updated as you edit your code **without restarting the
     Expo CLI or clearing the cache**", but you "need to perform a full reload
     … to see the updated value". So: no `--clear`, no dev-server restart.
   - **Fast Refresh is not enough.** `featureFlags.ts` reads `process.env` at
     module scope and `bootDefi()` registers adapters once at startup; Fast
     Refresh re-runs neither. A *full reload* re-executes the bundle and does.

   For a build that already has the bundle baked in (production, EAS, the store
   build), ship the change as an **EAS Update** — still no native rebuild — or
   make a new build.

   If behaviour still looks stale after a full reload, force-stop
   (`adb shell am force-stop com.planckify.takumiwallet`) and relaunch. That is
   the belt-and-braces step for module-scope state, not a routine requirement;
   see `docs/prototype-freeze-crash-retrospective.md` for the case that made it
   a habit.
5. **Check the chain is enabled for DeFi**: `DEFI_ENABLED_CHAIN_IDS` is separate
   from "the chain is supported". Empty means all directory chains are allowed.

**A device test spends real money.** Every address in the address book is a
mainnet deployment, so there is no testnet path for these families. Two options:

- **Small amounts on mainnet.** Simplest, and what the amounts in the fork tests
  are sized after.
- **Point the device at a fork.** Run `anvil --fork-url … --host 0.0.0.0`, and
  repoint the chain's provider row in `rpc-proxy` at it. The device then signs
  against fake state with real calldata. More setup, but nothing at risk, and it
  is the only way to rehearse a failure path (a revert, a paused market) safely.

### 12.3 Requirements before a tier goes on in PRODUCTION

A test build needs only §12.2. Production needs all of the following. They are
ordered so that failing an earlier one makes a later one meaningless.

| # | Requirement | How it is evidenced | Who signs off |
|---|---|---|---|
| 1 | The family actually resolves | `pnpm defi:dry-run` shows resolved pools for that project, not all refusals | Engineer |
| 2 | Pinned addresses match the deployments | `DRIFT_CHECKS=1` address-book drift green for the family's chains | Engineer |
| 3 | External APIs still have the shape we send | `DRIFT_CHECKS=1` external-API drift green | Engineer |
| 4 | The calldata the DEVICE builds moves the position | Fork tests green for the tier **at a pinned block** (§11.7) | Engineer |
| 5 | Every pinned address reviewed | Diff review of `address-book/` against each protocol's own docs, cross-checked against a second official source (§12 Q7, `address-book/README.md`). **Procedure + standing record: `docs/runbooks/defi-address-book-security-signoff.md`** | **Security** |
| 6 | The family has no open blocker | Not listed in §11.2's deliberately-off table | Engineer |
| 7 | Exit path is honest | A queue/DEX-exit venue must not offer an in-app withdraw (§12 Q2) | Product + Engineer |
| 8 | Ops can turn it off | `DEFI_FAMILY_KILL_SWITCH` understood and reachable without a deploy | Ops |
| 9 | **A human ran it end to end** | See below | **Engineer + Product** |

Requirement 5 is the one that cannot be automated and the one most likely to be
skipped. A green fork test proves the bytes are right; it says nothing about
whether the address they are sent to is the contract we believe it is. Only a
human comparing the book against the protocol's own documentation closes that.

**It has now been run once, and it earned its place.** The 2026-08-21 pass over
all 125 pinned addresses found **six** problems. Three were wrong addresses —
Ethereum `cWETHv3` pointing at an address with **no code**, Radiant pointing at
a reverting pool for a protocol that is **winding down**, and Origin `wOUSD`
pointing at **Origin's governance token** — and all three were fail-closed, so
no test, dry run or checksum guard could have surfaced any of them.

The other three came from running the on-chain drift spec for the first time,
and two of those were **not** fail-closed: the Pendle router allowlist accepted
a codeless `to` on five chains, and Curve read the **wrong registry** on Polygon
(an active "Cryptopool Factory") which answered successfully instead of
reverting. The sixth was a provenance gap (Avantis) since closed.

All six are fixed; drift went 13 → 0. Findings, evidence and the corrections:
**`docs/runbooks/defi-address-book-security-signoff.md`**.

#### Requirement 9 — the end-to-end human test

Automated coverage stops at "the bytes are right". Nobody has confirmed a USER
can complete the journey until a person does it on a real build, on mainnet,
with their own funds. Small amounts, but real ones: a testnet fork cannot
reproduce a paused market, a fee-on-transfer token, an approval that needs
resetting to zero, or a wallet that simply has no gas.

Run the whole loop for at least one pool in the family:

- [ ] The pool appears with the **"Deposit in-app"** badge, not Manual
- [ ] The approval card states the **real facts** — amount, asset, protocol,
      chain — and for a non-instant exit, the **lockup** (§12 Q2a). Facts come
      from tool args, never model prose
- [ ] Deposit succeeds and the transaction confirms
- [ ] The **position appears** with a sane value and APY, and survives an app
      restart
- [ ] **Partial withdraw** returns funds to the wallet
- [ ] **`"MAX"` withdraw** empties the position, dust ≈ 0
- [ ] A queue/DEX-exit venue **refuses** the in-app withdraw with honest copy
      rather than failing (§12 Q2)
- [ ] Nothing in the UI shows raw error text at any point (see CLAUDE.md)

Record who ran it, on which chain, with which pool, and the two transaction
hashes. "The fork test was green" is not an answer to requirement 9.

### 12.4 What is still blocking, as of the last review

| Blocker | Affects | Owner |
|---|---|---|
| Address-book security sign-off (req. 5) — **run 2026-08-21; 125/125 signed off, all 6 findings closed, on-chain drift 13 → 0.** Needs only a named counter-signature | **all tiers** | Security |
| `address-book-drift.spec.ts` is **not scheduled anywhere** — it already encodes the check that would have caught the `cWETHv3` bug, but its first-ever run was during the sign-off. It is green now, so scheduling starts from a clean baseline | all pinned families | Ops |
| Avantis `avUSDC` withdrawals **revert above 90% utilization** — `instant` is honest today (~9.4%) but the exit copy must not promise an unconditional MAX withdraw | `avantis` | Product |
| Morpho oracle/IRM allowlist is empty | Morpho Blue direct markets — every one refuses by design until oracles are reviewed | Risk |
| `BalancerQueries` not pinned | `balancer-lp` — cannot price `minimumBPT`, and a zero minimum is a silent sandwich | Engineer + Security |
| Curve classic pools refuse | `curve-lp` on non-NG pools — needs `lpToken` on the shared union | Engineer |
| Router-quote proxy not integration-tested against a live quote | `router-call` (Pendle) | Engineer |
| Two-phase request/claim not proven end to end | Tier 4 (`async-vault`), Convex/Aura | Engineer |
| DeFiLlama `/poolsOld` paywalled | Families with no on-chain registry source yet — set `DEFILLAMA_PRO_API_KEY` or add a source | Ops or Engineer |

Tiers 1–3 have cleared requirements 1–4. They are **not** cleared for production
until requirement 5 lands — which now means: apply the three address
corrections, resolve Radiant and Avantis, and get the sign-off log in
`docs/runbooks/defi-address-book-security-signoff.md` §7 countersigned by a
named human.
