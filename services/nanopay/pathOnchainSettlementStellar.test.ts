/**
 * Unit tests for `pathOnchainSettlementStellar.ts` — the Stellar `takumipay`
 * settlement orchestrator.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types \
 *        --import ./services/walletKit/evm/_test-resolver.mjs \
 *        services/nanopay/pathOnchainSettlementStellar.test.ts
 *
 * Scope: the orchestrator's pure composition — parse the wire commitment,
 * build the `process_merchant_payment` ScVal args, and hand them to the
 * presence-checked `walletKit.sendSorobanTransaction`. The wallet-kit method
 * itself (simulate → assemble → sign → submit) is validated by the testnet
 * round-trip, not mocked here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChainConfig } from "../../constants/configs/chainConfig.ts";
import type { TWallet } from "../../constants/types/walletTypes.ts";
import type {
  SendSorobanTransactionArgs,
  WalletKitAdapter,
} from "../walletKit/types.ts";
import { executeOnchainSettlementStellar } from "./pathOnchainSettlementStellar.ts";
import type { PaymentIntentResponse, QuoteCommitmentStellar } from "./types.ts";

const CONTRACT_ID = "CCLFTLVPHOKKDZYTMGU6UNXKFEN6VF3QVYEAJNULGIC7ZXTETAIPKKRZ";
const PAYER = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const SIGNATURE_B64 = Buffer.from(new Uint8Array(64)).toString("base64");

const STELLAR_CHAIN = {
  namespace: "stellar",
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
} as unknown as ChainConfig;

const WALLET = { address: PAYER } as unknown as TWallet;

const COMMITMENT: QuoteCommitmentStellar = {
  refId: "intent_1",
  merchantId: "merchant_1",
  token: CONTRACT_ID,
  amount: "1000000",
  platformFeeAmount: "25000",
  fiatAmountMinor: "150000",
  fiatCurrency: "IDR",
  exchangeRateId: "42",
  expiresAt: "1752300000",
};

function makeIntent(
  overrides: Partial<PaymentIntentResponse> = {},
): PaymentIntentResponse {
  return {
    id: "intent_1",
    quoteCommitmentStellar: COMMITMENT,
    quoteSignatureStellar: SIGNATURE_B64,
    takumiPayContractId: CONTRACT_ID,
    blockchainId: "bc_xlm",
    ...overrides,
  } as unknown as PaymentIntentResponse;
}

function makeKit(
  sendSorobanTransaction?: (
    args: SendSorobanTransactionArgs,
  ) => Promise<string>,
): WalletKitAdapter {
  return {
    namespace: "stellar",
    sendSorobanTransaction,
  } as unknown as WalletKitAdapter;
}

describe("executeOnchainSettlementStellar", () => {
  it("builds process_merchant_payment args and returns the tx hash", async () => {
    let captured: SendSorobanTransactionArgs | undefined;
    const kit = makeKit(async (args) => {
      captured = args;
      return "stellar_tx_hash_abc";
    });

    const result = await executeOnchainSettlementStellar({
      intent: makeIntent(),
      wallet: WALLET,
      walletKit: kit,
      chain: STELLAR_CHAIN,
      contractId: CONTRACT_ID,
    });

    assert.equal(result.txHash, "stellar_tx_hash_abc");
    assert.ok(captured, "sendSorobanTransaction was called");
    assert.equal(captured!.contractId, CONTRACT_ID);
    assert.equal(captured!.method, "process_merchant_payment");
    // payer + quote + backend_signature.
    assert.equal(captured!.args.length, 3);
    // First arg is the payer Address ScVal (SCV_ADDRESS).
    assert.equal(captured!.args[0].switch().name, "scvAddress");
  });

  it("throws MISSING_QUOTE when the commitment/signature is absent", async () => {
    const kit = makeKit(async () => "unused");
    await assert.rejects(
      executeOnchainSettlementStellar({
        intent: makeIntent({ quoteSignatureStellar: undefined }),
        wallet: WALLET,
        walletKit: kit,
        chain: STELLAR_CHAIN,
        contractId: CONTRACT_ID,
      }),
      (err: unknown) =>
        err instanceof Error &&
        (err as { code?: string }).code === "MISSING_QUOTE",
    );
  });

  it("throws WRONG_CHAIN_NAMESPACE for a non-Stellar chain", async () => {
    const kit = makeKit(async () => "unused");
    await assert.rejects(
      executeOnchainSettlementStellar({
        intent: makeIntent(),
        wallet: WALLET,
        walletKit: kit,
        chain: { namespace: "solana" } as unknown as ChainConfig,
        contractId: CONTRACT_ID,
      }),
      (err: unknown) =>
        (err as { code?: string }).code === "WRONG_CHAIN_NAMESPACE",
    );
  });

  it("throws WALLET_UNSUPPORTED when the kit lacks sendSorobanTransaction", async () => {
    await assert.rejects(
      executeOnchainSettlementStellar({
        intent: makeIntent(),
        wallet: WALLET,
        walletKit: makeKit(undefined),
        chain: STELLAR_CHAIN,
        contractId: CONTRACT_ID,
      }),
      (err: unknown) =>
        (err as { code?: string }).code === "WALLET_UNSUPPORTED",
    );
  });
});
