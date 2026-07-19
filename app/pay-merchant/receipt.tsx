/**
 * `/pay-merchant/receipt` — dedicated receipt screen reached after the
 * user's `/nanopay` submit lands 200 OK and `intent.status` first flips
 * to `paid`. Distinct route (not an inline card on `/pay-merchant`) so
 * that push-notification deep-links (task 32 / §6.3) and share-receipt
 * links can land here directly without replaying the sign-submit
 * pipeline.
 *
 * Spec: `docs/umkm-usdc-payout-spec.md` §2 step 9 ("Push + receipt
 * screen"), §6.3 (FCM/APNs — push delivers a receipt deep-link),
 * milestone M3.
 *
 * Status flow on this screen:
 *   - `paid`     → receipt body + live strip "Paid to merchant via
 *                  Nanopayments. Finalizing payout…"  (subtle spinner).
 *   - `paid_out` → receipt body + green-check strip "Payout complete.
 *                  The merchant received Rp X,XXX."
 *   - `failed`   → receipt body + red strip "Payout failed. Funds held
 *                  — ops will re-attempt. Ref: <intentId>."
 *   - anything else (e.g. the screen was opened directly from a push
 *     before the poll cache warmed) → skeleton loading.
 *
 * Always-render rule (task 31 scope): the receipt content (fiat amount,
 * USDC amount, merchant name, timestamp, intent id) renders the moment
 * the intent is loaded — we do NOT block on `paid_out`. The strip at
 * top is the only thing that changes across status transitions.
 *
 * Three-role separation (memory `feedback_role_separation.md`): screen
 * *reads* the intent via the same polling query as `/pay-merchant` — it
 * never mutates, never submits, never signs. Source of truth is the
 * server; the live-status strip flips from `paid` → `paid_out` when
 * task 30's webhook flips the backend status and the next poll (or an
 * invalidation fired by task 32's push handler via
 * `usePaymentIntentInvalidator`) reads it.
 *
 * Chain-extension discipline (memory
 * `feedback_chain_extension_discipline.md`): receipt renders from the
 * `PaymentIntentResponse` shape, which is namespace-agnostic. A future
 * Solana payer (M6) renders the same screen — no namespace branches.
 *
 * Copy-audience rule (spec §1.1): this screen is payer-facing and
 * post-auth, so "Paid", "Rp", "merchant" are fine. Chain IDs, gas,
 * nonces, and tx hashes are restricted to the optional "Details"
 * section at the bottom — primary copy stays clean.
 *
 * Clipboard discipline (spec §9, `docs/clipboard-policy.md`): the
 * intent id is explicitly copyable for support; merchant tokens /
 * JWS fragments / authorization nonces are NOT copyable.
 */

import { useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Store,
} from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StatusBar,
  Text,
  ToastAndroid,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { formatUnits } from "viem";
import type { TBlockchain } from "@/api/types/blockchain";
import { transactionsQueryKeys } from "@/constants/queryKeys/transactionsQueryKeys";
import { useBlockchains } from "@/hooks/queries/useBlockchains";
import { useWallet } from "@/hooks/useWallet";
import type { PaymentIntentResponse } from "@/services/nanopay";
import { useIntentStatus } from "@/services/nanopay";
import { copyToClipboard } from "@/utils/helperUtils";

/** USDC is a 6-decimal ERC-20 (spec §6.2 — `nanopayUsdcAmountMicros` is micros). */
const USDC_DECIMALS = 6;

/** ── helpers ────────────────────────────────────────────────────────── */

const formatIdrMinor = (minor: number): string => {
  const s = Math.max(0, Math.floor(minor)).toString();
  const groups: string[] = [];
  for (let i = s.length; i > 0; i -= 3) {
    groups.unshift(s.slice(Math.max(0, i - 3), i));
  }
  return `Rp ${groups.join(".")}`;
};

const formatUsdcMicros = (micros: string): string => {
  try {
    const whole = formatUnits(BigInt(micros), USDC_DECIMALS);
    const n = Number.parseFloat(whole);
    if (!Number.isFinite(n)) return `${whole} USDC`;
    return `${n.toFixed(n < 1 ? 4 : 2)} USDC`;
  } catch {
    return `${micros} µUSDC`;
  }
};

