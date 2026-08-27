# DeFi address-book security sign-off — procedure and record

**Owner:** Security (sign-off) + DeFi Strategies (preparation).
**Object of review:** every pinned address in
`api/src/strategies/targets/address-book/`.
**Satisfies:** `docs/runbooks/add-defi-pool-resolver.md` §12.3 requirement 5,
`docs/defi-evm-protocol-expansion-spec.md` §12 Q7,
`api/src/strategies/targets/address-book/README.md` "Changing anything here".

> **This is the one production requirement that no test can produce.** Every
> other item in §12.3 is a command someone runs. This one is a human reading a
> protocol's own documentation and comparing it, character by character, to a
> constant in our repo. If it is skipped, nothing goes red.

---

## 1. Why this cannot be skipped

Read this section before deciding the step is bureaucracy. It is not a
formality that has never caught anything: **the first time it was run properly
it found three wrong addresses out of 125**, one of them in the single largest
lending protocol on Ethereum.

### 1.1 A green test suite says nothing about this

The pipeline has real depth — Layer-1 pinning, on-chain identity validators,
fork tests that execute the device's own calldata, a checksum guard in
`address-book.spec.ts`. All of it answers **"do these bytes work?"**

Sign-off answers a different question: **"is this address the contract we
believe it is?"** A fork test against a pinned address proves the calldata is
well-formed *for that address*. If the address is wrong, the fork test is green
and the deposit is wrong. The test cannot tell the difference, because the
address is its premise, not its subject.

### 1.2 Fail-closed is a safety net, not a detector

Every finding below is *fail-closed*: the validator rejects the target and the
pool degrades to the Manual deep-link. No user funds were ever at risk.

That is exactly why these bugs survived. A wrong pin does not crash, page
anyone, or show up in a dry run as an error — it shows up as **a pool that is
quietly Manual**, which is indistinguishable from "this pool was never ours".
The system's best safety property is also its best camouflage. Sign-off is the
only step that looks at the addresses themselves rather than at outcomes.

**Corollary:** "it has been Manual for months and nobody complained" is
evidence *for* running the review, not against it.

### 1.3 The checksum guard gives false assurance — measured, not theorised

`address-book.spec.ts` asserts every address is valid EIP-55 and its comment
claims this "catches hand-edits". `lending.ts` leaned on that explicitly:

```
// Casing corrected to EIP-55; byte-identical to the form Compound's docs
// publish, which is not checksummed (address-book.spec.ts enforces the
// checksummed form so a future typo is caught by the checksum).
```

That reasoning is wrong, and Finding 1 is the proof. The pinned cWETHv3 address
is a **valid EIP-55 checksummed address** that has **no code on Ethereum at
all**:

```
$ getAddress("0xa17581a9e3356d9dce248e3a0b3a532e28d7f5a9")
  0xa17581A9e3356D9Dce248e3A0B3a532E28D7F5A9   ← as-written, checksum PASSES
```

A checksum only detects corruption of an address that was *already correct and
already checksummed*. Re-checksumming a mistyped address mints a fresh, valid
checksum over the mistake and launders it into something that looks
machine-verified. **The guard cannot fail on any finding in this document.**

### 1.4 An address book records a trust decision, not just bytes

Finding 2 is not a typo. Radiant's pinned pool is wrong *and* Radiant has been
wound down since June 2026 after a DPRK-attributed $50M exploit. Correcting the
address would have made things worse: it would newly enable deposits into a
protocol in maintenance mode. Only a human reading the protocol's own
communications catches that, and no address diff would have surfaced it.

This is the real content of the step. "Is this the right address?" is the easy
half. "**Should we be sending user funds here at all?**" is the half that needs
a person.

### 1.5 The comments in the book can actively mislead

`vaults.ts` carried this above the Origin entry:

> **Every Origin pool DeFiLlama publishes is currently Manual, and that is
> correct — do not re-investigate.**

The explanation given was pool-side (DeFiLlama's `underlyingTokens` don't match
the wrappers), and it was accurate as far as it went. But for `wOUSD` there was
*also* a book-side defect (Finding 3): the pinned "vault" is Origin's governance
token. The instruction not to re-investigate is what kept it hidden.

**Treat a "do not re-investigate" comment as unreviewed until sign-off has
confirmed the addresses it is defending.** A conclusion is only as good as the
constants it was reasoning about.

### 1.6 The one automated check that *could* have caught this had never been run

`address-book-drift.spec.ts` is the on-chain half of the guard, and its own
header states it checks `Comet baseToken() is non-zero`. That is precisely
Finding 1: the pinned `cWETHv3` has no code, so `baseToken()` reverts.

**It would have caught it. It had simply never been run.** The spec is gated
behind `ADDRESS_BOOK_DRIFT=1` plus a `STRATEGIES_RPC_URL_<chainId>` for every
chain, and its docstring says "Run it nightly." Nothing runs it nightly. Its
first execution — during this review, 2026-08-21, public RPCs, all ten chains —
returned **13 outstanding drifts**, none previously known. They are Findings 5
and 6 below.

> **A control that is opt-in, absent from CI, and needs ten environment
> variables is not a control.** It is a script someone wrote once. Either wire
> the drift spec into a scheduled job or accept that sign-off is manual — but
> do not count it as coverage twice.

---

## 2. Scope and method

### 2.1 Scope

All **125 distinct addresses** in `address-book/`:

| File | Distinct addresses | What they are |
|---|---:|---|
| `lending.ts` | 28 | Aave v3 + fork `Pool`s, Comet markets, Morpho singletons |
| `vaults.ts` | 27 | Pinned ERC-4626 vaults and their declared underlyings |
| `dex.ts` | 16 | Routers, factories, Vaults, position managers, queries |
| `lst.ts` | 11 | LST entry contracts and receipt tokens |
| `oracles.ts` | 33 | Morpho oracle factories + reviewed Chainlink feeds |
| `registries.ts` | 10 | Discovery registries and Comptrollers |

### 2.2 The bar each address had to clear

Per `address-book/README.md`:

1. Sourced from the protocol's **own** documentation or deployment registry —
   never a block-explorer label, never an aggregator.
2. Cross-checked against a **second official source**.
3. Where a second first-party source did not exist, an **on-chain identity
   read** was used as corroboration and the gap is recorded explicitly below.

Aggregator-only provenance (DeFiLlama `yield-server` adaptors, vaults.fyi,
stakingrewards) is recorded as **not meeting the bar**, even when the address
turns out to be right. Several book comments admit aggregator provenance; those
entries are called out in §5.

### 2.3 Sources actually used

