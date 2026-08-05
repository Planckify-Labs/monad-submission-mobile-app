/**
 * BridgeQuoteCard — the §7 disclosure surface.
 *
 * Spec: docs/bridge-capability-spec.md §7.
 *
 * A bridge is the highest-disclosure operation in the wallet: it is
 * ASYNCHRONOUS, CROSS-ADDRESS, and IRREVERSIBLE MID-FLIGHT. This card
 * answers all five questions §7 requires:
 *
 *   §7.1 What am I moving?      amount + symbol + chain, token
 *                               disambiguated, native vs wrapped stated
 *   §7.2 What do I get?         expected AND minimum received, visible
 *                               slippage, ITEMISED fees marked
 *                               deducted-vs-on-top, effective rate
 *   §7.3 How long, who do I trust? duration, bridge name + logo,
 *                               mechanism, route steps, verification
 *   §7.4 Where is it landing?   the destination address, explicitly
 *   §7.5 Destination readiness  blockers with inline remedies
 *   §7.6 No route               a plain explanatory state, not an error
 *
 * Facts-first (§8.1): every number here comes from the QUOTE PAYLOAD.
 * The model's prose is never a substitute for a rendered `toAmountMin`.
 *
 * Design language follows `feedback_agent_tool_card_design`
 * (rounded-2xl, white / matte-black-10 borders, brand-red accents,
 * `tapFeedback`), matching OpportunityListCard. Copy carries no
 * em-dashes (`feedback_no_emdash_in_ui_copy`).
 */

import {
  AlertTriangle,
  ArrowDown,
  BadgeCheck,
  ChevronDown,
  ChevronUp,
  Clock,
  Info,
  ShieldQuestion,
  Wallet,
} from "lucide-react-native";
import type React from "react";
import { useMemo, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import type {
  TBridgeBlocker,
  TBridgeFee,
  TBridgeProviderInfo,
  TBridgeRouteStep,
  TBridgeToken,
} from "@/api/types/bridge";
import { tapFeedback } from "@/utils/hapticsUtils";
import { agentErrorCopy } from "../agentErrorCopy";
import type { ToolComponentProps } from "../types";
import {
  chainLabel,
  effectiveRatePercent,
  formatDuration,
  formatSlippage,
  formatTokenAmount,
  formatTokenValue,
  formatUsd,
  mechanismLabel,
  noRouteCopy,
  partitionFees,
  truncateAddress,
} from "./bridgeFormat";

const BRAND_RED = "#c71c4b";
const MUTED = "#6b7280";
const WARN_AMBER = "#b45309";

type BridgeQuoteInput = {
  from_chain?: string;
  to_chain?: string;
  amount_raw?: string;
};

type QuoteSide = {
  chain?: string;
  /** Backend-resolved display name, so the card never derives one. */
  chainName?: string;
  token?: TBridgeToken;
  address?: string;
  amountRaw?: string;
  amountUsd?: string;
};

type BridgeQuoteData =
  | { routable: false; reason?: string }
  | {
      routable: true;
      quote_id?: string;
      provider?: string;
      from?: QuoteSide;
      to?: QuoteSide;
      to_amount_min_raw?: string;
      slippage_bps?: number;
      fees?: TBridgeFee[];
      receives_native_asset?: boolean;
      duration_seconds?: number;
      duration_range_seconds?: [number, number];
      bridge?: TBridgeProviderInfo;
      steps?: TBridgeRouteStep[];
      blockers?: TBridgeBlocker[];
      issued_at?: string;
      expires_at?: string;
      source_tx_hash?: string;
    };

type BridgeQuoteOutput = {
  status?: "success" | "failed" | string;
  error?: string;
  reason?: string;
  data?: BridgeQuoteData;
};

// ── shells ────────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-4 py-3.5">
      {children}
    </View>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
      {children}
    </Text>
  );
}

function Row({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <View className="flex-row items-center justify-between py-1">
      <Text className="text-xs text-gray-500 flex-1 pr-3">{label}</Text>
      <Text
        className={
          emphasis
            ? "text-xs font-bold text-light-matte-black"
            : "text-xs font-semibold text-light-matte-black"
        }
      >
        {value}
      </Text>
    </View>
  );
}

// ── §7.1 what am I moving ─────────────────────────────────────────────

