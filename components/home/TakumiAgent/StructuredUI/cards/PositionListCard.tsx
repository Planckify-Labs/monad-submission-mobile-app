/**
 * PositionListCard — renders `defi_list_positions` results.
 *
 * Reads the structured payload from the mobile executor
 * (`services/agent-executors/defi/reads.ts`). Per CLAUDE.md
 * user-facing-error rule, raw `output.error` codes stay in dev logs.
 */

import { router } from "expo-router";
import { AlertTriangle, Briefcase, LogIn, Sparkles } from "lucide-react-native";
import type React from "react";
import { Text, TouchableOpacity, View } from "react-native";
import SingleLoadingSekeleton from "@/components/common/SingleLoadingSekeleton";
import { getChainFamilyLabel } from "@/services/walletKit/chainInfo";
import type { ToolComponentProps } from "../types";
import SetupStrategyCTA from "./SetupStrategyCTA";

const BRAND_RED = "#c71c4b";

type PositionRow = {
  id?: string;
  protocol_slug?: string;
  chain_id?: number;
  namespace?: string;
  asset_symbol?: string;
  amount_at_deposit?: string;
  amount_at_deposit_usd?: string | number;
  current_amount_raw?: string | null;
  current_amount_usd?: string | number | null;
  /** Live APY off the position's opportunity row (null once the pool ages
   *  out of the cache) — joined server-side, never persisted. */
  current_apy?: number | null;
  pnl_usd?: number | null;
  pnl_pct?: number | null;
  status?: string;
  open_tx_hash?: string | null;
  opened_at?: string;
  goal?: string | null;
  target_date?: string | null;
};

type PositionInput = Record<string, unknown>;

type PositionOutput = {
  status?: "success" | "failed" | string;
  error?: string;
  data?: {
    positions?: PositionRow[];
    count?: number;
  };
};

function decimalsForSymbol(symbol: string): number {
  switch (symbol.toUpperCase()) {
    case "USDC":
    case "USDT":
    case "USDC.E":
      return 6;
    case "WBTC":
      return 8;
    case "SOL":
    case "JITOSOL":
    case "SUI":
      return 9;
    default:
      return 18;
  }
}

