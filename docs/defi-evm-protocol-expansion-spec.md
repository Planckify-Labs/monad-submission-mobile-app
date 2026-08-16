# DeFi EVM Protocol Expansion — Engineering Spec

**Status:** **Implemented 2026-08-15**, behind tier flags that default OFF.
Extends the shipped pool-level-deposits machinery to "as many EVM protocols as
possible", in four safety-ordered tiers.

> **What "implemented" means here.** Every tier's resolvers, adapters,
> validators and the full §11 safety pipeline are built, typechecked and
> unit-tested in both repos. Nothing is live: `FEATURE_DEFI_EVM_TIER1..4`
> (backend) and `EXPO_PUBLIC_FF_DEFI_EVM_TIER1..4` (mobile) all default to
> `false`.
>
> **Tiers 1–3 are now fork-tested** (§11.3 satisfied): 16 cases against
> Ethereum block 23,000,000 and Base block 28,000,000 execute real deposits and
> withdrawals with the calldata the DEVICE builds, and assert the position
> moved. See `docs/runbooks/add-defi-pool-resolver.md` §11.7 for what each tier
> proved and `services/defi/__fork__/` for the suite.
>
> **They are still not cleared for production**, because §12 Q7 requires
> security sign-off on every pinned address in
> `api/src/strategies/targets/address-book/` and that has not happened. A green
> fork test proves the bytes are right; it says nothing about whether the
> address they are sent to is the contract we believe it is.
>
> ➡️ **Before flipping any flag — for a device test or for production — read
> `docs/runbooks/add-defi-pool-resolver.md` §12.** It covers what a device test
> needs (both sides on, bundle rebuilt, app force-stopped), the eight
> requirements for production, and what is still blocking.
>
> Six families are additionally withheld with stated reasons (Balancer, Uniswap
> LP, async vaults, Convex/Aura, Avalon, six LST venues); see
> `docs/runbooks/add-defi-pool-resolver.md` §11.3.
>
> **Chain support is data-driven**: the supported-chain set comes from the
> `Blockchain` table through `api/src/strategies/targets/chain-directory.ts`,
> not from any map in code. Onboarding an EVM chain for DeFi is a seeded row
> plus an rpc-proxy route.
**Related:**
- `docs/defi-pool-level-deposits-spec.md` — the resolver → `DepositTarget` →
  adapter spine this builds on (§3.1 resolvers, §3.2 validation, §5 registry,
  §7 kind-routing, §8 LLM-never-handles-addresses). **Read that first.**
- `docs/defi-strategies-spec.md` — adapter interface, executors, scoring.
- `api/src/strategies/targets/*` — backend resolvers + on-chain validation.
- `mobile-app/services/defi/adapters/*` — mobile family adapters.
- Add-a-protocol runbook: `docs/runbooks/add-defi-pool-resolver.md`.

**Guiding invariant (inherited, non-negotiable):** adding a protocol is a new
one-file **resolver** + (only if a new `kind`) a new **family adapter** + one
`registerResolver(...)` / `registerDefiAdapter(...)` line. **Never** a `switch`
on `pool.project`. Resolvers **fail closed** — return `null` (→ manual
deep-link) whenever they cannot confidently resolve *and* on-chain-validate a
target. The LLM never supplies an address; the executor re-fetches the
server-resolved target by `pool_id` before signing (pool-level spec §6, §8).

---

## 1. Goal & non-goals

### Goal
Maximize the set of EVM DeFi pools a user (and the agent) can **deposit into and
withdraw from in-app**, safely and production-ready, by:
1. Widening the ERC-4626 funnel so more protocols route to the **existing**
   `Erc4626Adapter` with zero new execution code (Tier 1).
2. Implementing the `DepositTarget` kinds already declared in the union but
   never built — `compound-v3`, `morpho-blue`, `curve-lp` (Tier 2).
3. Adding the high-demand non-standard families behind a distinct
   router-calldata execution model (Tier 3).
4. Laying the interface for **asynchronous** (ERC-7540) vaults so RWA /
   withdrawal-queue pools are modeled correctly rather than badged as
   sync-and-failing (Tier 4).

### Non-goals
- Cross-chain zap routing (LI.FI) — unchanged, separate track.
- Supporting *every* DeFiLlama pool. We cover the **standards + families** that
  hold the bulk of TVL; the rest keep the honest **"Manual"** badge.
- Leveraged / borrow positions. This spec is **supply-side only** (deposit to
  earn, withdraw to exit). Borrow/collateral flows are explicitly out.
- Changing the scoring/ranking pipeline.

---

## 1.5 Protocols in scope — EVM catalog (DeFiLlama-derived)

**Method.** Snapshot of DeFiLlama `yields.llama.fi/pools` (2026-08-15), filtered
to EVM chains (Ethereum, Arbitrum, Base, OP, Polygon, BSC, Avalanche, Gnosis,
Linea, Sonic, Berachain, Mantle, Katana, Plume, Cronos, …), aggregated by
`project`, joined to category from `api.llama.fi/protocols`. TVL is the snapshot
figure (rounded), for **prioritization only** — never trusted at execution
time (§11). Coverage scales by **execution family**, so this is bucketed by
family; one resolver/adapter per family covers every listed protocol + its forks
+ every market on every EVM chain.

**Legend:** `[✓]` already shipped · `[T1]…[T4]` this spec's tier · `[docs]` the
official interface was verified for this spec (see Sources).

### Family A — ERC-4626 vaults → existing `Erc4626Adapter` (resolver-only)
| Protocol | ~TVL | Category | Status |
|---|---|---|---|
| Morpho (MetaMorpho vaults) | $10.5B | Lending | `[✓]` |
| Sky Savings (`sUSDS`) | $7.9B | CDP savings | `[T1]` `[docs]` |
| SparkLend savings (`sUSDS`/`sDAI`) | $1.07B | Yield | `[T1]` `[docs]` |
| Fluid lending (`fToken`, 4626) | $1.0B | Lending | `[T1]` `[docs]` |
| Concrete (capital allocator vaults) | $831M | Yield vault | `[T1]` (verify 4626) |
| Euler v2 (EVK evaults) | — | Lending | `[T1]` `[docs]` |
| Gearbox v3 (passive pools) | — | Lending | `[T1]` |
| Yearn v3 | $152M | Yield aggregator | `[✓]` |
| Venus (VenusERC4626 wrapper) | ⊂$1.07B | Lending | `[T1]` `[docs]` |
| Origin (`OUSD`/`OETH` wrappers) | — | Yield | `[T1]` |

### Family B — Aave-v3 pool & forks → existing `aave-v3` adapter (resolver-only)
Same `{kind:"aave-v3", pool, asset}` target; only the Pool address differs, and
the adapter/validator already read it from the resolved target.
| Protocol | ~TVL | Notes | Status |
|---|---|---|---|
| Aave v3 | $13.2B | canonical | `[✓]` |
| SparkLend | $4.2B | Aave-v3 fork; `spToken`; Pool via PoolAddressesProvider | `[T1]` `[docs]` |
| Zerolend / Avalon / Seamless / Radiant | — | Aave-v3 forks | `[T2]` |
| Aave v4 | $220M | **different interface** — defer | out (future) |

### Family C — Compound III (Comet) → new `compound-v3` adapter
| Compound III | $1.1B | `supply`/`withdraw(asset,amt)` | `[T2]` `[docs]` |

### Family D — Compound-v2 cToken forks → **new `compound-v2` adapter**
`mint(assets)` / `redeem(shares)` / `redeemUnderlying(assets)`, exchange-rate
shares. One adapter covers the whole fork lineage.
| Protocol | ~TVL | Notes | Status |
|---|---|---|---|
| Venus (core + isolated pools) | $1.07B | Compound-v2 fork (`vToken`) | `[T2]` `[docs]` |
| Benqi Lending / Sonne / others | — | cToken forks | `[T2]` |

### Family E — Morpho Blue isolated markets → new `morpho-blue` adapter
| Morpho Blue direct markets | ⊂$10.5B | `supply/withdraw(MarketParams,…)` | `[T2]` `[docs]` |

### Family F — Liquid staking / restaking (LST/LRT) → **new `lst-stake` family**
Native-ETH (or token) stake → rate-appreciating receipt. Deposit in-app;
**exit is often a withdrawal queue or via DEX** (see §7/§8.3 — some route to
Tier 4 async). Wrapped receipts that are ERC-4626 (e.g. `weETH`) can reuse
Family A instead.
| Protocol | ~TVL | Receipt | Status |
|---|---|---|---|
| Lido | $17.8B | `stETH`/`wstETH` | `[✓]` |
| Binance staked ETH | $6.9B | `wBETH` | `[T3]` |
| ether.fi | $3.9B | `eETH`/`weETH` | `[T3]` `[docs]` |
| Rocket Pool | $2.5B | `rETH` | `[T3]` `[docs]` |
| Kelp | $864M | `rsETH` | `[T3]` |
| Mantle mETH / Coinbase cbETH / StakeWise / Stader / Benqi sAVAX / Liquid Collective LsETH / Lombard LBTC | — | various | `[T3]` |

### Family G — DEX LP → Curve (`curve-lp`), Uni/Solidly/Balancer (`router-call`)
| Protocol | ~TVL | Model | Status |
|---|---|---|---|
| Curve | $1.38B | `add_liquidity`/`remove_liquidity_one_coin` | `[T2]` `[docs]` |
| Uniswap v3 / v4 | ~$1.9B | hosted-API calldata | `[T3]` `[docs]` |
| Aerodrome / Velodrome (Solidly) | — | Router `addLiquidity(stable/volatile)` | `[T3]` `[docs]` |
| Balancer v3 / Beets | $406M | Vault/Router | `[T3]` |
| Convex / Aura (LP boosting) | $444M | deposit LP → stake | `[T3]` (after Curve/Bal) |
| Pendle (LP + PT) | $371M | hosted-API calldata | `[T3]` `[docs]` |