/**
 * Locale-formatted timestamp for the receipt. We don't surface
 * `expiresAt` or any chain-side timestamp — just the intent's creation
 * moment via `createdAt` if present, else "now" (the screen only opens
 * once the user has paid, so this is a correct upper-bound for display).
 */
const formatReceiptTimestamp = (intent: PaymentIntentResponse): string => {
  const anyIntent = intent as unknown as {
    createdAt?: string | number;
    paidAt?: string | number;
  };
  const raw = anyIntent.paidAt ?? anyIntent.createdAt;
  const date = raw ? new Date(raw) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  // Indonesia-default; swap to `Intl.DateTimeFormat` when multi-country
  // lands per spec §12 Q3.
  return date.toLocaleString("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

/**
 * Merchant display name — duck-checks the same shape as the M2 quote
 * card so the receipt lights up whenever the backend starts populating
 * a merchant field (task 27 follow-up). Falls back to "Merchant".
 */
const extractMerchantName = (
  intent: PaymentIntentResponse,
  fallback?: string,
): string => {
  const anyIntent = intent as unknown as {
    merchant?: { displayName?: string; name?: string };
    merchantName?: string;
  };
  return (
    anyIntent.merchant?.displayName ??
    anyIntent.merchant?.name ??
    anyIntent.merchantName ??
    fallback ??
    "Merchant"
  );
};

/**
 * Resolves a network's display name purely from the `/blockchains` API
 * response (`useBlockchains`) — never a hardcoded local table. A prior
 * version of this file kept a `chainId → name` map by hand; it went stale
 * the moment a new chain shipped (SVM's `-101`/`-102` sentinels were
 * added, then Stellar's `-201`/`-202` sentinels were forgotten, and
 * receipts silently rendered `Chain -202`). Matching against the live
 * list means a newly-seeded `Blockchain` row is correct here with zero
 * mobile changes.
 *
 * Match priority: `blockchainId` (the DB row's own ULID, set on every
 * intent response regardless of rail) first, then the numeric EVM
 * `chainId` as a secondary match for older cached intents that predate
 * the `blockchainId` field. Returns `undefined` (never a fabricated
 * label) while the list is loading or genuinely has no match — callers
 * render the row conditionally, consistent with how `Treasury` above is
 * only shown when present.
 */
const resolveChainName = (
  intent: PaymentIntentResponse,
  blockchains: TBlockchain[] | undefined,
): string | undefined => {
  if (!blockchains) return undefined;
  return (
    blockchains.find((b) => b.id === intent.blockchainId)?.name ??
    blockchains.find((b) => b.chainId === intent.nanopayUsdcSourceChainId)?.name
  );
};

const extractFiatMinor = (intent: PaymentIntentResponse): number => {
  const anyIntent = intent as unknown as {
    fiat?: { amountMinor?: number };
    fiatAmountMinor?: number;
    amountMinor?: number;
  };
  return (
    anyIntent.fiat?.amountMinor ??
    anyIntent.fiatAmountMinor ??
    anyIntent.amountMinor ??
    0
  );
};

const showToast = (message: string) => {
  if (ToastAndroid && typeof ToastAndroid.show === "function") {
    ToastAndroid.show(message, ToastAndroid.SHORT);
    return;
  }
  // iOS — no toast primitive; swallow silently. Task 44 will ship a
  // proper cross-platform toast component.
  console.log(message);
};

/** ── screen ────────────────────────────────────────────────────────── */

export default function PayMerchantReceipt() {
  const params = useLocalSearchParams<{
    intentId?: string;
    merchantName?: string;
    walletAddress?: string;
  }>();
  const intentId =
    typeof params.intentId === "string" && params.intentId.length > 0
      ? params.intentId
      : undefined;
  const merchantName =
    typeof params.merchantName === "string" ? params.merchantName : undefined;

  // Lock the receipt query to a specific wallet's JWT for the lifetime
  // of this screen. The intent was created by *one* wallet on the
  // backend; reading it through the global `api` (whose JWT tracks
  // `active_wallet_index` at request time) means a wallet switch
  // mid-poll, or a stale token on the active wallet, silently breaks
  // the request and leaves the UI stuck on the loading skeleton.
  //
  // Source priority:
  //   1. Nav param from `/pay-merchant` (the in-flow handoff already
  //      knows the paying wallet).
  //   2. Active wallet at mount (push deep-link path — we don't get
  //      the wallet in the push payload, so the active wallet is the
  //      best available proxy). `useWallet` hydrates from storage
  //      asynchronously, so we capture the address the first frame it
  //      becomes non-empty and never re-bind after that.
  const { activeWallet } = useWallet();
  const paramWallet =
    typeof params.walletAddress === "string" && params.walletAddress.length > 0
      ? params.walletAddress
      : undefined;
  const [walletAddress, setWalletAddress] = useState<string | undefined>(
    paramWallet,
  );
  useEffect(() => {
    if (walletAddress) return;
    if (activeWallet?.address) setWalletAddress(activeWallet.address);
  }, [activeWallet?.address, walletAddress]);

  const intentQ = useIntentStatus(intentId, walletAddress);
  const intent = intentQ.data;
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!intent) return;
    if (intent.status === "paid" || intent.status === "paid_out") {
      queryClient.invalidateQueries({
        queryKey: transactionsQueryKeys.all,
        exact: false,
      });
    }
  }, [intent?.status, queryClient]);

  return (
    <>
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle="dark-content"
      />
      <SafeAreaView className="flex-1 bg-light-main-container">
        <View className="flex-row items-center px-4 py-3">
          <Pressable
            onPress={() => router.replace("/")}
            className="mr-3 p-2 -ml-2"
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Close receipt"
          >
            <ArrowLeft color="#20222c" size={24} />
          </Pressable>
          <Text className="text-light-matte-black text-lg font-bold">
            Receipt
          </Text>
        </View>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{ padding: 20, paddingBottom: 32 }}
          showsVerticalScrollIndicator={false}
        >
          {!intentId ? (
            <MissingIntentCard />
          ) : intent ? (
            <ReceiptBody intent={intent} merchantName={merchantName} />
          ) : intentQ.isError ? (
            <ReceiptErrorCard
              intentId={intentId}
              error={intentQ.error}
              onRetry={() => {
                intentQ.refetch();
              }}
            />
          ) : (
            <ReceiptSkeleton intentId={intentId} />
          )}
        </ScrollView>

        {intent ? <DoneBar /> : null}
      </SafeAreaView>
    </>
  );
}

