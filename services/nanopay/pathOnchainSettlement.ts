/**
 * `services/nanopay/pathOnchainSettlement.ts` — onchain settlement rail
 * for merchant payments (spec onchain-settlement extension, milestone M6).
 *
 * Customers pay by calling `processMerchantPayment(quoteCommitment,
 * backendSignature)` on the TakumiPay smart contract. After the tx
 * confirms, the mobile app POSTs the txHash to
 * `POST /pay/intents/:id/onchain` so the backend can reconcile.
 *
 * Layering (§5.5, matches `pathADirectArc.ts`):
 *   - `executeOnchainSettlement` is the orchestrator — validate inputs,
 *     encode calldata via `encodeFunctionData`, delegate broadcast to
 *     `walletKit.sendContractTransaction`, and return the tx hash.
 *   - `postOnchainSubmit` soft-links the backend onchain endpoint.
 *   - `onchainSubmitEndpoint` exports the URL template.
 *
 * Rules (non-negotiable):
 *   - Three-role separation (memory `feedback_role_separation.md`):
 *     the wallet signs + broadcasts; the backend is informed after-the-
 *     fact via `postOnchainSubmit`. Mobile never asks the server to
 *     settle — the chain IS the settle.
 *   - Chain-extension discipline: the guard is `chain.namespace ===
 *     "eip155"` — any EVM chain with the TakumiPay contract deployed
 *     is eligible.
 *   - Copy-audience rule: user-facing copy in `app/pay-merchant.tsx`
 *     says "Pay" — no contract / calldata / ABI jargon in user copy.
 */

import { HTTPError } from "ky";
import { type Address, encodeFunctionData, erc20Abi } from "viem";
import type {
  ChainConfig,
  EvmChainConfig,
} from "../../constants/configs/chainConfig.ts";
import { FEATURE_EVM_ONCHAIN_SETTLEMENT_MAINNET } from "../../constants/configs/featureFlags.ts";
import type { TWallet } from "../../constants/types/walletTypes.ts";
import type { WalletKitAdapter } from "../walletKit/types.ts";
import type { PaymentIntentResponse } from "./types.ts";

// Minimal ABI for processMerchantPayment — only the function we call
const PROCESS_MERCHANT_PAYMENT_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "refId", type: "string" },
          { name: "merchantId", type: "string" },
          { name: "tokenAddress", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "platformFeeAmount", type: "uint256" },
          { name: "fiatAmountMinor", type: "uint256" },
          { name: "fiatCurrency", type: "bytes3" },
          { name: "exchangeRateId", type: "uint256" },
          { name: "expiresAt", type: "uint256" },
        ],
        name: "quote",
        type: "tuple",
      },
      { name: "backendSignature", type: "bytes" },
    ],
    name: "processMerchantPayment",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
] as const;

/**
 * Typed error raised when the onchain settlement flow encounters a
 * pre-condition failure. Screens catch by `name` so copy stays in one
 * place. The `code` field maps to the shared `PaymentErrorCode` union
 * for classifier compatibility.
 */
