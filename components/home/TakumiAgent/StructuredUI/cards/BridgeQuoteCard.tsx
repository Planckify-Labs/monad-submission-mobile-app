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

import { router } from "expo-router";
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
import { useCallback, useMemo, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { bridgeApi } from "@/api/endpoints/bridge";
import type {
  TBridgeBlocker,
  TBridgeFee,
  TBridgeProviderInfo,
  TBridgeRouteStep,
  TBridgeToken,
} from "@/api/types/bridge";
import SingleLoadingSekeleton from "@/components/common/SingleLoadingSekeleton";
import WalletSwitcherModal from "@/components/wallet/WalletSwitcherModal";
import type { TWallet } from "@/constants/types/walletTypes";
import { useBlockchainsWithStorage } from "@/hooks/useBlockchainsWithStorage";
import { useWallet } from "@/hooks/useWallet";
import { buildChainConfigFromBlockchain } from "@/hooks/useWallet.helpers";
import { parseCaip2 } from "@/services/bridgeRoutes/caip";
import { bridgeDestinationChoice } from "@/services/bridgeRoutes/destinationChoice";
import { checkBridgeDestinationReadiness } from "@/services/bridgeRoutes/execute";
import { buildBridgeQuotePayload } from "@/services/bridgeRoutes/quotePayload";
import type { Namespace } from "@/services/chains/types";
import { addressesEqual } from "@/services/walletKit/chainInfo";
import { tapFeedback } from "@/utils/hapticsUtils";
import { agentErrorCopy } from "../agentErrorCopy";
import type { ToolComponentProps } from "../types";
import { AddWalletErrorAction } from "./AddWalletErrorAction";
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
import { ChainIcon } from "./ChainIcon";

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

/**
 * Which of the user's wallets is PAYING.
 *
 * The card named the destination but never the source, so with several
 * wallets on a chain there was no way to tell which one funds were
 * leaving. "Where is it going" and "what is it leaving" are both part of
 * §7.1, and only one of them was answered.
 *
 * Shows the wallet's NAME when the address matches one on the device —
 * "Main Wallet · ETH" is a fact the user can act on, whereas an `0x…`
 * string is one more thing to decode. Falls back to the bare address for
 * anything unrecognised, which is itself the useful signal.
 */
function SourceWallet({
  address,
  chain,
}: {
  address: string | undefined;
  chain: string | undefined;
}) {
  const { wallets } = useWallet();
  const namespace = chain ? parseCaip2(chain)?.namespace : undefined;
  if (!address) return null;

  const match = namespace
    ? wallets.find(
        (w) =>
          w.namespace === namespace &&
          addressesEqual(namespace, w.address, address),
      )
    : undefined;

  return (
    <View className="flex-row items-center gap-1 mt-0.5">
      <Wallet size={11} color={MUTED} />
      <Text className="text-[11px] text-gray-500">
        From {match?.name ? `${match.name} ` : ""}
        <Text className="text-gray-400">{truncateAddress(address)}</Text>
      </Text>
    </View>
  );
}

function AssetLine({
  side,
  caption,
  showSourceWallet,
}: {
  side: QuoteSide | undefined;
  caption: string;
  /** Only the paying side — the destination has its own "Arrives at" box. */
  showSourceWallet?: boolean;
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
      <View className="flex-row items-center gap-1 mt-0.5">
        <ChainIcon caip2={side?.chain} size={12} />
        <Text className="text-[11px] text-gray-500">
          {side?.chainName ?? chainLabel(side?.chain)}
        </Text>
        {token && !token.isNative ? (
          // USDC vs USDC.e on Arbitrum are DIFFERENT assets. Showing the
          // contract is what stops a silent mispick landing the user in
          // the wrong one (§7.1).
          //
          // The LABEL is not decoration. Unlabelled, a bare `0x…` in a
          // wallet app reads as an account, and a real user took this for
          // a stranger's wallet receiving their funds. The failure is
          // worse in the other direction too: teaching people to skim
          // past `0x…` strings here is teaching them to skim past the one
          // in "Arrives at", which IS a destination.
          <Text className="text-[10px] text-gray-400">
            Token {truncateAddress(token.address)}
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
      {showSourceWallet ? (
        <SourceWallet address={side?.address} chain={side?.chain} />
      ) : null}
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
 *
 * The "Change" affordance is the ONLY place on this card the user picks
 * their own destination wallet — it only appears here, on an already
 * resolved quote, never as a standalone prompt before one exists. It
 * opens the SAME `WalletSwitcherModal` the rest of the app uses to
 * change wallets, scoped to just the destination namespace, and never
 * calls `setActiveWallet`: picking a bridge destination must not change
 * the home screen's active wallet (`feedback_dapp_bridge_isolation`,
 * applied here even though this isn't the dApp bridge).
 *
 * Changing the destination MUST re-quote: fees, minimum received, and
 * whether a route exists at all can differ for a new `to_address`. The
 * card re-prices itself (see `useDestinationRequote`) rather than waiting
 * on the model, so picking a wallet updates the numbers immediately —
 * selection is handed up via `onSelectWallet` and the parent owns both
 * the re-quote and telling the agent.
 */
function DestinationAddress({
  address,
  chain,
  chainName,
  crossNamespace,
  onSelectWallet,
}: {
  address: string | undefined;
  chain: string | undefined;
  chainName: string | undefined;
  crossNamespace: boolean;
  /** Undefined in historical mode, which keeps a frozen card inert. */
  onSelectWallet?: (wallet: TWallet) => void;
}) {
  const { wallets } = useWallet();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const namespace = chain ? parseCaip2(chain)?.namespace : undefined;
  const switcherLabel = chainLabel(chain);
  const candidates = namespace
    ? wallets.filter((w) => w.namespace === namespace)
    : [];
  const label = chainName ?? switcherLabel;

  if (!address) return null;
  return (
    <>
      <View
        className={`mt-2.5 rounded-xl px-3 py-2 ${
          crossNamespace
            ? "bg-light-primary-red/5 border border-light-primary-red/20"
            : "bg-gray-50"
        }`}
      >
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-1.5">
            <ChainIcon caip2={chain} size={13} />
            <Wallet size={12} color={crossNamespace ? BRAND_RED : MUTED} />
            <SectionLabel>Arrives at</SectionLabel>
          </View>
          {onSelectWallet && candidates.length > 0 ? (
            <Pressable
              onPress={() => {
                tapFeedback();
                setSwitcherOpen(true);
              }}
              accessibilityRole="button"
              accessibilityLabel="Change destination wallet"
              hitSlop={8}
            >
              <Text className="text-[10px] font-bold text-light-primary-red">
                Change
              </Text>
            </Pressable>
          ) : null}
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
      <WalletSwitcherModal
        visible={switcherOpen}
        onClose={() => setSwitcherOpen(false)}
        wallets={candidates}
        activeWalletIndex={-1}
        onSelectWallet={(index) => {
          const wallet = candidates[index];
          if (!wallet) return;
          setSwitcherOpen(false);
          onSelectWallet?.(wallet);
        }}
        onAddWallet={() => {
          setSwitcherOpen(false);
          router.push("/login");
        }}
      />
    </>
  );
}

// ── §7.5 destination readiness ────────────────────────────────────────

/**
 * Gas top-up ("Add $X of gas") is PARKED pending infra work.
 *
 * The whole path is wired (this button -> a chat prompt -> the agent
 * rebuilding `bridge_execute` with `gas_top_up_usd` -> `POST
 * /bridge/gas-top-up` -> a LI.FI gas-zip leg -> a SECOND signed tx), but
 * it is unproven on our current stack:
 *
 *   - no test coverage anywhere, mobile or backend;
 *   - silent by design — `runGasTopUp` swallows every failure and lets
 *     the main bridge proceed, so a broken leg is indistinguishable from
 *     a working one and the user still lands with no gas;
 *   - it only works if the model faithfully reconstructs the entire
 *     `bridge_execute` call from chat history after the tap, which is
 *     exactly what fell over in the field (rejected transfer -> tap ->
 *     "interrupted before you approved it" -> dead conversation).
 *
 * Until that path is exercised end to end we withhold the ACTION and keep
 * only the warning message, which is useful on its own. Proceeding
 * without a top-up is already the non-blocking default (this blocker is
 * `severity: "warning"`), so nothing is stranded.
 *
 * To restore: flip `GAS_TOP_UP_ENABLED` to true here AND the mirror flag
 * in `services/agent-executors/defi/bridge.ts`.
 */
const GAS_TOP_UP_ENABLED = false;

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
      ? GAS_TOP_UP_ENABLED
        ? `Add $${blocker.remedy.suggestedUsd} of gas`
        : null
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

// ── local re-quote on destination change ──────────────────────────────

type RoutableQuote = Extract<BridgeQuoteData, { routable: true }>;

/**
 * Re-price the SAME route against a different destination wallet, from the
 * card, without a model round trip.
 *
 * Changing the destination genuinely changes the numbers (fees, minimum
 * received, and whether a route exists at all), so the old quote must not
 * stay on screen pretending otherwise. Going back through the agent to
 * re-quote costs an LLM turn and, worse, is not deterministic — a
 * follow-up phrased around a wallet and an address is exactly what got
 * mis-routed away from the bridge specialist before. `bridge_quote` is a
 * READ that signs nothing, so the card is allowed to call it directly.
 *
 * The agent is still told separately: it owns the eventual
 * `bridge_execute`, and its arguments come from conversation history, not
 * from this component. The `bridgeDestinationChoice` interlock is what
 * makes that safe rather than merely likely.
 *
 * Readiness is recomputed too. Blockers are per-DESTINATION (Solana ATA +
 * rent, Stellar trustline, EVM/Sui gas), so carrying the previous wallet's
 * blockers over would be worse than showing none: it would assert
 * something about an address we never checked.
 */
function useDestinationRequote(base: RoutableQuote | null) {
  const [localQuote, setLocalQuote] = useState<RoutableQuote | null>(null);
  const [isRequoting, setIsRequoting] = useState(false);
  const [noRouteReason, setNoRouteReason] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const { data: blockchains = [] } = useBlockchainsWithStorage({
    isActive: true,
  });

  const requote = useCallback(
    async (toAddress: string) => {
      // Everything the request needs comes off the quote already on
      // screen, so the re-quote can't drift from the route the user is
      // looking at (the tool INPUT may omit assets entirely).
      const fromChain = base?.from?.chain;
      const toChain = base?.to?.chain;
      const fromAsset = base?.from?.token?.caip19;
      const toAsset = base?.to?.token?.caip19;
      const amountRaw = base?.from?.amountRaw;
      const fromAddress = base?.from?.address;
      if (
        !fromChain ||
        !toChain ||
        !fromAsset ||
        !toAsset ||
        !amountRaw ||
        !fromAddress
      ) {
        return;
      }

      setIsRequoting(true);
      setFailed(false);
      setNoRouteReason(null);
      try {
        const result = await bridgeApi.getQuote({
          fromChain,
          toChain,
          fromAsset,
          toAsset,
          amountRaw,
          fromAddress,
          toAddress,
        });
        // Switching twice in quick succession leaves the FIRST re-quote in
        // flight. Whichever request resolves last would otherwise win the
        // card, so a slow reply for an abandoned wallet could paint over
        // the destination the user actually settled on. The pick is the
        // authority: if it has moved on, this reply is stale — drop it.
        if (bridgeDestinationChoice.get(toChain) !== toAddress) return;

        if (!result.routable) {
          // §7.6 capability boundary, not an error — the pair may simply
          // not route to this particular destination.
          setNoRouteReason(result.reason ?? null);
          setLocalQuote(null);
          return;
        }
        const blockers = await checkBridgeDestinationReadiness({
          toChain: result.quote.to.chain,
          toAsset: result.quote.to.token.caip19,
          address: result.quote.to.address,
          chains: blockchains.map(buildChainConfigFromBlockchain),
        }).catch(() => [] as TBridgeBlocker[]);
        // Readiness is another await, so re-check before committing.
        if (bridgeDestinationChoice.get(toChain) !== toAddress) return;
        // Bind the protection number to the pick. The figure now rendered
        // as "Minimum you receive" is what `bridge_execute` must enforce —
        // otherwise it would fall back to the model's argument, which
        // still carries the pre-switch quote's floor.
        bridgeDestinationChoice.setMinReceive(
          toChain,
          toAddress,
          result.quote.toAmountMinRaw,
        );
        setLocalQuote(buildBridgeQuotePayload(result.quote, blockers));
      } catch (err) {
        // Curated state only; nothing from the provider reaches the user
        // (CLAUDE.md user-facing errors).
        if (__DEV__) {
          console.warn("[BridgeQuoteCard] re-quote failed", err);
        }
        // A failure for an abandoned wallet is not the user's problem —
        // surfacing it would show an error for a destination they have
        // already moved off.
        if (bridgeDestinationChoice.get(toChain) === toAddress) {
          setFailed(true);
        }
      } finally {
        // Only the request that still owns the pick may take the skeleton
        // down. Clearing it from a superseded reply would reveal the stale
        // quote underneath while the current one is still in flight.
        if (bridgeDestinationChoice.get(toChain) === toAddress) {
          setIsRequoting(false);
        }
      }
    },
    [base, blockchains],
  );

  return {
    quote: localQuote ?? base,
    isRequoting,
    noRouteReason,
    failed,
    requote,
  };
}

/** Mirrors the resolved card's shape so the swap doesn't jump the layout. */
function QuoteSkeleton() {
  return (
    <Shell>
      <SectionLabel>Re-pricing for your new wallet</SectionLabel>
      <View className="mt-2 gap-1.5">
        <SingleLoadingSekeleton width="38%" height={22} borderRadius={6} />
        <SingleLoadingSekeleton width="26%" height={12} borderRadius={4} />
      </View>
      <View className="items-center py-1.5">
        <ArrowDown size={16} color={MUTED} />
      </View>
      <View className="gap-1.5">
        <SingleLoadingSekeleton width="44%" height={22} borderRadius={6} />
        <SingleLoadingSekeleton width="30%" height={12} borderRadius={4} />
      </View>
      <View className="mt-2.5 rounded-xl bg-gray-50 px-3 py-2 gap-2">
        <SingleLoadingSekeleton width="100%" height={12} borderRadius={4} />
        <SingleLoadingSekeleton width="70%" height={12} borderRadius={4} />
      </View>
      <View className="mt-2.5">
        <SingleLoadingSekeleton width="55%" height={12} borderRadius={4} />
      </View>
    </Shell>
  );
}

// ── main card ─────────────────────────────────────────────────────────

const BridgeQuoteCard: React.FC<
  ToolComponentProps<BridgeQuoteInput, BridgeQuoteOutput>
> = ({ state, input, output, mode, onUserPrompt }) => {
  const [expanded, setExpanded] = useState(false);

  const data = output?.data;
  const baseQuote = data && data.routable ? data : null;
  const {
    quote,
    isRequoting,
    noRouteReason: requoteNoRoute,
    failed: requoteFailed,
    requote,
  } = useDestinationRequote(baseQuote);

  const crossNamespace = useMemo(() => {
    const fromNs = quote?.from?.chain?.split(":")[0];
    const toNs = quote?.to?.chain?.split(":")[0];
    return Boolean(fromNs && toNs && fromNs !== toNs);
  }, [quote?.from?.chain, quote?.to?.chain]);

  /**
   * A destination change is handled ENTIRELY on device: record the pick,
   * then re-price locally.
   *
   * No message is sent to the agent, deliberately. It used to send one so
   * the model would re-issue `bridge_execute` with the new address — but
   * that made the model redo a quote the card had already produced, which
   * the user sees as the same work happening twice, plus an LLM turn of
   * latency. It is unnecessary because the recorded pick OUTRANKS the
   * model's argument in both places that matter: the executor resolves to
   * it, and the approval card renders it. The model's stale `to_address`
   * simply stops being load-bearing.
   */
  const handleSelectWallet = useCallback(
    (wallet: TWallet) => {
      const toChain = quote?.to?.chain;
      if (toChain) bridgeDestinationChoice.set(toChain, wallet.address);
      void requote(wallet.address);
    },
    [quote?.to?.chain, requote],
  );

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

  // Re-pricing for a newly picked destination wallet.
  if (isRequoting) return <QuoteSkeleton />;

  // The local re-quote could not reach the backend. Curated copy only,
  // and the previous quote is deliberately NOT left on screen — it is
  // priced for a wallet the user has moved on from.
  if (requoteFailed) {
    return (
      <Shell>
        <View className="flex-row items-center gap-2">
          <AlertTriangle size={15} color={BRAND_RED} />
          <Text className="text-xs font-bold uppercase tracking-wide text-light-primary-red">
            Could not re-price
          </Text>
        </View>
        <Text className="text-sm text-light-matte-black/80 mt-1.5">
          {agentErrorCopy("network_error")}
        </Text>
      </Shell>
    );
  }

  // Genuine failure. Curated copy only; the raw `error`/`reason` codes
  // never reach the user (CLAUDE.md user-facing errors).
  if ((state === "output-error" || output.status === "failed") && !quote) {
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
        {/* `no_wallet_on_destination_chain` names no chain, so hand the
            action the one the user asked to bridge to. */}
        <AddWalletErrorAction
          error={output.error}
          reason={output.reason}
          destinationNamespace={
            input?.to_chain
              ? (parseCaip2(input.to_chain)?.namespace as Namespace | undefined)
              : undefined
          }
        />
      </Shell>
    );
  }

  // §7.6 — a CAPABILITY BOUNDARY, not a failure. Plain explanatory state,
  // deliberately not an error card and not routed through agentErrorCopy.
  // `requoteNoRoute` is the same state reached by re-pricing: the route
  // exists for one destination wallet but not the one just picked.
  if (requoteNoRoute !== null || (data && !data.routable && !quote)) {
    const reason =
      requoteNoRoute ?? (data && !data.routable ? data.reason : undefined);
    return (
      <Shell>
        <View className="flex-row items-center gap-2">
          <Info size={15} color={MUTED} />
          <SectionLabel>Not available</SectionLabel>
        </View>
        <Text className="text-sm text-light-matte-black/80 mt-1.5">
          {noRouteCopy(reason)}
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
      <AssetLine side={quote.from} caption="You send" showSourceWallet />
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
        // Frozen history must stay inert — re-quoting an old card would
        // rewrite a settled turn.
        onSelectWallet={mode === "live" ? handleSelectWallet : undefined}
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
