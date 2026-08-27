/**
 * Quick Invest — the client-side allocation algorithm behind
 * `OpportunityQuickInvestCard` (docs/defi-quick-invest-spec.md §5, §6, §11).
 *
 * Pure and framework-free on purpose: this is the part that turns "one USD
 * total" into "N concrete deposit legs", and it is the part worth unit
 * testing (§10). The card renders the output; it computes nothing itself.
 *
 * Three rules from the spec are load-bearing here and easy to get wrong:
 *
 *  - **Single asset (§5.0).** A `defi_deposit` leg is denominated in one
 *    asset and there is no swap step on this path, so splitting a USD total
 *    across three *different* assets would silently assume the user holds
 *    all three. Allocation therefore resolves ONE `asset_symbol` first and
 *    filters to it before anything else.
 *  - **Minimum leg size, not a total threshold (§11.2).** `N = clamp(
 *    floor(total / 50), 1, 3)`. A small total collapses to the single
 *    safest pool instead of fragmenting into legs too small to be worth
 *    their own gas.
 *  - **`apy_7d_avg`, everywhere (§11.5).** The headline projection reads as
 *    a promise, so it rests on the smoother figure — and the per-leg
 *    breakdown must use the same basis or a user who checks the arithmetic
 *    finds a discrepancy.
 */

/** No leg smaller than this (§11.2). Also the granularity of `N`. */
export const MIN_LEG_USD = 50;
/** Never more than three legs — beyond that the breakdown stops reading. */
export const MAX_LEGS = 3;
/** State 2 starter: a share of the detected idle balance (§11.1). */
export const STARTER_SHARE = 0.25;
export const STARTER_MIN_USD = 50;
export const STARTER_MAX_USD = 500;
/** State 2 starter when no balance is detectable at all (§11.1, §11.6). */
export const STARTER_FALLBACK_USD = 100;

export type QuickInvestRow = {
  protocol_slug: string;
  chain_id?: number;
  chain_name?: string;
  namespace?: string;
  asset_symbol?: string;
  asset_contract?: string | null;
  pool_id?: string;
  pool_meta?: string | null;
  in_app?: boolean;
  /** Outside the user's saved risk tier (see `allocatableRows`). */
  outside_tier?: boolean;
  apy?: number | string;
  apy_7d_avg?: number | string;
  score?: number;
  tier?: string;
  il_exposure?: boolean;
};

export type AllocationLeg<TRow extends QuickInvestRow = QuickInvestRow> = {
  row: TRow;
  /** USD assigned to this leg. Legs sum to the requested total exactly. */
  amountUsd: number;
  /** Share of the total, derived from the ROUNDED amount so $ and % agree. */
  weight: number;
  /** `apy_7d_avg` where present, else `apy`, in percent units. */
  apy: number;
};

export type Allocation<TRow extends QuickInvestRow = QuickInvestRow> = {
  assetSymbol: string | null;
  legs: AllocationLeg<TRow>[];
  totalUsd: number;
  /** Σ(weight · apy), percent units. 0 when there are no legs. */
  blendedApy: number;
  projectedMonthlyUsd: number;
  projectedYearlyUsd: number;
};

