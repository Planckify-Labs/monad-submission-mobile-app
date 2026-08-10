/**
 * Unit tests for `pathOnchainSettlement.ts` — the EVM `processMerchantPayment`
 * settlement orchestrator.
 *
 * Scope: the ordering and shape of what the orchestrator broadcasts. The
 * wallet kit's signing/broadcast internals are stubbed; what matters here is
 * that an ERC-20 payment is preceded by a confirmed, exactly-sized approval,
 * and that a native payment is not.
 */

import { decodeFunctionData, erc20Abi } from "viem";
import { describe, expect, it } from "vitest";

import type { ChainConfig } from "../../constants/configs/chainConfig.ts";
import type { TWallet } from "../../constants/types/walletTypes.ts";
import type {
  SendContractTransactionArgs,
  WalletKitAdapter,
} from "../walletKit/types.ts";
import { executeOnchainSettlement } from "./pathOnchainSettlement.ts";
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
function makeKit(opts: { allowance?: bigint } = {}) {
  const sent: SendContractTransactionArgs[] = [];
  const waited: string[] = [];
  const kit: WalletKitAdapter = {
    async sendContractTransaction(args: SendContractTransactionArgs) {
      sent.push(args);
      return `0x${sent.length.toString(16).padStart(64, "0")}`;
    },
    async getTokenAllowance() {
      return opts.allowance ?? 0n;
    },
    async waitForTransaction({ hash }: { hash: string }) {
      waited.push(hash);
    },
  } as unknown as WalletKitAdapter;
  return { kit, sent, waited };
}

describe("executeOnchainSettlement — ERC-20 approval", () => {
  it("approves the exact amount before paying when allowance is insufficient", async () => {
    const { kit, sent, waited } = makeKit({ allowance: 0n });

    await executeOnchainSettlement({
      intent: intentWith(ARC_USDC),
      wallet: WALLET,
      walletKit: kit,
      chain: ARC_CHAIN,
      contractAddress: CONTRACT,
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
