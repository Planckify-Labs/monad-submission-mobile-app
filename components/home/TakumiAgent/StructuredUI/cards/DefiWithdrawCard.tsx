/**
 * DefiWithdrawCard — proposal card for `defi_withdraw`.
 *
 * Replaces the generic `PendingTxCard` fallback, which rendered a bare
 * "APPROVAL REQUIRED / Transaction / Reject / Approve" prompt: the
 * `defi_withdraw` tool's own args are just `{ position_id, amount_raw }`
 * (routing needs nothing else — see writes.ts), so the shared facts-first
 * summary builder had nothing to read and fell all the way through to its
 * terminal fallback string.
 *
 * Security note (mirrors `approvalSummary.ts`'s header): `defi_withdraw` now
 * also accepts OPTIONAL `protocol_slug` / `asset_symbol` / `chain_id`
 * DISPLAY HINTS from the model (agent-api propose.ts), copied from
 * `defi_list_positions`. Those hints are never used for ROUTING, and this
 * card never renders them directly either — they could be wrong (stale
 * context) or, worst case, adversarially mismatched by something the model
 * read earlier in the turn (the exact prompt-injection shape approvalSummary
 * exists to defend against). Instead this card fetches the position by
 * `position_id` itself (the same authenticated, ownership-scoped lookup the
 * executor already does at execution time) and renders ONLY that — ground
 * truth, not the model's claim about it. The executor's own
 * `assertWithdrawHintsMatchPosition` is the second, execution-time layer of
 * the same defense.
 *
 * Chain-agnostic by construction: chain identity is resolved through a
 * CAIP-2-style lookup table + `getChainFamilyLabel(namespace)` for non-EVM
 * rows (same helper `PositionListCard` uses), never a namespace-string
 * equality branch (CLAUDE.md hard rule, `pnpm check:chains`).
 * `defi_withdraw` itself only executes EVM positions today (Sui withdraws
 * route through the separate intent-engine path), but nothing here assumes
 * that — a namespace this card doesn't know about still renders a real chain
 * label instead of breaking.
 */

import { useQuery } from "@tanstack/react-query";
import type React from "react";
import { Text, View } from "react-native";
import { strategiesApi } from "@/api/endpoints/strategies";
import type { TStrategyPosition } from "@/api/types/strategy";
import SingleLoadingSekeleton from "@/components/common/SingleLoadingSekeleton";
import { decimalsForSymbol } from "@/services/defi/assetDecimals";
import { prettyProtocol } from "@/services/defi/opportunityDisplay";
import { getChainFamilyLabel } from "@/services/walletKit/chainInfo";
import {
  approvalSummaryFromToolInput,
  factsFirstSummary,
  formatSmallestUnits,
} from "../approvalSummary";
import type { ToolComponentProps } from "../types";
import WriteApprovalGate from "../WriteApprovalGate";
import { HistoricalReceipt, LivePendingTxView } from "./PendingTxCard";

type DefiWithdrawInput = {
  position_id?: string;
  amount_raw?: string;
  protocol_slug?: string;
  chain_id?: number;
  asset_symbol?: string;
  amount_usd?: number;
  human_summary?: string;
  description?: string;
  [k: string]: unknown;
};

type DefiWithdrawOutput = {
  status?: "success" | "failed" | string;
  tx_hash?: string;
  tx_confirmed?: boolean;
  transaction_id?: string;
  block_number?: number;
  data?: {
    chain_id?: number;
    asset_symbol?: string;
    namespace?: string;
    [k: string]: unknown;
  };
  error?: string;
  reason?: string;
  user_decision?: "approved" | "rejected";
};

/** Numeric EVM chain ids + the non-EVM family lookup, same pattern as
 *  `PositionListCard.chainLabel` — deliberately a table, not a namespace
 *  branch. */
function chainLabel(chainId?: number, namespace?: string): string | undefined {
  if (chainId === undefined && namespace) {
    const label = getChainFamilyLabel(namespace);
    return label !== "Wallet" ? label : undefined;
  }
  switch (chainId) {
    case 1:
      return "Ethereum";
    case 8453:
      return "Base";
    case 42161:
      return "Arbitrum";
    case 10:
      return "Optimism";
    case 137:
      return "Polygon";
    case 56:
      return "BNB Chain";
    default:
      return chainId ? `Chain ${chainId}` : undefined;
  }
}

function parseBigInt(raw: string | undefined): bigint | undefined {
  if (!raw || !/^[0-9]+$/.test(raw)) return undefined;
  try {
    return BigInt(raw);
  } catch {
    return undefined;
  }
}

