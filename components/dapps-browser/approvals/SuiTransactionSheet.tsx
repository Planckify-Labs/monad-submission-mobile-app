import * as Clipboard from "expo-clipboard";
import React, { useCallback, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import type {
  ApprovalDecision,
  ApprovalIntent,
} from "@/services/bridge/approval";
import type {
  SuiDecodedCommand,
  SuiNetwork,
  SuiSignTxPayload,
  SuiSimulationSummary,
} from "@/services/chains/sui/payloads";
import { useScreenshotGuard } from "@/services/security/screenshotGuard";
import type { ComputeSigningDigestArgs } from "@/services/walletKit/types";
import { truncateAddress } from "@/utils/walletUtils";
import { ApprovalShell } from "./ApprovalShell";
import { ClearSigningSection } from "./ClearSigningSection";
import { PrimaryActions, SheetModal } from "./SheetModal";
import { useBiometricApproval } from "./useBiometricApproval";

interface Props {
  intent: ApprovalIntent<SuiSignTxPayload>;
  onDecision: (d: ApprovalDecision) => void;
}

const NETWORK_LABEL: Record<SuiNetwork, string> = {
  mainnet: "Mainnet",
  testnet: "Testnet",
  devnet: "Devnet",
};

function commandLabel(c: SuiDecodedCommand): string {
  switch (c.kind) {
    case "MoveCall":
      return `MoveCall · ${c.module}::${c.function}`;
    case "TransferObjects":
      return `Transfer ${c.objectArgCount} object${c.objectArgCount === 1 ? "" : "s"}`;
    case "SplitCoins":
      return `Split coin into ${c.amountCount} part${c.amountCount === 1 ? "" : "s"}`;
    case "MergeCoins":
      return `Merge ${c.sourceArgCount} coin${c.sourceArgCount === 1 ? "" : "s"}`;
    case "Publish":
      return `Publish ${c.modules} module${c.modules === 1 ? "" : "s"}`;
    case "Upgrade":
      return `Upgrade ${c.modules} module${c.modules === 1 ? "" : "s"}`;
    case "MakeMoveVec":
      return `Make Move vec · ${c.elements} element${c.elements === 1 ? "" : "s"}`;
  }
}

function commandDetail(c: SuiDecodedCommand): string {
  switch (c.kind) {
    case "MoveCall":
      return `${c.package} · ${c.argumentCount} args, ${c.typeArgumentCount} type args`;
    case "TransferObjects":
      return `→ recipient at arg #${c.recipientArgIndex}`;
    case "SplitCoins":
      return `from coin at arg #${c.sourceArgIndex}`;
    case "MergeCoins":
      return `into coin at arg #${c.targetArgIndex}`;
    case "Publish":
    case "Upgrade":
      return `${c.dependencies} dependencies`;
    case "MakeMoveVec":
      return c.type ?? "";
  }
}

function GasSummary({
  payload,
}: {
  payload: SuiSignTxPayload;
}): React.ReactElement | null {
  const sim = payload.simulation;
  if (!payload.gasBudget && !sim) return null;
  const totalUsed = sim
    ? sim.gasUsed.computation + sim.gasUsed.storage - sim.gasUsed.storageRebate
    : null;
  return (
    <View className="bg-gray-50 rounded-xl p-3 mb-3">
      <Text className="text-xs text-gray-500 mb-1">Gas</Text>
      {payload.gasBudget !== undefined && (
        <Text className="text-sm text-gray-800">
          Budget: {payload.gasBudget.toString()} MIST
        </Text>
      )}
      {payload.gasPrice !== undefined && (
        <Text className="text-xs text-gray-600 mt-0.5">
          Price: {payload.gasPrice.toString()} MIST
        </Text>
      )}
      {totalUsed !== null && (
        <Text className="text-xs text-gray-600 mt-0.5">
          Estimated used: {totalUsed.toString()} MIST
        </Text>
      )}
      {payload.gasOwner &&
        payload.sender &&
        payload.gasOwner !== payload.sender && (
          <Text className="text-xs text-orange-700 mt-1">
            Sponsored by {truncateAddress({ address: payload.gasOwner })}
          </Text>
        )}
    </View>
  );
}

function SimulationSummary({
  summary,
}: {
  summary?: SuiSimulationSummary;
}): React.ReactElement | null {
  if (!summary) return null;
  return (
    <View className="bg-gray-50 rounded-xl p-3 mb-3">
      <Text className="text-xs text-gray-500 mb-1">Simulation</Text>
      <Text
        className={`text-sm ${
          summary.status === "success" ? "text-emerald-700" : "text-red-700"
        }`}
      >
        Status: {summary.status}
      </Text>
      {summary.balanceChanges.length > 0 && (
        <View className="mt-2">
          <Text className="text-xs text-gray-500">Balance changes</Text>
          {summary.balanceChanges.slice(0, 5).map((b, i) => (
            <Text key={i} className="text-xs text-gray-800">
              {b.coinType}: {b.amount.toString()} MIST
              {b.amount < 0n ? " (out)" : " (in)"}
            </Text>
          ))}
        </View>
      )}
      {summary.objectChanges.length > 0 && (
        <View className="mt-2">
          <Text className="text-xs text-gray-500">Object changes</Text>
          {summary.objectChanges.slice(0, 5).map((o, i) => (
            <Text key={i} className="text-xs text-gray-800">
              {o.kind} · {o.objectType ?? o.objectId ?? "?"}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

export function SuiTransactionSheet({
  intent,
  onDecision,
}: Props): React.ReactElement {
  useScreenshotGuard();
  const p = intent.payload;
  const decoded = p.decoded ?? [];
  const semantics = p.semantics ?? [];

  // Task 65 — Stage-2 descriptor input (first MoveCall command; the
  // other PTB command kinds are already fully legible at Stage 1) and
  // the chain's own pre-signature tx digest.
  const clearSigningCall = useMemo(
    () => decoded.find((c) => c.kind === "MoveCall"),
    [decoded],
  );
  const digestArgs = useMemo<ComputeSigningDigestArgs>(
    () => ({ kind: "transaction", transaction: p.transaction }),
    [p.transaction],
  );

  const approve = useCallback(
    () => onDecision({ id: intent.id, outcome: "approve" }),
    [intent.id, onDecision],
  );
  const { gatedApprove, pending, error } = useBiometricApproval(
    p.mode === "sign-and-execute" ? "Sign and execute" : "Sign transaction",
    approve,
  );

  const copyTx = async (): Promise<void> => {
    await Clipboard.setStringAsync(p.transaction);
  };

  return (
    <SheetModal
      onDismiss={() => onDecision({ id: intent.id, outcome: "reject" })}
    >
      <ApprovalShell
        intent={intent}
        title={
          p.mode === "sign-and-execute"
            ? "Sign & execute Sui transaction"
            : "Sign Sui transaction"
        }
      >
        <ScrollView className="flex-1">
          <View className="flex-row items-center mb-3">
            <View className="px-3 py-1 rounded-full bg-blue-50">
              <Text className="text-xs text-blue-700">
                Sui · {NETWORK_LABEL[p.network]}
              </Text>
            </View>
            <Text className="ml-2 text-xs text-gray-600">
              {truncateAddress({ address: p.address })}
            </Text>
          </View>

          {/*
            Standard-level readings from the PTB semantic passes (kiosk,
            package upgrade, and anything docked later). Rendered above
            the structural command list so the user reads "what this
            does" before "how it is built". Entirely generic: the sheet
            never learns a standard's name, so docking a new pass needs
            no change here.
          */}
          {semantics.map((s) => (
            <View
              key={s.code}
              className={`rounded-xl p-3 mb-3 border ${
                s.severity === "warn"
                  ? "bg-amber-50 border-amber-300"
                  : "bg-white border-gray-200"
              }`}
            >
              <Text
                className={`text-sm font-semibold ${
                  s.severity === "warn" ? "text-amber-900" : "text-gray-900"
                }`}
              >
                {s.title}
              </Text>
              {s.fields.map((f) => (
                <View key={f.label} className="flex-row mt-1">
                  <Text className="text-xs text-gray-500 w-28">{f.label}</Text>
                  <Text className="text-xs text-gray-900 flex-1" selectable>
                    {f.value}
                  </Text>
                </View>
              ))}
            </View>
          ))}

          {decoded.length > 0 ? (
            <View className="bg-gray-50 rounded-xl p-3 mb-3">
              <Text className="text-xs text-gray-500 mb-1">
                Programmable transaction ({decoded.length} commands)
              </Text>
              {decoded.map((c, i) => (
                <View key={i} className="py-1 border-t border-gray-100">
                  <Text className="text-sm text-gray-900">
                    {i + 1}. {commandLabel(c)}
                  </Text>
                  <Text className="text-xs text-gray-500" selectable>
                    {commandDetail(c)}
                  </Text>
                </View>
              ))}
            </View>
          ) : (
            <View className="bg-gray-50 rounded-xl p-3 mb-3">
              <Text className="text-xs text-gray-500">
                Decoder unavailable — review the raw bytes carefully.
              </Text>
              <Text
                className="text-xs font-mono text-gray-700 mt-2"
                selectable
                numberOfLines={3}
              >
                {p.transaction}
              </Text>
            </View>
          )}

          {/* Task 65 — descriptor + AI summary + explorer-matching
              tx digest (visible pre-signature, base58). */}
          <ClearSigningSection
            intent={intent}
            call={clearSigningCall}
            network={p.network}
            digestArgs={digestArgs}
          />

          <SimulationSummary summary={p.simulation} />
          <GasSummary payload={p} />

          <Text
            className="text-xs text-violet-700 mb-2"
            onPress={() => {
              void copyTx();
            }}
          >
            Copy transaction (base64)
          </Text>
          {error && <Text className="text-xs text-red-600 mt-2">{error}</Text>}
        </ScrollView>
      </ApprovalShell>
      <PrimaryActions
        approveLabel={
          pending
            ? "Authenticating…"
            : p.mode === "sign-and-execute"
              ? "Sign & execute"
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
