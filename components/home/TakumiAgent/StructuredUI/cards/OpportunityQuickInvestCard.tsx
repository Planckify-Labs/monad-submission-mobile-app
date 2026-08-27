/**
 * OpportunityQuickInvestCard — the default render of
 * `defi_list_opportunities` (docs/defi-quick-invest-spec.md §3).
 *
 * The old default sold the *tool*: a paginated list of protocol rows to
 * read and compare, then one manually typed amount per checked pool before
 * the submit button even enabled — the same empty form whether or not the
 * user had already said "invest $750, balanced". This leads with the
 * outcome instead, and scales the friction to how much the user already
 * specified.
 *
 * One card, three entry points, driven purely by which `OpportunityInput`
 * fields the model passed (no new plumbing — the signal already reaches
 * the card today, it was just unused):
 *
 *   1. `amount_usd` present  → the Simulator, pre-set, one tap to confirm.
 *   2. `tier` only           → the Simulator, opened on a proportional
 *                              starter amount (§11.1) instead of zero.
 *   3. neither                → a single recommendation headline built from
 *                              the wallet's detected idle balance; the
 *                              Simulator appears only on "Adjust amount".
 *
 * The browse list is NOT replaced. It stays reachable in one tap and is
 * unchanged — it is also how a new protocol/pool gets exercised
 * individually with a hand-typed amount, which this card deliberately
 * cannot do.
 */

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import {
  ArrowRight,
  ListFilter,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
} from "lucide-react-native";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { strategiesApi } from "@/api/endpoints/strategies";
import SingleLoadingSekeleton from "@/components/common/SingleLoadingSekeleton";
import { useIdleAssetBalances } from "@/hooks/defi/useIdleAssetBalances";
import { useUserStrategy } from "@/hooks/queries/useStrategy";
import { useWallet } from "@/hooks/useWallet";
import { track } from "@/services/analytics/posthog";
import {
  isTestnetRow,
  prettyProtocol,
} from "@/services/defi/opportunityDisplay";
import { chainLabel, TIER_LABEL } from "@/services/defi/opportunityLabels";
import { shapeOpportunity } from "@/services/defi/opportunityShape";
import type { QuickInvestRow } from "@/services/defi/quickInvest";
import {
  allocatableRows,
  allocate,
  buildDepositPrompt,
  formatUsd,
  isUsdPegged,
  projectionApy,
  resolveTargetAsset,
  sliderBounds,
  snapToStep,
  starterAmountUsd,
  usdToTokenAmount,
} from "@/services/defi/quickInvest";
import { getDefiAdapter } from "@/services/defi/registry";
import AllocationBreakdown from "./quickInvest/AllocationBreakdown";
import AmountSlider from "./quickInvest/AmountSlider";
import RiskDial, { type RiskTier } from "./quickInvest/RiskDial";
import SetupStrategyCTA from "./SetupStrategyCTA";

const BRAND_RED = "#c71c4b";

const TIERS: RiskTier[] = ["conservative", "balanced", "aggressive"];

function asTier(value: string | undefined): RiskTier | null {
  const key = (value ?? "").toLowerCase() as RiskTier;
  return TIERS.includes(key) ? key : null;
}

export type QuickInvestInput = {
  tier?: string;
  asset_symbol?: string;
  chain_id?: number;
  liquidity_profile?: string;
  amount_usd?: number;
};

export type QuickInvestScope = {
  chain_scope?: string;
  active_namespace?: string;
  active_chain_id?: number | null;
  active_chain_name?: string | null;
};

/** Which of the three entry points the card opened on (§3). */
export type EntryState = 1 | 2 | 3;

export function entryStateFor(input: QuickInvestInput | undefined): EntryState {
  const hasAmount =
    typeof input?.amount_usd === "number" &&
    Number.isFinite(input.amount_usd) &&
    input.amount_usd > 0;
  if (hasAmount) return 1;
  return asTier(input?.tier) ? 2 : 3;
}

