/**
 * Shared calldata risk banners — spec phase L.
 *
 * These branches used to live inline in `EvmTransactionSheet`, which is
 * why `EvmBatchCallsSheet` had none of them: the same
 * `approve(spender, MAX)` produced a red unlimited-allowance banner
 * through `eth_sendTransaction` and a bare `approve(spender, amount)`
 * parameter list through `wallet_sendCalls`. Phases D and F built five
 * risk banners and an attacker could skip every one of them by choosing
 * the batch method.
 *
 * Extraction rather than a second copy is the point. Two hand-maintained
 * copies of a security banner drift, and the copy that drifts is the one
 * nobody is reading. Both EVM sheets now render risk through this file,
 * so a sixth risk kind cannot land in one surface and miss the other.
 */

import React from "react";
import { Text, View } from "react-native";
import { formatUnits, toHex } from "viem";
import type { DecodedCalldata } from "@/services/decoders/calldata";
import { formatRawUint256 } from "@/services/decoders/calldata";

// TWV-2026-009 — user-visible copy for the high-risk calldata variants.
// Keep the sentences identical to the spec so reviewers can grep for
// them; copy drift is a merge-block.
const SET_APPROVAL_FOR_ALL_COPY =
  "This gives the operator permission to move ALL current and future NFTs you hold in this collection. Revoke as soon as the dApp is done.";
const UNLIMITED_APPROVE_COPY =
  "This lets the spender move an unlimited amount of this token from your wallet, now and forever, until you revoke.";
// Phase D / F — copy for the risk variants added by this spec.
const DELEGATE_COPY =
  "This lets another address act for you on sites that check delegation, without moving anything now. It stays in effect until you revoke it.";
const APPROVE_NFT_COPY =
  "This lets the operator move this one item. Other items in the collection are not affected.";
const APPROVE_UNKNOWN_COPY =
  "We could not confirm what kind of contract this is, so we cannot tell you whether the number below is an amount or an item number. Continue only if you know what this contract does.";
// Shown when the unresolved value is large enough that, IF this is a
// token, it is an unlimited allowance. Phrased conditionally on purpose:
// we do not know the contract type, and claiming we do is the failure
// mode this whole phase exists to remove.
const APPROVE_UNKNOWN_UNLIMITED_COPY =
  "If this contract is a token, this grants an unlimited allowance that lasts until you revoke it.";
// Phase N — the hedged variant, used when only the offline threshold
// fired because the token would not tell us its supply. The distinction
// is worth the extra string: one sentence is a fact about this token,
// the other is a rule of thumb, and saying the second in the voice of
// the first is how warnings lose their meaning.
const LOOKS_UNLIMITED_APPROVE_COPY =
  "This allowance is large enough that it behaves like an unlimited one. We could not read this token's total supply to confirm, so check the amount below before you continue.";
// Phase N — a bounded allowance rendered at the token's own scale. No
// warning attached: this row exists because "18,446,744,073,710" is a
// number a person can judge and a 20-digit integer is not.
const BOUNDED_APPROVE_COPY =
  "This lets the spender move up to the amount below. It stays in effect until you revoke it.";

/**
 * Confirm-button copy for the risks that deserve their own verb.
 *
 * Lives here rather than in the sheet for the same reason the banners
 * do: a button reading "Confirm" under a red unlimited-allowance banner
 * is the sheet quietly disagreeing with itself, and keeping the two in
 * one file is what stops them drifting apart.
 *
 * Returns `null` when the generic label is right.
 */
export function riskConfirmLabel(
  decoded: DecodedCalldata | null | undefined,
): string | null {
  const risk = decoded?.risk;
  if (!risk) return null;
  if (risk.kind === "setApprovalForAll" && risk.approved) {
    return "Grant full collection access";
  }
  if (risk.kind === "approve" && risk.isUnlimited) {
    // Phase N — the button carries the same confidence the banner does.
    // "Approve unlimited" over a card that says "we could not confirm"
    // is the sheet contradicting itself in the one place the user acts.
    return risk.unlimitedBasis === "supply"
      ? "Approve unlimited"
      : "Approve large allowance";
  }
  if (risk.kind === "delegate" && risk.enabled) return "Grant delegation";
  return null;
}

