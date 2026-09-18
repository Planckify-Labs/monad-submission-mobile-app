/**
 * Unit tests for `pathOnchainSettlement.ts` — the EVM `processMerchantPayment`
 * settlement orchestrator.
 *
 * Scope: the ordering and shape of what the orchestrator broadcasts. The
 * wallet kit's signing/broadcast internals are stubbed; what matters here is
 * that an ERC-20 payment is preceded by a confirmed, exactly-sized approval,
 * and that a native payment is not.
 */

import { HTTPError } from "ky";
import { decodeFunctionData, erc20Abi } from "viem";
import { describe, expect, it, vi } from "vitest";

import type { ChainConfig } from "../../constants/configs/chainConfig.ts";
import type { TWallet } from "../../constants/types/walletTypes.ts";
import type {
  SendContractTransactionArgs,
  WalletKitAdapter,
} from "../walletKit/types.ts";
import {
  executeOnchainSettlement,
  InsufficientFeeError,
  MERCHANT_PAYMENT_GAS_FALLBACK,
  submitOnchainWithRetry,
} from "./pathOnchainSettlement.ts";
import type { PaymentIntentResponse } from "./types.ts";

const CONTRACT = "0x9EEC5aD4FC092fD468A8114007e541238F4Ba5ee" as const;
const ARC_USDC = "0x3600000000000000000000000000000000000000" as const;
const NATIVE = "0x0000000000000000000000000000000000000000" as const;
const PAYER = "0x0141781Aad86A023FaC70C6Aad0A8E7253164DB6" as const;

const ARC_CHAIN = {
  namespace: "eip155",
  chain: { id: 5042002, name: "Arc Testnet" },
  isTestnet: true,
} as unknown as ChainConfig;

const WALLET = { address: PAYER } as unknown as TWallet;

function intentWith(tokenAddress: string): PaymentIntentResponse {
  return {
    id: "intent_1",
    quoteSignature: `0x${"ab".repeat(65)}`,
    quoteCommitment: {
      refId: "intent_1",
      merchantId: "merchant_1",
      tokenAddress,
      amount: "1000000",
      platformFeeAmount: "100000",
      fiatAmountMinor: 1_500_000,
      fiatCurrency: "IDR",
      exchangeRateId: 42,
      expiresAt: Math.floor(Date.now() / 1000) + 900,
    },
  } as unknown as PaymentIntentResponse;
}

/** Records every broadcast so tests can assert on call ordering. */
function makeKit(
  opts: {
    allowance?: bigint;
    /** Allowance reads, in order; the last value repeats. Overrides `allowance`. */
    allowanceReads?: bigint[];
    /** Throw on the Nth payment broadcast (1-based); approve is never affected. */
    failPaymentAttempt?: { attempt: number; error: Error };
    /** When set, the kit can price calls: the fee it reports and the wallet's native balance. */
    fee?: { feeWei: bigint; balanceWei: bigint; estimateThrows?: boolean };
  } = {},
) {
  const sent: SendContractTransactionArgs[] = [];
  const waited: string[] = [];
  const allowanceLog: bigint[] = [];
  let paymentAttempts = 0;
  const kit: WalletKitAdapter = {
    async sendContractTransaction(args: SendContractTransactionArgs) {
      const isPayment = args.to.toLowerCase() === CONTRACT.toLowerCase();
      if (isPayment) {
        paymentAttempts++;
        if (opts.failPaymentAttempt?.attempt === paymentAttempts) {
          throw opts.failPaymentAttempt.error;
        }
      }
      sent.push(args);
      return `0x${sent.length.toString(16).padStart(64, "0")}`;
    },
    async getTokenAllowance() {
      const reads = opts.allowanceReads;
      const value = reads
        ? (reads[Math.min(allowanceLog.length, reads.length - 1)] ?? 0n)
        : (opts.allowance ?? 0n);
      allowanceLog.push(value);
      return value;
    },
    async waitForTransaction({ hash }: { hash: string }) {
      waited.push(hash);
    },
    ...(opts.fee
      ? {
          async estimateContractCallFee(args: { fallbackGas?: bigint }) {
            if (opts.fee?.estimateThrows && args.fallbackGas === undefined) {
              throw new Error("execution reverted");
            }
            return {
              gas: 359_544n,
              maxFeePerGas: 122_000_000_000n,
              feeWei: opts.fee?.feeWei ?? 0n,
            };
          },
          async getNativeBalance() {
            return opts.fee?.balanceWei ?? 0n;
          },
        }
      : {}),
  } as unknown as WalletKitAdapter;
  return { kit, sent, waited, allowanceLog };
}

