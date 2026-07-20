/**
 * `signX402SvmPayment` — Solana x402 payment signer (spec §5.2.1, §5.5,
 * milestone M6).
 *
 * This module is the Path B-SVM counterpart to
 * `services/walletKit/evm/signTransferWithAuthorization.ts`. Given a
 * base64-encoded versioned Solana transaction pre-built by the backend
 * (ComputeBudget × 2, SPL Token `TransferChecked`, optional Memo per
 * §5.2.1 wire format) — already partially signed with the facilitator's
 * fee-payer slot as a placeholder — this signer adds the user's
 * signature over the message bytes and returns the updated base64 tx.
 *
 * Isolated from `SolanaWalletKit.ts` so the pure signing path is
 * Node-testable without pulling the kit's keystore transitive imports
 * (`expo-secure-store`, MMKV, …) into the test harness. The kit wraps
 * this with a `getSolanaSignerForWallet` lookup so the private key
 * never leaves the `services/walletService.ts` dwell site (TWV-2026-070).
 *
 * Rules (non-negotiable — enforced by spec + review):
 *   - Adapter signs only. Submission is the backend facilitator's job
 *     (task 43 — SVM facilitator backend). No network I/O here.
 *     Memory: `feedback_role_separation.md`.
 *   - Instruction list MUST NOT be mutated. `partiallySignTransaction`
 *     from `@solana/kit` is chosen precisely because it signs over the
 *     existing `messageBytes` — rewriting instructions would invalidate
 *     the scheme (spec §5.2.1: "facilitator already expects the
 *     instructions verbatim").
 *   - Fee-payer signature slot is not touched. The facilitator attaches
 *     it at settle time; the wallet only fills its own slot.
 *   - Never log `messageBytes`, signatures, or the signer's keyPair.
 *     On failure, propagate the thrown error — the adapter's caller
 *     surfaces a bounded `__DEV__` breadcrumb (matching the pattern in
 *     `services/chains/solana/signer.ts`).
 *   - No `react` / `react-native` / `expo` imports — this module must
 *     run under the Node `--experimental-strip-types` test harness.
 *
 * TODO(spec §12 Q7): the x402 SVM RFC
 * (`github.com/coinbase/x402/issues/646` — Deadline Validation + Smart
 * Wallet Support) may add additional authorization fields (e.g. a
 * pre-hashed "authorization digest" the wallet signs alongside the tx).
 * If that lands before M6 ships, the extra field becomes a second
 * argument here and the facilitator proxy (task 43) forwards it
 * through. Until then the partial-sign path matches the current
 * `scheme_exact_svm` draft.
 */

import type { KeyPairSigner, Transaction } from "@solana/kit";
import { partiallySignTransaction } from "@solana/kit";

import {
  base64ToTransaction,
  transactionToBase64,
} from "../../chains/solana/codec.ts";
import { SvmSignerUnavailableError } from "../types.ts";
import { computeSolanaSigningDigest } from "./clearSigning.ts";

/**
 * Pure signing primitive — given a kit `KeyPairSigner` and a base64
 * partially-signed versioned transaction, returns the updated base64
 * tx with the user's signature attached. Exported separately from the
 * adapter entry-point so `services/nanopay/submitAuthorization.ts`
 * (task 17's SVM equivalent, shipped in task 43) can reuse the same
 * primitive on the test bench against a throwaway signer — no kit
 * registry, no `expo-secure-store`, no `walletService` required.
 */
export async function signX402SvmPaymentWithSigner(
  signer: KeyPairSigner,
  transactionBase64: string,
): Promise<string> {
  // Decode the facilitator-authored wire transaction back into a kit
  // `Transaction` (readonly `{ messageBytes, signatures }`). The
  // `signatures` map already carries the fee-payer placeholder slot
  // — we never touch that entry; `partiallySignTransaction` only
  // writes to the slot whose address matches `signer.keyPair`'s
  // public key.
  const tx: Transaction = base64ToTransaction(transactionBase64);

  // Task 65 (TWV-2026-066) Phase C — defense-in-depth: log the
  // SHA-256 of the exact message bytes being signed even though this
  // first-party flow has no dedicated approval sheet. Cross-checkable
  // against the facilitator's copy of the same transaction.
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    const digest = await computeSolanaSigningDigest({
      kind: "transaction",
      transaction: transactionBase64,
    });
    console.log(
      "[clear-signing] x402 SVM message SHA-256:",
      digest?.values[0]?.value,
    );
  }

  // `partiallySignTransaction` (as opposed to `signTransaction`) does
  // NOT assert the transaction is fully signed afterward. This is the
  // whole point of Path B-SVM: the fee-payer slot stays empty until
  // the facilitator adds its signature at settle time.
  const signed = await partiallySignTransaction([signer.keyPair], tx);

  return transactionToBase64(signed);
}

/**
 * Narrow helper used by the kit entry-point. Throws a typed
 * `SvmSignerUnavailableError` when the wallet lookup returns `null`
 * so UI (`app/pay-merchant.tsx`) can catch by `name` without
 * re-parsing the message.
 */
export function assertSolanaSigner(
  signer: KeyPairSigner | null,
  walletAddress: string,
): asserts signer is KeyPairSigner {
  if (!signer) {
    throw new SvmSignerUnavailableError(walletAddress);
  }
}