interface Props {
  decoded: DecodedCalldata | null | undefined;
  /**
   * The contract being called. Shown as the collection / token row, so
   * the user can see *which* asset the grant covers rather than only who
   * receives it. Comes from the call being rendered, never from a
   * home-screen wallet or chain.
   */
  contractAddress?: `0x${string}`;
  /**
   * Render the supporting fact rows (spender, amount, operator, scope)
   * inside the banner.
   *
   * Default `true`, which is what a surface with nowhere else to put
   * them needs — `EvmBatchCallsSheet` renders one banner per call and
   * has no grouped detail cards of its own. `EvmTransactionSheet` sets
   * it `false`: its "Estimated changes" and "Advanced details" cards
   * already carry every one of these fields, and a warning that repeats
   * the same spender and amount a third time reads as noise, which is
   * how a warning stops being read at all.
   */
  factRows?: boolean;
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "red" | "amber";
}): React.ReactElement {
  return (
    <View className="flex-row mt-1">
      <Text
        className={`text-xs w-20 ${tone === "red" ? "text-red-700" : "text-amber-800"}`}
      >
        {label}
      </Text>
      <Text
        className={`text-xs flex-1 ${tone === "red" ? "text-red-900" : "text-amber-900"}`}
        selectable
      >
        {value}
      </Text>
    </View>
  );
}

