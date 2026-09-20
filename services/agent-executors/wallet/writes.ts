/**
 * Write executors — all require a signing wallet client.
 *
 * The approval UX that gates these is task 13/14's concern; this file
 * assumes the SSE dispatcher (task 09) has already passed approval and
 * is now asking us to actually sign + submit. Every executor in this
 * file returns `{ status: "success", tx_hash }` on submission — it does
 * NOT wait for confirmation. The agent separately calls `get_transaction`
 * later to see whether the tx was mined (AGENT_PROTOCOL §10 "Optimistic
 * UI Pattern").
 *
 * TakumiPay-specific tools (execute_booking, cancel_booking,
 * create_purchase) are stubbed as `not_implemented` — we don't yet have
 * the vendor contract ABIs or the TakumiPay SDK binding needed to
 * build the exact call payload. See the individual TODO(task-10)
 * markers for what's still missing.
 */

import { type Abi, erc20Abi, parseUnits } from "viem";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import { getPreferredGasToken } from "@/hooks/usePreferredGasToken";
import { fixedErc20TransferGasLimit } from "@/services/chains/evm/monad";
import { pollRelayerTaskHash } from "@/services/gasAbstraction/pollTaskStatus";
import { resolveGasPayment } from "@/services/gasAbstraction/resolveGasPayment";
import { recordTransfer } from "@/services/transfers/transferRecordOutbox";
import {
  requireWalletClient,
  resolveChainClients,
  resolveChainDef,
} from "../chainRouter";
import {
  ExecutorError,
  ExecutorErrorCode,
  type MobileToolExecutor,
  requireAddress,
  requireBigInt,
  requireString,
  resolveChainId,
  safeExecute,
} from "../types";

/**
 * Resolve a token amount to a bigint, mirroring the `send.tsx` pattern:
 *   parseUnits(amount, decimals)
 *
 * Accepts two input shapes so the LLM can avoid doing
 * `amount × 10^decimals` arithmetic (which it gets wrong for non-18
 * decimal tokens like IDRX with 2 decimals):
 *
 *   Preferred: { token_amount: "98000", token_decimals: 2 }
 *              → parseUnits("98000", 2) = 9800000n
 *
 *   Fallback:  { amount_wei: "9800000" }
 *              → BigInt("9800000")
 *
 * Both paths produce the same bigint — the preferred path is just more
 * reliable because the LLM doesn't need to multiply.
 */
function resolveTokenAmount(input: Parameters<MobileToolExecutor>[0]): bigint {
  if (
    typeof input.token_amount === "string" &&
    input.token_amount.length > 0 &&
    typeof input.token_decimals === "number"
  ) {
    try {
      return parseUnits(input.token_amount, input.token_decimals);
    } catch {
      throw new ExecutorError(
        ExecutorErrorCode.InvalidInput,
        `invalid token_amount "${input.token_amount}" with token_decimals ${input.token_decimals}`,
      );
    }
  }
  return requireBigInt(input, "amount_wei");
}

/**
 * `send_native_token` — transfer native gas token (ETH, MATIC, BNB…).
 * Server input: `{ chain_id, to, value_wei }`.
 */
export const sendNativeToken: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    const chainId = resolveChainId(input, context);
    const to = requireAddress(input, "to");
    const value = requireBigInt(input, "value_wei");

    const walletClient = requireWalletClient(chainId, context);
    const { publicClient } = resolveChainClients(chainId, context);
    // viem wallet clients require an explicit account + chain when the
    // underlying account is a local signer. Pull both from the resolved
    // client.
    const account = walletClient.account;
    if (!account) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "wallet client has no account",
      );
    }

    const hash = await walletClient.sendTransaction({
      account,
      to,
      value,
      chain: walletClient.chain,
    });

    // Record transfer history — same durable outbox as send.tsx, so the
    // recipient's push survives a lapsed session or a dropped request.
    // Never throws and must NOT fail the executor; the tx is already on chain.
    let transactionId: string | undefined;
    const nativeToken = context.blockchains
      .find((b) => b.chainId === chainId && b.isEVM)
      ?.tokens?.find((t) => t.isNativeCurrency);
    if (nativeToken?.id) {
      transactionId = await recordTransfer({
        fromAddress: context.wallet.address,
        toAddress: to,
        amount: value.toString(),
        txHash: hash,
        token: { tokenId: nativeToken.id },
      });
    }

    return {
      status: "success",
      tx_hash: hash,
      tx_confirmed: false,
      transaction_id: transactionId,
      data: { chain_id: chainId, to, value_wei: value.toString() },
      ...(publicClient ? {} : {}),
    };
  });

