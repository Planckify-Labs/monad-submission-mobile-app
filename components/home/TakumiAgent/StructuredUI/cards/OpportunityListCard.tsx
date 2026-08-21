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
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from "lucide-react-native";
import type React from "react";
import { useCallback, useMemo, useState } from "react";
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
import { useAddWalletPrompt } from "@/hooks/useAddWalletPrompt";
import { useWallet } from "@/hooks/useWallet";
import type { Namespace } from "@/services/chains/types";
import {
  type DisplayPool,
  groupOpportunities,
  type OpportunityGroup,
  prettyProtocol,
  type RawOpportunity,
} from "@/services/defi/opportunityDisplay";
// ⚠️ TEMPORARY DEBUG — delete with services/defi/__debugEvmCoverage.ts
import { logEvmCoverage } from "@/services/defi/__debugEvmCoverage";
import { protocolAppUrl } from "@/services/defi/protocolLinks";
import { getChainFamilyLabel } from "@/services/walletKit/chainInfo";
import { ownedNamespaces } from "@/services/walletPresence";
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
    /** Which chain scope produced these rows (see the read executor). */
    chain_scope?: string;
    /** Namespace of the wallet's active chain at call time. */
    active_namespace?: string;
    /** Numeric id of the active chain, or null for non-EVM. */
    active_chain_id?: number | null;
    /** Display name of the active chain (e.g. "Base"), when resolvable. */
    active_chain_name?: string | null;
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