/** ── live status strip ─────────────────────────────────────────────── */

function StatusStrip({ intent }: { intent: PaymentIntentResponse }) {
  const fiatLabel = formatIdrMinor(extractFiatMinor(intent));
  switch (intent.status) {
    case "paid":
      return (
        <View className="flex-row items-center bg-amber-50 rounded-xl px-4 py-3 mb-4">
          <ActivityIndicator size="small" color="#d97706" />
          <Text className="text-amber-800 text-sm ml-3 flex-1">
            Payment successful. Processing to merchant…
          </Text>
        </View>
      );
    case "paid_out":
      return (
        <View className="flex-row items-center bg-green-50 rounded-xl px-4 py-3 mb-4">
          <CheckCircle2 color="#16a34a" size={20} />
          <Text className="text-green-800 text-sm ml-3 flex-1">
            Payout complete. The merchant received {fiatLabel}.
          </Text>
        </View>
      );
    case "failed":
      return (
        <View className="flex-row items-start bg-red-50 rounded-xl px-4 py-3 mb-4">
          <AlertCircle color="#dc2626" size={20} />
          <Text className="text-red-800 text-sm ml-3 flex-1">
            Payout failed. Funds held — ops will re-attempt. Ref: {intent.id}
          </Text>
        </View>
      );
    default:
      // `pending | submitting | settling | expired` shouldn't normally
      // reach this screen — `/pay-merchant` only navigates here on
      // `paid`. If a push deep-link overshoots the backend state, fall
      // through to a neutral settling strip.
      return (
        <View className="flex-row items-center bg-light-main-container rounded-xl px-4 py-3 mb-4">
          <ActivityIndicator size="small" color="#c71c4b" />
          <Text className="text-light-matte-black/70 text-sm ml-3 flex-1">
            Checking payout status…
          </Text>
        </View>
      );
  }
}

/** ── receipt body ──────────────────────────────────────────────────── */

