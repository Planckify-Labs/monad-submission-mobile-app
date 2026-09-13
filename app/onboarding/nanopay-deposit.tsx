/**
 * `/onboarding/nanopay-deposit` — one-time Circle GatewayWallet deposit
 * screen. Payer-facing M4 onboarding surface (spec §5.2 step 1, §5.4
 * gasless summary, §9.1 `REQUIRES_DEPOSIT` / `DEPOSIT_PENDING_ATTESTATION`
 * / `DEPOSIT_FAILED`, milestone M4).
 *
 * After this single deposit, every subsequent scan-to-pay is
 * signing-only — no gas, no on-chain wait from the user's side.
 *
 * Three-role separation (memory `feedback_role_separation.md`):
 *   - The screen signs (via `WalletKitAdapter.sendUserOpWithUsdcPaymaster`).
 *   - The task-37 bundler proxy forwards on-chain submission.
 *   - The task-38 `/v1/pay/intents/:id/deposit-receipt` endpoint records
 *     the receipt and polls Circle for attestation.
 *
 * Chain-extension discipline (memory `feedback_chain_extension_discipline.md`):
 * the chain picker is keyed off presence of `row.gateway` + `row.paymaster`
 * + `row.usdc` on the enriched `/v1/blockchains` row — NO
 * `if (namespace === "X")` branches. Chains without a Paymaster
 * deployment are filtered out of the picker at the hook layer.
 *
 * Copy-audience rule: payer-facing. USDC / wallet / gasless is OK;
 * "UserOp" / "bundler" / "nonce" / "permit" are not. All error strings
 * flow through `<PaymentError>` via `services/errors/paymentErrors.ts`.
 *
 * No-force: "Skip for now" returns the user to `/pay-merchant` (if an
 * intent was passed) or home — Path A (direct-on-Arc, task 40) remains
 * available without a deposit. Task 41's path selector dispatches.
 *
 * Onboarding completion marker: on first successful (even
 * `PENDING_ATTESTATION`) deposit we set a boolean in MMKV via
 * `useRQGlobalState` so the standalone entrypoint on home (task 41)
 * hides the "Set up gasless payments" CTA on return visits.
 */

import { router, useLocalSearchParams } from "expo-router";
import { ArrowLeft, CheckCircle2, Sparkles, Wallet } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import { SafeAreaView } from "react-native-safe-area-context";
import { erc20Abi, formatUnits, parseUnits } from "viem";
import type { TBlockchain } from "@/api/types/blockchain";
import { PaymentError } from "@/components/PaymentError";
import { findEvmChainById } from "@/constants/configs/chainConfig";
import { useBlockchainsWithStorage } from "@/hooks/useBlockchainsWithStorage";
import useRQGlobalState from "@/hooks/useRQGlobalState";
import { useWallet } from "@/hooks/useWallet";
import {
  classifyPaymentError,
  type PaymentErrorCode,
} from "@/services/errors/paymentErrors";
import { useDepositForPaymaster } from "@/services/nanopay/useGatewayDeposit";
import { getPublicClient } from "@/utils/clients";

/**
 * MMKV-backed "is deposit recorded" flag. Backed by `useRQGlobalState`
 * so the home screen and path selector (task 41) read the same cache
 * slot. Set to `true` on first successful `depositAndRecordReceipt` —
 * even `PENDING_ATTESTATION` counts, since the on-chain row has landed
 * and Circle will converge the attestation state.
 */
const NANOPAY_DEPOSIT_COMPLETE_KEY = ["onboarding", "nanopay-deposit-complete"];

/** USDC is 6-decimal on every Gateway-supported chain (§6.7 usdc.decimals). */
const USDC_DECIMALS = 6;

/**
 * Minimum sensible first deposit. 10 USDC matches the service-level
 * paymaster approve cap (`DEFAULT_PAYMASTER_APPROVE_MICROS` in
 * `gatewayDeposit.ts`) so the default flow leaves room for the
 * paymaster pull + a small first payment.
 */
const DEFAULT_DEPOSIT_USDC = "10";

/**
 * Deposit-capable row shape — narrowed so every chain field the screen
 * hands to `useDepositForPaymaster` is non-null. Prevents the mutation
 * call site from repeating null checks.
 */
interface DepositCapableChain {
  id: string;
  name: string;
  chainId: number;
  gatewayWalletAddress: `0x${string}`;
  paymasterAddress: `0x${string}`;
  usdcTokenAddress: `0x${string}`;
  usdcDecimals: number;
}

