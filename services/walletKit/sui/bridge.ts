/**
 * Sui bridge capability — CAIP ids, execution, destination readiness.
 *
 * Spec: docs/bridge-capability-spec.md §5.1, §5.2, §7.5.
 *
 * Docked onto `SuiWalletKit` as optional, presence-checked methods
 * (`feedback_space_docking`).
 *
 * Sui reaches CCTP through LI.FI's `mayanMCTP` (§2.1), which is fine and
 * already works — CCTP V2 does not list Sui, so a direct Sui CCTP adapter
 * would need V1 and buys us nothing (§2.3).
 */

import { fromBase64 } from "@mysten/bcs";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import { getSuiSignerForWallet } from "@/services/walletService";
import {
  type BridgeDestinationReadinessArgs,
  BridgePayloadUnsupportedError,
  type BridgeReadinessBlocker,
  type SubmitBridgeExecutionArgs,
} from "../types";

const SUI_NAMESPACE = "sui" as const;

/** Sui's own gas coin, modelled as an ordinary coin type. */
const SUI_COIN_TYPE = "0x2::sui::SUI";

export function suiCaip2For(chain: ChainConfig): string | null {
  // Sui's CAIP-2 reference is the network name, and unlike Stellar it
  // matches this app's internal `network` value exactly, so no
  // translation is needed.
  return chain.namespace === SUI_NAMESPACE
    ? `${SUI_NAMESPACE}:${chain.network}`
    : null;
}

export function suiToAssetCaip19(
  chain: ChainConfig,
  contractAddress?: string | null,
): string | null {
  const caip2 = suiCaip2For(chain);
  if (!caip2) return null;
  // Sui has no separate native namespace: the gas token IS a coin type.
  return `${caip2}/coin:${contractAddress || SUI_COIN_TYPE}`;
}

/**
 * Sign and execute the provider-built PTB.
 *
 * Re-hydrates and signs the exact bytes the quote was priced against —
 * never rebuilds the transaction, mirroring `signAndExecuteSuiPtb`.
 */
export async function suiSubmitBridgeExecution({
  wallet,
  chain,
  payload,
}: SubmitBridgeExecutionArgs): Promise<string> {
  if (payload.kind !== "serialized_transaction") {
    throw new BridgePayloadUnsupportedError(payload.kind);
  }
  if (chain.namespace !== SUI_NAMESPACE) {
    throw new BridgePayloadUnsupportedError(payload.kind);
  }
  if (payload.encoding !== "base64") {
    throw new BridgePayloadUnsupportedError(payload.kind);
  }

  // The wallet bound to THIS intent, never a home-screen fallback
  // (`feedback_dapp_bridge_isolation`).
  const signer: Ed25519Keypair | null = await getSuiSignerForWallet(wallet);
  if (!signer) {
    throw new Error("SuiWalletKit.submitBridgeExecution: no signer");
  }

  const client = new SuiJsonRpcClient({
    url: chain.rpcUrl,
    network: chain.network,
  });
  const tx = Transaction.from(fromBase64(payload.payload));
  const { digest } = await client.signAndExecuteTransaction({
    transaction: tx,
    signer,
    options: { showEffects: false },
  });
  return digest;
}

/** Enough SUI to pay a couple of transactions afterwards. */
const MIN_MIST = 20_000_000n; // 0.02 SUI

const SUGGESTED_TOP_UP_USD = 2;

/**
 * Sui destination readiness: like EVM, the precondition is native gas.
 *
 * Any Sui address can receive any coin type without prior setup, so there
 * is no receive-side blocker — only the strand risk of arriving with no
 * SUI to move the funds with.
 */
export async function suiCheckBridgeDestinationReadiness({
  chain,
  address,
}: BridgeDestinationReadinessArgs): Promise<BridgeReadinessBlocker[]> {
  if (chain.namespace !== SUI_NAMESPACE) return [];

  let balance: bigint;
  try {
    const client = new SuiJsonRpcClient({
      url: chain.rpcUrl,
      network: chain.network,
    });
    const res = await client.getBalance({
      owner: address,
      coinType: SUI_COIN_TYPE,
    });
    balance = BigInt(res.totalBalance);
  } catch {
    // A check that cannot run must not invent a blocker.
    return [];
  }

  if (balance >= MIN_MIST) return [];

  return [
    {
      code: "no_destination_gas",
      message:
        "You have no SUI on Sui. You will not be able to move these funds after they arrive.",
      severity: "warning",
      remedy: { kind: "gas_top_up", suggestedUsd: SUGGESTED_TOP_UP_USD },
    },
  ];
}