const noSleep = () => Promise.resolve();

describe("executeOnchainSettlement — ERC-20 approval", () => {
  it("approves the exact amount before paying when allowance is insufficient", async () => {
    // The stub never reports the new allowance, so this also covers the
    // bounded wait giving up and proceeding (the chain has the last word).
    const { kit, sent, waited } = makeKit({ allowance: 0n });

    await executeOnchainSettlement({
      intent: intentWith(ARC_USDC),
      wallet: WALLET,
      walletKit: kit,
      chain: ARC_CHAIN,
      contractAddress: CONTRACT,
      sleep: noSleep,
    });

    expect(sent.length, "expected an approve followed by the payment").toBe(2);

    const [approve, payment] = sent;
    expect(
      approve.to.toLowerCase(),
      "approve must target the token, not the payment contract",
    ).toBe(ARC_USDC.toLowerCase());
    const decoded = decodeFunctionData({ abi: erc20Abi, data: approve.data });
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args).toEqual([CONTRACT, 1_000_000n]);

    expect(
      payment.to.toLowerCase(),
      "payment must target the TakumiPay contract",
    ).toBe(CONTRACT.toLowerCase());
    expect(payment.value, "ERC-20 payment must send no native value").toBe(0n);

    // The approve must be confirmed before the payment is broadcast,
    // otherwise transferFrom can run against the stale allowance. The stub
    // hands back `0x…01` for the first broadcast, which is the approve.
    expect(waited).toEqual([`0x${"0".repeat(63)}1`]);
  });

  it("after approving, waits until the allowance is actually visible on the read path before paying", async () => {
    // First read: 0 → approve. Then two stale reads (lagging node), then
    // the allowance shows up. The payment must only go out after that.
    const { kit, sent, allowanceLog } = makeKit({
      allowanceReads: [0n, 0n, 0n, 1_000_000n],
    });

    await executeOnchainSettlement({
      intent: intentWith(ARC_USDC),
      wallet: WALLET,
      walletKit: kit,
      chain: ARC_CHAIN,
      contractAddress: CONTRACT,
      sleep: noSleep,
    });

    expect(sent.length).toBe(2);
    expect(allowanceLog).toEqual([0n, 0n, 0n, 1_000_000n]);
  });

  it("retries the payment once when estimation still sees the pre-approve state", async () => {
    const stale = Object.assign(
      new Error(
        "Execution reverted for an unknown reason.\n\nDetails: execution reverted",
      ),
      { name: "TransactionExecutionError" },
    );
    const { kit, sent } = makeKit({
      allowanceReads: [0n, 1_000_000n],
      failPaymentAttempt: { attempt: 1, error: stale },
    });

    const result = await executeOnchainSettlement({
      intent: intentWith(ARC_USDC),
      wallet: WALLET,
      walletKit: kit,
      chain: ARC_CHAIN,
      contractAddress: CONTRACT,
      sleep: noSleep,
    });

    // approve + the payment that finally went out (the failed try recorded nothing)
    expect(sent.length).toBe(2);
    expect(result.txHash).toBe(`0x${"0".repeat(63)}2`);
  });

  it("does not retry a revert when nothing was approved in this call: that is a real refusal", async () => {
    const stale = new Error("Execution reverted for an unknown reason.");
    const { kit } = makeKit({
      allowance: 5_000_000n,
      failPaymentAttempt: { attempt: 1, error: stale },
    });

    await expect(
      executeOnchainSettlement({
        intent: intentWith(ARC_USDC),
        wallet: WALLET,
        walletKit: kit,
        chain: ARC_CHAIN,
        contractAddress: CONTRACT,
        sleep: noSleep,
      }),
    ).rejects.toBe(stale);
  });

  it("gives up after a second revert even right after an approve", async () => {
    const stale = new Error("Execution reverted for an unknown reason.");
    const { kit } = makeKit({ allowanceReads: [0n, 1_000_000n] });
    let attempts = 0;
    const original = kit.sendContractTransaction!.bind(kit);
    kit.sendContractTransaction = async (args) => {
      if (args.to.toLowerCase() === CONTRACT.toLowerCase()) {
        attempts++;
        throw stale;
      }
      return original(args);
    };

    await expect(
      executeOnchainSettlement({
        intent: intentWith(ARC_USDC),
        wallet: WALLET,
        walletKit: kit,
        chain: ARC_CHAIN,
        contractAddress: CONTRACT,
        sleep: noSleep,
      }),
    ).rejects.toBe(stale);
    expect(attempts).toBe(2);
  });

  it("skips the approve when the existing allowance already covers the amount", async () => {
    const { kit, sent, waited } = makeKit({ allowance: 5_000_000n });

    await executeOnchainSettlement({
      intent: intentWith(ARC_USDC),
      wallet: WALLET,
      walletKit: kit,
      chain: ARC_CHAIN,
      contractAddress: CONTRACT,
    });

    expect(sent.length, "expected only the payment").toBe(1);
    expect(sent[0].to.toLowerCase()).toBe(CONTRACT.toLowerCase());
    expect(waited).toEqual([]);
  });

  it("does not approve for a native payment, and forwards amount as value", async () => {
    const { kit, sent } = makeKit();

    await executeOnchainSettlement({
      intent: intentWith(NATIVE),
      wallet: WALLET,
      walletKit: kit,
      chain: ARC_CHAIN,
      contractAddress: CONTRACT,
    });

    expect(sent.length, "native payment needs no approval").toBe(1);
    expect(sent[0].value).toBe(1_000_000n);
  });
});