function toNum(value: number | string | undefined | null): number {
  if (value === undefined || value === null) return Number.NaN;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * The APY a projection is allowed to rest on (§11.5): the 7-day average
 * where the row has one, the current APY otherwise, 0 when neither parses.
 */
export function projectionApy(row: QuickInvestRow): number {
  const avg = toNum(row.apy_7d_avg);
  if (Number.isFinite(avg)) return avg;
  const now = toNum(row.apy);
  return Number.isFinite(now) ? now : 0;
}

function scoreOf(row: QuickInvestRow): number {
  const n = toNum(row.score);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Two decimals, without float dust ($0.1 + $0.2 style drift). */
function money(n: number): number {
  return Math.round(n * 100) / 100;
}

const normalizeSymbol = (s: string | undefined | null) =>
  (s ?? "").trim().toUpperCase();

/**
 * Rows that Quick Invest may allocate into at all: executable in-app
 * (manual pools have no deposit path — the same rule the browse list's
 * checkbox builder already enforces) and carrying a usable asset symbol.
 */
export function allocatableRows<TRow extends QuickInvestRow>(
  rows: readonly TRow[],
): TRow[] {
  return rows.filter(
    (r) =>
      r.in_app === true &&
      // The risk ceiling holds. A row outside the user's saved tier is
      // returned only so the card can say it exists; auto-allocating into
      // it would turn "here is what you're missing" into "here is where I
      // put your money".
      r.outside_tier !== true &&
      normalizeSymbol(r.asset_symbol),
  );
}

/** Safest-first, APY as the tiebreak — the same order the browse list uses. */
function rankRows<TRow extends QuickInvestRow>(rows: readonly TRow[]): TRow[] {
  return [...rows].sort((a, b) => {
    const byScore = scoreOf(b) - scoreOf(a);
    if (byScore !== 0) return byScore;
    return projectionApy(b) - projectionApy(a);
  });
}

/**
 * §5.0 step 3 — the asset whose best-scoring row leads.
 *
 * `usable` filters to assets the card can actually TRANSACT in. Without
 * it this ranked on safety score alone, which is how a wallet on Avalanche
 * ended up allocated into BTC.B at 0.01% APY: that row genuinely had the
 * best safety score, but the asset had no resolvable USD price, so the
 * projection read $0.00, the CTA was dead, and the card contradicted the
 * agent's own answer in the same turn (which had recommended USDC at
 * ~4.7%). An asset that cannot be priced cannot be converted from a USD
 * amount, so choosing one guarantees a card that looks right and does
 * nothing.
 */
export function bestScoringAsset<TRow extends QuickInvestRow>(
  rows: readonly TRow[],
  usable?: (assetSymbol: string) => boolean,
): string | null {
  const ranked = rankRows(allocatableRows(rows));
  if (usable) {
    const actionable = ranked.find((r) =>
      usable(normalizeSymbol(r.asset_symbol)),
    );
    if (actionable) return normalizeSymbol(actionable.asset_symbol);
  }
  // Last resort: an unusable asset still beats an empty card, and the UI
  // has an honest "we can't price this" state for exactly this case.
  return ranked.length > 0 ? normalizeSymbol(ranked[0].asset_symbol) : null;
}

/**
 * §5.0 — resolve the ONE asset the allocation is denominated in.
 *
 * Order: what the model passed → the asset behind the detected idle
 * balance → the best-scoring asset the card can act on. Each candidate is
 * only accepted if it actually appears among the allocatable rows;
 * otherwise the card would open on an asset it cannot deposit into.
 *
 * `canPrice` is what keeps the fallback honest — see `bestScoringAsset`.
 * The first two candidates skip it deliberately: an asset the user named,
 * or one they are actually holding, is what they meant even if we have to
 * show a degraded state for it.
 */
export function resolveTargetAsset<TRow extends QuickInvestRow>(
  rows: readonly TRow[],
  candidates: {
    inputAsset?: string | null;
    detectedAsset?: string | null;
    canPrice?: (assetSymbol: string) => boolean;
  },
): string | null {
  const available = new Set(
    allocatableRows(rows).map((r) => normalizeSymbol(r.asset_symbol)),
  );
  for (const candidate of [candidates.inputAsset, candidates.detectedAsset]) {
    const sym = normalizeSymbol(candidate);
    if (sym && available.has(sym)) return sym;
  }
  return bestScoringAsset(rows, candidates.canPrice);
}

/**
 * §11.2 — how many legs a total is worth. `count` caps it when fewer pools
 * are available than the total would otherwise buy.
 */
export function legCount(totalUsd: number, count: number): number {
  if (count <= 0 || !Number.isFinite(totalUsd) || totalUsd <= 0) return 0;
  const byTotal = Math.floor(totalUsd / MIN_LEG_USD);
  return Math.max(1, Math.min(MAX_LEGS, Math.min(byTotal, count)));
}

/**
 * §11.1 — the amount State 2 opens on when the user named a goal but no
 * number. Deliberately NOT varied by tier: tier decides *where* the money
 * goes, never *how much* the user starts with.
 */
export function starterAmountUsd(idleUsd: number | null | undefined): number {
  if (idleUsd === null || idleUsd === undefined || !Number.isFinite(idleUsd)) {
    return STARTER_FALLBACK_USD;
  }
  if (idleUsd <= 0) return STARTER_FALLBACK_USD;
  const proportional = idleUsd * STARTER_SHARE;
  // The clamp is what keeps the suggestion from looking reckless at either
  // end: a flat $500 is impossible for someone holding $80, a flat $50 is
  // noise for someone holding $50k. When the balance itself is below the
  // floor, suggest the balance rather than more than the user has.
  if (idleUsd < STARTER_MIN_USD) return money(idleUsd);
  return money(
    Math.min(STARTER_MAX_USD, Math.max(STARTER_MIN_USD, proportional)),
  );
}

export type SliderBounds = { min: number; max: number; step: number };

function niceStep(max: number): number {
  if (max <= 200) return 5;
  if (max <= 1_000) return 10;
  if (max <= 5_000) return 25;
  if (max <= 20_000) return 100;
  if (max <= 100_000) return 500;
  return 1_000;
}

/**
 * The range the amount slider spans.
 *
 * `openingAmountUsd` is the amount the card OPENED on — never the live
 * value being dragged. That distinction is the whole point of the
 * parameter's name: when no balance is detected the ceiling is derived
 * from the amount, so feeding it the live value made `max` grow as the
 * user dragged right, which pushed the thumb back left and made it chase
 * the finger. Bounds must be stable for the duration of an interaction.
 *
 * When the wallet balance IS known it is the ceiling, verbatim: a slider
 * that can pick more than the user holds only produces a deposit that
 * fails at the executor.
 */
export function sliderBounds(args: {
  openingAmountUsd: number;
  idleUsd?: number | null;
}): SliderBounds {
  const openingAmountUsd = Math.max(0, toNum(args.openingAmountUsd) || 0);
  const idle =
    args.idleUsd !== null &&
    args.idleUsd !== undefined &&
    Number.isFinite(args.idleUsd) &&
    args.idleUsd > 0
      ? args.idleUsd
      : null;

  let max: number;
  if (idle !== null && idle >= openingAmountUsd) {
    // The balance is the ceiling, used VERBATIM — rounding it up to a nice
    // step would let the slider reach past what the user actually holds.
    max = idle;
  } else {
    // No balance (non-EVM per §11.6, or an unpriced asset), or a stated
    // amount above it — which still has to be reachable, since the balance
    // may be stale or held on another chain. The $1,000 floor keeps the
    // no-signal case explorable: a ceiling derived only from an opening
    // value of 0 would cap the slider at pocket change.
    const headroom = Math.max(openingAmountUsd * 1.6, 1_000);
    const step = niceStep(headroom);
    max = Math.ceil(headroom / step) * step;
  }

  const step = niceStep(max);
  const min = Math.min(step, max);
  return { min, max, step };
}

/**
 * The value under a touch at absolute `pageX`, given the track's measured
 * origin and width. Returns `null` before the track has been laid out.
 *
 * Extracted and tested because this is precisely where the slider was
 * wrong: the obvious implementation reads `e.nativeEvent.locationX`, which
 * is relative to whichever view RECEIVED the touch. The moment a finger
 * crosses the thumb, that is the thumb's own 20px box, so the value
 * collapses toward the minimum and snaps back on the way off — the "slider
 * fighting you" symptom. Taking an absolute coordinate and subtracting a
 * measured origin is what makes the answer independent of which child was
 * hit.
 */
export function valueAtPageX(args: {
  pageX: number;
  trackOriginX: number;
  trackWidth: number;
  bounds: SliderBounds;
}): number | null {
  const { pageX, trackOriginX, trackWidth, bounds } = args;
  if (!Number.isFinite(trackWidth) || trackWidth <= 0) return null;
  const fraction = (pageX - trackOriginX) / trackWidth;
  const clamped = Math.min(1, Math.max(0, fraction));
  return snapToStep(bounds.min + clamped * (bounds.max - bounds.min), bounds);
}

export function snapToStep(value: number, bounds: SliderBounds): number {
  const clamped = Math.min(bounds.max, Math.max(bounds.min, value));
  const snapped = Math.round(clamped / bounds.step) * bounds.step;
  return money(Math.min(bounds.max, Math.max(bounds.min, snapped)));
}

/**
 * §5.1 — split `totalUsd` across the safest in-app pools for one asset.
 *
 * `minLegUsdFor` is the §5.2 *bonus*: where a row's adapter exposes
 * `minDepositRaw`, the caller converts it to USD and passes it here. It is
 * presence-checked, never assumed — exactly one adapter in the repo defines
 * it today, so the flat $50 floor is the mechanism and this only tightens.
 */
export function allocate<TRow extends QuickInvestRow>(args: {
  rows: readonly TRow[];
  totalUsd: number;
  assetSymbol: string | null;
  minLegUsdFor?: (row: TRow) => number | undefined;
}): Allocation<TRow> {
  const { rows, assetSymbol, minLegUsdFor } = args;
  const totalUsd = money(Math.max(0, toNum(args.totalUsd) || 0));
  const empty: Allocation<TRow> = {
    assetSymbol,
    legs: [],
    totalUsd,
    blendedApy: 0,
    projectedMonthlyUsd: 0,
    projectedYearlyUsd: 0,
  };
  if (totalUsd <= 0 || !assetSymbol) return empty;

  const wanted = normalizeSymbol(assetSymbol);
  const candidates = rankRows(
    allocatableRows(rows).filter(
      (r) => normalizeSymbol(r.asset_symbol) === wanted,
    ),
  ).filter((r) => {
    // A pool whose own minimum exceeds the whole budget can never be part
    // of any split — drop it before it can displace a usable pool.
    const rowMin = minLegUsdFor?.(r);
    return rowMin === undefined || rowMin <= totalUsd;
  });
  if (candidates.length === 0) return empty;

  // Try the leg count the total buys, then walk down. A leg that would fall
  // under its own adapter minimum is what forces the retry; the flat floor
  // is already encoded in `legCount`.
  for (let n = legCount(totalUsd, candidates.length); n >= 1; n -= 1) {
    const picked = candidates.slice(0, n);
    const amounts = splitByScore(picked, totalUsd);
    const violates = picked.some((row, i) => {
      const rowMin = minLegUsdFor?.(row);
      return rowMin !== undefined && amounts[i] < rowMin;
    });
    if (violates && n > 1) continue;
    const legs: AllocationLeg<TRow>[] = picked.map((row, i) => ({
      row,
      amountUsd: amounts[i],
      weight: totalUsd > 0 ? amounts[i] / totalUsd : 0,
      apy: projectionApy(row),
    }));
    const blendedApy = legs.reduce((sum, leg) => sum + leg.weight * leg.apy, 0);
    return {
      assetSymbol: wanted,
      legs,
      totalUsd,
      blendedApy,
      projectedMonthlyUsd: (totalUsd * blendedApy) / 100 / 12,
      projectedYearlyUsd: (totalUsd * blendedApy) / 100,
    };
  }
  return empty;
}

/**
 * `weight_i = score_i / Σscore`, rounded to cents with the remainder folded
 * into the LARGEST leg so `Σamount_i === total` exactly (§5.1 step 4). A
 * naive per-leg round under/over-shoots the total by a cent or two, which
 * shows up as a breakdown that does not add up to the headline.
 */
function splitByScore(
  rows: readonly QuickInvestRow[],
  totalUsd: number,
): number[] {
  const scores = rows.map(scoreOf);
  const sum = scores.reduce((a, b) => a + b, 0);
  // No usable scores (all missing/zero) — even split rather than a
  // divide-by-zero. Ranking already put the safest first either way.
  const weights =
    sum > 0 ? scores.map((s) => s / sum) : rows.map(() => 1 / rows.length);
  const amounts = weights.map((w) => money(totalUsd * w));
  const drift = money(totalUsd - amounts.reduce((a, b) => a + b, 0));
  if (drift !== 0) {
    let largest = 0;
    for (let i = 1; i < amounts.length; i += 1) {
      if (amounts[i] > amounts[largest]) largest = i;
    }
    amounts[largest] = money(amounts[largest] + drift);
  }
  return amounts;
}

/**
 * The natural-language deposit request the card hands to the agent.
 *
 * Shared with the browse list's multi-select builder so the two paths can
 * never drift into describing the same deposit differently. `amount` is a
 * pre-formatted string: browse passes the user's typed text verbatim
 * ("100.50"), Quick Invest passes its computed token amount.
 */
export type DepositLeg = {
  amount: string;
  symbol: string;
  protocolLabel: string;
  poolMeta?: string | null;
  chain?: string | null;
  poolId?: string;
};

export function buildDepositPrompt(legs: readonly DepositLeg[]): string {
  const parts = legs.map((leg) => {
    const meta = leg.poolMeta ? ` — ${leg.poolMeta}` : "";
    // Carry the exact poolId so the agent pins the precise pool (spec §6):
    // EVM routes it into `defi_deposit { pool_id }`, Sui into
    // `defi_intent_preview { poolId }`. The agent routes by the row's
    // chain/namespace, not by this hint.
    const poolHint = leg.poolId ? ` (pool_id ${leg.poolId})` : "";
    return `${leg.amount} ${leg.symbol} into ${leg.protocolLabel}${meta}${
      leg.chain ? ` on ${leg.chain}` : ""
    }${poolHint}`;
  });
  return parts.length === 1
    ? `Deposit ${parts[0]} from my wallet. Please proceed.`
    : `Deposit the following from my wallet: ${parts.join("; ")}. Please proceed.`;
}

/**
 * Token units for a USD leg. `priceUsd` is 1 for the USD-pegged
 * stablecoins that dominate this surface; anything else comes from the
 * backend's Alchemy price proxy (§6.1) and may legitimately be unknown, in
 * which case there is no honest conversion and the caller must not guess.
 */
export function usdToTokenAmount(
  amountUsd: number,
  priceUsd: number | null | undefined,
  decimals = 6,
): string | null {
  if (!priceUsd || !Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  const tokens = amountUsd / priceUsd;
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  // Trim trailing zeros so the prompt reads "100" not "100.000000".
  const fixed = tokens.toFixed(Math.min(decimals, 8));
  return fixed.replace(/\.?0+$/, "") || "0";
}

/** USD-pegged assets a price lookup would only add drift to (§6.1). */
const USD_PEGGED = new Set([
  "USDC",
  "USDC.E",
  "USDT",
  "USDT0",
  "DAI",
  "USDS",
  "USDE",
  "SUSDE",
  "SUSDS",
  "FRAX",
  "LUSD",
  "GHO",
  "PYUSD",
  "USDAI",
  "USDBC",
  "CRVUSD",
  "TUSD",
  "FDUSD",
  "BUSD",
  "USDGLO",
  "EURC",
]);

export function isUsdPegged(symbol: string | undefined | null): boolean {
  return USD_PEGGED.has(normalizeSymbol(symbol));
}

export function formatUsd(value: number, opts?: { cents?: boolean }): string {
  if (!Number.isFinite(value)) return "—";
  const cents = opts?.cents ?? Math.abs(value) < 100;
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  })}`;
}
