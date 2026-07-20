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
import { decodeCalldata } from "@/services/decoders/calldata";
import type { ApprovalIntent } from "../approval";
import type { IntentInspector } from "../inspector";

export const EvmCalldataDecoderInspector: IntentInspector = {
  name: "evm-calldata-decoder",
  priority: 15,
  mode: "auto",
  namespaces: ["eip155"],
  async inspect(intent: ApprovalIntent) {
    if (intent.kind === "sendTransaction") {
      const payload = intent.payload as EvmSendTxPayload;
      const decoded = decodeCalldata(payload.data);
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
      const decodedCalls = payload.calls.map((c) => decodeCalldata(c.data));
      if (decodedCalls.every((d) => d === null)) {
        return { annotations: [], verdict: "allow" as const };
      }
      return {
        annotations: [],
        verdict: "allow" as const,
        patch: {
          ...(payload as object),
          decodedCalls,
        } as Partial<ApprovalIntent["payload"]>,
      };
    }
    return { annotations: [], verdict: "allow" as const };
  },
};
