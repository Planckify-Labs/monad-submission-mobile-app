/**
 * Stellar XDR decoder inspector — pure decode, no RPC.
 *
 * Calls `decodeStellarTransaction(payload.xdr, payload.networkPassphrase)`
 * and patches the intent payload with structural fields: `sourceAccount`,
 * `fee`, `sequence`, `memo`, and `decoded: StellarDecodedOperation[]`.
 *
 * Spec reference: `docs/stellar-dapp-bridge-spec.md` §8.1.
 *
 * Runs at priority 15 (matches `SuiPtbDecoderInspector`/
 * `SolanaProgramDecoderInspector`) so `StellarPreflightInspector` at
 * priority 20 can consume the decoded destination/asset fields.
 */

import type { StellarSignTransactionPayload } from "@/services/chains/stellar/payloads";
import { decodeStellarTransaction } from "@/services/chains/stellar/xdrDecode";
import type { ApprovalIntent } from "../approval";
import type { IntentAnnotation, IntentInspector } from "../inspector";

/** Stellar's own "no cap" convention — the max i64 sentinel value. */
const UNLIMITED_TRUSTLINE_LIMIT = "922337203685.4775807";

const HIGH_OPERATION_COUNT = 20;

export const StellarXdrDecoderInspector: IntentInspector = {
  name: "stellar-xdr-decoder",
  priority: 15,
  mode: "auto",
  namespaces: ["stellar"],
  async inspect(intent: ApprovalIntent) {
    if (intent.kind !== "signTransaction") {
      return { annotations: [], verdict: "allow" };
    }
    const payload = intent.payload as StellarSignTransactionPayload;
    if (!payload.xdr || !payload.networkPassphrase) {
      return { annotations: [], verdict: "allow" };
    }

    let decoded: ReturnType<typeof decodeStellarTransaction>;
    try {
      decoded = decodeStellarTransaction(
        payload.xdr,
        payload.networkPassphrase,
      );
    } catch {
      // Malformed XDR — the adapter already validates this pre-enqueue
      // (`StellarAdapter#handleSignTransaction`), so reaching here with
      // a decode failure is unexpected. Skip silently rather than
      // blocking the sheet; the raw-bytes fallback view still renders.
      return { annotations: [], verdict: "allow" };
    }

    const annotations: IntentAnnotation[] = [];

    if (
      payload.address &&
      decoded.sourceAccount &&
      payload.address.toLowerCase() !== decoded.sourceAccount.toLowerCase()
    ) {
      annotations.push({
        code: "sender.mismatch",
        severity: "warn",
        title: "Sender address mismatch",
        detail: `The transaction's source account (${decoded.sourceAccount}) does not match the connected wallet (${payload.address}).`,
        source: "stellar-xdr-decoder",
      });
    }

    if (
      decoded.operations.some(
        (op) =>
          op.kind === "changeTrust" && op.limit === UNLIMITED_TRUSTLINE_LIMIT,
      )
    ) {
      annotations.push({
        code: "trustline.unlimited-limit",
        severity: "info",
        title: "Unlimited trustline limit",
        detail:
          'This sets no cap on how much of the asset the account can hold — Stellar\'s own convention for "no limit," not a numeric ceiling.',
        source: "stellar-xdr-decoder",
      });
    }

    if (decoded.operations.length > HIGH_OPERATION_COUNT) {
      annotations.push({
        code: "operation.high-count",
        severity: "warn",
        title: "Unusually large operation batch",
        detail: `This transaction bundles ${decoded.operations.length} operations.`,
        source: "stellar-xdr-decoder",
      });
    }

    if (decoded.operations.some((op) => op.kind === "invokeHostFunction")) {
      annotations.push({
        code: "soroban.invoke-host-function",
        severity: "danger",
        title: "Soroban contract invocation",
        detail:
          "This transaction invokes a smart contract. TakumiPay cannot decode Soroban operations yet. Review carefully before signing.",
        source: "stellar-xdr-decoder",
      });
    }

    return {
      annotations,
      verdict: "allow",
      patch: {
        ...(payload as object),
        sourceAccount: decoded.sourceAccount,
        fee: decoded.fee,
        sequence: decoded.sequence,
        memo: decoded.memo,
        decoded: decoded.operations,
      } as Partial<ApprovalIntent["payload"]>,
    };
  },
};