### Family H — RWA / async & permissioned → ERC-7540 or Manual
Most are **KYC-gated or asynchronous** (request→claim). Model as `async-vault`
(§7) when ERC-7540-compliant; otherwise stay **Manual** (never badge in-app).
| Protocol | ~TVL | Note | Status |
|---|---|---|---|
| BlackRock BUIDL | $2.0B | permissioned | Manual/`[T4]` |
| Circle USYC | $3.0B | permissioned | Manual/`[T4]` |
| Centrifuge | $1.6B | ERC-7540 | `[T4]` |
| Ondo (USDY/OUSG) | $1.3B | mixed | `[T4]`/Manual |
| Usual (`USD0`/`USD0++`) | $514M | bond token | Manual |
| Maple (`syrupUSDC`) | $3.75B | permissionless RWA lending | `[✓]` |
| Midas / VanEck / Invesco / Superstate | — | permissioned | Manual |

### Already-shipped, unchanged
Lido `[✓]`, Aave v3 `[✓]`, Morpho MetaMorpho `[✓]`, Yearn v3 `[✓]`, Ethena
`sUSDe` `[✓]` ($1.4B), EigenLayer `[✓]`, GMX v2 `[✓]` ($157M), Maple `[✓]`, Curve
3pool `[✓]` (generalized by `[T2]`), plus the Sui/Solana adapter set.

> **Bottom line:** the catalog is **8 execution families** covering ~40 named
> protocols (and their forks) — but only **~7 adapters** total, because Families
> A/B/C/E are one adapter each and D/F/G add one family adapter apiece. Adding
> the next protocol in any family is a one-file resolver.

---

## 2. Standards reference (what each family actually is)

The single most important fact: **ERC-4626 is the only universal deposit/withdraw
ABI, and most protocols are not 4626.** EVM DeFi splits into execution families;
coverage is won family-by-family.

| Family | Primitive (official) | 4626? | Routes to | Tier |
|---|---|---|---|---|
| Tokenized vault | `deposit(assets,receiver)` / `redeem(shares,receiver,owner)` | ✅ | `Erc4626Adapter` (existing) | 1 |
| Aave-style pool | `supply(asset,amt,onBehalf,ref)` / `withdraw(asset,amt,to)` | ⚠️ aToken-ish | `aave-v3` adapter (existing) | — |
| Comet (Compound III) | `supply(asset,amt)` / `withdraw(asset,amt)` | ❌ | `compound-v3` adapter (**new**) | 2 |
| Morpho Blue market | `supply(MarketParams,…)` / `withdraw(MarketParams,…)` | ❌ | `morpho-blue` adapter (**new**) | 2 |
| Curve LP | `add_liquidity` / `remove_liquidity_one_coin` | ❌ | `curve-lp` adapter (**new**) | 2 |
| Router-calldata (Pendle, Uni v3/v4 LP) | protocol REST API returns calldata | ❌ | `router-call` adapter (**new**) | 3 |
| Async vault (ERC-7540) | `requestDeposit`→claim / `requestRedeem`→claim | ⚠️ 4626+ | `async-vault` adapter (**new**) | 4 |

**Approval standards.** Every EVM deposit needs the target `approve`d as spender
first — already modeled by `UnsignedCall.needsApproval` (an ERC-20 approve
preamble). Where the asset supports **ERC-2612 `permit`** (USDC, DAI, USDS, …)
or **Permit2**, an adapter *may* emit a permit signature instead of a separate
approve tx (§8.4). Not required for v1; approve-preamble is the safe default.

**Withdraw is where families diverge most.** `BuildWithdrawArgs.amount` is
`bigint | "MAX"`. Each family's `"MAX"` sentinel differs (§8.3). ERC-7540 breaks
the one-tx model entirely and needs the Tier 4 two-phase shape (§7).

---

## 3. Changes to the shared `DepositTarget` union

The union lives in **two** files that MUST stay in sync
(`api/src/strategies/targets/types.ts` and
`mobile-app/services/defi/types.ts`). Tier 1 adds **no** new kind (Euler/Spark/
Sky/Gearbox/Origin are all `erc4626`). Tiers 2–4 touch it as follows.

### 3.1 `morpho-blue` — CORRECTNESS FIX (blocking)

The **currently declared** `{ kind: "morpho-blue"; marketId: Hex }` **cannot
build a transaction.** Morpho Blue's `supply`/`withdraw` take the full
`MarketParams` struct, and `marketId` is `keccak256(abi.encode(marketParams))`
— a one-way hash you cannot invert on-chain. Replace it:

```ts
// MarketParams per Morpho Blue docs — the id is derived, not primary.
| {
    kind: "morpho-blue";
    /** keccak256(abi.encode(params)) — identity/validation only. */
    marketId: Hex;
    /** Full struct required to CALL supply/withdraw. */
    params: {
      loanToken: Address;      // the asset a lender supplies (== underlying)
      collateralToken: Address;
      oracle: Address;
      irm: Address;
      lltv: bigint;            // uint256 (1e18-scaled)
    };
    /** Convenience: == params.loanToken, the deposited asset. */
    asset: Address;
  }
```

The resolver fills `params` from the Morpho GraphQL API (§5.2) and MUST verify
on-chain that `keccak256(encode(params)) === marketId` before trusting it (§6).

### 3.2 `compound-v3` — already correct
`{ kind: "compound-v3"; comet: Address; asset: Address }` is sufficient: `comet`
is the market contract, `asset` is the base token supplied. No change.

### 3.3 `curve-lp` — clarify semantics
`{ kind: "curve-lp"; pool: Address; asset: Address; index: number }` — `index`
is the coin's position in the pool's `coins[]` array; `asset` is that coin.
Add an optional `nCoins` + `isNg` (new-generation vs legacy ABI) so the adapter
picks the right `add_liquidity` arity without an on-chain probe each build:
```ts
| { kind: "curve-lp"; pool: Address; asset: Address; index: number;
    nCoins: 2 | 3 | 4; isNg: boolean }
```

### 3.4 `router-call` (Tier 3) — new kind
Pendle / Uniswap LP don't have a stable on-chain deposit ABI we encode
ourselves; their **hosted API returns calldata**. Model the *identity* only;
calldata is fetched at execute time (§5.5, §7.3):
```ts
| { kind: "router-call"; protocol: "pendle" | "uniswap-v3" | "uniswap-v4";
    market: Address; chainId: number; tokenIn: Address }
```

### 3.5 `async-vault` (Tier 4) — new kind
ERC-7540 request/claim vault:
```ts
| { kind: "async-vault"; vault: Address; asset: Address;
    flavor: "7540-deposit" | "7540-redeem" | "7540-both" }
```

### 3.6 Additional kinds surfaced by the DeFiLlama catalog (§1.5)
```ts
// Family D — Compound-v2 cToken forks (Venus, Benqi, …).
| { kind: "compound-v2"; cToken: Address; asset: Address }
// Family F — liquid staking / restaking. `venue` selects the pinned stake
// shape + shared contracts in the address-book; `receipt` is the rate-token;
// `exit` records how a withdraw is serviced so the UI never promises instant.
| { kind: "lst-stake"; venue: string; receipt: Address; asset: Address;
    exit: "queue" | "dex" | "instant" }
// Family G — Solidly (Aerodrome/Velodrome) LP. `stable` picks the invariant.
| { kind: "solidly-lp"; router: Address; pool: Address; token0: Address;
    token1: Address; stable: boolean }
// Family G — Balancer v3 / Beets. `poolId` is the Vault registration id.
| { kind: "balancer-lp"; vault: Address; poolId: Hex; asset: Address }
```
**No new `kind` for Aave-forks (Family B):** SparkLend et al. reuse
`{ kind:"aave-v3", pool, asset }` — only the `pool` address differs, and the
adapter + `validateAaveV3` already read it from the resolved target. A fork ships
as a **resolver only**. Likewise Fluid/Euler/Concrete/Venus-4626 reuse
`{ kind:"erc4626" }` (Family A) — resolver only.

---

## 4. Tier 1 — widen the ERC-4626 funnel (highest breadth / least code)

**No new adapter. No new kind.** Each protocol below is a native/ERC-4626-
compliant vault that already routes to the shipped `Erc4626Adapter` via
`targetKinds: ["erc4626"]`. The whole task per protocol is **one
`*.resolver.ts` + one `registerResolver(...)`** that maps the DeFiLlama pool's
matching keys (`chain`, `underlyingTokens[0]`, `poolMeta`) to
`{ kind:"erc4626", vault, asset }`, plus reuse of the existing
`validateErc4626` on-chain check (`asset()` matches, 4626 selectors respond,
TVL band).

| Protocol | 4626 status (official) | Registry to resolve vault address | Notes |
|---|---|---|---|
| **Euler v2** | EVK "EVaults are (mostly) standard-conforming ERC-4626" | Euler's vault lens / subgraph, or per-chain factory list | Multi-vault; disambiguate by `poolMeta` like Morpho |
| **Spark `sUSDS`/`sDAI`** | "ERC-4626 representation of USDS/DAI" | Single canonical address per token (address-book) | Single-vault → accept only unambiguous match |
| **Sky Savings (`sUSDS`)** | Same SSR token as Spark exposes | Canonical address | Stablecoin-native — aligns with QRis thesis |
| **Gearbox v3** | Passive LP = ERC-4626 | Gearbox address list | Multi-pool; `poolMeta` match |
| **Fluid lending** | "supply to Liquidity via ERC-4626-compliant `fToken`s" | Fluid `LendingFactory` / resolver list | `minDeposit()` + `minAmountOut` on deposit → set from `previewDeposit` (§8.4) |
| **Concrete** | 4626 capital-allocator vaults | Concrete registry | No special-casing — `validateErc4626` (proves `asset()`+`convertToShares`) IS the verification; fails → Manual (§12 Q1) |
| **Venus (ERC-4626 wrapper)** | "VenusERC4626 Vaults" wrap `vToken`s | Venus 4626 wrapper list | Prefer the 4626 wrapper over the raw `vToken` (Family D) when it exists |
| **Origin (`OUSD`/`OETH` wrappers)** | wrapped tokens are 4626 | Origin registry | Optional |

