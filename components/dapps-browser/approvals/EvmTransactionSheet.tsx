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
import {
  deployedContractLabel,
  describeDeployedContract,
  guessDeployedContractKind,
} from "@/services/decoders/deployedContractKind";
import { originHost } from "@/services/permissions/caip";
import { rpcFetchOptions } from "@/services/rpc/proxyAuth";
import { detectClaimMismatch } from "@/services/security/claimLabelDelta";
import {
  type AssetDelta,
  predictAssetDeltasFromCalldata,
  type SimulatedAssetChange,
  simulateAssetChanges,
  type TraceSimulationResult,
} from "@/services/security/txSimulator";
import type {
  ClearSigningDescriptor,
  ComputeSigningDigestArgs,
} from "@/services/walletKit/types";
import { truncateAddress } from "@/utils/walletUtils";
import { ApprovalShell } from "./ApprovalShell";
// Phase L — the risk banners live here so the batch sheet renders the
// identical set. Do not re-inline them.
import { CalldataRiskSection, riskConfirmLabel } from "./CalldataRiskSection";
import { ClearSigningSection } from "./ClearSigningSection";
import { CounterpartyLabel } from "./CounterpartyLabel";
import { PrimaryActions, SheetModal } from "./SheetModal";
import { useBiometricApproval } from "./useBiometricApproval";

