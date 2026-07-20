import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { createPublicClient, formatEther, formatUnits, http } from "viem";
import { useBlockchainsWithStorage } from "@/hooks/useBlockchainsWithStorage";
import { buildChainConfigFromBlockchain } from "@/hooks/useWallet.helpers";
import type {
  ApprovalDecision,
  ApprovalIntent,
} from "@/services/bridge/approval";
import type {
  EvmSendTxPayload,
  GasEstimate,
} from "@/services/chains/evm/payloads";
import { decodeCalldata } from "@/services/decoders";
import { detectClaimMismatch } from "@/services/security/claimLabelDelta";
import {
  type AssetDelta,
  predictAssetDeltasFromCalldata,
  type SimulatedAssetChange,
  simulateAssetChanges,
} from "@/services/security/txSimulator";
import type {
  ClearSigningDescriptor,
  ComputeSigningDigestArgs,
} from "@/services/walletKit/types";
import { truncateAddress } from "@/utils/walletUtils";
import { ApprovalShell } from "./ApprovalShell";
import { ClearSigningSection } from "./ClearSigningSection";
import { PrimaryActions, SheetModal } from "./SheetModal";

// TWV-2026-009 — user-visible copy for the high-risk calldata variants.
// Keep the sentences identical to the spec so reviewers can grep for
// them; copy drift is a merge-block.
const SET_APPROVAL_FOR_ALL_COPY =
  "This gives the operator permission to move ALL current and future NFTs you hold in this collection. Revoke as soon as the dApp is done.";
const UNLIMITED_APPROVE_COPY =
  "This lets the spender move an unlimited amount of this token from your wallet — now and forever, until you revoke.";

interface Props {
  intent: ApprovalIntent<EvmSendTxPayload & { gasEstimate?: GasEstimate }>;
  onDecision: (d: ApprovalDecision) => void;
}

