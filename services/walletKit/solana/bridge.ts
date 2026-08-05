/**
 * Solana bridge capability — CAIP ids, execution, destination readiness.
 *
 * Spec: docs/bridge-capability-spec.md §5.1, §5.2, §7.5.
 *
 * Docked onto `SolanaWalletKit` as optional, presence-checked methods
 * (`feedback_space_docking`).
 *
 * Solana's destination precondition is NOT gas in the EVM sense: the
 * account needs an associated token account for the incoming mint, and
 * that account needs rent. That is exactly why §10.4 reframed the problem
 * from "does the destination need an approve?" to per-namespace
 * readiness — the EVM answer does not generalise.
 */

import {
  address,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  getBase64EncodedWireTransaction,
  type KeyPairSigner,
  partiallySignTransaction,
  sendAndConfirmTransactionFactory,
} from "@solana/kit";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import {
  base64ToTransaction,
  bytesToBase58,
} from "@/services/chains/solana/codec";
import { getSolanaSignerForWallet } from "@/services/walletService";
import {
  type BridgeDestinationReadinessArgs,
  BridgePayloadUnsupportedError,
  type BridgeReadinessBlocker,
  type SubmitBridgeExecutionArgs,
} from "../types";

const SOLANA_NAMESPACE = "solana" as const;

/**
 * CAIP-2 references for Solana are the first 32 chars of the cluster's
 * genesis hash, per the CAIP-30 Solana namespace definition.
 */
const CLUSTER_CAIP2_REFERENCE: Record<string, string> = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
};

/** SLIP-44 coin type for SOL. */
const SLIP44_SOL = "501";

export function solanaCaip2For(chain: ChainConfig): string | null {
  if (chain.namespace !== SOLANA_NAMESPACE) return null;
  const reference = CLUSTER_CAIP2_REFERENCE[chain.cluster];
  return reference ? `${SOLANA_NAMESPACE}:${reference}` : null;
}

export function solanaToAssetCaip19(
  chain: ChainConfig,
  contractAddress?: string | null,
): string | null {
  const caip2 = solanaCaip2For(chain);
  if (!caip2) return null;
  if (!contractAddress) return `${caip2}/slip44:${SLIP44_SOL}`;
  // Base58 mints are CASE-SENSITIVE — never fold them
  // (`feedback_address_case_per_encoding`).
  return `${caip2}/token:${contractAddress}`;
}

/**
 * Sign and submit the provider-serialised Solana transaction.
 *
 * LI.FI hands back an already-built versioned transaction, so we sign
 * over the existing message bytes rather than rebuilding instructions —
 * rewriting them would invalidate the route the quote was priced against.
 */
export async function solanaSubmitBridgeExecution({
  wallet,
  chain,
  payload,
}: SubmitBridgeExecutionArgs): Promise<string> {
  if (payload.kind !== "serialized_transaction") {
    throw new BridgePayloadUnsupportedError(payload.kind);
  }
  if (chain.namespace !== SOLANA_NAMESPACE) {
    throw new BridgePayloadUnsupportedError(payload.kind);
  }
  if (payload.encoding !== "base64") {
    throw new BridgePayloadUnsupportedError(payload.kind);
  }

  // The wallet bound to THIS intent, never a home-screen fallback
  // (`feedback_dapp_bridge_isolation`).
  const signer: KeyPairSigner | null = await getSolanaSignerForWallet(wallet);
  if (!signer) {
    throw new Error("SolanaWalletKit.submitBridgeExecution: no signer");
  }

  const tx = base64ToTransaction(payload.payload);
  const signed = await partiallySignTransaction([signer.keyPair], tx);

  const rpc = createSolanaRpc(chain.rpcUrl);
  const wire = getBase64EncodedWireTransaction(signed);

  if (chain.rpcSubscriptionsUrl) {
    const rpcSubscriptions = createSolanaRpcSubscriptions(
      chain.rpcSubscriptionsUrl,
    );
    const sendAndConfirm = sendAndConfirmTransactionFactory({
      rpc,
      rpcSubscriptions,
    });
    await sendAndConfirm(signed as Parameters<typeof sendAndConfirm>[0], {
      commitment: "confirmed",
    });
  } else {
    await rpc
      .sendTransaction(wire, { encoding: "base64", skipPreflight: false })
      .send();
  }

  const signatureBytes = signed.signatures[signer.address];
  if (!signatureBytes) {
    throw new Error(
      "SolanaWalletKit.submitBridgeExecution: signature slot not filled",
    );
  }
  return bytesToBase58(signatureBytes);
}

/**
 * Rent for a token account is ~0.00204 SOL; a little SOL on top covers the
 * fee to move the funds afterwards.
 */
const MIN_LAMPORTS = 5_000_000n; // 0.005 SOL

const SUGGESTED_TOP_UP_USD = 2;

/**
 * Solana destination readiness.
 *
 * Two distinct blockers, not one:
 *   - No associated token account for the incoming mint, and not enough
 *     SOL to create one. The transfer itself can create the ATA, but only
 *     if rent is available.
 *   - No SOL at all, so the user cannot move the funds afterwards.
 */
export async function solanaCheckBridgeDestinationReadiness({
  chain,
  address: destination,
  contractAddress,
}: BridgeDestinationReadinessArgs): Promise<BridgeReadinessBlocker[]> {
  if (chain.namespace !== SOLANA_NAMESPACE) return [];

  const rpc = createSolanaRpc(chain.rpcUrl);

  let lamports: bigint;
  try {
    const { value } = await rpc.getBalance(address(destination)).send();
    lamports = BigInt(value);
  } catch {
    // A check that cannot run must not invent a blocker — a false "no SOL"
    // on a healthy account trains users to dismiss the real one.
    return [];
  }

  const blockers: BridgeReadinessBlocker[] = [];

  if (contractAddress) {
    let hasTokenAccount = false;
    try {
      const { value: accounts } = await rpc
        .getTokenAccountsByOwner(
          address(destination),
          { mint: address(contractAddress) },
          { encoding: "jsonParsed" },
        )
        .send();
      hasTokenAccount = accounts.length > 0;
    } catch {
      // Treat an unreadable account list as "present" rather than warning
      // on incomplete information.
      hasTokenAccount = true;
    }

    if (!hasTokenAccount && lamports < MIN_LAMPORTS) {
      blockers.push({
        code: "missing_token_account",
        message:
          "This Solana account has not held this token before and has no SOL to set it up. The transfer may not arrive.",
        severity: "blocking",
        remedy: { kind: "gas_top_up", suggestedUsd: SUGGESTED_TOP_UP_USD },
      });
    }
  }

  if (lamports < MIN_LAMPORTS && blockers.length === 0) {
    blockers.push({
      code: "no_destination_gas",
      message:
        "You have no SOL on Solana. You will not be able to move these funds after they arrive.",
      severity: "warning",
      remedy: { kind: "gas_top_up", suggestedUsd: SUGGESTED_TOP_UP_USD },
    });
  }

  return blockers;
}