/**
 * Multi-step progress state. Matches §9.1's
 * `DEPOSIT_PENDING_ATTESTATION` phase labels but framed in payer-
 * friendly copy ("Preparing…", "Confirming…") instead of
 * "submitting UserOp to bundler".
 */
type DepositStep =
  | "idle"
  | "preparing" // adapter sign + UserOp build
  | "submitting" // bundler in flight
  | "recording" // /deposit-receipt POST
  | "done"
  | "error";

interface LocalError {
  code: PaymentErrorCode;
  devMessage?: string;
}

/** Chain-extension discipline (hook-level filter, memory `feedback_filter_at_source.md`). */
function selectDepositCapableChains(
  rows: TBlockchain[] | undefined,
): DepositCapableChain[] {
  if (!rows) return [];
  const out: DepositCapableChain[] = [];
  for (const row of rows) {
    if (!row.isActive || !row.isEVM) continue;
    const chainId = row.chainId;
    if (typeof chainId !== "number") continue;
    const gateway = row.gateway?.walletContract;
    const paymaster = row.paymaster?.address;
    const usdc = row.usdc?.address;
    const usdcDecimals = row.usdc?.decimals ?? USDC_DECIMALS;
    if (!gateway || !paymaster || !usdc) continue;
    out.push({
      id: row.id,
      name: row.name,
      chainId,
      gatewayWalletAddress: gateway as `0x${string}`,
      paymasterAddress: paymaster as `0x${string}`,
      usdcTokenAddress: usdc as `0x${string}`,
      usdcDecimals,
    });
  }
  return out;
}

function classifyError(err: unknown): LocalError {
  const code = classifyPaymentError(err);
  const devMessage =
    err && typeof err === "object" && "message" in err
      ? typeof (err as { message?: unknown }).message === "string"
        ? ((err as { message?: string }).message as string)
        : undefined
      : typeof err === "string"
        ? err
        : undefined;
  return { code, devMessage };
}

/**
 * Bundler URL = task-37 proxy on `takumipay-api`. Mobile never sees
 * Pimlico / Alchemy URLs (spec §5.5, §10). The chainId is attached as
 * a query param so the proxy can route to the correct per-chain
 * bundler credential without the mobile client holding one.
 */
function buildBundlerUrl(chainId: number): string {
  const base = process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";
  return `${base}/v1/userop/submit?chainId=${chainId}`;
}

export default function NanopayDepositScreen() {
  const params = useLocalSearchParams<{ intentId?: string }>();
  const intentId =
    typeof params.intentId === "string" && params.intentId.length > 0
      ? params.intentId
      : undefined;

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
            Set up gasless payments
          </Text>
        </View>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{ padding: 20, paddingBottom: 32 }}
          showsVerticalScrollIndicator={false}
        >
          <DepositFlow intentId={intentId} />
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

