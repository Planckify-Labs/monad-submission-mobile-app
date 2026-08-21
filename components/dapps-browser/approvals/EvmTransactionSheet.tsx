import { ArrowLeftRight, FileCode, HandCoins } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import {
  createPublicClient,
  encodeFunctionData,
  formatEther,
  formatUnits,
  http,
  parseAbiItem,
  toHex,
} from "viem";
import { useTokenIdentity } from "@/hooks/queries/useTokenIdentity";
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
import { approveRiskSummary, decodeCalldata } from "@/services/decoders";
import { formatRawUint256 } from "@/services/decoders/calldata";
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
import {
  ClearSigningAiSummary,
  ClearSigningBody,
  ClearSigningWarnings,
  SigningDigestBlock,
  UnrecognizedCallNotice,
  useClearSigningDescriptor,
  useClearSigningSummary,
  useSigningDigest,
} from "./ClearSigningSection";
import { CounterpartyLabel } from "./CounterpartyLabel";
import {
  CollapsibleCard,
  DetailCard,
  DetailCardTitle,
  DetailEyebrow,
  DetailPanel,
  DetailRow,
  DetailStack,
} from "./DetailCard";
import { PrimaryActions, SheetModal } from "./SheetModal";
import { SpendingCapAmount, SpendingCapEditor } from "./SpendingCapEditor";
import { useApproveTargetRetry } from "./useApproveTargetRetry";
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
  // The origin this request came from, read off the intent rather than
  // any browser-level "current page" state.
  const requestHost = originHost(intent.origin.url);

  // A transaction with no recipient is a contract creation; that absence
  // *is* the protocol-level definition. `normalizeTx` only accepts a
  // missing `to` alongside init-code, so `undefined` here always means
  // "deploy this code", never "send to nowhere".
  const target = tx.to;
  const isDeployment = target === undefined;
  const initCodeBytes = tx.data ? (tx.data.length - 2) / 2 : 0;

  // The wallet's own RPC for this tx's chain, sourced from the backend
  // feed and never the dApp-supplied one. Declared up here because the
  // approve-target retry below reads through it, and the trace simulation
  // further down shares it.
  const { data: blockchains } = useBlockchainsWithStorage({ isActive: true });
  // Named from the backend feed, keyed on the chain *this call* is for,
  // never the home-screen active chain (dApp-bridge isolation).
  const chainName = useMemo(
    () => blockchains?.find((b) => b.chainId === tx.chainId)?.name,
    [blockchains, tx.chainId],
  );
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

  // Deployment calldata is constructor init-code, not an ABI call. Running
  // the 4-byte selector decoders over it would mis-hit some unrelated
  // signature and render a confident lie, so every decode path below is
  // gated off for deployments.
  // Prefer the inspector's decode: it carries the adapter's resolved
  // `approveTarget`, which is what separates an ERC-20 allowance
  // from an NFT approval. Re-decoding locally would drop that and fall
  // back to indeterminate.
  const originalDecoded = useMemo(
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

  // "Custom spending cap" — lets the user sign a smaller `approve` value
  // than the dApp requested. `spender` is read from the dApp's own,
  // unedited call so the override can never retarget who gets approved,
  // only how much. `null` = use the dApp's original request.
  const originalApprove = useMemo(
    () => approveRiskSummary(originalDecoded),
    [originalDecoded],
  );
  const approveSpender = originalApprove?.spender;
  const [customApproveRaw, setCustomApproveRaw] = useState<bigint | null>(null);

  // The calldata actually reviewed and signed. Re-encoded once, up front,
  // and threaded through every downstream read below (decode, digest,
  // simulation, raw-data view) rather than swapped in only at sign time —
  // so what this sheet shows is provably what gets signed, never a
  // last-second substitution the rest of the pipeline never saw.
  const effectiveData = useMemo(() => {
    if (customApproveRaw === null || !approveSpender || !tx.data) {
      return tx.data;
    }
    return encodeFunctionData({
      abi: [parseAbiItem("function approve(address spender, uint256 value)")],
      functionName: "approve",
      args: [approveSpender, customApproveRaw],
    });
  }, [tx.data, customApproveRaw, approveSpender]);

  // The adapter's probe shares the gas-estimate deadline and gives up on a
  // slow RPC, which is what leaves an ordinary ERC-20 rendered as "details
  // unconfirmed" in raw base units. Retry it here, where there is no
  // deadline. The adapter's answer always wins when it has one.
  const { target: retriedTarget, decimals: retriedDecimals } =
    useApproveTargetRetry(
      pinnedClient,
      target,
      !isDeployment &&
        tx.approveTarget?.decimals === undefined &&
        originalApprove !== null,
    );
  const approveTarget = tx.approveTarget ?? retriedTarget;

  const decoded = useMemo(
    () =>
      isDeployment
        ? null
        : customApproveRaw === null && approveTarget === tx.approveTarget
          ? originalDecoded
          : decodeCalldata(effectiveData, {
              approveTargetKind: approveTarget?.kind,
              totalSupply: approveTarget?.totalSupply,
              decimals: approveTarget?.decimals,
            }),
    [
      isDeployment,
      originalDecoded,
      customApproveRaw,
      effectiveData,
      approveTarget,
      tx.approveTarget,
    ],
  );

  // The allowance as it stands *after* any custom cap, so the spending
  // cap row shows what will actually be signed rather than what the
  // dApp asked for.
  const allowance = useMemo(() => approveRiskSummary(decoded), [decoded]);

  // Symbol + icon for the token being approved, so the cap reads
  // "1 USDT" with its logo rather than as a bare number beside 42 hex
  // characters. Decoration only: the amount is still scaled by the
  // decimals probed on-chain, and the full contract address stays on
  // screen underneath.
  const tokenIdentity = useTokenIdentity(
    tx.chainId,
    allowance ? target : undefined,
  );

  /**
   * The scale used to render and to accept the cap.
   *
   * Alchemy's `decimals` leads: it is available for any listed token on any
   * supported chain, including the case that sent us here — an ordinary
   * ERC-20 the on-chain probe could not type in time, which left the sheet
   * showing raw base units and demanding `6000000` for six tokens. Alchemy
   * gets it by calling `decimals()` on the contract, so this is a cached
   * read of the same value the wallet would fetch, range-checked server-side
   * before it ships.
   *
   * The wallet's own probes stay wired as the second source, so a chain with
   * no Alchemy coverage still scales correctly. When neither answers,
   * `undefined` falls the sheet back to raw units — honest, and the state
   * this whole path exists to make rare.
   */
  const capDecimals =
    tokenIdentity.decimals ?? allowance?.decimals ?? retriedDecimals;

  // Name the request in the user's terms. "Approve transaction" is the
  // mechanism; a person reading this sheet wants to know they are about
  // to hand out standing permission to move a token.
  const { title, subtitle } = useMemo(() => {
    if (isDeployment) {
      return {
        title: "Deploy contract",
        subtitle: "This site wants to create a new contract on the network.",
      };
    }
    if (allowance) {
      return {
        title: "Spending cap request",
        subtitle: "This site wants permission to spend your tokens.",
      };
    }
    return { title: "Approve transaction", subtitle: undefined };
  }, [isDeployment, allowance]);

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

  const hasCalldata = !!effectiveData && effectiveData !== "0x";
  // Task 65 — Stage-2 descriptor input + ERC-8213 Flow B digest input.
  const clearSigningCall = useMemo(
    () =>
      hasCalldata && target !== undefined
        ? { to: target, chainId: tx.chainId, data: effectiveData }
        : undefined,
    [hasCalldata, target, tx.chainId, effectiveData],
  );
  const digestArgs = useMemo<ComputeSigningDigestArgs>(
    () => ({ kind: "calldata", calldata: effectiveData ?? "0x" }),
    [effectiveData],
  );
  // Computed here rather than inside `ClearSigningSection` because this
  // sheet files the digest under "Advanced details", beside the raw
  // calldata it is a fingerprint of.
  const digest = useSigningDigest(intent.namespace, digestArgs);

  // Task 65 Phase F — claim-vs-delta cross-check (TWV-2026-038, task
  // 27) is fed by the resolved Stage-2 intent: structured and
  // registry/on-chain-sourced, so harder to evade than the free-text
  // regex (which stays as the fallback for unresolved calls).
  //
  // The pieces are composed here rather than dropped in as one
  // `ClearSigningSection` so the decoded claim can sit inside this
  // sheet's own summary card instead of arriving as another box.
  const [resolvedDescriptor, setResolvedDescriptor] =
    useState<ClearSigningDescriptor | null>(null);
  const onDescriptorResolved = useCallback(
    (d: ClearSigningDescriptor | null) => setResolvedDescriptor(d),
    [],
  );
  const descriptor = useClearSigningDescriptor(intent.namespace, {
    call: clearSigningCall,
    signer: intent.wallet?.address,
    onResolved: onDescriptorResolved,
  });
  const aiSummary = useClearSigningSummary(descriptor);

  // Device-owner check before the wallet signs, matching the Solana / Sui /
  // Stellar transaction sheets. EVM was the one family that confirmed a
  // fund-moving dApp transaction on a single tap.
  const approve = useCallback(() => {
    // Stash the user-picked source on the payload so adapter uses it.
    if (tx.gasEstimate) tx.gasEstimate.recommended = source;
    // A custom spending cap only ever lands here — never swapped into
    // `tx.data` earlier — so the adapter always signs exactly the bytes
    // this sheet just showed. `tx.decoded` is updated alongside it so a
    // stale (pre-edit) decode never survives into transaction history.
    if (customApproveRaw !== null) {
      tx.data = effectiveData;
      tx.decoded = decoded ?? undefined;
    }
    onDecision({ id: intent.id, outcome: "approve" });
  }, [
    tx,
    source,
    customApproveRaw,
    effectiveData,
    decoded,
    intent.id,
    onDecision,
  ]);
  const {
    gatedApprove,
    pending,
    error: biometricError,
  } = useBiometricApproval(
    `Confirm transaction on ${originHost(intent.origin.url)}`,
    approve,
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
            data: effectiveData,
            chainId: tx.chainId,
            approveTargetKind: tx.approveTarget?.kind,
          }),
    [tx.from, target, tx.value, effectiveData, tx.chainId, tx.approveTarget],
  );

  const [sim, setSim] = useState<
    | { phase: "idle" | "loading" | "unavailable" }
    | { phase: "ok"; changes: SimulatedAssetChange[]; reverted: boolean }
  >({ phase: "idle" });

  useEffect(() => {
    const hasSomethingToSimulate =
      (!!effectiveData && effectiveData !== "0x") ||
      (!!tx.value && tx.value > 0n);
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
        data: effectiveData,
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
  }, [pinnedClient, tx.from, target, tx.value, effectiveData, tx.chainId]);

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
      <ApprovalShell intent={intent} title={title} subtitle={subtitle}>
        <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
          {/*
            Alerts first and unboxed from the summary below them. The facts
            they used to repeat (spender, amount) now live in that summary,
            so `factRows` is off: a banner restating the same three values a
            third time is how a warning stops being read.
          */}
          <CalldataRiskSection
            decoded={decoded}
            contractAddress={target}
            factRows={false}
          />
          <ClearSigningWarnings descriptor={descriptor} />
          {claimMismatch.triggered && (
            <View className="bg-red-50 border border-red-200 rounded-2xl p-4 mb-3">
              <Text className="text-xs font-bold text-red-800 uppercase tracking-wider">
                Claim does not match predicted result
              </Text>
              <Text className="text-sm text-red-900 mt-1">
                {claimMismatch.reason}
              </Text>
            </View>
          )}
          {hasCalldata && !decoded?.signature && descriptor === null && (
            <UnrecognizedCallNotice />
          )}

          {/*
            One card for "what am I agreeing to". Grouping is done with
            filled panels, the way the activity-detail cards do it, rather
            than with rules between every row.
          */}
          <DetailCard>
            {isDeployment ? (
              <>
                <DetailCardTitle icon={<FileCode size={22} color="#c71c4b" />}>
                  {deployedContractLabel(deployKind.kind)}
                </DetailCardTitle>
                {/* Read off the init-code being signed, so it costs no RPC
                    call. Hedged on purpose: matching selectors proves they
                    are present, not that the code behaves. */}
                {deployDescription && (
                  <Text className="text-sm text-light-matte-black/70 mb-3">
                    {deployDescription}
                  </Text>
                )}
                <DetailPanel className="mb-3">
                  <Text className="text-xs text-light-matte-black/70 leading-5">
                    {DEPLOYMENT_COPY}
                  </Text>
                </DetailPanel>
                <DetailRow
                  label="Code size"
                  value={`${initCodeBytes.toLocaleString()} bytes`}
                />
              </>
            ) : allowance ? (
              <>
                {/*
                  The cap is the decision, so it gets the headline slot.
                  `approve(spender, value)` is an ordinary token write, so
                  the wallet is free to sign a smaller cap than the site
                  asked for — see `SpendingCapEditor`.
                */}
                {/* Handing coins over, not a shield: this screen is the
                    user *granting* an allowance, and a protective icon above
                    a permission grant reads as reassurance the sheet has no
                    business offering. */}
                <DetailCardTitle icon={<HandCoins size={22} color="#c71c4b" />}>
                  Spending cap
                </DetailCardTitle>
                <DetailPanel className="mb-3">
                  {capDecimals === undefined ? (
                    /*
                      Neither Alchemy nor the on-chain reads could give us this
                      token's scale, so there is no honest way to turn "5.19"
                      into base units. The amount is still shown exactly as the
                      site encoded it, but editing is withheld rather than
                      falling back to asking for raw units: a field that
                      demands `6000000` to approve six is the wallet handing
                      its own unfinished work to the person signing.
                    */
                    <SpendingCapAmount
                      display={formatRawUint256(allowance.amount)}
                      symbol={tokenIdentity.symbol}
                      logo={tokenIdentity.logo}
                      unlimited={allowance.unlimited}
                    />
                  ) : (
                    <SpendingCapEditor
                      display={
                        allowance.unlimited
                          ? "Unlimited"
                          : formatAmount(allowance.amount, capDecimals)
                      }
                      decimals={capDecimals}
                      symbol={tokenIdentity.symbol}
                      logo={tokenIdentity.logo}
                      unlimited={allowance.unlimited}
                      custom={customApproveRaw !== null}
                      onChange={setCustomApproveRaw}
                      onReset={() => setCustomApproveRaw(null)}
                    />
                  )}
                </DetailPanel>
                {capDecimals === undefined && (
                  <Text className="text-xs text-amber-700 mb-3">
                    We could not read this token's details, so the amount above
                    is shown exactly as the site encoded it and cannot be
                    changed here.
                  </Text>
                )}
                <Text className="text-xs text-light-matte-black/50 mb-4">
                  A spending cap stays in effect until you revoke it.
                </Text>
                <View className="gap-3">
                  <DetailStack
                    label="Token"
                    copyValue={target}
                    copyLabel="Token address"
                  >
                    <CounterpartyLabel address={target} />
                  </DetailStack>
                  <DetailStack
                    label="Spender"
                    copyValue={allowance.spender}
                    copyLabel="Spender address"
                  >
                    <CounterpartyLabel address={allowance.spender} />
                  </DetailStack>
                </View>
              </>
            ) : (
              <>
                {/*
                  TWV-2026-011 — what actually moves, read before what runs.
                  Partial coverage is surfaced explicitly.
                */}
                <DetailCardTitle
                  icon={<ArrowLeftRight size={22} color="#c71c4b" />}
                  accessory={
                    sim.phase === "ok" ? (
                      <Text className="text-[10px] text-light-matte-black/40">
                        Simulated
                      </Text>
                    ) : null
                  }
                >
                  Estimated changes
                </DetailCardTitle>
                <DetailPanel className="mb-4">
                  {simLoading ? (
                    <Text className="text-sm text-light-matte-black/70">
                      Simulating transaction...
                    </Text>
                  ) : displayDeltas.length === 0 ? (
                    <Text className="text-sm text-light-matte-black/70">
                      No asset movement predicted.
                    </Text>
                  ) : (
                    displayDeltas.map((d, i) => (
                      <Text
                        key={`${d.symbol}-${i}`}
                        className={`text-lg font-bold ${
                          d.direction === "out"
                            ? "text-light-primary-red"
                            : "text-green-700"
                        }`}
                      >
                        {d.direction === "out" ? "-" : "+"} {d.display}{" "}
                        {d.symbol}
                      </Text>
                    ))
                  )}
                </DetailPanel>
                <View className="gap-3">
                  <DetailStack
                    label="To"
                    copyValue={target}
                    copyLabel="Address"
                  >
                    {/* Phase R — the ENS name is additive; the full address
                        stays on screen. */}
                    <CounterpartyLabel address={target} />
                  </DetailStack>
                  {/*
                    `tx.value !== undefined`, not `tx.value`. A token swap
                    sends `value: "0x0"`, which normalizes to the bigint
                    `0n`, and `{0n && …}` evaluates to `0n` rather than
                    `false`. React 19 treats a bigint child as text
                    (`createChild`: `"bigint" === typeof newChild`), so that
                    emits a stray "0" as a raw text node inside this View —
                    invalid in RN, where text must live in a <Text>.
                    Comparing explicitly keeps the guard boolean.
                  */}
                  {tx.value !== undefined && tx.value > 0n && (
                    <DetailRow
                      label="Value"
                      value={`${formatEther(tx.value)} native`}
                    />
                  )}
                </View>
              </>
            )}

            {/* Task 65 — the decoded claim and where it came from. Fields
                are suppressed for an allowance because they are the spender
                and cap already shown above. */}
            {descriptor && (
              <View className="mt-4">
                <DetailEyebrow>What this does</DetailEyebrow>
                <DetailPanel>
                  <ClearSigningBody
                    descriptor={descriptor}
                    showFields={!allowance}
                  />
                  <View className="mt-2">
                    <ClearSigningAiSummary summary={aiSummary} />
                  </View>
                </DetailPanel>
              </View>
            )}

            {simReverted && (
              <Text className="text-xs text-light-primary-red mt-3 font-semibold">
                This transaction is expected to fail (revert). Signing it would
                still cost gas and change nothing.
              </Text>
            )}
            {coverageUnknown && !simLoading && (
              <Text className="text-xs text-amber-700 mt-3">
                We could not simulate this transaction on this network. Review
                the decoded call and signing digest before you sign.
              </Text>
            )}
          </DetailCard>

          {/* Where it runs, who asked, what it costs. Compact rows, no
              rules — spacing carries the grouping. */}
          <DetailCard>
            <DetailEyebrow>Transaction</DetailEyebrow>
            <DetailRow
              label="Network"
              value={chainName ?? `Chain ${tx.chainId}`}
            />
            <DetailRow label="Request from" value={requestHost} />
            <DetailRow label="Network fee">
              <View className="items-end">
                <Text className="text-sm font-semibold text-light-matte-black">
                  {gasCost ? `~${gasCost}` : "—"}
                </Text>
                {tx.gasEstimate && (
                  <View className="flex-row mt-1.5 bg-light-main-container rounded-lg p-0.5">
                    {(["wallet", "dApp"] as const).map((s) => {
                      const on = source === s;
                      return (
                        <TouchableOpacity
                          key={s}
                          onPress={() => setSource(s)}
                          className={`px-2.5 py-1 rounded-md ${
                            on ? "bg-white" : ""
                          }`}
                        >
                          <Text
                            className={`text-[11px] font-semibold ${
                              on
                                ? "text-light-primary-red"
                                : "text-light-matte-black/50"
                            }`}
                          >
                            {s === "wallet" ? "Wallet" : "Site"}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}
              </View>
            </DetailRow>
            {tx.gasEstimate && (
              <Text className="text-xs text-light-matte-black/40 mt-1">
                {tx.gasEstimate.rationale}
              </Text>
            )}
          </DetailCard>

          {/*
            The technical layer. Collapsed by default, but opened when the
            wallet could not decode what the call does: at that point the raw
            material stops being an advanced extra and becomes the only
            evidence there is.
          */}
          <CollapsibleCard
            title="Advanced details"
            defaultOpen={hasCalldata && !decoded?.signature}
          >
            <View>
              <DetailRow label="Fee type" value={feeLabel} />
              {decoded?.signature && (
                <DetailRow label="Function" value={decoded.functionName} />
              )}
              {decoded && !decoded.signature && hasCalldata && (
                <DetailRow
                  label="Selector"
                  value={`${decoded.selector}…`}
                  mono
                />
              )}
              {allowance && (
                <>
                  <DetailRow
                    label="Cap (raw units)"
                    value={allowance.amount.toString()}
                    mono
                  />
                  <DetailRow
                    label="Cap (hex)"
                    value={toHex(allowance.amount)}
                    mono
                  />
                </>
              )}
            </View>

            {decoded?.signature && decoded.args && decoded.args.length > 0 && (
              <View>
                <DetailEyebrow>Arguments</DetailEyebrow>
                <DetailPanel>
                  {decoded.args.map((a, i) => (
                    <View key={`${a.name}-${i}`} className="mb-1.5">
                      <Text className="text-[11px] text-light-matte-black/50">
                        {a.name}
                      </Text>
                      <Text
                        className="text-xs font-mono text-light-matte-black/80"
                        selectable
                      >
                        {formatArg(a.value)}
                      </Text>
                    </View>
                  ))}
                  {decoded.ambiguous && (
                    <Text className="text-xs text-amber-700 mt-1">
                      Selector matches multiple signatures; best-guess shown.
                    </Text>
                  )}
                </DetailPanel>
              </View>
            )}

            {digest && (
              <View>
                <DetailEyebrow>Verify on a second device</DetailEyebrow>
                <DetailPanel>
                  <SigningDigestBlock digest={digest} variant="bare" />
                </DetailPanel>
              </View>
            )}

            {hasCalldata && (
              <View>
                <DetailEyebrow>Raw calldata</DetailEyebrow>
                <DetailPanel>
                  <Text
                    className="text-[10px] font-mono text-light-matte-black/70"
                    selectable
                  >
                    {effectiveData}
                  </Text>
                </DetailPanel>
              </View>
            )}
          </CollapsibleCard>

          {(intent.wallet?.type === "Smart4337" ||
            intent.wallet?.type === "Smart7702") && (
            <Text className="text-xs text-light-matte-black/40 mb-3 px-1">
              Smart wallet · Executed as a UserOperation
            </Text>
          )}
        </ScrollView>
      </ApprovalShell>
      {biometricError && (
        <Text
          className="text-xs text-light-primary-red px-4 mt-2"
          accessibilityLabel="biometric-error"
        >
          {biometricError}
        </Text>
      )}
      <PrimaryActions
        approveLabel={
          pending ? "Authenticating…" : (riskConfirmLabel(decoded) ?? "Confirm")
        }
        rejectLabel="Cancel"
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