/**
 * `transfer_erc20` — call `ERC20.transfer(to, amount)`.
 * Server input: `{ chain_id, contract_address, to, token_amount, token_decimals }`
 * or legacy: `{ chain_id, contract_address, to, amount_wei }`.
 */
export const transferErc20: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    const chainId = resolveChainId(input, context);
    const tokenAddress = requireAddress(input, "contract_address");
    const to = requireAddress(input, "to");
    const amount = resolveTokenAmount(input);
    const decimals =
      typeof input.token_decimals === "number" ? input.token_decimals : 18;

    // Decide how gas is paid (stablecoin abstraction vs native) via the
    // same single policy `app/send.tsx` uses. `getPreferredGasToken()`
    // reads the persisted setting (this runs off the React tree).
    const chain: ChainConfig = {
      namespace: "eip155",
      chain: resolveChainDef(chainId, context.blockchains),
    };
    const gasPlan = await resolveGasPayment({
      wallet: context.wallet,
      chain,
      intent: { to, tokenAddress, amount, decimals, memo: "takumi-agent" },
      preferredGasToken: getPreferredGasToken(),
    });

    // Prefer the stablecoin, else block — don't silently fall back to
    // native gas. Stable code only (curated copy lives in agentErrorCopy);
    // the token in question is the user's gas-settings choice.
    if (gasPlan.mode === "blocked") {
      return { status: "failed", error: "insufficient_fee_token_for_gas" };
    }

    let hash: `0x${string}`;
    if (gasPlan.mode === "abstracted") {
      try {
        const { taskId } = await gasPlan.provider.execute({
          wallet: context.wallet,
          chain,
          intent: { to, tokenAddress, amount, decimals, memo: "takumi-agent" },
          feeTokenSymbol: gasPlan.quote.feeToken.symbol,
        });
        hash = (await pollRelayerTaskHash(
          gasPlan.provider,
          chain,
          taskId,
        )) as `0x${string}`;
      } catch (relayErr) {
        if (__DEV__)
          console.warn("[transferErc20] abstracted failed:", relayErr);
        return { status: "failed", error: "relayed_transfer_failed" };
      }
    } else {
      // Native gas path — unchanged viem writeContract.
      const walletClient = requireWalletClient(chainId, context);
      const account = walletClient.account;
      if (!account) {
        throw new ExecutorError(
          ExecutorErrorCode.WalletCannotExecute,
          "wallet client has no account",
        );
      }
      // Monad bills on gas_limit, not gas_used — same pinned limit as
      // `EvmWalletKit.sendTokenTransfer` for the AUSD call shape.
      const gas = fixedErc20TransferGasLimit({
        chainId,
        contractAddress: tokenAddress,
      });
      hash = await walletClient.writeContract({
        account,
        chain: walletClient.chain,
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "transfer",
        args: [to, amount],
        ...(gas !== undefined ? { gas } : {}),
      });
    }

    // Record transfer history — same durable outbox as send.tsx. The
    // outbox resolves the tokenId from contractAddress + blockchainId when
    // it posts (public catalog lookup). Never throws; the tx is already on
    // chain.
    let transactionId: string | undefined;
    const blockchain = context.blockchains.find(
      (b) => b.chainId === chainId && b.isEVM,
    );
    if (blockchain) {
      transactionId = await recordTransfer({
        fromAddress: context.wallet.address,
        toAddress: to,
        amount: amount.toString(),
        txHash: hash,
        token: { contractAddress: tokenAddress, blockchainId: blockchain.id },
      });
    }

    return {
      status: "success",
      tx_hash: hash,
      tx_confirmed: false,
      transaction_id: transactionId,
      data: {
        chain_id: chainId,
        contract_address: tokenAddress,
        to,
        amount_wei: amount.toString(),
        // So the agent can truthfully answer "did you pay gas in USDC?".
        gas_paid_in: gasPlan.mode === "abstracted" ? "USDC" : "native",
        relayed: gasPlan.mode === "abstracted",
      },
    };
  });

/**
 * `write_contract` — generic state-changing contract call.
 * Server input:
 *   { chain_id, contract_address, abi, function_name, args?, value_wei? }
 */