export function EvmTransactionSheet({
  intent,
  onDecision,
}: Props): React.ReactElement {
  const tx = intent.payload;
  const [source, setSource] = useState<"wallet" | "dApp">(
    tx.gasEstimate?.recommended ?? "wallet",
  );
  const [showRaw, setShowRaw] = useState(false);
  const decoded = useMemo(() => decodeCalldata(tx.data), [tx.data]);

  const hasCalldata = !!tx.data && tx.data !== "0x";
  // Task 65 — Stage-2 descriptor input + ERC-8213 Flow B digest input.
  const clearSigningCall = useMemo(
    () =>
      hasCalldata
        ? { to: tx.to, chainId: tx.chainId, data: tx.data }
        : undefined,
    [hasCalldata, tx.to, tx.chainId, tx.data],
  );
  const digestArgs = useMemo<ComputeSigningDigestArgs>(
    () => ({ kind: "calldata", calldata: tx.data ?? "0x" }),
    [tx.data],
  );

  // Task 65 Phase F — claim-vs-delta cross-check (TWV-2026-038, task
  // 27) now also fed by the resolved Stage-2 intent: structured and
  // registry/on-chain-sourced, so harder to evade than the free-text
  // regex (which stays as the fallback for unresolved calls).
  const [resolvedDescriptor, setResolvedDescriptor] =
    useState<ClearSigningDescriptor | null>(null);
  const onDescriptorResolved = useCallback(
    (d: ClearSigningDescriptor | null) => setResolvedDescriptor(d),
    [],
  );

  // TWV-2026-011 — static calldata predictor. Instant (no network), so
  // it paints the asset-movement block on first render and is the
  // fallback when on-chain simulation isn't available.
  const staticSim = useMemo(
    () =>
      predictAssetDeltasFromCalldata({
        from: tx.from,
        to: tx.to,
        value: tx.value,
        data: tx.data,
        chainId: tx.chainId,
      }),
    [tx.from, tx.to, tx.value, tx.data, tx.chainId],
  );

  // TWV-2026-011 follow-up — real trace-based simulation. Built on a
  // PINNED client (the wallet's own RPC for this tx's chain, sourced from
  // the backend feed), never the dApp-supplied one. Resolves the exact
  // per-token balance diffs the static predictor can't, e.g. for a router
  // `execute`. Falls back to the static block when the RPC can't trace.
  const { data: blockchains } = useBlockchainsWithStorage({ isActive: true });
  const pinnedClient = useMemo(() => {
    const row = blockchains?.find(
      (b) => b.chainId === tx.chainId && Boolean(b.rpcUrl),
    );
    if (!row) return null;
    const cfg = buildChainConfigFromBlockchain(row);
    if (cfg.namespace !== "eip155") return null;
    return createPublicClient({
      chain: cfg.chain,
      transport: http(row.rpcUrl, { retryCount: 0, timeout: 8000 }),
    });
  }, [blockchains, tx.chainId]);

  const [sim, setSim] = useState<
    | { phase: "idle" | "loading" | "unavailable" }
    | { phase: "ok"; changes: SimulatedAssetChange[]; reverted: boolean }
  >({ phase: "idle" });

  useEffect(() => {
    const hasSomethingToSimulate =
      (!!tx.data && tx.data !== "0x") || (!!tx.value && tx.value > 0n);
    if (!pinnedClient || !hasSomethingToSimulate) {
      setSim({ phase: "unavailable" });
      return;
    }
    let cancelled = false;
    setSim({ phase: "loading" });
    void simulateAssetChanges(pinnedClient, {
      from: tx.from,
      to: tx.to,
      value: tx.value,
      data: tx.data,
      chainId: tx.chainId,
    }).then((res) => {
      if (cancelled) return;
      setSim(
        res.status === "ok"
          ? { phase: "ok", changes: res.changes, reverted: res.reverted }
          : { phase: "unavailable" },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [pinnedClient, tx.from, tx.to, tx.value, tx.data, tx.chainId]);

  // Deltas fed to the claim-vs-result cross-check. When the real trace is
  // available it wins: an on-chain net-inflow figure is far harder to
  // spoof than the static guess.
  const claimDeltas = useMemo<AssetDelta[]>(() => {
    if (sim.phase === "ok") {
      return sim.changes.map((c) => ({
        token: c.token,
        symbol: c.symbol,
        direction: c.direction,
        amount: c.amount,
        counterparty: tx.to,
        kind: c.token === null ? "native" : "transfer",
      }));
    }
    return staticSim.deltas;
  }, [sim, staticSim.deltas, tx.to]);

  const claimMismatch = useMemo(
    () =>
      detectClaimMismatch({
        functionName: decoded?.functionName,
        resolvedIntent: resolvedDescriptor?.intent,
        deltas: claimDeltas,
      }),
    [decoded?.functionName, resolvedDescriptor?.intent, claimDeltas],
  );

  // Unified, formatted rows for the asset-movement card — from the real
  // trace when we have it, else the static predictor.
  const displayDeltas = useMemo(() => {
    if (sim.phase === "ok") {
      return sim.changes.map((c) => ({
        symbol: c.symbol,
        direction: c.direction,
        display: formatAmount(c.amount, c.decimals),
      }));
    }
    return staticSim.deltas.map((d) => ({
      symbol: d.symbol,
      direction: d.direction,
      display:
        d.amount === "unlimited"
          ? "Unlimited"
          : d.token === null
            ? formatEther(d.amount)
            : d.amount.toString(),
    }));
  }, [sim, staticSim.deltas]);

  const simReverted = sim.phase === "ok" && sim.reverted;
  const simLoading = sim.phase === "loading";
  // Show the "couldn't enumerate" caution only when we truly have nothing
  // authoritative: the trace is unavailable AND the static pass was partial.
  const coverageUnknown =
    sim.phase !== "ok" && staticSim.coverage === "partial";

  const feeLabel =
    tx.type === 0 ? "Legacy" : tx.type === 1 ? "Access list" : "Dynamic fee";

  const gasCost = useMemo(() => {
    const est =
      source === "wallet" && tx.gasEstimate
        ? tx.gasEstimate.wallet
        : tx.gasEstimate?.dApp;
    if (!est) return null;
    const maxFee = (est.maxFeePerGas ?? est.gasPrice) || undefined;
    const gas = est.gas ?? tx.gas;
    if (!maxFee || !gas) return null;
    try {
      return formatEther(maxFee * gas);
    } catch {
      return null;
    }
  }, [source, tx.gas, tx.gasEstimate]);

  return (
    <SheetModal
      onDismiss={() => onDecision({ id: intent.id, outcome: "reject" })}
    >
      <ApprovalShell intent={intent} title="Approve transaction">
        <ScrollView className="flex-1">
          {/*
            TWV-2026-011 — asset-delta block. Rendered above and larger
            than the decoded calldata so the user reads "what moves"
            before "what runs". Partial coverage is surfaced explicitly.
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
            {simLoading ? (
              <Text className="text-sm text-blue-900 mt-1">
                Simulating transaction...
              </Text>
            ) : displayDeltas.length === 0 ? (
              <Text className="text-sm text-blue-900 mt-1">
                No asset movement predicted.
              </Text>
            ) : (
              displayDeltas.map((d, i) => (
                <View
                  key={`${d.symbol}-${i}`}
                  className="flex-row items-center mt-1"
                >
                  <Text
                    className={`text-base font-bold ${
                      d.direction === "out" ? "text-red-700" : "text-green-700"
                    }`}
                  >
                    {d.direction === "out" ? "-" : "+"} {d.display} {d.symbol}
                  </Text>
                </View>
              ))
            )}
            {simReverted && (
              <Text className="text-xs text-red-700 mt-2 font-medium">
                This transaction is expected to fail (revert). Signing it would
                still cost gas and change nothing.
              </Text>
            )}
            {coverageUnknown && !simLoading && (
              <Text className="text-xs text-amber-700 mt-2">
                We could not simulate this transaction on this network. Review
                the decoded call and signing digest below before you sign.
              </Text>
            )}
          </View>
          {decoded?.risk?.kind === "setApprovalForAll" &&
            decoded.risk.approved && (
              <View className="bg-red-50 border border-red-300 rounded-xl p-3 mb-3">
                <Text className="text-xs font-bold text-red-800 uppercase">
                  High risk — grants control of entire collection
                </Text>
                <Text className="text-sm text-red-900 mt-1">
                  {SET_APPROVAL_FOR_ALL_COPY}
                </Text>
                <View className="flex-row mt-2">
                  <Text className="text-xs text-red-700 w-20">Operator</Text>
                  <Text className="text-xs text-red-900 flex-1" selectable>
                    {decoded.risk.operator}
                  </Text>
                </View>
                <View className="flex-row mt-1">
                  <Text className="text-xs text-red-700 w-20">Collection</Text>
                  <Text className="text-xs text-red-900 flex-1" selectable>
                    {tx.to}
                  </Text>
                </View>
              </View>
            )}
          {decoded?.risk?.kind === "approve" && decoded.risk.isUnlimited && (
            <View className="bg-red-50 border border-red-300 rounded-xl p-3 mb-3">
              <Text className="text-xs font-bold text-red-800 uppercase">
                Unlimited approval
              </Text>
              <Text className="text-sm text-red-900 mt-1">
                {UNLIMITED_APPROVE_COPY}
              </Text>
              <View className="flex-row mt-2">
                <Text className="text-xs text-red-700 w-20">Spender</Text>
                <Text className="text-xs text-red-900 flex-1" selectable>
                  {decoded.risk.spender}
                </Text>
              </View>
              <View className="flex-row mt-1">
                <Text className="text-xs text-red-700 w-20">Token</Text>
                <Text className="text-xs text-red-900 flex-1" selectable>
                  {tx.to}
                </Text>
              </View>
            </View>
          )}
          {/* Task 65 — descriptor card + AI summary + signing digest.
              The digest renders even when nothing resolves (that's when
              independent verification matters most); the unrecognized
              card only fires when the local selector decode also found
              nothing, so it never contradicts the Function card below. */}
          {claimMismatch.triggered && (
            <View className="bg-red-50 border border-red-300 rounded-xl p-3 mb-3">
              <Text className="text-xs font-bold text-red-800 uppercase">
                Claim label does not match predicted result
              </Text>
              <Text className="text-sm text-red-900 mt-1">
                {claimMismatch.reason}
              </Text>
            </View>
          )}
          <ClearSigningSection
            intent={intent}
            call={clearSigningCall}
            digestArgs={digestArgs}
            showUnrecognizedCard={hasCalldata && !decoded?.signature}
            onDescriptorResolved={onDescriptorResolved}
          />
          <View className="bg-gray-50 rounded-xl p-3 mb-3">
            <Text className="text-xs text-gray-500">To</Text>
            <Text className="text-sm text-gray-900" selectable>
              {tx.to}
            </Text>
            {tx.value && tx.value > 0n && (
              <>
                <Text className="text-xs text-gray-500 mt-2">Value</Text>
                <Text className="text-sm text-gray-900">
                  {formatEther(tx.value)} {intent.wallet ? "native" : ""}
                </Text>
              </>
            )}
          </View>

          {decoded && decoded.signature && (
            <View className="bg-white rounded-xl border border-gray-200 p-3 mb-3">
              <Text className="text-xs text-gray-500 mb-1">Function</Text>
              <Text className="text-sm font-medium text-gray-900">
                {decoded.functionName}
              </Text>
              {decoded.args?.map((a, i) => (
                <View key={`${a.name}-${i}`} className="flex-row mt-1">
                  <Text className="text-xs text-gray-500 w-20">{a.name}</Text>
                  <Text className="text-xs text-gray-900 flex-1" selectable>
                    {formatArg(a.value)}
                  </Text>
                </View>
              ))}
              {decoded.ambiguous && (
                <Text className="text-xs text-amber-700 mt-1">
                  Selector matches multiple signatures; best-guess shown.
                </Text>
              )}
            </View>
          )}
          {decoded && !decoded.signature && tx.data && tx.data !== "0x" && (
            <View className="bg-white rounded-xl border border-gray-200 p-3 mb-3">
              <Text className="text-xs text-gray-500">
                Calldata (unknown selector)
              </Text>
              <Text className="text-xs text-gray-900" selectable>
                {decoded.selector}…
              </Text>
            </View>
          )}

          <View className="bg-white rounded-xl border border-gray-200 p-3">
            <View className="flex-row items-center mb-2">
              <Text className="text-xs text-gray-500 flex-1">
                Gas · {feeLabel}
              </Text>
              {tx.gasEstimate && (
                <View className="flex-row">
                  <TouchableOpacity
                    onPress={() => setSource("dApp")}
                    className={`px-2 py-1 rounded-l-md ${
                      source === "dApp" ? "bg-gray-900" : "bg-gray-100"
                    }`}
                  >
                    <Text
                      className={`text-xs ${
                        source === "dApp" ? "text-white" : "text-gray-700"
                      }`}
                    >
                      dApp
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => setSource("wallet")}
                    className={`px-2 py-1 rounded-r-md ${
                      source === "wallet" ? "bg-gray-900" : "bg-gray-100"
                    }`}
                  >
                    <Text
                      className={`text-xs ${
                        source === "wallet" ? "text-white" : "text-gray-700"
                      }`}
                    >
                      Wallet
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
            <Text className="text-sm text-gray-900">
              {gasCost ? `~${gasCost}` : "—"}
            </Text>
            {tx.gasEstimate && (
              <Text className="text-xs text-gray-500 mt-1">
                {tx.gasEstimate.rationale}
              </Text>
            )}
          </View>

          {hasCalldata && (
            <View className="mt-3">
              <TouchableOpacity onPress={() => setShowRaw((r) => !r)}>
                <Text className="text-xs text-gray-500 underline">
                  {showRaw ? "Hide raw data" : "View raw data"}
                </Text>
              </TouchableOpacity>
              {showRaw && (
                <View className="bg-gray-50 rounded-xl p-3 mt-2">
                  <Text
                    className="text-[10px] font-mono text-gray-700"
                    selectable
                  >
                    {tx.data}
                  </Text>
                </View>
              )}
            </View>
          )}

          {(intent.wallet?.type === "Smart4337" ||
            intent.wallet?.type === "Smart7702") && (
            <Text className="text-xs text-gray-500 mt-3">
              Smart wallet · Executed as a UserOperation
            </Text>
          )}
        </ScrollView>
      </ApprovalShell>
      <PrimaryActions
        approveLabel={
          decoded?.risk?.kind === "setApprovalForAll" && decoded.risk.approved
            ? "Grant full collection access"
            : decoded?.risk?.kind === "approve" && decoded.risk.isUnlimited
              ? "Approve unlimited"
              : "Confirm"
        }
        onApprove={() => {
          // Stash the user-picked source on the payload so adapter uses it.
          if (tx.gasEstimate) tx.gasEstimate.recommended = source;
          onDecision({ id: intent.id, outcome: "approve" });
        }}
        onReject={() => onDecision({ id: intent.id, outcome: "reject" })}
      />
    </SheetModal>
  );
}

function formatArg(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string" && v.startsWith("0x") && v.length === 42)
    return truncateAddress({ address: v, preset: "medium" });
  if (Array.isArray(v)) return `[${v.length} items]`;
  return String(v);
}

// Format a token amount from base units to a human string using its
// decimals. Falls back to the raw integer if formatting throws (e.g. a
// nonsensical decimals value from a hostile token contract).
function formatAmount(amount: bigint, decimals: number): string {
  try {
    return formatUnits(amount, decimals);
  } catch {
    return amount.toString();
  }
}
