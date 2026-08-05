/**
 * EVM bridge capability — CAIP ids, execution, destination readiness.
 *
 * Spec: docs/bridge-capability-spec.md §5.1, §5.2, §7.5.
 *
 * Docked onto `EvmWalletKit` as optional, presence-checked methods
 * (`feedback_space_docking`). Everything EVM-specific about bridging
 * lives here — most importantly the ERC-20 allowance, which is the ONLY
 * namespace that has the concept and therefore the reason "does the
 * destination need an approve?" was the wrong framing (§10.4).
 */

import { erc20Abi } from "viem";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import { getAccountForWallet } from "@/services/walletService";
import { getPublicClient, getWalletClient } from "@/utils/clients";
import {
  type BridgeDestinationReadinessArgs,
  BridgePayloadUnsupportedError,
  type BridgeReadinessBlocker,
  type SubmitBridgeExecutionArgs,
} from "../types";

const EVM_NAMESPACE = "eip155" as const;

/** SLIP-44 coin type for ETH — the CAIP-19 canonical native form. */
const SLIP44_ETH = "60";

export function evmCaip2For(chain: ChainConfig): string | null {
  return chain.namespace === EVM_NAMESPACE
    ? `${EVM_NAMESPACE}:${chain.chain.id}`
    : null;
}

export function evmToAssetCaip19(
  chain: ChainConfig,
  contractAddress?: string | null,
): string | null {
  const caip2 = evmCaip2For(chain);
  if (!caip2) return null;
  if (!contractAddress) return `${caip2}/slip44:${SLIP44_ETH}`;
  // EVM hex addresses fold case, so lowercasing here is safe. It would
  // NOT be for a Solana mint or a Stellar strkey
  // (`feedback_address_case_per_encoding`).
  return `${caip2}/erc20:${contractAddress.toLowerCase()}`;
}

/**
 * Sign and submit the provider-built EVM bridge transaction.
 *
 * Ensures the ERC-20 allowance first when the payload carries one. That
 * approval is a REAL step the user sees in the route breakdown (§7.3) and
 * is presence-checked rather than assumed: native-token sources carry no
 * `approval` and skip it entirely.
 */
export async function evmSubmitBridgeExecution({
  wallet,
  chain,
  payload,
}: SubmitBridgeExecutionArgs): Promise<string> {
  if (payload.kind !== "evm_transaction") {
    throw new BridgePayloadUnsupportedError(payload.kind);
  }
  if (chain.namespace !== EVM_NAMESPACE) {
    throw new BridgePayloadUnsupportedError(payload.kind);
  }

  // The wallet bound to THIS intent, never a home-screen fallback
  // (`feedback_dapp_bridge_isolation`).
  const account = getAccountForWallet(wallet);
  if (!account) {
    throw new Error("EvmWalletKit.submitBridgeExecution: no signer");
  }

  const publicClient = getPublicClient(chain.chain);
  const walletClient = getWalletClient(account, chain.chain);

  if (payload.approval) {
    const token = payload.approval.token as `0x${string}`;
    const spender = payload.approval.spender as `0x${string}`;
    const required = BigInt(payload.approval.amountRaw);

    const allowance = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, spender],
    });

    if (allowance < required) {
      const approveHash = await walletClient.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, required],
        account,
        chain: chain.chain,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
    }
  }

  return walletClient.sendTransaction({
    to: payload.to as `0x${string}`,
    data: payload.data as `0x${string}`,
    value: BigInt(payload.value || "0"),
    account,
    chain: chain.chain,
    ...(payload.gasLimit ? { gas: BigInt(payload.gasLimit) } : {}),
  });
}

/**
 * Gas headroom below which the user cannot realistically move funds after
 * they arrive. Deliberately generous: the failure mode we are guarding is
 * "bridged a full balance and is now stranded", so a false warning costs
 * one extra tap while a missed one costs the whole position.
 */
const MIN_GAS_WEI = 200_000_000_000_000n; // 0.0002 ETH

/** Suggested top-up, in USD. Small on purpose (§7.5 copy: "Add $2 of ETH"). */
const SUGGESTED_TOP_UP_USD = 2;

/**
 * EVM destination readiness: the precondition is NATIVE GAS.
 *
 * Any valid EVM address can receive any ERC-20, so there is no
 * receive-side blocker here. The strand risk is entirely about being able
 * to MOVE the funds afterwards.
 */
export async function evmCheckBridgeDestinationReadiness({
  chain,
  address,
}: BridgeDestinationReadinessArgs): Promise<BridgeReadinessBlocker[]> {
  if (chain.namespace !== EVM_NAMESPACE) return [];

  let balance: bigint;
  try {
    balance = await getPublicClient(chain.chain).getBalance({
      address: address as `0x${string}`,
    });
  } catch {
    // A readiness check that cannot run must not invent a blocker — an
    // unnecessary "you have no gas" warning on a healthy account trains
    // users to dismiss the one that matters.
    return [];
  }

  if (balance >= MIN_GAS_WEI) return [];

  const symbol = chain.chain.nativeCurrency.symbol;
  return [
    {
      code: "no_destination_gas",
      message: `You have no ${symbol} on ${chain.chain.name}. You will not be able to move these funds after they arrive.`,
      severity: "warning",
      remedy: { kind: "gas_top_up", suggestedUsd: SUGGESTED_TOP_UP_USD },
    },
  ];
}
