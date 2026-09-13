/**
 * `/pay-x402` — Path C (raw x402 against an arbitrary merchant) scan-
 * to-pay screen (spec §5.3, milestone M5, task 39).
 *
 * Unlike `/pay-merchant` (Path B), Path C has no server intent. The
 * merchant's OWN server is the authoritative endpoint: we fetch the
 * resource URL, parse the 402 challenge, sign an EIP-3009 authorization,
 * and POST it back with header `X-PAYMENT`. The merchant — or a
 * facilitator the merchant names — settles. Our backend is NOT in the
 * loop (three-role separation, memory `feedback_role_separation.md`).
 *
 * Copy audience (post-auth, payer-facing): show the USDC amount and
 * the merchant host. No chain ids, no internal terms. Matches the
 * payer-vs-merchant copy rule the spec pins for the Path B screen.
 *
 * Chain-extension discipline: the 402 challenge carries the chain id
 * — we resolve the matching `ChainConfig` from `supportedChains`. No
 * `if (chainId === X)` branching here or in the service module.
 *
 * Nonce discipline: NO caching of the 402 challenge. We fetch fresh on
 * mount and on every retry — the nonce is single-use.
 */

import { router, useLocalSearchParams } from "expo-router";
import { ArrowLeft, CheckCircle2, Globe } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import { SafeAreaView } from "react-native-safe-area-context";
import { formatUnits } from "viem";
import { findEvmChainById } from "@/constants/configs/chainConfig";
import { useWallet } from "@/hooks/useWallet";
import {
  executePathC,
  parseX402Challenge,
  type X402Challenge,
  X402ChallengeParseError,
  X402FetchError,
} from "@/services/nanopay/pathCRawX402";
import { getEvmChainId } from "@/services/walletKit/chainInfo";

const USDC_DECIMALS = 6;

type Phase =
  | "probing" // fetching + parsing the 402 challenge
  | "ready" // challenge in hand, waiting on the user's Pay tap
  | "signing" // wallet is signing the EIP-3009 authorization
  | "submitting" // POSTing back the signed envelope
  | "paid" // merchant returned 200 (or 202→200 after poll)
  | "error";

interface ErrorState {
  title: string;
  detail?: string;
}

/**
 * Trim a resource URL to just `host[:port]` for the header display.
 * We intentionally strip paths and query strings — those often leak
 * session ids. Host + TLS is the trust signal payers can verify.
 */
function extractHost(resourceUrl: string): string {
  try {
    const u = new URL(resourceUrl);
    return u.host;
  } catch {
    return resourceUrl;
  }
}

function formatUsdcMicros(micros: string): string {
  try {
    const whole = formatUnits(BigInt(micros), USDC_DECIMALS);
    const n = parseFloat(whole);
    if (!Number.isFinite(n)) return `${whole} USDC`;
    return `${n.toFixed(n < 1 ? 4 : 2)} USDC`;
  } catch {
    return `${micros} µUSDC`;
  }
}

export default function PayX402() {
  const params = useLocalSearchParams<{ resourceUrl?: string }>();
  const resourceUrl =
    typeof params.resourceUrl === "string" ? params.resourceUrl : undefined;

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
            <ArrowLeft color="#20222c" size={24} />
          </Pressable>
          <Text className="text-light-matte-black text-lg font-bold">
            Pay resource
          </Text>
        </View>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{ padding: 20, paddingBottom: 32 }}
          showsVerticalScrollIndicator={false}
        >
          {resourceUrl ? (
            <PathCFlow resourceUrl={resourceUrl} />
          ) : (
            <MissingResourceCard />
          )}
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