> **Fluid caveat:** its 4626 `deposit` enforces `minAmountOut` (shares) and a
> `minDeposit()` floor — set `minAmountOut` from `previewDeposit(amount)` ×
> (1 − bps) and pre-check the floor, else the tx reverts. Same for any 4626 vault
> that adds a min-out guard.

**Reuse `erc4626.resolver.ts` structure verbatim** (it already implements the
Morpho + Yearn resolvers): fetch the protocol's free HTTPS vault list →
filter by `asset == underlyingTokens[0]` → `poolMeta` label match → single
unambiguous fallback → `ctx.validate(target, pool)`. Prefer the plain HTTPS
endpoint over an SDK (pool-level spec §3.1).

**Acceptance:** a scored Euler/Spark/Sky USDC pool badges "Deposit in-app";
deposit and `"MAX"` withdraw both succeed on a fork; validation rejects a vault
whose `asset()` ≠ underlying.

---

## 5. Tier 2 — implement the declared-but-empty kinds

Each is **one backend resolver + one mobile family adapter** (new `targetKinds`).
One adapter instance covers every market of that family on every EVM chain,
routed by `DepositTarget.kind` — exactly like `Erc4626Adapter`.

### 5.1 Compound III (Comet)

**Official interface** (docs.compound.finance):
- Deposit base: `supply(address asset, uint amount)` — must `approve` Comet first.
- Withdraw base: `withdraw(address asset, uint amount)`; **`amount = type(uint256).max` withdraws the full base balance** (the safe MAX sentinel).
- Position read: `balanceOf(address account)` returns the account's **base**
  supply balance (interest-accruing), scaled to base-token decimals. (Collateral
  uses `collateralBalanceOf` — out of scope; we only supply the base asset.)
- Identity: `baseToken()` returns the market's base asset.

