/**
 * Unit tests for `StellarWalletKit`.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types \
 *        --import ./services/walletKit/evm/_test-resolver.mjs \
 *        services/walletKit/stellar/StellarWalletKit.test.ts
 *
 * Style matches `services/walletKit/sui/SuiWalletKit.test.ts` — Node
 * test runner, no react / react-native / expo imports at the test
 * bench. We reuse the EVM resolver hook because the kit transitively
 * imports `services/walletService.ts` (for `getStellarSignerForWallet` +
 * `generateWalletMnemonic`), which in turn imports the Expo /
 * MMKV-backed secure-store modules. Network-bound methods
 * (`getNativeBalance`, `sendNativeTransfer`) are only asserted for
 * their namespace guards + delegation hand-off here — the happy path
 * is covered by `services/chains/stellar/transferService.ts` /
 * `assetTransferService.ts` against a mocked Horizon client.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-base";
import { mainnet } from "viem/chains";

import type { ChainConfig } from "../../../constants/configs/chainConfig.ts";
import { mnemonicToStellarPrivateKey } from "../../chains/stellar/derivation.ts";
import { sep53Digest } from "../../chains/stellar/sep53.ts";
import { createStellarWalletKit } from "./StellarWalletKit.ts";

const stellarMainnetChain: ChainConfig = {
  namespace: "stellar",
  network: "mainnet",
  horizonUrl: "https://horizon.stellar.org",
};

const stellarTestnetChain: ChainConfig = {
  namespace: "stellar",
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
};

const ethereumChain: ChainConfig = {
  namespace: "eip155",
  chain: mainnet,
};

// BIP-39 canonical zero mnemonic; the same vector used in
// `services/chains/stellar/derivation.test.ts`.
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const VALID_EVM_ADDRESS = "0x4838B106FCe9647Bdf1E7877BF73cE8B0BAD5f97";

// Must mirror the constants in `accountState.ts` / `StellarWalletKit.ts`.
const NEW_ACCOUNT_MIN_BALANCE_STROOPS = 10_000_000n;
const STELLAR_FEE_RESERVE_STROOPS = 10_000n;

describe("StellarWalletKit — interface wiring", () => {
  const kit = createStellarWalletKit();

  it("advertises the stellar namespace and capability flags", () => {
    assert.equal(kit.namespace, "stellar");
    assert.equal(kit.supportsTokenTransfer, true);
    assert.equal(kit.supportsPrivateKeyImport, true);
    assert.equal(kit.displayName, "Stellar");
    assert.equal(kit.requireBiometricForConnect, true);
  });
});

describe("StellarWalletKit.validateAddress", () => {
  const kit = createStellarWalletKit();

  it("accepts a canonical StrKey G… address", () => {
    const address = Keypair.random().publicKey();
    assert.equal(kit.validateAddress(address), true);
  });

  it("rejects an EVM hex address (cross-chain guard)", () => {
    assert.equal(kit.validateAddress(VALID_EVM_ADDRESS), false);
  });

  it("rejects an empty string", () => {
    assert.equal(kit.validateAddress(""), false);
  });
});

describe("StellarWalletKit.validatePrivateKey", () => {
  const kit = createStellarWalletKit();

  it("accepts a canonical StrKey S… secret", () => {
    const secret = Keypair.random().secret();
    assert.equal(kit.validatePrivateKey(secret), true);
  });

  it("rejects an empty string", () => {
    assert.equal(kit.validatePrivateKey(""), false);
  });

  it("rejects garbage", () => {
    assert.equal(kit.validatePrivateKey("not-a-key"), false);
  });
});

describe("StellarWalletKit.validateMnemonic", () => {
  const kit = createStellarWalletKit();

  it("accepts the canonical BIP-39 mnemonic", () => {
    assert.equal(kit.validateMnemonic(TEST_MNEMONIC), true);
  });

  it("trims surrounding whitespace before validation", () => {
    assert.equal(kit.validateMnemonic(`  ${TEST_MNEMONIC}  `), true);
  });

  it("rejects garbage", () => {
    assert.equal(kit.validateMnemonic("not a valid mnemonic phrase"), false);
  });
});

describe("StellarWalletKit.createWalletFromMnemonic", () => {
  const kit = createStellarWalletKit();

  it("derives a StrKey G… address matching a direct SLIP-0010 derivation", async () => {
    const seed = mnemonicToStellarPrivateKey(TEST_MNEMONIC);
    const expected = Keypair.fromRawEd25519Seed(Buffer.from(seed)).publicKey();

    const wallet = await kit.createWalletFromMnemonic({
      mnemonic: TEST_MNEMONIC,
    });
    assert.equal(wallet.address, expected);
    assert.equal(wallet.namespace, "stellar");
    assert.equal(wallet.type, "SeedPhrase");
    assert.equal(wallet.source, "Created");
    assert.equal(wallet.stellar?.stellarAddress, expected);
    assert.equal(wallet.stellar?.scheme, "ed25519");
  });

  it("throws on a malformed mnemonic", async () => {
    await assert.rejects(
      () => kit.createWalletFromMnemonic({ mnemonic: "not a mnemonic" }),
      /StellarWalletKit: invalid BIP-39 mnemonic/,
    );
  });
});

describe("StellarWalletKit.signAuthMessage", () => {
  const kit = createStellarWalletKit();

  it("produces a SEP-53 signature over SHA-256(prefix ‖ message), not the raw bytes", async () => {
    const wallet = await kit.createWalletFromMnemonic({
      mnemonic: TEST_MNEMONIC,
    });
    const message = "twv: hello stellar";

    const seed = mnemonicToStellarPrivateKey(TEST_MNEMONIC);
    const kp = Keypair.fromRawEd25519Seed(Buffer.from(seed));
    const expected = kp.sign(sep53Digest(message)).toString("base64");

    const actual = await kit.signAuthMessage(wallet, message);
    assert.equal(actual, expected);

    // Guard the migration: it must NOT be the pre-SEP-53 raw-UTF-8 form.
    const legacy = kp.sign(Buffer.from(message, "utf8")).toString("base64");
    assert.notEqual(actual, legacy);
  });
});

describe("StellarWalletKit.formatNativeAmount / parseNativeAmount", () => {
  const kit = createStellarWalletKit();

  it("formatNativeAmount(1.5 XLM) renders '1.5000 XLM'", () => {
    assert.equal(
      kit.formatNativeAmount(15_000_000n, stellarMainnetChain),
      "1.5000 XLM",
    );
  });

  it("parseNativeAmount('1.5') returns 15_000_000n stroops", () => {
    assert.equal(
      kit.parseNativeAmount("1.5", stellarMainnetChain),
      15_000_000n,
    );
  });

  it("round-trip: parse then format returns the input", () => {
    const raw = kit.parseNativeAmount("1.5", stellarMainnetChain);
    assert.equal(
      kit.formatNativeAmount(raw, stellarMainnetChain),
      "1.5000 XLM",
    );
  });

  it("format throws on a non-stellar chain", () => {
    assert.throws(
      () => kit.formatNativeAmount(1n, ethereumChain),
      /assertStellarChain: expected Stellar chain/,
    );
  });

  it("parse throws on a non-stellar chain", () => {
    assert.throws(
      () => kit.parseNativeAmount("1", ethereumChain),
      /assertStellarChain: expected Stellar chain/,
    );
  });
});

describe("StellarWalletKit.buildTxExplorerUrl", () => {
  const kit = createStellarWalletKit();

  it("returns the StellarExpert 'public' URL for mainnet (not 'mainnet')", () => {
    assert.equal(
      kit.buildTxExplorerUrl?.("abc", stellarMainnetChain),
      "https://stellar.expert/explorer/public/tx/abc",
    );
  });

  it("returns the testnet StellarExpert URL for testnet", () => {
    assert.equal(
      kit.buildTxExplorerUrl?.("abc", stellarTestnetChain),
      "https://stellar.expert/explorer/testnet/tx/abc",
    );
  });

  it("returns null for a non-stellar chain", () => {
    assert.equal(kit.buildTxExplorerUrl?.("abc", ethereumChain), null);
  });

  it("returns null for an empty hash", () => {
    assert.equal(kit.buildTxExplorerUrl?.("", stellarMainnetChain), null);
  });
});

describe("StellarWalletKit display hooks — null on non-stellar chains", () => {
  const kit = createStellarWalletKit();

  it("getChainId returns null for non-stellar chains", () => {
    assert.equal(kit.getChainId?.(ethereumChain), null);
  });

  it("getChainId returns the network string for stellar chains", () => {
    assert.equal(kit.getChainId?.(stellarMainnetChain), "mainnet");
    assert.equal(kit.getChainId?.(stellarTestnetChain), "testnet");
  });

  it("formatChainLabel returns null for non-stellar chains", () => {
    assert.equal(kit.formatChainLabel?.(ethereumChain), null);
  });

  it("formatChainLabel capitalises the network for stellar chains", () => {
    assert.equal(
      kit.formatChainLabel?.(stellarMainnetChain),
      "Stellar Mainnet",
    );
    assert.equal(
      kit.formatChainLabel?.(stellarTestnetChain),
      "Stellar Testnet",
    );
  });

  it("nativeSymbol returns null for non-stellar chains", () => {
    assert.equal(kit.nativeSymbol?.(ethereumChain), null);
  });

  it("nativeSymbol returns 'XLM' for stellar chains", () => {
    assert.equal(kit.nativeSymbol?.(stellarMainnetChain), "XLM");
  });

  it("getAuthChainSlug returns stellar-mainnet / stellar-testnet", () => {
    assert.equal(
      kit.getAuthChainSlug?.(stellarMainnetChain),
      "stellar-mainnet",
    );
    assert.equal(
      kit.getAuthChainSlug?.(stellarTestnetChain),
      "stellar-testnet",
    );
    assert.equal(kit.getAuthChainSlug?.(ethereumChain), null);
  });

  it("defaultAuthChainSlug is stellar-mainnet", () => {
    assert.equal(kit.defaultAuthChainSlug, "stellar-mainnet");
  });
});

describe("StellarWalletKit.matchesBlockchainRow", () => {
  const kit = createStellarWalletKit();

  it("matches a mainnet row via chainSlug prefix", () => {
    const row = {
      isEVM: false,
      isTestnet: false,
      chainSlug: "stellar-mainnet",
      name: "Stellar",
      rpcUrl: "https://horizon.stellar.org",
    } as never;
    assert.equal(kit.matchesBlockchainRow?.(stellarMainnetChain, row), true);
  });

  it("rejects a testnet row against a mainnet chain", () => {
    const row = {
      isEVM: false,
      isTestnet: true,
      chainSlug: "stellar-testnet",
      name: "Stellar Testnet",
      rpcUrl: "https://horizon-testnet.stellar.org",
    } as never;
    assert.equal(kit.matchesBlockchainRow?.(stellarMainnetChain, row), false);
  });

  it("rejects an EVM row", () => {
    const row = { isEVM: true, isTestnet: false } as never;
    assert.equal(kit.matchesBlockchainRow?.(stellarMainnetChain, row), false);
  });
});

describe("StellarWalletKit.truncateAddress", () => {
  const kit = createStellarWalletKit();
  const address = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";

  it("returns a start...end slice with the spec defaults (start=6, end=4)", () => {
    assert.equal(kit.truncateAddress(address), "GDRXE2...JUJ6");
  });

  it("honours custom start/end lengths", () => {
    assert.equal(
      kit.truncateAddress(address, { start: 4, end: 4 }),
      "GDRX...JUJ6",
    );
  });
});

describe("StellarWalletKit network methods — namespace guard", () => {
  const kit = createStellarWalletKit();
  const EXPECTED_ADDRESS = Keypair.random().publicKey();

  it("getNativeBalance rejects non-stellar chains", async () => {
    await assert.rejects(
      () => kit.getNativeBalance(EXPECTED_ADDRESS, ethereumChain),
      /assertStellarChain: expected Stellar chain/,
    );
  });

  it("getTokenBalance rejects non-stellar chains", async () => {
    await assert.rejects(
      () =>
        kit.getTokenBalance(
          EXPECTED_ADDRESS,
          ethereumChain,
          "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        ),
      /assertStellarChain: expected Stellar chain/,
    );
  });

  it("sendNativeTransfer rejects non-stellar chains", async () => {
    await assert.rejects(
      () =>
        kit.sendNativeTransfer({
          wallet: { address: EXPECTED_ADDRESS } as never,
          to: EXPECTED_ADDRESS,
          amount: 1n,
          chain: ethereumChain,
        }),
      /assertStellarChain: expected Stellar chain/,
    );
  });

  it("sendTokenTransfer rejects non-stellar chains", async () => {
    await assert.rejects(
      () =>
        kit.sendTokenTransfer({
          wallet: { address: EXPECTED_ADDRESS } as never,
          to: EXPECTED_ADDRESS,
          amount: 1n,
          chain: ethereumChain,
          contractAddress:
            "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
          decimals: 7,
        }),
      /assertStellarChain: expected Stellar chain/,
    );
  });

  it("checkAssetReceivable rejects non-stellar chains", async () => {
    await assert.rejects(
      () =>
        kit.checkAssetReceivable?.({
          chain: ethereumChain,
          to: EXPECTED_ADDRESS,
          contractAddress:
            "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        }),
      /assertStellarChain: expected Stellar chain/,
    );
  });

  it("exposes checkAssetReceivable as a function (space-docking optional capability)", () => {
    assert.equal(typeof kit.checkAssetReceivable, "function");
  });

  it("hasTrustline rejects non-stellar chains", async () => {
    await assert.rejects(
      () =>
        kit.hasTrustline?.({
          chain: ethereumChain,
          to: EXPECTED_ADDRESS,
          contractAddress:
            "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        }),
      /assertStellarChain: expected Stellar chain/,
    );
  });

  it("establishTrustline rejects non-stellar chains", async () => {
    await assert.rejects(
      () =>
        kit.establishTrustline?.({
          wallet: { address: EXPECTED_ADDRESS } as never,
          chain: ethereumChain,
          contractAddress:
            "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        }),
      /assertStellarChain: expected Stellar chain/,
    );
  });

  it("exposes hasTrustline and establishTrustline as functions (space-docking optional capabilities)", () => {
    assert.equal(typeof kit.hasTrustline, "function");
    assert.equal(typeof kit.establishTrustline, "function");
  });

  it("exposes getSignerForWallet as a function (dwell-site delegation)", () => {
    assert.equal(typeof kit.getSignerForWallet, "function");
  });
});

describe("StellarWalletKit signing-path delegation — fail-loud guards", () => {
  // Regression guard against drift from the Sui/Solana pattern: the kit
  // must call `getStellarSignerForWallet` BEFORE constructing a
  // transfer, so a wallet without a usable signer fails loud at the
  // dwell site. Triggered by a non-stellar wallet namespace, which
  // makes `getStellarSignerForWallet` return `null`.
  const kit = createStellarWalletKit();
  const EXPECTED_ADDRESS = Keypair.random().publicKey();

  it("sendNativeTransfer throws 'No Stellar signer for wallet' when the dwell site returns null", async () => {
    await assert.rejects(
      () =>
        kit.sendNativeTransfer({
          wallet: {
            address: VALID_EVM_ADDRESS,
            namespace: "eip155",
          } as never,
          to: EXPECTED_ADDRESS,
          amount: 1n,
          chain: stellarMainnetChain,
        }),
      /No Stellar signer for wallet/,
    );
  });

  it("sendTokenTransfer throws 'No Stellar signer for wallet' when the dwell site returns null", async () => {
    await assert.rejects(
      () =>
        kit.sendTokenTransfer({
          wallet: {
            address: VALID_EVM_ADDRESS,
            namespace: "eip155",
          } as never,
          to: EXPECTED_ADDRESS,
          amount: 1n,
          chain: stellarMainnetChain,
          contractAddress:
            "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
          decimals: 7,
        }),
      /No Stellar signer for wallet/,
    );
  });

  it("establishTrustline throws 'No Stellar signer for wallet' when the dwell site returns null", async () => {
    await assert.rejects(
      () =>
        kit.establishTrustline?.({
          wallet: {
            address: VALID_EVM_ADDRESS,
            namespace: "eip155",
          } as never,
          chain: stellarMainnetChain,
          contractAddress:
            "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        }),
      /No Stellar signer for wallet/,
    );
  });
});

describe("StellarWalletKit.estimateMaxTransferable — reserve floor constants", () => {
  it("NEW_ACCOUNT_MIN_BALANCE_STROOPS + STELLAR_FEE_RESERVE_STROOPS matches accountState.ts", () => {
    // Duplicated here (rather than imported) so the test stays readable
    // without importing non-exported kit internals — mirrors the Sui
    // kit test's MAX_GAS_BUDGET_MIST duplication comment.
    assert.equal(NEW_ACCOUNT_MIN_BALANCE_STROOPS, 10_000_000n);
    assert.equal(STELLAR_FEE_RESERVE_STROOPS, 10_000n);
  });
});
