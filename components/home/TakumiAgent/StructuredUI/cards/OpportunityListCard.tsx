/**
 * OpportunityListCard — renders `defi_list_opportunities` results.
 *
 * Reads the structured payload emitted by the mobile executor in
 * `services/agent-executors/defi/reads.ts` (`{ opportunities: [...] }`).
 * Per CLAUDE.md user-facing-error rule the failure branch shows
 * hand-written friendly copy; the raw `output.error` (curated code
 * like `unknown_error` / `authentication_required`) goes to dev logs
 * only.
 *
 * Presentation (full redesign):
 *  - Rows are ranked by safety (`score` desc, APY as tiebreak) so the
 *    safest venue leads; testnets sink to the bottom and are hidden
 *    entirely in production builds when any mainnet row exists.
 *  - The list pages in groups of `PREVIEW_COUNT` via Prev/Next (shared
 *    `PagerButton`), mirroring the redemption-catalog card.
 *  - Raw DeFiLlama slugs (`aave-v3-base-sepolia`) are prettified into
 *    display names (text only — no icon/avatar; this is a data-comparison
 *    list, not a brand grid); the chain is shown once as metadata instead
 *    of being baked into the slug.
 *  - APY is the hero number (with 7d-avg context); the repeated risk
 *    pill collapses into a single header chip when every row shares a
 *    tier, and the unused `score` surfaces as a "Safety" signal.
 *  - Rows are tappable → they ask the agent to dig into that specific
 *    opportunity as the user's pick (works for strategy-less browsers,
 *    unlike the strategy-gated /strategies detail screen). Inert in
 *    historical mode where `onUserPrompt` is undefined.
 *  - The empty state is actionable: tap to ask the agent to widen.
 */

import { router } from "expo-router";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Coins,
  ExternalLink,
  LogIn,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from "lucide-react-native";