First-party deployment registries and docs, e.g.
`bgd-labs/aave-address-book`, `compound-finance/comet` `deployments/*/roots.json`,
`docs.morpho.org`, `sparkdotfi/sparklend-deployments`,
`sparkdotfi/spark-address-registry`, `seamless-protocol/gov-proposals`,
`zerolend/docs.zerolend.xyz`, `balancer/balancer-deployments`,
`Uniswap/docs`, `pendle-finance/pendle-core-v2-public`,
`aerodrome-finance/{contracts,docs}`, `velodrome-finance/contracts`,
`curvefi/curve-api`, `Instadapp/fluid-deployments`, `euler-xyz/euler-interfaces`,
`mds1/multicall`, `compound-finance/compound-protocol`,
`VenusProtocol/vips`, `moonwell-fi/{moonwell-contracts-v2,moonwell-sdk}`,
`docs.benqi.fi`, `rocket-pool/docs.rocketpool.net`,
`etherfi-protocol/smart-contracts`, `staderlabs.gitbook.io`,
`lidofinance/lido-js-sdk`, `mantle-lsp/contracts`, `sky-ecosystem/spells-mainnet`,
`docs.avantprotocol.com`, `40-Acres/docs`, Binance support docs, and
Chainlink's reference-data directory.

On-chain corroboration used public RPCs and read-only calls
(`getCode`, `getReserveData`, `getReservesList`, `asset`, `symbol`, `name`,
`baseToken`, `getAllFTokens`, `get_id_info`, plus EIP-1967 / legacy proxy slot
reads and PUSH4 selector scans).

---

## 3. Verdict summary — sign-off 2026-08-21

| Family / group | Addresses | Verdict |
|---|---:|---|
| Aave v3 `Pool` (10 chains) | 10 | **PASS** |
| SparkLend (Ethereum, Gnosis) | 2 | **PASS** |
| Seamless (Base) | 1 | **PASS** |
| ZeroLend (Linea) | 1 | **PASS** |
| **Radiant (Arbitrum)** | 1 | **FAIL — remove family (Finding 2)** |
| Avalon | 0 | **PASS** (deliberately empty, correct) |
| **Compound III / Comet** | 16 | **15 PASS, 1 FAIL (Finding 1)** |
| Morpho Blue singletons | 2 | **PASS** |
| Sky savings (sUSDS, sDAI) | 2 + assets | **PASS** |
| Spark Vault V2 (4 vaults) | 4 + assets | **PASS** |
| **Origin (wOETH, wOUSD)** | 2 + assets | **wOETH PASS, wOUSD FAIL (Finding 3)** |
| Avant (savETH, savBTC, savUSD) | 3 + assets | **PASS** |
| 40 Acres (Base, Optimism) | 2 + assets | **PASS** |
| **Avantis (avUSDC)** | 1 + asset | **PASS** (first-party source obtained, Finding 4 resolved) |
| Curve `AddressProvider` | 1 | **PASS** (address correct and deterministic) |
| Curve `METAREGISTRY_ID` | id | **FAIL → FIXED** — read the wrong registry on Polygon (Finding 6) |
| Pendle Router v4 address | 1 | **PASS** (correct on all 5 deployed chains) |
| Pendle router **allowlist scoping** | — | **FAIL → FIXED** — was chain-blind (Finding 5) |
| Uniswap v3 position managers | 5 | **PASS** |
| Uniswap v4 position managers | 2 | **PASS** |
| Aerodrome router + factory | 2 | **PASS** |
| Velodrome v2 router + factory | 2 | **PASS** |
| Balancer v2 Vault + chain set | 1 + 7 chains | **PASS** (Sonic correctly dropped) |
| Balancer v3 Vaults | 2 | **PASS** |
| `BalancerQueries` (7 chains) | 7 | **PASS** |
| Multicall3 | 1 | **PASS** |
| Euler `GenericFactory` | 1 | **PASS** |
| Fluid `LendingResolver` (4 chains) | 4 | **PASS** (see §5.2 note) |
| Comptrollers (Venus, Benqi, Moonwell, Compound v2) | 4 | **PASS** |
| LST venues (7 venues) | 11 | **PASS** |
| Morpho Chainlink oracle factories | 2 | **PASS** |
| Chainlink feeds | 31 | **PASS — 0 discrepancies** |

**Result: 121 of 125 addresses signed off on first pass. 3 wrong addresses, 1
provenance gap, plus 2 scoping defects found by the first on-chain drift run.
All six findings are now closed — 125/125 addresses signed off**, pending a
named counter-signature and the operational item in §1.6.

The three *address* failures were fail-closed: they silently removed coverage
we believed we had, but risked no funds. **Findings 5 and 6 are the ones to
read first**, because neither was fail-closed:

- **Finding 5** — a control that was too permissive, in the table the codebase
  itself calls its highest-risk: the Pendle allowlist approved a codeless `to`
  on five chains.
- **Finding 6** — Curve read the **wrong registry** on Polygon and got a
  successful answer, so a pool candidate came from the wrong pool set with no
  error raised.

Both had a guard that *appeared* to cover them and did not — see §1.3 and the
end of Finding 6. That pattern, not any individual address, is the main
takeaway from this review.

---

## 4. Findings

### Finding 1 — Ethereum `cWETHv3` is pinned to an address with no code — **HIGH**

`lending.ts`, `COMET_MARKETS[1]`.

| | Address |
|---|---|
| Pinned | `0xa17581A9e3356D9Dce248e3A0B3a532E28D7F5A9` |
| Official | `0xA17581A9E3356d9A858b789D68B4d866e593aE94` |

They diverge at the 15th hex nibble; this is a transcription error, not a
casing difference.

**Evidence**

- `eth_getCode(pinned)` → `0x` (**no contract at all** on Ethereum mainnet).
- `eth_getCode(official)` → ~1.9 KB of bytecode.
- `official.baseToken()` → `0xc02aaa…756cc2` (WETH), confirming the WETH market.
- Both strings are valid EIP-55, so `address-book.spec.ts` passes on the wrong
  one (§1.3).

**Official sources (two, both first-party)**

- `compound-finance/comet` → `deployments/mainnet/weth/roots.json` → `"comet"`.
- `compound-finance/comet` → `forge/script/marketupdates/helpers/MarketAddresses.sol`.

**Impact** — `validateCompoundV3` reads `comet.baseToken()`; against an address
with no code the call reverts, the target is rejected, and the pool degrades to
Manual. No funds at risk. Effect: **Compound III WETH on Ethereum has never
been depositable in-app**, and the failure is invisible.

**Correction**

```diff
-    "0xa17581A9e3356D9Dce248e3A0B3a532E28D7F5A9", // cWETHv3
+    "0xA17581A9E3356d9A858b789D68B4d866e593aE94", // cWETHv3
```

Delete the "casing corrected to EIP-55" comment with it — the claim it makes is
false and it is what made the address look reviewed.

---

### Finding 2 — Radiant is pinned to the wrong pool, and should be removed entirely — **HIGH**

`lending.ts`, `RADIANT_POOLS[42161]`.

| | Address | `getReservesList()` |
|---|---|---|
| Pinned | `0xF4B1486DD74D07706052A33d31d7c0AAFD0659E1` | **reverts** |
| Radiant's docs | `0xE23B4AE3624fB6f7cDEF29bC8EAD912f1Ede6886` | 15 reserves |

**Evidence**

