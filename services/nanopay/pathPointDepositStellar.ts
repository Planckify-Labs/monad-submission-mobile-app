/**
 * `services/nanopay/pathPointDepositStellar.ts` — Stellar point-deposit
 * counterpart of the EVM smart-contract deposit path in `useDepositState`.
 * Calls `deposit_points` on the `takumi_pay` Soroban contract.
 *
 * Space-docking: self-contained Stellar module. It asserts its own namespace
 * at entry and reaches the chain ONLY through the presence-checked
 * `walletKit.sendSorobanTransaction` — no shared code branches on namespace to
 * pick it (mirrors `pathOnchainSettlementStellar.ts`; see
 * `docs/solana-contract-integration-spec.md` §4.2).
 *
 * Unlike the merchant-payment path there is no backend-signed quote: the payer
 * (tx source) authorizes the SAC transfer via the envelope signature, so this
 * just resolves the token's SAC id, builds the args, and submits.
 */

import { Networks } from "@stellar/stellar-base";

import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import {
  buildDepositPointsArgs,
  DEPOSIT_POINTS,
  resolveStellarSacId,
} from "@/services/chains/stellar/takumiPay";
import type { WalletKitAdapter } from "@/services/walletKit/types";

export class PointDepositStellarError extends Error {
  readonly name = "PointDepositStellarError";
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ExecutePointDepositStellarArgs {
  wallet: TWallet;
  walletKit: WalletKitAdapter;
  chain: ChainConfig;
  /** `takumi_pay` contract id (`C…`) — the deposit target. */
  contractId: string;
  /**
   * Token identifier from the Token row — either an already-resolved SAC id
   * (`C…`) or the compound `"{CODE}:{ISSUER}"` classic-asset form.
   */
  token: string;
  /** Client-generated deposit reference id. */
  refId: string;
  /** Raw token amount in the asset's smallest unit (Stellar = 7 decimals). */
  amount: bigint;
}

export interface ExecutePointDepositStellarResult {
  txHash: string;
}

export async function executePointDepositStellar(
  args: ExecutePointDepositStellarArgs,
): Promise<ExecutePointDepositStellarResult> {
  const { wallet, walletKit, chain, contractId, token, refId, amount } = args;

  if (chain.namespace !== "stellar") {
    throw new PointDepositStellarError(
      "WRONG_CHAIN_NAMESPACE",
      "Expected Stellar chain",
    );
  }

  if (typeof walletKit.sendSorobanTransaction !== "function") {
    throw new PointDepositStellarError(
      "WALLET_UNSUPPORTED",
      "Wallet does not support sendSorobanTransaction",
    );
  }

  if (amount <= 0n) {
    throw new PointDepositStellarError(
      "INVALID_AMOUNT",
      "Deposit amount must be positive",
    );
  }

  const networkPassphrase =
    chain.network === "testnet" ? Networks.TESTNET : Networks.PUBLIC;
  const tokenSacId = resolveStellarSacId(token, networkPassphrase);

  const callArgs = buildDepositPointsArgs({
    payer: wallet.address,
    tokenSacId,
    refId,
    amount,
  });

  const txHash = await walletKit.sendSorobanTransaction({
    wallet,
    chain,
    contractId,
    method: DEPOSIT_POINTS,
    args: callArgs,
  });

  return { txHash };
}
