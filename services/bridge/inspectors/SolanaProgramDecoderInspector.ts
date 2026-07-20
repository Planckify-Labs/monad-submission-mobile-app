/**
 * Solana program decoder inspector — parses the wire-format tx into
 * structural fields + decoded instructions so the sheet, the agent,
 * and downstream inspectors have ready-to-read data.
 *
 * Runs at priority 15 (before simulation at 20) so the simulation
 * inspector can consume `feePayer` / `signerAccounts` when emitting
 * writable-account warnings.
 *
 * Agent-context contract (§4.9 + user brief): every signTransaction
 * intent arrives at the approval sheet with:
 *   - payload.decoded         — ordered instruction list
 *   - payload.feePayer        — tx fee payer (static key 0)
 *   - payload.signerAddresses — required signers (not just active wallet)
 *   - payload.altReferences   — v0 ALT lookups the tx cites
 *   - payload.durableNonce    — { isDurableNonce, nonceAccount, authority }
 * The Takumi-AI on-demand inspector walks these without re-parsing.
 */

import { detectDurableNonce } from "@/services/chains/solana/durableNonce";
import type { SolanaSignTxPayload } from "@/services/chains/solana/payloads";
import { decodeInstructions } from "@/services/chains/solana/programDecoder";
import {
  parseWireTransaction,
  signerAccounts,
  writableAccounts,
} from "@/services/chains/solana/txMessageParser";
import type { ApprovalIntent } from "../approval";
import type { IntentInspector } from "../inspector";

export const SolanaProgramDecoderInspector: IntentInspector = {
  name: "solana-program-decoder",
  priority: 15,
  mode: "auto",
  namespaces: ["solana"],
  async inspect(intent: ApprovalIntent) {
    if (intent.kind !== "signTransaction") {
      return { annotations: [], verdict: "allow" };
    }
    const payload = intent.payload as SolanaSignTxPayload;
    if (!payload.transaction) {
      return { annotations: [], verdict: "allow" };
    }

    const parsed = parseWireTransaction(payload.transaction);
    if (!parsed) {
      // Malformed / unsupported wire; sheet shows raw base64 and agent
      // still sees the payload it can decode itself.
      return { annotations: [], verdict: "allow" };
    }

    const rawInstructions = parsed.instructions.map((ix) => ({
      programId: ix.programId,
      accounts: ix.accounts,
      data: ix.data,
    }));
    const decoded = decodeInstructions(rawInstructions);

    const nonce = detectDurableNonce(
      parsed.instructions[0]
        ? {
            programId: parsed.instructions[0].programId,
            accounts: parsed.instructions[0].accounts,
            data: parsed.instructions[0].data,
          }
        : null,
    );

    return {
      annotations: [],
      verdict: "allow",
      patch: {
        ...(payload as object),
        decoded,
        // Task 65: Stage-2 clear-signing (on-chain IDL) needs the raw
        // instruction bytes the decoded view drops.
        rawInstructions,
        feePayer: parsed.feePayer,
        signerAddresses: signerAccounts(parsed),
        writableAddresses: writableAccounts(parsed),
        accountKeys: parsed.accountKeys,
        altReferences: parsed.addressTableLookups,
        durableNonce: nonce,
        version: parsed.version,
      } as Partial<ApprovalIntent["payload"]>,
    };
  },
};