function AssetLine({
  side,
  caption,
}: {
  side: QuoteSide | undefined;
  caption: string;
}) {
  const token = side?.token;
  const usd = formatUsd(side?.amountUsd);
  return (
    <View>
      <SectionLabel>{caption}</SectionLabel>
      <View className="flex-row items-baseline gap-1.5 mt-0.5">
        <Text className="text-lg font-bold text-light-matte-black">
          {formatTokenAmount(side?.amountRaw, token?.decimals)}
        </Text>
        <Text className="text-sm font-semibold text-light-matte-black">
          {token?.symbol ?? ""}
        </Text>
        {usd ? <Text className="text-[11px] text-gray-400">{usd}</Text> : null}
      </View>
      <View className="flex-row items-center gap-1.5 mt-0.5">
        <Text className="text-[11px] text-gray-500">
          {side?.chainName ?? chainLabel(side?.chain)}
        </Text>
        {token && !token.isNative ? (
          // USDC vs USDC.e on Arbitrum are DIFFERENT assets. Showing the
          // contract is what stops a silent mispick landing the user in
          // the wrong one (§7.1).
          <Text className="text-[10px] text-gray-400">
            {truncateAddress(token.address)}
          </Text>
        ) : null}
        {token?.verification === "unverified" ? (
          <View className="flex-row items-center gap-0.5">
            <ShieldQuestion size={11} color={WARN_AMBER} />
            <Text className="text-[10px] font-semibold text-amber-700">
              Unverified
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

// ── §7.4 where is it landing ──────────────────────────────────────────

/**
 * For a same-namespace bridge the destination address usually matches the
 * source, so this reads as noise. For Base → Solana it is a COMPLETELY
 * DIFFERENT address derived from the same mnemonic, one the user has
 * never seen in this context. Hiding it is how funds go missing, so it is
 * always shown.
 */
function DestinationAddress({
  address,
  chain,
  chainName,
  crossNamespace,
}: {
  address: string | undefined;
  chain: string | undefined;
  chainName: string | undefined;
  crossNamespace: boolean;
}) {
  const label = chainName ?? chainLabel(chain);
  if (!address) return null;
  return (
    <View
      className={`mt-2.5 rounded-xl px-3 py-2 ${
        crossNamespace
          ? "bg-light-primary-red/5 border border-light-primary-red/20"
          : "bg-gray-50"
      }`}
    >
      <View className="flex-row items-center gap-1.5">
        <Wallet size={12} color={crossNamespace ? BRAND_RED : MUTED} />
        <SectionLabel>Arrives at</SectionLabel>
      </View>
      <Text className="text-xs font-semibold text-light-matte-black mt-0.5">
        {truncateAddress(address)}
      </Text>
      <Text className="text-[11px] text-gray-500 mt-0.5">
        {crossNamespace
          ? `Your ${label} address, which is different from the one you are sending from.`
          : `Your wallet on ${label}`}
      </Text>
    </View>
  );
}

// ── §7.5 destination readiness ────────────────────────────────────────

/**
 * Renders every namespace's blockers through ONE component. Adding a
 * namespace means implementing `checkBridgeDestinationReadiness` on its
 * wallet kit, not editing this card (§7.5).
 *
 * Both paths are offered inline for a warning: convenience AND safety,
 * not a dead-end warning. Neither option is preselected.
 */
function BlockerRow({
  blocker,
  onRemedy,
}: {
  blocker: TBridgeBlocker;
  onRemedy?: (blocker: TBridgeBlocker) => void;
}) {
  const blocking = blocker.severity === "blocking";
  const remedyLabel =
    blocker.remedy.kind === "gas_top_up"
      ? `Add $${blocker.remedy.suggestedUsd} of gas`
      : blocker.remedy.kind === "establish_trustline"
        ? "Set up this asset"
        : null;

  return (
    <View
      className={`mt-2 rounded-xl px-3 py-2.5 border ${
        blocking
          ? "border-light-primary-red/30 bg-light-primary-red/5"
          : "border-amber-300/50 bg-amber-50"
      }`}
    >
      <View className="flex-row items-center gap-1.5">
        <AlertTriangle size={13} color={blocking ? BRAND_RED : WARN_AMBER} />
        <Text
          className={`text-[11px] font-bold uppercase tracking-wide ${
            blocking ? "text-light-primary-red" : "text-amber-700"
          }`}
        >
          {blocking ? "Cannot continue" : "Heads up"}
        </Text>
      </View>
      <Text className="text-xs text-light-matte-black/80 mt-1">
        {blocker.message}
      </Text>
      {remedyLabel && onRemedy ? (
        <View className="flex-row gap-2 mt-2.5">
          <Pressable
            onPress={() => {
              tapFeedback();
              onRemedy(blocker);
            }}
            accessibilityRole="button"
            accessibilityLabel={remedyLabel}
            className="rounded-xl border-2 border-light-primary-red bg-light-primary-red/10 px-3 py-1.5 active:opacity-70"
          >
            <Text className="text-[11px] font-bold text-light-matte-black">
              {remedyLabel}
            </Text>
          </Pressable>
          {!blocking ? (
            <Pressable
              onPress={tapFeedback}
              accessibilityRole="button"
              accessibilityLabel="I will top up later"
              className="rounded-xl border border-light-matte-black/15 bg-white px-3 py-1.5 active:opacity-70"
            >
              <Text className="text-[11px] font-semibold text-light-matte-black">
                I will top up later
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// ── §7.2 / §7.3 detail ────────────────────────────────────────────────

function FeeBreakdown({ fees }: { fees: TBridgeFee[] | undefined }) {
  const { deducted, onTop } = partitionFees(fees);
  if (deducted.length === 0 && onTop.length === 0) return null;

  return (
    <View className="mt-2">
      {deducted.length > 0 ? (
        <>
          <SectionLabel>Taken from what you receive</SectionLabel>
          {deducted.map((fee) => (
            <Row
              key={`${fee.key}-${fee.label}-${fee.amountRaw}`}
              label={fee.label}
              value={
                formatUsd(fee.amountUsd) ??
                formatTokenValue(fee.amountRaw, fee.token)
              }
            />
          ))}
        </>
      ) : null}
      {onTop.length > 0 ? (
        <View className={deducted.length > 0 ? "mt-1.5" : undefined}>
          <SectionLabel>Paid on top</SectionLabel>
          {onTop.map((fee) => (
            <Row
              key={`${fee.key}-${fee.label}-${fee.amountRaw}`}
              label={fee.label}
              value={
                formatUsd(fee.amountUsd) ??
                formatTokenValue(fee.amountRaw, fee.token)
              }
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function RouteSteps({ steps }: { steps: TBridgeRouteStep[] | undefined }) {
  const meaningful = (steps ?? []).filter(
    (s) => s.kind === "swap" || s.kind === "burn",
  );
  if (meaningful.length <= 1) return null;
  return (
    <View className="mt-2">
      <SectionLabel>Route</SectionLabel>
      {meaningful.map((step, index) => (
        <Text key={step.key} className="text-[11px] text-gray-500 mt-0.5">
          {index + 1}. {step.label}
        </Text>
      ))}
    </View>
  );
}

// ── main card ─────────────────────────────────────────────────────────

const BridgeQuoteCard: React.FC<
  ToolComponentProps<BridgeQuoteInput, BridgeQuoteOutput>
> = ({ state, input, output, onUserPrompt }) => {
  const [expanded, setExpanded] = useState(false);

  const data = output?.data;
  const quote = data && data.routable ? data : null;

  const crossNamespace = useMemo(() => {
    const fromNs = quote?.from?.chain?.split(":")[0];
    const toNs = quote?.to?.chain?.split(":")[0];
    return Boolean(fromNs && toNs && fromNs !== toNs);
  }, [quote?.from?.chain, quote?.to?.chain]);

  // Loading.
  if (!output || state === "input-available" || state === "input-streaming") {
    return (
      <Shell>
        <SectionLabel>Checking routes</SectionLabel>
        <Text className="text-sm text-gray-500 mt-1">
          Finding the best way to move your funds.
        </Text>
      </Shell>
    );
  }

  // Genuine failure. Curated copy only; the raw `error`/`reason` codes
  // never reach the user (CLAUDE.md user-facing errors).
  if (state === "output-error" || output.status === "failed") {
    return (
      <Shell>
        <View className="flex-row items-center gap-2">
          <AlertTriangle size={15} color={BRAND_RED} />
          <Text className="text-xs font-bold uppercase tracking-wide text-light-primary-red">
            Could not quote
          </Text>
        </View>
        <Text className="text-sm text-light-matte-black/80 mt-1.5">
          {agentErrorCopy(output.error, output.reason)}
        </Text>
      </Shell>
    );
  }

  // §7.6 — a CAPABILITY BOUNDARY, not a failure. Plain explanatory state,
  // deliberately not an error card and not routed through agentErrorCopy.
  if (data && !data.routable) {
    return (
      <Shell>
        <View className="flex-row items-center gap-2">
          <Info size={15} color={MUTED} />
          <SectionLabel>Not available</SectionLabel>
        </View>
        <Text className="text-sm text-light-matte-black/80 mt-1.5">
          {noRouteCopy(data.reason)}
        </Text>
      </Shell>
    );
  }

  if (!quote) {
    return (
      <Shell>
        <SectionLabel>No quote</SectionLabel>
      </Shell>
    );
  }

  const destinationLabel = quote.to?.chainName ?? chainLabel(quote.to?.chain);
  const rate = effectiveRatePercent(quote.from?.amountUsd, quote.to?.amountUsd);
  const mechanism = mechanismLabel(quote.bridge?.mechanism);

  return (
    <Shell>
      {/* §7.1 what am I moving */}
      <AssetLine side={quote.from} caption="You send" />
      <View className="items-center py-1.5">
        <ArrowDown size={16} color={MUTED} />
      </View>
      <AssetLine side={quote.to} caption="You receive" />

      {/* §7.1 native vs wrapped, said plainly */}
      {quote.receives_native_asset ? (
        <View className="flex-row items-center gap-1 mt-1.5">
          <BadgeCheck size={12} color="#059669" />
          <Text className="text-[11px] font-semibold text-emerald-700">
            You receive native {quote.to?.token?.symbol ?? "tokens"}, not a
            wrapped version.
          </Text>
        </View>
      ) : null}

      {/* §7.2 the protection number, always on screen */}
      <View className="mt-2.5 rounded-xl bg-gray-50 px-3 py-2">
        <Row
          label="Minimum you receive"
          value={formatTokenValue(quote.to_amount_min_raw, quote.to?.token)}
          emphasis
        />
        <Row
          label="Slippage tolerance"
          value={formatSlippage(quote.slippage_bps)}
        />
        {rate !== null ? (
          <Row
            label="Value change"
            value={`${rate >= 0 ? "+" : ""}${rate.toFixed(2)}%`}
          />
        ) : null}
      </View>

      {/* §7.3 how long and who am I trusting */}
      <View className="flex-row items-center gap-2 mt-2.5">
        <Clock size={12} color={MUTED} />
        <Text className="text-[11px] text-gray-500">
          {formatDuration(quote.duration_seconds, quote.duration_range_seconds)}
        </Text>
        <Text className="text-[11px] text-gray-300">·</Text>
        {quote.bridge?.logoUri ? (
          <Image
            source={{ uri: quote.bridge.logoUri }}
            style={{ width: 14, height: 14, borderRadius: 7 }}
          />
        ) : null}
        <Text className="text-[11px] font-semibold text-light-matte-black">
          {quote.bridge?.name ?? "Bridge"}
        </Text>
      </View>
      {mechanism ? (
        <Text className="text-[10px] text-gray-400 mt-0.5">{mechanism}</Text>
      ) : null}

      {/* §7.4 where is it landing */}
      <DestinationAddress
        address={quote.to?.address}
        chain={quote.to?.chain}
        chainName={quote.to?.chainName}
        crossNamespace={crossNamespace}
      />

      {/* §7.5 destination readiness */}
      {(quote.blockers ?? []).map((blocker) => (
        <BlockerRow
          key={`${blocker.code}-${blocker.message}`}
          blocker={blocker}
          onRemedy={
            onUserPrompt
              ? (b) =>
                  onUserPrompt(
                    b.remedy.kind === "establish_trustline"
                      ? `Set up ${quote.to?.token?.symbol ?? "this asset"} on my ${destinationLabel} wallet so I can receive it`
                      : `Add ${b.remedy.kind === "gas_top_up" ? `$${b.remedy.suggestedUsd}` : "some"} of gas on ${destinationLabel} as part of this transfer`,
                  )
              : undefined
          }
        />
      ))}

      {/* §7.2 itemised fees + §7.3 route, behind a disclosure */}
      <Pressable
        onPress={() => {
          tapFeedback();
          setExpanded((v) => !v);
        }}
        accessibilityRole="button"
        accessibilityLabel={expanded ? "Hide details" : "Show fee details"}
        className="flex-row items-center gap-1 mt-2.5 active:opacity-70"
      >
        <Text className="text-[11px] font-bold text-light-primary-red">
          {expanded ? "Hide details" : "Fees and route"}
        </Text>
        {expanded ? (
          <ChevronUp size={13} color={BRAND_RED} />
        ) : (
          <ChevronDown size={13} color={BRAND_RED} />
        )}
      </Pressable>

      {expanded ? (
        <View className="mt-1">
          <FeeBreakdown fees={quote.fees} />
          <RouteSteps steps={quote.steps} />
        </View>
      ) : null}
    </Shell>
  );
};

export default BridgeQuoteCard;
