import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { createPublicClient, formatEther, formatUnits, http } from "viem";
import { useBlockchainsWithStorage } from "@/hooks/useBlockchainsWithStorage";
import { buildChainConfigFromBlockchain } from "@/hooks/useWallet.helpers";
import type {
  ApprovalDecision,
  ApprovalIntent,
} from "@/services/bridge/approval";
import type { EvmBatchCallsPayload } from "@/services/chains/evm/payloads";
import { decodeCalldata } from "@/services/decoders";
import {
  calldataRiskSeverity,
  type DecodedCalldata,
} from "@/services/decoders/calldata";
import { originHost } from "@/services/permissions/caip";
import { rpcFetchOptions } from "@/services/rpc/proxyAuth";
import {
  type BatchTraceSimulationResult,
  simulateBatchAssetChanges,
} from "@/services/security/txSimulator";
import type { ComputeSigningDigestArgs } from "@/services/walletKit/types";
import { ApprovalShell } from "./ApprovalShell";
import { CalldataRiskSection } from "./CalldataRiskSection";
import { ClearSigningSection } from "./ClearSigningSection";
import { CounterpartyLabel } from "./CounterpartyLabel";
import { PrimaryActions, SheetModal } from "./SheetModal";
import { useBiometricApproval } from "./useBiometricApproval";

// Phase L — a batch is exactly as dangerous as its most dangerous entry,
// and the risky entry is not reliably the first one. The test-dapp's own
// `eip5792.js` builds the hard case: one malicious call appended to a
// list of benign ones, where the flagged entry sits below the fold.
const BATCH_HIGH_RISK_COPY =
  "At least one call in this batch grants someone standing access to your assets. Scroll through every call before you confirm.";
const BATCH_MEDIUM_RISK_COPY =
  "At least one call in this batch is an approval we could not fully confirm. Review each call before you confirm.";
// Silence reads as safety, so say it outright when nothing was traced.
const NOT_SIMULATED_COPY =
  "We could not preview what this batch would move on this network. Review each call below before you confirm.";

/**
 * Task 65 — per-call clear-signing block. Each batch entry gets its
 * own Stage-2 descriptor + ERC-8213 Flow B calldata digest ("both,
 * never one" applies per calldata, and a batch is N calldatas).
 */
function BatchCallClearSigning({
  intent,
  call,
}: {
  intent: ApprovalIntent<EvmBatchCallsPayload>;
  call: EvmBatchCallsPayload["calls"][number];
}): React.ReactElement | null {
  const hasCalldata = !!call.data && call.data !== "0x";
  const clearSigningCall = useMemo(
    () =>
      hasCalldata
        ? { to: call.to, chainId: intent.payload.chainId, data: call.data }
        : undefined,
    [hasCalldata, call.to, call.data, intent.payload.chainId],
  );
  const digestArgs = useMemo<ComputeSigningDigestArgs>(
    () => ({ kind: "calldata", calldata: call.data ?? "0x" }),
    [call.data],
  );
  return (
    <ClearSigningSection
      intent={intent}
      call={clearSigningCall}
      digestArgs={digestArgs}
    />
  );
}

interface Props {
  intent: ApprovalIntent<EvmBatchCallsPayload>;
  onDecision: (d: ApprovalDecision) => void;
}