function formatUsd(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`;
}

function SkeletonProposal() {
  return (
    <View className="bg-light rounded-3xl p-5 mb-1.5 border border-light-matte-black/5">
      <SingleLoadingSekeleton width={70} height={10} borderRadius={4} />
      <SingleLoadingSekeleton
        width={180}
        height={18}
        borderRadius={4}
        style={{ marginTop: 8 }}
      />
      <View className="flex-row gap-3 mt-4">
        <SingleLoadingSekeleton width={140} height={54} borderRadius={12} />
        <SingleLoadingSekeleton width={140} height={54} borderRadius={12} />
      </View>
    </View>
  );
}

/** Ground-truth facts panel + the shared approval gate. Only reached once
 *  the position has actually loaded — see `WithdrawProposal`. */
function WithdrawFacts({
  position,
  amountRaw,
  decision,
  addToolResult,
  onRequestApproval,
}: {
  position: TStrategyPosition;
  amountRaw: bigint | undefined;
  decision: ToolComponentProps<
    DefiWithdrawInput,
    DefiWithdrawOutput
  >["decision"];
  addToolResult: (output: DefiWithdrawOutput) => void;
  onRequestApproval?: () => void;
}) {
  const protocolLabel = prettyProtocol(position.protocolSlug);
  const chain = chainLabel(position.chainId, position.namespace);
  const decimals = decimalsForSymbol(position.assetSymbol);

  const positionBalance = position.currentAmountRaw
    ? parseBigInt(position.currentAmountRaw)
    : undefined;
  const isFullExit =
    amountRaw !== undefined &&
    positionBalance !== undefined &&
    amountRaw >= positionBalance;
  const remainingRaw =
    !isFullExit && amountRaw !== undefined && positionBalance !== undefined
      ? positionBalance - amountRaw
      : undefined;

  const amountLabel = formatSmallestUnits(amountRaw?.toString(), decimals);

  // Proportional USD estimate — the position's cached $ value is for the
  // FULL balance, so a partial withdrawal scales it by the fraction being
  // pulled out. Omitted (not guessed) when any input to the ratio is
  // missing or the position has no live balance to scale against.
  const currentUsd = position.currentAmountUsd
    ? Number(position.currentAmountUsd)
    : undefined;
  const withdrawnUsd =
    isFullExit && typeof currentUsd === "number"
      ? currentUsd
      : typeof currentUsd === "number" &&
          amountRaw !== undefined &&
          positionBalance !== undefined &&
          positionBalance > 0n
        ? (currentUsd * Number(amountRaw)) / Number(positionBalance)
        : undefined;
  const remainingUsd =
    typeof currentUsd === "number" && typeof withdrawnUsd === "number"
      ? currentUsd - withdrawnUsd
      : undefined;

  const apy =
    typeof position.currentApy === "number" &&
    Number.isFinite(position.currentApy)
      ? position.currentApy
      : undefined;

  const summary = factsFirstSummary(
    {
      action: "Withdraw",
      amount: amountLabel,
      asset: position.assetSymbol,
      suffix: `from ${protocolLabel}${chain ? ` on ${chain}` : ""}`,
    },
    {},
    `Withdraw from ${protocolLabel}`,
  );

  return (
    <View className="mb-1.5">
      <View className="bg-light rounded-3xl p-5 shadow-md- border border-light-matte-black/5">
        <Text className="text-light-matte-black/60 text-xs uppercase tracking-wide">
          Withdraw
        </Text>
        <Text className="text-light-matte-black font-bold text-lg mt-1">
          {protocolLabel}
          {chain ? ` · ${chain}` : ""}
        </Text>

        <View className="flex-row items-center mt-3 gap-3">
          <View className="flex-1 bg-light-main-container rounded-xl p-3">
            <Text className="text-light-matte-black/60 text-xs">Amount</Text>
            <Text
              className="text-light-matte-black font-semibold mt-1"
              numberOfLines={1}
            >
              {amountLabel ? `${amountLabel} ${position.assetSymbol}` : "—"}
            </Text>
            {formatUsd(withdrawnUsd) ? (
              <Text className="text-light-matte-black/60 text-xs mt-1">
                {formatUsd(withdrawnUsd)}
              </Text>
            ) : null}
          </View>
          <View className="flex-1 bg-light-main-container rounded-xl p-3">
            <Text className="text-light-matte-black/60 text-xs">
              {isFullExit ? "Type" : "Remaining after"}
            </Text>
            {isFullExit ? (
              <Text className="text-light-matte-black font-semibold mt-1">
                Full withdrawal
              </Text>
            ) : (
              <>
                <Text
                  className="text-light-matte-black font-semibold mt-1"
                  numberOfLines={1}
                >
                  {remainingRaw !== undefined
                    ? `${formatSmallestUnits(remainingRaw.toString(), decimals) ?? "—"} ${position.assetSymbol}`
                    : "—"}
                </Text>
                {formatUsd(remainingUsd) ? (
                  <Text className="text-light-matte-black/60 text-xs mt-1">
                    {formatUsd(remainingUsd)}
                  </Text>
                ) : null}
              </>
            )}
          </View>
        </View>

        {apy !== undefined ? (
          <Text className="text-light-matte-black/60 text-xs mt-3">
            {isFullExit
              ? `You'll stop earning ${apy.toFixed(2)}% APY on this position.`
              : `The withdrawn amount stops earning ${apy.toFixed(2)}% APY — the rest keeps earning.`}
          </Text>
        ) : null}
        <Text className="text-light-matte-black/60 text-xs mt-1">
          Funds return to your wallet{chain ? ` on ${chain}` : ""}.
        </Text>
      </View>

      <WriteApprovalGate
        decision={decision}
        summary={summary}
        onApprove={() =>
          addToolResult({ status: "success", user_decision: "approved" })
        }
        onReject={() =>
          addToolResult({ status: "failed", user_decision: "rejected" })
        }
        onRequestApproval={onRequestApproval}
      />
    </View>
  );
}

