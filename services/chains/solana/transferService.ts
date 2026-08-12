/**
 * Small, testable primitives for Solana native-SOL transfers.
 *
 * Spec reference: `docs/solana-chain-support-spec.md` §7.6.
 *
 * Rationale:
 *   - `SolanaWalletKit` (Task 12) needs a "fetch native balance" and a
 *     "build + sign + submit SOL transfer" helper it can call from a
 *     namespace-agnostic surface (`WalletKitAdapter.sendNativeTransfer`).
 *     Keeping these out of the kit lets us unit-test the RPC shape and
 *     the transaction-construction flow without a `TWallet`, a registry,
 *     or an active chain.
 *   - Everything here is `@solana/kit`-only — no `@solana/web3.js`,
 *     no legacy v1 helpers, no `Math.random`. Lamports stay `bigint`
 *     end-to-end per the spec's bigint-in-the-hot-path rule.
 *
 * Public-RPC friendliness:
 *   - `buildAndSendSolTransfer` accepts an *optional* `rpcSubs`. When
 *     omitted (the default for most public endpoints, which rate-limit
 *     WebSocket subscriptions), we fall back to
 *     `rpc.sendTransaction(...).send()` — no WS subscription required.
 *     Callers that have a real subscription endpoint get the nicer
 *     "send-and-confirm" path for free.
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
import { getTransferSolInstruction } from "@solana-program/system";
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

/**
 * Convenience type alias so callers don't have to spell out the generic.
 * `createSolanaRpc(...)` returns this (modulo the cluster nominal type,
 * which we intentionally erase at module boundaries for ergonomics).
 */
export type SolanaRpc = Rpc<SolanaRpcApi>;

/**
 * Mirror of {@link SolanaRpc} for the subscriptions client (WebSocket).
 * Optional in {@link buildAndSendSolTransfer} — see the public-RPC note above.
 */
export type SolanaRpcSubs = RpcSubscriptions<SolanaRpcSubscriptionsApi>;

/**
 * Returns the native SOL balance (in lamports) of the given base58 address.
 *
 * `rpc.getBalance(...)` resolves to `{ context, value }` where `value` is a
 * `Lamports` brand over `bigint`. We coerce through `BigInt(value)` so
 * consumers can rely on a plain `bigint` regardless of what the transport
 * happened to hand us (some JSON transports may deliver `number` for small
 * values until the integer-overflow handler kicks in).
 */
export async function getSolanaBalance(
  rpc: SolanaRpc,
  addressStr: string,
): Promise<bigint> {
  const { value } = await rpc.getBalance(address(addressStr)).send();
  return BigInt(value);
}

/**
 * Returns the minimum lamport balance required to exempt an account of the
 * given size (in bytes) from rent collection.
 *
 * Used downstream by the estimator's fee-reserve calculation (spec §7.6)
 * — `size = 0` gives the baseline native-account rent exemption, which is
 * the value we reserve when computing "max transferable".
 *
 * Keeps the same `bigint`-coercion discipline as {@link getSolanaBalance}.
 */
export async function getSolanaRentExemption(
  rpc: SolanaRpc,
  size: number,
): Promise<bigint> {
  const value = await rpc
    .getMinimumBalanceForRentExemption(BigInt(size))
    .send();
  return BigInt(value);
}

/**
 * Args for {@link buildAndSendSolTransfer}.
 *
 * `rpcSubs` is optional by design — see the module header. `signer` is a
 * plain {@link TransactionSigner}, which covers `KeyPairSigner` (Task 10's
 * dwell site) *and* the no-op signer used by tests.
 */
export type BuildAndSendSolTransferArgs = {
  rpc: SolanaRpc;
  rpcSubs?: SolanaRpcSubs | undefined;
  signer: TransactionSigner;
  /** Recipient base58 address. Coerced via `address()` at the boundary. */
  to: string;
  /** Amount in lamports. Never a `number`. */
  lamports: bigint;
};

/**
 * Build, sign, and submit a native-SOL transfer. Returns the base58
 * transaction signature (same value `getSignatureFromTransaction` produces
 * locally — the RPC's returned signature is not trusted as the source of
 * truth per kit best practice).
 *
 * Flow (matches spec §7.6 exactly):
 *   1. Fetch latest blockhash (`confirmed` commitment is the RPC default).
 *   2. Pipe a v0 transaction message through: fee-payer → lifetime →
 *      append `getTransferSolInstruction(...)`.
 *   3. Sign with `signTransactionMessageWithSigners` (resolves every
 *      `TransactionSigner` referenced by the message — in this case just
 *      the fee payer, which doubles as the transfer source).
 *   4. Submit:
 *      - If `rpcSubs` is provided, use `sendAndConfirmTransactionFactory`
 *        with `commitment: "confirmed"`.
 *      - Otherwise, use `rpc.sendTransaction(wire, { encoding: "base64" })`
 *        directly — public-RPC-friendly fallback, no WS.
 *   5. Return `getSignatureFromTransaction(signedTx)`.
 */
export async function buildAndSendSolTransfer(
  args: BuildAndSendSolTransferArgs,
): Promise<Signature> {
  const { rpc, rpcSubs, signer, to, lamports } = args;

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  // Phase J — priority fee scoped to the accounts this transfer actually
  // locks, so an uncontended transfer does not pay a hot account's
  // premium. Bounded: a fee oracle that hangs must not block the send.
  const destination = address(to) as Address;
  const microLamports = await withFeeTimeout(
    fetchPriorityFee(rpc, [signer.address, destination]),
    PRIORITY_FEE_TIMEOUT_MS,
    DEFAULT_MICRO_LAMPORTS_PER_CU,
  );

  const build = (unitLimit: number) =>
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      // Compute budget goes first: the runtime reads these before the
      // instructions they govern.
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
      (m) =>
        appendTransactionMessageInstruction(
          getTransferSolInstruction({
            source: signer,
            destination,
            amount: lamports,
          }),
          m,
        ),
    );

  // Two passes: a generous provisional limit so simulation can run, then
  // a limit sized to what the run actually cost. A tight limit is
  // cheaper, and the default 200k over-reserves for a bare transfer.
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
    // `sendAndConfirmTransactionFactory` requires a subscriptions client;
    // callers without one take the fallback below.
    const sendAndConfirm = sendAndConfirmTransactionFactory({
      // The factory is typed per-cluster (devnet/testnet/mainnet). We
      // erased the cluster nominal type at the module boundary, so cast
      // through `never` just for the factory call — runtime behaviour is
      // cluster-agnostic.
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