**Adapter** `adapters/cometV3.ts`, `targetKinds:["compound-v3"]`:
- `buildDeposit`: `to=comet`, `supply(asset, amount)`, `needsApproval:{token:asset,spender:comet,amount}`.
- `buildWithdraw`: `withdraw(asset, amount==="MAX" ? MAX_UINT256 : amount)`.
- `readPosition(wallet, ctx)`: needs the `comet` from `ctx.target`; returns
  `balanceOf(wallet)` in base units (like Aave's aToken read).

**Resolver** `compound.resolver.ts` (family `compound`, aliases
`compound-v3`, `compound-usdc`, `compoundv3`): map `(chain, underlyingTokens[0])`
to the canonical Comet for that base asset from the **official markets list**
(hardcoded per-chain address-book, same posture as Aave's Pool map). Emit
`{ kind:"compound-v3", comet, asset }`.

**Validation** (add `validateCompoundV3` to `validation.ts`): read
`comet.baseToken()`, require `eqAddr(baseToken, target.asset)`; require the
Comet is non-empty (`totalSupply() > 0`). Fail closed on revert.

### 5.2 Morpho Blue (direct markets)

**Official interface** (docs.morpho.org, singleton `Morpho` contract):
```solidity
supply(MarketParams marketParams, uint256 assets, uint256 shares,
       address onBehalf, bytes data)
       returns (uint256 assetsSupplied, uint256 sharesSupplied);
withdraw(MarketParams marketParams, uint256 assets, uint256 shares,
         address onBehalf, address receiver)
         returns (uint256 assetsWithdrawn, uint256 sharesWithdrawn);
```
Rules from docs: **exactly one of `assets`/`shares` is zero**; `msg.sender` must
be authorized for `onBehalf` on withdraw (self is always authorized).

**Adapter** `adapters/morphoBlue.ts`, `targetKinds:["morpho-blue"]`:
- Requires the extended target with full `params` (§3.1).
- `buildDeposit`: supply as a **lender** → `assets=amount, shares=0,
  onBehalf=wallet, data="0x"`. `to` = the singleton Morpho address (per-chain
  constant). `needsApproval:{token:params.loanToken, spender:Morpho, amount}`.
- `buildWithdraw`:
  - partial: `assets=amount, shares=0, onBehalf=wallet, receiver=wallet`.
  - **`"MAX"`: read the lender's `supplyShares` via `Morpho.position(id, wallet)`
    and withdraw by `shares` (`assets=0`)** — avoids dust/rounding reverts, same
    rationale as the 4626 adapter using `redeem` for full exit.
- `readPosition(wallet, ctx)`: `position(marketId, wallet).supplyShares` →
  convert to assets via `expectedSupplyAssets` (blue-sdk math) or the
  `market(id)` totals. Needs `ctx.target` for `marketId`.

**Resolver** `morpho-blue.resolver.ts`: query Morpho GraphQL for the market by
`(chainId, loanAsset==underlying, poolMeta/uniqueKey)`, pull the full
`MarketParams`, compute `marketId=keccak256(encode(params))`, and emit the
extended target. **Only lender-safe markets** (the pool must be a supply/earn
pool in DeFiLlama, not a borrow position).

**Validation** (`validateMorphoBlue`): recompute
`keccak256(abi.encode(params))` and require it equals `target.marketId`; call
`Morpho.market(marketId)` and require `totalSupplyAssets > 0` and
`params.loanToken == underlying`. This closes the "wrong struct" hole.

### 5.3 Curve LP (generalize beyond `curve3pool`)

**Official interface** (curve pools; ABI varies by generation):
- Deposit: `add_liquidity(uint256[N] amounts, uint256 min_mint_amount)` — set
  only `amounts[index]` non-zero (single-sided).
- Withdraw one coin: `remove_liquidity_one_coin(uint256 lp_amount, int128 i,
  uint256 min_received)` (legacy) / `(uint256 lp_amount, uint256 i, uint256
  min_received)` (NG uses `uint256` index).
- **Slippage: `min_mint_amount` / `min_received` MUST be set** from
  `calc_token_amount` / `calc_withdraw_one_coin` × (1 − slippageBps). A zero
  min is a sandwich invitation — **hard requirement**, block build if unset.

**Adapter** `adapters/curveLp.ts`, `targetKinds:["curve-lp"]`: branch ABI arity
on `target.nCoins` + `target.isNg` (carried on the target, not probed). Compute
`min_*` from the pool's `calc_*` view at build time with a default 0.5% slippage
(configurable). `"MAX"` withdraw = LP `balanceOf(wallet)`.

**Resolver** `curve.resolver.ts`: use the **official Curve registry / metadata
API** to map `(chain, poolMeta/underlyingTokens)` → `{ pool, asset, index,
nCoins, isNg }`. Fail closed for pools whose `index` for the underlying can't be
uniquely determined (e.g. duplicate-asset pools).

> Curve LP carries **impermanent-loss / de-peg risk** absent from single-asset
> vaults. Surface `kind: "lp_stable" | "lp_volatile"` (already in `StrategyKind`)
> so the card can warn, and keep `staticSafetyScore` conservative.

### 5.3b Aave-v3 forks — SparkLend & siblings (resolver-only, Family B)
SparkLend is an **Aave-v3 fork** (docs.spark.fi): the `Pool` exposes the same
`supply(asset,amount,onBehalf,ref)` / `withdraw(asset,amount,to)`, mints
`spToken`s (aToken analog), and the Pool address is fetched from its
`PoolAddressesProvider`. **No new adapter or kind** — a `spark.resolver.ts`
emits `{ kind:"aave-v3", pool: <SparkLend Pool>, asset }` and the existing
`AaveV3` adapter + `validateAaveV3` (`getReserveData(asset).aTokenAddress != 0`)
already handle it. Same recipe for Zerolend / Avalon / Seamless / Radiant: one
resolver each, Pool from the fork's addresses-provider, pinned in the
address-book (§11 Layer-1 allowlist). Fork Pools MUST be address-book-pinned, not
API-trusted.

### 5.4 Compound-v2 cToken forks — Venus & siblings (Family D, new kind)

**Official interface** (Compound-v2 lineage; Venus docs): supply
`mint(uint mintAmount)` → receive `cToken`/`vToken`; withdraw
`redeem(uint shares)` or `redeemUnderlying(uint assets)`; the position in
underlying units is `cToken.balanceOf × exchangeRateStored / 1e18`. `mint`
requires ERC-20 `approve` of the cToken first. (Venus additionally ships
**VenusERC4626 wrapper vaults** — when a wrapper exists for the market, prefer
routing through Family A instead; the cToken adapter is the general fallback for
forks without a 4626 wrapper.)

**Adapter** `adapters/compoundV2.ts`, `targetKinds:["compound-v2"]`:
- `buildDeposit`: `to=cToken`, `mint(amount)`, `needsApproval:{token:asset,spender:cToken,amount}`.
- `buildWithdraw`: partial → `redeemUnderlying(amount)`; **`"MAX"` →
  `redeem(cToken.balanceOf(wallet))`** (share-based, avoids exchange-rate dust).
- `readPosition(wallet, ctx)`: `balanceOf × exchangeRateStored`.

**Resolver** `compound-v2.resolver.ts` (family `venus`, aliases the fork slugs):
map `(chain, underlyingTokens[0], poolMeta)` → the market's `cToken` from the
protocol's own markets list; emit `{ kind:"compound-v2", cToken, asset }`.

**Validation** (`validateCompoundV2`): read `cToken.underlying()` and require
`eqAddr(underlying, target.asset)` (native-asset markets have no `underlying()`
→ handle explicitly); confirm `exchangeRateStored() > 0`. Fail closed.

### 5.5 Approval + submission — unchanged
All Tier-2 adapters emit `kind:"evm-call"` with the ERC-20 `needsApproval`
preamble the executor already injects (paymaster path included). No executor
change.

### 5.6 Resolver context — unchanged
All resolvers reuse the existing `ResolverContext.fetchJsonCached` (Valkey-
cached, inflight-deduped) and `ctx.validate`. No new infra.

---

## 6. Tier 3 — router-calldata families (Pendle, Uniswap LP)

These have **no stable on-chain deposit ABI we encode**; the protocol's **hosted
API returns the calldata**, priced with slippage at request time. This is a
different trust/execution model and gets its own kind + adapter + a **server-side
proxy** (never call the third-party API with the user's address straight from
the client without going through our backend, so keys/rate-limits/allowlisting
are centralized).

**Pendle** (docs.pendle.finance, Hosted SDK):
- Add liquidity: `GET /v2/sdk/{chainId}/markets/{market}/add-liquidity`
  `{ receiver, slippage, tokenIn, amountIn, enableAggregator }` → returns `tx`
  `{ to, data, value }`.
- Swap-to-PT: `.../swap` with `tokenOut = PT`.

**Adapter** `adapters/routerCall.ts`, `targetKinds:["router-call"]`:
- `buildDeposit`: call **our backend proxy** → returns `{to,data,value}` →
  wrap as `evm-call`. The `needsApproval` spender is the returned `to` (Pendle
  Router). Because calldata is time-sensitive (slippage, TWAP), the executor
  MUST build → simulate → sign within a short window and re-fetch on revert.
- `buildWithdraw` / remove-liquidity: symmetric endpoint.

**Guardrails (mandatory for router-calldata):**
1. **Slippage cap** enforced server-side; reject quotes exceeding it.
2. **`to` allowlist** — the returned target MUST be the known Pendle/Uniswap
   router for that chain (address-book), else block. Defends against a
   compromised/spoofed API response routing funds elsewhere.
3. **Simulate before sign** (already in the intent executor) — non-negotiable
   here since we didn't author the calldata.
4. Value/asset assertion: decode enough of the return to confirm `tokenIn ==
   underlying` and `amountIn == amount`.

> Uniswap v3/v4 concentrated-liquidity LP has tick-range + IL complexity; ship
> Pendle first (single `add-liquidity` call), then Uniswap.

### 6.1 Solidly LP — Aerodrome (Base) / Velodrome (OP), `solidly-lp`
Solidly forks (docs.velodrome/aerodrome) deposit via the **Router**:
`addLiquidity(tokenA, tokenB, stable, amountA, amountB, minA, minB, to,
deadline)`; exit `removeLiquidity(...)`. `stable` picks the invariant (stable vs
volatile pool). **Slippage (`minA/minB`) + `deadline` are mandatory** — compute
from `quoteAddLiquidity`. Adapter `adapters/solidlyLp.ts`,
`targetKinds:["solidly-lp"]`; resolver reads the pool + `stable` flag from the
official pool factory. Router MUST be address-book-pinned. IL risk → conservative
`staticSafetyScore`, `lp_stable`/`lp_volatile` tier.

### 6.2 Balancer v3 / Beets — `balancer-lp`
Deposit through the Balancer **Vault/Router** by `poolId`; single-asset joins
set min-BPT-out. New adapter + resolver; Vault pinned in the address-book. Lower
priority than Solidly (fewer stablecoin single-sided pools).

### 6.3 Convex / Aura — LP boosting
Two-step: obtain the Curve/Balancer LP (Family G above), then `deposit(pid, amt,
stake=true)` into Convex/Aura for boosted rewards. Ships **after** Curve/Balancer
LP land; models as a distinct venue that consumes the LP adapter's output.

### 6.4 Liquid staking / restaking — `lst-stake` (Family F)
Not router-calldata, but grouped in Tier 3 as a bespoke family. Deposit is a
per-venue stake into a rate-appreciating receipt; `venue` on the target selects
the pinned entry contract + shape from the address-book (space-docking):
- **Rocket Pool** — `RocketDepositPool.deposit()` (payable) → `rETH`.
- **ether.fi** — `LiquidityPool.deposit()` (payable) → `eETH`; optional wrap to
  `weETH` (non-rebasing). If a pool surfaces `weETH` (ERC-4626-shaped), prefer
  Family A instead.
- **Binance `wBETH`, Mantle `mETH`, Coinbase `cbETH`, StakeWise, Stader, Kelp
  `rsETH`, Lombard `LBTC`** — each a `venue` config.

**Adapter** `adapters/lstStake.ts`, `targetKinds:["lst-stake"]`, one instance,
per-venue config. `readPosition` = `receipt.balanceOf × rate`.

> **Exit is the hard part.** Most LSTs redeem via a **withdrawal queue** (days)
> or a **DEX swap** (instant, slippage). The target's `exit` field drives UX:
> `"dex"` → route the withdraw through the swap layer with slippage bounds;
> `"queue"` → this is effectively async → model with the Tier-4 request/claim
> machinery, never as an instant `"MAX"` withdraw. Deposit ships first; label the
> exit path honestly (`liquidityProfile: "queued_long"`).

---

## 7. Tier 4 — asynchronous vaults (ERC-7540)

ERC-7540 (finalized 2024; used by Centrifuge, Ondo institutional pools, some
Pendle) extends 4626 for assets that **cannot settle in one tx** — tokenized
treasuries, private credit, any RWA with T+1/T+2 or a withdrawal queue. Deposit
and redeem become a **request → (off-chain fulfill) → claim** state machine.
This **breaks** `UnsignedCall`'s one-shot model and needs deliberate interface
work — hence Tier 4, design-first.

**Official flow** (ERC-7540 / OZ community-contracts):
- Deposit: `requestDeposit(assets, controller, owner)` → later
  `deposit(assets, receiver)` / `mint` to **claim** once `claimableDepositRequest`
  is non-zero.
- Redeem: `requestRedeem(shares, controller, owner)` → later
  `withdraw`/`redeem` to claim once `claimableRedeemRequest` is non-zero.

**Interface changes required (design deliverable of this tier):**
1. Extend `UnsignedCall`/withdraw states: `amount` gains a two-phase notion, or
   add `buildRequestDeposit` / `buildClaimDeposit` / `buildRequestRedeem` /
   `buildClaimRedeem` optional methods (presence-checked, space-docking).
2. **Pending-claims tracker** — persist request status (`pendingDepositRequest`
   / `claimableDepositRequest`) on the position row; a worker polls readiness
   and notifies the user to claim. Position display must show "pending
   settlement".
3. Agent UX: `defi_deposit` on an async pool returns "requested — will notify
   when claimable", not "done".

**Do not** register any `async-vault` resolver until this interface ships; until
then, ERC-7540 pools stay **Manual** (correct-by-default), never badged in-app
where they'd request-then-appear-stuck.

---

## 8. Cross-cutting production requirements

### 8.1 On-chain validation is MANDATORY per new kind
`validation.ts` gains `validateCompoundV3`, `validateCompoundV2`,
`validateMorphoBlue`, `validateCurveLp`, `validateSolidlyLp`,
`validateBalancerLp`, `validateLstStake`; router-call validates via the
`to`-allowlist + simulate; async validates `supportsInterface(0x2f0a18c5)`
(ERC-7540). Aave-forks (SparkLend, …) reuse `validateAaveV3`; Family-A additions
(Fluid/Euler/Concrete/Venus-4626) reuse `validateErc4626`. The registry's
`default: return true` passthrough is **removed for EVM kinds** — every EVM kind
must have an explicit validator or the target is rejected. (Non-EVM kinds keep
resolver-internal validation.)

### 8.2 Fail-closed everywhere
Any resolver ambiguity, API miss, hash mismatch, or unreadable chain state →
`null` → Manual. Never guess an address. This is the property that makes
"route user funds" safe.

### 8.3 Withdraw `"MAX"` semantics table (get these exactly right)
| Kind | `"MAX"` mechanism |
|---|---|
| `erc4626` | `redeem(balanceOf(owner), owner, owner)` (existing) |
| `aave-v3` | `withdraw(asset, type(uint256).max, to)` (existing) |
| `compound-v3` | `withdraw(asset, type(uint256).max)` |
| `morpho-blue` | read `supplyShares`, `withdraw(assets=0, shares=supplyShares)` |
| `curve-lp` | `remove_liquidity_one_coin(balanceOf(LP), index, min)` |
| `async-vault` | `requestRedeem(sharesBalance,…)` then claim |

### 8.4 Approvals
Default: ERC-20 approve preamble via `needsApproval` (unchanged). Optional
enhancement: emit ERC-2612 `permit` / Permit2 for permit-capable assets to save
a tx — additive, presence-checked, out of v1 scope. Never leave infinite
approvals implicit — approve the exact `amount`.

### 8.5 Testing (per family, before registration)
- **Fork tests** (Anvil/Tenderly per chain): deposit → readPosition → partial
  withdraw → MAX withdraw round-trips; assert dust ≈ 0.
- **Validation unit tests**: a wrong `asset()`/`baseToken()`/`marketId`/`to`
  is rejected; a correct one passes.
- **Resolver tests**: real DeFiLlama pool fixtures resolve to the right target;
  ambiguous pools resolve to `null`.
- **Simulation gate**: every build dry-run-reverts-block (router-call especially).
- Mirror the existing `*.resolver.spec.ts` / `registry.test.ts` patterns.

### 8.6 Feature-flag rollout (mirror `bootstrap.ts` phases)
- `FEATURE_DEFI_EVM_TIER1` — Family A resolvers (Euler, Spark/Sky savings, Fluid,
  Concrete, Venus-4626, Gearbox, Origin) + Family B Aave-fork resolvers
  (SparkLend, …). Ship first, lowest risk (no new adapter/kind).
- `FEATURE_DEFI_EVM_TIER2` — Comet (`compound-v3`), Compound-v2 cToken forks
  (`compound-v2`, Venus), Morpho Blue (`morpho-blue`), Curve LP (`curve-lp`).
- `FEATURE_DEFI_EVM_TIER3` — router-call (Pendle → Uniswap), Solidly
  (`solidly-lp`), Balancer (`balancer-lp`), Convex/Aura, LSTs (`lst-stake`).
- `FEATURE_DEFI_EVM_TIER4` — async (`async-vault`) — off until the two-phase
  interface lands; ERC-7540/permissioned RWA stay Manual until then.
Each flag gates BOTH the backend `registerResolver` and mobile
`registerDefiAdapter` so a half-wired family never badges "in-app". Prefer a
**per-family** sub-flag under each tier so one risky family can be dark-launched
independently (ties into the §11.3 Layer-3 kill-switch).

### 8.7 Backend/mobile union sync check
Add a CI test asserting the `DepositTarget` union is structurally identical in
`api/src/strategies/targets/types.ts` and `mobile-app/services/defi/types.ts`
(the two already carry a "keep in sync" comment; enforce it).

---

## 9. Per-family definition-of-done checklist

A family is production-ready only when ALL hold:
- [ ] Resolver added + registered behind its tier flag; fails closed on ambiguity.
- [ ] Family adapter added + registered with correct `targetKinds`.
- [ ] `DepositTarget` union updated in **both** files (CI sync test green).
- [ ] Explicit on-chain validator in `validation.ts` (no `default:true` for EVM).
- [ ] Deposit + partial withdraw + `"MAX"` withdraw fork-tested; dust ≈ 0.
- [ ] `readPosition` returns correct underlying-unit balance (or documented DB
      fallback for kinds that can't derive from address alone).
- [ ] Slippage enforced (Curve, router-call).
- [ ] `to`/router allowlist enforced (router-call).
- [ ] Approval scoped to exact amount.
- [ ] Card badges "Deposit in-app" only when target resolves + validates.
- [ ] Runbook entry appended.

---

## 10. Sequencing summary

Ordered by TVL-unlocked ÷ effort (highest first), grounded in the §1.5 catalog:
1. **Tier 1 Family A** (Euler → Sky/Spark savings → Fluid → Concrete → Venus-4626
   → Gearbox) — pure resolvers onto the existing 4626 adapter. Biggest breadth,
   least risk; ship each independently.
2. **Tier 1 Family B — SparkLend** ($4.2B) and other Aave-forks — resolver only,
   reuses the Aave adapter + validator. Highest single-protocol unlock for ~1 file.
3. **Tier 2 — Compound III** ($1.1B) — cleanest new adapter (2-arg supply/withdraw,
   covers all Comet markets/chains).
4. **Tier 2 — Compound-v2 cToken forks / Venus** ($1.07B) — one adapter covers the
   whole fork lineage.
5. **Tier 2 — Morpho Blue** — includes the `marketId → MarketParams` correctness
   fix; unlocks the base markets under MetaMorpho.
6. **Tier 2 — Curve LP** — generalizes `curve3pool`; adds slippage discipline.
7. **Tier 3 — Pendle** (router-call proxy + allowlist) → Uniswap → Solidly
   (Aerodrome/Velodrome) → Balancer → Convex.
8. **Tier 3 — LSTs** (`lst-stake`: Rocket Pool, ether.fi, …) — deposit first;
   queue-exit venues route to Tier-4 machinery.
9. **Tier 4 — ERC-7540 / RWA async** — interface design first; no resolver until
   two-phase claim lands.

---

## 11. Safety layer (defense-in-depth)

We route user funds into third-party contracts, with an LLM proposing intents
and external APIs supplying data. No single check is sufficient — safety is a
**pipeline of independent layers**, each fail-closed, ordered from cheapest/
earliest to most expensive/latest. A target must clear **every** layer that
applies to its kind. `[E]` = already exists, `[N]` = new for this expansion.

**Chain-agnostic by construction.** Although the *protocol families* in this
spec are EVM, the safety layer is **not** — it is designed chain-agnostic and
extensible from day one (the wallet already spans `eip155 | solana | sui |
stellar`, and `DepositTarget`/`UnsignedCall` are already chain-discriminated
unions). The **layer taxonomy below is universal**; only the *primitive* used to
satisfy a check differs per chain, and each chain docks its primitives in through
one interface — the same space-docking pattern as the resolver/adapter
registries. Adding a chain is implementing a provider, never editing a check.

### 11.0 Architecture — universal layers, per-chain primitives

Three pieces, none EVM-specific:

**a) `SafetyCheck` (chain-agnostic descriptor).** A check declares *what* it
verifies and *where it applies* — never *how* to talk to a chain:
```ts
interface SafetyCheck {
  readonly id: string;                 // e.g. "target-has-code"
  readonly layer: 0|1|2|3|4|5|6;
  readonly appliesTo: {                // omitted field ⇒ "all"
    namespaces?: readonly Namespace[]; // e.g. undefined = every chain
    kinds?: readonly DepositTargetKind[];
  };
  run(ctx: SafetyContext): Promise<SafetyResult>; // { ok } | { fail: DefiErrorCode, detail }
}
```

**b) `ChainSafetyProvider` (the ONLY chain-specific seam).** Checks call this
capability interface, not viem/Sui/Solana SDKs directly. One implementation per
`Namespace`, registered by namespace. This is what makes the layer chain-agnostic
— a check like "target has code" is written once against the provider:
```ts
interface ChainSafetyProvider {
  readonly namespace: Namespace;
  /** L1: the target address/object/account exists and is executable code. */
  targetExists(target: DepositTarget): Promise<boolean>;
  /** L1: identity read — vault.asset() / comet.baseToken() / coinType / mint. */
  readUnderlying(target: DepositTarget): Promise<string | null>;
  /** L1: target ∈ pinned per-chain address-book / program allowlist. */
  isAllowlisted(target: DepositTarget): Promise<boolean>;
  /** L4: chain binding — the built call is bound to the intended chain. */
  assertChainBinding(call: UnsignedCall, chainId: number | string): boolean;
  /** L4: decode the call and return its human/machine intent for matching. */
  decodeIntent(call: UnsignedCall): Promise<DecodedIntent | null>;
  /** L4: dry-run / simulate without broadcasting. */
  simulate(call: UnsignedCall): Promise<SimResult>;
  /** L5: protocol's own emergency state (paused/frozen/deprecated/expired). */
  isProtocolHalted(target: DepositTarget): Promise<boolean>;
  /** L5: post-exec position delta for the assertion. */
  readPositionDelta(target: DepositTarget, owner: string): Promise<bigint>;
}
```
`decodeIntent` returns a normalized shape (`{ to, action, asset, amount,
recipient }`) so the Layer-4 "decoded intent matches user intent" check is
identical across chains — EVM decodes calldata, Sui inspects PTB `moveCall`
targets/args, Solana inspects instruction program-ids/accounts, all collapsing to
the same struct.

**c) `SafetyPipeline` (chain-agnostic runner).** Selects the checks whose
`appliesTo` matches `(namespace, target.kind)`, runs them in `layer` order,
**short-circuits fail-closed** on the first failure, and returns a typed
`DefiErrorCode`. Knows nothing about any chain:
```ts
registerSafetyCheck(check);          // space-docking, like registerResolver
registerChainSafetyProvider(prov);   // one per Namespace
await runSafetyPipeline(ctx);        // → { ok } | { fail: DefiErrorCode, layer, id }
```