function formatTokenAmount(
  raw: string | null | undefined,
  symbol: string,
): string {
  if (!raw) return `— ${symbol}`;
  const decimals = decimalsForSymbol(symbol);
  let n: number;
  try {
    n = Number(raw) / 10 ** decimals;
  } catch {
    return `— ${symbol}`;
  }
  if (!Number.isFinite(n)) return `— ${symbol}`;
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symbol}`;
}

function chainLabel(chainId?: number, namespace?: string): string | null {
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

function daysUntil(target?: string | null): string | null {
  if (!target) return null;
  const t = new Date(target).getTime();
  if (!Number.isFinite(t)) return null;
  const diff = t - Date.now();
  const days = Math.round(diff / (1000 * 60 * 60 * 24));
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "today";
  return `${days}d left`;
}

function SkeletonRow() {
  return (
    <View className="py-3">
      <SingleLoadingSekeleton width={140} height={12} borderRadius={4} />
      <SingleLoadingSekeleton
        width={100}
        height={10}
        borderRadius={4}
        style={{ marginTop: 6 }}
      />
    </View>
  );
}

function formatUsd(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : null;
}

function PositionRowItem({ row }: { row: PositionRow }) {
  const chain = chainLabel(row.chain_id, row.namespace);
  const amount = formatTokenAmount(
    row.current_amount_raw ?? row.amount_at_deposit,
    row.asset_symbol ?? "",
  );
  const goalCountdown = daysUntil(row.target_date);
  const currentUsd = formatUsd(row.current_amount_usd);
  const pnlPct = Number(row.pnl_pct);
  const hasPnl =
    row.pnl_pct !== null &&
    row.pnl_pct !== undefined &&
    Number.isFinite(pnlPct);
  const apy = Number(row.current_apy);
  const hasApy =
    row.current_apy !== null &&
    row.current_apy !== undefined &&
    Number.isFinite(apy);

  return (
    <View className="py-3">
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 min-w-0">
          <Text
            className="text-sm font-semibold text-light-matte-black"
            numberOfLines={1}
          >
            {row.protocol_slug ?? "Position"}
          </Text>
          <View className="flex-row flex-wrap gap-1.5 mt-1">
            {row.asset_symbol ? (
              <Text className="text-[10px] font-bold uppercase tracking-wide text-gray-500">
                {row.asset_symbol}
              </Text>
            ) : null}
            {chain ? (
              <Text className="text-[10px] text-gray-500">· {chain}</Text>
            ) : null}
            {row.status ? (
              <Text className="text-[10px] text-gray-500">· {row.status}</Text>
            ) : null}
          </View>
          {hasApy ? (
            <Text className="text-[10px] font-semibold text-emerald-600 mt-1">
              Earning {apy.toFixed(2)}% APY
            </Text>
          ) : null}
        </View>
        <View className="items-end">
          <Text className="text-sm font-bold text-light-matte-black">
            {amount}
          </Text>
          {currentUsd ? (
            <Text className="text-xs text-light-matte-black/60 mt-0.5">
              {currentUsd}
            </Text>
          ) : null}
          {hasPnl ? (
            <Text
              className={`text-[10px] font-semibold mt-0.5 ${pnlPct >= 0 ? "text-emerald-600" : "text-rose-600"}`}
            >
              {pnlPct >= 0 ? "+" : ""}
              {pnlPct.toFixed(2)}%
            </Text>
          ) : null}
          {goalCountdown ? (
            <Text className="text-[10px] text-amber-700 mt-1">
              {goalCountdown}
            </Text>
          ) : null}
        </View>
      </View>
      {row.goal ? (
        <View className="flex-row items-center gap-1.5 mt-2">
          <Sparkles size={12} color={BRAND_RED} />
          <Text
            className="text-[11px] text-light-matte-black/70"
            numberOfLines={1}
          >
            {row.goal}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const PositionListCard: React.FC<
  ToolComponentProps<PositionInput, PositionOutput>
> = ({ state, output, showSetupCTA = true }) => {
  if (state === "input-streaming" || state === "input-available" || !output) {
    return (
      <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-3">
        <View className="flex-row items-center gap-2 mb-1">
          <Briefcase size={14} color={BRAND_RED} />
          <Text className="text-xs font-bold uppercase tracking-wide text-light-matte-black">
            Your positions
          </Text>
          <View className="ml-auto">
            <SingleLoadingSekeleton width={40} height={10} borderRadius={4} />
          </View>
        </View>
        <View className="divide-y divide-gray-100">
          <SkeletonRow />
          <SkeletonRow />
        </View>
      </View>
    );
  }

  if (state === "output-error" || output.status === "failed") {
    if (__DEV__ && output.error) {
      console.warn("[PositionListCard] tool result failed:", output.error);
    }
    if (output.error === "authentication_required") {
      return (
        <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-4">
          <View className="flex-row items-center gap-2 mb-2">
            <View className="w-8 h-8 rounded-full bg-light-primary-red/10 items-center justify-center">
              <LogIn size={16} color={BRAND_RED} />
            </View>
            <Text className="text-sm font-semibold text-light-matte-black">
              Sign in to view your positions
            </Text>
          </View>
          <Text className="text-sm text-light-matte-black/70 mb-3">
            Sign in to track your DeFi positions, returns, and goals across
            chains.
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
            Couldn&apos;t load positions
          </Text>
        </View>
        <Text className="text-sm text-light-matte-black/80 mt-1.5">
          We couldn&apos;t load your DeFi positions right now. Please try again
          in a moment.
        </Text>
      </View>
    );
  }

  const rows = output.data?.positions ?? [];

  if (rows.length === 0) {
    return (
      <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-3">
        <View className="flex-row items-center gap-2">
          <Briefcase size={14} color={BRAND_RED} />
          <Text className="text-xs font-bold uppercase tracking-wide text-light-matte-black">
            Your positions
          </Text>
        </View>
        <Text className="text-sm text-light-matte-black/80 mt-1.5">
          You don&apos;t have any open DeFi positions yet.
        </Text>
        {showSetupCTA ? <SetupStrategyCTA variant="block" /> : null}
      </View>
    );
  }

  return (
    <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-3">
      <View className="flex-row items-center gap-2 mb-1">
        <Briefcase size={14} color={BRAND_RED} />
        <Text className="text-xs font-bold uppercase tracking-wide text-light-matte-black">
          Your positions
        </Text>
        <Text className="ml-auto text-[10px] text-gray-500">
          {rows.length} active
        </Text>
      </View>
      <View className="divide-y divide-gray-100">
        {rows.map((row, idx) => (
          <PositionRowItem
            key={row.id ?? `${row.protocol_slug}-${idx}`}
            row={row}
          />
        ))}
      </View>
    </View>
  );
};

export default PositionListCard;
