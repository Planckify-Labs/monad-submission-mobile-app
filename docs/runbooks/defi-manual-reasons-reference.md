# Why a pool stays Manual — evidence reference

**Purpose:** a fast-lookup table for "is this Manual row already investigated, or
is it a real gap?" Every entry below was verified on chain or against the
protocol's own source during the 2026-08-21/22 EVM resolver sessions. Cross-
references point at the full narrative in
[`add-defi-pool-resolver.md`](./add-defi-pool-resolver.md) and the pinned-address
review in
[`defi-address-book-security-signoff.md`](./defi-address-book-security-signoff.md).

**How to use this:** find the pool's protocol/asset row. If it's here, the
refusal is a recorded decision — read the evidence before re-investigating. If
it's not here, it's either genuinely unexamined or new since this table was
last updated (see the date on each row).

---

## 1. Compliance-gated — the protocol enforces investor eligibility on chain

| Pool | Circumstance | Evidence | First-party source |
|---|---|---|---|
| `centrifuge-protocol` — all Janus Henderson / tokenised-fund vaults (Ethereum, Base; ~$1.19B) | Real-world-asset security. `requestDeposit` from an ordinary, funded, non-whitelisted wallet reverts — this is Centrifuge's own compliance gate, not a bug in our resolver or adapter. | Fork-tested 2026-08-22 against a **recent** block (`FORK_BLOCKS_RECENT[1]`): a funded wallet's `requestDeposit(1000e18, holder, holder)` on vault `0x381f4f3b…` reverts with selector `0x8cd22d19`. Confirmed via `cast sig "TransferNotAllowed()"` → exact match. | `AsyncRequestManager.sol` line ~93, `centrifuge/protocol` (GitHub): `require(_canTransfer(vault_, address(0), controller, …), TransferNotAllowed());` — https://github.com/centrifuge/protocol/blob/main/src/vaults/AsyncRequestManager.sol |
| `maple` — Syrup USDC / Syrup USDT (Ethereum, ~$3.89B) | Permissioned lending pool. Real ERC-4626 vaults, but only allowlisted depositors can supply. | Verified on chain 2026-08-21: `maxDeposit(<ordinary address>)` returns exactly `0` on both `syrupUSDC` (`0x80ac24aA…`) and `syrupUSDT` (`0x356B8d89…`), while `asset()`/`totalAssets()`/`convertToShares()` all answer normally (i.e. a real, working vault that simply will not accept this caller). | Addresses from Spark's own registry (`sparkdotfi/spark-address-registry`); `maxDeposit` semantics are the ERC-4626 standard's own way of declaring "closed to this caller." |
| `liquid-collective` — LsETH (Ethereum, ~$778M) | Direct minting is allowlist-gated (KYC). No permissionless path exists to acquire LsETH by staking. | Recorded in `address-book/lst.ts`'s `LST_VENUES_DEFERRED` — a stake call was never built because there is no call to build. | Liquid Collective's own docs describe LsETH issuance as requiring an approved node operator / KYC'd participant flow — no public `deposit()`/`stake()` entry point exists on their issuer contract. |
| `lombard-lbtc` — LBTC (Ethereum, ~$696M) | Not a KYC gate — the mint path itself is BTC-side. Acquiring LBTC means bridging real Bitcoin in through Lombard's own bridge/custody flow; there is no EVM contract call that stakes an EVM asset into LBTC. | Recorded in `address-book/lst.ts`'s `LST_VENUES_DEFERRED`: "deposit is a Bitcoin-side flow bridged in, not an EVM stake call." No `stake()`/`deposit()` entry point exists on an EVM contract for this — nothing to pin. | Lombard's own bridge/mint architecture (BTC deposit → attestation → LBTC mint) is documented on their side, not the EVM side. |

## 2. Not permissionless — the deposit would revert for an ordinary user, independent of KYC