export function CalldataRiskSection({
  decoded,
  contractAddress,
  factRows = true,
}: Props): React.ReactElement | null {
  const risk = decoded?.risk;
  if (!risk) return null;

  if (risk.kind === "setApprovalForAll") {
    if (!risk.approved) return null;
    return (
      <View className="bg-red-50 border border-red-200 rounded-2xl p-4 mb-3">
        <Text className="text-xs font-bold text-red-800 uppercase">
          High risk: grants control of entire collection
        </Text>
        <Text className="text-sm text-red-900 mt-1">
          {SET_APPROVAL_FOR_ALL_COPY}
        </Text>
        {factRows && (
          <>
            <Row label="Operator" value={risk.operator} tone="red" />
            {contractAddress && (
              <Row label="Collection" value={contractAddress} tone="red" />
            )}
          </>
        )}
      </View>
    );
  }

  if (risk.kind === "delegate") {
    if (!risk.enabled) return null;
    return (
      <View className="bg-red-50 border border-red-200 rounded-2xl p-4 mb-3">
        <Text className="text-xs font-bold text-red-800 uppercase">
          High risk: grants standing rights over your NFTs
        </Text>
        <Text className="text-sm text-red-900 mt-1">{DELEGATE_COPY}</Text>
        {factRows && (
          <>
            <Row label="Delegate" value={risk.delegate} tone="red" />
            <Row
              label="Scope"
              value={
                risk.scope === "all"
                  ? "Everything in this wallet"
                  : risk.scope === "contract"
                    ? `One collection: ${risk.contract ?? "unknown"}`
                    : `One item: ${risk.tokenId?.toString() ?? "unknown"}`
              }
              tone="red"
            />
          </>
        )}
      </View>
    );
  }

  if (risk.kind === "approveNft") {
    return (
      <View className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-3">
        <Text className="text-xs font-bold text-amber-900 uppercase">
          Approves one item
        </Text>
        <Text className="text-sm text-amber-900 mt-1">{APPROVE_NFT_COPY}</Text>
        {factRows && (
          <>
            <Row label="Operator" value={risk.operator} tone="amber" />
            <Row
              label="Item"
              value={`#${risk.tokenId.toString()}`}
              tone="amber"
            />
          </>
        )}
      </View>
    );
  }

  if (risk.kind === "approveUnknownAsset") {
    return (
      <View className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-3">
        <Text className="text-xs font-bold text-amber-900 uppercase">
          Approval, details unconfirmed
        </Text>
        <Text className="text-sm text-amber-900 mt-1">
          {APPROVE_UNKNOWN_COPY}
        </Text>
        {factRows && (
          <>
            <Row label="Spender" value={risk.spender} tone="amber" />
            <Row
              label="Value"
              value={formatRawUint256(risk.value)}
              tone="amber"
            />
            <Row
              label="Value (raw units)"
              value={risk.value.toString()}
              tone="amber"
            />
            <Row label="Value (hex)" value={toHex(risk.value)} tone="amber" />
          </>
        )}
        {risk.looksUnlimited && (
          <Text className="text-sm text-red-900 mt-2 font-semibold">
            {APPROVE_UNKNOWN_UNLIMITED_COPY}
          </Text>
        )}
      </View>
    );
  }

  if (risk.kind === "approve") {
    // Phase N — three states, phrased at three different confidences.
    //
    //   supply known, amount >= supply   fact       "Unlimited approval"
    //   supply unknown, amount >= 2^255  heuristic  "Looks unlimited"
    //   bounded                          fact       the amount itself
    //
    // The middle row is the one that used to be stated as the first.
    if (risk.isUnlimited) {
      const certain = risk.unlimitedBasis === "supply";
      return (
        <View
          className={`border rounded-2xl p-4 mb-3 ${
            certain
              ? "bg-red-50 border-red-200"
              : "bg-amber-50 border-amber-200"
          }`}
        >
          <Text
            className={`text-xs font-bold uppercase ${
              certain ? "text-red-800" : "text-amber-900"
            }`}
          >
            {certain
              ? "Unlimited approval"
              : "Looks like an unlimited approval"}
          </Text>
          <Text
            className={`text-sm mt-1 ${certain ? "text-red-900" : "text-amber-900"}`}
          >
            {certain ? UNLIMITED_APPROVE_COPY : LOOKS_UNLIMITED_APPROVE_COPY}
          </Text>
          {factRows && (
            <>
              <Row
                label="Spender"
                value={risk.spender}
                tone={certain ? "red" : "amber"}
              />
              {contractAddress && (
                <Row
                  label="Token"
                  value={contractAddress}
                  tone={certain ? "red" : "amber"}
                />
              )}
              {risk.decimals !== undefined && (
                <Row
                  label="Amount"
                  value={formatRawUint256(risk.amount)}
                  tone={certain ? "red" : "amber"}
                />
              )}
            </>
          )}
        </View>
      );
    }
    // Bounded, and we know the scale. Neutral by design: this is not a
    // warning, it is the number the user came to check — so when the
    // host sheet already shows that number in its own spending-cap row,
    // this card is pure duplication and steps aside entirely.
    if (risk.decimals !== undefined && factRows) {
      return (
        <View className="bg-white border border-gray-100 rounded-2xl p-4 mb-3">
          <Text className="text-xs font-semibold text-light-matte-black/50 uppercase tracking-wider">
            Token approval
          </Text>
          <Text className="text-sm text-light-matte-black/70 mt-1">
            {BOUNDED_APPROVE_COPY}
          </Text>
          <View className="flex-row mt-1">
            <Text className="text-xs text-light-matte-black/50 w-20">
              Amount
            </Text>
            <Text className="text-xs text-light-matte-black flex-1" selectable>
              {formatTokenAmount(risk.amount, risk.decimals)}
            </Text>
          </View>
          <View className="flex-row mt-1">
            <Text className="text-xs text-light-matte-black/50 w-20">
              Spender
            </Text>
            <Text className="text-xs text-light-matte-black flex-1" selectable>
              {risk.spender}
            </Text>
          </View>
        </View>
      );
    }
    return null;
  }

  return null;
}

/**
 * Base units to a human amount. Falls back to the raw integer when
 * `formatUnits` throws, which a hostile `decimals()` can cause: a wrong
 * big number is worse than an unformatted true one.
 */
function formatTokenAmount(amount: bigint, decimals: number): string {
  try {
    return formatUnits(amount, decimals);
  } catch {
    return amount.toString();
  }
}