describe("executeOnchainSettlement — rail gating", () => {
  it("refuses to settle on a non-testnet chain while the flag is off", async () => {
    const { kit, sent } = makeKit();
    const mainnetChain = {
      ...(ARC_CHAIN as object),
      isTestnet: false,
    } as unknown as ChainConfig;

    await expect(
      executeOnchainSettlement({
        intent: intentWith(ARC_USDC),
        wallet: WALLET,
        walletKit: kit,
        chain: mainnetChain,
        contractAddress: CONTRACT,
      }),
    ).rejects.toThrow(/not enabled on mainnet/);
    expect(sent.length, "nothing may be broadcast when gated off").toBe(0);
  });

  it("throws MISSING_QUOTE when the intent carries no signed quote", async () => {
    const { kit } = makeKit();
    await expect(
      executeOnchainSettlement({
        intent: { id: "intent_1" } as unknown as PaymentIntentResponse,
        wallet: WALLET,
        walletKit: kit,
        chain: ARC_CHAIN,
        contractAddress: CONTRACT,
      }),
    ).rejects.toThrow(/quoteCommitment or quoteSignature/);
  });
});

describe("executeOnchainSettlement — network fee", () => {
  it("refuses to sign when the wallet can't cover the live fee, naming the numbers", async () => {
    // 0.0439 MON needed (359,544 gas × 122 gwei), 0.0231 MON held: the
    // Monad Testnet case of 2026-09-17, which the node reports only as
    // "execution reverted".
    const { kit, sent } = makeKit({
      allowance: 5_000_000n,
      fee: {
        feeWei: 43_864_368_000_000_000n,
        balanceWei: 23_130_164_000_000_000n,
      },
    });

    await expect(
      executeOnchainSettlement({
        intent: intentWith(ARC_USDC),
        wallet: WALLET,
        walletKit: kit,
        chain: ARC_CHAIN,
        contractAddress: CONTRACT,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({
      name: "InsufficientFeeError",
      feeWei: 43_864_368_000_000_000n,
      balanceWei: 23_130_164_000_000_000n,
    });
    expect(sent, "nothing must be broadcast").toEqual([]);
  });

  it("signs when the balance covers fee + value", async () => {
    const { kit, sent } = makeKit({
      allowance: 5_000_000n,
      fee: {
        feeWei: 43_864_368_000_000_000n,
        balanceWei: 50_000_000_000_000_000n,
      },
    });
    await executeOnchainSettlement({
      intent: intentWith(ARC_USDC),
      wallet: WALLET,
      walletKit: kit,
      chain: ARC_CHAIN,
      contractAddress: CONTRACT,
      sleep: noSleep,
    });
    expect(sent.length).toBe(1);
  });

  it("a native payment must cover fee AND the amount", async () => {
    const { kit } = makeKit({
      fee: { feeWei: 1_000_000n, balanceWei: 1_500_000n }, // amount is 1_000_000
    });
    await expect(
      executeOnchainSettlement({
        intent: intentWith(NATIVE),
        wallet: WALLET,
        walletKit: kit,
        chain: ARC_CHAIN,
        contractAddress: CONTRACT,
        sleep: noSleep,
      }),
    ).rejects.toBeInstanceOf(InsufficientFeeError);
  });

  it("prices with the fallback gas when the node won't estimate, so the check still runs", async () => {
    const { kit, sent } = makeKit({
      allowance: 5_000_000n,
      fee: {
        feeWei: 43_864_368_000_000_000n,
        balanceWei: 1n,
        estimateThrows: true,
      },
    });
    await expect(
      executeOnchainSettlement({
        intent: intentWith(ARC_USDC),
        wallet: WALLET,
        walletKit: kit,
        chain: ARC_CHAIN,
        contractAddress: CONTRACT,
        sleep: noSleep,
      }),
    ).rejects.toBeInstanceOf(InsufficientFeeError);
    expect(sent).toEqual([]);
    expect(MERCHANT_PAYMENT_GAS_FALLBACK).toBeGreaterThan(359_544n);
  });
});

describe("submitOnchainWithRetry", () => {
  const base = {
    intentId: "01M2PRX5BA34H2ZES9EPBN3GNQ",
    txHash: `0x${"ab".repeat(32)}`,
    blockchainId: "monad-testnet",
    sleep: () => Promise.resolve(),
  };

  function httpError(status: number): HTTPError {
    const response = new Response(null, { status });
    return new HTTPError(
      response,
      new Request("https://api.example/pay"),
      {} as never,
    );
  }

  it("SETTLING is the normal answer: returned on the first try, nothing retried", async () => {
    const poster = vi.fn().mockResolvedValue({ id: "os", status: "SETTLING" });

    const res = await submitOnchainWithRetry({ ...base, poster });

    expect(res).toEqual({ id: "os", status: "SETTLING" });
    expect(poster).toHaveBeenCalledTimes(1);
  });

  it("retries handing over the SAME hash on network / 5xx failures, then rethrows the last one", async () => {
    const poster = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Network request failed"))
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValue(httpError(502));

    await expect(
      submitOnchainWithRetry({ ...base, poster, delaysMs: [0, 0] }),
    ).rejects.toBeInstanceOf(HTTPError);
    expect(poster).toHaveBeenCalledTimes(3);
    for (const call of poster.mock.calls) {
      expect(call[0].body.txHash).toBe(base.txHash);
    }
  });

  it("recovers when a later attempt gets through", async () => {
    const poster = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Network request failed"))
      .mockResolvedValueOnce({ id: "os", status: "SETTLING" });

    const res = await submitOnchainWithRetry({ ...base, poster });

    expect(res).toEqual({ id: "os", status: "SETTLING" });
    expect(poster).toHaveBeenCalledTimes(2);
  });

  it("stops immediately on a 400: the request itself is invalid", async () => {
    const poster = vi.fn().mockRejectedValue(httpError(400));

    await expect(
      submitOnchainWithRetry({ ...base, poster }),
    ).rejects.toMatchObject({ response: { status: 400 } });
    expect(poster).toHaveBeenCalledTimes(1);
  });

  it("treats 409 (intent already moved on) as done and lets the status poll decide", async () => {
    const poster = vi.fn().mockRejectedValue(httpError(409));

    await expect(submitOnchainWithRetry({ ...base, poster })).resolves.toBe(
      null,
    );
    expect(poster).toHaveBeenCalledTimes(1);
  });
});