- Pinned address has ~2 KB of code but **reverts on `getReservesList()` and on
  `getReserveData(WETH)`** — the exact call `validateAaveV3` makes.
- The documented address answers both, and `paused()` returns `false`.
- Both are proxies with different implementations.
- Radiant's own docs (`docs.radiant.capital/radiant/contracts-and-security/arbitrum-contracts`)
  name `lendingPool = 0xE23B4AE3…`. The pinned value matches only a block-explorer
  label, which `README.md` rule 1 explicitly forbids as a source.

**The reason this is not an address fix**

Radiant Capital was exploited for ~$50M in October 2024 (attributed by Mandiant
to a DPRK-linked group), and on **2026-06-01 its DAO announced a wind-down**:
maintenance mode, no further development, borrow caps to zero, TVL down from
>$300M to roughly $2.2M, front-end committed only through end of 2026.

Correcting the address would take a family that currently resolves nothing and
make it resolve into a protocol that is shutting down. **Recommendation: delete
the Radiant book entry and the `RadiantResolver` registration**, or leave the
book entry empty with a comment in the style of `AVALON_POOLS`.

> This finding is the clearest argument for §1.4. Address review and venue
> review are the same review. A diff-only check passes Radiant the moment
> someone "fixes" the address.

---

### Finding 3 — Origin `wOUSD` is pinned to Origin's governance token — **HIGH**

`vaults.ts`, `ORIGIN_VAULTS[1]`.

| | Address | `symbol()` | `asset()` |
|---|---|---|---|
| Pinned as `wOUSD` | `0x9c354503C38481a7A7a51629142963F98eCC12D0` | **`OGV`** | **reverts** |
| Actual `wOUSD` | `0xD2af830E8CBdFed6CC11Bab697bB25496ed6FA62` | `WOUSD` | `0x2A8e1E67…` (OUSD) |

**Evidence**

- On-chain: pinned address returns `name()` = **"Origin DeFi Governance"** and
  reverts on `asset()`. It is an ERC-20 governance token, not a vault.
- Origin's own registry, `OriginProtocol/origin-dollar` →
  `contracts/utils/addresses.js`, labels it under a literal `// OGV` comment:
  `addresses.mainnet.OGV = "0x9c354503C38481a7A7a51629142963F98eCC12D0"`.
- The real wrapper is `WOUSDProxy = 0xD2af830E8CBdFed6CC11Bab697bB25496ed6FA62`
  (`OriginProtocol/ousd.com` → `src/constants/contractAddresses.ts`), and its
  `asset()` equals the `asset` the book already declares for this entry.
- `wOETH` (`0xDcEe70654261AF21C44c093C300eD3Bb97b78192`) is **correct** —
  confirmed as `WOETHProxy` in the same registry and `symbol()` = `wOETH`.

**Impact** — `validateErc4626` calls `asset()`, which reverts, so the target is
rejected and the pool goes Manual. No funds at risk. Had the entry been reached
by any code path that trusts the book without the validator, it would have
directed an ERC-4626 `deposit` at a governance token.

**Correction**

```diff
     {
-      vault: "0x9c354503C38481a7A7a51629142963F98eCC12D0",
+      vault: "0xD2af830E8CBdFed6CC11Bab697bB25496ed6FA62",
       asset: "0x2A8e1E676Ec238d8A992307B495b45B3fEAa5e86", // OUSD
       label: "wOUSD",
     },
```

Also soften the "do not re-investigate" comment (§1.5): the pool-side reasoning
stays true, but it must not read as a blanket instruction to skip the addresses.

---

### Finding 4 — Avantis `avUSDC` had no first-party address source — **RESOLVED 2026-08-21**

`vaults.ts`, `AVANTIS_VAULTS[8453]`, `0x944766f715b51967E56aFdE5f0Aa76cEaCc9E7f9`.

The address was always **likely correct** — on-chain it answers
`symbol()` = `avUSDC` with `asset()` = Base USDC — but it failed the provenance
bar, which is a distinct requirement from being right. Its only stated source
was DeFiLlama's `yield-server/src/adaptors/avantis`, an aggregator, which
`README.md` rule 1 does not accept.

**A first-party source was found on a second pass.** The initial search
(`docs.avantisfi.com`, `developer.avantisfi.com`, `avantis_trader_sdk/config.py`)
looked for a *static* document and concluded none existed. That was the wrong
place: Avantis publishes its registry from its own service.

```
GET https://tx-builder.avantisfi.com/addresses
  → { "chainId": 8453, "addresses": { … "tranche": "0x944766f715b51967E56aFdE5f0Aa76cEaCc9E7f9" … } }
```

**Why this endpoint can be trusted as first-party.** It is not taken on faith —
all **8 of 8** sibling addresses it returns (`tradingRouter`, `tradingStorage`,
`pairStorage`, `pairInfos`, `priceAggregator`, `usdc`, `multicall`, `referral`)
match, exactly, the table Avantis publishes in
`Avantis-Labs/avantis-trading-skill` → `contracts.md`. A payload that agrees
with the protocol's own published document on every checkable entry is the
protocol's own registry.

**Second source + on-chain tie-in.** `GET /v2/lp/state` independently returns the
same `tranche`, and its reported vault state matches the chain **exactly**:

| | API | On chain |
|---|---|---|
| `totalAssets` | `18078157898262` | `18078157898262` |
| `totalSupply` | `13331490199376` | `13331490199376` |

An exact match on live totals proves the endpoint describes *this* contract,
not merely a plausible-looking address. Avantis' SDK independently documents
avUSDC as "the ERC-4626 tranche".

**Residual caveat, recorded rather than waved through:** Avantis publishes no
*static* document naming the tranche (`contracts.md` covers trading contracts
only and says vault internals live in a private repo), so both documentary
sources are endpoints of the same first-party service. That is far above
aggregator provenance and clears the bar, but re-check if the address ever
appears in a static Avantis doc.

**Two risk notes that are product decisions, not resolver ones:**

- The book's existing observation stands: this vault is the counterparty side
  of a perps venue, so depositors underwrite trader PnL and the share price can
  fall in a way a lending vault's cannot.
- **Exit is instant but conditional.** `/v2/lp/state` exposes
  `withdrawThreshold`, documented as "utilization ceiling for withdrawals,
  1e10-scaled; withdrawals that would push utilization above it **revert**",
  set to **90%** against a current `utilizationRatio` of **~9.4%**. There is no
  lock or epoch, so `instant` is the honest verdict today, but a `"MAX"`
  withdraw can revert when the vault is heavily utilised. Captured in the book
  comment so the exit-terms copy (§11.3b, §12 Q2) does not overstate it.

---

### Finding 5 — the Pendle router allowlist is chain-blind — **MEDIUM/HIGH** *(found by the first drift run)*

`dex.ts` / `index.ts`, `routerAllowlist()`.

```ts
case "pendle":
  // One deterministic Router across every chain Pendle supports.
  return [PENDLE_ROUTER];
```

Compare the branch directly beneath it:

```ts
case "uniswap-v3": {
  const pm = UNISWAP_V3_POSITION_MANAGERS[chainId];
  return pm ? [pm] : [];        // ← chain not in the book ⇒ EMPTY allowlist
}
```

Uniswap fails closed per chain. **Pendle cannot**: it returns a non-empty
allowlist for *every* `chainId`, including chains where Pendle is not deployed.

**Evidence** — the drift run reports no code at `0x8888888888…F946` on chains
**100 (Gnosis), 137 (Polygon), 43114 (Avalanche), 59144 (Linea), 534352
(Scroll)**. Pendle's own `deployments/<chainId>-core.json` exists only for the
chains where it is deployed (1, 10, 56, 8453, 42161 confirmed).

**Why this matters more than a dead constant.** `dex.ts` describes itself as
"the highest-risk table in the address book", because the `router-call` family
executes bytes we did not author and the allowlist is *the* control:

> the ONLY thing standing between a spoofed API response and a `tx.to` that
> drains a wallet is the allowlist below

Two protections are lost on those five chains:

- `router-call.resolver.ts:43` uses `routerAllowlist(...).length === 0` as its
  fail-closed gate. For Pendle that gate can never fire, on any chain.
- `isRouterAllowlisted()` (used by `router-quote.service.ts:120` to vet the
  hosted API's `to`) will accept the pinned router on a chain where it is a
  **codeless address**. A `call` to a codeless address does not revert: attached
  value is simply gone, and an ERC-20 approval granted to it is a standing
  approval on an address that could later be occupied via `CREATE2`.

Exploitation needs a compromised or spoofed Pendle API response on one of those
chains, so likelihood is low — but eliminating reliance on likelihood is the
entire purpose of an allowlist.

**Correction** — make Pendle a per-chain map like `BALANCER_QUERIES`, keyed only
to chains with an official Pendle deployment, and return `[]` otherwise:

```ts
case "pendle": {
  const router = PENDLE_ROUTERS[chainId];
  return router ? [router] : [];
}
```

The address is the same on every chain Pendle supports; the point is that
*supported* must become data rather than an assumption.

---

### Finding 6 — `CURVE_METAREGISTRY_ID = 7` reads the WRONG REGISTRY on Polygon — **MEDIUM** *(found by the first drift run)*

`dex.ts`. The `AddressProvider` address itself is correct and genuinely
deterministic; the defect is the **id**, a single global constant applied to
every chain. Measured on chain 2026-08-21 by walking `get_id_info(0..max_id)`:

| Chain | `AddressProvider` | id 7 | Verdict |
|---|---|---|---|
| 1 Ethereum | deployed, `max_id=11` | `"Metaregistry"`, active | correct |
| 10 / 100 / 42161 / 43114 | deployed, `max_id=5..6` | id 7 does not exist | no MetaRegistry, ever |
| 56 / 8453 / 534352 | deployed, `max_id=0` | inactive | no MetaRegistry |
| 59144 Linea | **no code** | — | not deployed |
| **137 Polygon** | deployed, `max_id=7` | **`"Cryptopool Factory"`, ACTIVE, non-zero** | **wrong contract, silently** |

**Polygon is why this is not a low-severity "fails closed" note.** I first
recorded it as one and that was wrong. On Polygon the old constant resolves to
`0xE5De15A9C9bBedb4F5EC13B131E61245f2983A69`, which the AddressProvider's own
`description` calls the Cryptopool Factory, and Curve factories **also
implement `find_pool_for_coins`**. Verified live:

```
Cryptopool Factory.find_pool_for_coins(USDC.e, WETH) = 0x4Cce5169E5F30FF8D149b658495e80B95315fA62
=> the wrong-registry call SUCCEEDS (does not revert)
```

So `CurvePoolCandidateSource` did not decline on Polygon — it answered from a
narrower, different pool set than the MetaRegistry unions, with nothing
anywhere reporting an error. A user could be routed to a volatile cryptopool
where the MetaRegistry would have named a different pool with a different risk
profile.

**And the old drift assertion PASSED there.** It checked `get_address(7)` is
*non-zero*, which is true of the wrong contract. That is the same failure shape
as the checksum guard in §1.3: a check that validates a property the bug does
not violate, and therefore reads as coverage while providing none.

**Correction** — the id becomes per-chain data (`CURVE_METAREGISTRY_IDS`,
Ethereum only), callers decline when a chain is absent rather than defaulting,
and the drift assertion now requires the slot to be **active and to describe
itself as `"Metaregistry"`**.

---

## 5. Notes that are not findings

### 5.1 Deliberate omissions verified as correct

- **Avalon** — `AVALON_POOLS` is empty on purpose (Pool differs per market).
  Correct; it fails closed to Manual.
- **Balancer on Sonic (146)** — confirmed removed correctly:
  `balancer/balancer-deployments` returns **404** for `addresses/sonic.json`
  while `gnosis.json` returns 200. There is no official source for a v2 Vault
  there.
- **Sky `sUSDS` on Base/Arbitrum** — correctly absent; the book's reasoning
  (bridged token, `asset()` reverts) is sound.
- **40 Acres on Avalanche** — correctly absent. 40 Acres' own docs
  (`40-Acres/docs` → `contracts.mdx`) confirm exactly two Avalanche USDC vaults,
  `PHAR-USDC-Vault 0x124D00b1…` and `BLACK-USDC-Vault 0xC0485C4b…`, which is the
  ambiguity the code comment describes.
- **Spark `sUSDC`** — correctly excluded in favour of `spUSDC`.

### 5.2 Fluid — two official artifacts, both live

The pins match `Instadapp/fluid-deployments` → `deployments.md` → LendingResolver
**exactly on all four chains**, which is the source the code comment cites. Note
that `Instadapp/fluid-contracts-public` → `deployments/<net>/LendingResolver.json`
names a *different* address (`0x48D32f49aFeAEC7AE66ad7B9264f446fc11a1569`, the
same on every network). Both are live and return **identical** fToken sets
(mainnet 7, Base 6). No action needed; recorded so the next reviewer does not
treat the second artifact as a discrepancy.

### 5.3 wBETH — a false alarm worth recording

An initial bytecode scan of `0xa2E3356610840701BDf5611a53974510Ae27E2e1` found
no `deposit(address)` selector, suggesting the pinned
`payable-deposit-referral` shape could never execute. **That was wrong.** The
contract is a proxy using the legacy `org.zeppelinos.proxy.implementation` slot,
not EIP-1967, so the dispatcher lives in the implementation at
`0x9e021c9607bd3adb7424d3b25a2d35763ff180bb`, which does carry
`deposit(address)` (`0xf340fa01`). The venue is correct.

Lesson for the next reviewer: **scan the implementation, not the proxy**, and
check more than the EIP-1967 slot before concluding a function is missing.

### 5.4 Chainlink feeds were exemplary

All 31 pinned feeds matched Chainlink's reference-data directory on **address,
pair name, heartbeat and deviation threshold** with zero discrepancies. This is
the standard the rest of the book should be held to, and it is the strongest
evidence that the review is tractable rather than performative.

---

## 6. Sign-off status

| Requirement | Status |
|---|---|
| §12.3 #5 — every pinned address reviewed | **COMPLETE — 125/125 signed off. All six findings closed 2026-08-21** (§6.1). Outstanding: a **named counter-signature** (§7) and the operational item in §1.6 (schedule the drift spec). |

### 6.2 Addresses added after the 2026-08-21 pass

The sign-off covers the book as it stood. Every line added since carries its
own evidence here, to the same three-part bar (§2.2): the protocol's own
registry, a second official source, and the label matching.

| Address | Family | Provenance | Cross-check | Label |
|---|---|---|---|---|
| `0x036676389e48133B63a802f8635AD39E752D375D` | Kelp `entry` (LRTDepositPool) | Kelp's own on-chain registry: `LRTDepositPool.lrtConfig()` → `0x947Cb493…` | `LRTConfig.rsETH()` returns the pinned receipt below, so the two constants corroborate each other | `getRsETHAmountToMint` answers; `getTotalAssetDeposits` = 143,858 ETH, matching DeFiLlama's TVL |
| `0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7` | Kelp `receipt` (rsETH) | `LRTConfig.rsETH()` | DeFiLlama's `kelp` row names rsETH on Ethereum | `symbol()` = `"rsETH"` |
| `0x349A73444b1a310BAe67ef67973022020d70020d` | Kelp `rateViewAt` (LRTOracle, device-side) | `LRTConfig.getContract(keccak("LRT_ORACLE"))` | `rsETHPrice()` = 1.078433, the **exact inverse** of the pool's own mint quote (0.927272) | Valuation only. Not a `tx.to` |
| `0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9` | Sky `stUSDS` | Sky's on-chain **dss-chain-log** (`0xdA0Ab1e0…`, 515 entries): `getAddress("STUSDS")` | The same registry returns `SUSDS` → `0xa3931d71…` and `USDS` → `0xdC035D45…`, both matching constants reviewed independently in the first pass | `symbol()` `"stUSDS"`, `name()` `"Staked USDS"`, `asset()` = USDS, `totalAssets()` $199.9M vs DeFiLlama's $204.0M |

**Venue question asked for each** (§2.2's third part, the one that needs a
person): Kelp is a live restaking protocol with ~$1.10B staked and a working
withdrawal queue, shipped **deposit-only** because that queue is two-phase.
`stUSDS` is Sky's own savings vault, deposit-capped rather than gated, and its
round trip was **executed on a fork** rather than inferred from probes — which
is the check Avant taught us to insist on, since every structural signal on
Avant also looked correct.

---

## 10. Solana address-book security sign-off — 2026-08-27

Closes §9's Solana half. Sui (§9.3) is untouched by this pass and remains
unsigned. Same bar as §2.2, using §9.4's substitution (owning program /
type-origin package stands in for a checksummed "address").