// Slug → display name now lives in `services/defi/opportunityDisplay.ts`
// (`prettyProtocol`): the approval surfaces have to show the user the same
// venue name this list showed them when they picked it.

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
// "Add wallet" is amber because it is neither a capability limit nor a dead
// end — it is the one state the user can clear themselves.
function ExecBadge({
  inApp,
  hasWallet,
}: {
  inApp: boolean;
  hasWallet: boolean;
}) {
  if (inApp && !hasWallet) {
    return (
      <View className="rounded-full bg-amber-50 px-1.5 py-0.5">
        <Text className="text-[9px] font-bold text-amber-700">Add wallet</Text>
      </View>
    );
  }
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

// Leading glyph for an in-app pool the user has no wallet for. Same shell
// as `ManualGlyph` so the row still scans as "not checkable", but amber
// rather than grey: this one is fixable, and tapping it starts the fix.
function NoWalletGlyph() {
  return (
    <View className="w-5 h-5 rounded-md border-2 border-amber-300 items-center justify-center bg-white">
      <Plus size={11} color="#b45309" strokeWidth={3} />
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
  hasWallet,
  onToggle,
  onManual,
  onNoWallet,
  onInspect,
}: {
  pool: DisplayPool;
  isTop: boolean;
  showTier: boolean;
  showProtocol: boolean;
  showBadge: boolean;
  selected: boolean;
  /** False only when we positively know the user holds no key here. */
  hasWallet: boolean;
  onToggle: () => void;
  onManual: () => void;
  onNoWallet: () => void;
  onInspect: () => void;
}) {
  const inApp = pool.inApp;
  // Checkable requires BOTH an in-app route and a wallet to sign with.
  // Without the second condition the row let the user build a deposit
  // that could only fail once it reached the executor.
  const checkable = inApp && hasWallet;
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
        if (!inApp) return onManual();
        return checkable ? onToggle() : onNoWallet();
      }}
      android_ripple={{ color: "rgba(0,0,0,0.04)" }}
      className={`flex-row items-center gap-3 active:opacity-70 px-3.5 py-3 mb-1.5 rounded-2xl border ${
        selected
          ? "border-light-primary-red bg-light-primary-red/10"
          : "border-light-matte-black/10 bg-white"
      }`}
    >
      {!inApp ? (
        <ManualGlyph />
      ) : checkable ? (
        <Checkbox checked={selected} />
      ) : (
        <NoWalletGlyph />
      )}
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
          {/* The missing-wallet state is always worth badging: unlike
              "Manual" it isn't implied by anything else in the row. */}
          {showBadge || (inApp && !hasWallet) ? (
            <ExecBadge inApp={inApp} hasWallet={hasWallet} />
          ) : null}
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
          {inApp && !hasWallet ? (
            <Text className="text-[11px] text-amber-700 font-medium">
              {tvl || safety ? "· " : ""}
              {`Add a ${chain || "wallet"} wallet to deposit`}
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
  hasWalletFor,
  onTogglePool,
  onManualPool,
  onNoWalletPool,
  onInspect,
}: {
  group: OpportunityGroup;
  isTop: boolean;
  showTier: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  isSelected: (rowKey: string) => boolean;
  hasWalletFor: (pool: DisplayPool) => boolean;
  onTogglePool: (rowKey: string) => void;
  onManualPool: (slug: string, appUrl?: string | null) => void;
  onNoWalletPool: (pool: DisplayPool) => void;
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
        hasWallet={hasWalletFor(pool)}
        onToggle={() => onTogglePool(pool.rowKey)}
        onManual={() => onManualPool(pool.protocol_slug, pool.app_url)}
        onNoWallet={() => onNoWalletPool(pool)}
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
              hasWallet={hasWalletFor(pool)}
              onToggle={() => onTogglePool(pool.rowKey)}
              onManual={() => onManualPool(pool.protocol_slug, pool.app_url)}
              onNoWallet={() => onNoWalletPool(pool)}
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
  const { wallets } = useWallet();
  const { promptFor, sheet: addWalletSheet } = useAddWalletPrompt();
  const [page, setPage] = useState(0);

  const owned = useMemo(
    () => new Set<Namespace>(ownedNamespaces(wallets)),
    [wallets],
  );

  /**
   * Whether the user could actually sign a deposit into this pool.
   *
   * Fails OPEN twice over. `namespace` is optional on the server payload,
   * and an empty `owned` set is indistinguishable from wallets not having
   * hydrated out of SecureStore yet — neither is evidence the user lacks
   * a wallet, and treating them as such would flash "Add wallet" across
   * every row on mount. A wrongly-enabled row still fails safely at the
   * executor; a wrongly-disabled one is invisible and unexplainable.
   */
  const hasWalletFor = useCallback(
    (pool: DisplayPool) => {
      const ns = pool.namespace as Namespace | undefined;
      if (!ns || owned.size === 0) return true;
      return owned.has(ns);
    },
    [owned],
  );

  const promptAddWalletForPool = useCallback(
    (pool: DisplayPool) => {
      const ns = pool.namespace as Namespace | undefined;
      if (!ns) return;
      tapFeedback();
      promptFor(ns);
    },
    [promptFor],
  );
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
    // ⚠️ TEMPORARY DEBUG — dumps EVM in-app vs Manual coverage to Metro.
    logEvmCoverage(all as RawOpportunity[]);
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

  // The list is scoped to the wallet's active chain unless the user asked
  // to leave it. When rows DO sit on other chains, say so plainly: they
  // need a chain switch or a bridge before any of them is one tap away.
  const activeNamespace = output?.data?.active_namespace;
  const activeChainId = output?.data?.active_chain_id ?? null;
  // Prefer the exact chain ("Base"); fall back to the family ("Sui") only
  // for chains with no numeric id.
  const activeChainLabel =
    output?.data?.active_chain_name ??
    (activeNamespace ? getChainFamilyLabel(activeNamespace) : null);
  const isActiveChainScope = output?.data?.chain_scope === "active_chain";
  // Off-chain means a different chain, not just a different family: on
  // Base, an Arbitrum pool needs a bridge exactly like a Sui one.
  const offActiveChain =
    !!activeNamespace &&
    allPools.length > 0 &&
    allPools.every(
      (p) =>
        (p.namespace && p.namespace !== activeNamespace) ||
        (activeChainId !== null &&
          p.chain_id !== undefined &&
          Number(p.chain_id) !== activeChainId),
    );
  const scopeNote =
    offActiveChain && activeChainLabel
      ? `Not on your active ${activeChainLabel} chain. You would need to switch chain or bridge first.`
      : null;

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
        {/* The list never leaves the active chain on its own, so an empty
            result usually means "nothing on THIS chain" rather than
            "nothing anywhere". Name the chain, then offer the widening as
            a tap instead of doing it silently. */}
        <Text className="text-sm text-light-matte-black/80 mt-1.5">
          {isActiveChainScope && activeChainLabel
            ? `No yield options on ${activeChainLabel} right now.`
            : "No matches for these filters right now."}
        </Text>
        {onUserPrompt ? (
          <TouchableOpacity
            onPress={() =>
              onUserPrompt(
                isActiveChainScope
                  ? "Show me yield options on every chain, not just my active one."
                  : "Show me yield options across all risk levels and chains, even smaller pools.",
              )
            }
            activeOpacity={0.85}
            className="mt-2.5 flex-row items-center justify-center gap-2 rounded-xl border border-light-primary-red/20 bg-light-primary-red/5 px-3 py-2.5"
          >
            <Search size={14} color={BRAND_RED} />
            <Text className="text-xs font-semibold text-light-primary-red">
              {isActiveChainScope
                ? "See options on other chains"
                : "See every yield option"}
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

      {scopeNote ? (
        <Text className="px-3.5 pb-2 text-[11px] text-gray-500">
          {scopeNote}
        </Text>
      ) : null}

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
            hasWalletFor={hasWalletFor}
            onTogglePool={toggleRow}
            onManualPool={openManual}
            onNoWalletPool={promptAddWalletForPool}
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

      {addWalletSheet}
    </View>
  );
};

export default OpportunityListCard;
