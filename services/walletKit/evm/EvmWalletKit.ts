/**
 * `EvmWalletKit` — relocates existing EVM helpers behind the
 * `WalletKitAdapter` interface.
 *
 * Per spec §4.5 / §7.6 and Task 05: this is a **no-behavior-change**
 * relocation. Every call site forwards to the existing helper in
 * `utils/walletUtils.ts`, `utils/clients.ts`, or
 * `services/walletService.ts` — no reimplementation, no reformatting,
 * no "while we're here" cleanup. R4b mitigation depends on this.
 *
 * Callers are responsible for dispatching on `ChainConfig.namespace`
 * via `walletKitRegistry`; every method here narrows to `"eip155"` at
 * entry and throws on mismatch.
 */

import { getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import {
  erc20Abi,
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
  zeroAddress,
} from "viem";
import type { ChainConfig } from "../../../constants/configs/chainConfig.ts";
import type { TWallet } from "../../../constants/types/walletTypes.ts";
import { getPublicClient, getWalletClient } from "../../../utils/clients.ts";
import {
  createWalletFromMnemonic as createEvmWalletFromMnemonic,
  createWalletFromPrivateKey as createEvmWalletFromPrivateKey,
  isValidMnemonic,
  isValidPrivateKey,
  truncateAddress as truncateAddressUtil,
} from "../../../utils/walletUtils.ts";
import {
  decideAuthorizationByAddress,
  decideAuthorizationByBytecode,
} from "../../chains/evm/eip7702Guard.ts";
import { fixedErc20TransferGasLimit } from "../../chains/evm/monad.ts";
import {
  generateWalletMnemonic,
  getAccountForWallet,
} from "../../walletService.ts";
import type {
  ContractCallFeeEstimate,
  CreateDelegationArgs,
  CreateWalletFromMnemonicParams,
  CreateWalletFromPrivateKeyParams,
  DelegationStruct,
  EncodeDelegationsArgs,
  Estimate7710TransactionArgs,
  Estimate7710TransactionResult,
  EstimateContractCallFeeArgs,
  EstimateMaxTransferableArgs,
  GetRelayerFeeDataArgs,
  GetRelayerStatusArgs,
  GetTokenAllowanceArgs,
  NativeTransferArgs,
  RelayerAuthorizationEntry,
  RelayerCapabilities,
  RelayerFeeData,
  RelayerStatus,
  Send7710TransactionArgs,
  Send7710TransactionResult,
  SendContractTransactionArgs,
  SendUserOpResult,
  SendUserOpWithUsdcPaymasterArgs,
  SettleX402PaymentArgs,
  SettleX402PaymentResult,
  SignDelegationArgs,
  SignEip7702AuthorizationArgs,
  SignTransferWithAuthorizationArgs,
  TokenTransferArgs,
  TruncateAddressOptions,
  UpgradeToSmartAccountArgs,
  UpgradeToSmartAccountResult,
  WaitForTransactionArgs,
  WalletKitAdapter,
} from "../types.ts";
import {
  evmCaip2For,
  evmCheckBridgeDestinationReadiness,
  evmSubmitBridgeExecution,
  evmToAssetCaip19,
} from "./bridge.ts";
import {
  computeEvmSigningDigest,
  resolveEvmClearSigningDescriptor,
} from "./clearSigning.ts";
import {
  buildUnsignedDelegation,
  DELEGATION_ZERO_SALT,
  encodeSignedDelegations,
  signUnsignedDelegation,
} from "./delegations.ts";
import { bootstrapEvmSettlementRails } from "./rails/bootstrap.ts";
import {
  relayerEstimate7710Transaction,
  relayerGetCapabilities,
  relayerGetFeeData,
  relayerGetStatus,
  relayerSend7710Transaction,
} from "./relayer.ts";
import { sendUserOpWithUsdcPaymaster as sendUserOpWithUsdcPaymasterPure } from "./sendUserOpWithUsdcPaymaster.ts";
import { signTransferWithAuthorization as signTransferWithAuthorizationPure } from "./signTransferWithAuthorization.ts";
import {
  evmWalletConnectCodec,
  evmWalletConnectNamespace,
} from "./walletConnect";
import { settleX402PaymentEvm } from "./x402Settle.ts";

const EVM_NAMESPACE = "eip155" as const;

/** Canonical MetaMask stateless-7702 delegator (fallback if env lookup fails). */
const FALLBACK_STATELESS_DELEGATOR =
  "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B" as `0x${string}`;

function assertEvm(
  chain: ChainConfig,
): asserts chain is Extract<ChainConfig, { namespace: "eip155" }> {
  if (chain.namespace !== EVM_NAMESPACE) {
    throw new Error("EvmWalletKit: expected eip155 chain");
  }
}

/**
 * Resolves the EIP-7702 stateless-delegator implementation address for
 * `chainId` from the MetaMask smart-accounts environment, falling back to
 * the canonical address when the env lookup is unavailable. Shared by the
 * standalone upgrade flow and the relayer `authorizationList` builder.
 */
function resolveStatelessDelegatorAddress(chainId: number): `0x${string}` {
  try {
    const environment = getSmartAccountsEnvironment(chainId);
    const impl = environment?.implementations?.EIP7702StatelessDeleGatorImpl;
    if (impl) return impl as `0x${string}`;
  } catch {
    // Fall through to the canonical fallback below.
  }
  return FALLBACK_STATELESS_DELEGATOR;
}

export function createEvmWalletKit(): WalletKitAdapter {
  // Dock the EVM settlement rails into the x402 settlement registry
  // (idempotent). The `settleX402Payment` chain resolves them by presence.
  bootstrapEvmSettlementRails();

  return {
    namespace: EVM_NAMESPACE,
    supportsTokenTransfer: true,
    supportsPrivateKeyImport: true,
    // `TakumiPay.depositPoints` — the ERC-20 approve + deposit path in
    // `hooks/deposit/useDepositState.ts`.
    supportsPointDeposit: true,
    displayName: "Ethereum",
    brandColor: "#627EEA",
    // Connect binds a wallet to an origin and is the gate every later
    // signing request rides on, so it needs the same device-owner check
    // Solana / Sui / Stellar already require. This kit previously omitted
    // the flag "for parity with MetaMask", which made the wallet's
    // strongest chain family its least protected one: an EVM-only dApp
    // could be connected by anyone holding an unlocked phone, while the
    // exact same tap on a Solana or Sui dApp prompted for biometric/PIN.
    requireBiometricForConnect: true,
    preferredPaymentRail: "evm",
    // Deep-link spec §4.5 — WalletConnect `eip155` namespace / codec.
    // No `buildPaymentRequest`: ERC-681 payments route to the send screen.
    walletConnectNamespace: evmWalletConnectNamespace,
    walletConnectCodec: evmWalletConnectCodec,
    getChainId(chain) {
      return chain.namespace === EVM_NAMESPACE ? chain.chain.id : null;
    },
    formatChainLabel(chain) {
      return chain.namespace === EVM_NAMESPACE ? chain.chain.name : null;
    },
    nativeSymbol(chain) {
      return chain.namespace === EVM_NAMESPACE
        ? chain.chain.nativeCurrency.symbol
        : null;
    },
    matchesBlockchainRow(chain, row) {
      return (
        chain.namespace === EVM_NAMESPACE &&
        row.isEVM === true &&
        row.chainId === chain.chain.id
      );
    },
    buildTxExplorerUrl(txHash, chain) {
      if (chain.namespace !== EVM_NAMESPACE) return null;
      if (!txHash) return null;
      const explorer = chain.chain.blockExplorers?.default?.url;
      if (!explorer || typeof explorer !== "string") return null;
      const base = explorer.endsWith("/") ? explorer.slice(0, -1) : explorer;
      return `${base}/tx/${txHash}`;
    },

    canonicalizeAddress(address) {
      // EIP-55 checksum collapses case; fall back to lowercase for a
      // malformed-but-hex string rather than throwing.
      try {
        return getAddress(address);
      } catch {
        return address.toLowerCase();
      }
    },

    // ── Wallet creation & validation ────────────────────────────────
    validateAddress: (address: string): boolean => isAddress(address),
    validatePrivateKey: (privateKey: string): boolean =>
      isValidPrivateKey(privateKey),
    validateMnemonic: (mnemonic: string): boolean => isValidMnemonic(mnemonic),

    async createWalletFromPrivateKey(
      params: CreateWalletFromPrivateKeyParams,
    ): Promise<TWallet> {
      return createEvmWalletFromPrivateKey(params.privateKey, params.name);
    },

    async createWalletFromMnemonic(
      params: CreateWalletFromMnemonicParams,
    ): Promise<TWallet> {
      return createEvmWalletFromMnemonic(params.mnemonic, params.name);
    },

    generateMnemonic: (): string => generateWalletMnemonic(),

    // ── Keys & signers ──────────────────────────────────────────────
    async getSignerForWallet(wallet: TWallet): Promise<unknown | null> {
      return getAccountForWallet(wallet);
    },

    // ── Auth ────────────────────────────────────────────────────────
    async signAuthMessage(wallet: TWallet, message: string): Promise<string> {
      const account = getAccountForWallet(wallet);
      if (!account) {
        throw new Error(
          "EvmWalletKit.signAuthMessage: unable to reconstruct signer",
        );
      }
      return account.signMessage({ message });
    },

    // ── Reads ───────────────────────────────────────────────────────
    async getNativeBalance(
      address: string,
      chain: ChainConfig,
    ): Promise<bigint> {
      assertEvm(chain);
      const pc = getPublicClient(chain.chain);
      return pc.getBalance({ address: address as `0x${string}` });
    },

    async getTokenBalance(
      address: string,
      chain: ChainConfig,
      contractAddress: string,
    ): Promise<bigint> {
      assertEvm(chain);
      const pc = getPublicClient(chain.chain);
      return (await pc.readContract({
        address: contractAddress as `0x${string}`,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address as `0x${string}`],
      })) as bigint;
    },

    // ── Writes ──────────────────────────────────────────────────────
    async sendNativeTransfer({
      wallet,
      to,
      amount,
      chain,
    }: NativeTransferArgs): Promise<string> {
      assertEvm(chain);
      const account = getAccountForWallet(wallet);
      if (!account) {
        throw new Error("EvmWalletKit: unable to reconstruct signer");
      }
      const wc = getWalletClient(account, chain.chain);
      const hash = await wc.sendTransaction({
        to: to as `0x${string}`,
        value: amount,
      });
      return hash;
    },

    async sendTokenTransfer({
      wallet,
      to,
      amount,
      chain,
      contractAddress,
      decimals,
    }: TokenTransferArgs): Promise<string> {
      assertEvm(chain);
      const account = getAccountForWallet(wallet);
      if (!account) {
        throw new Error("EvmWalletKit: unable to reconstruct signer");
      }
      const wc = getWalletClient(account, chain.chain);
      // Monad bills on gas_limit, not gas_used — pin the limit for the
      // AUSD call shape instead of estimating (see `monad.ts`). Other
      // pairs get `undefined`, i.e. viem's plain estimate, unchanged.
      const gas = fixedErc20TransferGasLimit({
        chainId: chain.chain.id,
        contractAddress,
      });
      return wc.writeContract({
        abi: erc20Abi,
        address: contractAddress as `0x${string}`,
        functionName: "transfer",
        args: [to as `0x${string}`, amount],
        account: wc.account!,
        chain: wc.chain,
        ...(gas !== undefined ? { gas } : {}),
      });
    },

    // ── Gasless USDC signer (spec §5.5, milestone M2) ──────────────
    //
    // Routes through the shared viem `signTypedData` primitive — zero
    // new keystore access patterns, zero new biometric plumbing. The
    // EIP-712 domain / type shape is pinned in
    // `signTransferWithAuthorization.ts` so Circle's Gateway struct
    // lives in exactly one place.
    async signTransferWithAuthorization(
      args: SignTransferWithAuthorizationArgs,
    ): Promise<`0x${string}`> {
      assertEvm(args.chain);
      const account = getAccountForWallet(args.wallet);
      if (!account) {
        throw new Error(
          "EvmWalletKit.signTransferWithAuthorization: unable to reconstruct signer",
        );
      }
      return signTransferWithAuthorizationPure(account, args);
    },

    // ── Circle Paymaster ERC-4337 UserOp (spec §5.4 / §12 Q6, M4) ──
    //
    // Routes through the pure `sendUserOpWithUsdcPaymaster` module so
    // the viem `toSimple7702SmartAccount` + `sendUserOperation`
    // wiring lives in exactly one place. The kit's job is to resolve
    // the wallet's signer and narrow the chain — everything else
    // (approve-preamble, EIP-7702 authorization, bundler submit) is
    // pure-function and Node-testable.
    async sendUserOpWithUsdcPaymaster(
      args: SendUserOpWithUsdcPaymasterArgs,
    ): Promise<SendUserOpResult> {
      assertEvm(args.chain);
      const account = getAccountForWallet(args.wallet);
      if (!account) {
        throw new Error(
          "EvmWalletKit.sendUserOpWithUsdcPaymaster: unable to reconstruct signer",
        );
      }
      return sendUserOpWithUsdcPaymasterPure(account, args);
    },

    // ── Onchain settlement contract call (spec §5.7, M6) ─────────────
    //
    // Sends a raw contract transaction with pre-encoded calldata.
    // Used by the onchain settlement path to call
    // `processMerchantPayment` on the TakumiPay contract.
    async sendContractTransaction({
      wallet,
      chain,
      to,
      data,
      value,
    }: SendContractTransactionArgs): Promise<string> {
      assertEvm(chain);
      const account = getAccountForWallet(wallet);
      if (!account) {
        throw new Error(
          "EvmWalletKit.sendContractTransaction: unable to reconstruct signer",
        );
      }
      const wc = getWalletClient(account, chain.chain);
      return wc.sendTransaction({ to, data, value: value ?? 0n });
    },

    async estimateContractCallFee({
      from,
      chain,
      to,
      data,
      value,
      fallbackGas,
    }: EstimateContractCallFeeArgs): Promise<ContractCallFeeEstimate> {
      assertEvm(chain);
      const pc = getPublicClient(chain.chain);
      // Gas WITHOUT fee fields: with them attached, a node folds the
      // "can this account pay the fee" check into the estimate and the
      // shortfall comes back as a bare revert — the very thing we are
      // trying to detect and name.
      const [gas, fees] = await Promise.all([
        pc
          .estimateGas({
            account: from as `0x${string}`,
            to,
            data,
            value: value ?? 0n,
          })
          .catch((err) => {
            if (fallbackGas === undefined) throw err;
            return fallbackGas;
          }),
        pc.estimateFeesPerGas(),
      ]);
      const maxFeePerGas = fees.maxFeePerGas ?? (await pc.getGasPrice());
      return { gas, maxFeePerGas, feeWei: gas * maxFeePerGas };
    },

    async getTokenAllowance({
      owner,
      spender,
      tokenAddress,
      chain,
    }: GetTokenAllowanceArgs): Promise<bigint> {
      assertEvm(chain);
      const pc = getPublicClient(chain.chain);
      return (await pc.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner as `0x${string}`, spender],
      })) as bigint;
    },

    async waitForTransaction({
      hash,
      chain,
    }: WaitForTransactionArgs): Promise<void> {
      assertEvm(chain);
      const pc = getPublicClient(chain.chain);
      await pc.waitForTransactionReceipt({ hash });
    },

    async estimateMaxTransferable({
      balance,
      chain,
      from,
      to,
    }: EstimateMaxTransferableArgs): Promise<bigint> {
      assertEvm(chain);
      const pc = getPublicClient(chain.chain);
      const gas =
        ((await pc.estimateGas({
          account: from as `0x${string}`,
          to: (to ?? from) as `0x${string}`,
          value: balance,
        })) *
          11n) /
        10n;
      const gasPrice = await pc.getGasPrice();
      const max = balance - gas * gasPrice;
      return max > 0n ? max : 0n;
    },

    // ── Display ─────────────────────────────────────────────────────
    // Shape is `"<amount> <symbol>"` — mirrors the Solana kit
    // (`"0.0123 SOL"`) so `app/send.tsx` and `app/wallet.tsx` can
    // display the kit output directly without re-reading
    // `chain.nativeCurrency.symbol`. Callers that need just the number
    // (e.g. the amount input field) strip the symbol via
    // `.split(" ")[0]` — see §7.6 / §7.7.
    formatNativeAmount(raw: bigint, chain: ChainConfig): string {
      assertEvm(chain);
      const human = parseFloat(
        formatUnits(raw, chain.chain.nativeCurrency.decimals),
      ).toFixed(4);
      return `${human} ${chain.chain.nativeCurrency.symbol}`;
    },
    parseNativeAmount(human: string, chain: ChainConfig): bigint {
      assertEvm(chain);
      return parseUnits(human, chain.chain.nativeCurrency.decimals);
    },
    truncateAddress(address: string, opts?: TruncateAddressOptions): string {
      return truncateAddressUtil({
        address,
        startLength: opts?.start,
        endLength: opts?.end,
      });
    },

    async upgradeToSmartAccount({
      wallet,
      chain,
    }: UpgradeToSmartAccountArgs): Promise<UpgradeToSmartAccountResult> {
      assertEvm(chain);
      const account = getAccountForWallet(wallet);
      if (!account) {
        throw new Error("EvmWalletKit: unable to reconstruct signer");
      }

      const publicClient = getPublicClient(chain.chain);
      const walletClient = getWalletClient(account, chain.chain);

      // 1. Resolve MetaMask delegator contract address
      let delegatorAddress =
        "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B" as `0x${string}`;
      try {
        const environment = getSmartAccountsEnvironment(chain.chain.id);
        if (environment?.implementations?.EIP7702StatelessDeleGatorImpl) {
          delegatorAddress = environment.implementations
            .EIP7702StatelessDeleGatorImpl as `0x${string}`;
        }
      } catch {
        // Fallback to the canonical address if environment is not found or throws
      }
      // 2. Security Invariants checks (SI-1 & SI-2)
      const addressDecision = decideAuthorizationByAddress(delegatorAddress);
      if (!addressDecision.ok) {
        throw new Error(addressDecision.message);
      }

      const bytecode = await publicClient.getCode({
        address: delegatorAddress,
      });
      const bytecodeDecision = decideAuthorizationByBytecode(bytecode);
      if (!bytecodeDecision.ok) {
        throw new Error(bytecodeDecision.message);
      }

      // 3. Sign Authorization tuple for self-execution (nonce automatically resolved by viem with executor: 'self')
      const authorization = await walletClient.signAuthorization({
        account,
        contractAddress: delegatorAddress,
        executor: "self",
      });

      // 4. Submit EIP-7702 Transaction targeting the EOA itself to activate delegation
      const hash = await walletClient.sendTransaction({
        authorizationList: [authorization],
        data: "0x",
        to: account.address,
      });

      return {
        transactionHash: hash,
        smartAccountAddress: wallet.address,
      };
    },

    async isSmartAccountActive(
      wallet: TWallet,
      chain: ChainConfig,
    ): Promise<boolean> {
      assertEvm(chain);
      const pc = getPublicClient(chain.chain);
      const code = await pc.getCode({
        address: wallet.address as `0x${string}`,
      });
      if (!code || code === "0x") return false;

      // EIP-7702 upgraded code starts with 0xef0100 (delegation designator prefix)
      return code.startsWith("0xef0100");
    },

    // ── ERC-7710 onchain delegation (spec Phase 2 §5.3) ──────────────
    //
    // Translation + SDK wiring lives in the pure `./delegations.ts`
    // module so the scope/caveat mapping is Node-testable. The kit's
    // job is to narrow the chain and resolve clients/signers.
    async createDelegation({
      wallet,
      chain,
      delegate,
      scope,
      caveats = [],
      salt = DELEGATION_ZERO_SALT,
    }: CreateDelegationArgs): Promise<Omit<DelegationStruct, "signature">> {
      assertEvm(chain);
      return buildUnsignedDelegation({
        chainId: chain.chain.id,
        delegator: wallet.address as `0x${string}`,
        delegate: delegate as `0x${string}`,
        scope,
        caveats,
        salt: salt as `0x${string}`,
      });
    },

    async signDelegation({
      wallet,
      chain,
      delegation,
    }: SignDelegationArgs): Promise<`0x${string}`> {
      assertEvm(chain);
      const account = getAccountForWallet(wallet);
      if (!account) {
        throw new Error(
          "EvmWalletKit.signDelegation: unable to reconstruct signer",
        );
      }
      const publicClient = getPublicClient(chain.chain);
      return signUnsignedDelegation(account, publicClient, delegation);
    },

    async encodeDelegations({
      chain,
      delegations,
    }: EncodeDelegationsArgs): Promise<string> {
      assertEvm(chain);
      return encodeSignedDelegations(delegations);
    },

    // ── 1Shot Relayer gas abstraction (spec Phase 3 §5.3) ────────────
    //
    // All JSON-RPC wiring lives in the pure `./relayer.ts` module so the
    // request builders / decoders are Node-testable with a mocked fetch.
    // The kit's job is to narrow the chain (SI-2: the relayer `chainId`
    // can only ever be the active EVM chain's id) and forward.
    async getRelayerCapabilities({
      chain,
    }: {
      chain: ChainConfig;
    }): Promise<RelayerCapabilities> {
      assertEvm(chain);
      return relayerGetCapabilities({ chainId: chain.chain.id });
    },

    async getRelayerFeeData({
      chain,
      token,
    }: GetRelayerFeeDataArgs): Promise<RelayerFeeData> {
      assertEvm(chain);
      return relayerGetFeeData({ chainId: chain.chain.id, token });
    },

    async estimate7710Transaction({
      chain,
      transactions,
      authorizationList,
      feeSafetyMax,
    }: Estimate7710TransactionArgs): Promise<Estimate7710TransactionResult> {
      assertEvm(chain);
      return relayerEstimate7710Transaction({
        chainId: chain.chain.id,
        transactions,
        authorizationList,
        feeSafetyMax,
      });
    },

    async send7710Transaction({
      chain,
      transactions,
      context,
      authorizationList,
      destinationUrl,
      memo,
    }: Send7710TransactionArgs): Promise<Send7710TransactionResult> {
      assertEvm(chain);
      return relayerSend7710Transaction({
        chainId: chain.chain.id,
        transactions,
        context,
        authorizationList,
        destinationUrl,
        memo,
      });
    },

    async getRelayerTransactionStatus({
      chain,
      taskId,
    }: GetRelayerStatusArgs): Promise<RelayerStatus> {
      assertEvm(chain);
      return relayerGetStatus({ chainId: chain.chain.id, taskId });
    },

    // ── Agent-initiated x402 micropayments (spec Phase 5 §5.3) ───────
    //
    // Rail selection + budget/fee enforcement live in the pure
    // `./x402Settle.ts` module (Node-testable with a mocked relayer).
    // The kit only narrows the chain to EVM and forwards.
    async settleX402Payment(
      args: SettleX402PaymentArgs,
    ): Promise<SettleX402PaymentResult> {
      assertEvm(args.chain);
      return settleX402PaymentEvm(args);
    },

    // ── EIP-7702 authorization for in-flight relayer upgrade ─────────
    //
    // Produces a single `authorizationList` entry so an un-upgraded EOA
    // can be upgraded to the stateless-7702 delegator in the same relayer
    // request as its first sponsored send. Reuses the same allowlist /
    // bytecode guards as `upgradeToSmartAccount` (SI-1 / SI-2). Unlike
    // that path (`executor: "self"`), here the relayer is the executor,
    // so the authorization is signed against the EOA's pending nonce.
    async signEip7702Authorization({
      wallet,
      chain,
    }: SignEip7702AuthorizationArgs): Promise<RelayerAuthorizationEntry> {
      assertEvm(chain);
      const account = getAccountForWallet(wallet);
      if (!account) {
        throw new Error(
          "EvmWalletKit.signEip7702Authorization: unable to reconstruct signer",
        );
      }

      const delegatorAddress = resolveStatelessDelegatorAddress(chain.chain.id);

      const addressDecision = decideAuthorizationByAddress(delegatorAddress);
      if (!addressDecision.ok) {
        throw new Error(addressDecision.message);
      }

      const publicClient = getPublicClient(chain.chain);
      const bytecode = await publicClient.getCode({
        address: delegatorAddress,
      });
      const bytecodeDecision = decideAuthorizationByBytecode(bytecode);
      if (!bytecodeDecision.ok) {
        throw new Error(bytecodeDecision.message);
      }

      const nonce = await publicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      });

      if (!account.signAuthorization) {
        throw new Error(
          "EvmWalletKit.signEip7702Authorization: signer cannot sign authorizations",
        );
      }
      const auth = await account.signAuthorization({
        chainId: chain.chain.id,
        address: delegatorAddress,
        nonce,
      });

      return {
        address: delegatorAddress,
        chainId: chain.chain.id,
        nonce,
        r: auth.r,
        s: auth.s,
        yParity: auth.yParity ?? 0,
      };
    },

    // ── Clear signing (task 65 / TWV-2026-066) ──────────────────────
    // ERC-7730 resolution against the bundled/pinned snapshot and the
    // ERC-8213 digest pair (Flow A typed data + Flow B calldata). Both
    // are pure/in-process — no network call on the EVM path.
    resolveClearSigningDescriptor: resolveEvmClearSigningDescriptor,
    computeSigningDigest: computeEvmSigningDigest,

    // ── Bridge capability (bridge-capability-spec §5.1, §5.2, §7.5) ──
    // CAIP ids, provider-payload submission (incl. the ERC-20 allowance
    // no other namespace has), and the native-gas strand check.
    caip2For: evmCaip2For,
    toAssetCaip19: evmToAssetCaip19,
    submitBridgeExecution: evmSubmitBridgeExecution,
    checkBridgeDestinationReadiness: evmCheckBridgeDestinationReadiness,
  };
}
