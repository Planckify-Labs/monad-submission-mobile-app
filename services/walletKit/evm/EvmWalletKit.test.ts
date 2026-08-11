/**
 * Unit tests for `EvmWalletKit`.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types \
 *        --import ./services/walletKit/evm/_test-resolver.mjs \
 *        services/walletKit/evm/EvmWalletKit.test.ts
 *
 * Style matches `services/walletKit/registry.test.ts` — Node test
 * runner, no react / react-native / expo imports at the test bench.
 *
 * The companion `_test-resolver.mjs` resolves the `@/*` path alias and
 * `.ts` extensions so the kit and its helper chain load under plain
 * Node. Network-bound methods (`getNativeBalance`,
 * `sendNativeTransfer`, `estimateMaxTransferable`) defer to viem
 * clients constructed inside `utils/clients.ts` with no DI seam; they
 * are stubbed below via `TODO` to avoid hitting mainnet.
 *
 * R4b guard: `validateAddress`, `validateMnemonic`, `formatNativeAmount`,
 * `parseNativeAmount`, and `truncateAddress` are asserted byte-identical
 * to the underlying helpers (`isAddress`, `isValidMnemonic`,
 * `formatUnits` / `parseUnits`, `truncateAddress` in `walletUtils.ts`).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as smartAccountsKit from "@metamask/smart-accounts-kit";
import { formatUnits, isAddress, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import type { TBlockchain } from "../../../api/types/blockchain.ts";
import type { ChainConfig } from "../../../constants/configs/chainConfig.ts";
import * as clients from "../../../utils/clients.ts";
import { truncateAddress as truncateAddressUtil } from "../../../utils/walletUtils.ts";
import { createEvmWalletKit } from "./EvmWalletKit.ts";

const setGlobalMockPublicClient = (clients as any).setGlobalMockPublicClient;
const setGlobalMockWalletClient = (clients as any).setGlobalMockWalletClient;

const ethereumChain: ChainConfig = {
  namespace: "eip155",
  chain: mainnet,
};

const solanaChain: ChainConfig = {
  namespace: "solana",
  cluster: "devnet",
  rpcUrl: "https://api.devnet.solana.com",
};

const VALID_ADDRESS = "0x4838B106FCe9647Bdf1E7877BF73cE8B0BAD5f97";
const INVALID_ADDRESS = "0xNOT_AN_ADDRESS";
const VALID_MNEMONIC =
  "test test test test test test test test test test test junk";

describe("EvmWalletKit — interface wiring", () => {
  const kit = createEvmWalletKit();

  it("advertises the eip155 namespace and capability flags", () => {
    assert.equal(kit.namespace, "eip155");
    assert.equal(kit.supportsTokenTransfer, true);
    assert.equal(kit.supportsPrivateKeyImport, true);
  });
});

describe("EvmWalletKit.validateAddress (R4b bytes-out parity)", () => {
  const kit = createEvmWalletKit();

  it("returns true for a valid EVM address", () => {
    assert.equal(kit.validateAddress(VALID_ADDRESS), true);
  });

  it("returns false for garbage input", () => {
    assert.equal(kit.validateAddress(INVALID_ADDRESS), false);
    assert.equal(kit.validateAddress(""), false);
  });

  it("matches viem `isAddress` byte-for-byte on mixed inputs", () => {
    const cases = [
      VALID_ADDRESS,
      VALID_ADDRESS.toLowerCase(),
      INVALID_ADDRESS,
      "",
      "0x0000000000000000000000000000000000000000",
      "not-hex",
    ];
    for (const c of cases) {
      assert.equal(
        kit.validateAddress(c),
        isAddress(c),
        `parity broken for input ${JSON.stringify(c)}`,
      );
    }
  });
});

describe("EvmWalletKit.validateMnemonic", () => {
  const kit = createEvmWalletKit();

  it("accepts a canonical 12-word mnemonic", () => {
    assert.equal(kit.validateMnemonic(VALID_MNEMONIC), true);
  });

  it("rejects a mnemonic with the wrong word count", () => {
    assert.equal(kit.validateMnemonic("too few words"), false);
  });

  it("trims surrounding whitespace like the underlying helper", () => {
    assert.equal(kit.validateMnemonic(`  ${VALID_MNEMONIC}  `), true);
  });
});

describe("EvmWalletKit.formatNativeAmount / parseNativeAmount", () => {
  const kit = createEvmWalletKit();

  it("formatNativeAmount renders `<amount> <symbol>` matching the spec (R4b)", () => {
    const raw = 1_234_567_890_123_456_789n;
    const human = parseFloat(
      formatUnits(raw, mainnet.nativeCurrency.decimals),
    ).toFixed(4);
    assert.equal(
      kit.formatNativeAmount(raw, ethereumChain),
      `${human} ${mainnet.nativeCurrency.symbol}`,
    );
  });

  it("round-trips a human-denominated ETH value through parse → format", () => {
    const human = "1.5";
    const raw = kit.parseNativeAmount(human, ethereumChain);
    assert.equal(raw, parseUnits(human, mainnet.nativeCurrency.decimals));
    const display = parseFloat(
      formatUnits(raw, mainnet.nativeCurrency.decimals),
    ).toFixed(4);
    assert.equal(
      kit.formatNativeAmount(raw, ethereumChain),
      `${display} ${mainnet.nativeCurrency.symbol}`,
    );
  });

  it("throws a clear error when handed a non-eip155 chain", () => {
    assert.throws(
      () => kit.formatNativeAmount(1n, solanaChain),
      /EvmWalletKit: expected eip155 chain/,
    );
    assert.throws(
      () => kit.parseNativeAmount("1", solanaChain),
      /EvmWalletKit: expected eip155 chain/,
    );
  });
});

describe("EvmWalletKit.truncateAddress (parity with utils/walletUtils)", () => {
  const kit = createEvmWalletKit();

  it("default preset matches the existing util", () => {
    assert.equal(
      kit.truncateAddress(VALID_ADDRESS),
      truncateAddressUtil({ address: VALID_ADDRESS }),
    );
  });

  it("honors custom start/end lengths via the kit's opts shape", () => {
    const opts = { start: 6, end: 4 };
    assert.equal(
      kit.truncateAddress(VALID_ADDRESS, opts),
      truncateAddressUtil({
        address: VALID_ADDRESS,
        startLength: opts.start,
        endLength: opts.end,
      }),
    );
  });

  it("handles empty-string address the same way as the util", () => {
    assert.equal(kit.truncateAddress(""), truncateAddressUtil({ address: "" }));
  });
});

describe("EvmWalletKit network methods — namespace guard", () => {
  const kit = createEvmWalletKit();

  it("getNativeBalance rejects non-eip155 chains", async () => {
    await assert.rejects(
      () => kit.getNativeBalance(VALID_ADDRESS, solanaChain),
      /EvmWalletKit: expected eip155 chain/,
    );
  });

  it("sendNativeTransfer rejects non-eip155 chains", async () => {
    await assert.rejects(
      () =>
        kit.sendNativeTransfer({
          wallet: { address: VALID_ADDRESS } as never,
          to: VALID_ADDRESS,
          amount: 1n,
          chain: solanaChain,
        }),
      /EvmWalletKit: expected eip155 chain/,
    );
  });

  it("estimateMaxTransferable rejects non-eip155 chains", async () => {
    await assert.rejects(
      () =>
        kit.estimateMaxTransferable({
          balance: 1n,
          chain: solanaChain,
          from: VALID_ADDRESS,
        }),
      /EvmWalletKit: expected eip155 chain/,
    );
  });
});

describe("EvmWalletKit.upgradeToSmartAccount & isSmartAccountActive", () => {
  const kit = createEvmWalletKit();
  const key = generatePrivateKey();
  const mockAccount = privateKeyToAccount(key);
  const wallet = {
    address: mockAccount.address,
    namespace: "eip155",
    type: "PrivateKey",
    privateKey: key,
  } as any;

  it("upgradeToSmartAccount rejects non-eip155 chains", async () => {
    await assert.rejects(
      () => kit.upgradeToSmartAccount!({ wallet, chain: solanaChain }),
      /EvmWalletKit: expected eip155 chain/,
    );
  });

  it("isSmartAccountActive returns false for EOA and true for active smart account", async () => {
    // 1. Mock public client to return empty bytecode (EOA)
    const mockPublicClient = {
      getCode: async () => "0x",
    };
    setGlobalMockPublicClient(mockPublicClient);

    const activeBefore = await kit.isSmartAccountActive!(wallet, ethereumChain);
    assert.equal(activeBefore, false);

    // 2. Mock public client to return upgraded contract bytecode (prefix 0xef0100)
    const mockPublicClientActive = {
      getCode: async () => "0xef0100abcdef",
    };
    setGlobalMockPublicClient(mockPublicClientActive);

    const activeAfter = await kit.isSmartAccountActive!(wallet, ethereumChain);
    assert.equal(activeAfter, true);

    setGlobalMockPublicClient(null);
  });

  it("upgradeToSmartAccount executes EIP-7702 upgrade flow adhering to security allowlist and bytecode sniffing", async () => {
    const mockPublicClient = {
      getCode: async () => "0x",
      waitForTransactionReceipt: async () => ({ status: "success" }),
      getTransactionCount: async () => 0,
    };

    let signedAuthorizationArgs: any = null;
    let sentTransactionArgs: any = null;

    const mockWalletClient = {
      signAuthorization: async (args: any) => {
        signedAuthorizationArgs = args;
        return {
          contractAddress: args.contractAddress,
          chainId: 1,
          nonce: 0,
          yParity: 0,
          r: "0x",
          s: "0x",
        };
      },
      sendTransaction: async (args: any) => {
        sentTransactionArgs = args;
        return "0xmocktxhash";
      },
    };

    setGlobalMockPublicClient(mockPublicClient);
    setGlobalMockWalletClient(mockWalletClient);

    const res = await kit.upgradeToSmartAccount!({
      wallet,
      chain: ethereumChain,
    });

    assert.equal(res.transactionHash, "0xmocktxhash");
    assert.equal(res.smartAccountAddress, wallet.address);

    // Assert correct delegator address and self executor used
    assert.equal(
      signedAuthorizationArgs.contractAddress,
      "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B",
    );
    assert.equal(signedAuthorizationArgs.executor, "self");

    // Assert transaction submission format
    assert.equal(sentTransactionArgs.authorizationList.length, 1);
    assert.equal(sentTransactionArgs.to, wallet.address);

    // Clean up
    setGlobalMockPublicClient(null);
    setGlobalMockWalletClient(null);
  });

  it("upgradeToSmartAccount rejects delegator address not on allowlist (SI-1)", async () => {
    // Mock getSmartAccountsEnvironment to return a non-allowlisted delegator address
    (smartAccountsKit as any).setMockEnvironment({
      implementations: {
        EIP7702StatelessDeleGatorImpl:
          "0x1234567890abcdef1234567890abcdef12345678",
      },
    });

    await assert.rejects(
      () => kit.upgradeToSmartAccount!({ wallet, chain: ethereumChain }),
      /delegator not on EIP-7702 allowlist/,
    );

    (smartAccountsKit as any).setMockEnvironment(null);
  });

  it("upgradeToSmartAccount rejects delegator bytecode containing SELFDESTRUCT (SI-2)", async () => {
    // Mock public client to return bytecode containing SELFDESTRUCT
    const mockPublicClient = {
      getCode: async () => "0x6080604052ff5b",
      waitForTransactionReceipt: async () => ({ status: "success" }),
    };
    setGlobalMockPublicClient(mockPublicClient);

    await assert.rejects(
      () => kit.upgradeToSmartAccount!({ wallet, chain: ethereumChain }),
      /delegator bytecode contains SELFDESTRUCT in prologue/,
    );

    setGlobalMockPublicClient(null);
  });
});

function evmRow(partial: Partial<TBlockchain>): TBlockchain {
  return {
    id: "row",
    name: "Row",
    chainId: null,
    chainSlug: null,
    rpcUrl: "",
    blockExplorer: "",
    isEVM: false,
    isActive: true,
    isTestnet: false,
    updatedAt: "",
    ...partial,
  } as TBlockchain;
}

describe("EvmWalletKit — chain-agnostic capabilities", () => {
  const kit = createEvmWalletKit();

  it("does not implement auth chainSlug (EVM keys on chainId)", () => {
    assert.equal(kit.getAuthChainSlug, undefined);
    assert.equal(kit.defaultAuthChainSlug, undefined);
  });

  it("advertises the evm payment rail", () => {
    assert.equal(kit.preferredPaymentRail, "evm");
  });

  it("gates dApp connect behind the device-owner check, like every other kit", () => {
    // Regression: this kit shipped without the flag, so `ConnectSheet`'s
    // `kit?.requireBiometricForConnect === true` was false and an EVM-only
    // dApp connected on a bare tap — while the same tap on a Solana, Sui or
    // Stellar dApp prompted for biometric/PIN.
    assert.equal(kit.requireBiometricForConnect, true);
  });

  it("matchesBlockchainRow matches an EVM row by chainId", () => {
    assert.equal(
      kit.matchesBlockchainRow?.(
        ethereumChain,
        evmRow({ isEVM: true, chainId: 1 }),
      ),
      true,
    );
  });

  it("matchesBlockchainRow rejects wrong chainId, non-EVM rows, and non-EVM chains", () => {
    assert.equal(
      kit.matchesBlockchainRow?.(
        ethereumChain,
        evmRow({ isEVM: true, chainId: 8453 }),
      ),
      false,
    );
    assert.equal(
      kit.matchesBlockchainRow?.(
        ethereumChain,
        evmRow({ isEVM: false, chainSlug: "solana-mainnet" }),
      ),
      false,
    );
    assert.equal(
      kit.matchesBlockchainRow?.(
        solanaChain,
        evmRow({ isEVM: true, chainId: 1 }),
      ),
      false,
    );
  });
});