**Division of labor (why this stays clean):**
- **Fully chain-agnostic checks** — Layer 0 (input schema, no-LLM-address),
  Layer 3 (tier/whitelist/kill-switch/exposure caps), and the arithmetic of
  Layer 2 (amount bounds, slippage-floor-present) operate on metadata only →
  **one implementation, every chain, forever**.
- **Provider-backed checks** — Layers 1, 4, 5 (identity, decode, simulate,
  pause, delta) are written **once** against `ChainSafetyProvider` → they gain a
  new chain the moment that chain's provider is registered, with **zero change to
  the check**.

**Per-namespace primitive mapping** (the same universal check, different
provider implementation):

| Universal check | eip155 | sui | solana | stellar |
|---|---|---|---|---|
| `targetExists` (L1) | `EXTCODESIZE>0` | object exists, expected type | account exists, owner==program | ledger entry exists |
| `readUnderlying` (L1) | `asset()`/`baseToken()` | `coinType` (T) | token `mint` | asset code/issuer |
| `isAllowlisted` (L1) | pinned contract book | pinned package/object ids | pinned program ids | pinned contract ids |
| `assertChainBinding` (L4) | EIP-155 `chainId` | correct network + package | cluster + program id | network passphrase |
| `decodeIntent` (L4) | ABI-decode calldata | inspect PTB moveCalls/args | inspect ixs/accounts | inspect operations |
| `simulate` (L4) | `eth_call`/estimateGas | `devInspect`/`dryRun` | `simulateTransaction` | `simulateTransaction` |
| `isProtocolHalted` (L5) | `isFrozen`/paused flags | `assert_version`/pause field | program pause account | contract paused flag |

> This is why "focus on EVM" and "chain-agnostic" don't conflict: we ship only
> the `eip155` provider now, but every check and the runner are already the
> version we'd keep when Sui/Solana DeFi lands — those just register a provider.

### Layer 0 — Input provenance (tool boundary, mobile)
- `[E]` **No LLM-supplied addresses** — reject any address-shaped tool field
  (`FORBIDDEN_TARGET_KEYS`); the only trusted handle from the model is `pool_id`.
- `[E]` **Server-resolved target** — the executor re-fetches the authoritative
  `depositTarget` by `pool_id`; the model's job ends at pool selection.
- `[N]` **Strict input schema** — `amount` is a positive integer in raw units;
  `pool_id` matches a known UUID shape; unknown fields rejected (not ignored).