// Phase B — contract creation has no recipient, so the sheet must say
// what is happening instead of showing a blank "To" row.
const DEPLOYMENT_COPY =
  "This creates a new contract on the network rather than sending to an existing address. The code has not been reviewed by TakumiPay.";

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

  // A transaction with no recipient is a contract creation; that absence
  // *is* the protocol-level definition. `normalizeTx` only accepts a
  // missing `to` alongside init-code, so `undefined` here always means
  // "deploy this code", never "send to nowhere".
  const target = tx.to;
  const isDeployment = target === undefined;
  const initCodeBytes = tx.data ? (tx.data.length - 2) / 2 : 0;

  // Deployment calldata is constructor init-code, not an ABI call. Running
  // the 4-byte selector decoders over it would mis-hit some unrelated
  // signature and render a confident lie, so every decode path below is
  // gated off for deployments.
  // Prefer the inspector's decode: it carries the adapter's resolved
  // `approveTarget`, which is what separates an ERC-20 allowance
  // from an NFT approval. Re-decoding locally would drop that and fall
  // back to indeterminate.
  const decoded = useMemo(
    () =>
      isDeployment
        ? null
        : (tx.decoded ??
          decodeCalldata(tx.data, {
            approveTargetKind: tx.approveTarget?.kind,
            totalSupply: tx.approveTarget?.totalSupply,
            decimals: tx.approveTarget?.decimals,
          })),
    [isDeployment, tx.decoded, tx.data, tx.approveTarget],
  );

  // What this deployment actually deploys, read from the init-code. A
  // sheet that says only "Contract deployment" gives the same label to
  // an NFT collection, a token, and an arbitrary program.
  const deployKind = useMemo(
    () => guessDeployedContractKind(isDeployment ? tx.data : undefined),
    [isDeployment, tx.data],
  );
  const deployDescription = useMemo(
    () => describeDeployedContract(deployKind),
    [deployKind],
  );

  const hasCalldata = !!tx.data && tx.data !== "0x";
  // Task 65 — Stage-2 descriptor input + ERC-8213 Flow B digest input.
  const clearSigningCall = useMemo(
    () =>
      hasCalldata && target !== undefined
        ? { to: target, chainId: tx.chainId, data: tx.data }
        : undefined,
    [hasCalldata, target, tx.chainId, tx.data],
  );
  const digestArgs = useMemo<ComputeSigningDigestArgs>(
    () => ({ kind: "calldata", calldata: tx.data ?? "0x" }),
    [tx.data],
  );

  // Device-owner check before the wallet signs, matching the Solana / Sui /
  // Stellar transaction sheets. EVM was the one family that confirmed a
  // fund-moving dApp transaction on a single tap.
  const approve = useCallback(() => {
    // Stash the user-picked source on the payload so adapter uses it.
    if (tx.gasEstimate) tx.gasEstimate.recommended = source;
    onDecision({ id: intent.id, outcome: "approve" });
  }, [tx.gasEstimate, source, intent.id, onDecision]);
  const {
    gatedApprove,
    pending,
    error: biometricError,
  } = useBiometricApproval(
    `Confirm transaction on ${originHost(intent.origin.url)}`,
    approve,
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
      target === undefined
        ? // A deployment has no recipient to attribute deltas to, and no
          // way to know statically what its constructor does. "partial"
          // is the honest answer and drives the same "couldn't enumerate"
          // caution any other opaque payload gets.
          { deltas: [] as AssetDelta[], coverage: "partial" as const }
        : predictAssetDeltasFromCalldata({
            from: tx.from,
            to: target,
            value: tx.value,
            data: tx.data,
            chainId: tx.chainId,
            approveTargetKind: tx.approveTarget?.kind,
          }),
    [tx.from, target, tx.value, tx.data, tx.chainId, tx.approveTarget],
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
      // The wallet's own RPC is behind an authenticated proxy; without
      // the bearer every simulation read comes back 401 and the sheet
      // silently degrades to "could not simulate".
      transport: http(row.rpcUrl, {
        retryCount: 0,
        timeout: 8000,
        ...(rpcFetchOptions(row.rpcUrl) ?? {}),
      }),
    });
  }, [blockchains, tx.chainId]);

  const [sim, setSim] = useState<
    | { phase: "idle" | "loading" | "unavailable" }
    | { phase: "ok"; changes: SimulatedAssetChange[]; reverted: boolean }
  >({ phase: "idle" });

  useEffect(() => {
    const hasSomethingToSimulate =
      (!!tx.data && tx.data !== "0x") || (!!tx.value && tx.value > 0n);
    // Deployments are excluded: the tracer needs a call target, and the
    // contract this creates has no address until it is mined.
    if (!pinnedClient || !hasSomethingToSimulate || target === undefined) {
      setSim({ phase: "unavailable" });
      return;
    }
    let cancelled = false;
    setSim({ phase: "loading" });
    // Simulation is an enrichment, never a gate. This sheet is the last
    // thing standing between a dApp and the user's funds, so it MUST
    // render even when the tracer cannot run — the static predictor and
    // the decoded calldata below already carry the safety-critical
    // content, and `coverageUnknown` tells the user what is missing.
    //
    // Both guards are load-bearing and neither subsumes the other:
    //   - try/catch covers a *synchronous* throw. `simulateAssetChanges`
    //     itself is documented never-throws, but Metro's inlineRequires
    //     resolves `require('@/services/security/txSimulator')` (and its
    //     viem/ox graph) at this call site, so a module-init failure
    //     surfaces here, outside that function's own try.
    //   - .catch covers a rejected promise.
    //
    // This is not hypothetical: `ox` throwing on first load
    // (`Cannot assign to read-only property 'toString'`, see
    // docs/prototype-freeze-crash-retrospective.md) escaped through this
    // exact line, blew past the error boundary, and left the user with
    // NO approval sheet for an ERC-20 `approve` — a silent rejection that
    // is indistinguishable, from the outside, from a silent approval.
    const settle = (res: TraceSimulationResult | null) => {
      if (cancelled) return;
      setSim(
        res && res.status === "ok"
          ? { phase: "ok", changes: res.changes, reverted: res.reverted }
          : { phase: "unavailable" },
      );
    };
    try {
      void simulateAssetChanges(pinnedClient, {
        from: tx.from,
        to: target,
        value: tx.value,
        data: tx.data,
        chainId: tx.chainId,
      })
        .then(settle)
        .catch((e: unknown) => {
          if (__DEV__) console.warn("[EvmTransactionSheet] simulate failed", e);
          settle(null);
        });
    } catch (e) {
      if (__DEV__) {
        console.warn("[EvmTransactionSheet] simulate threw synchronously", e);
      }
      settle(null);
    }
    return () => {
      cancelled = true;
    };
  }, [pinnedClient, tx.from, target, tx.value, tx.data, tx.chainId]);

  // Deltas fed to the claim-vs-result cross-check. When the real trace is
  // available it wins: an on-chain net-inflow figure is far harder to
  // spoof than the static guess.
  const claimDeltas = useMemo<AssetDelta[]>(() => {
    if (sim.phase === "ok" && target !== undefined) {
      return sim.changes.map((c) => ({
        token: c.token,
        symbol: c.symbol,
        direction: c.direction,
        amount: c.amount,
        counterparty: target,
        kind: c.token === null ? "native" : "transfer",
      }));
    }
    return staticSim.deltas;
  }, [sim, staticSim.deltas, target]);

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
          <CalldataRiskSection decoded={decoded} contractAddress={target} />
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
            {isDeployment ? (
              <>
                <Text className="text-xs text-gray-500">Action</Text>
                <Text className="text-sm font-medium text-gray-900">
                  {deployedContractLabel(deployKind.kind)}
                </Text>
                {/* Read off the init-code being signed, so it costs no
                    RPC call. Hedged on purpose: matching selectors proves
                    they are present, not that the code behaves. */}
                {deployDescription && (
                  <Text className="text-sm text-gray-800 mt-1">
                    {deployDescription}
                  </Text>
                )}
                <Text className="text-xs text-gray-600 mt-1">
                  {DEPLOYMENT_COPY}
                </Text>
                <Text className="text-xs text-gray-500 mt-2">Code size</Text>
                <Text className="text-sm text-gray-900">
                  {initCodeBytes.toLocaleString()} bytes
                </Text>
              </>
            ) : (
              <>
                <Text className="text-xs text-gray-500">To</Text>
                {/* Phase R — the ENS name is additive; the full address
                    stays on screen. */}
                <CounterpartyLabel address={target} />
              </>
            )}
            {/*
              `tx.value !== undefined`, not `tx.value`. A token swap sends
              `value: "0x0"`, which normalizes to the bigint `0n`, and
              `{0n && …}` evaluates to `0n` rather than `false`. React 19
              treats a bigint child as text (`createChild`: `"bigint" ===
              typeof newChild`), so that emits a stray "0" as a raw text
              node inside this View — invalid in RN, where text must live
              in a <Text>. Comparing explicitly keeps the guard boolean.

              Scope note: this is a latent rendering bug found while
              reading the sheet, NOT the tower.exchange force-close. That
              one was `TypeError: Cannot assign to read-only property
              'toString'` from `ox` colliding with the prototype freeze in
              pollyfills.ts, and it fired in a passive effect after this
              render had already committed.
            */}
            {tx.value !== undefined && tx.value > 0n && (
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
          pending ? "Authenticating…" : (riskConfirmLabel(decoded) ?? "Confirm")
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
