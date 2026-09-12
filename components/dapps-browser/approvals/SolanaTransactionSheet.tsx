import React, { useCallback, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import type {
  ApprovalDecision,
  ApprovalIntent,
} from "@/services/bridge/approval";
import { isJitoTipAccount } from "@/services/chains/solana/jitoTipAccounts";
import type {
  SolanaCluster,
  SolanaDecodedInstruction,
  SolanaSignTxPayload,
  SolanaSimulationSummary,
} from "@/services/chains/solana/payloads";
import type { ComputeSigningDigestArgs } from "@/services/walletKit/types";
import { truncateAddress } from "@/utils/walletUtils";
import { ApprovalShell } from "./ApprovalShell";
import { ClearSigningSection } from "./ClearSigningSection";
import { RiskBanner } from "./RiskBanner";
import { PrimaryActions, SheetModal } from "./SheetModal";
import { useBiometricApproval } from "./useBiometricApproval";

interface Props {
  intent: ApprovalIntent<SolanaSignTxPayload>;
  onDecision: (d: ApprovalDecision) => void;
}

const CLUSTER_LABEL: Record<SolanaCluster, string> = {
  "mainnet-beta": "Mainnet",
  devnet: "Devnet",
  testnet: "Testnet",
};

function ComputeBudgetRow({
  decoded,
}: {
  decoded?: SolanaDecodedInstruction[];
}): React.ReactElement | null {
  if (!decoded) return null;
  const limit = decoded.find(
    (d) => d.program === "compute-budget" && d.kind === "setComputeUnitLimit",
  );
  const price = decoded.find(
    (d) => d.program === "compute-budget" && d.kind === "setComputeUnitPrice",
  );
  if (!limit && !price) return null;
  const limitValue =
    limit && "value" in limit ? Number(limit.value) : undefined;
  const priceValue =
    price && "value" in price ? Number(price.value) : undefined;
  const priorityFeeLamports =
    limitValue !== undefined && priceValue !== undefined
      ? Math.ceil((limitValue * priceValue) / 1_000_000)
      : undefined;
  return (
    <View className="border border-gray-200 rounded-xl p-3 mt-2">
      <Text className="text-xs text-gray-500 mb-1">Compute budget</Text>
      {limitValue !== undefined && (
        <Text className="text-xs text-gray-700">
          Unit limit: {limitValue.toLocaleString()}
        </Text>
      )}
      {priceValue !== undefined && (
        <Text className="text-xs text-gray-700">
          Unit price: {priceValue} μlamports/CU
        </Text>
      )}
      {priorityFeeLamports !== undefined && (
        <Text className="text-xs text-gray-900 mt-1 font-medium">
          Est. priority fee: {priorityFeeLamports.toLocaleString()} lamports
        </Text>
      )}
    </View>
  );
}

function JitoTipRow({
  decoded,
}: {
  decoded?: SolanaDecodedInstruction[];
}): React.ReactElement | null {
  if (!decoded) return null;
  // System transfer whose destination is a Jito tip account.
  const tipTransfer = decoded.find((d) => {
    if (d.program !== "system" || d.kind !== "transfer") return false;
    const data = (d as { data: { to?: string; lamports?: bigint } }).data;
    return typeof data.to === "string" && isJitoTipAccount(data.to);
  });
  if (!tipTransfer) return null;
  const data = (tipTransfer as { data: { to: string; lamports?: bigint } })
    .data;
  return (
    <View className="border border-amber-200 bg-amber-50 rounded-xl p-3 mt-2">
      <Text className="text-xs text-amber-900 font-medium">Jito MEV tip</Text>
      <Text className="text-xs text-amber-800 mt-1">
        {typeof data.lamports === "bigint"
          ? `${data.lamports.toString()} lamports`
          : "tip"}{" "}
        → {truncateAddress({ address: data.to, preset: "medium" })}
      </Text>
    </View>
  );
}

function SimulationRow({
  s,
}: {
  s?: SolanaSimulationSummary;
}): React.ReactElement | null {
  if (!s) return null;
  return (
    <View className="border border-gray-200 rounded-xl p-3 mt-2">
      <Text className="text-xs text-gray-500 mb-1">Simulation</Text>
      {s.unitsConsumed !== undefined && (
        <Text className="text-xs text-gray-700">
          Units consumed: {s.unitsConsumed.toLocaleString()}
        </Text>
      )}
      {s.balanceChanges.length > 0 && (
        <Text className="text-xs text-gray-700 mt-1">
          Balance changes: {s.balanceChanges.length}
        </Text>
      )}
      {s.tokenChanges.length > 0 && (
        <Text className="text-xs text-gray-700">
          Token changes: {s.tokenChanges.length}
        </Text>
      )}
      {s.warnings.length > 0 && (
        <Text className="text-xs text-amber-800 mt-1">
          {s.warnings.length} warning(s) — see risk banner.
        </Text>
      )}
    </View>
  );
}

function DecodedList({
  decoded,
}: {
  decoded?: SolanaDecodedInstruction[];
}): React.ReactElement | null {
  if (!decoded || decoded.length === 0) return null;
  return (
    <View className="border border-gray-200 rounded-xl p-3 mt-2">
      <Text className="text-xs text-gray-500 mb-1">Decoded instructions</Text>
      {decoded.map((ix, i) => {
        // `fields` and `risk` are declared by the program decoder, not
        // known here. That is what lets a newly docked decoder surface
        // detail and raise a warning without touching this sheet.
        const fields = "fields" in ix ? ix.fields : undefined;
        const risk = "risk" in ix ? ix.risk : undefined;
        return (
          <View key={`${i}-${ix.program}`} className="mt-1">
            <Text
              className={`text-xs ${
                risk ? "font-semibold text-amber-900" : "text-gray-700"
              }`}
            >
              {i + 1}. {ix.program} · {"kind" in ix ? ix.kind : "memo"}
            </Text>
            {risk && (
              <Text className="text-xs text-amber-800 ml-3">{risk.detail}</Text>
            )}
            {fields?.map((f) => (
              <Text key={f.label} className="text-xs text-gray-500 ml-3">
                {f.label}: {f.value}
              </Text>
            ))}
          </View>
        );
      })}
    </View>
  );
}

export function SolanaTransactionSheet({
  intent,
  onDecision,
}: Props): React.ReactElement {
  const p = intent.payload;

  // Task 65 — Stage-2 descriptor input. Prefer the first
  // unknown-program instruction (the on-chain-IDL leg needs the raw
  // bytes the decoded view drops); otherwise the first substantive
  // decoded instruction (well-known-program leg).
  const clearSigningCall = useMemo(() => {
    if (!p.decoded || p.decoded.length === 0) return undefined;
    const unknownIdx = p.decoded.findIndex(
      (d) => "kind" in d && d.kind === "unknown",
    );
    if (unknownIdx >= 0 && p.rawInstructions?.[unknownIdx]) {
      return p.rawInstructions[unknownIdx];
    }
    return p.decoded.find(
      (d) => d.program !== "compute-budget" && d.program !== "memo",
    );
  }, [p.decoded, p.rawInstructions]);
  const digestArgs = useMemo<ComputeSigningDigestArgs>(
    () => ({ kind: "transaction", transaction: p.transaction }),
    [p.transaction],
  );

  const approve = useCallback(
    () => onDecision({ id: intent.id, outcome: "approve" }),
    [intent.id, onDecision],
  );
  const reason =
    p.mode === "sign-and-send"
      ? `Sign & send on ${CLUSTER_LABEL[p.cluster]}`
      : `Sign transaction on ${CLUSTER_LABEL[p.cluster]}`;
  const { gatedApprove, pending, error } = useBiometricApproval(
    reason,
    approve,
  );

  return (
    <SheetModal
      onDismiss={() => onDecision({ id: intent.id, outcome: "reject" })}
    >
      <ApprovalShell intent={intent} title="Approve Solana transaction">
        <RiskBanner annotations={intent.annotations} showProvenance={false} />
        <ScrollView className="flex-1">
          <View className="flex-row items-center mb-3">
            <View className="px-2 py-0.5 rounded-full bg-violet-100">
              <Text className="text-xs font-medium text-violet-700">
                Solana · {CLUSTER_LABEL[p.cluster]}
              </Text>
            </View>
            <View className="ml-2 px-2 py-0.5 rounded-full bg-gray-100">
              <Text className="text-xs text-gray-700">
                {p.mode === "sign-and-send" ? "Sign & send" : "Sign only"}
              </Text>
            </View>
            <View className="ml-2 px-2 py-0.5 rounded-full bg-gray-100">
              <Text className="text-xs text-gray-700">
                {p.version === 0 ? "v0" : "legacy"}
              </Text>
            </View>
          </View>
          {p.linkMessage ? (
            // Deep-link spec D-13: text a Solana Pay server sent with the
            // transaction. Shown apart, labelled, never as the counterparty.
            <View className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-3">
              <Text className="text-xs text-amber-900/70 mb-1">
                Message from the request (not verified)
              </Text>
              <Text
                className="text-sm text-amber-900"
                style={{ fontFamily: "monospace" }}
              >
                {p.linkMessage}
              </Text>
            </View>
          ) : null}
          <View className="bg-gray-50 rounded-xl p-3">
            <Text className="text-xs text-gray-500">Fee payer</Text>
            <Text className="text-sm text-gray-900 mb-2" selectable>
              {truncateAddress({ address: p.address, preset: "medium" })}
            </Text>
            <Text className="text-xs text-gray-500">
              Transaction (base64, truncated)
            </Text>
            <Text
              className="text-xs font-mono text-gray-700"
              selectable
              numberOfLines={3}
            >
              {p.transaction.slice(0, 120)}
              {p.transaction.length > 120 ? "…" : ""}
            </Text>
          </View>
          {/* Task 65 — descriptor + AI summary + message SHA-256 digest. */}
          <View className="mt-2">
            <ClearSigningSection
              intent={intent}
              call={clearSigningCall}
              network={p.cluster}
              digestArgs={digestArgs}
            />
          </View>
          <DecodedList decoded={p.decoded} />
          <ComputeBudgetRow decoded={p.decoded} />
          <JitoTipRow decoded={p.decoded} />
          <SimulationRow s={p.simulation} />
          {error && <Text className="text-xs text-red-600 mt-2">{error}</Text>}
        </ScrollView>
      </ApprovalShell>
      <PrimaryActions
        approveLabel={
          pending
            ? "Authenticating…"
            : p.mode === "sign-and-send"
              ? "Sign & send"
              : "Sign"
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