import type React from "react";
import { useMemo, useState } from "react";
import {
  Pressable,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { strategiesApi } from "@/api/endpoints/strategies";
import SingleLoadingSekeleton from "@/components/common/SingleLoadingSekeleton";
import { useUserStrategy } from "@/hooks/queries/useStrategy";
import {
  type DisplayPool,
  groupOpportunities,
  type OpportunityGroup,
  type RawOpportunity,
} from "@/services/defi/opportunityDisplay";
import { protocolAppUrl } from "@/services/defi/protocolLinks";
import { getChainFamilyLabel } from "@/services/walletKit/chainInfo";
import { tapFeedback } from "@/utils/hapticsUtils";
import type { ToolComponentProps } from "../types";
import PagerButton from "./PagerButton";
import SetupStrategyCTA from "./SetupStrategyCTA";

const BRAND_RED = "#c71c4b";
const PREVIEW_COUNT = 6;

type RiskTier = "conservative" | "balanced" | "aggressive";

type OpportunityRow = {
  id?: string;
  protocol_slug: string;
  chain_id?: number;
  chain_name?: string;
  namespace?: string;
  asset_symbol?: string;
  pool_id?: string;
  /** DeFiLlama vault/market name — disambiguates sibling pools (spec §4.2). */
  pool_meta?: string | null;
  /** Protocol's own site for the "Manual" deep-link (spec §9.1). */
  app_url?: string | null;
  /** Executability: true ⇒ AI-agent-executable in-app; else "Manual" (§2.1). */
  in_app?: boolean;
  apy?: number | string;
  apy_7d_avg?: number | string;
  tvl_usd?: number | string;
  score?: number;
  tier?: RiskTier | string;
  il_exposure?: boolean;
};

type OpportunityInput = {
  tier?: string;
  asset_symbol?: string;
  chain_id?: number;
  liquidity_profile?: string;
  amount_usd?: number;
};

type OpportunityOutput = {
  status?: "success" | "failed" | string;
  error?: string;
  data?: {
    opportunities?: OpportunityRow[];
    count?: number;
  };
};

const TIER_LABEL: Record<string, string> = {
  conservative: "Low risk",
  balanced: "Moderate risk",
  aggressive: "High risk",
};

const TIER_PILL_COLOR: Record<string, string> = {
  conservative: "bg-green-100 text-green-700",
  balanced: "bg-amber-100 text-amber-700",
  aggressive: "bg-rose-100 text-rose-700",
};

// Known DeFiLlama / adapter slugs → human display names. Anything not
// listed falls back to title-casing the slug (after stripping a trailing
// chain suffix), so new protocols still read cleanly without an entry.
const PROTOCOL_DISPLAY_NAMES: Record<string, string> = {
  "aave-v3": "Aave V3",
  "aave-v2": "Aave V2",
  aave: "Aave",
  "fluid-lending": "Fluid",
  fluid: "Fluid",
  "centrifuge-protocol": "Centrifuge",
  centrifuge: "Centrifuge",
  maple: "Maple",
  "morpho-vault": "Morpho",
  "morpho-blue": "Morpho",
  morpho: "Morpho",
  "compound-v3": "Compound V3",
  "compound-v2": "Compound V2",
  spark: "Spark",
  "sky-lending": "Sky",
  sky: "Sky",
  "ethena-usde": "Ethena",
  ethena: "Ethena",
  lido: "Lido",
  "jito-solana": "Jito",
  jito: "Jito",
  "yearn-finance": "Yearn",
  "yearn-v3": "Yearn",
  yearn: "Yearn",
  "curve-dex": "Curve",
  curve: "Curve",
  scallop: "Scallop",
  navi: "Navi",
};

// Trailing chain qualifiers we strip from a slug before prettifying, so
// "aave-v3-base-sepolia" → "aave-v3" (the chain is shown separately).
const CHAIN_SUFFIXES = [
  "-base-sepolia",
  "-arbitrum-sepolia",
  "-optimism-sepolia",
  "-ethereum-sepolia",
  "-sepolia",
  "-base",
  "-arbitrum",
  "-optimism",
  "-polygon",
  "-ethereum",
  "-mainnet",
];

const TESTNET_CHAIN_IDS = new Set<number>([
  11155111, // Ethereum Sepolia
  84532, // Base Sepolia
  421614, // Arbitrum Sepolia
  11155420, // Optimism Sepolia
  80002, // Polygon Amoy
  97, // BNB testnet
  43113, // Avalanche Fuji
  59141, // Linea Sepolia
  534351, // Scroll Sepolia
]);

function apyNumber(value: OpportunityRow["apy"]): number {
  if (value === undefined || value === null) return Number.NEGATIVE_INFINITY;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
}

// Keep only digits and a single decimal point as the user types an amount.
function sanitizeAmount(raw: string): string {
  const cleaned = raw.replace(/[^0-9.]/g, "");
  const [whole, ...rest] = cleaned.split(".");
  return rest.length ? `${whole}.${rest.join("")}` : whole;
}

function amountValue(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function formatApy(value: OpportunityRow["apy"]): string {
  const n = apyNumber(value);
  if (!Number.isFinite(n)) return "—";
  // Backend stores APY in percent units (e.g. 5.2 == 5.2%) so render
  // directly without multiplying.
  return `${n.toFixed(2)}%`;
}

function formatTvl(value: OpportunityRow["tvl_usd"]): string | null {
  if (value === undefined || value === null) return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B TVL`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M TVL`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K TVL`;
  return `$${n.toFixed(0)} TVL`;
}

function formatSafety(value: OpportunityRow["score"]): string | null {
  if (value === undefined || value === null) return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return null;
  return `Safety ${Math.round(n)}`;
}

// Prefer the backend's DeFiLlama-provided label (covers testnets like
// "Ethereum Sepolia" and any chain we haven't hardcoded). Fall back to a
// best-effort lookup by chainId for legacy payloads that omit the name.
function chainLabel(
  chainName?: string,
  chainId?: number,
  namespace?: string,
): string | null {
  if (chainName && chainName.trim()) return chainName;
  // Non-EVM payloads (Solana / Sui) carry a namespace but no numeric
  // chainId — ask the registry for the chain-family label instead of
  // branching on the namespace string here.
  if (chainId === undefined && namespace) {
    const label = getChainFamilyLabel(namespace);
    if (label !== "Wallet") return label;
  }
  switch (chainId) {
    case 1:
      return "Ethereum";
    case 8453:
      return "Base";
    case 42161:
      return "Arbitrum";
    case 10:
      return "Optimism";
    case 137:
      return "Polygon";
    case 56:
      return "BNB Chain";
    default:
      return chainId ? `Chain ${chainId}` : null;
  }
}

function prettyProtocol(slug: string): string {
  const lower = slug.trim().toLowerCase();
  if (PROTOCOL_DISPLAY_NAMES[lower]) return PROTOCOL_DISPLAY_NAMES[lower];
  let base = lower;
  for (const suffix of CHAIN_SUFFIXES) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }
  if (PROTOCOL_DISPLAY_NAMES[base]) return PROTOCOL_DISPLAY_NAMES[base];
  return (
    base
      .split(/[-_]/)
      .filter(Boolean)
      .map((word) =>
        /^v\d+$/i.test(word)
          ? word.toUpperCase()
          : word.charAt(0).toUpperCase() + word.slice(1),
      )
      .join(" ") || slug
  );
}

function isTestnetRow(row: OpportunityRow): boolean {
  if (
    row.chain_id !== undefined &&
    TESTNET_CHAIN_IDS.has(Number(row.chain_id))
  ) {
    return true;
  }
  const name = (row.chain_name ?? "").toLowerCase();
  return /sepolia|testnet|goerli|holesky|devnet|fuji|mumbai|amoy/.test(name);
}

function SkeletonRow() {
  return (
    <View className="flex-row items-center gap-3 py-2.5">
      <View className="flex-1">
        <SingleLoadingSekeleton width={120} height={12} borderRadius={4} />
        <SingleLoadingSekeleton
          width={90}
          height={10}
          borderRadius={4}
          style={{ marginTop: 6 }}
        />
      </View>
      <View className="items-end">
        <SingleLoadingSekeleton width={54} height={14} borderRadius={4} />
        <SingleLoadingSekeleton
          width={34}
          height={10}
          borderRadius={4}
          style={{ marginTop: 6 }}
        />
      </View>
    </View>
  );
}

function SafestPill() {
  return (
    <View className="flex-row items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-0.5">
      <ShieldCheck size={9} color="#059669" />
      <Text className="text-[9px] font-bold text-emerald-700">Safest</Text>
    </View>
  );
}

// Bold-bordered indicator matching the app's strongest identity signal —
// the `border-2 border-light-matte-black` + brand-red treatment on the
// RedemptionCatalog product tiles and the Prev/Next PagerButton — so the
// box is unmistakably "ours" in both states (black ring always, red fill
// when checked).
function Checkbox({ checked }: { checked: boolean }) {
  return (
    <View
      className={`w-5 h-5 rounded-md border-2 border-light-matte-black items-center justify-center ${
        checked ? "bg-light-primary-red" : "bg-white"
      }`}
    >
      {checked ? <Check size={13} color="#ffffff" strokeWidth={3} /> : null}
    </View>
  );
}

// Per-row executability chip (spec §2.1 / §9.2). "Manual" reads as a subdued
// grey chip; in-app rows carry the checkbox as their affordance, so they only
// show an "In-app" chip when a group mixes both to make the split explicit.
function ExecBadge({ inApp }: { inApp: boolean }) {
  return inApp ? (
    <View className="rounded-full bg-emerald-50 px-1.5 py-0.5">
      <Text className="text-[9px] font-bold text-emerald-700">In-app</Text>
    </View>
  ) : (
    <View className="rounded-full bg-gray-100 px-1.5 py-0.5">
      <Text className="text-[9px] font-bold text-gray-500">Manual</Text>
    </View>
  );
}

// Leading glyph for a manual pool — replaces the checkbox entirely (§9.2:
// "no checkbox at all"), signalling the deep-link-out affordance instead.
function ManualGlyph() {
  return (
    <View className="w-5 h-5 rounded-md border-2 border-light-matte-black/20 items-center justify-center bg-white">
      <ExternalLink size={11} color="#9ca3af" strokeWidth={2.5} />
    </View>
  );
}

/**
 * One concrete pool. In-app pools are checkable (the multi-select builder
 * acts only on these); manual pools render no checkbox and deep-link out
 * (§9.2). `showProtocol` toggles the protocol name (standalone single-pool
 * group) vs the poolMeta label (inside a sibling drill-down).
 */
function PoolRow({
  pool,
  isTop,
  showTier,
  showProtocol,
  showBadge,
  selected,
  onToggle,
  onManual,
  onInspect,
}: {
  pool: DisplayPool;
  isTop: boolean;
  showTier: boolean;
  showProtocol: boolean;
  showBadge: boolean;
  selected: boolean;
  onToggle: () => void;
  onManual: () => void;
  onInspect: () => void;
}) {
  const inApp = pool.inApp;
  const primary = showProtocol
    ? prettyProtocol(pool.protocol_slug)
    : pool.pool_meta || "Pool";
  const tierKey = String(pool.tier ?? "").toLowerCase();
  const tierLabel = TIER_LABEL[tierKey] ?? tierKey;
  const tierClass = TIER_PILL_COLOR[tierKey] ?? "bg-gray-100 text-gray-700";
  const chain = chainLabel(pool.chain_name, pool.chain_id, pool.namespace);
  const tvl = formatTvl(pool.tvl_usd);
  const safety = formatSafety(pool.score);
  // Standalone rows show asset · chain; inside a group the header already does.
  const meta = showProtocol
    ? [pool.asset_symbol, chain].filter(Boolean).join(" · ")
    : null;
  const subLabel = showProtocol && pool.pool_meta ? pool.pool_meta : null;
  const sevenDay = formatApy(pool.apy_7d_avg);

  return (
    <Pressable
      onPress={() => {
        onInspect();
        (inApp ? onToggle : onManual)();
      }}
      android_ripple={{ color: "rgba(0,0,0,0.04)" }}
      className={`flex-row items-center gap-3 active:opacity-70 px-3.5 py-3 mb-1.5 rounded-2xl border ${
        selected
          ? "border-light-primary-red bg-light-primary-red/10"
          : "border-light-matte-black/10 bg-white"
      }`}
    >
      {inApp ? <Checkbox checked={selected} /> : <ManualGlyph />}
      <View className="flex-1 min-w-0">
        <View className="flex-row items-center gap-1.5">
          <Text
            className={`text-sm font-semibold shrink ${
              selected ? "text-light-primary-red" : "text-light-matte-black"
            }`}
            numberOfLines={1}
          >
            {primary}
          </Text>
          {isTop ? <SafestPill /> : null}
          {showBadge ? <ExecBadge inApp={inApp} /> : null}
        </View>
        {subLabel ? (
          <Text className="text-[11px] text-gray-500 mt-0.5" numberOfLines={1}>
            {subLabel}
          </Text>
        ) : null}
        {meta ? (
          <Text className="text-[11px] text-gray-500 mt-0.5" numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
        <View className="flex-row items-center flex-wrap gap-x-1 mt-0.5">
          {tvl ? (
            <Text className="text-[11px] text-gray-400">{tvl}</Text>
          ) : null}
          {safety ? (
            <Text className="text-[11px] text-gray-400">
              {tvl ? "· " : ""}
              {safety}
            </Text>
          ) : null}
          {pool.il_exposure ? (
            <Text className="text-[11px] text-rose-600">· IL risk</Text>
          ) : null}
          {!inApp ? (
            <Text className="text-[11px] text-light-primary-red font-medium">
              {tvl || safety ? "· " : ""}Deposit on site ↗
            </Text>
          ) : null}
        </View>
      </View>

      <View className="items-end">
        <Text className="text-base font-bold text-emerald-600">
          {formatApy(pool.apy)}
        </Text>
        {sevenDay !== "—" ? (
          <Text className="text-[10px] text-gray-400 mt-0.5">
            7d {sevenDay}
          </Text>
        ) : null}
        {showTier && tierLabel ? (
          <View
            className={`rounded-full px-2 py-0.5 mt-1 ${tierClass.split(" ")[0]}`}
          >
            <Text
              className={`text-[10px] font-semibold ${tierClass.split(" ")[1]}`}
            >
              {tierLabel}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * A `(protocol, asset, chain)` group. A single-pool group renders as one flat
 * PoolRow (the common case — unchanged UX). A multi-pool group renders a
 * tappable header ("best of N pools") that expands to the sibling drill-down;
 * each sibling is a PoolRow. Only in-app siblings are checkable.
 */
function GroupCard({
  group,
  isTop,
  showTier,
  expanded,
  onToggleExpand,
  isSelected,
  onTogglePool,
  onManualPool,
  onInspect,
}: {
  group: OpportunityGroup;
  isTop: boolean;
  showTier: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  isSelected: (rowKey: string) => boolean;
  onTogglePool: (rowKey: string) => void;
  onManualPool: (slug: string, appUrl?: string | null) => void;
  onInspect: (pool: DisplayPool) => void;
}) {
  const mixed = group.inAppCount > 0 && group.inAppCount < group.poolCount;

  if (group.poolCount === 1) {
    const pool = group.pools[0];
    return (
      <PoolRow
        pool={pool}
        isTop={isTop}
        showTier={showTier}
        showProtocol
        showBadge={!pool.inApp}
        selected={isSelected(pool.rowKey)}
        onToggle={() => onTogglePool(pool.rowKey)}
        onManual={() => onManualPool(pool.protocol_slug, pool.app_url)}
        onInspect={() => onInspect(pool)}
      />
    );
  }

  const name = prettyProtocol(group.protocolSlug);
  const chain = chainLabel(group.chainName, group.chainId, group.namespace);
  const meta = [group.assetSymbol, chain].filter(Boolean).join(" · ");
  const tierKey = String(group.tier ?? "").toLowerCase();
  const tierLabel = TIER_LABEL[tierKey] ?? tierKey;
  const tierClass = TIER_PILL_COLOR[tierKey] ?? "bg-gray-100 text-gray-700";
  const selectedInGroup = group.pools.filter((p) =>
    isSelected(p.rowKey),
  ).length;

  return (
    <View className="mb-1.5 rounded-2xl border border-light-matte-black/10 bg-white overflow-hidden">
      <Pressable
        onPress={() => {
          tapFeedback();
          onToggleExpand();
        }}
        android_ripple={{ color: "rgba(0,0,0,0.04)" }}
        className="flex-row items-center gap-3 px-3.5 py-3 active:opacity-70"
      >
        {expanded ? (
          <ChevronDown size={18} color="#6b7280" />
        ) : (
          <ChevronRight size={18} color="#6b7280" />
        )}
        <View className="flex-1 min-w-0">
          <View className="flex-row items-center gap-1.5">
            <Text
              className="text-sm font-semibold text-light-matte-black shrink"
              numberOfLines={1}
            >
              {name}
            </Text>
            {isTop ? <SafestPill /> : null}
          </View>
          {meta ? (
            <Text
              className="text-[11px] text-gray-500 mt-0.5"
              numberOfLines={1}
            >
              {meta}
            </Text>
          ) : null}
          <Text className="text-[11px] text-gray-400 mt-0.5">
            {group.inAppCount > 0
              ? `${group.inAppCount} in-app · ${group.poolCount} pools`
              : `${group.poolCount} pools · manual`}
            {selectedInGroup > 0 ? ` · ${selectedInGroup} selected` : ""}
          </Text>
        </View>
        <View className="items-end">
          <Text className="text-base font-bold text-emerald-600">
            best {formatApy(group.bestApy)}
          </Text>
          {showTier && tierLabel ? (
            <View
              className={`rounded-full px-2 py-0.5 mt-1 ${tierClass.split(" ")[0]}`}
            >
              <Text
                className={`text-[10px] font-semibold ${tierClass.split(" ")[1]}`}
              >
                {tierLabel}
              </Text>
            </View>
          ) : null}
        </View>
      </Pressable>
      {expanded ? (
        <View className="px-2 pb-2 pt-0.5 gap-1.5">
          {group.pools.map((pool) => (
            <PoolRow
              key={pool.rowKey}
              pool={pool}
              isTop={false}
              showTier={false}
              showProtocol={false}
              showBadge={mixed}
              selected={isSelected(pool.rowKey)}
              onToggle={() => onTogglePool(pool.rowKey)}
              onManual={() => onManualPool(pool.protocol_slug, pool.app_url)}
              onInspect={() => onInspect(pool)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const OpportunityListCard: React.FC<
  ToolComponentProps<OpportunityInput, OpportunityOutput>
> = ({ state, input, output, onUserPrompt, showSetupCTA = true }) => {
  const { data: strategy } = useUserStrategy();
  const [page, setPage] = useState(0);
  // Multi-select deposit builder: checked pools + their per-row amount, keyed
  // by the stable rowKey so a selection survives paging (spec §9.2). Only
  // in-app pools are ever added.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  // Which multi-pool groups are expanded to their sibling drill-down.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggleRow = (key: string) => {
    tapFeedback();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleExpand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  // "Manual" deep-link: open the protocol's own UI in the in-app dapps-browser
  // (still on the Takumi wallet via the DappBridge; spec §9.1). Prefer the
  // server-provided protocol URL (`app_url`) so long-tail venues open their
  // real dApp instead of the DeFiLlama page.
  const openManual = (slug: string, appUrl?: string | null) => {
    tapFeedback();
    router.push({
      pathname: "/dapps-browser",
      params: { url: protocolAppUrl(slug, appUrl) },
    });
  };
  // DEV-only diagnostic: the resolved deposit target (the actual on-chain
  // address/ids) is intentionally kept OUT of the card payload (spec §8 — the
  // LLM/client never handles an address), so on press we fetch it by poolId and
  // log the on-chain identity the backend resolver produced: EVM contract
  // (erc4626 vault / aave pool), Sui package+object ids (scallop-market), or
  // Solana program+reserve+mint. `depositTarget: null` ⇒ unresolved (Manual).
  // Never runs in production.
  const devLogResolvedTarget = (pool: DisplayPool) => {
    if (!__DEV__ || !pool.pool_id) return;
    strategiesApi
      .getPool(pool.pool_id)
      .then((o) => {
        console.log("[OpportunityListCard] resolved deposit target", {
          protocol: pool.protocol_slug,
          poolMeta: pool.pool_meta ?? null,
          chain: pool.chain_name ?? pool.chain_id ?? pool.namespace ?? null,
          poolId: pool.pool_id,
          inApp: pool.inApp,
          assetContract: o.assetContract,
          depositTarget: o.depositTarget,
          appUrl: o.appUrl,
        });
      })
      .catch((err) => {
        console.warn("[OpportunityListCard] getPool failed", err);
      });
  };

  const inputTierLabel = input?.tier
    ? (TIER_LABEL[input.tier] ?? input.tier)
    : null;

  // Group siblings by (protocol, asset, chain) so a multi-vault protocol shows
  // as ONE row with a "best of N pools" drill-down instead of N indistinct
  // rows (spec §2.1, §9). Testnets are filtered first (hidden in production
  // when any mainnet row exists), then grouping ranks groups safest-first.
  const groups = useMemo(() => {
    const all = output?.data?.opportunities ?? [];
    const mainnet = all.filter((r) => !isTestnetRow(r));
    const visible = !__DEV__ && mainnet.length > 0 ? mainnet : all;
    return groupOpportunities(visible as RawOpportunity[]);
  }, [output]);

  // Flattened pools (across all groups + pages) drive selection + counts.
  const allPools = useMemo(() => groups.flatMap((g) => g.pools), [groups]);

  const headerAsset = useMemo(() => {
    const assets = new Set(
      allPools.map((p) => p.asset_symbol).filter(Boolean) as string[],
    );
    return assets.size === 1 ? [...assets][0] : null;
  }, [allPools]);

  const header = inputTierLabel
    ? `${inputTierLabel} opportunities`
    : headerAsset
      ? `Yield on your ${headerAsset}`
      : "Yield opportunities";

  if (state === "input-streaming" || state === "input-available" || !output) {
    return (
      <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-3">
        <View className="flex-row items-center gap-2 mb-1">
          <TrendingUp size={14} color={BRAND_RED} />
          <Text className="text-xs font-bold uppercase tracking-wide text-light-matte-black">
            {header}
          </Text>
          <View className="ml-auto">
            <SingleLoadingSekeleton width={50} height={10} borderRadius={4} />
          </View>
        </View>
        <View className="gap-1.5">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </View>
      </View>
    );
  }

  if (state === "output-error" || output.status === "failed") {
    if (__DEV__ && output.error) {
      console.warn("[OpportunityListCard] tool result failed:", output.error);
    }
    if (output.error === "authentication_required") {
      return (
        <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-4">
          <View className="flex-row items-center gap-2 mb-2">
            <View className="w-8 h-8 rounded-full bg-light-primary-red/10 items-center justify-center">
              <LogIn size={16} color={BRAND_RED} />
            </View>
            <Text className="text-sm font-semibold text-light-matte-black">
              Sign in to explore DeFi
            </Text>
          </View>
          <Text className="text-sm text-light-matte-black/70 mb-3">
            Sign in to see real-time yield opportunities tailored to your
            wallet&apos;s risk profile.
          </Text>
          <TouchableOpacity
            onPress={() => router.push("/auth")}
            className="bg-light-primary-red rounded-full px-5 py-2.5 self-start"
          >
            <Text className="text-white font-semibold text-sm">Sign in</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <View className="my-1.5 rounded-2xl border border-light-primary-red/30 bg-light-primary-red/5 px-3.5 py-3">
        <View className="flex-row items-center gap-2">
          <AlertTriangle size={14} color={BRAND_RED} />
          <Text className="text-xs font-bold uppercase tracking-wide text-light-primary-red">
            Couldn&apos;t load opportunities
          </Text>
        </View>
        <Text className="text-sm text-light-matte-black/80 mt-1.5">
          We couldn&apos;t load yield opportunities right now. Please try again
          in a moment.
        </Text>
      </View>
    );
  }

  if (groups.length === 0) {
    return (
      <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-3">
        <View className="flex-row items-center gap-2">
          <ShieldCheck size={14} color={BRAND_RED} />
          <Text className="text-xs font-bold uppercase tracking-wide text-light-matte-black">
            {header}
          </Text>
        </View>
        <Text className="text-sm text-light-matte-black/80 mt-1.5">
          No matches for these filters right now.
        </Text>
        {onUserPrompt ? (
          <TouchableOpacity
            onPress={() =>
              onUserPrompt(
                "Show me yield options across all risk levels and chains, even smaller pools.",
              )
            }
            activeOpacity={0.85}
            className="mt-2.5 flex-row items-center justify-center gap-2 rounded-xl border border-light-primary-red/20 bg-light-primary-red/5 px-3 py-2.5"
          >
            <Search size={14} color={BRAND_RED} />
            <Text className="text-xs font-semibold text-light-primary-red">
              See every yield option
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }

  const pageCount = Math.max(1, Math.ceil(groups.length / PREVIEW_COUNT));
  const safePage = Math.min(page, pageCount - 1);
  const shownGroups = groups.slice(
    safePage * PREVIEW_COUNT,
    safePage * PREVIEW_COUNT + PREVIEW_COUNT,
  );
  // Tier uniformity is computed across every pool (not the current page) so
  // the "All Low risk" header chip stays stable while paging.
  const allTiers = new Set(
    allPools.map((p) => String(p.tier ?? "").toLowerCase()).filter(Boolean),
  );
  const uniformTier = allTiers.size === 1 ? [...allTiers][0] : null;
  const uniformTierClass = uniformTier
    ? (TIER_PILL_COLOR[uniformTier] ?? "bg-gray-100 text-gray-700")
    : null;
  const topHasScore = Number.isFinite(groups[0]?.bestScore ?? Number.NaN);
  const topGroupKey = groups[0]?.key;

  // Selected in-app pools (across all pages) drive the deposit builder. A leg
  // is "depositable" once it has a positive amount. Manual pools can never be
  // selected (they have no checkbox), so the batch only ever acts on in-app
  // pools (spec §9.2).
  const selectedPools = allPools.filter(
    (p) => p.inApp && selected.has(p.rowKey),
  );
  const depositable = selectedPools.filter(
    (p) => amountValue(amounts[p.rowKey]) > 0,
  );
  const canDeposit = depositable.length > 0;
  // Submitting needs the live agent callback (undefined once the card goes
  // historical); selection/amount entry stays usable regardless.
  const canSubmit = canDeposit && !!onUserPrompt;
  const submitDeposit = () => {
    if (!onUserPrompt || depositable.length === 0) return;
    const legs = depositable.map((p) => {
      const sym = p.asset_symbol ?? input?.asset_symbol ?? "tokens";
      const chain = chainLabel(p.chain_name, p.chain_id, p.namespace);
      const meta = p.pool_meta ? ` — ${p.pool_meta}` : "";
      // Carry the exact poolId so the agent pins the precise pool (spec §6):
      // EVM routes it into `defi_deposit { pool_id }`, Sui into
      // `defi_intent_preview { poolId }` (pool-level Sui deposits, Phase 3) — a
      // multi-vault Sui venue (Ember) is otherwise ambiguous from the venue name
      // alone. Both paths now consume a pool_id, so include it whenever the pick
      // carries one; the agent routes by the row's chain/namespace, not by this
      // hint (no namespace branch here, per the CI guardrail).
      const poolHint = p.pool_id ? ` (pool_id ${p.pool_id})` : "";
      return `${amounts[p.rowKey]} ${sym} into ${prettyProtocol(
        p.protocol_slug,
      )}${meta}${chain ? ` on ${chain}` : ""}${poolHint}`;
    });
    onUserPrompt(
      legs.length === 1
        ? `Deposit ${legs[0]} from my wallet. Please proceed.`
        : `Deposit the following from my wallet: ${legs.join("; ")}. Please proceed.`,
    );
    setSelected(new Set());
    setAmounts({});
  };

  return (
    <View className="my-1.5-">
      <View className="flex-row items-center gap-2 px-3.5 py-3 mb-1.5 rounded-2xl border border-light-matte-black/10 bg-white">
        <TrendingUp size={14} color={BRAND_RED} />
        <Text className="text-xs font-bold uppercase tracking-wide text-light-matte-black">
          {header}
        </Text>
        <View className="ml-auto flex-row items-center gap-2">
          {uniformTier && uniformTierClass ? (
            <View
              className={`rounded-full px-2 py-0.5 ${uniformTierClass.split(" ")[0]}`}
            >
              <Text
                className={`text-[10px] font-semibold ${uniformTierClass.split(" ")[1]}`}
              >
                All {TIER_LABEL[uniformTier] ?? uniformTier}
              </Text>
            </View>
          ) : null}
          <Text className="text-[10px] text-gray-500">
            {groups.length} option{groups.length === 1 ? "" : "s"}
          </Text>
        </View>
      </View>

      <View className="gap-1.5-">
        {shownGroups.map((group, idx) => (
          <GroupCard
            key={group.key}
            group={group}
            isTop={
              safePage === 0 &&
              idx === 0 &&
              group.key === topGroupKey &&
              groups.length > 1 &&
              topHasScore
            }
            showTier={!uniformTier}
            expanded={expanded.has(group.key)}
            onToggleExpand={() => toggleExpand(group.key)}
            isSelected={(key) => selected.has(key)}
            onTogglePool={toggleRow}
            onManualPool={openManual}
            onInspect={devLogResolvedTarget}
          />
        ))}
      </View>

      {pageCount > 1 ? (
        <View className="mt-2 flex-row items-center justify-between px-0.5">
          <PagerButton
            direction="prev"
            disabled={safePage === 0}
            onPress={() => setPage((p) => Math.max(0, p - 1))}
          />
          <Text className="text-[11px] text-gray-500">
            Page {safePage + 1} of {pageCount}
          </Text>
          <PagerButton
            direction="next"
            disabled={safePage >= pageCount - 1}
            onPress={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          />
        </View>
      ) : null}

      {selectedPools.length > 0 ? (
        <View className="mt-3 rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-3">
          <View className="flex-row items-center gap-1.5 mb-2">
            <Coins size={13} color={BRAND_RED} />
            <Text className="text-[11px] font-bold uppercase tracking-wide text-light-matte-black">
              Amount to deposit
            </Text>
          </View>
          {selectedPools.map((p) => {
            const key = p.rowKey;
            const sym = p.asset_symbol ?? input?.asset_symbol ?? "—";
            const label = p.pool_meta || prettyProtocol(p.protocol_slug);
            return (
              <View key={key} className="flex-row items-center gap-3 py-1.5">
                <View className="w-14 items-center rounded-xl border border-light-primary-red/20 bg-light-primary-red/10 px-1.5 py-2.5">
                  <Text
                    className="text-[11px] font-bold text-light-matte-black"
                    numberOfLines={1}
                  >
                    {sym}
                  </Text>
                </View>
                <TextInput
                  value={amounts[key] ?? ""}
                  onChangeText={(t) =>
                    setAmounts((a) => ({ ...a, [key]: sanitizeAmount(t) }))
                  }
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                  placeholderTextColor="#9ca3af"
                  className="flex-1 rounded-xl border border-light-matte-black/10 bg-white px-3 py-2.5 text-sm text-light-matte-black"
                />
                <Text
                  className="w-[72px] text-right text-[11px] font-semibold text-light-primary-red"
                  numberOfLines={1}
                >
                  {label}
                </Text>
              </View>
            );
          })}
          <TouchableOpacity
            onPress={submitDeposit}
            disabled={!canSubmit}
            activeOpacity={0.85}
            className={`mt-2.5 flex-row items-center justify-center gap-2 rounded-full px-4 py-2.5 ${
              canSubmit ? "bg-light-primary-red" : "bg-light-matte-black/15"
            }`}
          >
            <Text
              className={`text-sm font-bold ${
                canSubmit ? "text-white" : "text-light-matte-black/40"
              }`}
            >
              {canDeposit
                ? `Deposit ${depositable.length} selected`
                : "Enter an amount to deposit"}
            </Text>
            {canSubmit ? (
              <ArrowRight size={16} color="#ffffff" strokeWidth={2.5} />
            ) : null}
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {strategy && onUserPrompt ? (
            <TouchableOpacity
              onPress={() =>
                onUserPrompt(
                  "Pick the best opportunity for me from the ones you just listed and propose a deposit.",
                )
              }
              activeOpacity={0.85}
              className="mt-3 flex-row items-center justify-center gap-2 rounded-xl border border-dashed border-light-primary-red/40 bg-light-primary-red/5 px-3 py-2.5"
            >
              <Sparkles size={14} color={BRAND_RED} />
              <Text className="text-xs font-semibold text-light-primary-red">
                Not sure? Let Takumi pick for you
              </Text>
            </TouchableOpacity>
          ) : null}
          {showSetupCTA ? <SetupStrategyCTA /> : null}
        </>
      )}
    </View>
  );
};

export default OpportunityListCard;
