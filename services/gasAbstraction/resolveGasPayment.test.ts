/**
 * Tests for the gas-payment policy/selector.
 *
 * Uses injected deps (no global registries). Verifies the three outcomes:
 * native fallthrough (preference / unsupported chain / not-eligible),
 * abstracted happy path, and blocked-on-insufficient-balance.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baseSepolia, mainnet } from "viem/chains";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import { type GasPaymentPlan, resolveGasPayment } from "./resolveGasPayment";
import type { GasAbstractionProvider, GasAbstractionQuote } from "./types";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const chain: ChainConfig = { namespace: "eip155", chain: baseSepolia };
const solanaChain: ChainConfig = {
  namespace: "solana",
  cluster: "devnet",
  rpcUrl: "https://api.devnet.solana.com",
};
const wallet = { address: "0x1", namespace: "eip155" } as TWallet;
const intent = { to: "0x2", tokenAddress: USDC, amount: 500_000n, decimals: 6 };

const quote: GasAbstractionQuote = {
  providerId: "1shot",
  feeToken: { address: USDC, symbol: "USDC", decimals: 6 },
  feeAmount: 100_000n,
  totalRequired: 600_000n,
};

function fakeProvider(
  overrides: Partial<GasAbstractionProvider> = {},
): GasAbstractionProvider {
  return {
    id: "1shot",
    supportsChain: () => true,
    listFeeTokens: async () => [quote.feeToken],
    supportsIntent: async () => true,
    getQuote: async () => quote,
    execute: async () => ({ providerId: "1shot", taskId: "0xt" }),
    getStatus: async () => ({ status: "pending", statusCode: 100 }),
    ...overrides,
  };
}

const deps = (provider: GasAbstractionProvider | null, balance: bigint) => ({
  resolveProvider: () => provider,
  getTokenBalance: async () => balance,
});

describe("resolveGasPayment", () => {
  it("returns native when preference is native", async () => {
    const plan = await resolveGasPayment(
      { wallet, chain, intent, preferredGasToken: "native" },
      deps(fakeProvider(), 10_000_000n),
    );
    assert.equal(plan.mode, "native");
  });

  it("returns native on an unsupported (non-EVM) chain", async () => {
    const plan = await resolveGasPayment(
      { wallet, chain: solanaChain, intent, preferredGasToken: "USDC" },
      deps(fakeProvider(), 10_000_000n),
    );
    assert.equal(plan.mode, "native");
  });

  it("returns native on a supported namespace but non-allowlisted chain", async () => {
    // mainnet (1) is allowlisted; use a chain not in the set to prove the gate.
    const unlisted: ChainConfig = {
      namespace: "eip155",
      chain: { ...mainnet, id: 999999 },
    };
    const plan = await resolveGasPayment(
      { wallet, chain: unlisted, intent, preferredGasToken: "USDC" },
      deps(fakeProvider(), 10_000_000n),
    );
    assert.equal(plan.mode, "native");
  });

  it("returns native when the intent is not eligible (getQuote throws)", async () => {
    const provider = fakeProvider({
      getQuote: async () => {
        throw new Error("token not accepted");
      },
    });
    const plan = await resolveGasPayment(
      { wallet, chain, intent, preferredGasToken: "USDC" },
      deps(provider, 10_000_000n),
    );
    assert.equal(plan.mode, "native");
  });

  it("returns abstracted when the wallet covers amount + fee", async () => {
    const plan = await resolveGasPayment(
      { wallet, chain, intent, preferredGasToken: "USDC" },
      deps(fakeProvider(), 600_000n),
    );
    assert.equal(plan.mode, "abstracted");
    if (plan.mode === "abstracted") {
      assert.equal(plan.quote.totalRequired, 600_000n);
      assert.equal(plan.provider.id, "1shot");
    }
  });

  it("forwards the preferred symbol to the provider quote", async () => {
    let seen: string | undefined;
    const provider = fakeProvider({
      getQuote: async (args) => {
        seen = args.feeTokenSymbol;
        return quote;
      },
    });
    await resolveGasPayment(
      { wallet, chain, intent, preferredGasToken: "USDT0" },
      deps(provider, 10_000_000n),
    );
    assert.equal(seen, "USDT0");
  });

  it("blocks (no silent native) when balance < amount + fee", async () => {
    const plan: GasPaymentPlan = await resolveGasPayment(
      { wallet, chain, intent, preferredGasToken: "USDC" },
      deps(fakeProvider(), 550_000n),
    );
    assert.equal(plan.mode, "blocked");
    if (plan.mode === "blocked") {
      assert.equal(plan.reason, "insufficient_balance");
      assert.equal(plan.needed, 600_000n);
      assert.equal(plan.have, 550_000n);
    }
  });
});
