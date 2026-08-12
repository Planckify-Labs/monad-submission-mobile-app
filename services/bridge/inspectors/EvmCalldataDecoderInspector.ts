/**
 * EVM calldata decoder inspector — Stage-1 structural decode parity
 * (task 65 / TWV-2026-066 Phase A).
 *
 * Wraps the existing bundled selector→signature decoder
 * (`services/decoders/calldata.ts#decodeCalldata`) — it does NOT
 * reimplement it — so EVM transactions get the same priority-15
 * "structural fields patched onto the payload" treatment
 * `SolanaProgramDecoderInspector` / `SuiPtbDecoderInspector` /
 * `StellarXdrDecoderInspector` already give their chains. Downstream
 * Stage-2 consumers (clear-signing descriptor resolution, the agent
 * context) read `payload.decoded` / `payload.decodedCalls` without
 * re-parsing.
 *
 * Pure decode, no RPC. Runs before the simulation-class inspectors at
 * priority 20, matching the other Stage-1 decoders.
 */

import type {
  EvmBatchCallsPayload,
  EvmSendTxPayload,
} from "@/services/chains/evm/payloads";
import {
  calldataRiskSeverity,
  decodeCalldata,
} from "@/services/decoders/calldata";
import type { ApprovalIntent } from "../approval";
import type { IntentAnnotation, IntentInspector } from "../inspector";

export const EvmCalldataDecoderInspector: IntentInspector = {
  name: "evm-calldata-decoder",
  priority: 15,
  mode: "auto",
  namespaces: ["eip155"],
  async inspect(intent: ApprovalIntent) {
    if (intent.kind === "sendTransaction") {
      const payload = intent.payload as EvmSendTxPayload;
      // No recipient means contract creation, and its calldata is
      // constructor init-code rather than an ABI-encoded call. Feeding
      // that to a 4-byte selector table produces a confident wrong
      // answer, so leave `decoded` unset and let the sheet render the
      // deployment presentation instead.
      if (payload.to === undefined) {
        return { annotations: [], verdict: "allow" as const };
      }
      // Pass the adapter's contract-type resolution through so the
      // shared `approve` selector resolves to the right risk variant.
      const decoded = decodeCalldata(payload.data, {
        approveTargetKind: payload.approveTarget?.kind,
        totalSupply: payload.approveTarget?.totalSupply,
        decimals: payload.approveTarget?.decimals,
      });
      if (!decoded) {
        return { annotations: [], verdict: "allow" as const };
      }
      return {
        annotations: [],
        verdict: "allow" as const,
        patch: {
          ...(payload as object),
          decoded,
        } as Partial<ApprovalIntent["payload"]>,
      };
    }
    if (intent.kind === "sendCalls") {
      const payload = intent.payload as EvmBatchCallsPayload;
      if (!Array.isArray(payload.calls) || payload.calls.length === 0) {
        return { annotations: [], verdict: "allow" as const };
      }
      // Same rule per batch entry — a creation call inside a batch keeps
      // its `null` slot so the index alignment with `calls` holds. The
      // adapter's per-call approve-target resolution is threaded through
      // so a batched `approve` reaches the same risk variant a
      // standalone one does (spec phase L).
      const decodedCalls = payload.calls.map((c, i) =>
        c.to === undefined
          ? null
          : decodeCalldata(c.data, {
              approveTargetKind: payload.approveTargets?.[i]?.kind,
              totalSupply: payload.approveTargets?.[i]?.totalSupply,
              decimals: payload.approveTargets?.[i]?.decimals,
            }),
      );
      if (decodedCalls.every((d) => d === null)) {
        return { annotations: [], verdict: "allow" as const };
      }
      // Phase L — the risky entry is not reliably the first one, and the
      // sheet's own banner sits inside a scroll view. Raising an
      // annotation puts the same fact in `RiskBanner`, above the fold and
      // outside the list, and feeds the verdict so a flagged batch cannot
      // be waved through by a renderer that forgets to look.
      const flagged = decodedCalls.flatMap((d, i) => {
        const severity = calldataRiskSeverity(d);
        return severity === "none" ? [] : [{ index: i, severity }];
      });
      const annotations: IntentAnnotation[] = [];
      if (flagged.length > 0) {
        const worst = flagged.some((f) => f.severity === "high")
          ? "high"
          : "medium";
        const positions = flagged.map((f) => f.index + 1).join(", ");
        annotations.push({
          code: "evm.batch.risky-call",
          severity: worst === "high" ? "danger" : "warn",
          title:
            flagged.length === 1
              ? `Call ${positions} in this batch needs review`
              : `${flagged.length} calls in this batch need review`,
          detail:
            worst === "high"
              ? `Call ${positions} grants someone standing access to your assets. Check it before you confirm.`
              : `Call ${positions} is an approval we could not fully confirm. Check it before you confirm.`,
          source: "local",
        });
      }
      return {
        annotations,
        verdict:
          flagged.length > 0
            ? ("require-extra-confirmation" as const)
            : ("allow" as const),
        patch: {
          ...(payload as object),
          decodedCalls,
        } as Partial<ApprovalIntent["payload"]>,
      };
    }
    return { annotations: [], verdict: "allow" as const };
  },
};
