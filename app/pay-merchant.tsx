/**
 * `/pay-merchant` — Path B (Circle Nanopayments, EIP-3009) scan-to-pay
 * screen. Ships the M2 happy path: quote fetch → sign → submit → poll.
 *
 * Spec: `docs/umkm-usdc-payout-spec.md` §2 steps 6–7 (scan → sign → settle),
 * §5.5 (happy-path wiring), §6.2 (`PaymentIntent`), §8.5 #1 (intent-id-first
 * deep-link contract), milestone M2.
 *
 * Three-role separation (memory `feedback_role_separation.md`, §9 FX-
 * manipulation rule): the server creates the intent and pre-shapes every
 * EIP-712 field the wallet will sign (domain, nonce, value). The wallet
 * only signs. This screen renders + dispatches — it NEVER computes FX,
 * mints nonces, or forwards an unsigned intent to Circle directly. The
 * user approves the IDR amount; `nanopayUsdcAmountMicros` is a derived display.
 *
 * Chain-extension discipline (memory `feedback_chain_extension_discipline.md`):
 * the sign step dispatches via presence-of-method on `WalletKitAdapter.
 * signTransferWithAuthorization`. Solana's kit leaves that method
 * `undefined`; M6 task 42 adds the SVM equivalent. No
 * `if (namespace === "X")` here.
 *
 * Route params:
 *   - `intentId` (canonical) — existing server intent, we poll it.
 *   - `raw` + `kind` (M1 fallback) — scanner handed us the parsed QRIS
 *     bytes before the server mint endpoint shipped; we mint here and
 *     redirect to the canonical `?intentId=` URL.
 *
 * M2 residuals (noted inline):
 *   - Task 24 (settle proxy) backend — until it lands, the submit POST
 *     404s. We catch `NanopaySubmitError.status === 404` and show a
 *     dev-only banner so QA can tell "backend not ready" from "crash".
 *   - Task 27 (`GET /v1/merchants/:id`) — not yet available; we fall
 *     back to "Merchant" for display name.
 *   - Task 31 (receipt screen) — landed. On the first `paid` status
 *     transition, we `router.replace` to `/pay-merchant/receipt?intentId
 *     =<id>` so the receipt becomes the back-stack target. The inline
 *     `PaidCard` below is now a *transient* loader covering the frame
 *     window between the status flip and Expo Router's navigation
 *     commit — keeps the user from seeing a flash of the quote card.
 *   - Task 44 (`<PaymentError>` component) — landed. This screen
 *     imports the shared component + classifier + copy table from
 *     `services/errors/paymentErrors.ts` and
 *     `components/PaymentError.tsx`. No inline error strings remain.
 */

import { useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { HTTPError } from "ky";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  Search,
  Shield,
  Store,
  X,
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import { SafeAreaView } from "react-native-safe-area-context";
import { formatUnits } from "viem";
import type { TBlockchain } from "@/api/types/blockchain";
import { BaseModal, ModalHeader } from "@/components/common/BaseModal";
import OptimizedImage from "@/components/common/OptimizedImage";
import PinConfirmationModal from "@/components/common/PinConfirmationModal";
import { PaymentError } from "@/components/PaymentError";
import {
  PaymentProgressHero,
  type PayStep,
} from "@/components/pay-merchant/PaymentProgressHero";
import WalletSelectorModal from "@/components/wallet/WalletSelectorModal";
import {
  type ChainConfig,
  findEvmChainById,
} from "@/constants/configs/chainConfig";
import { api, optionalAuthApi } from "@/constants/configs/ky";
import {
  getAccessTokenForWallet,
  useNonce,
  useVerifySignature,
} from "@/hooks/queries/useAuth";
import { usePaymentContract } from "@/hooks/queries/usePaymentContract";
import {
  type PaymentToken,
  usePaymentTokens,
} from "@/hooks/queries/usePaymentTokens";
import { useBlockchainsWithStorage } from "@/hooks/useBlockchainsWithStorage";
import { useWallet } from "@/hooks/useWallet";
import {
  buildChainConfigFromBlockchain,
  resolveNamespace,
} from "@/hooks/useWallet.helpers";
import { track } from "@/services/analytics/posthog";
import {
  classifyPaymentError,
  type PaymentErrorCode,
  type PaymentErrorContext,
  resolvePaymentErrorCopy,
} from "@/services/errors/paymentErrors";
import {
  buildAuthorizationFromIntent,
  type PaymentIntentResponse,
  useCreateIntent,
  useIntentStatus,
  useSubmitNanopay,
  useSubmitOnchain,
} from "@/services/nanopay";
import {
  executePathA,
  type OnChainReceiptRequest,
  type OnChainReceiptResponse,
  onChainReceiptEndpoint,
  postOnChainReceipt,
  watchArcPayoutEvent,
} from "@/services/nanopay/pathADirectArc";
import {
  buildMerchantPaymentCall,
  executeOnchainSettlement,
  MERCHANT_PAYMENT_GAS_FALLBACK,
  type OnchainSubmitRequest,
  type OnchainSubmitResponse,
  onchainSubmitEndpoint,
  postOnchainSubmit,
  submitOnchainWithRetry,
} from "@/services/nanopay/pathOnchainSettlement";
import { executeOnchainSettlementStellar } from "@/services/nanopay/pathOnchainSettlementStellar";
import { executeOnchainSettlementSvm } from "@/services/nanopay/pathOnchainSettlementSvm";
import { preflightShortfall } from "@/services/nanopay/preflight";
import { settlementAmountLabel } from "@/services/nanopay/settlementAmount";
import {
  chainBadgeLabel,
  formatChainLabel,
  getChainFamilyLabel,
  getEvmChainId,
  getNonceParams,
  matchesBlockchainRow,
  preferredChainRail,
} from "@/services/walletKit/chainInfo";
import { ownedNamespaces } from "@/services/walletPresence";

/** Arc Testnet viem chainId — source chain for the Nanopay EIP-3009 sig. */
const ARC_TESTNET_CHAIN_ID = 5042002;

/** USDC is a 6-decimal ERC-20 (the `nanopayUsdcAmountMicros` field is in micros). */
const USDC_DECIMALS = 6;

const { height: SCREEN_HEIGHT } = Dimensions.get("window");
/** Bottom-sheet sizing — mirrors `components/common/ChainSelector.tsx`. */
const SHEET_MAX_HEIGHT = SCREEN_HEIGHT * 0.67;
const SHEET_SCROLL_MAX_HEIGHT = SHEET_MAX_HEIGHT - 200;

/** Merchant kinds we accept from the scanner fallback path. */
type MerchantKind = "qris" | "takumipay";

/**
 * Screen-local state machine. The intent's `status` field drives most of
 * the UI, but signing and the submit handshake happen client-side before
 * the server even knows — hence the extra local phases.
 */
/**
 * How long the paid state stays on screen before the receipt replaces it.
 * Long enough to register the check and "Paid to {merchant}", short enough
 * not to feel like waiting.
 */
const RECEIPT_HANDOFF_DELAY_MS = 700;

type LocalPhase =
  | "idle" // quote visible, waiting on user tap
  | "signing" // wallet is producing the EIP-712 signature
  | "submitting" // POST /v1/pay/intents/:id/nanopay in flight
  | "settled" // local bookkeeping; truth is `intent.status === "paid"`
  | "error";

/**
 * Screen-local error shape. The `code` comes from the shared
 * `classifyPaymentError` helper (task 44); `devMessage` is kept only
 * for `__DEV__` surfacing inside `<PaymentError>`.
 */
interface LocalError {
  code: PaymentErrorCode;
  devMessage?: string;
}

/** ── helpers (inline per task constraint) ───────────────────────────── */

const formatIdrMinor = (minor: number): string => {
  const s = Math.max(0, Math.floor(minor)).toString();
  const groups: string[] = [];
  for (let i = s.length; i > 0; i -= 3) {
    groups.unshift(s.slice(Math.max(0, i - 3), i));
  }
  return `Rp ${groups.join(".")}`;
};

/**
 * Formats 6-decimal USDC atomic units for the derived secondary display.
 * Trims trailing zeros past 2dp for readability — we never render more
 * than 4dp since `nanopayUsdcAmountMicros` from the backend is already at micro
 * precision and the user approved an IDR amount, not this number.
 */
const formatUsdcMicros = (micros: string): string => {
  try {
    const whole = formatUnits(BigInt(micros), USDC_DECIMALS);
    const n = parseFloat(whole);
    if (!Number.isFinite(n)) return `${whole} USDC`;
    return `${n.toFixed(n < 1 ? 4 : 2)} USDC`;
  } catch {
    return `${micros} µUSDC`;
  }
};

/**
 * Resolves an EVM `ChainConfig` by viem chain id, preferring the backend
 * `/blockchains` feed and falling back to the static `supportedChains` list.
 *
 * The feed is the source of truth for which chains exist — `ChainSelector`
 * and `useWallet` already build their configs from it. The static list is a
 * bundled subset (mainnet/polygon/arbitrum/…), so resolving against it alone
 * makes any backend-only chain unreachable: Arc Testnet (5042002) is served
 * and active, but absent from `supportedChains`, so `findEvmChainById`
 * returned undefined and this screen failed with `chain_mismatch` before it
 * ever reached the wallet. Falling back keeps chains that are only in the
 * bundle (or a feed that hasn't loaded yet) working exactly as before.
 */
const resolveEvmChainConfig = (
  chainId: number,
  blockchains: TBlockchain[] | undefined,
): ChainConfig | undefined => {
  const row = blockchains?.find((b) => b.chainId === chainId);
  if (row) return buildChainConfigFromBlockchain(row);
  return findEvmChainById(chainId);
};

const resolveKind = (
  kindParam: string | undefined,
  providerParam: string | undefined,
): MerchantKind | null => {
  if (kindParam === "qris" || kindParam === "takumipay") return kindParam;
  if (providerParam === "xendit_qris") return "qris";
  if (providerParam === "takumipay") return "takumipay";
  return null;
};

/**
 * Screen-local wrapper around the shared classifier. Retains the raw
 * `err.message` in `devMessage` for `__DEV__` surfacing only (the
 * shared `classifyPaymentError` intentionally drops it so sensitive
 * hex blobs never make it to telemetry / prod logs).
 */
const makeLocalError = (
  code: PaymentErrorCode,
  devMessage?: string,
): LocalError => {
  if (__DEV__) {
    console.error(`[pay-merchant] code=${code}`, devMessage ?? "");
  }
  return { code, devMessage };
};

const classifyError = (err: unknown): LocalError => {
  const code = classifyPaymentError(err);

  let devMessage: string | undefined;
  if (err && typeof err === "object") {
    const e = err as {
      name?: string;
      message?: string;
      status?: number;
      response?: { status?: number };
    };
    const parts: string[] = [];
    if (e.name) parts.push(`name=${e.name}`);
    if (e.message) parts.push(e.message);
    const httpStatus = e.status ?? e.response?.status;
    if (httpStatus) parts.push(`HTTP ${httpStatus}`);
    devMessage = parts.join(" | ") || undefined;
  } else if (typeof err === "string") {
    devMessage = err;
  }

  if (__DEV__) {
    console.error(`[pay-merchant] code=${code}`, err);
  }

  return { code, devMessage };
};

/** ── screen ────────────────────────────────────────────────────────── */

export default function PayMerchant() {
  const params = useLocalSearchParams<{
    intentId?: string;
    channel?: string;
    kind?: string;
    provider?: string;
    raw?: string;
    merchantName?: string;
    walletAddress?: string;
  }>();
  const intentId =
    typeof params.intentId === "string" ? params.intentId : undefined;
  const kindParam = typeof params.kind === "string" ? params.kind : undefined;
  const providerParam =
    typeof params.provider === "string" ? params.provider : undefined;
  const raw = typeof params.raw === "string" ? params.raw : undefined;
  const kind = resolveKind(kindParam, providerParam);
  const merchantName =
    typeof params.merchantName === "string" ? params.merchantName : undefined;
  const walletAddress =
    typeof params.walletAddress === "string" ? params.walletAddress : undefined;

  const hasIntentId = Boolean(intentId && intentId.length > 0);
  const hasFallback = !hasIntentId && Boolean(kind) && Boolean(raw);

  return (
    <>
      <SystemBars style="dark" />
      <SafeAreaView className="flex-1 bg-light-main-container">
        <View className="flex-row items-center px-4 py-3">
          <Pressable
            onPress={() => router.back()}
            className="mr-3 p-2 -ml-2"
            hitSlop={8}
          >
            <ArrowLeft color="#c71c4b" size={24} />
          </Pressable>
          <Text className="text-light-matte-black text-lg font-bold">
            Pay merchant
          </Text>
        </View>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{ padding: 20, paddingBottom: 32 }}
          showsVerticalScrollIndicator={false}
        >
          {hasIntentId ? (
            <IntentFlow
              intentId={intentId as string}
              merchantName={merchantName}
              walletAddress={walletAddress}
            />
          ) : hasFallback ? (
            <MintFallback
              kind={kind as MerchantKind}
              raw={raw as string}
              merchantName={merchantName}
            />
          ) : (
            <MissingIntentCard />
          )}
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

/** ── intent-id path: poll, sign, submit ────────────────────────────── */

function IntentFlow({
  intentId,
  merchantName: merchantNameParam,
  walletAddress,
}: {
  intentId: string;
  merchantName?: string;
  walletAddress?: string;
}) {
  const {
    activeWallet,
    activeChain,
    getActiveWalletKit,
    changeActiveChainToConfig,
  } = useWallet();
  const { data: allBlockchains } = useBlockchainsWithStorage({
    isActive: true,
  });
  const intentQ = useIntentStatus(intentId, walletAddress);
  const submit = useSubmitNanopay();

  const [phase, setPhase] = useState<LocalPhase>("idle");
  const [error, setError] = useState<LocalError | null>(null);
  // Guards against double-counting: `intent` gets a fresh object reference
  // on any refetch (e.g. useSubmitOnchain's invalidateQueries), even after
  // status has already settled to "paid"/"paid_out".
  const trackedSettledRef = useRef(false);

  const intent = intentQ.data;

  // Drive terminal phase from the server intent. Signing / submitting
  // flips first on our side, then the poll confirms.
  useEffect(() => {
    if (!intent) return;
    if (intent.status === "paid" || intent.status === "paid_out") {
      setPhase("settled");
      setError(null);
      if (!trackedSettledRef.current) {
        trackedSettledRef.current = true;
        track("merchant_payment_completed", {
          // Nanopay/x402/takumipay settlement is EVM/USDC-only today —
          // see intent.nanopayUsdcSourceChainId / contractAddress typing.
          chain: "evm",
          rail: intent.path,
          amount_minor:
            intent.tokenAmountMinor ?? intent.nanopayUsdcAmountMicros,
        });
      }
      return;
    }
    if (intent.status === "failed") {
      // On the on-chain rail this is a chain verdict (the tx reverted,
      // nothing moved); the settlement worker already pushed the same
      // message. Nanopay failures land here too and the copy still holds:
      // nothing was taken.
      setPhase("error");
      setError(makeLocalError("payment_not_completed", "intent.status=failed"));
      return;
    }
    if (intent.status === "expired") {
      setPhase("error");
      setError(makeLocalError("quote_expired"));
    }
  }, [intent]);

  // On the first `paid` transition, hand off to the dedicated receipt
  // screen (task 31). `router.replace` keeps the back stack clean: the
  // user's back button from the receipt returns to home/scanner, not
  // to this mid-flow screen.
  //
  // The hand-off waits `RECEIPT_HANDOFF_DELAY_MS` so the on-chain card's
  // final state — the green check and "Paid to {merchant}" — is actually
  // seen before the receipt takes over, instead of flashing for a frame.
  // The timer is cleared on cleanup, so leaving the screen first (the
  // "Done" button, back) or a status change never fires a stale
  // navigation, and nothing lingers after the hand-off.
  useEffect(() => {
    if (!intent) return;
    if (intent.status !== "paid" && intent.status !== "paid_out") return;
    const timer = setTimeout(() => {
      router.replace({
        // `/pay-merchant/receipt` isn't in the generated typed-routes
        // union yet — cast narrowly per the same pattern used for
        // `/pay-merchant` above.
        pathname: "/pay-merchant/receipt" as "/send",
        // Forward the wallet that *created* the intent so the receipt
        // query locks to that wallet's JWT via `createApiForWallet`.
        // Without this the receipt fell back to the global `api`
        // instance, whose JWT tracks `active_wallet_index` at request
        // time — switching wallets (or having a stale token on the
        // active wallet) would hang the poll on "Fetching payment".
        params: { intentId, merchantName: merchantNameParam, walletAddress },
      });
    }, RECEIPT_HANDOFF_DELAY_MS);
    return () => clearTimeout(timer);
  }, [intent?.status, intentId, merchantNameParam, walletAddress]);

  // Quote-expiry guard from client clock — the backend enforces the real
  // cut-off, but this catches the "user left the app open for 2 mins"
  // case before we waste a wallet prompt.
  const isClientExpired = useMemo(() => {
    if (!intent?.expiresAt) return false;
    return intent.expiresAt < Date.now();
  }, [intent?.expiresAt]);

  const onPay = useCallback(async () => {
    if (!intent) return;

    // Presence-of-method dispatch — kits without EIP-3009 (Solana) leave
    // this undefined. No `if (namespace === "X")` branches.
    const kit = activeWallet?.namespace ? getActiveWalletKit() : null;
    if (!kit || typeof kit.signTransferWithAuthorization !== "function") {
      setError(makeLocalError("wallet_unsupported"));
      setPhase("error");
      return;
    }

    // Pre-flight chain switch — the authorization is bound to
    // `intent.nanopay.sourceChainId`. If the active chain disagrees,
    // flip via the shared overlay so biometrics prompt against the
    // right network.
    const sourceChainId = intent.nanopay?.sourceChainId ?? ARC_TESTNET_CHAIN_ID;
    const sourceChainConfig = resolveEvmChainConfig(
      sourceChainId,
      allBlockchains,
    );
    if (!sourceChainConfig) {
      setError(
        makeLocalError(
          "chain_mismatch",
          `No chain config for id=${sourceChainId}`,
        ),
      );
      setPhase("error");
      return;
    }
    const activeEvmChainId = getEvmChainId(activeChain) ?? null;
    if (activeEvmChainId !== sourceChainId) {
      const ok = await changeActiveChainToConfig(sourceChainConfig);
      if (!ok) {
        setError(makeLocalError("chain_mismatch"));
        setPhase("error");
        return;
      }
    }

    try {
      setPhase("signing");
      setError(null);

      const signArgs = buildAuthorizationFromIntent(intent, {
        wallet: activeWallet,
        chain: sourceChainConfig,
      });
      const signature = await kit.signTransferWithAuthorization(signArgs);

      setPhase("submitting");
      await submit.mutateAsync({ intentId, signature });
      // Polling picks up the terminal status; we stay in "submitting"
      // until `intent.status` flips to `paid | failed`.
    } catch (err) {
      // Defensive: do NOT log `signArgs`, `signature`, or bigint message
      // fields. `classifyError` only reads `name` / `message` / `status`.
      setError(classifyError(err));
      setPhase("error");
    }
  }, [
    activeChain,
    activeWallet,
    allBlockchains,
    changeActiveChainToConfig,
    getActiveWalletKit,
    intent,
    intentId,
    submit,
  ]);

  // Loading the quote itself.
  if (intentQ.isLoading || !intent) {
    return <LoadingCard intentId={intentId} />;
  }

  // Terminal success — `useEffect` above navigates to `/pay-merchant/
  // receipt` after a short beat. The on-chain rail renders its own
  // "Paid to {merchant}" state for that beat (the progress hero's last
  // row and green check); the other rails show the minimal PaidCard.
  const isPaid = intent.status === "paid" || intent.status === "paid_out";
  if ((phase === "settled" || isPaid) && intent.path !== "takumipay") {
    return <PaidCard />;
  }

  if (isClientExpired && phase === "idle") {
    return (
      <PaymentError
        code="quote_expired"
        intentId={intentId}
        onRescan={() => router.back()}
        onBack={() => router.back()}
        onRetry={() => router.back()}
      />
    );
  }

  if (phase === "error" && error) {
    // Quote-expired takes the user back to the scanner; everything
    // else lets them re-tap the Pay button from an `idle` state.
    const resetToIdle = () => {
      setError(null);
      setPhase("idle");
    };
    const rescan = () => router.back();
    return (
      <PaymentError
        code={error.code}
        devMessage={
          error.code === "backend_not_ready"
            ? "Settle backend not ready (M3)"
            : error.devMessage
        }
        intentId={intentId}
        context={{ tokenSymbol: "USDC" }}
        onRetry={resetToIdle}
        onBack={rescan}
        onRescan={rescan}
        onTopUp={resetToIdle}
      />
    );
  }

  // Path A (direct-on-Arc, task 40) — backend flips `intent.path = "A"`
  // when the user either has no Gateway deposit yet or the quote is
  // large enough that Nanopayments' batched settle is undesirable. The
  // branch lives on the server-set flag so there's no client-side
  // selector logic duplicated here.
  if (extractIntentPath(intent) === "A") {
    return (
      <PathACard
        intent={intent}
        intentId={intentId}
        merchantName={merchantNameParam}
        onBack={() => router.back()}
      />
    );
  }

  if (extractIntentPath(intent) === "takumipay") {
    return (
      <OnchainCard
        intent={intent}
        intentId={intentId}
        merchantName={merchantNameParam}
        walletAddress={walletAddress}
        onBack={() => router.back()}
      />
    );
  }

  // No explicit path from backend — dispatch by wallet capability.
  // Wallets without EIP-3009 (e.g. Solana kits) route to onchain
  // settlement rather than erroring with "wallet_unsupported".
  const kit = activeWallet?.namespace ? getActiveWalletKit() : null;
  if (!kit || typeof kit.signTransferWithAuthorization !== "function") {
    return (
      <OnchainCard
        intent={intent}
        intentId={intentId}
        merchantName={merchantNameParam}
        walletAddress={walletAddress}
        onBack={() => router.back()}
      />
    );
  }

  return (
    <QuoteCard
      intent={intent}
      phase={phase}
      merchantName={merchantNameParam}
      onPay={onPay}
    />
  );
}

/** ── Path A — direct-on-Arc (spec §5.1, milestone M5) ──────────────── */

/**
 * Single-card Path A flow. Separate from `QuoteCard` because the
 * confirmation narrative is different: no "submitting to Circle,"
 * no batched attestation — the chain itself IS the receipt.
 *
 * Mirrors `IntentFlow`'s pre-flight chain switch so biometrics prompt
 * against Arc even if the user was last on a non-Arc chain. Fires the
 * on-chain receipt POST + viem-side receipt poll in parallel once the
 * wallet broadcasts, then flips to `"settled"` once both settle. The
 * backend watcher reconciles via `Transfer` events so the polling
 * query upstream in `IntentFlow` lands on `"paid"` independently of
 * this card's local state.
 */
function PathACard({
  intent,
  intentId,
  merchantName: merchantNameParam,
  onBack,
}: {
  intent: PaymentIntentResponse;
  intentId: string;
  merchantName?: string;
  onBack: () => void;
}) {
  const {
    activeWallet,
    activeChain,
    getActiveWalletKit,
    changeActiveChainToConfig,
  } = useWallet();
  const { data: allBlockchains } = useBlockchainsWithStorage({
    isActive: true,
  });

  const [phase, setPhase] = useState<LocalPhase>("idle");
  const [error, setError] = useState<LocalError | null>(null);

  const onSend = useCallback(async () => {
    if (!activeWallet?.namespace) {
      setError(makeLocalError("wallet_unsupported"));
      setPhase("error");
      return;
    }
    const kit = getActiveWalletKit();

    // Chain flip — Path A is Arc-only (enforced inside `executePathA`
    // via `nativeCurrency.symbol === "USDC"`). Re-use the pre-flight
    // switch so biometrics prompt on the right network.
    const sourceChainId =
      intent.nanopayUsdcSourceChainId ?? ARC_TESTNET_CHAIN_ID;
    const sourceChainConfig = resolveEvmChainConfig(
      sourceChainId,
      allBlockchains,
    );
    if (!sourceChainConfig) {
      setError(
        makeLocalError(
          "chain_mismatch",
          `No chain config for id=${sourceChainId}`,
        ),
      );
      setPhase("error");
      return;
    }
    const activeEvmChainId = getEvmChainId(activeChain) ?? null;
    if (activeEvmChainId !== sourceChainId) {
      const ok = await changeActiveChainToConfig(sourceChainConfig);
      if (!ok) {
        setError(makeLocalError("chain_mismatch"));
        setPhase("error");
        return;
      }
    }

    try {
      setPhase("signing");
      setError(null);

      const usdcAmount = BigInt(intent.nanopayUsdcAmountMicros);
      const result = await executePathA({
        payer: activeWallet.address as `0x${string}`,
        merchantAddress: intent.nanopayUsdcTreasuryAddress,
        usdcAmount,
        chain: sourceChainConfig,
        wallet: activeWallet,
        walletKit: kit,
      });

      setPhase("submitting");
      // Fire the backend hint + on-chain receipt watcher in parallel.
      // The hint is best-effort (endpoint may 404 during M5 rollout);
      // the watcher is authoritative.
      await Promise.all([
        postOnChainReceipt({
          intentId,
          txHash: result.txHash,
          chainId: result.chainId,
          poster: defaultOnChainReceiptPoster,
        }).catch(() => null),
        watchArcPayoutEvent({
          chain: sourceChainConfig,
          txHash: result.txHash,
        }),
      ]);

      // Local "done" — the backend `Transfer`-event watcher will flip
      // `intent.status` to `"paid"` once it observes the event, at
      // which point `IntentFlow`'s effect navigates to the receipt.
      setPhase("settled");
    } catch (err) {
      setError(classifyError(err));
      setPhase("error");
    }
  }, [
    activeChain,
    activeWallet,
    allBlockchains,
    changeActiveChainToConfig,
    getActiveWalletKit,
    intent,
    intentId,
  ]);

  if (phase === "error" && error) {
    const resetToIdle = () => {
      setError(null);
      setPhase("idle");
    };
    return (
      <PaymentError
        code={error.code}
        devMessage={error.devMessage}
        intentId={intentId}
        context={{ tokenSymbol: "USDC" }}
        onRetry={resetToIdle}
        onBack={onBack}
        onRescan={onBack}
        onTopUp={resetToIdle}
      />
    );
  }

  const isBusy = phase === "signing" || phase === "submitting";
  const ctaLabel =
    phase === "signing"
      ? "Confirming…"
      : phase === "submitting"
        ? "Confirming payment…"
        : "Send USDC";

  return (
    <View className="bg-light rounded-3xl p-6 shadow-md-">
      <View className="flex-row items-center mb-5">
        <View className="w-11 h-11 bg-light-primary-red/10 rounded-full items-center justify-center mr-3">
          <Store color="#c71c4b" size={20} />
        </View>
        <View className="flex-1">
          <Text className="text-light-matte-black font-semibold text-base">
            {extractMerchantName(intent, merchantNameParam)}
          </Text>
          <Text className="text-light-matte-black/50 text-xs">
            Pay via direct transfer. Confirmation in ~2 seconds.
          </Text>
        </View>
      </View>

      <View className="bg-light-main-container rounded-xl p-4 mb-6">
        <Text className="text-light-matte-black/50 text-xs mb-1">Amount</Text>
        <Text className="text-light-matte-black text-3xl font-bold">
          {formatIdrMinor(extractFiatMinor(intent))}
        </Text>
        <Text className="text-light-matte-black/60 text-sm mt-2">
          ~{formatUsdcMicros(intent.nanopayUsdcAmountMicros)} from your balance
        </Text>
      </View>

      {phase === "submitting" ? (
        <View className="flex-row items-center justify-center mb-4">
          <ActivityIndicator size="small" color="#c71c4b" />
          <Text className="text-light-matte-black/60 text-sm ml-2">
            Waiting for confirmation…
          </Text>
        </View>
      ) : null}

      <TouchableOpacity
        activeOpacity={0.7}
        className={`py-4 px-5 rounded-xl items-center ${
          isBusy ? "bg-light-matte-black/20" : "bg-light-primary-red"
        }`}
        disabled={isBusy}
        onPress={onSend}
      >
        {isBusy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text className="text-light font-semibold">{ctaLabel}</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

/** ── Onchain settlement — TakumiWallet contract (onchain-settlement spec) ── */

/**
 * Single-card onchain settlement flow. The user pays by calling
 * `processMerchantPayment(quoteCommitment, backendSignature)` on the
 * TakumiWallet contract. After the tx confirms, the backend is notified
 * via `POST /v1/pay/intents/:id/onchain`.
 *
 * Shows a countdown timer to `quoteCommitment.expiresAt` so the user
 * knows how long the quote is valid. Handles chain switching, tx
 * broadcast, backend notification, and revert errors.
 */
function OnchainCard({
  intent,
  intentId,
  merchantName: merchantNameParam,
  walletAddress: lockedWalletAddress,
  onBack,
}: {
  intent: PaymentIntentResponse;
  intentId: string;
  merchantName?: string;
  walletAddress?: string;
  onBack: () => void;
}) {
  const { wallets, getKitForWallet } = useWallet();

  const [phase, setPhase] = useState<LocalPhase>("idle");
  const [error, setError] = useState<LocalError | null>(null);
  const [isPinVisible, setIsPinVisible] = useState(false);
  // Once the EVM payment tx is broadcast it must never be signed again for
  // this intent: the contract rejects a second `processMerchantPayment`
  // for the same refId, and the user would otherwise see "something went
  // wrong" after paying twice-in-spirit. A retry re-runs only the
  // confirm-and-submit half against this hash.
  const broadcastTxHashRef = useRef<`0x${string}` | null>(null);
  // Which real stage the payment is in, for the progress card. Advanced
  // only when the stage actually completes (broadcast, receipt, server
  // verdict), never on a timer — so a tick is a promise kept, not an
  // animation. `startedAt` drives the "taking longer than usual" line.
  const [payStep, setPayStep] = useState<{
    step: PayStep;
    startedAt: number;
  } | null>(null);
  const queryClient = useQueryClient();

  const sourceChainId = intent.nanopayUsdcSourceChainId;
  const { data: paymentContract, isLoading: isLoadingContract } =
    usePaymentContract({
      blockchainId: intent.blockchainId,
      chainId:
        !intent.blockchainId && sourceChainId > 0 ? sourceChainId : undefined,
    });

  // ── Resolve the intent's target chain from blockchainId ──────────
  const { data: allBlockchains } = useBlockchainsWithStorage({
    isActive: true,
  });
  const intentBlockchainRow = useMemo(() => {
    if (!intent.blockchainId || !allBlockchains?.length) return null;
    return allBlockchains.find((b) => b.id === intent.blockchainId) ?? null;
  }, [intent.blockchainId, allBlockchains]);

  const intentChainConfig = useMemo<ChainConfig | null>(() => {
    if (!intentBlockchainRow) return null;
    return buildChainConfigFromBlockchain(intentBlockchainRow);
  }, [intentBlockchainRow]);

  // ── Wallet selection: filter to wallets matching the intent chain ──
  const intentNamespace = intentChainConfig?.namespace ?? null;

  const eligibleWallets = useMemo(() => {
    if (!intentNamespace) return [];
    return wallets.filter((w) => w.namespace === intentNamespace);
  }, [wallets, intentNamespace]);

  const [selectedWalletAddr, setSelectedWalletAddr] = useState<string | null>(
    lockedWalletAddress ?? null,
  );

  // Auto-select wallet: if a locked address was provided, keep it; otherwise
  // fall back to the first eligible wallet and keep the selection stable.
  useEffect(() => {
    if (lockedWalletAddress) return;
    if (!eligibleWallets.length) {
      setSelectedWalletAddr(null);
      return;
    }
    const stillValid = eligibleWallets.some(
      (w) => w.address === selectedWalletAddr,
    );
    if (!stillValid) setSelectedWalletAddr(eligibleWallets[0].address);
  }, [lockedWalletAddress, eligibleWallets, selectedWalletAddr]);

  const selectedWallet = useMemo(
    () => eligibleWallets.find((w) => w.address === selectedWalletAddr) ?? null,
    [eligibleWallets, selectedWalletAddr],
  );

  // ── Balance display for the selected wallet ───────────────────────
  const [nativeBalance, setNativeBalance] = useState<bigint>(0n);
  const [isLoadingBalance, setIsLoadingBalance] = useState(true);
  const [tokenBalance, setTokenBalance] = useState<string>("0");
  const [isLoadingTokenBalance, setIsLoadingTokenBalance] = useState(false);
  // Live fee for THIS payment (gas for the exact calldata × current fee
  // cap), priced by the effect further down; null while unknown.
  const [feeEstimate, setFeeEstimate] = useState<{ feeWei: bigint } | null>(
    null,
  );

  const selectedKit = useMemo(
    () => (selectedWallet ? getKitForWallet(selectedWallet) : null),
    [selectedWallet, getKitForWallet],
  );

  // Fetch native balance for selected wallet on the intent's chain.
  useEffect(() => {
    if (!selectedWallet || !selectedKit || !intentChainConfig) {
      setNativeBalance(0n);
      setIsLoadingBalance(false);
      return;
    }
    if (selectedKit.namespace !== intentChainConfig.namespace) {
      setNativeBalance(0n);
      setIsLoadingBalance(false);
      return;
    }
    let cancelled = false;
    setIsLoadingBalance(true);
    selectedKit
      .getNativeBalance(selectedWallet.address, intentChainConfig)
      .then((b) => {
        if (!cancelled) setNativeBalance(b);
      })
      .catch(() => {
        if (!cancelled) setNativeBalance(0n);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingBalance(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedWallet, selectedKit, intentChainConfig]);

  const nativeBalanceDisplay = useMemo(() => {
    if (!selectedKit || !intentChainConfig) return "—";
    if (selectedKit.namespace !== intentChainConfig.namespace) return "—";
    return selectedKit.formatNativeAmount(nativeBalance, intentChainConfig);
  }, [selectedKit, intentChainConfig, nativeBalance]);

  // Fetch selected payment token balance (from the intent's sourceTokenId).
  const paymentTokens = usePaymentTokens({
    blockchainId: intent.blockchainId,
  });
  const paymentToken = useMemo(() => {
    if (!paymentTokens.data?.length) return null;
    const wanted = intent.sourceTokenId ?? intent.sourceToken?.id;
    if (wanted) {
      return paymentTokens.data.find((t) => t.id === wanted) ?? null;
    }
    return paymentTokens.data[0] ?? null;
  }, [paymentTokens.data, intent.sourceTokenId, intent.sourceToken?.id]);

  useEffect(() => {
    if (
      !selectedWallet ||
      !selectedKit ||
      !intentChainConfig ||
      !paymentToken
    ) {
      setTokenBalance("0");
      setIsLoadingTokenBalance(false);
      return;
    }
    if (selectedKit.namespace !== intentChainConfig.namespace) {
      setTokenBalance("0");
      return;
    }
    if (!paymentToken.contractAddress) {
      setTokenBalance("0");
      return;
    }
    let cancelled = false;
    setIsLoadingTokenBalance(true);
    selectedKit
      .getTokenBalance(
        selectedWallet.address,
        intentChainConfig,
        paymentToken.contractAddress,
      )
      .then((raw) => {
        if (cancelled) return;
        const decimals = paymentToken.decimals ?? 6;
        const divisor = 10n ** BigInt(decimals);
        const whole = raw / divisor;
        const frac = raw % divisor;
        const fracStr = frac.toString().padStart(decimals, "0");
        setTokenBalance(
          `${whole.toString()}.${fracStr}`.replace(/\.?0+$/, "") || "0",
        );
      })
      .catch(() => {
        if (!cancelled) setTokenBalance("0");
      })
      .finally(() => {
        if (!cancelled) setIsLoadingTokenBalance(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedWallet, selectedKit, intentChainConfig, paymentToken]);

  // ── Countdown timer ───────────────────────────────────────────────
  const expiresAtMs = intent.quoteCommitment
    ? intent.quoteCommitment.expiresAt * 1000
    : intent.expiresAt;
  const [remainingMs, setRemainingMs] = useState(() =>
    Math.max(0, expiresAtMs - Date.now()),
  );

  useEffect(() => {
    const timer = setInterval(() => {
      const left = Math.max(0, expiresAtMs - Date.now());
      setRemainingMs(left);
      if (left === 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresAtMs]);

  const countdownLabel = useMemo(() => {
    if (remainingMs <= 0) return "Expired";
    const totalSecs = Math.ceil(remainingMs / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }, [remainingMs]);

  const isExpired = remainingMs <= 0;

  // ── Payment execution ─────────────────────────────────────────────
  const onPay = useCallback(async () => {
    if (!selectedWallet || !intentChainConfig) {
      setError(makeLocalError("wallet_unsupported", "No wallet selected"));
      setPhase("error");
      return;
    }

    const kit = getKitForWallet(selectedWallet);
    const advance = (step: PayStep) =>
      setPayStep({ step, startedAt: Date.now() });

    // Pre-flight on balances we already display. A wallet with nothing in
    // it should hear so here, in plain words, not after a PIN prompt and a
    // failed broadcast whose error we then have to translate. Only runs
    // when the balances have actually loaded, and never once a tx is out
    // (a retry re-submits the hash, it doesn't pay again).
    if (!broadcastTxHashRef.current) {
      const shortfall = preflightShortfall({
        paymentToken,
        tokenBalance,
        isLoadingTokenBalance,
        nativeBalance,
        isLoadingBalance,
        feePaidInNative: typeof kit.sendContractTransaction === "function",
        feeNeededWei: feeEstimate?.feeWei ?? null,
        intent,
      });
      if (shortfall) {
        setError(makeLocalError(shortfall, "pre-flight balance check"));
        setPhase("error");
        return;
      }
    }

    try {
      setPhase("signing");
      setError(null);
      advance(broadcastTxHashRef.current ? "send" : "prepare");

      // Dispatch on the kit's settlement capability, not the chain
      // namespace: Solana settles via an Anchor instruction, EVM via a
      // contract transaction — each kit advertises exactly one.
      if (typeof kit.sendAnchorInstruction === "function") {
        const programIdStr = paymentContract?.address;
        if (!programIdStr) {
          setError(
            makeLocalError(
              "unknown",
              "No payment contract found for this chain",
            ),
          );
          setPhase("error");
          return;
        }

        const result = await executeOnchainSettlementSvm({
          intent,
          wallet: selectedWallet,
          walletKit: kit,
          chain: intentChainConfig,
          programIdStr,
        });

        setPhase("submitting");
        await postOnchainSubmit({
          intentId,
          txHash: result.txSignature,
          blockchainId: intent.blockchainId!,
          poster: defaultOnchainSubmitPoster,
        }).catch(() => null);
      } else if (typeof kit.sendContractTransaction === "function") {
        const contractAddress = paymentContract?.address as
          | `0x${string}`
          | undefined;
        if (!contractAddress) {
          setError(
            makeLocalError(
              "unknown",
              "No payment contract found for this chain",
            ),
          );
          setPhase("error");
          return;
        }

        let txHash = broadcastTxHashRef.current;
        if (!txHash) {
          const result = await executeOnchainSettlement({
            intent,
            wallet: selectedWallet,
            walletKit: kit,
            chain: intentChainConfig,
            contractAddress,
          });
          txHash = result.txHash;
          broadcastTxHashRef.current = txHash;
        }

        setPhase("submitting");
        advance("send");
        // Hand the hash over right away; the backend records it and
        // verifies against the chain on its own queue (receipt at the
        // chain's confirmation depth, then the contract record). From
        // here the user may leave: the status poll / push carries the
        // result. The tx is already out, so a failed submit is retried
        // with the same hash and is never a reason to sign again.
        try {
          await submitOnchainWithRetry({
            intentId,
            txHash,
            blockchainId: intent.blockchainId!,
            poster: defaultOnchainSubmitPoster,
          });
          advance("verify");
          // Poll immediately (and, while `settling`, every second — see
          // useIntentStatus) so a fast chain opens the receipt in ~1-2s.
          queryClient.invalidateQueries({
            queryKey: ["pay-intent", intentId],
          });
          // Stay in "submitting": the progress card owns the screen until
          // the poll reports `paid` (receipt) or `failed`.
          return;
        } catch (err) {
          if (__DEV__) {
            console.warn(
              `[pay-merchant] onchain submit failed intent=${intentId} txHash=${txHash}`,
              err,
            );
          }
          // Whatever kept the hash from reaching the server (network,
          // 5xx, or a 400 for a chain we've misconfigured), the payment
          // tx is already out. Keep the hash so "Check again" re-submits
          // it; never fall back to signing again.
          setError(makeLocalError("settlement_unconfirmed"));
          setPayStep(null);
          setPhase("error");
          return;
        }
      } else if (typeof kit.sendSorobanTransaction === "function") {
        // Prefer the intent's `takumiPayContractId` — the contract id the
        // backend signature is bound to — so the wallet submits to exactly the
        // contract the quote was signed for (a mismatch would trap on-chain);
        // fall back to the resolved SmartContract row.
        const contractId =
          intent.takumiPayContractId ?? paymentContract?.address;
        if (!contractId) {
          setError(
            makeLocalError(
              "unknown",
              "No payment contract found for this chain",
            ),
          );
          setPhase("error");
          return;
        }

        const result = await executeOnchainSettlementStellar({
          intent,
          wallet: selectedWallet,
          walletKit: kit,
          chain: intentChainConfig,
          contractId,
        });

        setPhase("submitting");
        await postOnchainSubmit({
          intentId,
          txHash: result.txHash,
          blockchainId: intent.blockchainId!,
          poster: defaultOnchainSubmitPoster,
        }).catch(() => null);
      } else {
        setError(
          makeLocalError(
            "wallet_unsupported",
            "Wallet can't settle payments on this chain",
          ),
        );
        setPhase("error");
        return;
      }

      setPayStep(null);
      setPhase("settled");
    } catch (err) {
      setPayStep(null);
      setError(classifyError(err));
      setPhase("error");
    }
  }, [
    selectedWallet,
    getKitForWallet,
    intent,
    intentChainConfig,
    intentId,
    paymentContract,
    queryClient,
    paymentToken,
    tokenBalance,
    isLoadingTokenBalance,
    nativeBalance,
    isLoadingBalance,
    feeEstimate,
  ]);

  // Price the fee for this exact call. Re-priced when the wallet or quote
  // changes; while unknown the pre-flight only rules out an empty wallet.
  useEffect(() => {
    const kit = selectedKit;
    const contract = (intent.contractAddress ?? paymentContract?.address) as
      | `0x${string}`
      | undefined;
    if (
      !kit?.estimateContractCallFee ||
      !selectedWallet ||
      !intentChainConfig ||
      !contract ||
      !intent.quoteCommitment ||
      !intent.quoteSignature
    ) {
      setFeeEstimate(null);
      return;
    }
    let cancelled = false;
    try {
      const call = buildMerchantPaymentCall(intent, contract);
      kit
        .estimateContractCallFee({
          from: selectedWallet.address,
          chain: intentChainConfig,
          to: call.to,
          data: call.data,
          value: call.value,
          fallbackGas: MERCHANT_PAYMENT_GAS_FALLBACK,
        })
        .then((fee) => {
          if (!cancelled) setFeeEstimate({ feeWei: fee.feeWei });
        })
        .catch(() => {
          if (!cancelled) setFeeEstimate(null);
        });
    } catch {
      setFeeEstimate(null);
    }
    return () => {
      cancelled = true;
    };
  }, [selectedKit, selectedWallet, intentChainConfig, intent, paymentContract]);

  // Known before anyone taps anything: the balances on this card already
  // say whether it can pay. Drives the inline notice and disables Pay so
  // the PIN never opens for a payment we know will not go through.
  const shortfall = useMemo(
    () =>
      broadcastTxHashRef.current
        ? null
        : preflightShortfall({
            paymentToken,
            tokenBalance,
            isLoadingTokenBalance,
            nativeBalance,
            isLoadingBalance,
            feePaidInNative:
              typeof selectedKit?.sendContractTransaction === "function",
            feeNeededWei: feeEstimate?.feeWei ?? null,
            intent,
          }),
    [
      paymentToken,
      tokenBalance,
      isLoadingTokenBalance,
      nativeBalance,
      isLoadingBalance,
      selectedKit,
      feeEstimate,
      intent,
    ],
  );

  // What this payment is in, for error copy that has to name it: the
  // settlement token from the intent (or the resolved payment token), the
  // fee coin from the kit, the network from the row. Never assumed.
  const nativeAmount = (wei: bigint) =>
    selectedKit && intentChainConfig
      ? selectedKit.formatNativeAmount(wei, intentChainConfig).split(" ")[0]
      : undefined;
  const errorContext: PaymentErrorContext = {
    tokenSymbol: intent.sourceToken?.symbol ?? paymentToken?.symbol,
    feeSymbol:
      (intentChainConfig && selectedKit?.nativeSymbol?.(intentChainConfig)) ||
      undefined,
    networkName:
      intentBlockchainRow?.name ??
      (intentChainConfig ? formatChainLabel(intentChainConfig) : undefined),
    feeNeeded: feeEstimate ? nativeAmount(feeEstimate.feeWei) : undefined,
    feeHave: isLoadingBalance ? undefined : nativeAmount(nativeBalance),
  };

  // ── Error state ───────────────────────────────────────────────────
  if (phase === "error" && error) {
    const resetToIdle = () => {
      setError(null);
      setPhase("idle");
    };
    // "Check again" after an unconfirmed submit re-runs only the
    // confirm-and-submit half against the hash already out; nothing is
    // signed, so there is nothing for a PIN to authorise.
    const retry = () => {
      if (broadcastTxHashRef.current) {
        setError(null);
        void onPay();
        return;
      }
      resetToIdle();
    };
    return (
      <PaymentError
        code={error.code}
        devMessage={error.devMessage}
        intentId={intentId}
        context={errorContext}
        onRetry={retry}
        onBack={onBack}
        onRescan={onBack}
        onTopUp={resetToIdle}
      />
    );
  }

  const isBusy =
    phase === "signing" || phase === "submitting" || isLoadingContract;
  const isPaid = intent.status === "paid" || intent.status === "paid_out";
  const inProgress =
    phase === "signing" ||
    phase === "submitting" ||
    phase === "settled" ||
    isPaid;
  const ctaLabel = isLoadingContract
    ? "Loading…"
    : phase === "signing"
      ? "Confirming…"
      : phase === "submitting"
        ? "Confirming payment…"
        : isExpired
          ? "Quote expired"
          : !selectedWallet
            ? "No wallet available"
            : "Pay";

  const tokenDisplay = settlementAmountLabel(intent, paymentToken);

  const networkLabel =
    intentBlockchainRow?.name ??
    (intentChainConfig ? formatChainLabel(intentChainConfig) : "Unknown");

  const merchantLabel = extractMerchantName(intent, merchantNameParam);

  return (
    <>
      <View className="bg-light rounded-3xl p-6 shadow-md-">
        <View className="flex-row items-center mb-5">
          <View className="w-11 h-11 bg-light-primary-red/10 rounded-full items-center justify-center mr-3">
            <Store color="#c71c4b" size={20} />
          </View>
          <View className="flex-1">
            <Text className="text-light-matte-black font-semibold text-base">
              {merchantLabel}
            </Text>
            <Text className="text-light-matte-black/50 text-xs">
              Pay via onchain settlement
            </Text>
          </View>
        </View>

        {/* While paying, the card is just the summary; the status hero
            below it is what the user watches. */}
        <View
          className={`bg-light-main-container rounded-xl p-4 ${inProgress ? "" : "mb-4"}`}
        >
          <Text className="text-light-matte-black/50 text-xs mb-1">Amount</Text>
          <Text className="text-light-matte-black text-3xl font-bold">
            {formatIdrMinor(extractFiatMinor(intent))}
          </Text>
          <Text className="text-light-matte-black/60 text-sm mt-2">
            ~{tokenDisplay} from your balance
          </Text>
        </View>

        {inProgress ? null : (
          <>
            {/* Network badge — driven by the intent's blockchainId */}
            <View className="bg-light-main-container rounded-xl px-4 py-3 mb-4">
              <Text className="text-light-matte-black/50 text-xs mb-1">
                Network
              </Text>
              <Text className="text-light-matte-black font-medium text-sm">
                {networkLabel}
              </Text>
            </View>

            {/* Wallet display — locked to the wallet that created the intent */}
            <View className="bg-light-main-container rounded-xl px-4 py-3 mb-4 flex-row items-center justify-between">
              <View className="flex-1">
                <Text className="text-light-matte-black/50 text-xs mb-1">
                  Pay from
                </Text>
                {selectedWallet ? (
                  <>
                    <Text
                      className="text-light-matte-black font-medium text-sm"
                      numberOfLines={1}
                    >
                      {selectedWallet.name || "Wallet"}
                    </Text>
                    <Text
                      className="text-light-matte-black/50 text-xs"
                      numberOfLines={1}
                      ellipsizeMode="middle"
                    >
                      {selectedWallet.address}
                    </Text>
                  </>
                ) : (
                  <Text className="text-light-matte-black/50 text-sm">
                    {eligibleWallets.length === 0
                      ? "No wallet for this network"
                      : "Select wallet"}
                  </Text>
                )}
              </View>
              <View className="items-end ml-3">
                {selectedWallet ? (
                  isLoadingBalance ? (
                    <ActivityIndicator size="small" color="#c71c4b" />
                  ) : (
                    <>
                      <Text className="text-light-matte-black text-xs font-medium">
                        {nativeBalanceDisplay}
                      </Text>
                      {paymentToken && (
                        <Text className="text-light-matte-black/60 text-[11px]">
                          {isLoadingTokenBalance
                            ? "Loading…"
                            : `${parseFloat(tokenBalance).toFixed(4)} ${paymentToken.symbol}`}
                        </Text>
                      )}
                    </>
                  )
                ) : null}
              </View>
            </View>

            {/* Network fee — the live estimate that also gates Pay. Only on
              rails that pay it from the wallet's own coin. */}
            {typeof selectedKit?.sendContractTransaction === "function" ? (
              <View className="bg-light-main-container rounded-xl px-4 py-3 mb-4 flex-row items-center justify-between">
                <Text className="text-light-matte-black/50 text-xs">
                  Network fee
                </Text>
                <Text className="text-light-matte-black text-xs font-medium">
                  {feeEstimate && intentChainConfig
                    ? `≈ ${selectedKit.formatNativeAmount(feeEstimate.feeWei, intentChainConfig)}`
                    : "Estimating…"}
                </Text>
              </View>
            ) : null}

            {shortfall ? (
              <BalanceShortfallNotice code={shortfall} context={errorContext} />
            ) : null}

            <View className="flex-row items-center justify-center mb-4">
              <Text
                className={`text-sm font-medium ${
                  isExpired
                    ? "text-red-500"
                    : remainingMs < 60_000
                      ? "text-orange-500"
                      : "text-light-matte-black/60"
                }`}
              >
                {isExpired ? "Quote expired" : `Expires in ${countdownLabel}`}
              </Text>
            </View>

            <TouchableOpacity
              activeOpacity={0.7}
              className={`py-4 px-5 rounded-xl items-center ${
                isBusy || isExpired || !selectedWallet || shortfall
                  ? "bg-light-matte-black/20"
                  : "bg-light-primary-red"
              }`}
              disabled={isBusy || isExpired || !selectedWallet || !!shortfall}
              onPress={() => setIsPinVisible(true)}
            >
              {isBusy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text className="text-light font-semibold">{ctaLabel}</Text>
              )}
            </TouchableOpacity>
          </>
        )}

        <PinConfirmationModal
          visible={isPinVisible}
          onClose={() => setIsPinVisible(false)}
          onConfirm={() => {
            setIsPinVisible(false);
            onPay();
          }}
          title="Confirm Payment"
        />
      </View>

      {inProgress ? (
        <PaymentProgressHero
          step={
            isPaid || phase === "settled"
              ? "done"
              : (payStep?.step ?? "prepare")
          }
          startedAt={payStep?.startedAt ?? Date.now()}
          merchantName={merchantLabel}
          onLeave={onBack}
        />
      ) : null}
    </>
  );
}

/**
 * Default poster for `/v1/pay/intents/:id/onchain`. Uses
 * `optionalAuthApi` so the payment flow never depends on the global
 * active wallet's auth state — the intent was already created under
 * the correct wallet's token, and the submit is a latency hint the
 * backend can reconcile from on-chain events.
 */
async function defaultOnchainSubmitPoster({
  intentId,
  body,
}: {
  intentId: string;
  body: OnchainSubmitRequest;
}): Promise<OnchainSubmitResponse> {
  return optionalAuthApi
    .post(onchainSubmitEndpoint(intentId), { json: body })
    .json<OnchainSubmitResponse>();
}

/**
 * Default poster for `/v1/pay/intents/:id/on-chain-receipt` wired to
 * the shared `api` ky instance. `postOnChainReceipt` swallows a 404
 * from here so the user's on-chain settle is never gated on backend
 * deploy timing.
 */
async function defaultOnChainReceiptPoster({
  intentId,
  body,
}: {
  intentId: string;
  body: OnChainReceiptRequest;
}): Promise<OnChainReceiptResponse> {
  return api
    .post(onChainReceiptEndpoint(intentId), { json: body })
    .json<OnChainReceiptResponse>();
}

/** ── fallback path: mint an intent from the scanned raw payload ─────── */

function MintFallback({
  kind,
  raw,
  merchantName: merchantNameParam,
}: {
  kind: MerchantKind;
  raw: string;
  merchantName?: string;
}) {
  const createIntent = useCreateIntent();
  const { wallets, activeChain, getKitForWallet } = useWallet();
  const { data: blockchains } = useBlockchainsWithStorage({ isActive: true });

  const [amountInput, setAmountInput] = useState("");
  const [error, setError] = useState<LocalError | null>(null);
  const [selectedChainId, setSelectedChainId] = useState<string | null>(null);
  const [selectedToken, setSelectedToken] = useState<PaymentToken | null>(null);
  const [chainPickerOpen, setChainPickerOpen] = useState(false);
  const [tokenPickerOpen, setTokenPickerOpen] = useState(false);
  const [chainSearch, setChainSearch] = useState("");
  const [tokenSearch, setTokenSearch] = useState("");

  // Fetch all payment tokens — the source of truth for which chains
  // support payments and which tokens are available per chain.
  const { data: allPaymentTokens, isLoading: isLoadingTokens } =
    usePaymentTokens();

  // Chains that have at least one payment-enabled token
  const paymentChainIds = useMemo(() => {
    if (!allPaymentTokens?.length) return new Set<string>();
    return new Set(allPaymentTokens.map((t) => t.blockchain.id));
  }, [allPaymentTokens]);

  // Payment-enabled AND signable by this device. The merchant's accepted
  // list says nothing about what the user holds a key for, so a
  // private-key EVM user could pick a Solana source chain, get through
  // the picker, and only hit a generic `chain_mismatch` at sign time
  // when `changeActiveChainToConfig` couldn't move the wallet. Filtering
  // here keeps a dead option out of the list instead of failing later.
  //
  // `wallets.length === 0` (still hydrating) is treated as "unknown" and
  // filters nothing, so the picker never blanks on first paint.
  const availableChains = useMemo(() => {
    if (!blockchains?.length) return [];
    const payable = blockchains.filter((b) => paymentChainIds.has(b.id));
    if (wallets.length === 0) return payable;
    const owned = new Set(ownedNamespaces(wallets));
    return payable.filter((b) =>
      owned.has(buildChainConfigFromBlockchain(b).namespace),
    );
  }, [blockchains, paymentChainIds, wallets]);

  const selectedChain = useMemo(
    () => availableChains.find((b) => b.id === selectedChainId) ?? null,
    [availableChains, selectedChainId],
  );

  // Auto-select blockchain. Prefer the chain matching the current
  // active wallet chain (Solana: match `cluster` to `isTestnet` so
  // devnet ≠ mainnet); fall back to the first available chain so the
  // picker is never empty after a scan when the active chain is
  // payment-disabled.
  useEffect(() => {
    if (selectedChainId || !availableChains.length) return;
    const match = availableChains.find((b) =>
      matchesBlockchainRow(activeChain, b),
    );
    setSelectedChainId(match?.id ?? availableChains[0].id);
  }, [activeChain, availableChains, selectedChainId]);

  // Tokens filtered to the selected chain
  const paymentTokens = useMemo(() => {
    if (!allPaymentTokens?.length) return [];
    if (!selectedChainId) return allPaymentTokens;
    return allPaymentTokens.filter((t) => t.blockchain.id === selectedChainId);
  }, [allPaymentTokens, selectedChainId]);

  // Auto-pick the first token for the current chain. Also handles the
  // chain-change case: if the previously selected token isn't valid on
  // the new chain, swap to the first one available there.
  useEffect(() => {
    if (!paymentTokens.length) {
      if (selectedToken) setSelectedToken(null);
      return;
    }
    const stillValid = paymentTokens.some((t) => t.id === selectedToken?.id);
    if (!stillValid) setSelectedToken(paymentTokens[0]);
  }, [paymentTokens, selectedToken]);

  const isLoadingChains = isLoadingTokens || !blockchains;

  // ── Wallet picker: filter to wallets matching selected chain ──────
  const selectedChainConfig = useMemo<ChainConfig | null>(() => {
    if (!selectedChain) return null;
    return buildChainConfigFromBlockchain(selectedChain);
  }, [selectedChain]);

  const selectedNamespace = selectedChainConfig?.namespace ?? null;

  const eligibleWallets = useMemo(() => {
    if (!selectedNamespace) return [];
    return wallets.filter((w) => w.namespace === selectedNamespace);
  }, [wallets, selectedNamespace]);

  const [selectedWalletAddr, setSelectedWalletAddr] = useState<string | null>(
    null,
  );
  const [walletPickerOpen, setWalletPickerOpen] = useState(false);

  useEffect(() => {
    if (!eligibleWallets.length) {
      setSelectedWalletAddr(null);
      return;
    }
    const stillValid = eligibleWallets.some(
      (w) => w.address === selectedWalletAddr,
    );
    if (!stillValid) setSelectedWalletAddr(eligibleWallets[0].address);
  }, [eligibleWallets, selectedWalletAddr]);

  const selectedWallet = useMemo(
    () => eligibleWallets.find((w) => w.address === selectedWalletAddr) ?? null,
    [eligibleWallets, selectedWalletAddr],
  );

  // ── Auth check for selected wallet ────────────────────────────────
  const [isWalletAuthed, setIsWalletAuthed] = useState<boolean | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isSignStatementVisible, setIsSignStatementVisible] = useState(false);
  const [isSignInPinVisible, setIsSignInPinVisible] = useState(false);

  useEffect(() => {
    if (!selectedWallet) {
      setIsWalletAuthed(null);
      return;
    }
    let cancelled = false;
    setIsCheckingAuth(true);
    getAccessTokenForWallet(selectedWallet.address.toLowerCase()).then(
      (token) => {
        if (!cancelled) {
          setIsWalletAuthed(!!token);
          setIsCheckingAuth(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [selectedWallet]);

  // ── Inline sign-in (SIWE / SIWS via kit.signAuthMessage) ─────────
  const nonceOpts = getNonceParams(selectedChainConfig, selectedChainConfig);

  const { data: nonceData } = useNonce(selectedWallet?.address, nonceOpts);
  const { mutateAsync: verifySignature } = useVerifySignature();

  const handleSignIn = useCallback(async () => {
    if (!selectedWallet || !nonceData?.message) return;
    setIsSigningIn(true);
    try {
      const kit = getKitForWallet(selectedWallet);
      const signature = await kit.signAuthMessage(
        selectedWallet,
        nonceData.message,
      );
      await verifySignature({ message: nonceData.message, signature });
      setIsWalletAuthed(true);
    } catch (err) {
      if (__DEV__) console.error("[MintFallback] sign-in failed:", err);
      setError(makeLocalError("unknown", "Sign-in failed. Please try again."));
    } finally {
      setIsSigningIn(false);
    }
  }, [selectedWallet, nonceData, getKitForWallet, verifySignature]);

  // ── Balance display for selected wallet ───────────────────────────
  const selectedKit = useMemo(
    () => (selectedWallet ? getKitForWallet(selectedWallet) : null),
    [selectedWallet, getKitForWallet],
  );

  const [nativeBalance, setNativeBalance] = useState<bigint>(0n);
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);

  useEffect(() => {
    if (!selectedWallet || !selectedKit || !selectedChainConfig) {
      setNativeBalance(0n);
      return;
    }
    if (selectedKit.namespace !== selectedChainConfig.namespace) return;
    let cancelled = false;
    setIsLoadingBalance(true);
    selectedKit
      .getNativeBalance(selectedWallet.address, selectedChainConfig)
      .then((b) => {
        if (!cancelled) setNativeBalance(b);
      })
      .catch(() => {
        if (!cancelled) setNativeBalance(0n);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingBalance(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedWallet, selectedKit, selectedChainConfig]);

  const nativeBalanceDisplay = useMemo(() => {
    if (!selectedKit || !selectedChainConfig) return "—";
    if (selectedKit.namespace !== selectedChainConfig.namespace) return "—";
    return selectedKit.formatNativeAmount(nativeBalance, selectedChainConfig);
  }, [selectedKit, selectedChainConfig, nativeBalance]);

  // ── Token balance for the selected payment token ──────────────────
  const [tokenBalance, setTokenBalance] = useState<string>("0");
  const [isLoadingTokenBalance, setIsLoadingTokenBalance] = useState(false);

  // The token amount isn't known until the quote comes back, so this step
  // only catches what needs no quote: a wallet with none of the token, or
  // none of the network's coin for the fee. Exact amount-vs-balance is the
  // confirm card's job.
  const quoteShortfall = useMemo(
    () =>
      preflightShortfall({
        paymentToken: selectedToken,
        tokenBalance,
        isLoadingTokenBalance,
        nativeBalance,
        isLoadingBalance,
        feePaidInNative:
          typeof selectedKit?.sendContractTransaction === "function",
        // Any positive token balance passes here; the quote decides the rest.
        intent: { nanopayUsdcAmountMicros: "1" },
      }),
    [
      selectedToken,
      tokenBalance,
      isLoadingTokenBalance,
      nativeBalance,
      isLoadingBalance,
      selectedKit,
    ],
  );

  useEffect(() => {
    if (
      !selectedWallet ||
      !selectedKit ||
      !selectedChainConfig ||
      !selectedToken
    ) {
      setTokenBalance("0");
      setIsLoadingTokenBalance(false);
      return;
    }
    if (selectedKit.namespace !== selectedChainConfig.namespace) {
      setTokenBalance("0");
      return;
    }
    if (!selectedToken.contractAddress) {
      setTokenBalance("0");
      return;
    }
    let cancelled = false;
    setIsLoadingTokenBalance(true);
    selectedKit
      .getTokenBalance(
        selectedWallet.address,
        selectedChainConfig,
        selectedToken.contractAddress,
      )
      .then((raw) => {
        if (cancelled) return;
        const decimals = selectedToken.decimals ?? 6;
        const divisor = 10n ** BigInt(decimals);
        const whole = raw / divisor;
        const frac = raw % divisor;
        const fracStr = frac.toString().padStart(decimals, "0");
        setTokenBalance(
          `${whole.toString()}.${fracStr}`.replace(/\.?0+$/, "") || "0",
        );
      })
      .catch(() => {
        if (!cancelled) setTokenBalance("0");
      })
      .finally(() => {
        if (!cancelled) setIsLoadingTokenBalance(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedWallet, selectedKit, selectedChainConfig, selectedToken]);

  const filteredChains = useMemo(() => {
    const q = chainSearch.trim().toLowerCase();
    if (!q) return availableChains;
    return availableChains.filter((b) => {
      const native = b.tokens?.find((t) => t.isNativeCurrency) ?? b.tokens?.[0];
      return (
        b.name.toLowerCase().includes(q) ||
        (native?.symbol?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [availableChains, chainSearch]);

  const filteredTokens = useMemo(() => {
    const q = tokenSearch.trim().toLowerCase();
    if (!q) return paymentTokens;
    return paymentTokens.filter(
      (t) =>
        t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q),
    );
  }, [paymentTokens, tokenSearch]);

  // Lightweight TLV walk for the static-vs-dynamic QRIS branch + merchant
  // name (tag 59). Scanner already validated CRC upstream so we stay lenient.
  const { staticAmount, qrisMerchantName } = useMemo(() => {
    if (kind !== "qris")
      return { staticAmount: undefined, qrisMerchantName: undefined };
    const trimmed = raw.trim();
    if (!trimmed.startsWith("000201"))
      return { staticAmount: undefined, qrisMerchantName: undefined };
    let amount: number | undefined;
    let name: string | undefined;
    let i = 0;
    while (i + 4 <= trimmed.length) {
      const tag = trimmed.slice(i, i + 2);
      const lenStr = trimmed.slice(i + 2, i + 4);
      if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lenStr)) break;
      const length = Number.parseInt(lenStr, 10);
      const start = i + 4;
      const end = start + length;
      if (end > trimmed.length) break;
      if (tag === "54") {
        const v = trimmed.slice(start, end);
        if (/^\d+(?:\.\d+)?$/.test(v)) {
          const n = Number.parseInt(v.split(".")[0], 10);
          if (Number.isFinite(n)) amount = n;
        }
      } else if (tag === "59") {
        name = trimmed.slice(start, end);
      }
      i = end;
    }
    return { staticAmount: amount, qrisMerchantName: name };
  }, [kind, raw]);

  const resolvedMerchantName =
    merchantNameParam || qrisMerchantName || undefined;

  const needsAmount = staticAmount === undefined;

  const parsedAmount = needsAmount
    ? Number.parseInt(amountInput, 10)
    : undefined;
  const isAmountEmpty = needsAmount && amountInput.trim().length === 0;
  const isAmountInvalid =
    needsAmount &&
    !isAmountEmpty &&
    (!Number.isFinite(parsedAmount) || (parsedAmount ?? 0) <= 0);

  const onMint = useCallback(async () => {
    setError(null);
    const amountMinor = staticAmount ?? Number.parseInt(amountInput, 10);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) return;
    try {
      if (__DEV__) {
        console.log(
          "[MintFallback] sourceTokenId=",
          selectedToken?.id,
          "chain=",
          selectedChain?.name,
          "wallet=",
          selectedWallet?.address,
        );
      }
      const preferredChain = selectedChainConfig
        ? preferredChainRail(selectedChainConfig)
        : "evm";
      const created = await createIntent.mutateAsync({
        scannedPayload: raw,
        currency: "IDR",
        fiatAmountMinor: amountMinor,
        sourceTokenId: selectedToken?.id,
        walletAddress: selectedWallet?.address,
        preferredChain,
      });
      // Replace so the user's back button returns to the scanner, not
      // to this fallback screen. The new URL is the canonical form.
      // Cast matches the pattern used in `app/scan-to-pay.tsx` —
      // `/pay-merchant` isn't yet in the generated typed-routes union.
      router.replace({
        pathname: "/pay-merchant" as "/send",
        params: {
          intentId: created.id,
          merchantName: resolvedMerchantName,
          walletAddress: selectedWallet?.address,
        },
      });
    } catch (err) {
      setError(classifyError(err));
    }
  }, [
    amountInput,
    createIntent,
    raw,
    staticAmount,
    selectedToken,
    selectedWallet,
    selectedChainConfig,
    resolvedMerchantName,
  ]);

  if (error) {
    const dismiss = () => setError(null);
    return (
      <PaymentError
        code={error.code}
        devMessage={error.devMessage}
        onRetry={dismiss}
        onBack={dismiss}
        onRescan={() => router.back()}
        onTopUp={dismiss}
      />
    );
  }

  return (
    <View className="bg-light rounded-3xl p-6 shadow-md-">
      <View className="flex-row items-center mb-5">
        <View className="w-11 h-11 bg-light-primary-red/10 rounded-full items-center justify-center mr-3">
          <Store color="#c71c4b" size={20} />
        </View>
        <View className="flex-1">
          <Text className="text-light-matte-black font-semibold text-base">
            {resolvedMerchantName ??
              (kind === "qris" ? "QRIS merchant" : "TakumiPay merchant")}
          </Text>
          <Text className="text-light-matte-black/50 text-xs">
            Confirm amount to create a payment
          </Text>
        </View>
      </View>

      {needsAmount ? (
        <View className="mb-6">
          <Text className="text-light-matte-black/60 text-sm mb-2">
            Amount (IDR)
          </Text>
          <TextInput
            value={amountInput}
            onChangeText={(t) => setAmountInput(t.replace(/[^0-9]/g, ""))}
            keyboardType="number-pad"
            placeholder="0"
            className={`bg-light-main-container rounded-xl px-4 py-3 text-light-matte-black text-base ${
              isAmountInvalid ? "border border-red-400" : ""
            }`}
          />
          {isAmountInvalid && (
            <Text className="text-red-500 text-xs mt-1.5 ml-1">
              Enter an amount greater than 0
            </Text>
          )}
        </View>
      ) : (
        <View className="bg-light-main-container rounded-xl p-4 mb-6">
          <Text className="text-light-matte-black/50 text-xs mb-1">Amount</Text>
          <Text className="text-light-matte-black text-xl font-bold">
            {formatIdrMinor(staticAmount as number)}
          </Text>
        </View>
      )}

      <View className="mb-6">
        <Text className="text-light-matte-black/60 text-sm mb-2">Network</Text>
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() => setChainPickerOpen(true)}
          className="bg-light-main-container rounded-xl px-4 py-3 flex-row items-center justify-between"
        >
          {selectedChain ? (
            (() => {
              const nativeToken =
                selectedChain.tokens?.find((t) => t.isNativeCurrency) ??
                selectedChain.tokens?.[0];
              return (
                <View className="flex-row items-center flex-1">
                  {nativeToken?.logoUrl ? (
                    <OptimizedImage
                      source={{ uri: nativeToken.logoUrl }}
                      style={{ width: 28, height: 28, borderRadius: 14 }}
                      contentFit="contain"
                    />
                  ) : (
                    <View className="w-7 h-7 bg-light-primary-red/10 rounded-full" />
                  )}
                  <Text className="text-light-matte-black font-medium text-base ml-3">
                    {selectedChain.name}
                  </Text>
                </View>
              );
            })()
          ) : (
            <Text className="text-light-matte-black/50 text-base">
              {isLoadingChains ? "Loading networks…" : "Select network"}
            </Text>
          )}
          <ChevronDown color="#20222c" size={16} />
        </TouchableOpacity>
      </View>

      <View className="mb-6">
        <Text className="text-light-matte-black/60 text-sm mb-2">Pay with</Text>
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() => setTokenPickerOpen(true)}
          className="bg-light-main-container rounded-xl px-4 py-3 flex-row items-center justify-between"
        >
          {selectedToken ? (
            <View className="flex-row items-center flex-1">
              {selectedToken.logoUrl ? (
                <OptimizedImage
                  source={{ uri: selectedToken.logoUrl }}
                  style={{ width: 28, height: 28, borderRadius: 14 }}
                  contentFit="contain"
                />
              ) : (
                <View className="w-7 h-7 bg-light-primary-red/10 rounded-full" />
              )}
              <View className="ml-3">
                <Text className="text-light-matte-black font-medium text-base">
                  {selectedToken.symbol}
                </Text>
                <Text className="text-light-matte-black/50 text-xs">
                  {selectedToken.blockchain.name}
                </Text>
              </View>
            </View>
          ) : (
            <Text className="text-light-matte-black/50 text-base">
              {isLoadingTokens ? "Loading tokens…" : "Select token"}
            </Text>
          )}
          <ChevronDown color="#20222c" size={16} />
        </TouchableOpacity>
      </View>

      {/* ── Wallet picker ─────────────────────────────────────────── */}
      <View className="mb-6">
        <Text className="text-light-matte-black/60 text-sm mb-2">Pay from</Text>
        <Pressable
          onPress={() => setWalletPickerOpen(true)}
          className="bg-light-main-container rounded-xl px-4 py-3 flex-row items-center justify-between"
        >
          {selectedWallet ? (
            <View className="flex-1 mr-3">
              <Text
                className="text-light-matte-black font-medium text-base"
                numberOfLines={1}
              >
                {selectedWallet.name || "Wallet"}
              </Text>
              <Text
                className="text-light-matte-black/50 text-xs"
                numberOfLines={1}
                ellipsizeMode="middle"
              >
                {selectedWallet.address}
              </Text>
            </View>
          ) : (
            <Text className="text-light-matte-black/50 text-base flex-1">
              {eligibleWallets.length === 0
                ? "No wallet for this network"
                : "Select wallet"}
            </Text>
          )}
          <View className="items-end">
            {selectedWallet &&
              (isLoadingBalance ? (
                <ActivityIndicator size="small" color="#c71c4b" />
              ) : (
                <>
                  <Text className="text-light-matte-black text-xs font-medium">
                    {nativeBalanceDisplay}
                  </Text>
                  {selectedToken && (
                    <Text className="text-light-matte-black/60 text-[11px]">
                      {isLoadingTokenBalance
                        ? "Loading…"
                        : `${parseFloat(tokenBalance).toFixed(4)} ${selectedToken.symbol}`}
                    </Text>
                  )}
                </>
              ))}
            <ChevronDown color="#20222c" size={16} />
          </View>
        </Pressable>
      </View>

      {quoteShortfall ? (
        <BalanceShortfallNotice
          code={quoteShortfall}
          context={{
            tokenSymbol: selectedToken?.symbol,
            feeSymbol:
              (selectedChainConfig &&
                selectedKit?.nativeSymbol?.(selectedChainConfig)) ||
              undefined,
            networkName: selectedChainConfig
              ? formatChainLabel(selectedChainConfig)
              : undefined,
          }}
        />
      ) : null}

      {/* ── Inline sign-in when wallet is not authenticated ─────── */}
      {selectedWallet && isWalletAuthed === false && !isCheckingAuth && (
        <View className="bg-light-primary-red/5 border border-light-primary-red/15 rounded-xl p-4 mb-6">
          <View className="flex-row items-center mb-2">
            <View className="w-8 h-8 bg-light-primary-red/10 rounded-full items-center justify-center mr-3">
              <Shield color="#c71c4b" size={16} />
            </View>
            <View className="flex-1">
              <Text className="text-light-matte-black text-sm font-semibold">
                Wallet verification needed
              </Text>
              <Text className="text-light-matte-black/50 text-xs">
                Sign a message to prove ownership before paying
              </Text>
            </View>
          </View>
          <TouchableOpacity
            activeOpacity={0.7}
            className={`py-3 rounded-xl items-center flex-row justify-center gap-2 ${
              isSigningIn || !nonceData?.message
                ? "bg-light-primary-red/30"
                : "bg-light-primary-red"
            }`}
            disabled={isSigningIn || !nonceData?.message}
            onPress={() => setIsSignStatementVisible(true)}
          >
            {isSigningIn ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <Shield color="#ffffff" size={14} />
                <Text className="text-white font-semibold text-sm">
                  Sign in with{" "}
                  {getChainFamilyLabel(selectedNamespace ?? undefined)} wallet
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}

      <BaseModal
        visible={isSignStatementVisible}
        onClose={() => setIsSignStatementVisible(false)}
        height="auto"
        borderRadius={28}
        contentClassName="px-6"
      >
        <ModalHeader title="Signing Statement" />
        <View className="bg-white rounded-3xl p-6 shadow-sm mb-5">
          <Text className="text-light-matte-black/70 mb-6 text-center">
            You are about to sign the following message with{" "}
            {selectedWallet?.name || "your wallet"}:
          </Text>
          <View className="bg-light-main-container p-4 rounded-xl mb-6">
            <ScrollView
              showsVerticalScrollIndicator={false}
              className="max-h-96"
            >
              <Text className="text-light-matte-black font-medium">
                {nonceData?.message || "Loading authentication message…"}
              </Text>
            </ScrollView>
          </View>
          <Text className="text-light-matte-black/70">
            Signing this message proves ownership of your wallet address. This
            is a secure operation that does not cost any gas fees.
          </Text>
        </View>
        <View className="flex-row gap-4">
          <Pressable
            className="flex-1 bg-light-main-container py-4 rounded-xl items-center"
            onPress={() => setIsSignStatementVisible(false)}
          >
            <Text className="text-light-matte-black font-bold">Cancel</Text>
          </Pressable>
          <Pressable
            className={`flex-1 py-4 rounded-xl items-center ${
              nonceData?.message
                ? "bg-light-primary-red"
                : "bg-light-primary-red/30"
            }`}
            disabled={!nonceData?.message}
            onPress={() => {
              setIsSignStatementVisible(false);
              setIsSignInPinVisible(true);
            }}
          >
            <Text className="text-white font-bold">Continue</Text>
          </Pressable>
        </View>
      </BaseModal>

      <PinConfirmationModal
        visible={isSignInPinVisible}
        onClose={() => setIsSignInPinVisible(false)}
        onConfirm={() => {
          setIsSignInPinVisible(false);
          handleSignIn();
        }}
        title="Confirm Sign-In"
      />

      <TouchableOpacity
        activeOpacity={0.7}
        className={`py-4 px-5 rounded-xl items-center ${
          createIntent.isPending ||
          !selectedToken ||
          !selectedWallet ||
          !isWalletAuthed ||
          isAmountEmpty ||
          isAmountInvalid ||
          quoteShortfall
            ? "bg-light-matte-black/20"
            : "bg-light-primary-red"
        }`}
        disabled={
          createIntent.isPending ||
          !selectedToken ||
          !selectedWallet ||
          !isWalletAuthed ||
          isAmountEmpty ||
          isAmountInvalid ||
          !!quoteShortfall
        }
        onPress={onMint}
      >
        {createIntent.isPending ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text className="text-light font-semibold">Continue</Text>
        )}
      </TouchableOpacity>

      <WalletSelectorModal
        visible={walletPickerOpen}
        onClose={() => setWalletPickerOpen(false)}
        wallets={eligibleWallets}
        activeWalletIndex={
          selectedWallet
            ? eligibleWallets.findIndex(
                (w) => w.address === selectedWallet.address,
              )
            : -1
        }
        onSelectWallet={(index) => {
          const w = eligibleWallets[index];
          if (w) setSelectedWalletAddr(w.address);
          setWalletPickerOpen(false);
        }}
        title={`Select wallet${selectedChain ? ` (${selectedChain.name})` : ""}`}
      />

      <PickerSheet
        visible={tokenPickerOpen}
        onClose={() => {
          setTokenPickerOpen(false);
          setTokenSearch("");
        }}
        title="Pay with"
        searchQuery={tokenSearch}
        onSearchChange={setTokenSearch}
        searchPlaceholder="Search tokens"
      >
        {!paymentTokens?.length ? (
          <View className="items-center justify-center py-8">
            {isLoadingTokens ? (
              <ActivityIndicator color="#c71c4b" />
            ) : (
              <Text className="text-light-matte-black/60 text-sm text-center">
                No payment tokens available.
              </Text>
            )}
          </View>
        ) : !filteredTokens.length ? (
          <View className="items-center justify-center py-8">
            <Text className="text-light-matte-black/60 text-sm">
              No tokens match &quot;{tokenSearch}&quot;
            </Text>
          </View>
        ) : (
          filteredTokens.map((t) => {
            const active = t.id === selectedToken?.id;
            return (
              <Pressable
                key={t.id}
                onPress={() => {
                  setSelectedToken(t);
                  setTokenPickerOpen(false);
                  setTokenSearch("");
                }}
                className={`flex-row items-center p-4 mb-2 rounded-xl ${
                  active ? "bg-light-primary-red/10" : "bg-light"
                }`}
              >
                {t.logoUrl ? (
                  <OptimizedImage
                    source={{ uri: t.logoUrl }}
                    style={{ width: 36, height: 36, borderRadius: 18 }}
                    containerStyle={{ marginRight: 12 }}
                    contentFit="contain"
                  />
                ) : (
                  <View className="w-9 h-9 bg-light-primary-red/10 rounded-full mr-3" />
                )}
                <View className="flex-1">
                  <Text className="text-light-matte-black font-bold">
                    {t.symbol}
                  </Text>
                  <Text className="text-light-matte-black/60 text-xs">
                    {t.name} · {t.blockchain.name}
                  </Text>
                </View>
                {active ? (
                  <View className="w-6 h-6 rounded-full bg-light-primary-red/10 items-center justify-center">
                    <Check size={14} color="#c71c4b" strokeWidth={3} />
                  </View>
                ) : null}
              </Pressable>
            );
          })
        )}
      </PickerSheet>

      <PickerSheet
        visible={chainPickerOpen}
        onClose={() => {
          setChainPickerOpen(false);
          setChainSearch("");
        }}
        title="Select network"
        searchQuery={chainSearch}
        onSearchChange={setChainSearch}
        searchPlaceholder="Search networks"
      >
        {!availableChains.length ? (
          <View className="items-center justify-center py-8">
            {isLoadingChains ? (
              <ActivityIndicator color="#c71c4b" />
            ) : (
              <Text className="text-light-matte-black/60 text-sm text-center">
                No networks available.
              </Text>
            )}
          </View>
        ) : !filteredChains.length ? (
          <View className="items-center justify-center py-8">
            <Text className="text-light-matte-black/60 text-sm">
              No networks match &quot;{chainSearch}&quot;
            </Text>
          </View>
        ) : (
          filteredChains.map((b) => {
            const active = b.id === selectedChainId;
            const nativeToken =
              b.tokens?.find((t) => t.isNativeCurrency) ?? b.tokens?.[0];
            return (
              <Pressable
                key={b.id}
                onPress={() => {
                  setSelectedChainId(b.id);
                  setChainPickerOpen(false);
                  setChainSearch("");
                }}
                className={`flex-row items-center p-4 mb-2 rounded-xl ${
                  active ? "bg-light-primary-red/10" : "bg-light"
                }`}
              >
                {nativeToken?.logoUrl ? (
                  <OptimizedImage
                    source={{ uri: nativeToken.logoUrl }}
                    style={{ width: 36, height: 36, borderRadius: 18 }}
                    containerStyle={{ marginRight: 12 }}
                    contentFit="contain"
                  />
                ) : (
                  <View className="w-9 h-9 bg-light-primary-red/10 rounded-full mr-3" />
                )}
                <View className="flex-1">
                  <Text className="text-light-matte-black font-bold">
                    {b.name}
                  </Text>
                  <Text className="text-light-matte-black/60 text-xs">
                    {nativeToken?.symbol ??
                      chainBadgeLabel(resolveNamespace(b))}
                  </Text>
                </View>
                {b.isTestnet ? (
                  <View className="bg-yellow-500/20 px-2 py-1 rounded-full mr-2">
                    <Text className="text-yellow-700 text-xs font-medium">
                      Testnet
                    </Text>
                  </View>
                ) : null}
                {active ? (
                  <View className="w-6 h-6 rounded-full bg-light-primary-red/10 items-center justify-center">
                    <Check size={14} color="#c71c4b" strokeWidth={3} />
                  </View>
                ) : null}
              </Pressable>
            );
          })
        )}
      </PickerSheet>
    </View>
  );
}

/** ── shared bottom-sheet shell ──────────────────────────────────────── */

/**
 * Slide-up bottom sheet for the chain / token pickers. Mirrors the
 * animation + chrome of `components/common/ChainSelector.tsx` so the
 * pay-merchant pickers feel native to the rest of the app: dim overlay
 * fade, translate-Y slide, drag handle, swipe-down to dismiss, search
 * row. Render-time visibility is gated on `visible` so the modal mounts
 * fresh each open and the entry animation always plays.
 */
function PickerSheet({
  visible,
  onClose,
  title,
  searchQuery,
  onSearchChange,
  searchPlaceholder,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  searchPlaceholder: string;
  children: React.ReactNode;
}) {
  return (
    <BaseModal visible={visible} onClose={onClose} contentClassName="px-6">
      <ModalHeader title={title} />

      <View className="flex-row items-center bg-light rounded-2xl px-3 py-2 mb-3">
        <Search size={16} color="#20222c80" />
        <TextInput
          value={searchQuery}
          onChangeText={onSearchChange}
          placeholder={searchPlaceholder}
          placeholderTextColor="#20222c80"
          autoCorrect={false}
          autoCapitalize="none"
          className="flex-1 ml-2 text-light-matte-black"
        />
        {searchQuery.length > 0 ? (
          <Pressable onPress={() => onSearchChange("")} hitSlop={8}>
            <X size={14} color="#20222c80" />
          </Pressable>
        ) : null}
      </View>

      <ScrollView
        style={{ maxHeight: SHEET_SCROLL_MAX_HEIGHT }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 24 }}
      >
        {children}
      </ScrollView>
    </BaseModal>
  );
}

/** ── UI cards ───────────────────────────────────────────────────────── */

function LoadingCard({ intentId }: { intentId: string }) {
  return (
    <View className="bg-light rounded-3xl p-6 shadow-md-">
      <View className="flex-row items-center mb-4">
        <View className="w-11 h-11 bg-light-primary-red/10 rounded-full items-center justify-center mr-3">
          <Store color="#c71c4b" size={20} />
        </View>
        <Text className="text-light-matte-black font-semibold text-base">
          Loading payment…
        </Text>
      </View>
      <View className="flex-row items-center">
        <ActivityIndicator size="small" color="#c71c4b" />
        <Text className="text-light-matte-black/60 text-sm ml-2">
          Fetching quote
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

function QuoteCard({
  intent,
  phase,
  merchantName: merchantNameParam,
  onPay,
}: {
  intent: PaymentIntentResponse;
  phase: LocalPhase;
  merchantName?: string;
  onPay: () => void;
}) {
  const isBusy = phase === "signing" || phase === "submitting";
  const ctaLabel =
    phase === "signing"
      ? "Confirming…"
      : phase === "submitting"
        ? "Submitting…"
        : `Pay ${formatIdrMinor(extractFiatMinor(intent))}`;

  return (
    <View className="bg-light rounded-3xl p-6 shadow-md-">
      <View className="flex-row items-center mb-5">
        <View className="w-11 h-11 bg-light-primary-red/10 rounded-full items-center justify-center mr-3">
          <Store color="#c71c4b" size={20} />
        </View>
        <View className="flex-1">
          <Text className="text-light-matte-black font-semibold text-base">
            {extractMerchantName(intent, merchantNameParam)}
          </Text>
          <Text className="text-light-matte-black/50 text-xs">
            Confirm to pay
          </Text>
        </View>
      </View>

      <View className="bg-light-main-container rounded-xl p-4 mb-6">
        <Text className="text-light-matte-black/50 text-xs mb-1">Amount</Text>
        <Text className="text-light-matte-black text-3xl font-bold">
          {formatIdrMinor(extractFiatMinor(intent))}
        </Text>
        <Text className="text-light-matte-black/60 text-sm mt-2">
          ~{formatUsdcMicros(intent.nanopayUsdcAmountMicros)} from your balance
        </Text>
      </View>

      {phase === "submitting" ? (
        <View className="flex-row items-center justify-center mb-4">
          <ActivityIndicator size="small" color="#c71c4b" />
          <Text className="text-light-matte-black/60 text-sm ml-2">
            Submitting to Circle…
          </Text>
        </View>
      ) : null}

      <TouchableOpacity
        activeOpacity={0.7}
        className={`py-4 px-5 rounded-xl items-center ${
          isBusy ? "bg-light-matte-black/20" : "bg-light-primary-red"
        }`}
        disabled={isBusy}
        onPress={onPay}
      >
        {isBusy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text className="text-light font-semibold">{ctaLabel}</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

/**
 * Transient "paid" loader — the `IntentFlow` effect navigates to
 * `/pay-merchant/receipt` the moment `intent.status === "paid"`, but
 * React commits this render first. Keep the UI on-brand during that
 * ~1-frame window rather than flashing the quote card or a blank
 * screen. All the actual receipt rendering lives in
 * `app/pay-merchant/receipt.tsx`.
 */
/**
 * Inline "this wallet can't pay this" strip for the quote and confirm
 * cards. Shown INSTEAD of letting the button open the PIN: when the
 * balances on screen already answer the question, asking the user to
 * confirm and then failing is the worst version of "no". Same copy as
 * the full-screen error, minus the button — the fix (another wallet or
 * token) is on this very screen.
 */
function BalanceShortfallNotice({
  code,
  context,
}: {
  code: "insufficient_funds" | "insufficient_fee";
  context: PaymentErrorContext;
}) {
  const copy = resolvePaymentErrorCopy(code, context);
  return (
    <View className="flex-row items-start bg-amber-50 rounded-xl px-4 py-3 mb-4">
      <AlertCircle color="#d97706" size={20} />
      <View className="flex-1 ml-3">
        <Text className="text-amber-900 font-semibold text-sm">
          {copy.title}
        </Text>
        <Text className="text-amber-800 text-xs leading-5 mt-0.5">
          {copy.body}
        </Text>
      </View>
    </View>
  );
}

function PaidCard() {
  return (
    <View className="bg-light rounded-3xl p-6 shadow-md-">
      <View className="items-center">
        <View className="w-14 h-14 bg-green-100 rounded-full items-center justify-center mb-3">
          <CheckCircle2 color="#16a34a" size={32} />
        </View>
        <Text className="text-light-matte-black font-bold text-xl">Paid</Text>
        <View className="flex-row items-center mt-3">
          <ActivityIndicator size="small" color="#c71c4b" />
          <Text className="text-light-matte-black/60 text-sm ml-2">
            Opening receipt…
          </Text>
        </View>
      </View>
    </View>
  );
}

function MissingIntentCard() {
  return (
    <View className="bg-light rounded-3xl p-6 shadow-md-">
      <Text className="text-light-matte-black font-semibold text-base mb-2">
        Missing intent
      </Text>
      <Text className="text-light-matte-black/60 text-sm mb-6">
        We couldn&apos;t find a payment intent for this link. Scan a merchant QR
        or open a valid payment link to continue.
      </Text>
      <TouchableOpacity
        activeOpacity={0.7}
        className="bg-light-primary-red py-4 px-5 rounded-xl items-center"
        onPress={() => router.back()}
      >
        <Text className="text-light font-semibold">Back</Text>
      </TouchableOpacity>
    </View>
  );
}

/** ── intent-shape helpers ───────────────────────────────────────────── */

/**
 * Merchant display name. The M2 intent schema doesn't guarantee a
 * merchant field (task 27 `GET /v1/merchants/:id` is a follow-up) —
 * we duck-check a few likely fields so the UI lights up whenever the
 * backend starts populating one, and fall back to "Merchant" otherwise.
 */
function extractMerchantName(
  intent: PaymentIntentResponse,
  fallback?: string,
): string {
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
}

/**
 * Settlement path selector — `"A"` for direct-on-Arc, `"B"` / `"C"` for
 * Circle Nanopayments / raw x402. The server sets this on the intent
 * (task 41 owns the selector logic); mobile presence-reads to pick a
 * render branch. Duck-checked because the M2 `types.ts` doesn't pin
 * this field yet — task 40 ships the mobile render ahead of the type
 * update so the two PRs can land independently.
 */
function extractIntentPath(
  intent: PaymentIntentResponse,
): "A" | "B" | "C" | "takumipay" | null {
  const anyIntent = intent as unknown as {
    path?: string;
    settlementPath?: string;
  };
  const raw = anyIntent.path ?? anyIntent.settlementPath;
  if (raw === "A" || raw === "B" || raw === "C") return raw;
  if (raw === "takumipay") return "takumipay";
  return null;
}

/**
 * Source-of-truth fiat amount shown to the user. The M2 shape in
 * `types.ts` doesn't pin this field (task 23 backend is still
 * iterating), so we duck-check for a few likely locations. Returns 0
 * when nothing is available — that's a visible "Rp 0" which will
 * surface the upstream contract gap loudly rather than silently.
 */
function extractFiatMinor(intent: PaymentIntentResponse): number {
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
}