const OpportunityQuickInvestCard: React.FC<{
  input: QuickInvestInput | undefined;
  /** Already testnet-filtered rows from the parent's current payload. */
  rows: QuickInvestRow[];
  scope: QuickInvestScope | undefined;
  /** Total option count, for the browse link's label. */
  optionCount: number;
  onUserPrompt?: (prompt: string) => void;
  onBrowse: () => void;
  showSetupCTA?: boolean;
}> = ({
  input,
  rows,
  scope,
  optionCount,
  onUserPrompt,
  onBrowse,
  showSetupCTA = true,
}) => {
  const { activeWallet } = useWallet();
  const { data: strategy } = useUserStrategy();
  const entryState = entryStateFor(input);
  const initialTier = asTier(input?.tier) ?? "balanced";

  // ── Risk dial: a re-fetch, not a recompute (§3.1) ──────────────────
  // `tier` is a hard server-side filter, so a payload fetched as
  // "balanced" holds only balanced rows. Dragging the dial therefore has
  // to go back to the API — which the card can do directly, the same way
  // the browse list's dev diagnostic already calls `strategiesApi`. Keyed
  // by tier so flipping back and forth is a cache hit rather than a
  // debounce.
  const [tier, setTier] = useState<RiskTier>(initialTier);
  const tierParams = useMemo(() => {
    const base: Record<string, unknown> = { tier };
    if (input?.asset_symbol) base.asset_symbol = input.asset_symbol;
    if (input?.liquidity_profile)
      base.liquidity_profile = input.liquidity_profile;
    if (input?.amount_usd !== undefined) base.amount_usd = input.amount_usd;
    // Reproduce the read executor's chain scoping so the re-fetch stays on
    // the same chains the user is already looking at.
    if (
      scope?.chain_scope === "requested_chain" &&
      input?.chain_id !== undefined
    ) {
      base.chain_id = input.chain_id;
    } else if (scope?.chain_scope === "active_chain") {
      if (scope.active_namespace) base.namespace = scope.active_namespace;
      if (scope.active_chain_id) base.chain_id = scope.active_chain_id;
    }
    return base as Parameters<typeof strategiesApi.getOpportunities>[0];
  }, [tier, input, scope]);

  const tierChanged = tier !== initialTier;
  const { data: refetched, isFetching: tierLoading } = useQuery({
    queryKey: ["defi", "quick-invest", "opportunities", tierParams],
    enabled: tierChanged,
    staleTime: 60 * 1000,
    // Tier → tier keeps the previous tier's rows on screen while the next
    // set loads, so the card does not blank out mid-drag.
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const raw = await strategiesApi.getOpportunities(tierParams);
      return (raw ?? []).map(shapeOpportunity).filter((r) => !isTestnetRow(r));
    },
  });

  /**
   * Falls back to the tool payload's own rows rather than `[]` while the
   * first dial change is in flight: an empty array would momentarily wipe
   * the detected asset, which resets the amount and makes the whole card
   * jump. The projection is skeletoned off `tierLoading` instead.
   */
  const activeRows: QuickInvestRow[] = useMemo(
    () => (tierChanged ? (refetched ?? rows) : rows),
    [tierChanged, refetched, rows],
  );

  // ── What the user is actually holding (§6, §11.4) ──────────────────
  const candidateSymbols = useMemo(
    () =>
      Array.from(
        new Set(
          allocatableRows(activeRows)
            .map((r) => r.asset_symbol)
            .filter((s): s is string => !!s),
        ),
      ),
    [activeRows],
  );
  const idle = useIdleAssetBalances({
    address: activeWallet?.address,
    chainId: scope?.active_chain_id ?? null,
    candidateSymbols,
  });

  // §5.0 — one asset, resolved before anything is split.
  //
  // `canPrice` is load-bearing, not a nicety. Ranking the fallback on
  // safety score alone put an Avalanche wallet into BTC.B at 0.01% APY:
  // the row scored well, but the asset had no resolvable USD price, so the
  // projection read $0.00 and the CTA was dead — while the agent's own
  // reply in the same turn recommended USDC at ~4.7%. A card that cannot
  // convert a USD amount into token units cannot act at all.
  const canPrice = useCallback(
    (symbol: string) =>
      isUsdPegged(symbol) || idle.bySymbol(symbol)?.priceUsd != null,
    [idle],
  );
  const targetAsset = useMemo(
    () =>
      resolveTargetAsset(activeRows, {
        inputAsset: input?.asset_symbol,
        detectedAsset: idle.largest?.symbol,
        canPrice,
      }),
    [activeRows, input?.asset_symbol, idle.largest?.symbol, canPrice],
  );
  const targetIdle = idle.bySymbol(targetAsset);
  const idleUsd = targetIdle?.usdValue ?? null;
  // A USD-pegged stablecoin needs no lookup (§6.1); anything else without a
  // resolved price has no honest USD → token conversion, so the card must
  // not invent one.
  const priceUsd = isUsdPegged(targetAsset)
    ? 1
    : (targetIdle?.priceUsd ?? null);

  // ── The amount, per state (§6) ─────────────────────────────────────
  // Held as "user has not touched it yet" (null) rather than seeded in
  // `useState`, so the default keeps tracking the balance as it loads in
  // and pins the moment the user drags. No effect, no stale initial value.
  const [pinnedAmount, setPinnedAmount] = useState<number | null>(null);
  const defaultAmount = useMemo(() => {
    if (entryState === 1) return input?.amount_usd ?? 0;
    if (entryState === 2) return starterAmountUsd(idleUsd);
    // State 3 opens on the detected balance itself. With nothing detectable
    // (non-EVM per §11.6, or a zero balance) it falls through to an empty
    // slider, which is exactly today's behaviour rather than a regression —
    // and deliberately NOT State 2's $100 starter: there is no goal signal
    // here to justify suggesting a number.
    return idleUsd ?? 0;
  }, [entryState, input?.amount_usd, idleUsd]);

  // Bounds deliberately do NOT depend on `pinnedAmount`. With no detected
  // balance the ceiling is derived from the amount, so feeding the live
  // value back in made `max` grow as the user dragged right, pushing the
  // thumb back left until it chased the finger. The range must hold still
  // for the whole interaction.
  const bounds = useMemo(
    () => sliderBounds({ openingAmountUsd: defaultAmount, idleUsd }),
    [defaultAmount, idleUsd],
  );
  const amount = snapToStep(pinnedAmount ?? defaultAmount, bounds);

  // ── The split (§5.1) ───────────────────────────────────────────────
  // §5.2: the flat $50 floor is the mechanism; `minDepositRaw` is a
  // presence-checked bonus. Exactly one adapter defines it today, and it
  // needs the asset's decimals + price to compare against a USD amount, so
  // it tightens where all three are available and is inert otherwise.
  const minLegUsdFor = useMemo(() => {
    const decimals = targetIdle?.decimals;
    if (decimals === undefined || !priceUsd) return undefined;
    return (row: QuickInvestRow) => {
      const raw = getDefiAdapter(row.protocol_slug)?.minDepositRaw;
      if (raw === undefined) return undefined;
      return (Number(raw) / 10 ** decimals) * priceUsd;
    };
  }, [targetIdle?.decimals, priceUsd]);

  const allocation = useMemo(
    () =>
      allocate({
        rows: activeRows,
        totalUsd: amount,
        assetSymbol: targetAsset,
        minLegUsdFor,
      }),
    [activeRows, amount, targetAsset, minLegUsdFor],
  );

  /**
   * Every row came back OUTSIDE the user's saved risk tier.
   *
   * The server returns these only when the tier ceiling matched nothing, so
   * reaching here means the honest answer is "there are options, just not at
   * your risk level" — not the "no yield options on this chain" the card
   * used to show. That copy was false: an Arbitrum wallet with a saved
   * Conservative profile was told USDT had nothing, while two balanced USDT
   * pools sat in the cache.
   */
  const allOutsideTier =
    activeRows.length > 0 && activeRows.every((r) => r.outside_tier === true);

  const [expanded, setExpanded] = useState(false);
  // State 3 leads with a recommendation; the Simulator is what "Adjust
  // amount" morphs into (§3). One-way: once the user opens it, it stays.
  const [adjusting, setAdjusting] = useState(false);

  // One event per card, for the metric that actually validates the
  // redesign (§10): does the quick path shorten "card shown" → "deposit
  // confirmed"? Entry state is derived from `input` alone, so it is stable
  // from the first render and safe to report once.
  const reported = useRef(false);
  useEffect(() => {
    if (reported.current) return;
    reported.current = true;
    track("defi_quick_invest_shown", { entry_state: entryState });
  }, [entryState]);

  const chainNames = useMemo(
    () =>
      Array.from(
        new Set(
          allocation.legs
            .map((l) =>
              chainLabel(l.row.chain_name, l.row.chain_id, l.row.namespace),
            )
            .filter((c): c is string => !!c),
        ),
      ),
    [allocation.legs],
  );

  const canConvert = priceUsd !== null && priceUsd > 0;
  /**
   * No amount was stated, no goal was stated, and no balance was
   * detectable (§11.6). The slider's floor would otherwise present its own
   * minimum as if it were a suggestion. Nothing is claimed until the user
   * drags: this is the "empty slider" §6 falls back to, at parity with the
   * empty text field the browse list opens with today.
   */
  const needsAmountChoice = pinnedAmount === null && defaultAmount <= 0;
  const noPools = allocation.legs.length === 0;
  const canSubmit =
    !!onUserPrompt &&
    allocation.legs.length > 0 &&
    canConvert &&
    !tierLoading &&
    !needsAmountChoice;

  const submit = () => {
    if (!onUserPrompt || !canConvert) return;
    const legs = allocation.legs.map((leg) => ({
      amount:
        usdToTokenAmount(leg.amountUsd, priceUsd, targetIdle?.decimals ?? 6) ??
        "0",
      symbol: leg.row.asset_symbol ?? targetAsset ?? "tokens",
      protocolLabel: prettyProtocol(leg.row.protocol_slug),
      poolMeta: leg.row.pool_meta,
      chain: chainLabel(
        leg.row.chain_name,
        leg.row.chain_id,
        leg.row.namespace,
      ),
      poolId: leg.row.pool_id,
    }));
    if (legs.some((l) => l.amount === "0")) return;
    track("defi_quick_invest_submitted", {
      entry_state: entryState,
      tier,
      legs: legs.length,
      amount_usd: allocation.totalUsd,
    });
    onUserPrompt(buildDepositPrompt(legs));
  };

  const goBrowse = () => {
    track("defi_quick_invest_browse", { entry_state: entryState });
    onBrowse();
  };

  /**
   * Secondary actions share ONE quiet row.
   *
   * They were three stacked full-width blocks under the primary CTA, which
   * left four things of near-equal weight and no obvious next step. These
   * two are alternatives to the primary action, not peers of it, so they
   * read as links: the eye lands on the pill, and the alternatives are
   * there when the pill is not what you wanted.
   *
   * Browse still has to be genuinely findable — it is the only surface that
   * can put a hand-typed amount into one hand-picked pool, which is how a
   * newly registered protocol gets verified — so it keeps the icon and the
   * accent colour while giving up its own row.
   */
  const secondaryRow = (extra?: React.ReactNode) => (
    <View className="mt-3 flex-row flex-wrap items-center justify-center gap-x-3 gap-y-1.5">
      {extra}
      {extra ? <View className="h-3 w-px bg-light-matte-black/15" /> : null}
      <TouchableOpacity
        onPress={goBrowse}
        activeOpacity={0.6}
        hitSlop={8}
        className="flex-row items-center gap-1.5 py-1"
        accessibilityRole="button"
        accessibilityHint="Pick pools one by one and set exact amounts"
      >
        <ListFilter size={13} color={BRAND_RED} />
        <Text className="text-xs font-semibold text-light-primary-red">
          {optionCount > 0
            ? `Browse ${optionCount} option${optionCount === 1 ? "" : "s"}`
            : "Browse the full list"}
        </Text>
      </TouchableOpacity>
    </View>
  );

  const whyTheseVenues =
    onUserPrompt && !noPools && !needsAmountChoice ? (
      <TouchableOpacity
        onPress={() =>
          onUserPrompt(
            "Explain why you picked these venues for me, and what the main risks are.",
          )
        }
        activeOpacity={0.6}
        hitSlop={8}
        className="flex-row items-center gap-1.5 py-1"
        accessibilityRole="button"
      >
        <Sparkles size={13} color={BRAND_RED} />
        <Text className="text-xs font-semibold text-light-primary-red">
          Why these venues?
        </Text>
      </TouchableOpacity>
    ) : null;

  if (allOutsideTier) {
    // Now that the tier filter is a CEILING rather than an equality test,
    // reaching here means one specific thing: pools exist for this asset,
    // but every one of them is riskier than the profile allows. That is
    // worth stating precisely — the earlier copy said "outside the higher
    // risk level you saved", which read as if safer pools were being
    // withheld, and with an aggressive profile they genuinely were.
    const savedTier = strategy?.tier
      ? (TIER_LABEL[String(strategy.tier).toLowerCase()] ?? null)
      : null;
    const asset = activeRows[0]?.asset_symbol ?? targetAsset;
    const bestApy = Math.max(
      ...activeRows.map((r) => projectionApy(r)),
      Number.NEGATIVE_INFINITY,
    );
    return (
      <View className="my-1.5">
        <View className="rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-3.5">
          <View className="flex-row items-center gap-1.5">
            <ShieldAlert size={13} color="#b45309" />
            <Text className="text-[11px] font-bold uppercase tracking-wide text-light-matte-black">
              Higher risk than your profile
            </Text>
          </View>

          {/* Lead with what exists, not with the refusal. The user asked a
              question; the answer is "these exist and here is the catch",
              not "no". */}
          <Text className="text-light-matte-black font-bold text-lg mt-1.5">
            {`${activeRows.length} ${asset ? `${asset} ` : ""}option${
              activeRows.length === 1 ? "" : "s"
            }`}
            {Number.isFinite(bestApy) && bestApy > 0 ? (
              <Text className="text-emerald-600">{`  up to ${bestApy.toFixed(2)}%`}</Text>
            ) : null}
          </Text>
          <Text className="text-[11.5px] text-gray-500 mt-0.5">
            {savedTier
              ? `All of them carry more risk than the ${savedTier.toLowerCase()} profile you saved, so we have not built a plan from them.`
              : "All of them carry more risk than your saved profile, so we have not built a plan from them."}
          </Text>

          <TouchableOpacity
            onPress={goBrowse}
            activeOpacity={0.85}
            className="mt-3 flex-row items-center justify-center gap-2 rounded-full bg-light-primary-red px-4 py-3"
            accessibilityRole="button"
          >
            <Text className="text-sm font-bold text-white">
              Look at them anyway
            </Text>
            <ArrowRight size={16} color="#ffffff" strokeWidth={2.5} />
          </TouchableOpacity>

          {/* Demoted: changing a saved risk profile mid-flow is a bigger
              decision than looking, and it leaves the conversation. */}
          <TouchableOpacity
            onPress={() => router.push("/strategies")}
            activeOpacity={0.6}
            hitSlop={8}
            className="mt-2 items-center py-1"
            accessibilityRole="button"
          >
            <Text className="text-xs font-semibold text-light-primary-red">
              Change my risk level
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── State 3: one recommendation, not a form (§3) ────────────────────
  // Nothing detectable to recommend against (non-EVM per §11.6, a zero
  // balance, or no executable pool) falls through to the Simulator rather
  // than headlining a number we do not have. The empty balance result is
  // "we could not look", never "you have no funds".
  const recommendable =
    idleUsd !== null && idleUsd > 0 && allocation.legs.length > 0;
  const wantsRecommendation = entryState === 3 && !adjusting;

  if (wantsRecommendation && recommendable) {
    const venueWord = allocation.legs.length === 1 ? "protocol" : "protocols";
    return (
      <View className="my-1.5">
        <View className="rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-3.5">
          <View className="flex-row items-center gap-1.5">
            <View className="w-1.5 h-1.5 rounded-full bg-light-primary-red" />
            <Text className="text-[11px] font-bold uppercase tracking-wide text-light-matte-black">
              {`Recommended for your ${formatUsd(idleUsd)} idle ${targetAsset ?? ""}`.trim()}
            </Text>
          </View>
          <Text className="text-3xl font-extrabold text-emerald-600 mt-1.5">
            {allocation.blendedApy.toFixed(1)}%
            <Text className="text-[13px] font-semibold text-gray-500">/yr</Text>
          </Text>
          <Text className="text-[11.5px] text-gray-500 mt-0.5">
            {`The safest combination across ${allocation.legs.length} ${venueWord}${
              chainNames.length === 1 ? ` on ${chainNames[0]}` : ""
            }`}
          </Text>
          <TouchableOpacity
            onPress={submit}
            disabled={!canSubmit}
            activeOpacity={0.85}
            className={`mt-3 flex-row items-center justify-center gap-2 rounded-full px-4 py-3 ${
              canSubmit ? "bg-light-primary-red" : "bg-light-matte-black/15"
            }`}
          >
            <Text
              className={`text-sm font-bold ${
                canSubmit ? "text-white" : "text-light-matte-black/40"
              }`}
            >
              {`Invest ${formatUsd(allocation.totalUsd)} now`}
            </Text>
            {canSubmit ? (
              <ArrowRight size={16} color="#ffffff" strokeWidth={2.5} />
            ) : null}
          </TouchableOpacity>
        </View>
        {secondaryRow(
          <TouchableOpacity
            onPress={() => setAdjusting(true)}
            activeOpacity={0.6}
            hitSlop={8}
            className="flex-row items-center gap-1.5 py-1"
            accessibilityRole="button"
          >
            <SlidersHorizontal size={13} color={BRAND_RED} />
            <Text className="text-xs font-semibold text-light-primary-red">
              Change amount
            </Text>
          </TouchableOpacity>,
        )}
        {showSetupCTA ? <SetupStrategyCTA /> : null}
      </View>
    );
  }

  if (wantsRecommendation && idle.isLoading) {
    return (
      <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-4">
        <SingleLoadingSekeleton width={180} height={11} borderRadius={4} />
        <SingleLoadingSekeleton
          width={96}
          height={28}
          borderRadius={6}
          style={{ marginTop: 10 }}
        />
        <SingleLoadingSekeleton
          width={220}
          height={10}
          borderRadius={4}
          style={{ marginTop: 8 }}
        />
      </View>
    );
  }

  // ── States 1 and 2 (and State 3 once adjusted): the Simulator ───────
  return (
    <View className="my-1.5">
      <View className="rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-3.5">
        <View className="flex-row items-center gap-2">
          <TrendingUp size={13} color={BRAND_RED} />
          <Text className="text-[11px] font-bold uppercase tracking-wide text-light-matte-black">
            {/* Three entry points must not share one header. Falling back
                here (State 3 with no detectable balance) previously wore
                State 1's "Amount to invest", so a card the agent had no
                signal for looked identical to one the user had given an
                exact number to. */}
            {needsAmountChoice
              ? "Choose an amount"
              : entryState === 2
                ? "Suggested to start"
                : "Amount to invest"}
          </Text>
          {targetAsset ? (
            <Text className="ml-auto text-[11px] font-semibold text-gray-500">
              {targetAsset}
            </Text>
          ) : null}
        </View>

        <Text className="text-3xl font-extrabold text-light-matte-black mt-1">
          {formatUsd(amount, { cents: amount % 1 !== 0 })}
        </Text>

        <AmountSlider
          value={amount}
          bounds={bounds}
          onChange={setPinnedAmount}
          formatValue={(v) => formatUsd(v, { cents: false })}
          minLabel={formatUsd(bounds.min, { cents: false })}
          maxLabel={
            idleUsd !== null
              ? `${formatUsd(bounds.max, { cents: false })} available`
              : formatUsd(bounds.max, { cents: false })
          }
        />

        <RiskDial value={tier} onChange={setTier} loading={tierLoading} />

        <View className="h-px bg-light-matte-black/[0.08] my-3" />

        <View className="flex-row items-center gap-1.5">
          <View className="w-1.5 h-1.5 rounded-full bg-light-primary-red" />
          <Text className="text-[11px] font-bold uppercase tracking-wide text-light-matte-black">
            Projected per month
          </Text>
        </View>

        {tierLoading ? (
          <SingleLoadingSekeleton
            width={110}
            height={22}
            borderRadius={5}
            style={{ marginTop: 6 }}
          />
        ) : (
          <Text className="text-xl font-extrabold text-emerald-600 mt-1">
            {noPools || needsAmountChoice
              ? "—"
              : `≈ ${formatUsd(allocation.projectedMonthlyUsd)}`}
          </Text>
        )}

        <Text className="text-[11.5px] text-gray-500 mt-0.5">
          {needsAmountChoice
            ? "Drag the slider to choose how much to invest."
            : noPools
              ? "Nothing here can take this amount in-app yet. The full list has more, including deposits you finish on the protocol's own site."
              : `${allocation.blendedApy.toFixed(2)}% blended 7-day APY across ${
                  allocation.legs.length
                } ${allocation.legs.length === 1 ? "venue" : "venues"}`}
        </Text>

        {needsAmountChoice ? null : (
          <AllocationBreakdown
            allocation={allocation}
            expanded={expanded}
            onToggle={() => setExpanded((v) => !v)}
          />
        )}
      </View>

      {!noPools && !canConvert ? (
        <Text className="mt-2 px-1 text-[11px] text-gray-500">
          {`We can't price ${targetAsset ?? "this asset"} right now, so we can't work out the deposit amount. You can still choose an exact amount from the full list.`}
        </Text>
      ) : null}

      {!noPools && !needsAmountChoice ? (
        <Text className="mt-2 text-center text-[11px] text-gray-400">
          Drag to see other projections
        </Text>
      ) : null}

      <TouchableOpacity
        onPress={submit}
        disabled={!canSubmit}
        activeOpacity={0.85}
        className={`mt-2 flex-row items-center justify-center gap-2 rounded-full px-4 py-3 ${
          canSubmit ? "bg-light-primary-red" : "bg-light-matte-black/15"
        }`}
      >
        <Text
          className={`text-sm font-bold ${
            canSubmit ? "text-white" : "text-light-matte-black/40"
          }`}
        >
          {noPools || needsAmountChoice
            ? "Choose an amount"
            : entryState === 2
              ? "Start this plan"
              : `Invest ${formatUsd(amount, { cents: false })}`}
        </Text>
        {canSubmit ? (
          <ArrowRight size={16} color="#ffffff" strokeWidth={2.5} />
        ) : null}
      </TouchableOpacity>

      {secondaryRow(whyTheseVenues)}
      {showSetupCTA ? <SetupStrategyCTA /> : null}
    </View>
  );
};

export default OpportunityQuickInvestCard;
