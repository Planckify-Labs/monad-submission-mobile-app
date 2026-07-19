/**
 * Unit tests for `pathPointDepositStellar.ts` — the Stellar `deposit_points`
 * orchestrator.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types \
 *        --import ./services/walletKit/evm/_test-resolver.mjs \
 *        services/nanopay/pathPointDepositStellar.test.ts
 *
 * Scope: the orchestrator's pure composition — resolve the token SAC id, build
 * the `deposit_points` ScVal args in ABI order, and hand them to the
 * presence-checked `walletKit.sendSorobanTransaction`. The kit method itself
 * (simulate → assemble → sign → submit) is validated by the testnet round-trip.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Address, scValToNative } from "@stellar/stellar-base";

import type { ChainConfig } from "../../constants/configs/chainConfig.ts";
import type { TWallet } from "../../constants/types/walletTypes.ts";
import type {
  SendSorobanTransactionArgs,
  WalletKitAdapter,
} from "../walletKit/types.ts";
import { executePointDepositStellar } from "./pathPointDepositStellar.ts";

const CONTRACT_ID = "CCLFTLVPHOKKDZYTMGU6UNXKFEN6VF3QVYEAJNULGIC7ZXTETAIPKKRZ";
const SAC = "CDJGWVHOS6XGCL5MJJFL2WTCNSFCKAGKW2KFZQ6CDEYZICUPEWS5FT4E";
const PAYER = "GCZ6IK35AZZU2DC5HLRSEE2I3F5YUBRTALUA3ILI7V2FV5KLT2OR4LWM";

const STELLAR_CHAIN = {
  namespace: "stellar",
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
} as unknown as ChainConfig;

const WALLET = { address: PAYER } as unknown as TWallet;

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

describe("executePointDepositStellar", () => {
  it("builds deposit_points args (payer, token SAC, ref_id, amount) and returns the tx hash", async () => {
    let captured: SendSorobanTransactionArgs | undefined;
    const kit = makeKit(async (args) => {
      captured = args;
      return "stellar_deposit_hash";
    });

    const result = await executePointDepositStellar({
      wallet: WALLET,
      walletKit: kit,
      chain: STELLAR_CHAIN,
      contractId: CONTRACT_ID,
      token: SAC,
      refId: "pt_9_xyz",
      amount: 50_000_000n,
    });

    assert.equal(result.txHash, "stellar_deposit_hash");
    assert.ok(captured, "sendSorobanTransaction was called");
    assert.equal(captured!.contractId, CONTRACT_ID);
    assert.equal(captured!.method, "deposit_points");
    assert.equal(captured!.args.length, 4);
    assert.equal(captured!.args[0].switch().name, "scvAddress");
    assert.equal(Address.fromScVal(captured!.args[0]).toString(), PAYER);
    assert.equal(Address.fromScVal(captured!.args[1]).toString(), SAC);
    assert.equal(scValToNative(captured!.args[2]), "pt_9_xyz");
    assert.equal(scValToNative(captured!.args[3]), 50_000_000n);
  });

  it("throws WRONG_CHAIN_NAMESPACE for a non-Stellar chain", async () => {
    const kit = makeKit(async () => "unused");
    await assert.rejects(
      executePointDepositStellar({
        wallet: WALLET,
        walletKit: kit,
        chain: { namespace: "solana" } as unknown as ChainConfig,
        contractId: CONTRACT_ID,
        token: SAC,
        refId: "pt_1",
        amount: 1n,
      }),
      (err: unknown) =>
        (err as { code?: string }).code === "WRONG_CHAIN_NAMESPACE",
    );
  });

  it("throws WALLET_UNSUPPORTED when the kit lacks sendSorobanTransaction", async () => {
    await assert.rejects(
      executePointDepositStellar({
        wallet: WALLET,
        walletKit: makeKit(undefined),
        chain: STELLAR_CHAIN,
        contractId: CONTRACT_ID,
        token: SAC,
        refId: "pt_1",
        amount: 1n,
      }),
      (err: unknown) =>
        (err as { code?: string }).code === "WALLET_UNSUPPORTED",
    );
  });

  it("throws INVALID_AMOUNT for a non-positive amount", async () => {
    const kit = makeKit(async () => "unused");
    await assert.rejects(
      executePointDepositStellar({
        wallet: WALLET,
        walletKit: kit,
        chain: STELLAR_CHAIN,
        contractId: CONTRACT_ID,
        token: SAC,
        refId: "pt_1",
        amount: 0n,
      }),
      (err: unknown) => (err as { code?: string }).code === "INVALID_AMOUNT",
    );
  });

  it("resolves a compound CODE:ISSUER token to its SAC address arg", async () => {
    let captured: SendSorobanTransactionArgs | undefined;
    const kit = makeKit(async (args) => {
      captured = args;
      return "hash";
    });

    await executePointDepositStellar({
      wallet: WALLET,
      walletKit: kit,
      chain: STELLAR_CHAIN,
      contractId: CONTRACT_ID,
      token: `USDC:${PAYER}`,
      refId: "pt_2",
      amount: 1n,
    });

    const tokenArg = Address.fromScVal(captured!.args[1]).toString();
    assert.ok(tokenArg.startsWith("C"), "token arg is a resolved SAC id");
    assert.equal(tokenArg.length, 56);
  });
});