function ReceiptBody({
  intent,
  merchantName: merchantNameParam,
}: {
  intent: PaymentIntentResponse;
  merchantName?: string;
}) {
  const fiatLabel = formatIdrMinor(extractFiatMinor(intent));
  const usdcLabel = formatUsdcMicros(intent.nanopayUsdcAmountMicros);
  const merchantName = extractMerchantName(intent, merchantNameParam);
  const timestamp = useMemo(() => formatReceiptTimestamp(intent), [intent]);

  return (
    <View>
      <StatusStrip intent={intent} />

      <View className="bg-light rounded-3xl p-6 shadow-md-">
        <View className="items-center mb-5">
          <View className="w-14 h-14 bg-light-primary-red/10 rounded-full items-center justify-center mb-2">
            <Store color="#c71c4b" size={24} />
          </View>
          <Text className="text-light-matte-black font-bold text-2xl">
            {fiatLabel}
          </Text>
          <Text className="text-light-matte-black/60 text-sm mt-1">
            {usdcLabel} from your balance
          </Text>
        </View>

        <View className="h-px bg-light-matte-black/10 mb-4" />

        <ReceiptRow label="Merchant" value={merchantName} />
        <ReceiptRow label="Amount" value={fiatLabel} />
        <ReceiptRow label="Paid with" value={usdcLabel} />
        {timestamp ? <ReceiptRow label="Date" value={timestamp} /> : null}
        <ReceiptRowCopyable label="Reference" value={intent.id} />
      </View>

      <DetailsSection intent={intent} />
    </View>
  );
}

function ReceiptRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between py-2">
      <Text className="text-light-matte-black/60 text-sm">{label}</Text>
      <Text
        className="text-light-matte-black text-sm font-medium flex-1 text-right ml-4"
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

function ReceiptRowCopyable({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  const onCopy = async () => {
    const ok = await copyToClipboard(value, label);
    if (ok) showToast(`${label} copied`);
  };
  return (
    <View className="flex-row justify-between items-center py-2">
      <Text className="text-light-matte-black/60 text-sm">{label}</Text>
      <TouchableOpacity
        activeOpacity={0.6}
        onPress={onCopy}
        className="flex-row items-center ml-4 flex-1 justify-end"
        accessibilityRole="button"
        accessibilityLabel={`Copy ${label}`}
      >
        <Text
          className="text-light-matte-black font-mono text-xs mr-2"
          numberOfLines={1}
          selectable
        >
          {value}
        </Text>
        <Copy color="#20222c" size={14} />
      </TouchableOpacity>
    </View>
  );
}

/**
 * Collapsible "Details" section — keeps chain / contract / source-chain
 * fields off the primary receipt per the copy-audience rule, but still
 * available for support debugging when a user taps in. Never surfaces
 * the authorization nonce, signature, or any secret material.
 */
function DetailsSection({ intent }: { intent: PaymentIntentResponse }) {
  const [open, setOpen] = useState(false);
  const ChevronIcon = open ? ChevronUp : ChevronDown;
  // Resolved live from `/blockchains` (see `resolveChainName`) — never a
  // hardcoded map, so this stays correct automatically as new chains ship.
  const { data: blockchains } = useBlockchains();
  const chainName = resolveChainName(intent, blockchains);
  return (
    <View className="bg-light rounded-3xl p-4 mt-4 shadow-md-">
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => setOpen((v) => !v)}
        className="flex-row items-center justify-between"
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <Text className="text-light-matte-black font-semibold text-sm">
          Details
        </Text>
        <ChevronIcon color="#20222c" size={18} />
      </TouchableOpacity>
      {open ? (
        <View className="mt-3">
          <ReceiptRow label="Status" value={intent.status} />
          {chainName ? <ReceiptRow label="Network" value={chainName} /> : null}
          {intent.nanopayUsdcTreasuryAddress ? (
            <ReceiptRow
              label="Treasury"
              value={shortenHex(intent.nanopayUsdcTreasuryAddress)}
            />
          ) : null}
          <ReceiptRow
            label="Token amount"
            value={formatUsdcMicros(intent.nanopayUsdcAmountMicros)}
          />
        </View>
      ) : null}
    </View>
  );
}

