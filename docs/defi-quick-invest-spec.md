# DeFi Quick Invest — Engineering Spec

**Status:** **Phases 0, 1 and 2 implemented (2026-08-27), not yet
device-verified.** Phase 3 (§13) deliberately NOT built — see the note at
the end of this block. All open questions resolved (§11, §12.6).

Phase 0 landed as: `services/defi/quickInvest.ts` (the §5/§6/§11
algorithm, pure) + `services/defi/quickInvest.test.ts` (§10, registered in
`vitest.config.ts`), `components/home/TakumiAgent/StructuredUI/cards/OpportunityQuickInvestCard.tsx`
with `cards/quickInvest/{AmountSlider,RiskDial,AllocationBreakdown}.tsx`,
`hooks/defi/useIdleAssetBalances.ts` (§6, §6.1, §11.4, §11.6), and the
quick/browse router inside `OpportunityListCard.tsx` (§4). Three
supporting extractions keep the two surfaces from drifting:
`services/defi/opportunityShape.ts` (`shapeOpportunity`, now shared with
`reads.ts` because §3.1's dial re-fetch produces rows itself),
`services/defi/opportunityLabels.ts` (`chainLabel`, `TIER_LABEL`), and
`isTestnetRow` moved into `services/defi/opportunityDisplay.ts`. The
deposit prompt wording is now one shared `buildDepositPrompt` so quick and
browse can never describe the same deposit differently.

Two deliberate additions beyond the spec as written:

- **The browse mode choice is session-sticky** (`useRQGlobalState`, key
  `["defi","opportunity-view-mode"]`), not per card. Reason from the
  product owner: the pool-by-pool list with hand-typed amounts is how a
  newly-registered protocol/pool gets exercised individually against the
  agent, so a tester needs it for *every* opportunity card in a
  conversation, not one tap per card. Browse mode carries a back arrow to
  return. §4's "demoted, not removed" is unchanged.
- **An explicit "nothing chosen yet" state.** §6's "empty slider" fallback
  would otherwise present the slider's own floor as if it were a
  suggestion, so with no amount, no tier and no detectable balance the
  projection reads `—`, the breakdown is hidden and the CTA is disabled
  until the user drags. Nothing is claimed that we did not compute.
**Related:** `docs/defi-pool-level-deposits-spec.md` (§9.2 — the UI invariant
this spec revises, entry-surface only), `docs/defi-strategies-spec.md`
(§8 scoring/ranking — the allocation algorithm here reuses `score`
as-is, no changes to how it's computed),
`components/home/TakumiAgent/StructuredUI/cards/OpportunityListCard.tsx`,
`agent-api/src/agents/defi/tools/opportunities.ts`,
`agent-api/src/agents/defi/systemPrompt.ts`,
`services/defi/types.ts` (`minDepositRaw` — adapter-level, §5.2),
`services/indexer/types.ts` + `hooks/queries/useTokenBalances.ts`
+ `services/indexer/boot.ts` (§6.1 — why mobile has no price source),
`api/src/strategies/external/alchemy-prices.client.ts` (§6.1 — the
source to expose), `services/tokens/prices.ts` (§6.2 FX).
For §12 (DCA v1):
`api/src/strategies/workers/auto-compound-watcher.processor.ts` and
`api/src/strategies/strategies.scheduler.ts` (the pattern it reuses),
`api/src/push/push.service.ts`, `services/push/index.ts`,
`hooks/useAgentPrefill.ts` + `components/home/TakumiAgent/AgentMode.tsx`
(`prefill`/`autoSend`), and for the chain-agnostic contract (§12.1a):
`api/src/utils/address.ts` (`canonicalizeWalletAddress`),
`api/src/blockchains/blockchain-enricher.ts` (`buildCaip2Id`),
`services/walletPresence/`, `scripts/check-chain-agnostic.sh`.
For §13 (DCA v2, future): `services/chains/evm/eip7702Guard.ts`,
`services/gasAbstraction/oneShot/oneShotRelayerProvider.ts`, skill
`public-relayer`. For §11.7 (future, diversification):
`api/src/strategies/external/zerion.client.ts`.
**Mockups:** `~/takumipay/opportunity-tool-ui-mockup/index.html` — 11
compared concepts plus the "Final Design" section at the top, which is
what §3 below implements (concept #11's slider+breakdown card, wrapped
by the 3-state entry logic).


### Phase 1 (agent-api) — landed

`src/agents/defi/tools/opportunities.ts`: `amount_usd`'s description
rewritten per §8, and `tier`'s alongside it (the same undersell applied —
the model only passed `tier` when consciously filtering, so a goal it
understood went unforwarded). `src/agents/defi/systemPrompt.ts` gained the
"pass `amount_usd` and `tier` whenever the user has stated them" rule, with
an explicit prohibition on INVENTING an amount: a guessed number reaches
the user as a pre-filled deposit amount, which is a financial suggestion
this app must not make on its own. Guarded by new cases in
`systemPrompt.spec.ts`, including that negative.

### Phase 2 (DCA v1) — landed across three repos

**api:** `RecurringInvestPlan` model + migration
`20260827000000_recurring_invest_plan`, `recurring-invest.service.ts`,
`workers/recurring-invest-watcher.processor.ts`, a daily `@Cron` in
`strategies.scheduler.ts`, and `GET/POST/PATCH /strategies/recurring-invest`
on `StrategiesController` (owner from the JWT, no wallet field on any DTO).
`StrategiesService.ensureUserStrategy` became public (§12.6 requirement 1)
and gained `getSavedTier`, so the DCA layer never touches the legacy
lowercased `UserStrategy.walletAddress` itself. `plan_not_found` added to
`DEFI_ERROR_CODES` and mirrored in mobile `defiErrors.ts`.

**agent-api:** `defi_set_recurring_invest` (write) and
`defi_list_recurring_invest` (read) in `tools/recurring.ts`, both
card-backed, plus a `human-summary` case whose wording says "remind",
never "invest". A systemPrompt section frames DCA as a reminder and forbids
calling it automatic.

**mobile:** `services/agent-executors/defi/recurring.ts`, both cards
(`RecurringInvestCard` renders `WriteApprovalGate`; `RecurringPlanListCard`
doubles as the §12.5 pause/cancel surface), the push branch in
`services/push/index.ts`, and `hooks/useAgentPrefill.ts`'s module-level
`setAgentPrefillDirect` plus a durable pending-prompt store.

Four deviations from the spec as written, each deliberate:

- **Watcher dedup is a compare-and-swap, not an event row (§12.4).** A plan
  is not a position, so mirroring the auto-compound `(positionId, kind)`
  unique constraint would have meant a whole new table. A conditional
  `updateMany` on the plan's own `nextDueAt` is strictly stronger — two
  overlapping scans cannot both win — and needs no table.
- **`ExecutorContext` gained `activeChainCaip2`.** §12.1a rule 1 requires
  CAIP-2, and `activeChainId` cannot express a Solana cluster or a Stellar
  network. Resolved through the walletKit registry's `matchesBlockchainRow`,
  so it is a registry lookup, not a namespace comparison.
- **§12.5b is handled by a durable pending prompt**, not by catching
  `authentication_required` in the landing turn. `armPendingAgentPrompt`
  persists the intent to MMKV; `AgentMode` re-arms it once a session exists
  again. One code path sends, and the intent survives an app restart during
  the sign-in detour, which a purely in-memory approach would not.
- **A generic write-card gate guard was added**
  (`StructuredUI/writeCardGate.test.ts`). §12.5 flags the missing-gate
  failure by name; a test that fails on it is the only thing that makes
  "do not repeat it" hold. It allowlists `x402_fetch` (spends inside a
  pre-signed allowance) with a stated reason, and it was verified to FAIL
  on injected drift before being trusted.

### Phase 3 (§13) — deliberately not built

Unattended recurring investing introduces a standing financial authority a
compromised relayer or scheduler could abuse periodically rather than once.
§13 says so itself and requires its own security-reviewed spec; the
schema's `executionMode` column is the forward-compat slot, and nothing
else about v1 assumes v2 exists. Building it as part of this work would be
exactly the "do not fold this into a Phase 0/1/2 PR" the spec prohibits.
---

## 1. Problem & goal

### Problem

The current default render of `defi_list_opportunities` sells the
**tool**, not the **result**: a paginated, groupable list of protocol
rows (TVL, safety score, 7d APY) that the user has to read and compare,
followed by an "Amount to deposit" section where every checked pool
needs its own manually typed `TextInput` before the submit button even
enables. This is true **regardless of what the user already told the
agent** — a user who just said "invest $750, balanced" still lands on
the same empty multi-field form as someone who said nothing at all.

### Goal

The card should lead with the outcome (a projected return and a ready
allocation), and the amount of friction between "open the card" and
"confirm" should scale with how much the user already specified — not
be a fixed number of taps every time. Manual, pool-by-pool control stays
available for users who want it; it's demoted, not removed (§4).

### Non-goals

- Changing the scoring/ranking pipeline (`defi-strategies-spec` §8).
  The allocation split (§5) is a client-side consumer of the existing
  `score` field, not a new model.
- Any new backend schema or migration. Phase 0 (§9) ships mobile-only.
- Removing or restyling the existing multi-select checkbox + Prev/Next
  list. It is preserved exactly per `defi-pool-level-deposits-spec`
  §9.2's hard rule — see §4 for how this spec stays compliant with that
  rule instead of overriding it.
- Persisted goal-tracking (mockup concept #07 — "Progress to a Goal").
  Separate feature, not scoped here.
- **Fully unattended recurring investing** (no push, no per-cycle user
  approval — see §13). Explicitly future work, not designed in this
  spec.
- **Cross-asset, portfolio-wide allocation in one action** ("invest a
  bit of everything I'm holding"). Quick Invest solves single-asset
  investing, sped up (§5.0) — depositing several *different* held
  assets into several pools at once stays on the Browse path (§4),
  which already handles it via per-row manual amounts.

This spec *does* now scope a lighter version of recurring investing
(concept #09 — "Auto-Invest Routine") as §12, once it became clear the
scheduler + push scaffolding it needs already exists and is proven in
production (the auto-compound watcher).

## 2. Current state (grounding)

- `OpportunityInput` — already defined in `OpportunityListCard.tsx` —
  carries `tier?`, `asset_symbol?`, `chain_id?`, `liquidity_profile?`,
  `amount_usd?`. These are exactly the arguments the model passed when
  it called `defi_list_opportunities`; the mobile tool-card component
  receives them verbatim as `input`.
- `agent-api/src/agents/defi/tools/opportunities.ts` documents
  `amount_usd` as *"Optional minimum-deposit filter, in USD"* and `tier`
  as *"Risk tier filter."* Both are real, load-bearing server-side
  filters today — `services/agent-executors/defi/reads.ts:245` forwards
  `amount_usd` straight into `strategiesApi.getOpportunities(...)`, and
  `api/src/strategies/strategies.controller.ts:102` consumes it. This
  matters: reusing this field for a UI projection is **not** a semantic
  conflict (a user with $750 shouldn't see pools with a higher minimum
  deposit either way), but it means Phase 1 (§8) is a description/prompt
  change, not a new field.
- The rendered card today is 100% browse-and-pick: grouped rows with a
  checkbox, a per-row manual `TextInput`, Prev/Next pagination
  (`PagerButton`), and a submit button that only enables once every
  checked row has a typed amount `> 0`.

**The signal this spec needs — did the user already say an amount, a
risk style, both, or neither — already reaches the card today.** It's
just unused for anything but pre-filtering the list. No new tool-call
plumbing is required to detect intent, only to render differently once
it's there.

## 3. Design — one card, three entry states

The card itself does not change per state — it's concept #11 from the
mockup: a live amount slider, a risk dial, a projected-return figure,
and a collapsed "View allocation" row that expands into a per-protocol
breakdown (name, chain, $ + % of total, APY). What changes is **what
the card opens showing**, driven by which `OpportunityInput` fields are
present:

| State | Trigger example | Fields present | Card opens on |
|---|---|---|---|
| **1 — Amount stated** | *"Invest $750, balanced"* | `amount_usd` **and** `tier` | The Simulator, slider and dial pre-set to what was said, projection already computed. User taps once to confirm. |
| **2 — Goal stated, no amount** | *"I want to start an emergency fund"* | `tier` only (inferred from the goal) | The same Simulator, but the slider starts at a tier-appropriate **starter default** (§6) instead of zero, and the dial is pre-set. |
| **3 — No specifics** | *"What should I do with my idle USDC?"* | neither | **Not** the Simulator — a single recommendation headline (mockup concept #05: "Recommended for your $X idle USDC", blended APY, one CTA) with a secondary "Adjust amount →" link that morphs into State 1/2, pre-filled from the detected balance. |

State 3 exists because opening an empty slider when the agent has zero
signal is no better than today's empty form — it just moves the empty
state from a text field to a slider. Leading with a concrete
recommendation gives the user something to react to (accept, or adjust)
instead of a decision to make from nothing.

### 3.1 The risk dial can't always recompute from already-fetched data

`strategies.service.ts:291` (`if (effectiveTier) where.tier =
effectiveTier;`) confirms `tier` is a hard Prisma filter server-side —
if the model called with `tier: "balanced"`, `output.data.opportunities`
contains **only** balanced rows, nothing conservative or aggressive to
fall back on. Dragging the mockup's dial to a different tier can't be a
pure client-side recompute the way dragging the *amount* slider can.

Fix: on a dial change, the card re-fetches directly — it already has
everything needed (`active_namespace`/`active_chain_id`/`chain_scope`
are in `output.data`, and the file already imports `strategiesApi`
for the dev-only `getPool` diagnostic call) — call
`strategiesApi.getOpportunities({ tier: newTier, ... })` itself,
bypassing the agent entirely, the same way the existing dev diagnostic
already calls `strategiesApi` directly from this component. This keeps
the dial genuinely live without a round-trip through the model, at the
cost of one extra network call per dial change (debounce it).

## 4. Relationship to the existing browse list (hard-rule check)

`defi-pool-level-deposits-spec.md` §9.2 states the existing card's
"look and interaction model are settled and must be preserved," and
explicitly calls out the multi-select checkbox builder and the
Prev/Next pager as things that must not be removed or restyled.

This spec does not touch either. `OpportunityListCard.tsx` becomes a
thin router between two render modes:

- **`quick`** (new, default) — renders the new
  `OpportunityQuickInvestCard` (§3).
- **`browse`** (existing, byte-for-byte unchanged) — the current
  grouped list, checkboxes, per-row `TextInput`, `PagerButton`,
  multi-select submit. Entered via a plain text link at the bottom of
  the quick card ("Browse all options →"), mirroring how mockup
  concept #05 treats the full list as an escape hatch rather than the
  default.

Nothing in §9.2's preserved list is removed, restyled, or reordered —
it's demoted from "the only surface" to "one tap away."

## 5. Allocation algorithm (client-side, no scoring changes)

### 5.0 Single-asset constraint — a gap in the original draft

The multi-row manual form this spec replaces wasn't only clunky UX —
it also happened to cover the case where the user's checked pools span
**different assets** (the shipped screenshot has USDAI, USDAI, USDC,
WST, and USDT rows on one page). A `defi_deposit` leg is denominated
in one specific asset. The existing `submitDeposit` *can* emit
multi-asset legs — each leg carries its own `p.asset_symbol` — but it
works today only because the user typed each amount **in the units of
an asset they already hold**. What does not exist anywhere on this path
is a **swap step**: splitting one USD total across three different
assets silently assumes the user holds all three (`services/swap/` is a
separate, unwired feature here).

So allocation must be **single-asset**: before scoring, resolve one
target `asset_symbol` —

1. `input.asset_symbol` if the model passed one, else
2. the asset behind State 3's detected idle balance (§6) if that's how
   the card opened, else
3. the `asset_symbol` with the best top-ranked `score` among the
   returned rows (i.e. group `output.data.opportunities` by asset
   first, then pick the best-scoring group) —

and filter `output.data.opportunities` to that one asset **before**
step 2 below. Cross-asset, "invest a bit of everything I hold in one
tap" allocation is explicitly not what Quick Invest does (added to §1
non-goals); that case stays on the Browse path (§4), which already
handles it correctly today.

### 5.1 The split, given a single-asset candidate set

Given a total amount and the (now single-asset) already-scored,
already-ranked subset of `output.data.opportunities` (safest-first,
same sort the browse list uses):

1. Filter to `in_app === true`. Manual pools can't be auto-allocated
   into — same rule the existing checkbox builder already enforces
   (only in-app pools are checkable).
2. Take the top `N` rows, where `N = clamp(floor(total / 50), 1, 3)` —
   the minimum-leg-size rule from §11.2, which subsumes the old
   `min(3, count)` and the dust-floor collapse into one expression.
   Cap by `count` when fewer rows are available.
3. `weight_i = score_i / Σscore` over the N rows — reuses the existing
   `score` field verbatim, no new ranking logic.
4. `amount_i = round(total * weight_i)`, with the rounding remainder
   folded into the **largest** leg so `Σamount_i === total` exactly (a
   naive per-leg round can under/over-shoot the total by a cent or two —
   worth a dedicated unit test, §10).
5. `blendedApy = Σ(weight_i * apy_i)`; `projectedMonthly = total *
   blendedApy / 100 / 12` (APY is stored in percent units per the
   existing `formatApy` comment). Whether this should use `apy` or the
   smoother `apy_7d_avg` is settled: **use `apy_7d_avg`** here and in
   the breakdown rows (§11.5) — the two can diverge
   meaningfully (the shipped screenshot's Gmx V2 Perps row shows 5.55%
   current vs 9.69% 7d-avg), and a "projected result" headline number
   is exactly the kind of promise that shouldn't be built on the
   noisier of the two without a deliberate choice.

### 5.2 Dust floor — a flat default, with `minDepositRaw` as a bonus

An earlier draft of this spec claimed `minDepositRaw` could carry this
generally. **It can't, and the layer matters:** `minDepositRaw?: bigint`
is declared on the **`DefiAdapter` interface**
(`services/defi/types.ts:402` — "Per-deployment minimum deposit in raw
asset units"), sitting alongside `buildDeposit`/`staticSafetyScore` as
an *optional adapter capability*. It is **not** a field on the
opportunity payload the card receives: `shapeOpportunity` in
`reads.ts` emits no minimum-deposit field at all, so
`OpportunityRow` has nothing to read. And in practice exactly **one**
adapter in the repo defines it today (`adapters/solanaJito.ts:136`,
`10_000_000n`) — it is `undefined` for essentially every row.

So the design is the inverse of that draft:

- **Primary:** the $50 minimum-leg-size rule (§11.2), i.e.
  `N = clamp(floor(total / 50), 1, 3)` — a small total naturally
  collapses to the single safest pool instead of fragmenting into dust
  legs.
- **Bonus, presence-checked:** where the row's adapter *does* expose
  `minDepositRaw`, tighten using it. The card can reach it the same way
  `reads.ts` already reaches the adapter for the `in_app` flag
  (`getDefiAdapter(o.protocolSlug)`), but it needs the asset's
  `decimals` to compare a raw `bigint` against a USD amount — so treat
  this as a refinement, not the mechanism.
- **Backstop (already exists):** `below_min_deposit` is a curated
  executor error (`api/src/strategies/errors/defi-error.ts`). The
  client heuristic exists to avoid *surfacing* that error, not to be
  the only guard against it.

## 6. Where the amount comes from, per state

- **State 1:** `amount = input.amount_usd`; `tier = input.tier` (default
  to `"balanced"` if only an amount was given).
- **State 2:** `tier = input.tier`; `amount` = the **proportional
  starter** from §11.1 — `clamp(25% of detected idle balance, $50,
  $500)`, or a flat `$100` when no balance is detectable. Note this is
  deliberately *not* varied by tier (§11.1 explains why).
- **State 3:** neither field is present. `amount` = the wallet's live
  balance of the resolved `asset_symbol`, read **client-side** via
  `useGroupedTokenBalances(address, chainId)`
  (`hooks/queries/useTokenBalances.ts`) — **not** supplied by the
  agent. This keeps the LLM out of financial arithmetic, consistent
  with the app's existing posture (e.g.
  `defi-pool-level-deposits-spec` §8: "no LLM-supplied addresses" —
  same reasoning applies to "no LLM-supplied balances"). If no
  meaningful balance is found (zero, or the asset isn't held), fall
  back to State 1 with an empty slider — today's default experience,
  not a regression.

### 6.1 Pricing — the mobile price path is a dead end today; use Alchemy via the backend

Two earlier drafts of this section were both wrong, in opposite
directions. Recording the actual state of the code because it is not
guessable from the type signatures:

- Draft A said "call `fetchTokenPrices`". **It cannot work.** The only
  provider registered in `services/indexer/boot.ts` is
  `DirectRPCProvider`, whose `getTokenPrices` throws
  `IndexerNotSupportedError`. Worse, `fetchTokenPrices` swallows that
  in a bare `catch` and returns `cached?.data ?? []` — so it fails
  **silently as an empty array**, not as an error. A naive
  implementation would ship a card showing `$0.00` with nothing in the
  logs.
- Draft B said "the balance row already carries `price`". **Typed, but
  never populated.** `TokenBalance.price` is `price?: number` and
  `useGroupedTokenBalances` does forward it, but `DirectRPCProvider`
  reads balances by multicall only — it never sets a price. So
  `item.price` is `undefined` in practice today.

`boot.ts` says so out loud: *"Additional providers (Alchemy, etc.) will
be registered here when platform task P1 is completed."* **Mobile has
no live USD price source right now.** Any part of this card that needs
one is blocked on that, and must not pretend otherwise.

**Use the Alchemy-backed price route that already exists end to end.**
Nothing needs to be built: `POST /strategies/asset-prices`
(`strategies.controller.ts:146`) is a batch USD spot-price proxy over
`AlchemyPricesClient`, documented in-repo as *"the only place Alchemy's
key is used; the mobile client never calls Alchemy directly"* — Valkey
cached, daily-budget capped server-side. The mobile client wrapper is
already written too: **`strategiesApi.getAssetPrices(queries)`**
(`api/endpoints/strategies.ts:104`), and `OpportunityListCard.tsx`
already imports `strategiesApi`.

Its request shape is a direct match for what the card holds — each
query is `{ chainId, assetSymbol, assetContract? }`, i.e. exactly
`OpportunityRow`'s `chain_id` / `asset_symbol` / `asset_contract`
(nullable `assetContract` is expected: omit it for a native coin).

Two contract details to respect:

- **Batched, max 25 queries per call** (`ArrayMaxSize(25)` on the DTO).
  Fine here — the card prices one resolved asset (§5.0), not a list.
- **`usd` comes back `number | null` and never throws.** A chain with
  no Alchemy mapping, or an asset it can't resolve, is a `null` price,
  not an error. Handle it as *"price unknown"* — show the token amount
  without a USD projection rather than rendering `$0.00` or a friendly
  error. This is the same silent-degradation trap as the dead
  `fetchTokenPrices` path above, except here it's an explicit,
  documented part of the contract.

**Scope check — smaller than it sounds.** Per §6.2 the card is
USD-denominated, and per §5.0 it resolves to a single asset, which for
most rows is a USD-pegged stablecoin. In that dominant case the price
call is skippable (1 token ≈ $1). This route is what makes the card
correct for non-stable assets — not a Phase 0 blocker for the
stablecoin flows.

### 6.2 Currency — USD, decided

**This card displays USD. No FX conversion.** Settled, not an open
question: the tool surface is USD-denominated by default, and the
assets involved are overwhelmingly USD-pegged stablecoins, so a
conversion layer would add drift without adding meaning.

Recording *why* it stays that way, because the alternative looks
tempting from the outside: the wallet does have a local-currency
concept (`getCurrencyPreference()` → `totalValueLocal` in
`computePortfolioTotal`), so mirroring it here reads like the
"consistent" choice. But `services/tokens/prices.ts` backs it with
`EXCHANGE_RATES`, a **hardcoded constant table** (`IDR: 15850`) under
the comment *"simple static fallback"* — there is no live FX feed
behind `getExchangeRate()`. That's tolerable for a current balance
readout (it drifts, but describes something the user can re-check);
it's worse for this card, whose headline is a **forward-looking
projection** the user reads as a promise. Anyone revisiting this should
treat "add local currency" as gated on replacing that static table with
a real rate source first — not as a display toggle.

## 7. Submit path — reuses existing wiring

The existing `submitDeposit` function in `OpportunityListCard.tsx`
(building a natural-language multi-leg deposit request and calling
`onUserPrompt`, which routes into the existing `defi_deposit` flow and
its approval gate) is reused as-is. The only change is what feeds it:
the computed allocation from §5 instead of the manually-typed `amounts`
state map. No new agent tool, no new approval surface, no change to
`intent.wallet` isolation.

## 8. Agent-api changes (Phase 1 — separate PR)

`amount_usd`'s current tool description ("Optional minimum-deposit
filter, in USD") undersells its new second use. Proposed rewrite:

> "The amount (USD) the user wants to invest, if they said one. Also
> used to filter out pools whose minimum deposit exceeds it — pass it
> whenever the user names a number, not only when filtering."

Plus a line in `defi/systemPrompt.ts` telling the model to pass
`amount_usd` / `tier` whenever the user states them, even outside an
explicit filter context.

This is copy-only — no schema change — but agent prompt edits carry
their own regression surface across every other flow that calls this
tool, so it should ship as its own reviewed change per the usual
`agent-api` systemPrompt process, not bundled into the mobile Phase 0
PR.

## 9. Phasing

| Phase | Scope | Blocks on |
|---|---|---|
| **0 — Mobile only** | `OpportunityQuickInvestCard` (3 states + Simulator), allocation algorithm, quick/browse router in `OpportunityListCard.tsx`, idle-balance lookup, unit tests. | Nothing — ships value even if the agent never passes `amount_usd`/`tier` (falls through to State 3 → State 1's empty-slider default, which is at parity with today). |
| **1 — Agent-api prompt tuning** | §8 description + systemPrompt rewrite so `amount_usd`/`tier` get passed more consistently. | Phase 0 shipped, so the improvement is immediately visible once this lands. |
| **2 — DCA v1 (reminder + one-tap)** | §12 — recurring-plan model, watcher/push job, deep-link into the Phase 0 Simulator pre-filled. | Phase 0 shipped (reuses the Simulator as the landing surface). Independent of Phase 1. |
| **3 — Future, out of scope** | §13 — fully unattended recurring investing (EIP-7710 delegated execution). Flagged, not designed here. | Its own security-reviewed spec. |

## 10. Testing

- **Unit (vitest):** the allocation function in isolation — the §5.0
  single-asset filter, weights sum to 1, `Σamount_i === total` after
  rounding, `in_app` filtering, and the §5.2 collapse to `N=1` (flat
  floor as the primary path, plus the presence-checked `minDepositRaw`
  refinement where an adapter supplies one).
- **`pnpm check:chains`:** the new component only reads chain-agnostic
  fields (`score`, `apy`, `in_app`) — no namespace branching expected,
  but it's the standard guardrail for anything under `components/`.
- **On-device QA:** drive all three states plus the browse-mode fallback
  through to an actual `defi_deposit` approval sheet on a dev build —
  per CLAUDE.md, this is a UI change and needs to be exercised in the
  app, not just type-checked.
- **Analytics:** emit a PostHog event per state shown and per
  quick-vs-browse choice (`services/analytics/`) — this is the metric
  that actually validates the redesign (does the quick path reduce
  drop-off between "card shown" and "deposit confirmed"), not just a
  design opinion.

## 11. Resolved decisions

Each of these was an open question in an earlier draft. They are
settled; the rationale is kept because the reasoning constrains
implementation, not just the outcome.

### 11.1 Starter amount for State 2 — proportional, not per-tier

`starter = clamp(25% of the user's detected idle balance of the
resolved asset, $50, $500)`; when no balance is detectable (non-EVM per
§11.6, or a zero balance), fall back to a flat **$100**.

**Deliberately not tier-dependent.** Scaling the default amount by risk
tier would encode "aggressive means invest more," which is a financial
suggestion this app should not make implicitly — tier decides *where*
the money goes, never *how much* the user starts with. A proportional
default is also the only one that isn't absurd at both ends: a flat
$500 is impossible for a user holding $80, and a flat $50 is noise for
one holding $50k. The clamp keeps the first-touch suggestion from
looking reckless in either direction.

### 11.2 Dust floor — one constant, expressed as a minimum leg size

**No leg smaller than $50.** So `N = clamp(floor(total / 50), 1, 3)`,
which replaces both the "flat floor" and the "collapse to N=1" rules
with a single number: $750 → 3 legs, $120 → 2 legs, $40 → 1 leg.

Expressing the floor as a *per-leg minimum* rather than a *total
threshold* is what makes it degrade smoothly instead of stepping off a
cliff at one magic total, and it directly encodes the actual concern
(a leg too small to be worth its own gas + protocol minimum). The
presence-checked `minDepositRaw` refinement (§5.2) still tightens
individual legs on the one adapter that supplies it.

### 11.3 Tool-description change ships separately

Phase 1, its own PR — not bundled into Phase 0. `defi_list_opportunities`
is a high-traffic shared tool and prompt edits regress across every
DeFi flow that calls it, while Phase 0 is designed to work without the
change (it just sees State 3 more often). Bundling would put a
mobile-UI PR behind an agent-prompt review for no delivery benefit.

### 11.4 State 3 prices a single dominant asset

Pick the **single largest USD-valued idle balance** among assets that
actually appear in the returned opportunity rows. No aggregation.

This follows from §5.0 rather than being an independent choice: since
allocation is single-asset (there is no swap step), an aggregated
"you're holding $4,000 across five tokens" headline would advertise a
number the card cannot act on in one deposit. Better to headline the
amount that is actually one tap from being invested.

### 11.5 Projections use `apy_7d_avg`, and so does the breakdown

Use `apy_7d_avg` where present, falling back to `apy`. Apply it to
**both** the headline projection and the per-protocol breakdown rows,
labelled as a 7-day average.

The headline is read as a promise, so it should rest on the smoother
figure — the shipped screenshot's Gmx V2 Perps row (5.55% current vs
9.69% 7d) shows how far the two can diverge. The reason the *breakdown*
must use the same basis is internal consistency: if rows showed current
APY while the headline was computed from 7d averages, a user who checks
the arithmetic finds a discrepancy and loses trust in the number. The
browse list (§4) keeps its existing current-APY-with-7d-context
presentation unchanged.

### 11.6 State 3 is EVM-only — a documented limitation

Verified in code, not assumed: the only registered indexer provider is
`DirectRPCProvider` (§6.1), whose `getTokenBalances` resolves chains
via `findEvmChainById`, checksums with `getAddress`, reads through
`erc20Abi` + multicall, and hardcodes `namespace: "eip155"`. It carries
a `TODO(task-05): EVM-only lookup` to that effect. For a non-EVM row
(`chain_id: 0`) it returns **`[]` silently** — no error to detect.

So idle-balance detection cannot work on Sui/Solana/Stellar today.
**Decision:** State 3 is EVM-only; on non-EVM the card opens in State 1
with an empty slider — which is exactly today's behaviour, so it is a
non-regression, not a downgrade. Do not build a fake balance path to
paper over it, and do not let the empty `[]` read as "user has no
funds" in copy.

### 11.7 Diversification awareness — deferred, not open

Deliberately excluded from v1. The allocation in §5 ranks purely by
`score`, blind to what the user already holds elsewhere.
`api/src/strategies/external/zerion.client.ts`'s `getPositions`
discovery/backfill (wired for a different reason — catching untracked
positions like Compound III, per
`project_defi_position_registration_bug_and_discovery`) already
surfaces a wallet's existing DeFi positions across protocols, and could
in principle feed a "don't concentrate further into a protocol you're
already heavy in" adjustment.

Not in v1 because it is a second data dependency *and* an unresolved
product question (should the tool actively steer users away from their
own prior choices?) stacked on top of an already-new allocation
algorithm. Revisit once Quick Invest v1 has usage data.


### 11.8 Sourcing note

Every decision above is grounded in this repo (files and line numbers
cited inline), not in vendor documentation. Alchemy's and Zerion's
public API references were **not** independently consulted — an attempt
to fetch them hit a tooling limit mid-session.

That is low-risk as written: §6.1 depends only on the *existing,
already-working* in-repo proxy (`POST /strategies/asset-prices` →
`strategiesApi.getAssetPrices`), whose request/response contract is
pinned by the DTO and the client wrapper in this codebase, not by
whatever Alchemy publishes today. §11.7's Zerion note is a deferral,
not an integration. Only if someone later bypasses the proxy and calls
either vendor directly does the upstream documentation become
load-bearing.

## 12. DCA v1 — recurring-invest reminder (mockup concept #09)

### 12.1 What this is, and what it deliberately isn't

A user opts into a recurring plan ("$25/week into Balanced"). On each
cycle the **server nudges, the user taps once to confirm, their own key
signs** — identical division of labor to the auto-compound feature
already live. **No new signing authority is created anywhere.** This is
not "automatic investing"; it's "investing with the remembering part
removed." True unattended execution is §13, explicitly out of scope
here.

### 12.1a Chain-agnostic by construction — the design contract

**"EVM first" must be an observed consequence, never a written
restriction.** The repo enforces this: `pnpm check:chains` fails the
build if anything under `components/`, `hooks/`, or `app/` contains
`namespace === "eip155"`, and the docking rule
(`feedback_space_docking`) is that new chain capabilities arrive as
presence-checked optional methods rather than branches.

DCA v1 is unusually easy to satisfy that with, because **its machinery
never touches a chain at all**: the watcher is a DB scan plus a push,
and the actual deposit is delegated to the existing `defi_deposit`
path, which already routes by namespace through the walletKit
registry. There is no signing, no RPC, no address handling anywhere in
the recurring layer. The only chain-aware surface is *how a plan
identifies its chain and its wallet* — so that is where the whole
chain-agnostic burden sits, and §12.3 handles it.

Concretely, four rules:

1. **Identify the chain by CAIP-2, not `(namespace, chainId: number)`.**
   A numeric `chainId` is an EVM-shaped key that degenerates to `0` for
   Solana/Sui/Stellar. `buildCaip2Id()`
   (`api/src/blockchains/blockchain-enricher.ts:80`) already produces
   the canonical form the app uses elsewhere, and enriched blockchain
   rows already serve `caip2Id`. Note it returns `null` for rows
   lacking the underlying data — validate at plan-creation time rather
   than storing a null chain.
2. **Canonicalize the wallet address per encoding — do not lowercase.**
   Covered in §12.3; it is the single most likely way this feature
   silently breaks on non-EVM.
3. **Derive availability from capability presence, not a namespace
   allowlist.** Whether a chain can run a recurring plan is exactly
   "does a deposit adapter exist for that venue" — the same
   `getDefiAdapter(slug)` presence check `reads.ts` already uses for
   the `in_app` flag. A new chain becomes DCA-capable by registering an
   adapter, with **zero** changes to DCA code.
4. **Mobile gates through `services/walletPresence`, role `active`.**
   Setting up a plan pins the wallet that will eventually sign, so the
   wallet on screen must be the wallet recorded — that is precisely the
   `active` role in the presence layer's vocabulary (as opposed to
   `counterparty`, which would be the wrong, laxer rule here).

**What "EVM for now" actually means**, then, is only this: EVM
namespaces are where deposit adapters happen to be registered today,
and §11.6's idle-balance detection (which merely *suggests* an amount)
is EVM-only. Both are presence-checked facts that resolve themselves as
other chains dock. Neither is expressed as a namespace comparison
anywhere.

### 12.2 Why this is in-scope now (unlike DCA v2)

`api/src/strategies/workers/auto-compound-watcher.processor.ts` +
`strategies.scheduler.ts` already implement the exact shape this needs,
in production, today: a BullMQ cron scans opted-in rows on an interval,
pushes a nudge via `PushService`, and dedups per window via a unique
`(entityId, kind)` event row so a cron that fires more than once in a
window doesn't double-nudge. DCA v1 is a new consumer of that pattern,
not a new pattern.

### 12.3 Data model (new — this phase does need a migration)

```prisma
model RecurringInvestPlan {
  id            String   @id @default(cuid())
  /**
   * Owner. Sourced ONLY from the JWT (§12.3a Rule 1) — never from a
   * request field — so it arrives already canonical and is stored
   * verbatim. Never .toLowerCase(): Solana/Stellar are case-significant.
   */
  walletAddress String
  /**
   * CAIP-2 chain id — "eip155:8453", "solana:5eykt4…", "stellar:pubnet".
   * Not (namespace, chainId): a numeric chain id is EVM-shaped and
   * degenerates to 0 elsewhere. Namespace is the prefix when needed,
   * so it is derived rather than stored twice (no drift).
   */
  caip2Id       String
  assetSymbol   String
  amountUsd     Float    // USD per §6.2 — namespace-free by construction
  tier          String   // conservative | balanced | aggressive
  cadenceDays   Int      // 7 or 30 only at launch (§12.6); Int not enum
                         // so a third option is a value, not a migration
  status        String   // active | paused | cancelled
  /**
   * "reminder" (v1, §12.1) — nudge, user taps, user's key signs.
   * Forward-compat slot for "unattended" (§13) so v2 rows coexist
   * with v1 rows instead of needing a migration. See §12.7 Axis 2.
   */
  executionMode String   @default("reminder")
  nextDueAt     DateTime
  createdAt     DateTime @default(now())

  @@index([status, nextDueAt])
  @@index([walletAddress, caip2Id])
}
```

#### 12.3a Address handling — designed out, not warned about

A new table keyed by wallet invites a `.toLowerCase()` for dedup, and
that is **wrong on two of the four namespaces**:
`canonicalizeWalletAddress` (`api/src/utils/address.ts:35`) checksums
EVM, lowercases Sui, and returns Solana (base58) and Stellar (base32
StrKey) **verbatim**, because those encodings are case-*significant*.
A plan written lowercased would never be found for its owner on those
chains — silently, with no error
(`feedback_address_case_per_encoding`).

"Remember to call the helper" is not a fix; it is a warning that
survives exactly until the next contributor. Three rules make the bug
unrepresentable instead:

**Rule 1 — the plan's owner is never an input.** `RecurringInvestPlan`
endpoints take **no wallet field in the DTO, body, or query**. The
owner comes from the JWT via the controller's existing
`getWalletAddress(req)` helper (`strategies.controller.ts:43`), exactly
as every other wallet-scoped strategies endpoint already does
(`getStrategy`, `deleteStrategy`, `getOpportunities`, `getPositions`).
A caller cannot supply a wrongly-cased address because a caller cannot
supply an address at all. This also inherits the wallet-binding posture
of `feedback_payment_jwt_binding` for free.

**Rule 2 — therefore the DCA layer never canonicalizes anything.** The
JWT's `walletAddress` was already canonicalized at issuance (the SIWx
login path passes the known `namespace` into the helper — see that
function's own doc comment). Since the value arrives canonical and is
stored verbatim, a `canonicalizeWalletAddress` call *inside* the
recurring service would be redundant at best. **Treat one appearing
there as a smell**: it means an address is entering from somewhere
other than the JWT, which is Rule 1 being violated.

**Rule 3 — the one genuine residual is the watcher, which has no
JWT.** The background processor reads `plan.walletAddress` (canonical,
per Rule 1) and joins it to push tokens to deliver the nudge. That join
is the only place two independently-produced address strings meet. The
push-registration path is documented as receiving *bare address
strings* with the namespace **inferred** rather than passed — so before
implementing, confirm the push-token table stores the same canonical
form. If it does not, canonicalize **both sides through the same
helper** at the join; never coerce one side with `.toLowerCase()` to
make it match.

**Backstop.** If you find yourself typing `.toLowerCase()` on an
address anywhere in this feature, stop — the answer is one of the three
rules above, not a case coercion.

Dedup for nudges reuses the same `kind = "recurring_invest_nudge:<bucket>"`
event-row pattern the compound watcher already uses (§12.2) rather than
inventing a second mechanism.

### 12.4 Backend

- New processor `recurring-invest-watcher.processor.ts`, structurally a
  copy of `auto-compound-watcher.processor.ts`: scan
  `RecurringInvestPlan` where `status = "active" AND nextDueAt <= now`,
  push *"Time to add $25 to your Balanced mix"*, advance
  `nextDueAt += cadenceDays`, write the dedup event row. **The query
  and the push are namespace-free** — the processor never inspects
  `caip2Id` beyond joining it for the chain's display name, and it
  never touches a chain. That is what makes this layer chain-agnostic
  for free (§12.1a).
- New `@Cron` entry in `strategies.scheduler.ts` enqueuing the watcher
  (daily cadence is enough granularity for weekly/monthly plans).
- New endpoints to create/pause/cancel a plan (mirrors the existing
  `UserStrategy.autoCompound` toggle's CRUD shape). The owner comes
  from `getWalletAddress(req)`, never from the DTO (§12.3a Rule 1).
  Create validates that `caip2Id` resolves to a known blockchain row
  (`buildCaip2Id` can yield `null`, §12.1a).
- Per the app-wide rule, none of these surfaces leak vendor or
  infrastructure detail into push copy — product-level wording only.

### 12.5 Mobile

- New agent write tool (e.g. `defi_set_recurring_invest`) with
  `{ amount_usd, tier, cadence }`, executor calls the new create
  endpoint. The executor — not the model — supplies the wallet and
  `caip2Id` from the active wallet, gated through
  `services/walletPresence` with role **`active`** (§12.1a rule 4):
  the plan pins the wallet that will sign later, so it must be the
  wallet the user is actually looking at. `counterparty` would be the
  wrong, laxer rule here. **Hard requirement, called out because it's
  been missed before:** the tool's StructuredUI card must itself render
  `WriteApprovalGate` — capability:write tagging alone does not surface
  a confirmation prompt (this is exactly the gap that shipped
  `bridge_execute` without a gate; do not repeat it here). Setting up a
  standing recurring plan is a write action even though no funds move
  at setup time.
- Push tap → deep link. Concretely, **not** a new screen: the Simulator
  only ever renders inside a Takumi Agent chat turn today (it's a
  `StructuredUI/cards/*` component, not a standalone route), and
  `hooks/useAgentPrefill.ts` already provides exactly the channel this
  needs — `{ text, autoSend }`, consumed by `AgentMode.tsx`, where
  `autoSend: true` "fires the prompt straight into a new turn"
  (documented use: capability / spotlight / quick-prompt cards). The
  push payload carries a plan-derived prompt (e.g. *"Invest $25 into my
  Balanced mix"*) and a new branch in `services/push/index.ts`'s
  existing `addNotificationResponseReceivedListener` — which already
  pattern-matches payloads and `router.push`es per type (payout /
  points / transfer branches are there today) — hands it over. That
  lands on the normal `defi_list_opportunities` → State 1 path (§3)
  exactly as if the user had typed it. **No new deposit UI, no new
  navigation primitive.**

  **One real wiring constraint, flagged because it isn't obvious:**
  `useAgentPrefill` is a **React hook** (backed by `useRQGlobalState`),
  while the push listener is **module-level, outside React** — it
  cannot call the hook. The prefill has to be written straight into the
  shared React Query cache the hook reads
  (`queryClient.setQueryData(["agent-prefill-prompt"], { text, autoSend:
  true })`), which means the push module needs access to the
  `queryClient` singleton. Confirm that access exists before committing
  to this route; if it doesn't, the alternative is a small
  module-level setter exported alongside the hook, writing the same
  cache key. Either way the *consumer* (`AgentMode`) is unchanged.

  Navigation still matters too: `AgentMode` lives under the home pager,
  so the branch must route home **and** set the prefill, not just set
  it.

  The user still taps "Use This Plan" and approves through the existing
  `defi_deposit` flow (§7) — the recurring plan only ever produces a
  pre-filled reminder, never a submitted transaction.
- Plan management (pause/cancel) — a settings toggle is enough for v1;
  doesn't need its own agent tool.

#### 12.5b Session expiry — the failure mode unique to DCA

DCA **adds no new authentication requirement**: `StrategiesController`
carries `@UseGuards(JwtAuthGuard)` at the class level, so every
strategies endpoint — including `getOpportunities` — is already authed,
and `OpportunityListCard` already renders a *"Sign in to explore DeFi"*
state for it. A signed-out user cannot see the opportunity list at all
today. Rule 1 (§12.3a) inherits that posture rather than imposing
anything.

What *is* new is the **time gap**. Every other flow authenticates and
acts within one session. A DCA nudge fires days or weeks after setup,
by which point the JWT may have expired with silent refresh failing —
which the executor reports as `authentication_required` (`utils.ts:140`).
Without handling, tapping the reminder lands the user in an agent turn
that immediately dead-ends on a sign-in error, having promised action.

Requirements:

- **The prefill must survive re-authentication.** If the landing turn
  hits `authentication_required`, route to `/auth` and resume the
  prefilled prompt afterwards — do not drop it. A reminder that loses
  its own intent after login is worse than no reminder.
- **The watcher keeps nudging regardless of session state**, and that
  is correct: push-token registration is independent of the JWT, the
  server cannot know a device's session died, and the plan is still
  valid. The fix belongs entirely on the landing side.
- **Copy stays outcome-shaped.** Per the user-facing-error rule, the
  user sees friendly sign-in copy, never a 401 or a raw error.

Worth exercising deliberately in QA (§12.8): set up a plan, expire the
session, then tap the nudge. This is invisible to any same-session
test, which is exactly the kind of gap that ships.

#### 12.5c Why a server session is required at all

Reasonable objection: depositing is an **on-chain** action, so why does
a recurring version of it need a backend session? Mapping the real
deposit path (`services/agent-executors/defi/writes.ts`) answers it,
and the answer is not the one most people guess:

| Step | Needs JWT? | Failure mode |
|---|---|---|
| Fetch scored venue catalog (`defi_list_opportunities`) | **Yes** | `authentication_required` → card renders "Sign in to explore DeFi". **Hard stop.** |
| Re-fetch authoritative `depositTarget` (`getPool`) | Yes | `.catch(() => null)` — soft |
| Read saved strategy (`getStrategy`) | Yes | `.catch(() => null)` — soft |
| Build / sign / submit the transaction | **No** | Pure on-chain, device key |
| USD snapshot (`getAssetPrices`) | Yes | soft |
| Record position (`createPosition`, `:735`) | Yes | **swallowed** — `__DEV__` log only |

So the user's intuition is right about the *money* part: **signing and
broadcasting need no server and no JWT**, and `createPosition` — which
still exists — is best-effort bookkeeping wrapped in a `try/catch` that
only logs in dev. A deposit lands on-chain whether or not the backend
ever hears about it.

**The catalog gate is policy, not architecture — do not mistake it for
one.** It would be easy to claim the scored venue list inherently
requires a session. It does not. `score-opportunities.processor.ts`
contains **zero** references to `walletAddress` or `userId`: the
pipeline polls DeFiLlama, scores pools, and writes `OpportunityCache`
as **global data, identical for every user**. The session requirement
comes from a blanket `@UseGuards(JwtAuthGuard)` at the
`StrategiesController` class level. Two signs it is blanket rather than
reasoned per-endpoint:

- `getOpportunity(slug)` and `getPoolById(poolId)` accept **no wallet
  at all** — purely global lookups — yet sit behind the same guard.
- `getOpportunities` uses the wallet for exactly one thing:
  `strategy?.tier`, to personalise the filter. With no strategy row it
  returns everything unfiltered anyway.

So a signed-out user *could* technically be served the scored catalog.
If public browsing is ever wanted, that is a per-endpoint guard
decision — **not** a rewrite of the scoring pipeline.

**Nor does push targeting require it.** `POST /users/me/push-token` is
`@Public()` (X-API-Key gated) with `OptionalJwtAuthGuard`, and its own
summary states the intent outright: *"so devices can register before
sign-in; if a valid JWT is also presented the token is linked to that
user."* It stores `userId: req.user?.id ?? null` — **nullable** — plus
the device's wallet subscriptions. The server can therefore reach a
device by wallet address with no session at all.

**So: sign-in is NOT an architectural requirement for DCA.** Every
candidate reason fails on inspection — depositing is on-chain, scoring
is a user-agnostic cron, position recording is soft, push targeting is
deliberately pre-sign-in, and a plan could be keyed by wallet address
exactly as push subscriptions already are. What remains is the single
blanket `JwtAuthGuard` on `StrategiesController`.

**It is therefore a product decision, and this spec makes it
deliberately: v1 requires sign-in.** Recorded with honest reasons, so
nobody later re-derives a fake technical one:

1. **Consistency.** The whole DeFi surface sits behind that guard.
   Making DCA the one unauthenticated DeFi feature would require
   un-gating the catalog endpoints too — a separate change with its own
   security review, not a side effect of shipping a reminder.
2. **Bookkeeping integrity.** `createPosition` needs a session to
   record anything. A DCA that deposits on a schedule while positions
   silently fail to record reproduces a bug class this repo has already
   hit in production
   (`project_defi_position_registration_bug_and_discovery`) — on a
   recurring basis rather than once.
3. **Scope discipline.** Un-gating is reversible and additive later;
   shipping unauthenticated first and retrofitting identity is not.

If public/no-login DCA is ever wanted, the work is a per-endpoint guard
review on `StrategiesController` plus wallet-keyed plan storage —
**not** a redesign of this feature.

**Conclusion: v1 requires sign-in by choice, not by necessity.** In
practice it adds no new gate — a signed-out user already cannot reach
the opportunity list under today's blanket guard.

Do **not** build a local-only variant (device-scheduled notification +
on-device plan). The reason is *not* that the server cannot reach an
unauthenticated device — it demonstrably can (push registration is
public by design). It is that an on-device plan has no server-side
scheduler behind it, drifts out of sync with backend-recorded
positions, and dies with an app reinstall. If no-login DCA is wanted,
build it **server-side keyed by wallet address**, the way push
subscriptions already work — never as a device-local imitation.

Sign-in here is **not** custody: the seed stays on device, the session
only unlocks backend records. The user's own key still signs.

> Related risk worth carrying into implementation: because
> `createPosition` swallows failures, a deposit can succeed on-chain
> while remaining invisible in-app. That exact silent drop has already
> been a production bug once
> (`project_defi_position_registration_bug_and_discovery`, fixed via
> `ensureUserStrategy`). DCA multiplies the exposure by depositing on a
> schedule, so a recurring cycle that repeatedly fails to record should
> be observable — not silent.

### 12.6 Resolved decisions (DCA v1)

**Cadence: weekly or monthly only.** Two chips, no free-form day count.
An arbitrary integer invites plans ("every 3 days") whose gas cost
eats a meaningful share of a small recurring deposit, and it buys no
real use case over the two options people actually think in. The
schema keeps `cadenceDays Int` (§12.3) rather than an enum, so adding
a third option later is a value change, not a migration.

**Missed cycles skip, they never stack.** `nextDueAt` always advances
to the next future slot whether or not the user acted on the nudge.
Stacking would produce two things this app should not do: a pile-up of
reminders nagging about money the user has already implicitly declined
to invest, and — worse — a "catch-up" prompt for a doubled amount the
user never asked for. This also matches the auto-compound precedent,
where a skipped nudge loses nothing.

**No prior `UserStrategy` row required.** A first-touch user can start
a plan straight from Quick Invest. The precedent already exists on the
deposit path: `ensureUserStrategy` in `strategies.service.ts:823`
auto-creates a row, logging *"auto-creating default UserStrategy
(tier=…) — deposited without prior /strategies onboarding"*, inheriting
the tier from what the user actually chose. Reuse it with the plan's
tier; requiring onboarding first would gate a recurring plan behind a
step one-off deposits don't need.

Precision on what "optional setup" means, because the mechanism is
easy to misremember: **no default row is pre-created for anyone.**
A `UserStrategy` appears only via explicit onboarding
(`createStrategy`, `:194`) or lazily on first deposit
(`ensureUserStrategy`, `:844`). What exists by default is a *behaviour
when the row is absent* — `getOpportunities` computes
`strategy?.tier ?? filter.tier` and only applies `where.tier` if that
resolves, so a user with no row sees **every tier unfiltered**. That is
what makes browsing without onboarding work.

**A saved strategy outranks the plan's tier at execution time — surface
that, never let it be silent.** Note the precedence in that same
expression: `strategy?.tier` wins over the query filter. So a user who
sets up "$25/week into Balanced" and *later* onboards as Conservative
will, when the nudge fires, land on a conservative list. The override
itself is **correct and must stay** — it is the safety ceiling behind
"never propose protocols above the user's risk tier". What is not
acceptable is doing it quietly: the user was promised Balanced.

Two requirements follow:

1. Creating a plan calls `ensureUserStrategy` with the plan's tier, so
   plan and strategy agree from the start and the common case never
   diverges at all.
2. When they *do* diverge later (the user changed their strategy), the
   landing surface states plainly that the saved risk profile is being
   applied instead of the plan's, and offers to update the plan. Fixed
   friendly copy per the user-facing-error rule — no raw tier strings
   thrown at the user.

### 12.7 Docking points — where future extension attaches

Space-docking discipline, applied honestly: name the axes that are
**actually likely** to extend, give each a docking point, and refuse to
build machinery for the ones that are speculative.

**Axis 1 — chain support. Already docked, nothing to add.** Two
existing registries cover it: `getDefiAdapter(slug)` decides whether a
venue is executable, and `WalletKitAdapter` covers signing. A new chain
becomes DCA-capable by registering an adapter (§12.1a rule 3).

**Axis 2 — execution mode (reminder → unattended). The one axis that
is certain to extend**, because §13 already describes it. Docking
point: add `executionMode String` to `RecurringInvestPlan` now,
defaulting to `"reminder"`. It costs one column today and means v2 rows
coexist with v1 rows instead of forcing a migration or a parallel
table later.

Deliberately **not** building a mode-dispatch registry yet. With one
implementation a registry is indirection without payoff; the point is
only to keep the *data* forward-compatible. When mode #2 lands, the
dispatch should follow the established shape —
`api/src/strategies/targets/registry.ts`'s `PoolTargetResolver` map,
which the pool-level-deposits spec (§5) already prescribes as "register
a resolver, **never** a `switch` on slug". Same rule, keyed by mode.

**Axis 3 — trigger kind (time-based → event-based, e.g. "when my
balance exceeds $X"). Plausible, but explicitly not designed for.**
`cadenceDays` + `nextDueAt` is a time-only model, and pretending
otherwise now would mean inventing a trigger abstraction with exactly
one implementation and no validated requirement. If it ever lands it
takes the same registry shape as Axis 2. Recorded so a future reader
knows it was considered and rejected, not overlooked.

**Anti-goal.** Do not add docking seams for notification channel,
per-plan protocol pinning, or multi-asset plans. None has a requirement
behind it, and each would widen the schema and the approval surface for
a feature that has not shipped once yet.

### 12.8 Chain-agnostic acceptance checks

Verifiable, not aspirational — a reviewer should be able to run these:

- `pnpm check:chains` passes with the new mobile surfaces in place
  (it fails the build on `namespace === "eip155"` under `components/`,
  `hooks/`, `app/`).
- `grep` the new backend processor, service, and controller for
  `eip155` / `solana` / `sui` / `stellar` — expect **zero** hits. The
  recurring layer has no legitimate reason to name a namespace.
- **Address rules are structurally verifiable, so verify them
  structurally, not just behaviourally:**
  - The create/pause/cancel DTOs contain **no** wallet-address field
    (§12.3a Rule 1). Grep them; a wallet field is an automatic fail.
  - `grep -n "toLowerCase\|canonicalizeWalletAddress"` across the new
    recurring service/controller returns **zero** hits (§12.3a Rule 2 —
    either one indicates an address is entering outside the JWT).
  - Behavioural backstop: a plan round-trips for a **Solana or
    Stellar** address — create, then look up, and confirm it is found.
    Invisible to any EVM-only test, which is exactly why it is listed.
  - The watcher's plan → push-token join is exercised for a
    case-significant namespace (§12.3a Rule 3), since that is the one
    place two independently-produced address strings meet.
- **Expired-session nudge (§12.5b):** create a plan, expire the
  session, tap the nudge — the prefilled intent must survive the
  re-auth detour rather than being dropped. No same-session test
  catches this.
- Pointing a plan at a namespace with no registered deposit adapter
  degrades to "not available yet" through the **presence check**, and
  the mobile UI reaches that state without any namespace comparison.
- No new optional capability was added to `WalletKitAdapter` or
  `DefiAdapter` for v1. If a reviewer finds one, that is a signal the
  recurring layer has started reaching into chain primitives it should
  be delegating instead (§12.1a).

## 13. Future improvement — fully unattended recurring investing (DCA v2)

**Not designed in this spec.** Flagged because the architectural
building blocks already exist elsewhere in the codebase for a different
purpose, which is worth knowing before anyone assumes this needs to be
built from zero:

- `services/chains/evm/eip7702Guard.ts` and
  `services/gasAbstraction/oneShot/oneShotRelayerProvider.ts` (skill
  `public-relayer`) already implement EIP-7702/7710 delegated,
  gas-abstracted execution — a user signs one scoped permission
  ("spend up to $X" with caveats), and a relayer executes within it
  without a per-transaction signature.
- In principle the same mechanism could let a server-side scheduler
  submit a periodic deposit under a pre-granted delegation, with **zero**
  push notification or per-cycle tap — the actual "set and forget" DCA
  behavior mocked in concept #09's copy.

This is explicitly **not** a green light to build it. It introduces a
new class of standing financial authority that a compromised relayer or
scheduler could abuse periodically rather than once, and it needs its
own security-reviewed spec — most likely modeled on
`docs/eip7710-1shot-relayer-spec.md` and
`docs/eip7702-delegator-allowlist-spec.md` — before any implementation
work starts. Do not fold this into a Phase 0/1/2 mobile PR.

**When it is built, it docks — and the docking points already exist.**
No new capability needs inventing, which is the strongest argument that
this design is on the right rails:

- **The capability slots are already on `WalletKitAdapter`**
  (`services/walletKit/types.ts`): `createDelegation?`,
  `signDelegation?`, `encodeDelegations?`, plus the relayer trio
  (`getRelayerCapabilities?` / `getRelayerFeeData?` /
  `getRelayerTransactionStatus?`) — all optional, with doc comments
  that already state the rule verbatim: *"Consumers presence-check per
  chain-extension discipline."* Note this is the **walletKit** registry,
  not `DefiAdapter`: a standing spending authorization is a
  chain/wallet signing primitive, not a per-venue deposit concern.
- **The recurring-allowance shape is already modeled.**
  `DelegationScope` supports `erc20PeriodTransfer` /
  `nativeTokenPeriodTransfer` with `periodAmount?` ("Recurring-allowance
  amount per `periodDuration`") and `periodDuration?` ("Period length in
  seconds (e.g. 604_800 for weekly)"). That is a DCA schedule expressed
  in the type system already — `periodAmount` = the plan's amount,
  `periodDuration` = `cadenceDays × 86400`.
- **The type is deliberately SDK-free**, "so UI screens and the local
  `PermissionGrantStore` can model delegations without importing
  `@metamask/smart-accounts-kit`", with `EvmWalletKit` translating at
  the port boundary and — per its own comment — *"Solana / Sui never
  see them."* The chain-specific translation is already quarantined in
  the EVM kit.

So the correct reading is **not** "v1 is chain-agnostic, v2 can't be."
It is: v1 needs no chain primitive at all, and v2's primitive is
already behind presence-checked optional methods. Shared code asks
*"does this kit offer delegation?"*, never *"is this EVM?"*. Another
namespace docks by implementing those same optional methods — zero
edits to shared code, zero edits to this feature.
