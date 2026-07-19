/**
 * Generic Soroban contract-invocation flow (build → simulate → assemble →
 * sign → submit → poll), hand-rolled on `@stellar/stellar-base` primitives so
 * the app takes no `@stellar/stellar-sdk` dependency (same posture as the rest
 * of `services/chains/stellar/`). This is the Stellar analogue of Solana's
 * "build a versioned tx from instructions, sign, broadcast" primitive — the
 * chain-generic half that `StellarWalletKit.sendSorobanTransaction` delegates
 * to; the contract-specific argument encoding lives in the caller
 * (`takumiPay/` + `pathOnchainSettlementStellar.ts`).
 *
 * The signature-bearing steps replicate what `@stellar/stellar-sdk`'s
 * `rpc.assembleTransaction` + `Server.prepareTransaction` do:
 *   1. Build the invocation tx with a placeholder fee and no Soroban data.
 *   2. `simulateTransaction` → footprint + resource fee + required auth.
 *   3. Sign each ADDRESS-credential auth entry with the payer key
 *      (`authorizeEntry`); SOURCE_ACCOUNT entries need no separate signature
 *      (the envelope signature covers them).
 *   4. `cloneFrom` the tx, add the resource fee, attach the Soroban data +
 *      signed auth, sign the envelope, submit, and poll `getTransaction`.
 *
 * All base64/XDR serialization goes through `transactionToBase64Xdr`
 * (`toEnvelope().toXDR("raw")` + `bytesToBase64`), never `tx.toXDR("base64")`,
 * to dodge the Hermes `Buffer.toString("base64")` bug documented in
 * `base64.ts`.
 */

import {
  Account,
  authorizeEntry,
  BASE_FEE,
  Contract,
  type Keypair,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-base";
import {
  type StellarHorizonClient,
  transactionToBase64Xdr,
} from "./horizonClient";
import { type SorobanRpcClient, SorobanRpcError } from "./sorobanRpcClient";

/** Envelope timeout — a Soroban settlement should confirm in seconds; 5 min is generous. */
const TX_TIMEOUT_SECS = 300;
/** Auth-entry validity window past the simulation ledger (~5 min at 5s/ledger). */
const AUTH_VALID_LEDGER_BUFFER = 100;
const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_ATTEMPTS = 30; // ~60s of confirmation polling

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface InvokeSorobanArgs {
  rpc: SorobanRpcClient;
  /** Used only to read the source account's current sequence number. */
  horizon: StellarHorizonClient;
  /** The payer keypair — both the tx source account and the required authorizer. */
  signer: Keypair;
  contractId: string;
  method: string;
  args: xdr.ScVal[];
}

/**
 * Invoke `contractId.method(...args)` with the payer as source + authorizer.
 * Returns the confirmed transaction hash. Throws `SorobanRpcError` on
 * simulation error, submission rejection, on-chain failure, or confirmation
 * timeout.
 */
export async function invokeSorobanContract(
  a: InvokeSorobanArgs,
): Promise<string> {
  const sourceAddr = a.signer.publicKey();
  const loaded = await a.horizon.loadAccount(sourceAddr);
  const account = new Account(sourceAddr, loaded.sequence);

  const op = new Contract(a.contractId).call(a.method, ...a.args);

  const simTx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: a.rpc.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(TX_TIMEOUT_SECS)
    .build();

  const sim = await a.rpc.simulateTransaction(transactionToBase64Xdr(simTx));

  // Sign the required auth. ADDRESS-credential entries need the payer's
  // signature (authorizeEntry); SOURCE_ACCOUNT entries are satisfied by the
  // envelope signature we add below.
  const validUntilLedger = sim.latestLedger + AUTH_VALID_LEDGER_BUFFER;
  const signedAuth: xdr.SorobanAuthorizationEntry[] = [];
  for (const entryB64 of sim.auth) {
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(entryB64, "base64");
    const isSourceCredential =
      entry.credentials().switch().name === "sorobanCredentialsSourceAccount";
    signedAuth.push(
      isSourceCredential
        ? entry
        : await authorizeEntry(
            entry,
            a.signer,
            validUntilLedger,
            a.rpc.networkPassphrase,
          ),
    );
  }

  // Reassemble: same source/sequence, base fee + resource fee, the simulated
  // Soroban footprint, and the signed auth attached to the host function.
  const hostFunction = op.body().invokeHostFunctionOp().hostFunction();
  const sorobanData = new SorobanDataBuilder(sim.transactionData).build();
  const fee = (
    parseInt(BASE_FEE, 10) + parseInt(sim.minResourceFee, 10)
  ).toString();

  const builder = TransactionBuilder.cloneFrom(simTx, { fee });
  builder.clearOperations();
  builder.addOperation(
    Operation.invokeHostFunction({ func: hostFunction, auth: signedAuth }),
  );
  builder.setSorobanData(sorobanData);
  const finalTx = builder.build();

  finalTx.sign(a.signer);

  const sent = await a.rpc.sendTransaction(transactionToBase64Xdr(finalTx));
  if (sent.status === "ERROR") {
    throw new SorobanRpcError(
      "Soroban sendTransaction rejected the invocation",
      undefined,
      sent,
    );
  }
  const hash = sent.hash;

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await delay(POLL_INTERVAL_MS);
    const got = await a.rpc.getTransaction(hash);
    if (got.status === "SUCCESS") {
      return hash;
    }
    if (got.status === "FAILED") {
      throw new SorobanRpcError(
        "Soroban transaction failed on-chain",
        undefined,
        got,
      );
    }
    // NOT_FOUND → still pending; keep polling.
  }

  throw new SorobanRpcError(
    `Soroban transaction ${hash} not confirmed after polling`,
    undefined,
    { hash },
  );
}