### Layer 1 — Target identity & provenance (resolve-time, backend)
This is the "is this the *real* contract" layer — the core of the user's ask.
- `[N]` **Has code** — `EXTCODESIZE(target) > 0` on the intended chain (a target
  that's an EOA or undeployed → reject). Cheap, catches a whole class of errors.
- `[N]` **Chain binding** — `resolveEvmChainId(pool.chain)` is supported AND the
  target was validated on *that* chain; the signed tx's `chainId` (EIP-155) must
  equal it at sign-time (Layer 4). No cross-chain address reuse assumptions.
- `[N]` **Singleton address-book allowlist** — for protocols with one canonical
  contract per chain (Aave Pool, Morpho singleton, Comet, Curve registry, Pendle
  router), the address MUST equal a **pinned, code-reviewed constant**, never
  "whatever the API returned". API-sourced addresses (per-vault) are allowed only
  after the identity checks below.
- `[E→N]` **Underlying match** — `asset()`/`baseToken()`/`loanToken` ==
  `underlyingTokens[0]`. Exists for 4626/Aave; **add per new kind** (Comet
  `baseToken()`, Morpho `params.loanToken`, Curve `coins[index]`).
- `[N]` **Morpho `marketId` integrity** — `keccak256(abi.encode(params)) ==
  marketId` (closes the hash-vs-struct hole, §3.1/§5.2).
- `[N]` **Family ↔ project provenance** — the DeFiLlama `pool.project` must match
  the resolver family/aliases AND the vault must come from the protocol's **own**
  registry (Morpho API, yDaemon, Curve registry). Defends against a look-alike
  pool claiming a trusted slug.
- `[N]` **Factory/deployer provenance (where available)** — verify a vault was
  deployed by the protocol's known factory, not a look-alike with a correct
  `asset()` but malicious logic.
- `[N]` **Oracle/IRM allowlist (Morpho Blue)** — even as a *lender* you inherit
  bad-debt risk from a manipulated oracle (borrowers escape liquidation). Only
  resolve markets whose `oracle`/`irm` are on a curated allowlist.
- `[E]` **TVL sanity band** — on-chain `totalAssets` within a loose factor of
  DeFiLlama's TVL (stablecoins). Catches wrong/dust vaults.
- `[N]` **Proxy/upgradeability flag** — detect proxy targets; surface
  "upgradeable" as a risk signal and refuse EOA-admin-upgradeable vaults for the
  conservative tier.

### Layer 2 — Economic / value safety (pre-sign)
- `[E]` **Balance sufficiency** (`insufficient_funds`).
- `[E→N]` **Amount bounds** — `minDepositRaw` (dust) exists; **add** per-tx max
  and per-user daily cap (velocity limit).
- `[N]` **Deposit-cap headroom** — ERC-4626 `maxDeposit(receiver) >= amount`;
  Comet supply-cap not exceeded; Aave reserve not at cap. Avoid guaranteed
  reverts and mid-cap partial fills.
- `[N]` **Share-inflation / donation-attack guard** — for fresh 4626 vaults,
  require a minimum vault age / TVL and a sane `convertToShares(1 unit)` before
  trusting share price. Blocks the classic first-depositor rounding exploit.
- `[N]` **Expected-output band** — `previewDeposit(amount)` shares > 0 and within
  tolerance; for LP/router, `expectedOut` within slippage of quote.
- `[E]` **APY drift ±5%** — stale-opportunity guard.
- `[N]` **Slippage floor (LP / router-call)** — `min_mint_amount` / `min_received`
  MUST be set from `calc_*`/quote × (1 − bps); a zero min hard-blocks the build.

### Layer 3 — Policy / authorization (per-user, backend)
- `[E]` **Tier ceiling**, **protocol whitelist**, **strategy-paused kill-switch**.
- `[N]` **Per-family global kill-switch** — ops can disable an entire family
  (e.g. "compound-v3") instantly on an exploit disclosure, independent of user
  state. Backed by a hot config the resolver + executor both read.
- `[N]` **Per-chain enablement flag** (separate from "supported").
- `[N]` **Cumulative-exposure cap** — max % of user funds in one protocol/family.
- `[N]` **Illiquidity consent (ERC-7540)** — async pools require explicit user
  acknowledgement of settlement delay before the first `requestDeposit`.

### Layer 4 — Execution integrity (sign & submit)
- `[E]` **Simulate before sign** — dry-run must not revert (mandatory; the only
  authority for router-call calldata we didn't author).
- `[E→N]` **Clear-signing / decoded-intent match** — decode the calldata and
  assert: `tx.to == resolved target` (or allowlisted router), function selector
  is the expected one, and decoded args match (`amount`, `receiver/onBehalf ==
  user's own wallet`, never a third party). Preview exists; **add the machine
  assertion**, especially for `router-call`.
- `[N]` **Approval scoping** — approve the **exact** amount to the **exact**
  spender (== target/router); never infinite; prefer `permit`/Permit2 when the
  asset supports it; revoke stale approvals.
- `[N]` **Chain-id in signed tx** (EIP-155) == intended chain — replay / wrong-
  chain protection.
- `[N]` **Quote freshness / deadline** — router quotes carry an expiry; re-fetch
  and re-simulate if stale before signing.
- `[N]` **Idempotency / double-submit guard** — one intent → one submission key.
- `[N]` **Gas sanity** — estimate within bounds; reject absurd gas (griefing).

### Layer 5 — Protocol-state & post-execution
- `[N]` **Protocol pause/frozen check** — read the protocol's own emergency
  state before deposit: Aave reserve `isFrozen`/`isPaused`, Comet supply-paused,
  Morpho market not deprecated, Pendle PT not past maturity.
- `[E]` **Receipt confirmation** — tx mined, status success
  (`submission_unconfirmed` otherwise).
- `[N]` **Position-delta assertion** — after deposit, `readPosition` shows
  +shares/+balance ≈ expected; after withdraw, funds returned to the user's
  wallet. Reconcile the DB row against chain; alert on mismatch.

### Layer 6 — Operational / supply-chain
- `[N]` **Untrusted external data** — Pendle/Morpho/DeFiLlama responses are
  schema-validated and address-allowlisted; a returned address never becomes a
  `tx.to` without the Layer-1 allowlist. Rate-limit + circuit-break each API.
- `[N]` **RPC integrity** — route reads through the trusted `rpc-proxy`;
  cross-check critical reads (validation) across providers where feasible.
- `[N]` **Address-book governance** — the pinned constants are version-controlled,
  reviewed, and changes gated (treat like a secret/allowlist change).
- `[N]` **Exploit monitoring → auto-trip** — watch protocol pause events / TVL
  crashes; auto-engage the Layer-3 family kill-switch.

### 11.1 Where each layer runs (fail-closed, both sides)
| Layer | Runs at | On failure |
|---|---|---|
| 0 Input | mobile tool boundary | reject tool call |
| 1 Identity | backend resolve-time (`validation.ts`) | target → `null` → **Manual** |
| 2 Economic | mobile pre-sign (`resolveAndGuard`/adapter) | typed `DefiError`, no tx |
| 3 Policy | backend + mobile | typed `DefiError`, no tx |
| 4 Execution | mobile sign/submit (`simulate`/`submitTx`) | abort before broadcast |
| 5 State/post | backend read + executor | block deposit / alert |
| 6 Ops | backend infra | kill-switch / degrade |

Two independent trust anchors must agree before funds move: the **backend**
(identity, policy, provenance) and the **on-device signer** (simulate + decoded-
intent match). Neither alone can authorize a transfer — a compromised backend
still can't get past the on-device decode assertion that `to`/args match what the
user approved, and a compromised client still can't get a target the backend
never resolved + validated.

### 11.2 New error codes
Add to `DefiErrorCode`: `target_not_a_contract`, `target_not_allowlisted`,
`market_id_mismatch`, `oracle_not_allowlisted`, `deposit_cap_exceeded`,
`slippage_too_high`, `quote_expired`, `protocol_paused`,
`decoded_intent_mismatch`, `exposure_cap_exceeded`, `family_disabled`,
`decimals_mismatch`, `counterparty_blocked`, `awaiting_finality`,
`duplicate_submission`, `velocity_exceeded`, `pool_anomaly_flagged`.

### 11.3 Minimum bar to register a new family / chain
- **New family** may go live **only** when its Layer-1 validator + Layer-4
  decoded-intent assertion + Layer-5 pause check are implemented and fork-tested.
  Registering without them is the one thing this spec forbids.
- **New chain** is bounded to exactly one deliverable: implement + register its
  `ChainSafetyProvider` (all seven primitives, §11.0b) and a `simulate` that is
  authoritative. Every existing provider-backed check then covers the chain with
  **no edit to any check or the runner**. A chain with a partial provider is
  registered as *read-only advisory* (Manual badge only) until `simulate` +
  `decodeIntent` are trustworthy — never as "in-app".

### 11.4 Intended module layout (implementation blueprint — not built yet)
Chain-agnostic core is namespace-free; chain specifics live only under
`providers/`. Adding a chain = one file under `providers/` + one registration.
```
services/defi/safety/
  types.ts            # SafetyCheck, ChainSafetyProvider, SafetyPipeline,
                      # SafetyContext, SafetyResult, DecodedIntent, SimResult
  registry.ts         # registerSafetyCheck / registerChainSafetyProvider /
                      # runSafetyPipeline  (space-docking; chain-agnostic)
  bootstrap.ts        # register all checks + the eip155 provider (phased flags)
  checks/
    layer0-input.ts   # agnostic: schema, no-LLM-address
    layer1-identity.ts# provider-backed: exists, underlying, allowlist, provenance
    layer2-economic.ts# agnostic arithmetic + provider preview/caps
    layer3-policy.ts  # agnostic: tier, whitelist, kill-switch, exposure caps
    layer4-execution.ts # provider-backed: chain-binding, decode-match, simulate
    layer5-state.ts   # provider-backed: protocol-halted, position-delta
  providers/
    eip155.ts         # THE only file shipped now (viem-backed)
    # sui.ts, solana.ts, stellar.ts  ← future: one file each, zero check edits
```
Wiring points (existing code): `runSafetyPipeline` is called from
`resolveAndGuard` (backend policy/identity) and from `simulate`/`submitTx`
(on-device Layer 4) — the two independent trust anchors of §11.1.

### 11.5 Safety parameters — universal vs chain-native

Different chains have genuinely different safety parameters (EVM allowances,
Solana account-owners, Sui object-versions, Stellar trustlines). A chain-agnostic
layer handles this with a **two-tier parameter model**: *normalize what's common,
delegate what's native.*

**Tier 1 — Universal (normalized) parameters.** Every `ChainSafetyProvider` MUST
map its raw call into these common shapes; the universal checks (and the runner)
depend on **nothing else**. This is the vocabulary that makes a check like
"recipient is the user's own wallet" identical on all four chains.

```ts
// What the built call actually does, chain-normalized (provider.decodeIntent).
interface DecodedIntent {
  destination: string;      // eip155 to · solana programId · sui pkg::mod::fn · stellar contract
  action: "deposit" | "withdraw" | "approve" | "stake" | "claim" | "unknown";
  assetIn: string | null;   // token address / mint / coinType / asset code
  amountIn: bigint | null;
  recipient: string | null; // MUST equal the user's own wallet
  valueNative: bigint;      // native coin attached (ETH/SOL/SUI/XLM)
  spender: string | null;   // approval/allowance grantee (== destination or null)
  approvalAmount: bigint | null; // exact; never unbounded
  minOut: bigint | null;    // slippage floor for LP/router/min-out vaults
  deadline: number | null;  // quote/tx expiry (unix)
}
// The surrounding decision context (identity + policy + economic + sim).
interface SafetyContext {
  namespace: Namespace;
  target: DepositTarget;
  chainId: number | string;
  wallet: string;
  requestedAmount: bigint | "MAX";
  underlyingExpected: string;   // from the resolved target
  previewOut: bigint | null;    // provider.previewOut (shares/LP/assets)
  tvlUsdSnapshot: number | null;
  sim: SimResult | null;        // { ok, revertReason?, stateDelta? }
  feeEstimate: bigint | null;
}
```
Universal checks over these (namespace-independent): `recipient === wallet`,
`assetIn === underlyingExpected`, `amountIn === requestedAmount` (or `MAX`
resolved), `spender === destination && approvalAmount === amountIn`,
`minOut != null` for slippage-bearing kinds, `deadline` fresh, `sim.ok`,
`previewOut` within band, `valueNative` matches for native deposits.

**Tier 2 — Chain-native parameters.** Each provider *additionally* validates the
safety params that only exist on its chain, exposed as **namespace-scoped
`SafetyCheck`s** (`appliesTo:{namespaces:["…"]}`) that call provider methods. The
runner treats each as opaque `{ok}|{fail: DefiErrorCode}` — it never learns what
a "trustline" or "object version" is.

| Namespace | Chain-native params the provider validates (Tier 2) |
|---|---|
| **eip155** | bytecode present (`EXTCODESIZE>0`); EIP-155 `chainId` in signed tx; ERC-20 **allowance** semantics (exact, reset-to-0 for non-standard tokens); function **selector** == expected; **proxy/implementation + admin** (upgradeable-by-EOA = risk); revert-reason decode; gas ceiling; fee-on-transfer / rebasing-token detection |
| **solana** | account **owner == expected program**; **mint + mint-authority** (frozen/closeable); **PDA/ATA derivation** correctness; per-instruction **writable/signer** flags; **program-id allowlist**; compute-unit budget; **address-lookup-table** resolution; rent-exemption; CPI target program |
| **sui** | object **type + ownership** (shared/owned/immutable as expected); **package::module::function** id pinned; on-chain **`version` vs pinned package** (`assert_version` pre-check — see existing `isDryRunUnreliable`); Move **abort-code** classification; shared-object mutation scope; gas-coin sufficiency; PTB command whitelist |
| **stellar** | **trustline** exists + limit ≥ amount; **network passphrase**; sequence number; operation-type allowlist; memo policy; sponsored-reserve / muxed-account handling; min-balance / reserve headroom |

**Why this stays chain-agnostic.** The runner + Tier-1 checks compile against
`DecodedIntent`/`SafetyContext` only. Tier-2 richness lives behind
`ChainSafetyProvider` methods and namespace-scoped checks, so a chain contributes
its *own* safety parameters **without** the universal layer, the runner, or any
other chain's checks changing. Adding EVM's allowance rules didn't teach the
runner about ERC-20; adding Stellar trustlines won't either.

**Parameter provenance (which layer owns each param — never the LLM).**
| Param group | Sourced at | Trust basis |
|---|---|---|
| `destination`, `underlyingExpected`, allowlist, provenance | backend resolve-time | address-book + on-chain reads (§11 L1) |
| `amountIn`, `spender`, `approvalAmount`, `valueNative` | mobile build-time (adapter) | derived from the resolved target + user input |
| `minOut`, `previewOut`, `deadline` | mobile build-time | protocol's own `preview/calc/quote` view |
| `sim`, `feeEstimate`, decoded `action`/`recipient` | on-device simulate/decode | the actual built call (§11 L4) |
| policy params (tier, whitelist, caps, kill-switch) | backend + mobile | user config + ops config (§11 L3) |

No safety parameter originates from the model; the LLM supplies only `pool_id`
(§11 L0). Every param above is produced by a trusted layer and cross-checked by
the opposite trust anchor (§11.1).

### 11.6 Additional coverage domains

Seven cross-cutting protections that round out the pipeline. Each maps to an
existing layer, docks in as a `SafetyCheck` or provider method (space-docking),
and is chain-agnostic unless noted.

**1. Decimals / units correctness (Layer 2/4) — must-have.**
Assert `amountIn` was scaled with the asset's **on-chain `decimals()`** (via
`provider.readDecimals(asset)`), never a hardcoded symbol→decimals map. The
current `decimalsForSymbol` fallback in `writes.ts`/`simulate.ts` is exactly the
6-vs-18 footgun this closes: a wrong scale silently deposits 10¹² × the intended
amount. Cross-check the decoded `amountIn` against `requestedAmount ×
10^onchainDecimals`; mismatch → `decimals_mismatch`. Chain-agnostic (mint/coin
decimals read through the provider).

**2. Compliance / sanctions screening (Layer 3) — must-have (regulatory).**
Takumi is a payments product, so screen the normalized `destination` /
`recipient` (and, per policy, the user) against a sanctions/deny list before
build. A hit → `counterparty_blocked`, hard-fail, audit-logged. Universal check
over `DecodedIntent` (works on any chain's normalized addresses); the list source
is ops-config, hot-swappable like the kill-switch. This is a hard gate, not a
score.

**3. Reorg / finality policy (Layer 5).**
"Done" requires `provider.finalityDepth(chainId)` confirmations before the
position is marked settled and any dependent step (e.g. zap, auto-compound)
fires — 1 on instant-finality L2s, more on reorg-prone chains, most for
cross-chain. Until then the state is `awaiting_finality` (a pending state, not a
user error). Chain-specific depth lives in the provider.

**4. MEV / private submission (Layer 4).**
Slippage floors (§12 Q4) are the baseline; additionally, sandwich-prone kinds
(`curve-lp`, `solidly-lp`, `balancer-lp`, `router-call`) MAY route through a
private mempool / bundle when `provider.supportsPrivateSubmit()` is true. Deadline
+ `minOut` remain mandatory regardless. Optional, presence-checked per chain.

**5. Idempotency & replay (Layer 4).**
One intent → one submission. Derive a dedup key from `(wallet, pool_id, amount,
nonce-window)`; a second build within the window returns the in-flight
tx/`duplicate_submission` instead of double-depositing. Guards against
double-tap, retry storms, and agent re-invocation. Chain-agnostic (nonce/blockhash
window supplied by the provider).

**6. Velocity & anomaly detection (Layer 1 + 3).**
Two guards: (a) per-user **velocity caps** — max deposits per rolling window →
`velocity_exceeded`; (b) a **new-pool anomaly circuit-breaker** — a pool whose
APY/TVL is statistically implausible ("too good to be true", distinct from the
APY-drift check on *known* pools) is flagged → `pool_anomaly_flagged` → Manual
until reviewed. Complements the exploit-monitoring auto-kill-switch (§11 L6).

**7. Audit trail / forensics (Layer 6, cross-cutting).**
Every `SafetyResult` is logged immutably: `{ checkId, layer, param, verdict,
target, wallet, chainId, ts }` — pass **and** fail. An incident must be fully
reconstructable ("which check let this through / blocked this"). Never logs
secrets or raw signer material; PII per the app's retention policy. This is an
observability requirement, not a gate.

> Priorities: **#1 (decimals)** and **#2 (compliance)** are must-haves — the
> first prevents silent fund-loss, the second is a likely regulatory line for a
> payments app. The rest are strong hardening, sequenced with their tiers.

---

## 12. Resolved decisions (previously open)

Every prior open question is now decided, so implementation never stalls on a
judgment call. Each carries the rationale (the "why", per house style).

**Q1 — Concrete / any "is-it-really-4626" candidate.** *Decided:* no
special-casing. A Family-A candidate is admitted **iff** `validateErc4626`
passes (`asset()` matches + `convertToShares(1 unit)` doesn't revert + TVL band).
The validator **is** the verification; a non-conforming vault fails closed →
Manual. *Why:* keeps "add a 4626 protocol" a pure resolver with zero bespoke
gating, and the on-chain proof is stronger than any allowlist.

**Q2 — LST exit (queue vs DEX) blocking Tier 3.** *Decided:* LST **deposit ships
in Tier 3 regardless**; the target's `exit` field decides withdraw:
- `exit:"dex"` → withdraw routes through the swap layer with slippage bounds
  (§12 Q4). Ships in Tier 3.
- `exit:"queue"` → **deposit ships, withdraw is disabled** and the card shows
  "exit via withdrawal queue" until Tier 4 async lands; then it upgrades to
  request→claim with **no resolver/adapter change** (only the `exit` handler
  gains a branch). *Why:* never block the large LST deposit TVL on the async
  interface, and never promise an instant exit we can't honor (§8.3).

**Q3 — Venus (and any cToken fork) 4626-wrapper vs raw cToken.** *Decided:*
**prefer the ERC-4626 wrapper (Family A) when one exists** for the market; use
the `compound-v2` adapter only where no wrapper exists. Resolver order tries the
4626-wrapper resolver first, then the cToken resolver. *Why:* less bespoke code,
reuses the hardened 4626 adapter/validator; the cToken path is the general
fallback for forks without wrappers.

**Q4 — Slippage policy (LP + 4626 min-out + LST DEX-exit).** *Decided:* default
**50 bps stable / 100 bps volatile**, tightened per user tier (conservative =
25/50), with a **hard server ceiling of 300 bps** beyond which the build is
blocked (`slippage_too_high`). Mins are always computed from the protocol's own
`calc_*`/`preview*`/`quote*` view at build time. *Why:* a single, auditable
policy; zero-min is never allowed (sandwich); the ceiling caps worst-case loss.

**Q5 — Native-asset (ETH) deposits (LSTs, ETH Comet markets).** *Decided:* native
deposits set `value: amount` on the `evm-call` and **omit `needsApproval`**
(native has no ERC-20 `approve`). The Layer-4 decode assertion checks `value ==
amount` instead of an approve preamble. *Why:* correctness — an approve on a
native deposit would be a no-op and mask a mis-build.

**Q6 — Morpho Blue oracle/IRM allowlist ownership.** *Decided:* a curated
allowlist in the backend address-book (`morpho-allowlist.ts`), **seeded from
Morpho's own curated/whitelisted-market flags** via their API and reviewed on
change; the resolver rejects markets whose `oracle`/`irm` aren't on it. *Why:*
lenders inherit bad-debt risk from a bad oracle (§11 L1); trust Morpho's curation
but pin it so a silent API change can't widen our exposure.

**Q7 — Address-book vs API-sourced addresses.** *Decided:* **singleton/router**
contracts (Aave/Spark Pool, Morpho, Comet, Curve registry, Pendle/Solidly/
Balancer routers) MUST come from pinned, reviewed constants; **per-vault/market**
addresses may come from the protocol's own API **only after** passing Layer-1
identity (`asset()`/`baseToken()`/`marketId` + provenance). A CI check forbids an
adapter using an API-returned address as `tx.to` for a singleton kind. *Why:* the
router-call families are the highest-risk surface; pinning the router is the
single most important defense (§11 L1).

**Q8 — Slippage/quote staleness for router-call.** *Decided:* quotes carry a
short TTL; the executor re-fetches + re-simulates if the sign step exceeds it
(`quote_expired`). *Why:* prevents signing stale, sandwichable calldata.

---

## 13. Extending via space-docking — the add-a-protocol contract

This is the canonical reference for adding **any** future protocol/chain. The
whole system is built so a new protocol **docks in by registration alone** —
**never** by editing shared code. If a change requires a `switch` on
`pool.project`, an `if (namespace === …)`, or a new branch in the executor/
registry/runner, it is **wrong by construction** — the extension point already
exists; find it.

### 13.1 The three registries (the only docking ports)
| Registry | File | Docking call | Adding… |
|---|---|---|---|
| **Target resolvers** (backend) | `api/.../targets/registry.ts` | `registerResolver(r)` | a pool → `DepositTarget` mapper |
| **Family adapters** (mobile) | `services/defi/registry.ts` | `registerDefiAdapter(a)` | a `DepositTarget.kind` → `UnsignedCall` builder |
| **Safety** (mobile) | `services/defi/safety/registry.ts` | `registerSafetyCheck(c)` / `registerChainSafetyProvider(p)` | a check (any chain) / a chain's primitives |

Routing is **data-driven, never nominal**: resolvers match by
`family`/`aliases`/`externalSlugs`; adapters route by `target.kind` via
`targetKinds`; safety checks select by `appliesTo:{namespaces,kinds}`. No shared
file learns the new protocol's name.

### 13.2 Decision tree — where does my new protocol dock?
```
Is deposit/withdraw ERC-4626 (deposit/redeem)?                  → Family A:
  ├─ yes → resolver only, emit { kind:"erc4626" }.  DONE (no adapter, no kind).
  └─ no ↓
Is it an Aave-v3-fork pool (supply/withdraw on a Pool)?         → Family B:
  ├─ yes → resolver only, emit { kind:"aave-v3", pool, asset }.  DONE.
  └─ no ↓
Does an existing kind already fit its ABI                        → resolver only,
   (compound-v3 / compound-v2 / morpho-blue / curve-lp /            emit that kind.
    solidly-lp / balancer-lp / lst-stake / router-call)?           DONE.
  └─ no ↓
Genuinely new ABI shape?                                         → NEW family:
   1 new kind in BOTH union files + 1 family adapter (targetKinds)
   + 1 validator + 1 resolver.  Register all three.  DONE.
```
Rule of thumb: **~90% of new protocols are "resolver only"** — they reuse an
existing kind/adapter/validator. A new adapter is required only for a genuinely
new on-chain calling convention.

### 13.3 Steps to add a protocol (resolver-only, the common case)
1. Write `foo.resolver.ts` (copy the closest sibling): match `family`/`aliases`,
   map `(chain, underlyingTokens[0], poolMeta)` → the existing kind, `ctx.validate`.
2. `registerResolver(FooResolver)` in `targets/bootstrap.ts` behind its tier flag.
3. Add any pinned singleton addresses to the reviewed address-book (§12 Q7).
4. `*.resolver.spec.ts`: real pool fixtures resolve; ambiguous → `null`.
5. Runbook entry. **No adapter, no union, no executor, no safety change.**

### 13.4 Steps to add a genuinely-new family (new kind)
Everything in 13.3, plus: add the `kind` to **both** union files (CI parity
test), a `FooAdapter` with `targetKinds:["foo"]`, a `validateFoo` in
`validation.ts` (Layer 1) + its Layer-4 decode case, and a Layer-5 pause read.
Register the adapter in `defi/bootstrap.ts`. This is the **only** path that
touches shared type files, and even then via addition (a new union member),
never modification of existing members.

### 13.5 Steps to add a new CHAIN (not a protocol)
Implement + `registerChainSafetyProvider` one `ChainSafetyProvider` (§11.0b, all
seven primitives) and the chain's adapters/resolvers. **Every provider-backed
safety check covers the chain automatically, with zero edits to any check or the
runner** (§11.3). A partial provider registers read-only/Manual until `simulate`
+ `decodeIntent` are trustworthy.

### 13.6 The invariants that keep docking safe (never regress these)
- Fail-closed: unresolved/unvalidated → `null` → Manual. Never guess.
- No LLM-supplied addresses; target re-fetched server-side by `pool_id`.
- Two independent trust anchors (backend + on-device) must agree (§11.1).
- No shared-code branch on protocol/chain name — route by `kind`/`aliases`/
  `appliesTo` only.
- A family goes live only past the §11.3 minimum bar.

> **Extensibility guarantee:** after this spec lands, onboarding the *next* EVM
> yield protocol is, in the common case, **one resolver file + one registration
> line + one test** — and onboarding the next *chain* is **one provider**. That
> is the whole point of the docking model: breadth grows without the shared
> surface area growing.

---

## Sources (official docs)

- ERC-4626 — https://ethereum.org/developers/docs/standards/tokens/erc-4626
- ERC-7540 (async vaults) — https://github.com/ethereum/ERCs/blob/master/ERCS/erc-7540.md ·
  https://docs.openzeppelin.com/community-contracts/erc7540
- Compound III (Comet) — https://docs.compound.finance/collateral-and-borrowing/ ·
  https://docs.compound.finance/helper-functions/ · https://docs.compound.finance/account-management/
- Morpho Blue — https://docs.morpho.org/get-started/resources/contracts/morpho/ ·
  https://docs.morpho.org/build/borrow/tutorials/assets-flow/
- Euler v2 (EVK, ERC-4626) — https://docs.euler.finance/developers/evk/ ·
  https://docs.euler.finance/developers/evk/interacting-with-vaults/
- Spark / Sky savings (sUSDS, sDAI) — https://docs.spark.fi/dev/savings/susds-token ·
  https://docs.spark.fi/dev/savings/sdai-token
- SparkLend (Aave-v3 fork Pool, spToken) — https://docs.spark.fi/dev/sparklend/core-contracts/pool ·
  https://docs.spark.fi/dev/sparklend/tokens/sptoken
- Venus (vToken Compound-v2 + VenusERC4626) — https://docs-v4.venus.io/technical-reference/reference-core-pool/vtoken ·
  https://docs-v4.venus.io/technical-reference/reference-technical-articles/venus-erc-4626
- Fluid (fToken ERC-4626) — https://docs.fluid.instadapp.io/ ·
  https://docs.fluid.instadapp.io/autogenerated-docs/protocols/lending/fToken/main.sol/abstract.fTokenCore.html
- Rocket Pool (rETH deposit) — https://docs.rocketpool.net/developers/usage/contracts/contracts.html ·
  https://docs.rocketpool.net/guides/staking/via-rp.html
- ether.fi (eETH/weETH, LiquidityPool) — https://etherfi.gitbook.io/etherfi/staking/eeth ·
  https://etherfi.gitbook.io/etherfi/contracts-and-integrations/deployed-contracts
- Aerodrome / Velodrome (Solidly LP) — https://docs.velodrome.finance/liquidity
- Pendle Hosted SDK — https://docs.pendle.finance/Developers/Backend/BackendAndHostedSDK ·
  https://docs.pendle.finance/pendle-v2-dev/Backend/HostedSdk
- Curve — https://docs.curve.finance/
- Data source — DeFiLlama yields (`yields.llama.fi/pools`) + protocols
  (`api.llama.fi/protocols`), snapshot 2026-08-15.