| Pool | Circumstance | Evidence | First-party source |
|---|---|---|---|
| Morpho Blue Vault V2s — 80 vaults, ~$478M+ across pools that route to them | Caller-gated. Every V2 vault checked refuses an ordinary deposit. | Verified 2026-08-21: 8 vaults hand-re-probed across a 500× TVL range ($542.8M → $1.2M) — all answer `totalAssets()`/`convertToShares()` normally and all return `maxDeposit(<ordinary address>) == 0`. | `api.morpho.org/graphql` `vaultV2s`/`vaultV2ByAddress` fields (Morpho's own indexer) confirm the V2 vault identity; the `maxDeposit` read is direct on-chain. |
| `pareto-credit` — USDC "FalconX" (Ethereum, ~$168M) | Not a standard ERC-4626 vault; it's an Idle-lineage senior/junior tranche token. | `AA_FalconXUSDC.asset()` **reverts** — verified 2026-08-21. A tranche token has no single "underlying asset" in the 4626 sense. | Idle Finance's tranche-vault architecture (the lineage this contract forks) — tranche tokens implement a different interface than plain ERC-4626. |
| `usd-ai` — sUSDAI "30d unlock" (Arbitrum, ~$356M) | Genuine 30-day lockup that neither exit probe can see. | Verified: no ERC-7540 interface (`supportsInterface(0x2f0a18c5)` false), no `cooldownDuration()` getter. A generic "any 4626 that validates" admission would mischaracterise this as instant-exit. | The pool's own `poolMeta` — "30d unlock" — is DeFiLlama's transcription of the protocol's stated terms; there is no on-chain getter that confirms it independently, which is exactly why it's withheld rather than guessed at. |
| `binance-staked-eth` — WBETH on BSC (~$9.02B on the slug overall) | Not a missing resolver — WBETH is deployed at the **identical address** on BSC as on Ethereum (confirmed real: `symbol()`→"wBETH", `exchangeRate()` non-zero), but the `deposit(address referral)` mint is closed there. | Verified 2026-08-22: the exact same `eth_call` (funded caller, non-zero referral, real `msg.value`) that returns a clean success (`0x`) on Ethereum bare-reverts on BSC with no reason string. `findLstVenuesForProject` keys on `(project, chainId)`, so with no BSC row in `LST_VENUES` it already refuses correctly today — nothing to build; a BSC venue row would just ship a call that reverts for every user. | Both chains' WBETH contract, read directly; DeFiLlama's own adaptor (`yield-server/src/adaptors/binance-staked-eth/index.js`) confirms it tracks `totalSupply` at this same address on both `ethereum` and `bsc`. |

## 3. Wrong product behind the same DeFiLlama slug — the deep link or the discovery source names something that isn't a deposit target

| Pool | Circumstance | Evidence | First-party source |
|---|---|---|---|
| `aave-v3` — "Umbrella" row, USDT (Ethereum, currently the only Umbrella row ingested, `poolId=a90d554a…`) | `waEthUSDT` (ERC-4626-wrapped static aToken, Aave's own safety-module staking product) is **not a listed reserve** on the main v3 Pool. | Verified on chain 2026-08-22: `Pool.getReserveData(0x7Bc34850…).aTokenAddress == 0x0` — the tuple's `aTokenAddress` field (index 8) is the zero address; `configuration`/`liquidityIndex` are also 0, confirming the reserve was never initialized on this Pool. **Checked against the live `OpportunityCache` 2026-08-22: this is the only Umbrella row currently ingested — a matching `waEthUSDC` Umbrella row does not currently exist in the feed at all, across any tier**, so that half of the original claim was ahead of what DeFiLlama is actually surfacing right now, not a live second gap. | Aave v3 Pool `0x87870Bca…` (Ethereum), read directly via `getReserveData`. |
| `aave-v3` — "Aave Horizon Market" (RLUSD) | Documented from Aave's own announcement as a separate, permissioned institutional/RWA deployment — a different `Pool` contract from the main v3 Pool, so the same `getReserveData` refusal would apply. **Correction 2026-08-22: no RLUSD/Horizon row currently exists in `OpportunityCache` at all** (checked across all three tiers) — DeFiLlama isn't currently surfacing this pool, so there is nothing live to refuse yet. Left here so the reasoning is ready the moment it appears, not presented as an active Manual row today. | No live pool row to check on-chain against (none ingested). | Aave's own Horizon Market announcement describes it as a distinct, KYC-gated deployment for institutional RWA. |
| `sky-lending` — "GROVE Farming Pool" (USDS, Ethereum, ~$166M) | The deep link names a Synthetix-style staking-rewards farm, not a vault. | Verified on chain 2026-08-22: `0x4E41488C…`'s `stakingToken()` returns USDS, `rewardsToken()` returns GROVE; `asset()`/`totalAssets()` both revert (not a 4626 contract at all). | DeFiLlama's own deep link (`widget=rewards&reward=0x4E41488C…`) names the farm directly. |
| `sky-lending` — Arbitrum `sUSDS` (~$362M) | Bridged token wrapper, not the real ERC-4626 vault. | Verified: `0xdDb46999…` answers `symbol() == "sUSDS"` but **reverts** on `asset()`, `totalAssets()`, `convertToShares()`, `maxDeposit()` — a 329-byte proxy with none of the real vault's logic. | Sky's own bridging docs describe L2 `sUSDS` as a wrapped representation, not a first-class vault deployment. |
| `sky-lending` — Maker CDP ilk rows (ETH-A/B/C, WSTETH-A/B, WBTC-A/C) | These describe collateral a user **locks to borrow** USDS, not a supply-side deposit. | Refused **by rule**, not by luck: `isSkyNonDepositRow()` matches the `<SYMBOL>-<LETTER>` Maker ilk naming convention before a candidate is even requested (`erc4626-family.resolver.ts`). Proven with `validate: true` in tests, so even a permissive validator cannot rescue these. **Checked live 2026-08-22: `OpportunityCache` currently carries only 5 `sky-lending` rows total (SDAI, STUSDS, SUSDS×2, GROVE Farming) and none of these ilk rows** — DeFiLlama isn't currently surfacing them for this slug. The refusal rule stays regardless, ready for when/if they appear. | Maker/Sky's own ilk-naming convention (used throughout their protocol docs and the Sky app itself). |
| `fluid-lending` — SUSDAI/WBTC/REUSD/PST/WEETH/CBBTC/PAXG/WSTUSR rows (Ethereum, sharing the `fluid-lending` slug) | These are collateral rows from **Fluid Vaults**, Instadapp's separate leveraged-borrow product — not the plain lending fTokens. | None of these addresses match any of the 7 real fTokens `LendingResolver.getAllFTokens()` returns (`fUSDC`, `fWETH`, `fUSDT`, `fwstETH`, `fGHO`, `fsUSDS`, `fUSDtb`). Cross-checked against Fluid's `VaultResolver.getAllVaultsAddresses()`, which returns real vault-shaped data for these same addresses. | Fluid's own `LendingResolver` and `VaultResolver` contracts (both on-chain, read directly). |
| `fluid-lending`/`fluid-lite` — ETH rows | DeFiLlama publishes the underlying as the native-ETH sentinel (`0x0`) while the real fToken's `asset()` is actual WETH/stETH. | Verified 2026-08-21/22: a labeling mismatch between the feed and the contract, not a code defect — matching on the feed's `0x0` finds nothing, correctly. | Direct `asset()` read on the fToken contract vs. DeFiLlama's `underlyingTokens` field for the same pool row. |

## 4. Genuinely different execution shape — needs a new kind or multi-step flow, not a resolver fix

| Pool | Circumstance | Evidence | First-party source |
|---|---|---|---|
| `aerodrome-slipstream` / `velodrome-slipstream` (Base/OP, ~$122–150M+) | Concentrated-liquidity generation — a position needs a tick range, a different product decision from "supply this asset." | Deliberately `reserved` in `protocols.ts` after the resolver's own substring report caught it silently answering for these slugs (2026-08-21) — the Router `addLiquidity` this family builds targets the v2 pair, not the CL pool. | Aerodrome/Velodrome's own CL pool interface differs structurally from their v2 pair interface — no `stable()` getter, a tick-range mint instead. |
| `renzo` — ezETH (Ethereum, ~$111M) | `RestakeManager` exposes a dual-overload stake shape (`depositETH()` and `depositETH(uint256)`) this codebase doesn't implement, plus a mint/collateral cap and a queue exit. | Verified on chain 2026-08-21 against the implementation behind `0x74a09653…`. | Renzo's `RestakeManager` contract, read directly. |
| `stakewise-v3` (Ethereum, ~$476M) | Multi-vault protocol whose entry contract is per-vault — needs its own registry-driven resolver, not a pinned singleton. | Not yet built; correctly stays Manual until it is. | — |
| Convex / Aura boosting | Two-leg flow (acquire the LP, then stake it) that a one-shot `UnsignedCall` cannot express, even with Tier-4's request/claim machinery — it needs a genuinely different multi-call primitive. | Documented as withheld for a **different reason** than async vaults: not "the same machinery, not shipped," but "needs a primitive that doesn't exist yet." | — |
| `avant` — savETH (Base) | Passed **every** structural check (real 4626: `asset()`/`totalAssets()`/`convertToShares()`/`maxDeposit()` all answer) — but `redeem()` reverts under an 86400s cooldown, the same shape as Ethena's `StakedUSDeV2`. | Found by **fork-executing** the exit, not by static probing — every earlier signal said ship it. `redeem()` reverts with `OperationNotAllowed()` while `cooldownDuration()` reads 86400. Withheld 2026-08-21. | On-chain, both reads performed directly against the deployed contract. |

## 5. Chain not seeded — RESOLVED for BSC/Avalanche 2026-08-22

BSC (chainId 56) and Avalanche (chainId 43114) are seeded (`Blockchain` rows,
native-currency `Token` rows) and both chains' rpc-proxy provider pairs are
live in production. `aave-v3` and `venus-core-pool` now resolve on both
chains — verified live: `aave-v3` went 25/29 → 28/29, `venus-core-pool` went
0/5 → 5/5.

**The chain row alone was not sufficient — this is the actual two-part
requirement, worth remembering for the next chain onboarded:**
1. A `Blockchain` DB row (chain-directory lookup, resolver address-book match).
2. An rpc-proxy provider pair for that chain (`chain=evm`, `network=<chainId>`)
   — without this, `getPublicClientForChain` still constructs a client (step 1
   alone looks sufficient), but every on-chain `readContract` call through it
   fails, and `validateAaveV3`/`validateCompoundV2`'s `catch { return false }`
   makes that failure indistinguishable from "genuinely not a reserve" —
   confirmed live via `rpc.takumipay.xyz` returning `"no rpc providers
   configured for evm/56"` while the same reserve read succeeded instantly
   over a direct Alchemy call. Check both, not just the `Blockchain` table,
   before concluding a newly-seeded chain "isn't picking up."

Also found + fixed on the way: `aave.resolver.ts` had its own stale,
hand-copied `AAVE_V3_POOLS` map (missing BSC entirely) instead of importing
`aaveForkPool("aave", chainId)` from the shared address book like every
sibling resolver — refactored to remove the duplicate source of truth.

Separately: two BullMQ scoring jobs (`aave-v3` BSC BTCB, `venus-core-pool` BSC
BTCB) got stuck as `"job stalled more than allowable limit"` from repeated
`node dist/main` restarts during this fix's testing — their fixed
`score-<poolId>` jobId blocked re-enqueueing until the stale `failed` Valkey
entries were manually cleared. If a specific pool still won't re-score after
a fix that should apply to it, check `bull:score-opportunities:score-<poolId>`
in Valkey for a stuck failed job before assuming the fix didn't work.

Remaining, unrelated to the chain-seed question:

| Protocol | Status |
|---|---|
| `centrifuge-protocol` Avalanche row | Still Manual by design — `CENTRIFUGE_ID_TO_CHAIN_ID` deliberately omits Avalanche (centrifugeId 5) because the chainId mapping was never independently verified. See `centrifuge.resolver.ts`'s own doc comment. |
| `bitway-earn`, `zerobase-cedefi` (BSC) | Confirmed still Manual after the chain fix, exactly as predicted — both fail their own structural checks (revert on every 4626 selector), never going to resolve regardless of chain/RPC. |
| `benqi-lending` (Avalanche) | **Resolved** — confirmed via direct `OpportunityCache` query 2026-08-22: both pools (BTC.B, USDC) have a populated `depositTarget`, `tier="balanced"`. They simply weren't in the coverage-report snapshot the same way the earlier Umbrella/Horizon rows weren't — a `"conservative"`-tier-scoped dump won't show a `"balanced"`-tier pool (§ "Reading a coverage-report dump" below). Not a gap; just read the DB directly instead of re-pulling the same tier. |
| `benqi-staked-avax` | Zero rows in `OpportunityCache` for this slug at all (checked 2026-08-22) — DeFiLlama simply isn't currently surfacing a pool under it, same class of "not presently in the ingested feed" as the Horizon/Umbrella-USDC rows in §3. Nothing to fix; re-check if/when DeFiLlama lists it again. |

## 6. Reserved by explicit spec decision — not a resolver gap at all

| Slug | Reason |
|---|---|
| `aave-v4` | Different Hub-and-Spoke Liquidity Layer architecture, not a Pool variant. Deferred by spec §1.5, not by a missing address — building this means understanding a materially different protocol from scratch. |

---

## Reading a coverage-report dump against this table

The in-app debug dump (`services/defi/__debugEvmCoverage.ts`, `logEvmCoverage`)
is scoped by two things that are easy to mistake for resolver bugs:

- **It reflects one risk tier, not the whole `OpportunityCache`.** The service
  query (`strategies.service.ts` `getOpportunities`) filters by
  `where.tier = effectiveTier` — a "conservative"-tier pull totals 112 rows
  where the full table (2026-08-22) has 382 across all three tiers. A pool
  documented in this reference as Manual can be legitimately absent from a
  given dump simply because it scored into a different tier, not because it
  stopped existing. Cross-check the DB directly
  (`SELECT tier, "chainName", "assetSymbol" FROM "OpportunityCache" WHERE
  "protocolSlug" = '<slug>'`) before treating a missing row as new information.
- **The `[assets]` bracket per protocol line is a union of every pool for that
  protocol — in-app AND Manual — not just the in-app ones.** An asset symbol
  appearing both in the summary bracket and in a `manual:` line underneath is
  not a duplicate-vault bug; it's the same symbol counted in the union and
  named again as the specific Manual instance.
- **`manualSamples` is capped at 6 lines per protocol** in the dump, so a
  protocol's printed `manual:` list can be shorter than `total - inApp`
  implies. The header count is authoritative; the printed list is a sample.

## Sign-off cross-reference

Every pinned address newly added while investigating these rows (Kelp's pool/
receipt/oracle, Sky's `stUSDS`, Centrifuge's `VaultRegistry`) is logged with its
own provenance in
[`defi-address-book-security-signoff.md` §6.2](./defi-address-book-security-signoff.md#62-addresses-added-after-the-2026-08-21-pass) —
that document is the audit trail; this one is the "why is it Manual" quick
reference.

*Last updated: 2026-08-22, alongside the Tier 1–4 EVM resolver expansion
session. New Manual rows should be checked against this table before
re-investigating a circumstance already recorded here.*