export const writeContract: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    const chainId = resolveChainId(input, context);
    const address = requireAddress(input, "contract_address");
    const functionName = requireString(input, "function_name");
    const abi = input.abi;
    if (!Array.isArray(abi)) {
      throw new ExecutorError(
        ExecutorErrorCode.InvalidInput,
        "missing_or_invalid_abi",
      );
    }
    const args = Array.isArray(input.args) ? (input.args as unknown[]) : [];
    const value =
      input.value_wei !== undefined ? requireBigInt(input, "value_wei") : 0n;

    const walletClient = requireWalletClient(chainId, context);
    const account = walletClient.account;
    if (!account) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "wallet client has no account",
      );
    }

    const hash = await walletClient.writeContract({
      account,
      chain: walletClient.chain,
      address,
      abi: abi as Abi,
      functionName,
      args,
      value,
    });
    return {
      status: "success",
      tx_hash: hash,
      tx_confirmed: false,
      data: {
        chain_id: chainId,
        contract_address: address,
        function_name: functionName,
      },
    };
  });

/**
 * `approve_erc20` — call `ERC20.approve(spender, amount)`.
 * Server input: `{ chain_id, contract_address, spender, token_amount, token_decimals }`
 * or legacy: `{ chain_id, contract_address, spender, amount_wei }`.
 *
 * NOTE: the spec specifically calls out that mobile should show an
 * extra "infinite allowance" warning before approving this — that UI
 * warning lives in task 13's approval sheet, not here. This executor
 * just submits the transaction once the sheet has returned.
 */
export const approveErc20: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    const chainId = resolveChainId(input, context);
    const tokenAddress = requireAddress(input, "contract_address");
    const spender = requireAddress(input, "spender");
    const amount = resolveTokenAmount(input);

    const walletClient = requireWalletClient(chainId, context);
    const account = walletClient.account;
    if (!account) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "wallet client has no account",
      );
    }

    const hash = await walletClient.writeContract({
      account,
      chain: walletClient.chain,
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amount],
    });
    return {
      status: "success",
      tx_hash: hash,
      tx_confirmed: false,
      data: {
        chain_id: chainId,
        token_address: tokenAddress,
        spender,
        amount_wei: amount.toString(),
      },
    };
  });

// ---------------------------------------------------------------------------
// TakumiPay on-chain write stubs
// ---------------------------------------------------------------------------
//
// TODO(task-10): the following three executors are intentionally stubbed.
// To complete them we need, at minimum:
//   1. The TakumiPay payment contract ABI for each supported chain
//      (deployed addresses live in the takumipay-api repo under
//      `src/contracts/` — they are not yet exposed to the mobile app).
//   2. A canonical mapping from { booking_id, payment_token } to the
//      exact `pay(...)` / `cancel(...)` call on that contract. The
//      mobile-app already has a `TakumiPay` client in `api/endpoints/`,
//      but it only hits the REST backend — the on-chain payload
//      construction lives server-side today.
//   3. A decision on who computes the EIP-712 permit (if the vendor
//      contract supports gasless approvals). The protocol says the
//      mobile signs, but the permit *structure* is vendor-specific.
//
// Until those land, each stub returns `{ status: "failed",
// error: "not_implemented" }` so the agent can surface a clear error
// to the user rather than silently hanging.

/**
 * `execute_booking` — stub. See the TODO block above.
 */
export const executeBooking: MobileToolExecutor = async (_input, _context) => {
  // TODO(task-10): wire this up once the TakumiPay contract ABI + address
  // registry is exposed to the mobile app. The protocol sample in
  // AGENT_PROTOCOL.md §10 references a `signAndSubmitPayment` helper
  // that doesn't exist in this repo yet.
  return { status: "failed", error: ExecutorErrorCode.NotImplemented };
};

/**
 * `cancel_booking` — stub. See the TODO block above.
 */
export const cancelBooking: MobileToolExecutor = async (_input, _context) => {
  // TODO(task-10): needs the vendor `cancel(bytes32 bookingId)` ABI and
  // a decision on whether cancellation is on-chain or off-chain with
  // an on-chain refund. Today it is server-only (see takumipay-api
  // `bookings.service.ts`).
  return { status: "failed", error: ExecutorErrorCode.NotImplemented };
};

/**
 * `create_purchase` — stub. See the TODO block above.
 */
export const createPurchase: MobileToolExecutor = async (_input, _context) => {
  // TODO(task-10): needs the "direct buy" contract ABI and the call
  // shape the server expects (price is usually quoted via
  // `get_latest_exchange_rate` first, then a `buy(...)` with a minOut).
  return { status: "failed", error: ExecutorErrorCode.NotImplemented };
};

export const WRITE_EXECUTORS: Record<string, MobileToolExecutor> = {
  send_native_token: sendNativeToken,
  transfer_erc20: transferErc20,
  write_contract: writeContract,
  approve_erc20: approveErc20,
  execute_booking: executeBooking,
  cancel_booking: cancelBooking,
  create_purchase: createPurchase,
};