function DepositFlow({ intentId }: { intentId?: string }) {
  const { activeWallet, getActiveWalletKit } = useWallet();
  const { data: blockchains, isLoading: chainsLoading } =
    useBlockchainsWithStorage({ isActive: true });
  const depositMutation = useDepositForPaymaster();
  const { setNewData: setOnboardingComplete } = useRQGlobalState<boolean>({
    queryKey: NANOPAY_DEPOSIT_COMPLETE_KEY,
    initialData: false,
  });

  const depositChains = useMemo(
    () => selectDepositCapableChains(blockchains as TBlockchain[]),
    [blockchains],
  );

  const [selectedChainId, setSelectedChainId] = useState<number | null>(null);
  const [amountInput, setAmountInput] = useState<string>(DEFAULT_DEPOSIT_USDC);
  const [step, setStep] = useState<DepositStep>("idle");
  const [error, setError] = useState<LocalError | null>(null);

  // Default the picker to the first deposit-capable chain once the
  // enriched catalogue lands. Explicit selection lives in local state so
  // the user can flip Base ↔ Arbitrum without us overwriting it.
  useEffect(() => {
    if (selectedChainId !== null) return;
    if (depositChains.length === 0) return;
    setSelectedChainId(depositChains[0].chainId);
  }, [depositChains, selectedChainId]);

  const selectedChain = useMemo(
    () => depositChains.find((c) => c.chainId === selectedChainId) ?? null,
    [depositChains, selectedChainId],
  );

  const { data: usdcBalanceMicros } = useUsdcBalance(
    selectedChain,
    activeWallet?.address,
  );

  const onDeposit = useCallback(async () => {
    setError(null);

    if (!activeWallet?.address || !activeWallet?.namespace) {
      setError({ code: "wallet_unsupported" });
      setStep("error");
      return;
    }
    if (!selectedChain) {
      setError({ code: "unknown", devMessage: "No chain selected" });
      setStep("error");
      return;
    }

    // Presence-of-method dispatch: adapters lacking paymaster UserOp
    // support (Solana) leave the method undefined. No namespace branches.
    const kit = getActiveWalletKit();
    if (typeof kit.sendUserOpWithUsdcPaymaster !== "function") {
      setError({ code: "wallet_unsupported" });
      setStep("error");
      return;
    }

    const chainConfig = findEvmChainById(selectedChain.chainId);
    if (!chainConfig) {
      setError({
        code: "chain_mismatch",
        devMessage: `No chain config for id=${selectedChain.chainId}`,
      });
      setStep("error");
      return;
    }

    let usdcAmount: bigint;
    try {
      const trimmed = (amountInput ?? "").trim();
      if (!trimmed) throw new Error("Enter an amount");
      usdcAmount = parseUnits(trimmed, selectedChain.usdcDecimals);
      if (usdcAmount <= 0n) throw new Error("Amount must be > 0");
    } catch (err) {
      setError(classifyError(err));
      setStep("error");
      return;
    }

    // Entry-point gating: for the M4 receipt endpoint to correlate, we
    // need an intentId. When the user reached this screen via the
    // standalone "Set up gasless payments" CTA (no pending payment),
    // the receipt POST still needs a row to hang the deposit off —
    // task 38 accepts a placeholder. Until that lands, we require an
    // intentId and surface a typed error otherwise.
    if (!intentId) {
      setError({
        code: "unknown",
        devMessage:
          "Standalone onboarding deposit (no pending intent) not yet wired — task 41 will navigate here with intentId.",
      });
      setStep("error");
      return;
    }

    try {
      setStep("preparing");
      // The mutation handles sign → submit → record. We flip `step`
      // optimistically for the UX progress bar; the underlying service
      // is atomic from the screen's vantage.
      setStep("submitting");
      const result = await depositMutation.mutateAsync({
        wallet: activeWallet,
        chain: chainConfig,
        payer: activeWallet.address as `0x${string}`,
        usdcTokenAddress: selectedChain.usdcTokenAddress,
        usdcAmount,
        gatewayWalletAddress: selectedChain.gatewayWalletAddress,
        paymasterAddress: selectedChain.paymasterAddress,
        bundlerUrl: buildBundlerUrl(selectedChain.chainId),
        intentId,
        walletKit: kit,
      });

      setStep("recording");
      // Even PENDING_ATTESTATION counts as "onboarded" — the on-chain
      // row has landed; Circle will converge on CONFIRMED via poll.
      if (result.status !== "FAILED") {
        setOnboardingComplete(true);
      }
      setStep("done");
    } catch (err) {
      setError(classifyError(err));
      setStep("error");
    }
  }, [
    activeWallet,
    amountInput,
    depositMutation,
    getActiveWalletKit,
    intentId,
    selectedChain,
    setOnboardingComplete,
  ]);

  const onSkip = useCallback(() => {
    // No-force rule: user can always pay via Path A (direct-on-Arc)
    // without a Gateway deposit. Task 41 handles dispatch at pay time.
    if (intentId) {
      router.replace({
        pathname: "/pay-merchant" as "/send",
        params: { intentId },
      });
    } else {
      router.back();
    }
  }, [intentId]);

  const onDone = useCallback(() => {
    if (intentId) {
      router.replace({
        pathname: "/pay-merchant" as "/send",
        params: { intentId },
      });
    } else {
      router.replace("/");
    }
  }, [intentId]);

  if (chainsLoading && depositChains.length === 0) {
    return <LoadingCard />;
  }

  if (step === "error" && error) {
    const resetToIdle = () => {
      setError(null);
      setStep("idle");
    };
    return (
      <PaymentError
        code={error.code}
        devMessage={error.devMessage}
        intentId={intentId}
        onRetry={resetToIdle}
        onBack={onSkip}
        onRescan={onSkip}
        onTopUp={resetToIdle}
      />
    );
  }

  if (step === "done") {
    return <DoneCard onContinue={onDone} />;
  }

  if (depositChains.length === 0) {
    // No chains expose the gateway + paymaster + usdc triple — backend
    // hasn't seeded Base / Arbitrum yet, or the enriched endpoint
    // hasn't landed. Surface as `deposit_required` copy so we stay in
    // the shared error matrix rather than inventing a local string.
    return (
      <PaymentError
        code="deposit_required"
        devMessage="No deposit-capable chains surfaced by /v1/blockchains yet."
        onBack={onSkip}
        onRetry={onSkip}
      />
    );
  }

  const isBusy =
    step === "preparing" || step === "submitting" || step === "recording";

  return (
    <View className="gap-4">
      <IntroCard />

      <ChainPicker
        chains={depositChains}
        selectedChainId={selectedChainId}
        onSelect={setSelectedChainId}
        disabled={isBusy}
      />

      <BalanceCard chain={selectedChain} balanceMicros={usdcBalanceMicros} />

      <AmountInputCard
        amount={amountInput}
        onChange={setAmountInput}
        symbol={selectedChain?.name ? "USDC" : "USDC"}
        disabled={isBusy}
      />

      {isBusy ? <DepositProgress step={step} /> : null}

      <TouchableOpacity
        activeOpacity={0.7}
        className={`py-4 px-5 rounded-xl items-center ${
          isBusy ? "bg-light-matte-black/20" : "bg-light-primary-red"
        }`}
        disabled={isBusy}
        onPress={onDeposit}
      >
        {isBusy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text className="text-light font-semibold">Deposit USDC</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity
        activeOpacity={0.7}
        className="py-3 px-5 rounded-xl items-center"
        disabled={isBusy}
        onPress={onSkip}
      >
        <Text className="text-light-matte-black/60 font-medium">
          Skip for now
        </Text>
      </TouchableOpacity>
    </View>
  );
}

/** ── sub-components ─────────────────────────────────────────────────── */

function IntroCard() {
  return (
    <View className="bg-light rounded-3xl p-6 shadow-md-">
      <View className="flex-row items-center mb-3">
        <View className="w-11 h-11 bg-light-primary-red/10 rounded-full items-center justify-center mr-3">
          <Sparkles color="#c71c4b" size={20} />
        </View>
        <Text className="text-light-matte-black font-bold text-lg">
          One-time setup
        </Text>
      </View>
      <Text className="text-light-matte-black/70 text-sm leading-5">
        Deposit USDC once to enable gasless payments. After this, every payment
        is instant — no fees, no confirmations.
      </Text>
    </View>
  );
}

function ChainPicker({
  chains,
  selectedChainId,
  onSelect,
  disabled,
}: {
  chains: DepositCapableChain[];
  selectedChainId: number | null;
  onSelect: (chainId: number) => void;
  disabled: boolean;
}) {
  return (
    <View className="bg-light rounded-3xl p-5 shadow-md-">
      <Text className="text-light-matte-black/60 text-xs mb-3">
        Deposit from
      </Text>
      <View className="gap-2">
        {chains.map((c) => {
          const isSelected = c.chainId === selectedChainId;
          return (
            <TouchableOpacity
              key={c.id}
              activeOpacity={0.7}
              disabled={disabled}
              onPress={() => onSelect(c.chainId)}
              className={`flex-row items-center justify-between p-4 rounded-xl border ${
                isSelected
                  ? "border-light-primary-red bg-light-primary-red/5"
                  : "border-light-matte-black/10 bg-light-main-container"
              }`}
            >
              <View className="flex-row items-center">
                <View className="w-8 h-8 rounded-full bg-light-matte-black/5 items-center justify-center mr-3">
                  <Wallet color="#20222c" size={16} />
                </View>
                <Text className="text-light-matte-black font-medium">
                  {c.name}
                </Text>
              </View>
              {isSelected ? <CheckCircle2 color="#c71c4b" size={18} /> : null}
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function BalanceCard({
  chain,
  balanceMicros,
}: {
  chain: DepositCapableChain | null;
  balanceMicros: bigint | undefined;
}) {
  if (!chain) return null;
  const display =
    typeof balanceMicros === "bigint"
      ? `${formatUsdc(balanceMicros, chain.usdcDecimals)} USDC`
      : "—";
  return (
    <View className="bg-light rounded-3xl p-5 shadow-md-">
      <Text className="text-light-matte-black/60 text-xs mb-1">
        Your USDC balance on {chain.name}
      </Text>
      <Text className="text-light-matte-black text-xl font-bold">
        {display}
      </Text>
    </View>
  );
}

function AmountInputCard({
  amount,
  onChange,
  symbol,
  disabled,
}: {
  amount: string;
  onChange: (v: string) => void;
  symbol: string;
  disabled: boolean;
}) {
  return (
    <View className="bg-light rounded-3xl p-5 shadow-md-">
      <Text className="text-light-matte-black/60 text-xs mb-2">
        Amount ({symbol})
      </Text>
      <TextInput
        value={amount}
        onChangeText={(t) => onChange(t.replace(/[^0-9.]/g, ""))}
        editable={!disabled}
        keyboardType="decimal-pad"
        placeholder={DEFAULT_DEPOSIT_USDC}
        className="bg-light-main-container rounded-xl px-4 py-3 text-light-matte-black text-base"
      />
      <Text className="text-light-matte-black/40 text-xs mt-2">
        You can top up again any time.
      </Text>
    </View>
  );
}

function DepositProgress({ step }: { step: DepositStep }) {
  // Payer-facing copy — no "UserOp", "bundler", "nonce" language.
  const steps: { key: DepositStep; label: string }[] = [
    { key: "preparing", label: "Preparing" },
    { key: "submitting", label: "Confirming" },
    { key: "recording", label: "Finalizing" },
  ];
  const currentIndex = steps.findIndex((s) => s.key === step);
  return (
    <View className="bg-light rounded-3xl p-5 shadow-md-">
      <View className="flex-row items-center mb-3">
        <ActivityIndicator size="small" color="#c71c4b" />
        <Text className="text-light-matte-black font-medium ml-2">
          {steps[currentIndex]?.label ?? "Processing"}…
        </Text>
      </View>
      <View className="gap-2">
        {steps.map((s, i) => {
          const done = i < currentIndex;
          const active = i === currentIndex;
          return (
            <View key={s.key} className="flex-row items-center">
              <View
                className={`w-2 h-2 rounded-full mr-3 ${
                  done
                    ? "bg-green-500"
                    : active
                      ? "bg-light-primary-red"
                      : "bg-light-matte-black/20"
                }`}
              />
              <Text
                className={`text-sm ${
                  done || active
                    ? "text-light-matte-black"
                    : "text-light-matte-black/40"
                }`}
              >
                {s.label}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function DoneCard({ onContinue }: { onContinue: () => void }) {
  return (
    <View className="bg-light rounded-3xl p-6 shadow-md-">
      <View className="items-center mb-4">
        <View className="w-14 h-14 bg-green-100 rounded-full items-center justify-center mb-3">
          <CheckCircle2 color="#16a34a" size={32} />
        </View>
        <Text className="text-light-matte-black font-bold text-xl">
          You&apos;re all set
        </Text>
        <Text className="text-light-matte-black/60 text-sm text-center mt-1">
          Payments are now instant. We&apos;ll finish the setup in the
          background.
        </Text>
      </View>
      <TouchableOpacity
        activeOpacity={0.7}
        className="bg-light-primary-red py-4 px-5 rounded-xl items-center mt-2"
        onPress={onContinue}
      >
        <Text className="text-light font-semibold">Continue</Text>
      </TouchableOpacity>
    </View>
  );
}

function LoadingCard() {
  return (
    <View className="bg-light rounded-3xl p-6 shadow-md-">
      <View className="flex-row items-center">
        <ActivityIndicator size="small" color="#c71c4b" />
        <Text className="text-light-matte-black/60 text-sm ml-2">
          Loading chains…
        </Text>
      </View>
    </View>
  );
}

/** ── USDC balance ──────────────────────────────────────────────────── */

/**
 * On-demand USDC balance read from the selected chain's USDC contract.
 * Kept inline per the "touch only this screen" task constraint — same
 * viem client helper the rest of the app uses (`getPublicClient`). No
 * caching beyond React Query's default; the screen re-mounts on each
 * onboarding visit.
 */
function useUsdcBalance(
  chain: DepositCapableChain | null,
  address: string | undefined,
): { data: bigint | undefined } {
  const [balance, setBalance] = useState<bigint | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setBalance(undefined);
    if (!chain || !address) return;
    const chainConfig = findEvmChainById(chain.chainId);
    if (!chainConfig) return;
    (async () => {
      try {
        const client = getPublicClient(chainConfig.chain);
        const result = (await client.readContract({
          abi: erc20Abi,
          address: chain.usdcTokenAddress,
          functionName: "balanceOf",
          args: [address as `0x${string}`],
        })) as bigint;
        if (!cancelled) setBalance(result);
      } catch {
        // Balance display is advisory only — swallow errors so the
        // screen still renders and lets the user deposit. The actual
        // deposit tx will fail loud if the user truly has 0 USDC.
        if (!cancelled) setBalance(undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chain, address]);

  return { data: balance };
}

function formatUsdc(micros: bigint, decimals: number): string {
  try {
    const whole = formatUnits(micros, decimals);
    const n = parseFloat(whole);
    if (!Number.isFinite(n)) return whole;
    return n.toFixed(2);
  } catch {
    return micros.toString();
  }
}