export class OnchainSettlementError extends Error {
  readonly name = "OnchainSettlementError";
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ExecuteOnchainSettlementArgs {
  intent: PaymentIntentResponse;
  wallet: TWallet;
  walletKit: WalletKitAdapter;
  chain: ChainConfig;
  contractAddress: `0x${string}`;
}

export interface ExecuteOnchainSettlementResult {
  txHash: `0x${string}`;
  chainId: number;
}

/**
 * Converts a 3-character ISO-4217 currency string (e.g. "IDR") to its
 * `bytes3` hex representation for the Solidity struct. Each character is
 * encoded as its ASCII byte value, zero-padded on the right.
 */
function fiatCurrencyToBytes3(currency: string): `0x${string}` {
  const bytes = new Uint8Array(3);
  for (let i = 0; i < Math.min(currency.length, 3); i++) {
    bytes[i] = currency.charCodeAt(i);
  }
  return `0x${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}` as `0x${string}`;
}

/**
 * Orchestrates the onchain settlement:
 *
 *   1. Validate the intent has `quoteCommitment` + `quoteSignature`.
 *   2. Validate the wallet kit supports `sendContractTransaction`.
 *   3. Validate the chain is EVM.
 *   4. Encode `processMerchantPayment(quote, backendSignature)` calldata.
 *   5. Delegate to `walletKit.sendContractTransaction` for broadcast.
 *   6. Return `{ txHash, chainId }`.
 *
 * For native-token payments (tokenAddress = zero address), the token
 * `amount` is attached as `msg.value` so the contract can pull it from
 * the caller's balance. For ERC-20 payments, `value` is `0n` and the
 * contract pulls via `transferFrom`, so this function first ensures an
 * exact-amount allowance (see the approval block below).
 */
export async function executeOnchainSettlement(
  args: ExecuteOnchainSettlementArgs,
): Promise<ExecuteOnchainSettlementResult> {
  const { intent, wallet, walletKit, chain, contractAddress } = args;

  if (!intent.quoteCommitment || !intent.quoteSignature) {
    throw new OnchainSettlementError(
      "MISSING_QUOTE",
      "Intent missing quoteCommitment or quoteSignature for onchain settlement",
    );
  }

  if (typeof walletKit.sendContractTransaction !== "function") {
    throw new OnchainSettlementError(
      "WALLET_UNSUPPORTED",
      "Wallet does not support contract transactions",
    );
  }

  if (chain.namespace !== "eip155") {
    throw new OnchainSettlementError(
      "WRONG_CHAIN_NAMESPACE",
      "Onchain settlement requires an EVM chain",
    );
  }

  // Testnet-only until the deployment's release blockers are cleared — the
  // quote signer key is public and ownership still sits with the deployer.
  // See `FEATURE_EVM_ONCHAIN_SETTLEMENT_MAINNET`.
  if (!chain.isTestnet && !FEATURE_EVM_ONCHAIN_SETTLEMENT_MAINNET) {
    throw new OnchainSettlementError(
      "RAIL_DISABLED",
      "Onchain settlement is not enabled on mainnet chains",
    );
  }

  const qc = intent.quoteCommitment;
  const isNativeToken =
    qc.tokenAddress === "0x0000000000000000000000000000000000000000";

  // ERC-20 approval. `processMerchantPayment` pulls via `transferFrom`, so
  // without an allowance the payment reverts — the header's "approval handled
  // upstream" was aspirational; nothing upstream ever set one.
  //
  // This was survivable while EVM merchant payments were native-token only.
  // It is not on a native-alias chain like Arc, where the contract refuses
  // address(0) outright (`NativeDisabledOnAliasChain`) and the ERC-20 is the
  // ONLY payable route, so every payment needs an allowance first.
  //
  // Approve exactly `qc.amount`, never unlimited: the user is confirming one
  // payment of a known size, and the quote's own expiry bounds the window.
  // A leftover allowance would outlive the intent it was granted for.
  if (!isNativeToken) {
    const amount = BigInt(qc.amount);
    const token = qc.tokenAddress as Address;

    // Presence-checked, per chain-extension discipline: a kit without these
    // reads (non-EVM) never reaches here, since we already required
    // `sendContractTransaction` and an eip155 chain above.
    const allowance = walletKit.getTokenAllowance
      ? await walletKit.getTokenAllowance({
          owner: wallet.address,
          spender: contractAddress,
          tokenAddress: token,
          chain,
        })
      : 0n;

    if (allowance < amount) {
      const approveHash = (await walletKit.sendContractTransaction({
        wallet,
        chain,
        to: token,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [contractAddress, amount],
        }),
        value: 0n,
      })) as `0x${string}`;

      // Must confirm before the payment is broadcast. Both land in the same
      // block otherwise and `transferFrom` can execute against the old
      // allowance, reverting the payment the user just authorized.
      if (walletKit.waitForTransaction) {
        await walletKit.waitForTransaction({ hash: approveHash, chain });
      }
    }
  }

  const calldata = encodeFunctionData({
    abi: PROCESS_MERCHANT_PAYMENT_ABI,
    functionName: "processMerchantPayment",
    args: [
      {
        refId: qc.refId,
        merchantId: qc.merchantId,
        tokenAddress: qc.tokenAddress as Address,
        amount: BigInt(qc.amount),
        platformFeeAmount: BigInt(qc.platformFeeAmount),
        fiatAmountMinor: BigInt(qc.fiatAmountMinor),
        fiatCurrency: fiatCurrencyToBytes3(qc.fiatCurrency),
        exchangeRateId: BigInt(qc.exchangeRateId),
        expiresAt: BigInt(qc.expiresAt),
      },
      intent.quoteSignature,
    ],
  });

  const txHash = (await walletKit.sendContractTransaction({
    wallet,
    chain,
    to: contractAddress,
    data: calldata,
    value: isNativeToken ? BigInt(qc.amount) : 0n,
  })) as `0x${string}`;

  return { txHash, chainId: chain.chain.id };
}

// ── Backend submit endpoint ─────────────────────────────────────────

/** Body of `POST /pay/intents/:id/onchain`. */
export interface OnchainSubmitRequest {
  txHash: string;
  blockchainId: string;
}

export interface OnchainSubmitResponse {
  id: string;
  status: string;
}

/**
 * HTTP seam. Production passes `postOnchainSubmit` wired to the shared
 * `api` ky instance (see `useIntentStatus.ts` for the analogous
 * pattern). Tests inject a stub so the Node test bench never has to
 * load `@/constants/configs/ky`.
 */
export type PostOnchainSubmit = (args: {
  intentId: string;
  body: OnchainSubmitRequest;
}) => Promise<OnchainSubmitResponse>;

/**
 * URL template for the onchain submit endpoint. Exported so both the
 * Query-hook site and any future caller share exactly one copy.
 */
export function onchainSubmitEndpoint(intentId: string): string {
  return `pay/intents/${encodeURIComponent(intentId)}/onchain`;
}

/**
 * Posts the onchain settlement tx hash to the backend. The backend
 * reconciles via on-chain events; this POST is a latency hint.
 * 404 is swallowed so the user's on-chain confirmation is never gated
 * on backend deploy timing.
 */
export async function postOnchainSubmit(args: {
  intentId: string;
  txHash: string;
  blockchainId: string;
  poster: PostOnchainSubmit;
}): Promise<OnchainSubmitResponse | null> {
  const body: OnchainSubmitRequest = {
    txHash: args.txHash,
    blockchainId: args.blockchainId,
  };
  try {
    return await args.poster({ intentId: args.intentId, body });
  } catch (err) {
    if (err instanceof HTTPError) {
      const status = err.response.status;
      if (status === 404) {
        if (isDevRuntime()) {
          console.log(
            `[pathOnchainSettlement] onchain endpoint 404 for intent ${args.intentId}; backend watcher will reconcile via events.`,
          );
        }
        return null;
      }
    }
    throw err;
  }
}

/**
 * `__DEV__` shim — Metro injects `__DEV__` as a global at bundle time,
 * but the Node test bench has no such binding. Reach through
 * `globalThis` to avoid a ReferenceError under Node while still
 * honouring the RN-side flag in production builds.
 */
function isDevRuntime(): boolean {
  const flag = (globalThis as unknown as { __DEV__?: boolean }).__DEV__;
  return typeof flag === "boolean" ? flag : false;
}