function PathCFlow({ resourceUrl }: { resourceUrl: string }) {
  const {
    activeWallet,
    activeChain,
    getActiveWalletKit,
    changeActiveChainToConfig,
  } = useWallet();
  const [phase, setPhase] = useState<Phase>("probing");
  const [challenge, setChallenge] = useState<X402Challenge | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [settlementRef, setSettlementRef] = useState<string | undefined>(
    undefined,
  );

  // Fetch + parse the 402 challenge on mount (no caching — the nonce is
  // single-use, so each visit to this screen pulls a fresh challenge).
  useEffect(() => {
    let cancelled = false;
    setPhase("probing");
    setError(null);
    (async () => {
      try {
        const response = await fetch(resourceUrl, { method: "GET" });
        if (response.status !== 402) {
          throw new X402FetchError({
            status: response.status,
            message: `Expected 402 Payment Required, got ${response.status}`,
          });
        }
        const parsed = await parseX402Challenge(response, resourceUrl);
        if (cancelled) return;
        setChallenge(parsed);
        setPhase("ready");
      } catch (err) {
        if (cancelled) return;
        setError(mapError(err));
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resourceUrl]);

  const onPay = useCallback(async () => {
    if (!challenge) return;
    const kit = activeWallet?.namespace ? getActiveWalletKit() : null;
    if (!kit || typeof kit.signTransferWithAuthorization !== "function") {
      setError({
        title: "Wallet doesn't support this payment",
        detail: "Switch to an EVM wallet and try again.",
      });
      setPhase("error");
      return;
    }

    // Pre-flight chain switch — the authorization is bound to the
    // chain id in the 402 challenge. We resolve the matching config
    // from `supportedChains` so the user signs against the right
    // network. No `if (chainId === X)` branching.
    const targetChain = findEvmChainById(challenge.extra.chainId);
    if (!targetChain) {
      setError({
        title: "Unsupported network",
        detail:
          "This resource asked for a chain your wallet doesn't have configured.",
      });
      setPhase("error");
      return;
    }
    const activeEvmId = getEvmChainId(activeChain) ?? null;
    if (activeEvmId !== targetChain.chain.id) {
      const ok = await changeActiveChainToConfig(targetChain);
      if (!ok) {
        setError({
          title: "Couldn't switch network",
          detail: "Try again or switch manually from the wallet screen.",
        });
        setPhase("error");
        return;
      }
    }

    try {
      setPhase("signing");
      setError(null);
      // Single call into the service — it does the 402 → sign → POST
      // → (optional) poll handshake. We don't re-probe the URL here
      // since the service fetches fresh internally; handing the URL
      // is enough.
      const result = await executePathC({
        resourceUrl,
        wallet: activeWallet,
        chain: targetChain,
        kit,
      });
      if (result.status === "paid") {
        setSettlementRef(result.settlementRef);
        setPhase("paid");
      } else {
        setError({
          title: "Payment not confirmed",
          detail: result.reason,
        });
        setPhase("error");
      }
    } catch (err) {
      setError(mapError(err));
      setPhase("error");
    }
  }, [
    activeChain,
    activeWallet,
    challenge,
    changeActiveChainToConfig,
    getActiveWalletKit,
    resourceUrl,
  ]);

  if (phase === "probing") {
    return <ProbingCard host={extractHost(resourceUrl)} />;
  }
  if (phase === "paid") {
    return <PaidCard settlementRef={settlementRef} />;
  }
  if (phase === "error" && error) {
    return <ErrorCard error={error} onRetry={() => router.back()} />;
  }
  if (!challenge) {
    return <ProbingCard host={extractHost(resourceUrl)} />;
  }
  return (
    <QuoteCard
      host={extractHost(resourceUrl)}
      challenge={challenge}
      phase={phase}
      onPay={onPay}
    />
  );
}

/** Maps service errors to the payer-facing copy table. No hex / no chain ids. */
function mapError(err: unknown): ErrorState {
  if (err instanceof X402FetchError) {
    return {
      title: "Couldn't reach this resource",
      detail: `The merchant returned ${err.status ?? "an error"}. Try again.`,
    };
  }
  if (err instanceof X402ChallengeParseError) {
    return {
      title: "This resource doesn't speak x402",
      detail: "Ask the merchant to check their payment setup and try again.",
    };
  }
  // AuthorizationValidityTooShortError, signing cancellation, generic errors.
  const name =
    err && typeof err === "object" && "name" in err
      ? (err as { name?: string }).name
      : undefined;
  if (name === "AuthorizationValidityTooShortError") {
    return {
      title: "Quote expired",
      detail: "The merchant's payment window is too short. Ask them to retry.",
    };
  }
  return {
    title: "Payment failed",
    detail: "Something went wrong. Please try again.",
  };
}

/** ── UI cards ───────────────────────────────────────────────────────── */

function ProbingCard({ host }: { host: string }) {
  return (
    <View className="bg-light rounded-3xl p-6 shadow-md-">
      <View className="flex-row items-center mb-4">
        <View className="w-11 h-11 bg-light-primary-red/10 rounded-full items-center justify-center mr-3">
          <Globe color="#c71c4b" size={20} />
        </View>
        <Text className="text-light-matte-black font-semibold text-base">
          Loading payment…
        </Text>
      </View>
      <View className="flex-row items-center">
        <ActivityIndicator size="small" color="#c71c4b" />
        <Text className="text-light-matte-black/60 text-sm ml-2">
          Fetching quote from {host}
        </Text>
      </View>
    </View>
  );
}

function QuoteCard({
  host,
  challenge,
  phase,
  onPay,
}: {
  host: string;
  challenge: X402Challenge;
  phase: Phase;
  onPay: () => void;
}) {
  const isBusy = phase === "signing" || phase === "submitting";
  const ctaLabel =
    phase === "signing"
      ? "Confirming…"
      : phase === "submitting"
        ? "Submitting…"
        : `Pay ${formatUsdcMicros(challenge.maxAmountRequired)}`;
  return (
    <View className="bg-light rounded-3xl p-6 shadow-md-">
      <View className="flex-row items-center mb-5">
        <View className="w-11 h-11 bg-light-primary-red/10 rounded-full items-center justify-center mr-3">
          <Globe color="#c71c4b" size={20} />
        </View>
        <View className="flex-1">
          <Text className="text-light-matte-black font-semibold text-base">
            {host}
          </Text>
          <Text className="text-light-matte-black/50 text-xs">
            Confirm to pay this resource
          </Text>
        </View>
      </View>

      <View className="bg-light-main-container rounded-xl p-4 mb-6">
        <Text className="text-light-matte-black/50 text-xs mb-1">Amount</Text>
        <Text className="text-light-matte-black text-3xl font-bold">
          {formatUsdcMicros(challenge.maxAmountRequired)}
        </Text>
        <Text className="text-light-matte-black/60 text-sm mt-2">
          From your USDC balance
        </Text>
      </View>

      {phase === "submitting" ? (
        <View className="flex-row items-center justify-center mb-4">
          <ActivityIndicator size="small" color="#c71c4b" />
          <Text className="text-light-matte-black/60 text-sm ml-2">
            Submitting payment…
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

function PaidCard({ settlementRef }: { settlementRef?: string }) {
  return (
    <View className="bg-light rounded-3xl p-6 shadow-md-">
      <View className="items-center">
        <View className="w-14 h-14 bg-green-100 rounded-full items-center justify-center mb-3">
          <CheckCircle2 color="#16a34a" size={32} />
        </View>
        <Text className="text-light-matte-black font-bold text-xl">Paid</Text>
        <Text className="text-light-matte-black/60 text-sm mt-2 text-center">
          The merchant has confirmed your payment.
        </Text>
        {settlementRef ? (
          <Text
            className="text-light-matte-black/40 text-xs mt-3 font-mono"
            selectable
          >
            {settlementRef}
          </Text>
        ) : null}
      </View>
      <TouchableOpacity
        activeOpacity={0.7}
        className="bg-light-primary-red py-4 px-5 rounded-xl items-center mt-6"
        onPress={() => router.back()}
      >
        <Text className="text-light font-semibold">Done</Text>
      </TouchableOpacity>
    </View>
  );
}

function ErrorCard({
  error,
  onRetry,
}: {
  error: ErrorState;
  onRetry: () => void;
}) {
  return (
    <View className="bg-light rounded-3xl p-6 shadow-md-">
      <Text className="text-light-matte-black font-semibold text-base mb-2">
        {error.title}
      </Text>
      {error.detail ? (
        <Text className="text-light-matte-black/60 text-sm mb-6">
          {error.detail}
        </Text>
      ) : null}
      <TouchableOpacity
        activeOpacity={0.7}
        className="bg-light-primary-red py-4 px-5 rounded-xl items-center"
        onPress={onRetry}
      >
        <Text className="text-light font-semibold">Back</Text>
      </TouchableOpacity>
    </View>
  );
}

function MissingResourceCard() {
  return (
    <View className="bg-light rounded-3xl p-6 shadow-md-">
      <Text className="text-light-matte-black font-semibold text-base mb-2">
        Missing resource URL
      </Text>
      <Text className="text-light-matte-black/60 text-sm mb-6">
        We couldn&apos;t find a payment target for this link. Scan or paste an
        x402 payment URL to continue.
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