### 10.1 Scope

Solana has no single `address-book/` directory (§9.1) — the trust decisions
are spread across the device safety provider, two adapter-side venue tables,
and their backend twins:

| Population | Where | Distinct addresses |
|---|---|---:|
| Protocol programs (Kamino Lend, Kamino kVault, Kamino kLiquidity, Raydium CPMM/AMM v4/Stable, Jito Restaking Vault, Jupiter Lend) | `services/defi/safety/providers/solana.ts` ⇄ 8 `api/src/strategies/targets/*.resolver.ts` | 8 |
| Kamino kvault venue table (2 vaults: Sentora PYUSD, Ethena Prime) | `api/.../kamino-kvault.config.ts` ⇄ `services/defi/adapters/kaminoKvault.ts` | 4 (2 vaults + 2 mints) |
| Jito "Kyros" restaking-vault pin | `api/.../jito-vault.resolver.ts` ⇄ `services/defi/adapters/jitoVaultDeposit.ts` | 1 (vault; mint is JitoSOL, counted below) |
| Solana LST venue table — 16 `spl-stake-pool` venues | `services/defi/adapters/solana/lst.config.ts` ⇄ `api/.../solana-lst.config.ts` | 35 (16 pools + 16 mints + the 3 distinct stake-pool-fork programs behind them) |
| Solana LST venue table — Marinade | same files | 3 (program + state + mSOL mint) |
| **Total** | | **51** |

`BPF_LOADER_UPGRADEABLE` (`solana.ts`, used only to assert Jupiter Lend's
program is a deployed executable) is Solana's own native loader address, not
a protocol trust decision — checked live but not counted above, the same way
the EVM pass didn't "sign off" `0x0` or a CREATE2 factory.