export function EvmBatchCallsSheet({
  intent,
  onDecision,
}: Props): React.ReactElement {
  const p = intent.payload;
  const atomic =
    intent.wallet?.type === "Smart4337" || intent.wallet?.type === "Smart7702";

  // Prefer the inspector's decode (priority 15, index-aligned with
  // `calls`) and fall back to decoding here, so the sheet still renders
  // risk if the inspector pipeline did not run.
  const decodedCalls = useMemo<(DecodedCalldata | null)[]>(
    () =>
      p.calls.map(
        (c, i) =>
          p.decodedCalls?.[i] ??
          (c.to === undefined
            ? null
            : decodeCalldata(c.data, {
                approveTargetKind: p.approveTargets?.[i]?.kind,
                totalSupply: p.approveTargets?.[i]?.totalSupply,
                decimals: p.approveTargets?.[i]?.decimals,
              })),
      ),
    [p.calls, p.decodedCalls, p.approveTargets],
  );

  // Batch-level verdict: the worst entry wins. Surfaced above the list so
  // a risky call at index 7 of 9 cannot be scrolled past.
  const worstSeverity = useMemo(() => {
    let worst: "high" | "medium" | "none" = "none";
    for (const d of decodedCalls) {
      const s = calldataRiskSeverity(d);
      if (s === "high") return "high";
      if (s === "medium") worst = "medium";
    }
    return worst;
  }, [decodedCalls]);

  const riskyIndexes = useMemo(
    () =>
      decodedCalls.flatMap((d, i) =>
        calldataRiskSeverity(d) === "none" ? [] : [i + 1],
      ),
    [decodedCalls],
  );

  // Phase L — simulate the batch as one sequence on the wallet's own RPC
  // (never the dApp's). Whole-batch, not per call: see
  // `simulateBatchAssetChanges` for why independent simulation would
  // report false reverts on an approve-then-swap batch.
  const { data: blockchains } = useBlockchainsWithStorage({ isActive: true });
  const pinnedClient = useMemo(() => {
    const row = blockchains?.find(
      (b) => b.chainId === p.chainId && Boolean(b.rpcUrl),
    );
    if (!row) return null;
    const cfg = buildChainConfigFromBlockchain(row);
    if (cfg.namespace !== "eip155") return null;
    return createPublicClient({
      chain: cfg.chain,
      // The wallet's own RPC is behind an authenticated proxy; without
      // the bearer every simulation read comes back 401 and the sheet
      // silently degrades to "could not simulate".
      transport: http(row.rpcUrl, {
        retryCount: 0,
        timeout: 8000,
        ...(rpcFetchOptions(row.rpcUrl) ?? {}),
      }),
    });
  }, [blockchains, p.chainId]);

  const [sim, setSim] = useState<
    | { phase: "idle" | "loading" | "unavailable" }
    | {
        phase: "ok";
        result: Extract<BatchTraceSimulationResult, { status: "ok" }>;
      }
  >({ phase: "idle" });

  useEffect(() => {
    if (!pinnedClient || p.calls.length === 0) {
      setSim({ phase: "unavailable" });
      return;
    }
    let cancelled = false;
    setSim({ phase: "loading" });
    void simulateBatchAssetChanges(pinnedClient, {
      from: p.from,
      calls: p.calls,
    }).then((res) => {
      if (cancelled) return;
      setSim(
        res.status === "ok"
          ? { phase: "ok", result: res }
          : { phase: "unavailable" },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [pinnedClient, p.from, p.calls]);

  // Device-owner check before the wallet signs. A batch is N fund-moving
  // calls behind one tap, so it needs the gate at least as much as the
  // single-transaction sheet does.
  const approve = useCallback(
    () => onDecision({ id: intent.id, outcome: "approve" }),
    [intent.id, onDecision],
  );
  const {
    gatedApprove,
    pending,
    error: biometricError,
  } = useBiometricApproval(
    `Confirm ${p.calls.length} calls for ${originHost(intent.origin.url)}`,
    approve,
  );

  return (
    <SheetModal
      onDismiss={() => onDecision({ id: intent.id, outcome: "reject" })}
    >
      <ApprovalShell intent={intent} title={`Batch (${p.calls.length} calls)`}>
        <ScrollView className="flex-1">
          {worstSeverity !== "none" && (
            <View
              className={`border rounded-xl p-3 mb-3 ${
                worstSeverity === "high"
                  ? "bg-red-50 border-red-300"
                  : "bg-amber-50 border-amber-300"
              }`}
            >
              <Text
                className={`text-xs font-bold uppercase ${
                  worstSeverity === "high" ? "text-red-800" : "text-amber-900"
                }`}
              >
                {worstSeverity === "high"
                  ? "High risk in this batch"
                  : "Needs review in this batch"}
              </Text>
              <Text
                className={`text-sm mt-1 ${
                  worstSeverity === "high" ? "text-red-900" : "text-amber-900"
                }`}
              >
                {worstSeverity === "high"
                  ? BATCH_HIGH_RISK_COPY
                  : BATCH_MEDIUM_RISK_COPY}
              </Text>
              <Text
                className={`text-xs mt-2 ${
                  worstSeverity === "high" ? "text-red-700" : "text-amber-800"
                }`}
              >
                Flagged: call {riskyIndexes.join(", call ")}
              </Text>
            </View>
          )}

          {/*
            Asset movement across the whole batch. Rendered above the
            per-call list so the user reads "what moves" before "what
            runs", matching the single-transaction sheet.
          */}
          <View className="bg-blue-50 border border-blue-200 rounded-xl p-3 mb-3">
            <View className="flex-row items-center">
              <Text className="text-xs font-semibold text-blue-800 uppercase flex-1">
                Asset movement
              </Text>
              {sim.phase === "ok" && (
                <Text className="text-[10px] text-blue-600">
                  Simulated on-chain
                </Text>
              )}
            </View>
            {sim.phase === "loading" ? (
              <Text className="text-sm text-blue-900 mt-1">
                Simulating batch...
              </Text>
            ) : sim.phase === "ok" ? (
              sim.result.changes.length === 0 ? (
                <Text className="text-sm text-blue-900 mt-1">
                  No net asset movement predicted.
                </Text>
              ) : (
                sim.result.changes.map((c, i) => (
                  <View
                    key={`${c.symbol}-${i}`}
                    className="flex-row items-center mt-1"
                  >
                    <Text
                      className={`text-base font-bold ${
                        c.direction === "out"
                          ? "text-red-700"
                          : "text-green-700"
                      }`}
                    >
                      {c.direction === "out" ? "-" : "+"}{" "}
                      {formatAmount(c.amount, c.decimals)} {c.symbol}
                    </Text>
                  </View>
                ))
              )
            ) : (
              <Text className="text-xs text-amber-700 mt-1">
                {NOT_SIMULATED_COPY}
              </Text>
            )}
            {sim.phase === "ok" && sim.result.revertedIndexes.length > 0 && (
              <Text className="text-xs text-red-700 mt-2 font-medium">
                Expected to fail at call{" "}
                {sim.result.revertedIndexes.map((i) => i + 1).join(", ")}.
                Signing would still cost gas.
              </Text>
            )}
          </View>

          {/*
            Atomicity is an execution guarantee, not a safety one. When a
            call in the batch is flagged, the green "Atomic batch" pill
            would read as reassurance about the wrong thing, so it drops
            to neutral and says what atomicity actually buys.
          */}
          <View
            className={`self-start px-2 py-1 rounded-full mb-1 ${
              worstSeverity !== "none"
                ? "bg-gray-100"
                : atomic
                  ? "bg-green-50"
                  : "bg-amber-50"
            }`}
          >
            <Text
              className={`text-xs ${
                worstSeverity !== "none"
                  ? "text-gray-700"
                  : atomic
                    ? "text-green-700"
                    : "text-amber-700"
              }`}
            >
              {atomic ? "Atomic batch" : "Sequential"}
            </Text>
          </View>
          {atomic && worstSeverity !== "none" && (
            <Text className="text-xs text-gray-600 mb-3">
              Atomic means all calls succeed or none do. It does not mean the
              calls are safe.
            </Text>
          )}
          {!atomic && (
            <Text className="text-xs text-amber-700 mb-3">
              Sequential: if one step fails, earlier steps will still be
              on-chain.
            </Text>
          )}

          {p.calls.map((c, i) => {
            const decoded = decodedCalls[i];
            return (
              <View
                key={`${c.to}-${i}`}
                className="bg-white border border-gray-200 rounded-xl p-3 mb-2"
              >
                <Text className="text-xs text-gray-500">Call {i + 1}</Text>
                {/* Phase R — additive name, address always present. */}
                <CounterpartyLabel
                  address={c.to}
                  fallbackLabel="New contract (deployment)"
                />
                {c.value && c.value > 0n && (
                  <Text className="text-xs text-gray-500 mt-1">
                    Value: {formatEther(c.value)}
                  </Text>
                )}
                {/* Phase L — the same banners the single-transaction
                    sheet renders, from the same component. */}
                <View className="mt-2">
                  <CalldataRiskSection
                    decoded={decoded}
                    contractAddress={c.to}
                  />
                </View>
                {decoded?.signature && (
                  <View className="mt-1">
                    <Text className="text-xs font-medium text-gray-900">
                      {decoded.functionName}
                    </Text>
                    {/* Argument VALUES, not just names. "approve(spender,
                        amount)" told the user nothing at all. */}
                    {decoded.args?.map((a, j) => (
                      <View key={`${a.name}-${j}`} className="flex-row mt-0.5">
                        <Text className="text-xs text-gray-500 w-20">
                          {a.name}
                        </Text>
                        <Text
                          className="text-xs text-gray-900 flex-1"
                          selectable
                        >
                          {formatArg(a.value)}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
                {decoded && !decoded.signature && c.data && c.data !== "0x" && (
                  <Text className="text-xs text-gray-500 mt-1">
                    Unknown selector {decoded.selector}
                  </Text>
                )}
                <View className="mt-2">
                  <BatchCallClearSigning intent={intent} call={c} />
                </View>
              </View>
            );
          })}
        </ScrollView>
      </ApprovalShell>
      {biometricError && (
        <Text
          className="text-xs text-red-600 px-4 mt-2"
          accessibilityLabel="biometric-error"
        >
          {biometricError}
        </Text>
      )}
      <PrimaryActions
        approveLabel={
          pending
            ? "Authenticating…"
            : worstSeverity === "high"
              ? "Confirm high-risk batch"
              : "Confirm batch"
        }
        onApprove={() => {
          void gatedApprove();
        }}
        onReject={() => onDecision({ id: intent.id, outcome: "reject" })}
        loading={pending}
      />
    </SheetModal>
  );
}

function formatArg(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return `[${v.length} items]`;
  return String(v);
}

function formatAmount(amount: bigint, decimals: number): string {
  try {
    return formatUnits(amount, decimals);
  } catch {
    return amount.toString();
  }
}