function WithdrawProposal({
  input,
  decision,
  addToolResult,
  onRequestApproval,
}: {
  input: DefiWithdrawInput;
  decision: ToolComponentProps<
    DefiWithdrawInput,
    DefiWithdrawOutput
  >["decision"];
  addToolResult: (output: DefiWithdrawOutput) => void;
  onRequestApproval?: () => void;
}) {
  const positionId =
    typeof input.position_id === "string" && input.position_id
      ? input.position_id
      : undefined;
  const amountRaw = parseBigInt(
    typeof input.amount_raw === "string" ? input.amount_raw : undefined,
  );

  const positionQuery = useQuery({
    queryKey: ["defi-withdraw-position", positionId],
    queryFn: () => strategiesApi.getPosition(positionId as string),
    enabled: !!positionId,
  });

  if (!positionId || positionQuery.isLoading) return <SkeletonProposal />;

  if (positionQuery.isError || !positionQuery.data) {
    // Enrichment failed — don't block the withdrawal on a display fetch.
    // Fall back to the generic facts-first summary (still hint-based, best
    // effort) rather than a dead end.
    if (__DEV__) {
      console.warn(
        "[DefiWithdrawCard] position fetch failed, falling back",
        positionQuery.error,
      );
    }
    return (
      <WriteApprovalGate
        decision={decision}
        summary={approvalSummaryFromToolInput(
          input as Record<string, unknown>,
          typeof input.human_summary === "string"
            ? input.human_summary
            : undefined,
          "Withdraw",
        )}
        onApprove={() =>
          addToolResult({ status: "success", user_decision: "approved" })
        }
        onReject={() =>
          addToolResult({ status: "failed", user_decision: "rejected" })
        }
        onRequestApproval={onRequestApproval}
      />
    );
  }

  return (
    <WithdrawFacts
      position={positionQuery.data}
      amountRaw={amountRaw}
      decision={decision}
      addToolResult={addToolResult}
      onRequestApproval={onRequestApproval}
    />
  );
}

const DefiWithdrawCard: React.FC<
  ToolComponentProps<DefiWithdrawInput, DefiWithdrawOutput>
> = ({
  state,
  input,
  output,
  mode,
  addToolResult,
  decision,
  onRequestApproval,
}) => {
  if (mode === "historical") {
    return <HistoricalReceipt input={input} output={output} state={state} />;
  }

  if (state === "input-streaming" || state === "input-available") {
    if (!addToolResult) {
      return <HistoricalReceipt input={input} output={output} state={state} />;
    }
    return (
      <WithdrawProposal
        input={input}
        decision={decision}
        addToolResult={addToolResult}
        onRequestApproval={onRequestApproval}
      />
    );
  }

  return (
    <LivePendingTxView
      txHash={typeof output?.tx_hash === "string" ? output.tx_hash : undefined}
      input={input}
      output={output}
      state={state}
    />
  );
};

export default DefiWithdrawCard;
