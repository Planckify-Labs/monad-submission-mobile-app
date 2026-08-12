/**
 * SPL / Token-2022 transfer primitives for Solana.
 *
 * Mirrors `transferService.ts` (native SOL transfers) but for fungible
 * tokens under both the classic SPL Token program and Token-2022.
 *
 * Uses `@solana-program/token` + `@solana-program/token-2022` (codama
 * generated, `@solana/kit`-native) so the build path stays consistent
 * with `buildAndSendSolTransfer`.
 *
 * Flow:
 *   1. Fetch the mint account to detect which token program owns it.
 *   2. Derive sender + recipient ATAs via `findAssociatedTokenPda`
 *      with the correct `tokenProgram`.
 *   3. Prepend `createAssociatedTokenIdempotent` for the recipient ATA
 *      (no-ops if it already exists, avoids a preflight RPC call).
 *   4. Append `transferChecked` (requires `decimals` — guards against
 *      mint-mismatch at the protocol level).
 *   5. Sign + submit via the same blockhash → sign → send pipeline as
 *      native transfers.
 */

import type {
  Address,
  Base64EncodedWireTransaction,
  Rpc,
  RpcSubscriptions,
  Signature,
  SolanaRpcApi,
  SolanaRpcSubscriptionsApi,
  TransactionSigner,
} from "@solana/kit";
import {
  address,
  appendTransactionMessageInstruction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import {
  DEFAULT_MICRO_LAMPORTS_PER_CU,
  fetchPriorityFee,
  PRIORITY_FEE_TIMEOUT_MS,
  PROVISIONAL_COMPUTE_UNITS,
  setComputeUnitLimitInstruction,
  setComputeUnitPriceInstruction,
  simulateComputeUnits,
  withFeeTimeout,
} from "./priorityFee";

export type SolanaRpc = Rpc<SolanaRpcApi>;
export type SolanaRpcSubs = RpcSubscriptions<SolanaRpcSubscriptionsApi>;

const KNOWN_TOKEN_PROGRAMS = new Set<string>([
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
]);

/**
 * Fetches the mint account's owner program to determine SPL Token vs
 * Token-2022. Falls back to the classic SPL Token program if the account
 * lookup fails (defensive — the tx will fail anyway if the mint is bad).
 */
async function detectTokenProgram(
  rpc: SolanaRpc,
  mintAddr: Address,
): Promise<Address> {
  const { value } = await rpc
    .getAccountInfo(mintAddr, { encoding: "base64" })
    .send();
  if (value?.owner && KNOWN_TOKEN_PROGRAMS.has(value.owner)) {
    return value.owner as Address;
  }
  return TOKEN_PROGRAM_ADDRESS;
}

export type BuildAndSendSplTransferArgs = {
  rpc: SolanaRpc;
  rpcSubs?: SolanaRpcSubs | undefined;
  signer: TransactionSigner;
  to: string;
  mint: string;
  amount: bigint;
  decimals: number;
};

export async function buildAndSendSplTransfer(
  args: BuildAndSendSplTransferArgs,
): Promise<Signature> {
  const { rpc, rpcSubs, signer, to, mint, amount, decimals } = args;

  const mintAddr = address(mint);
  const ownerAddr = address(signer.address);
  const recipientAddr = address(to);

  const tokenProgram = await detectTokenProgram(rpc, mintAddr);

  const [senderAta] = await findAssociatedTokenPda({
    owner: ownerAddr,
    mint: mintAddr,
    tokenProgram,
  });

  const [recipientAta] = await findAssociatedTokenPda({
    owner: recipientAddr,
    mint: mintAddr,
    tokenProgram,
  });

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const createAtaIx = getCreateAssociatedTokenIdempotentInstruction({
    payer: signer,
    ata: recipientAta,
    owner: recipientAddr,
    mint: mintAddr,
    tokenProgram,
  });

  const transferIx = getTransferCheckedInstruction(
    {
      source: senderAta,
      mint: mintAddr,
      destination: recipientAta,
      authority: signer,
      amount,
      decimals,
    },
    { programAddress: tokenProgram },
  );

  // Phase J — same treatment as the native path. Writable set is the
  // sender's token account, the recipient's, and the fee payer; the
  // mint is read-only so it does not belong in the contention scope.
  const microLamports = await withFeeTimeout(
    fetchPriorityFee(rpc, [signer.address, senderAta, recipientAta]),
    PRIORITY_FEE_TIMEOUT_MS,
    DEFAULT_MICRO_LAMPORTS_PER_CU,
  );

  const build = (unitLimit: number) =>
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) =>
        appendTransactionMessageInstruction(
          setComputeUnitLimitInstruction(unitLimit),
          m,
        ),
      (m) =>
        appendTransactionMessageInstruction(
          setComputeUnitPriceInstruction(microLamports),
          m,
        ),
      (m) => appendTransactionMessageInstruction(createAtaIx, m),
      (m) => appendTransactionMessageInstruction(transferIx, m),
    );

  const provisional = await signTransactionMessageWithSigners(
    build(PROVISIONAL_COMPUTE_UNITS),
  );
  const measured = await withFeeTimeout(
    simulateComputeUnits(rpc, getBase64EncodedWireTransaction(provisional)),
    PRIORITY_FEE_TIMEOUT_MS,
    null,
  );
  const signed =
    measured === null
      ? provisional
      : await signTransactionMessageWithSigners(build(measured));

  if (rpcSubs) {
    const sendAndConfirm = sendAndConfirmTransactionFactory({
      rpc: rpc as never,
      rpcSubscriptions: rpcSubs as never,
    });
    await sendAndConfirm(signed, { commitment: "confirmed" });
  } else {
    const wire = getBase64EncodedWireTransaction(signed);
    await rpc
      .sendTransaction(wire as Base64EncodedWireTransaction, {
        encoding: "base64",
      })
      .send();
  }

  return getSignatureFromTransaction(signed);
}