Individual Kamino Lend reserves, individual Raydium pools, and individual
kLiquidity strategies are **not** book entries — only the 8 programs above
are pinned for those kinds. Each instance is instead independently
owner-checked on-chain, every time, by `isAllowlisted`/`isAllowedDestination`
at deposit time. That is stronger than a static pin (it cannot go stale the
way Finding 1's `cWETHv3` did), so those instances are out of this review's
scope for the same reason §2's EVM book never lists per-market Aave reserves.

### 10.2 Method actually used

- **Cross-repo parity.** `services/defi/nonEvmPinParity.test.ts` (targeted
  single-file run, 2026-08-27: **7/7 pass**) mechanically confirms mobile and
  api agree. Per §1.1/§9.2, that proves agreement, not correctness — every
  verification below is independent of it.
- **Leg 1 (protocol's own registry).** Official npm-scoped SDK packages —
  `@kamino-finance/klend-sdk`, `@kamino-finance/kliquidity-sdk`,
  `@raydium-io/raydium-sdk-v2`, `@jito-foundation/vault-sdk`,
  `@marinade.finance/marinade-ts-sdk`, `@jup-ag/lend` — downloaded from the
  npm registry and grepped for each pinned constant. A scoped npm package
  under an org name (`@kamino-finance/*`, `@jito-foundation/*`,
  `@marinade.finance/*`) requires npm-verified ownership of that org, which is
  the same tier of first-party evidence §2.2 accepts for a GitHub org repo.
  Sanctum's own `igneous-labs/sanctum-lst-list` Rust crate
  (`rust/sanctum-lst-list/src/programs.rs`) for the three stake-pool-fork
  program ids. Kamino's own live vaults API (`api.kamino.finance/kvaults/vaults`)
  for the two kvault instances. DeFiLlama's protocol registry
  (`api.llama.fi/protocol/kyros`) for Kyros's official URL + asset, and its
  `yield-server` adaptor source for solstrategies (recorded below at the same
  below-the-bar tier §2.2 gives aggregator-adjacent provenance).
- **Leg 2 (second source / on-chain corroboration).** Live `getAccountInfo`
  against public mainnet RPC for all 51 addresses: every program confirmed
  `executable: true`, owner = the upgradeable BPF loader; every instance
  account confirmed owner = its claimed program; every one of the 16 stake
  pools had its `pool_mint` field (SPL Stake Pool layout, offset 162 — the
  same offset `adapters/solanaLst.ts` already reads, re-applied independently
  here rather than trusted) decoded and compared byte-for-byte against the
  claimed mint. A `total_lamports` read on all 16 pools additionally served
  as a liveness check (§10.4 explains why).
- **Leg 3 (venue question, §1.4).** Kamino, Raydium, Jito, Jupiter Lend and
  Marinade are re-confirmed live and operating **today** (not from training
  recall) by the fact that their own APIs/on-chain state answered with
  current, non-trivial numbers during this review (Kamino kvault
  `tokenAvailable`/`sharesIssued`, Jupiter Lend's `totalAssets`, Kyros's
  DeFiLlama TVL, all 16 stake pools' `total_lamports`). Per-brand
  reputational/incident research for each of the 16 white-label LST brands
  individually was **not** performed — see §10.6.

### 10.3 Verdict summary

| Family / group | Addresses | Verdict |
|---|---:|---|
| Kamino Lend program | 1 | **PASS** — matches `@kamino-finance/klend-sdk`'s own `programId.ts` |
| Kamino kVault program | 1 | **PASS** — matches klend-sdk's `kvault` codegen `programId.ts` |
| Kamino kLiquidity program | 1 | **PASS** — matches `@kamino-finance/kliquidity-sdk`'s `YVAULTS_PROGRAM_ADDRESS` |
| Kamino kvault instances (Sentora PYUSD, Ethena Prime) | 2 vaults + 2 mints | **PASS** — Kamino's own `/kvaults/vaults` API names both, `tokenMint` matches exactly, both live and funded |
| Raydium CPMM / AMM v4 / Stable programs | 3 | **PASS** — all three match `@raydium-io/raydium-sdk-v2`'s `src/common/programId.ts` exactly |
| Jito Restaking Vault program | 1 | **PASS** — matches `@jito-foundation/vault-sdk`'s `JITO_VAULT_PROGRAM_ADDRESS` |
| Jito "Kyros" vault instance | 1 | **PASS, with a recorded gap (Finding S2)** — on-chain + DeFiLlama asset-match only, no first-party document names the instance |
| Jupiter Lend program | 1 | **PASS** — matches `@jup-ag/lend`'s own bundled `PROGRAM_IDS.lending.main` |
| Sanctum stake-pool-fork programs (`Spl`, `SanctumSpl`, `SanctumSplMulti`) | 3 | **PASS** — all three match Sanctum's own `sanctum-lst-list` Rust crate `programs.rs` |
| 15 `spl-stake-pool` LST venues (jito/jupsol/dsol/phantom/dfdv/hylo/bonk/helius/bybit/thevault/doublezero/blazestake/jpool/binance/jagpool) | 30 (pool + mint) | **PASS** — pool, program tag and mint all match Sanctum's list exactly; on-chain owner+mint decode match; all 16 live with 100K-10.3M SOL staked (see below) |
| `solstrategies` (stkeSOL) | 2 (pool + mint) | **PASS, below the strict provenance bar (recorded, same as original pin)** — matches DeFiLlama's `yield-server` adaptor source code exactly; on-chain owner+mint match; 615K SOL live |
| Marinade program, state, mSOL mint | 3 | **PASS** — all three match `@marinade.finance/marinade-ts-sdk`'s own README account list; state's on-chain owner matches the program |

**Result: 51/51 addresses signed off, 0 wrong addresses.** Two findings
recorded, neither an address defect — see §10.4.

### 10.4 Findings

#### Finding S1 — Sanctum's canonical LST source has moved behind a key this codebase doesn't have — **MEDIUM (informational, not fail-closed)**

`igneous-labs/sanctum-lst-list`'s own `README.md`:

> **ARCHIVE NOTICE** — This repo is no longer in use. Sanctum LST metadata is
> now served from a live DB via our API at
> `https://sanctum-api.ironforge.network`.

Every endpoint on that replacement API returned `401 {"error":{"code":
"UNAUTHORIZED","message":"Missing API key."}}` during this review — this
codebase has no credential for it. Two things follow, and they cut opposite
ways:

- The **program-id constants** (`Spl`/`SanctumSpl`/`SanctumSplMulti` →
  `SPoo1Ku8…`/`SP12tWFxD9…`/`SPMBzsVUuo…`) live in the repo's compiled Rust
  crate source, not the archived data feed — those are unaffected and still
  matched exactly (§10.3).
- The **per-pool TOML rows** (pool address, mint, symbol) are a frozen
  snapshot that happened to still be fetchable from GitHub. It matched all 15
  applicable venues byte-for-byte, but Sanctum is no longer maintaining that
  file going forward. A new pool Sanctum onboards after the archive date, or
  a future pool migration, would not be caught by re-diffing against it.

This is the same shape as §1.6: a control that looks like coverage but quietly
stopped being current. **Recommendation:** whoever owns Sanctum's integration
relationship should get an `ironforge` API key before the next Solana
re-verification pass, so `sanctum-lst-list.toml` can be replaced with the live
endpoint rather than a dated GitHub snapshot.

#### Finding S2 — Jito's "Kyros" vault has no first-party document naming the specific pinned instance — **LOW (documented gap, §2.2 rule 3)**

`CQpvXgoaaawDCLh8FwMZEwQqnPakRUZ5BnzhjnEBPJv`, pinned in
`jito-vault.resolver.ts`/`jitoVaultDeposit.ts`.

Checked and came up empty: `kyros.fi`'s static HTML (client-rendered SPA, no
address in the served markup), `api.kyros.fi`, `kyros.fi/api/*`,
`kobe.mainnet.jito.network` (Jito's known stake-data API host),
`jito.network`'s public API and docs (403/404). Unlike the Jito Vault
*program* (confirmed against the official SDK, §10.3) or Kamino's kvault
instances (confirmed against Kamino's own `/kvaults/vaults` API), no
first-party source publishes which vault address is "Kyros" as a named
product.

What corroborates it instead: the account's on-chain owner is the Jito Vault
program (confirmed §10.2), and DeFiLlama's own protocol registry
(`api.llama.fi/protocol/kyros`) names the official site (`kyros.fi`) and its
one live Solana pool's `underlyingTokens` is exactly the pinned JitoSOL mint,
with a live TVL of ~$11.8M during this review — the same "payload agrees with
the protocol on every checkable point" reasoning §2.2/Finding 4 already
established as sufficient when a static document doesn't exist. Recording
this honestly as a gap rather than silently treating on-chain-only as equal
to the full three-leg bar: a future reviewer should re-check whether Kyros
ever exposes a vault-list endpoint the way Kamino does.

#### Note — Kamino's own vault label differs from the book's DeFiLlama-driven one (benign)

Kamino's `/kvaults/vaults` API names `D1XVxx4ur7kiSgpuerUmoJXvZ3yEBFZWPx1uN7qBADFb`
**"Ethena Prime"**; the book's `poolMeta` match string (sourced from
DeFiLlama, which is what the resolver actually joins against) is **"Kamino
USDG Ethena"**. Address and mint both match exactly (§10.3) — this is two
different projects' display names for the same vault, not a Finding-3-shaped
defect. Recorded so a future reviewer doesn't re-flag it as a mismatch.

#### Note — Jupiter Lend's second ("ethena") program deployment, independently corroborated

`@jup-ag/lend`'s own bundled `PROGRAM_IDS` constant confirms Jupiter Lend
segments some assets under a **second** program deployment,
`jup97Zx1NixM8UJMQFw8TtKzqTiRT3ETAJR7cVx3PfQ` (`lending.ethena`), distinct
from the pinned `lending.main` (`jup3YeL8Qh…`). `adapters/jupiterLend.ts`'s
own header already documented this exact split and reasoned that an asset
needing "ethena" would fail loudly (account-not-found) rather than silently
misroute — this review independently confirms the second program id is real
(not a hypothetical) and that all 7 live Earn assets on
`lite-api.jup.ag/lend/v1/earn/tokens` today are mainstream single assets
consistent with "main". Not a new finding; recorded as corroboration of an
already-correct call.

### 10.5 Sign-off status

| Requirement | Status |
|---|---|
| Every Solana pinned address reviewed | **COMPLETE — 51/51 addresses signed off 2026-08-27, 0 wrong addresses.** Two findings recorded (S1: a source going stale, not an address defect; S2: a documented provenance gap on one vault instance, not a wrong address). Outstanding: a **named Security counter-signature** (below) and obtaining an `ironforge` API key (S1). |

**Running total (Solana): 51 addresses signed off, 0 corrections needed.**
Tracked separately from the EVM running total in §6.2 (129 addresses) — these
are two distinct populations per §9.

### 10.6 What this pass did not cover (residual scope, stated honestly per §1)

- **Sui pins (§9.3)** — completely untouched by this pass, still unsigned.
- **Per-brand solvency/incident history** for each of the 16 LST brand names
  (Phantom, DeFi Development Corp, Hylo, BONK, Helius, Bybit, The Vault,
  DoubleZero, BlazeStake, JPool, Binance, JagPool, SOL Strategies) was not
  individually researched the way Radiant's wind-down was surfaced in §1.4/
  Finding 2. Substituted with a live on-chain liveness read instead (§10.2) —
  a materially different, weaker signal than a reputational check, and worth
  a follow-up pass if any of these venues starts carrying meaningful TVL
  through this app.
- **Finding S1's replacement source** (`sanctum-api.ironforge.network`) could
  not be queried — no API key available to this review.
- **Dynamic-resolution instances** (individual Kamino Lend reserves, Raydium
  pools, kLiquidity strategies) — by design not book entries; see §10.1.

### Sign-off log (Solana)

| Date | Reviewer | Scope | Result |
|---|---|---|---|
| 2026-08-27 | Automated review, pending Security counter-signature | 51 Solana pinned addresses: 8 protocol programs, Kamino kvault's 2 instances, Jito's Kyros vault, the 17-venue LST table (16 `spl-stake-pool` + Marinade) — full on-chain corroboration for all, first-party SDK/API/registry match for all but one instance (S2) | **51/51 PASS.** 0 wrong addresses. 2 findings (S1, S2), neither hiding an incorrect address. |

> Same rule as §7: a row here needs a **named human**. The 2026-08-27 row is
> a prepared review, not a signature — a Security reviewer countersigns after
> checking this section's evidence.

**Running total: 129 addresses.** The counter-signature in §7 covers 125; these
four are appended pending the same signature.

**This document does not by itself clear any tier for production.** §12.3 has
nine requirements; this is one. Requirement 9 (a human running the full journey
on a real device with real funds) remains outstanding and is not something this
review can substitute for.

### 6.1 Remediation applied 2026-08-21

| Finding | Change | Verification |
|---|---|---|
| 1 — `cWETHv3` | `COMET_MARKETS[1]` corrected to `0xA17581A9E3356d9A858b789D68B4d866e593aE94`; the false "checksum catches typos" comment removed | `tsc` clean; `address-book.spec.ts` 15/15; drift reports **no Comet drift** |
| 2 — Radiant | Family **deleted**: `RADIANT_POOLS`, the `radiant` entry in `AAVE_FORK_POOL_BOOKS`, and `RadiantResolver` (incl. its `TIER1_AAVE_FORK_RESOLVERS` slot). Replaced by a comment recording both disqualifying reasons | `tsc` clean; resolver + manifest specs 78/78; `radiant*` slugs now fall through to Manual |
| 3 — Origin `wOUSD` | Corrected to `0xD2af830E8CBdFed6CC11Bab697bB25496ed6FA62`; the "do not re-investigate" instruction reworded to scope it to the pool-side reasoning only | `tsc` clean; drift reports **no 4626 `asset()` drift** |
| 4 — Avantis provenance | Book comment now cites Avantis' own `tx-builder.avantisfi.com/addresses` registry (authenticated 8/8 against their published `contracts.md`), the `/v2/lp/state` second endpoint, and the exact on-chain totals match; the DeFiLlama attribution removed. Exit caveat (90% utilization ceiling) recorded | Registry cross-check 8/8; API totals === on-chain totals |
| 5 — Pendle allowlist | Added `PENDLE_ROUTER_CHAINS = [1, 10, 56, 8453, 42161]` (Pendle's own `deployments/<chainId>-core.json`, each confirmed to hold code on chain); `routerAllowlist("pendle", …)` now returns `[]` off those chains, matching the Uniswap branch | 3 new unit tests; drift clean |
| 6 — Curve id | `CURVE_METAREGISTRY_ID` → `CURVE_METAREGISTRY_IDS` (`{1: 7}`); `curveMetaRegistryId()` accessor; `CurvePoolCandidateSource` declines when a chain has no id; drift now asserts the slot is **active** and describes itself as `"Metaregistry"` | 2 new unit tests; **negative test performed**, see below |

Files touched: `address-book/{lending,vaults,dex,index,README}`,
`aave-fork.resolver.ts`, `candidates/onchain.source.ts`,
`address-book/address-book.spec.ts`, `address-book/address-book-drift.spec.ts`.

**Verification.** `tsc` clean; **124 tests across 7 suites pass**; the on-chain
drift run that reported **13 drifts before** now reports **0** across all ten
chains.

**The new Curve guard was proved to fail on real drift**, not merely to pass.
Temporarily re-adding `137: 7` to `CURVE_METAREGISTRY_IDS` and re-running the
drift spec produced:

```
curve chain=137: AddressProvider id 7 describes itself as "Cryptopool Factory",
not "Metaregistry" — the slot moved and a wrong registry would answer silently
```

The old `non-zero` assertion passed on that exact input. The temporary entry
was reverted and the book re-verified.

Findings 5 and 6 also gained **unit-level** regressions in
`address-book.spec.ts`, deliberately not left to the drift spec alone: §1.6 is
the whole reason an opt-in network check should not be the only guard.

### 6.2 Remaining sequence

All six findings are closed. What is left is not address review:

1. **Wire `address-book-drift.spec.ts` into a scheduled job** (§1.6). It already
   encodes the check that would have caught Finding 1; it just never ran. It is
   green now, so scheduling starts from a clean baseline. **Owner: Ops.**
2. Re-run `pnpm defi:dry-run --protocol compound-v3` and `--protocol origin` and
   confirm the previously-Manual pools resolve. Expect `curve` to resolve on
   Ethereum only and `pendle` on the five deployed chains — both are now the
   honest answer rather than a silent one. **Owner: Engineer.**
3. Feed the Avantis exit caveat (Finding 4: withdrawals revert above 90%
   utilization) into the exit-terms copy review. **Owner: Product.**
4. **Countersign §7.** **Owner: Security.**

Note this closes §12.3 requirement 5 only. Requirement 9 — a human running the
journey end to end on a real device with real funds — is untouched by this
review and still blocks production.

---


## 7. Sign-off log

| Date | Reviewer | Scope | Result |
|---|---|---|---|
| 2026-08-21 | Automated review, pending Security counter-signature | All 125 addresses + first on-chain drift run | **125/125 PASS.** All six findings remediated and verified (§6.1); on-chain drift 13 → 0. |

> A row here needs a **named human**. The 2026-08-21 row is a prepared review,
> not a signature: it is the evidence pack a security reviewer countersigns
> after checking the corrections landed.

---

## 8. Running the next sign-off

Re-run whenever a pinned address is **added or changed**, and re-run the whole
book before any tier flips on in production.

### 8.1 Per address

1. **Find the protocol's own registry.** In order of preference: a deployments
   repo (`*/deployments/*.json`, `*-address-registry`), the protocol's docs
   site, then its official SDK. `gh api -X GET search/code -f q='org:<org> <address>'`
   is the fastest way to find which official file claims an address — and,
   just as usefully, to prove that **no** official file does.

   **Do not stop at static documents.** Finding 4 was first written up as "no
   first-party source exists" after searching docs sites, the SDK config and
   the GitHub org. The source existed: Avantis serves its registry from its own
   API (`tx-builder.avantisfi.com/addresses`). Before concluding a protocol
   publishes nothing, check for a first-party **service** — an `/addresses`
   endpoint, an OpenAPI spec (`/openapi.json`), a tx-builder, or an SDK that
   fetches addresses at runtime rather than hard-coding them.

   **A first-party API is only as good as your ability to authenticate it.**
   Prove the payload is the protocol's by checking it against something the
   protocol already published: the Avantis endpoint agreed with their public
   `contracts.md` on 8 of 8 sibling addresses. Then tie it to the chain — an
   endpoint whose reported `totalAssets`/`totalSupply` match the contract's own
   values *exactly* is demonstrably describing that contract. An unauthenticated
   API response is no better than an aggregator.
2. **Find a second official source.** A second first-party file, a governance
   spell, an audit report. Not a block explorer, not an aggregator.
3. **Confirm the label.** The most dangerous failure is an address that is real,
   official, and *the wrong contract* — Finding 3 was a genuine Origin address
   under an official comment reading `// OGV`.
4. **Corroborate on chain.** `symbol()` / `asset()` for vaults,
   `getReserveData(asset)` for Aave-shaped pools, `baseToken()` for Comet,
   `getAllFTokens()` for Fluid. For proxies, resolve the implementation first
   (§5.3).
5. **Ask the venue question.** Is the protocol solvent, operating, and not
   winding down or in the aftermath of an exploit? (§1.4)

### 8.2 Chainlink feeds in bulk

Chainlink publishes machine-readable directories that make the whole feed list
checkable in one pass:

```
https://reference-data-directory.vercel.app/feeds-mainnet.json
https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json
```

Match `proxyAddress` and compare `name`, `heartbeat`, and `threshold * 100`
against the pinned `pair`, `heartbeatSec`, and `deviationBps`.

### 8.3 What to write down

For each address: the two source URLs, the label each source uses, the on-chain
reads, and the verdict. A verdict with no citation is not a sign-off — it is an
opinion, and the whole point of this step is that opinions are what the
automated layers already give us.

## 9. Non-EVM pins — NOT covered by this sign-off

**Status: Solana signed off 2026-08-21 → 2026-08-27, see §10. Sui remains
unsigned.** Everything in §§1-8 concerns
`api/src/strategies/targets/address-book/`, which is EVM-only. The Solana and
Sui expansions added a second population of pinned identities that had never
had an equivalent pass, and the numbers are no longer small. §10 closes the
Solana half; Sui (§9.3) is still open.

### 9.1 Where they live

Unlike EVM, they are not in one book. The trust decisions are spread across
three kinds of file, in two repos:

| Population | Where | Roughly |
|---|---:|---|
| Solana program ids | `mobile-app/services/defi/safety/providers/solana.ts` (Layer-1/L4 pins), each adapter's own constant, `api/.../*.resolver.ts` | 9 programs |
| Solana LST venue table | `mobile-app/services/defi/adapters/solana/lst.config.ts` ⇄ `api/.../solana-lst.config.ts` | 16 venues × (program, stakePool, mint) |
| Sui packages | per-venue config (`cetus/bluefin/current/kai/...config.ts`), some CONSTANT, some fetched live | 10 venues |
| Sui LST venue table | `mobile-app/services/defi/adapters/sui/lst.config.ts` ⇄ `api/.../sui-lst.config.ts` | 4 venues |

### 9.2 What is now automated (and what that does not prove)

`mobile-app/services/defi/nonEvmPinParity.test.ts` compares the two repos'
copies of the Solana program ids and both LST venue tables, the same way
`addressBookParity.test.ts` does for EVM. Read §1.1 before treating that as
coverage: **a parity test proves the two copies agree, not that either is
right.** The first EVM sign-off found three wrong addresses out of 125, and a
parity test would have called all three of them consistent.

### 9.3 The Sui-specific problem a review has to decide

Several Sui venues do not pin their call package at all — they FETCH it:
Suilend from an on-chain `UpgradeCap` (trustworthy: on-chain, from a pinned
cap id), but NAVI, Turbos, Ember and Scallop from the vendor's own HTTPS
endpoint, with a pinned fallback. A compromised or spoofed vendor endpoint
therefore chooses a `moveCall` target for us.

The device's Layer-1 check narrows this: `providers/sui.ts` verifies the target
OBJECT's on-chain type origin against the type the backend independently
resolved, so a swapped package alone does not get a deposit routed to it. It
does not close it, because a package upgrade legitimately changes the call
target while the type origin stays fixed. **This is the open question a Sui
sign-off has to answer**, and it has no EVM equivalent — an EVM address book
entry cannot change under you between two reads.

### 9.4 The bar, when the pass is run

Same three parts as §2.2, with one substitution: an on-chain identity read on
Solana means the account's **owning program** (what `isAllowlisted` checks) and
on Sui the object's **type origin package**. Aggregator provenance still does
not meet the bar. Note that most Solana pins were sourced from
`igneous-labs/sanctum-lst-list` plus a live `getAccountInfo` cross-check, which
IS a first-party-plus-corroboration story and should shorten the pass
considerably — see `add-defi-pool-resolver.md` §14.2.