const shortenHex = (hex: string): string => {
  if (!hex || hex.length <= 12) return hex;
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
};

/** ── skeletons / edge cards ────────────────────────────────────────── */

function ReceiptSkeleton({ intentId }: { intentId: string }) {
  return (
    <View className="bg-light rounded-3xl p-6 shadow-md-">
      <View className="flex-row items-center mb-4">
        <View className="w-11 h-11 bg-light-primary-red/10 rounded-full items-center justify-center mr-3">
          <Store color="#c71c4b" size={20} />
        </View>
        <Text className="text-light-matte-black font-semibold text-base">
          Loading receipt…
        </Text>
      </View>
      <View className="flex-row items-center">
        <ActivityIndicator size="small" color="#c71c4b" />
        <Text className="text-light-matte-black/60 text-sm ml-2">
          Fetching payment
        </Text>
      </View>
      {__DEV__ ? (
        <Text
          className="text-light-matte-black/30 font-mono text-xs mt-4"
          selectable
        >
          {intentId}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Shown when the intent fetch errors out — most often because the
 * authenticated wallet has no JWT for this session (e.g. token cleared
 * by a 401 elsewhere, or the user is on a wallet that hasn't completed
 * sign-in). Without this card the screen would loop forever on the
 * loading skeleton, which is what the "stuck on Fetching payment" bug
 * looked like.
 */
function ReceiptErrorCard({
  intentId,
  error,
  onRetry,
}: {
  intentId: string;
  error: unknown;
  onRetry: () => void;
}) {
  // Receipt fetches can fail with raw 4xx/5xx bodies, gateway HTML, or
  // viem RPC noise. None of that is safe to surface — show a friendly
  // line and keep the underlying error in __DEV__ logs only.
  if (__DEV__ && error) {
    console.warn("[receipt] load failed", error);
  }
  const detail = "We couldn't load this receipt right now.";
  return (
    <View className="bg-light rounded-3xl p-6 shadow-md-">
      <View className="flex-row items-center mb-3">
        <AlertCircle color="#dc2626" size={20} />
        <Text className="text-light-matte-black font-semibold text-base ml-2">
          Couldn&apos;t load receipt
        </Text>
      </View>
      <Text className="text-light-matte-black/70 text-sm mb-5">{detail}</Text>
      <TouchableOpacity
        activeOpacity={0.7}
        className="bg-light-primary-red py-4 px-5 rounded-xl items-center mb-3"
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel="Retry loading receipt"
      >
        <Text className="text-light font-semibold">Retry</Text>
      </TouchableOpacity>
      <TouchableOpacity
        activeOpacity={0.7}
        className="py-3 px-5 rounded-xl items-center"
        onPress={() => router.replace("/")}
        accessibilityRole="button"
        accessibilityLabel="Back to home"
      >
        <Text className="text-light-matte-black/70 font-medium">
          Back to home
        </Text>
      </TouchableOpacity>
      {__DEV__ ? (
        <Text
          className="text-light-matte-black/30 font-mono text-xs mt-4"
          selectable
        >
          {intentId}
        </Text>
      ) : null}
    </View>
  );
}

function MissingIntentCard() {
  return (
    <View className="bg-light rounded-3xl p-6 shadow-md-">
      <Text className="text-light-matte-black font-semibold text-base mb-2">
        Receipt unavailable
      </Text>
      <Text className="text-light-matte-black/60 text-sm mb-6">
        We couldn&apos;t find a receipt for this link. The payment reference may
        have expired.
      </Text>
      <TouchableOpacity
        activeOpacity={0.7}
        className="bg-light-primary-red py-4 px-5 rounded-xl items-center"
        onPress={() => router.replace("/")}
      >
        <Text className="text-light font-semibold">Back to home</Text>
      </TouchableOpacity>
    </View>
  );
}

function DoneBar() {
  return (
    <View className="px-5 pb-5 pt-2">
      <TouchableOpacity
        activeOpacity={0.7}
        className="bg-light-primary-red py-4 px-5 rounded-xl items-center"
        onPress={() => router.replace("/")}
        accessibilityRole="button"
        accessibilityLabel="Done"
      >
        <Text className="text-light font-semibold">Done</Text>
      </TouchableOpacity>
    </View>
  );
}
