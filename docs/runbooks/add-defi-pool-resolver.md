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
>   the one most likely to be skipped.
> - **What is still blocking**: §12.4.

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
  endpoint(s) and where the on-chain address lives. It's MIT-licensed;
  mirror the fetch logic.

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
| `balancer-lp` | Its single-asset join needs a reviewed `BalancerQueries` deployment to price `minimumBPT`. A zero minimum is a **silent** sandwich, not a revert. |
| `router-call` (Uniswap v3/v4) | A concentrated-liquidity position needs a tick range — a different product decision from "supply this asset". Pendle ships; Uniswap waits for that UX. |
| `async-vault` (ERC-7540) | §7: no resolver until the two-phase request→claim flow is proven end to end. The kind, validator, adapter and claim-watcher exist; the resolver is the last piece. |
| Convex / Aura | Boosting is a two-leg flow (acquire the LP, then stake it) that one-shot `UnsignedCall` cannot express. Ships on the Tier-4 two-phase machinery. |
| Avalon (Aave fork) | One `Pool` per market, so there is no single address to pin. Its book is empty on purpose. |
| Curve classic pools | `curveLp.ts:lpTokenOf` returns `target.pool`, i.e. it assumes the pool IS its LP token. True for Curve NG, false for the classic pools (3pool mints a separate ERC-20). The resolver now refuses a pool that is not its own LP token, so classic pools fail closed to Manual. Supporting them means adding `lpToken` to the shared union — a change to both repos and the parity test. |
| Kelp, Mantle mETH, StakeWise, cbETH, LsETH, LBTC | Each needs either a caller-supplied min-out with a verified preview view, a permissionless mint that doesn't exist, or a non-EVM deposit path. Listed in `address-book/lst.ts` as `LST_VENUES_DEFERRED`. |

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

### 11.7 Fork-test status

Run against Ethereum block 23,000,000 and Base block 28,000,000 (`FORK_BLOCKS`),
16 cases, all passing. What each tier proved:

| Tier | Proven on a fork |
|---|---|
| 1 | ERC-4626 (sDAI) and Aave v3 deposit + `MAX` withdraw round trip; SparkLend executes through the SAME adapter with only a different pinned Pool, which is the §5.3b claim; a declared asset that contradicts the target's underlying is refused |
| 2 | Comet, cToken and Morpho Blue round trips — chosen because they cover the three ways a position is represented (the market IS the receipt / a separate exchange-rate receipt / shares inside a singleton). A Morpho params struct with one field altered cannot supply, which is §5.2's hole closed on-chain |
| 3 | Rocket Pool and ether.fi stake ETH and receive their receipt with NO approval; a queue-exit venue REFUSES an in-app withdraw (§12 Q2); an unpinned venue key refuses; Aerodrome's two-sided add emits BOTH approvals, each scoped to the router and never infinite |

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
| 5 | Every pinned address reviewed | Diff review of `address-book/` against each protocol's own docs, cross-checked against a second official source (§12 Q7, `address-book/README.md`) | **Security** |
| 6 | The family has no open blocker | Not listed in §11.2's deliberately-off table | Engineer |
| 7 | Exit path is honest | A queue/DEX-exit venue must not offer an in-app withdraw (§12 Q2) | Product + Engineer |
| 8 | Ops can turn it off | `DEFI_FAMILY_KILL_SWITCH` understood and reachable without a deploy | Ops |

Requirement 5 is the one that cannot be automated and the one most likely to be
skipped. A green fork test proves the bytes are right; it says nothing about
whether the address they are sent to is the contract we believe it is. Only a
human comparing the book against the protocol's own documentation closes that.

### 12.4 What is still blocking, as of the last review

| Blocker | Affects | Owner |
|---|---|---|
| Address-book security sign-off (req. 5) | **all tiers** | Security |
| Morpho oracle/IRM allowlist is empty | Morpho Blue direct markets — every one refuses by design until oracles are reviewed | Risk |
| `BalancerQueries` not pinned | `balancer-lp` — cannot price `minimumBPT`, and a zero minimum is a silent sandwich | Engineer + Security |
| Curve classic pools refuse | `curve-lp` on non-NG pools — needs `lpToken` on the shared union | Engineer |
| Router-quote proxy not integration-tested against a live quote | `router-call` (Pendle) | Engineer |
| Two-phase request/claim not proven end to end | Tier 4 (`async-vault`), Convex/Aura | Engineer |
| DeFiLlama `/poolsOld` paywalled | Families with no on-chain registry source yet — set `DEFILLAMA_PRO_API_KEY` or add a source | Ops or Engineer |

Tiers 1–3 have cleared requirements 1–4. They are **not** cleared for production
until requirement 5 lands.
