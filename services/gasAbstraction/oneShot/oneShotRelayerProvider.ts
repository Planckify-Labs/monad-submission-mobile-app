/**
 * `oneShotRelayerProvider` — gas abstraction via the 1Shot ERC-7710
 * public relayer. Pays transaction gas in a stablecoin — the gas-settings
 * preference (`feeTokenSymbol`) is the source of truth for the FEE token,
 * independent of the token actually being sent. Which stablecoins are
 * offerable on a chain is whatever the live `relayer_getCapabilities`
 * lists for it (USDC everywhere, USDT / USDT0 / mUSD / USDG on some
 * chains, USDC only on the two testnets as of 2026-09) — nothing is
 * hardcoded here, so the provider is the same on mainnets and testnets.
 *
 * Two shapes, picked automatically:
 *   - Sending the fee token itself (work token == fee token): one
 *     `Erc20TransferAmount` delegation scoped to `fee + work` covers both
 *     legs in a single bundle entry (skill Example 1b).
 *   - Sending any other token, e.g. IDRX (work token != fee token): two
 *     delegations — a fee-token delegation (→ `feeCollector`) and a
 *     work-token delegation (→ recipient) — batched as two bundle entries
 *     that the relayer merges into one on-chain `redeemDelegations`
 *     (skill Example 2).
 *
 * The feature still declines (→ native fallback via `resolveGasPayment`)
 * when the chain isn't supported or the preferred symbol isn't an
 * accepted relayer fee token on that chain.
 *
 * The orchestration core (`runRelayerTransfer`, `quoteRelayerTransfer`,
 * `resolveRelayerContext`) is exported and takes a `RelayerKit` so it can
 * be unit-tested with a fake kit (no network, no keystore). The provider
 * object just resolves the real EVM kit from `walletKitRegistry`.
 */

import { encodeFunctionData, erc20Abi } from "viem";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import {
  getRelayerErrorCode,
  RELAYER_ERROR,
  relayerFeeSafetyMaxAtoms,
} from "@/services/walletKit/evm/relayer";
import { walletKitRegistry } from "@/services/walletKit/registry";
import type {
  DelegationStruct,
  RelayerBundleEntry,
  RelayerChainCapabilities,
  RelayerExecution,
  RelayerFeeData,
  WalletKitAdapter,
} from "@/services/walletKit/types";
import { isGasAbstractionSupported } from "../supportedChains";
import {
  type FeeToken,
  feeTokenSymbolMatches,
  type GasAbstractionArgs,
  type GasAbstractionExecuteResult,
  type GasAbstractionProvider,
  type GasAbstractionQuote,
  GasAbstractionUnavailableError,
} from "../types";

export const ONE_SHOT_PROVIDER_ID = "1shot";

/** Upper-bound gas units for a fee transfer + a work transfer (rough quote). */
const FEE_GAS_UPPER_BOUND = 250_000n;

/**
 * Subset of `WalletKitAdapter` the relayer flow drives. All members are
 * optional on the adapter; the helpers presence-check before use so a
 * misconfigured kit fails with a typed `GasAbstractionUnavailableError`
 * instead of a `TypeError`.
 */
export type RelayerKit = Pick<
  WalletKitAdapter,
  | "getRelayerCapabilities"
  | "getRelayerFeeData"
  | "isSmartAccountActive"
  | "signEip7702Authorization"
  | "createDelegation"
  | "signDelegation"
  | "estimate7710Transaction"
  | "send7710Transaction"
  | "getRelayerTransactionStatus"
>;

function eqAddr(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Fresh 32-byte replay-protection salt (CSPRNG when available). */
function randomSaltHex(): `0x${string}` {
  const bytes = new Uint8Array(32);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    // Last-resort fallback for environments without WebCrypto. The app
    // polyfills `crypto.getRandomValues` for viem, so this is effectively
    // test-only; a salt is replay protection, not key material.
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex as `0x${string}`;
}

function buildErc20TransferExecution(
  token: string,
  to: string,
  amount: bigint,
): RelayerExecution {
  return {
    target: token,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [to as `0x${string}`, amount],
    }),
  };
}

/**
 * Rough fee estimate for UI + the balance gate, floored at `minFee`.
 *
 * The relayer's `rate` is the **native-token price in whole payment-token
 * units** (e.g. `2000` USDC per 1 ETH), NOT a direct wei→atoms multiplier.
 * So the fee in payment-token atoms is:
 *
 *   nativeFeeWei / 1e18  (wei → whole native)
 *     × rate             (whole native → whole payment token)
 *     × 10**decimals     (whole payment token → atoms)
 *
 * Float math is fine here — this is only a pre-send estimate for the
 * balance gate; the authoritative fee is locked in `execute` via
 * `relayer_estimate7710Transaction`.
 */
export function computeRoughFee(
  feeData: RelayerFeeData,
  gasUpperBound: bigint = FEE_GAS_UPPER_BOUND,
): bigint {
  const nativeFeeWei = feeData.gasPrice * gasUpperBound;
  const tokenWhole = (Number(nativeFeeWei) / 1e18) * feeData.rate;
  const atomsFloat = tokenWhole * 10 ** feeData.tokenDecimals;
  const tokenAtoms = Number.isFinite(atomsFloat)
    ? BigInt(Math.ceil(atomsFloat))
    : 0n;
  return tokenAtoms > feeData.minFee ? tokenAtoms : feeData.minFee;
}

interface ResolvedRelayerContext {
  chainCaps: RelayerChainCapabilities;
  /**
   * The token gas is charged in — the gas-settings preference. Resolved
   * by symbol against the relayer's accepted fee tokens for this chain,
   * NOT from the token being sent.
   */
  feeToken: FeeToken;
  /** The token actually being transferred to the recipient. */
  workTokenAddress: string;
  /**
   * True when the work transfer and the fee draw on the same token (the
   * user is sending USDC itself). Lets the bundle collapse to a single
   * delegation in that case.
   */
  sameToken: boolean;
}

/**
 * Live relayer capabilities for `chain`, or `null` when the relayer does
 * not serve it. Routed to the right relayer host (mainnet / testnet) by
 * the kit; this helper is host-agnostic.
 */
export async function fetchRelayerChainCapabilities(
  kit: RelayerKit,
  chain: ChainConfig,
): Promise<RelayerChainCapabilities | null> {
  if (!kit.getRelayerCapabilities) {
    throw new GasAbstractionUnavailableError(
      "relayer capabilities unsupported",
    );
  }
  const chainId = chain.namespace === "eip155" ? chain.chain.id : -1;
  const caps = await kit.getRelayerCapabilities({ chain });
  return caps[chainId] ?? null;
}

/**
 * Resolves the relayer capabilities for the chain and the fee token the
 * user asked for (`feeTokenSymbol`, the gas-settings preference). The
 * token being SENT is independent — it may be the fee token itself, IDRX,
 * or anything else. Declines (typed unavailable error) only when the
 * chain isn't covered or the symbol isn't an accepted fee token there, so
 * `resolveGasPayment` can fall back to native gas.
 */
export async function resolveRelayerContext(
  kit: RelayerKit,
  { chain, intent, feeTokenSymbol }: GasAbstractionArgs,
): Promise<ResolvedRelayerContext> {
  const chainCaps = await fetchRelayerChainCapabilities(kit, chain);
  if (!chainCaps) {
    throw new GasAbstractionUnavailableError(
      "chain not in relayer capabilities",
    );
  }
  // Gas is paid in the preferred stablecoin regardless of what's being
  // sent — gas settings is the source of truth for the fee token. Match by
  // symbol (the relayer keys accepted tokens by address but tags each with
  // its symbol); the accepted set is per chain and comes from the live
  // capabilities, so the same code serves every chain the relayer does.
  const feeToken = chainCaps.tokens.find((t) =>
    feeTokenSymbolMatches(t.symbol, feeTokenSymbol),
  );
  if (!feeToken) {
    throw new GasAbstractionUnavailableError(
      "preferred token not accepted as relayer fee token",
    );
  }
  return {
    chainCaps,
    feeToken,
    workTokenAddress: intent.tokenAddress,
    sameToken: eqAddr(feeToken.address, intent.tokenAddress),
  };
}

export async function quoteRelayerTransfer(
  kit: RelayerKit,
  args: GasAbstractionArgs,
): Promise<GasAbstractionQuote> {
  const { feeToken, sameToken } = await resolveRelayerContext(kit, args);
  if (!kit.getRelayerFeeData) {
    throw new GasAbstractionUnavailableError("relayer fee data unsupported");
  }
  const feeData = await kit.getRelayerFeeData({
    chain: args.chain,
    token: feeToken.address,
  });
  const feeAmount = computeRoughFee(feeData);
  // The fee-token balance gate must cover the fee. When the work transfer
  // also draws on the fee token (sending the fee token itself), it must
  // additionally cover the send amount. For a different work token (e.g.
  // IDRX) the work balance is on its own token and validated by the send
  // flow / relayer simulation — the fee-token gate only needs the fee.
  const totalRequired = sameToken ? feeAmount + args.intent.amount : feeAmount;
  return {
    providerId: ONE_SHOT_PROVIDER_ID,
    feeToken,
    feeAmount,
    totalRequired,
  };
}

/**
 * Full price-lock loop: optional in-flight EIP-7702 upgrade, build + sign
 * the delegation, estimate, re-sign if the required fee changed, submit.
 */
export async function runRelayerTransfer(
  kit: RelayerKit,
  args: GasAbstractionArgs,
): Promise<GasAbstractionExecuteResult> {
  const { wallet, chain, intent } = args;
  const { chainCaps, feeToken, sameToken } = await resolveRelayerContext(
    kit,
    args,
  );

  if (
    !kit.createDelegation ||
    !kit.signDelegation ||
    !kit.estimate7710Transaction ||
    !kit.send7710Transaction ||
    !kit.getRelayerFeeData
  ) {
    throw new GasAbstractionUnavailableError("relayer methods unsupported");
  }

  // First abstracted send of an un-upgraded EOA carries the EIP-7702
  // authorization so the relayer upgrades + redeems in one request.
  let authorizationList: Awaited<
    ReturnType<NonNullable<RelayerKit["signEip7702Authorization"]>>
  >[] = [];
  if (kit.isSmartAccountActive && kit.signEip7702Authorization) {
    const active = await kit.isSmartAccountActive(wallet, chain);
    if (!active) {
      authorizationList = [
        await kit.signEip7702Authorization({ wallet, chain }),
      ];
    }
  }
  const authList = authorizationList.length ? authorizationList : undefined;

  // SI-1 overcharge ceiling expressed in THIS fee token's atoms. The
  // relayer tags the same stablecoin with different decimals per chain
  // (USDC is 6dp on Base, 18dp on BSC), so a fixed 6dp bound would reject
  // every honest 18dp quote.
  const feeSafetyMax = relayerFeeSafetyMaxAtoms(feeToken.decimals);

  // Signs one `Erc20TransferAmount` delegation to the relayer's target.
  const signScopedDelegation = async (
    tokenAddress: string,
    maxAmount: bigint,
  ): Promise<DelegationStruct> => {
    const unsigned = await kit.createDelegation!({
      wallet,
      chain,
      delegate: chainCaps.targetAddress,
      scope: {
        type: "erc20TransferAmount",
        tokenAddress,
        maxAmount,
      },
      salt: randomSaltHex(),
    });
    // SI-4: the delegate (redeemer) must be the relayer's target address.
    if (!eqAddr(unsigned.delegate, chainCaps.targetAddress)) {
      throw new GasAbstractionUnavailableError("redeemer address mismatch");
    }
    const signature = await kit.signDelegation!({
      wallet,
      chain,
      delegation: unsigned,
    });
    return { ...unsigned, signature };
  };

  const buildSignedBundle = async (
    feeAmount: bigint,
  ): Promise<RelayerBundleEntry[]> => {
    if (sameToken) {
      // Sending the fee token itself: one delegation scoped to fee + work
      // covers both legs in a single bundle entry (skill Example 1b).
      const signed = await signScopedDelegation(
        feeToken.address,
        feeAmount + intent.amount,
      );
      return [
        {
          permissionContext: [signed],
          executions: [
            buildErc20TransferExecution(
              feeToken.address,
              chainCaps.feeCollector,
              feeAmount,
            ),
            buildErc20TransferExecution(
              feeToken.address,
              intent.to,
              intent.amount,
            ),
          ],
        },
      ];
    }
    // Sending a different token (e.g. IDRX): a fee-token delegation and a
    // work-token delegation, batched as two bundle entries the relayer
    // merges into one on-chain redeemDelegations (skill Example 2). One
    // authorizationList entry still covers both — same delegator EOA.
    const feeDelegation = await signScopedDelegation(
      feeToken.address,
      feeAmount,
    );
    const workDelegation = await signScopedDelegation(
      intent.tokenAddress,
      intent.amount,
    );
    return [
      {
        permissionContext: [feeDelegation],
        executions: [
          buildErc20TransferExecution(
            feeToken.address,
            chainCaps.feeCollector,
            feeAmount,
          ),
        ],
      },
      {
        permissionContext: [workDelegation],
        executions: [
          buildErc20TransferExecution(
            intent.tokenAddress,
            intent.to,
            intent.amount,
          ),
        ],
      },
    ];
  };

  // Mock fee starts at the relayer's floor; the estimate returns the real
  // required amount, which we honor with one re-sign if it changed.
  const feeData = await kit.getRelayerFeeData({
    chain,
    token: feeToken.address,
  });
  let feeAmount = feeData.minFee > 0n ? feeData.minFee : 1n;

  let bundle = await buildSignedBundle(feeAmount);
  let estimate = await kit.estimate7710Transaction({
    chain,
    transactions: bundle,
    authorizationList: authList,
    feeSafetyMax,
  });
  if (!estimate.success) {
    throw new GasAbstractionUnavailableError(
      estimate.error ?? "estimate failed",
    );
  }

  if (
    estimate.requiredPaymentAmount !== undefined &&
    estimate.requiredPaymentAmount !== feeAmount
  ) {
    feeAmount = estimate.requiredPaymentAmount;
    bundle = await buildSignedBundle(feeAmount);
    estimate = await kit.estimate7710Transaction({
      chain,
      transactions: bundle,
      authorizationList: authList,
      feeSafetyMax,
    });
    if (!estimate.success) {
      throw new GasAbstractionUnavailableError(
        estimate.error ?? "re-estimate failed",
      );
    }
  }

  if (!estimate.context) {
    throw new GasAbstractionUnavailableError("missing price-lock context");
  }

  // Submit, retrying ONCE on an expired price-lock (4204). The price-lock
  // ages out (~45s); the signed delegation does NOT, so a refresh only
  // needs a fresh `context` from a re-estimate — no re-sign (1Shot error-
  // handling guide: "refresh and resubmit with fresh context").
  let context = estimate.context;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { taskId } = await kit.send7710Transaction({
        chain,
        transactions: bundle,
        context,
        authorizationList: authList,
        memo: intent.memo,
      });
      // Surface the final price-locked fee + token so callers (the send
      // success screen) can show what gas was paid in.
      return {
        providerId: ONE_SHOT_PROVIDER_ID,
        taskId,
        feeAmount,
        feeToken,
      };
    } catch (err) {
      lastError = err;
      const expired = getRelayerErrorCode(err) === RELAYER_ERROR.QUOTE_EXPIRED;
      if (attempt === 0 && expired) {
        const refreshed = await kit.estimate7710Transaction({
          chain,
          transactions: bundle,
          authorizationList: authList,
          feeSafetyMax,
        });
        if (refreshed.success && refreshed.context) {
          context = refreshed.context;
          continue;
        }
      }
      break;
    }
  }
  throw lastError ?? new GasAbstractionUnavailableError("relayer send failed");
}

function resolveEvmKit(): RelayerKit {
  return walletKitRegistry.get("eip155");
}

export function createOneShotRelayerProvider(): GasAbstractionProvider {
  return {
    id: ONE_SHOT_PROVIDER_ID,

    supportsChain(chain: ChainConfig): boolean {
      return isGasAbstractionSupported(chain);
    },

    async listFeeTokens(chain: ChainConfig): Promise<FeeToken[]> {
      if (!this.supportsChain(chain)) return [];
      const caps = await fetchRelayerChainCapabilities(resolveEvmKit(), chain);
      return caps ? caps.tokens.map((t) => ({ ...t })) : [];
    },

    async supportsIntent(args: GasAbstractionArgs): Promise<boolean> {
      if (!this.supportsChain(args.chain)) return false;
      try {
        await resolveRelayerContext(resolveEvmKit(), args);
        return true;
      } catch {
        return false;
      }
    },

    getQuote(args: GasAbstractionArgs): Promise<GasAbstractionQuote> {
      return quoteRelayerTransfer(resolveEvmKit(), args);
    },

    execute(args: GasAbstractionArgs): Promise<GasAbstractionExecuteResult> {
      return runRelayerTransfer(resolveEvmKit(), args);
    },

    async getStatus({ chain, taskId }) {
      const kit = resolveEvmKit();
      if (!kit.getRelayerTransactionStatus) {
        throw new GasAbstractionUnavailableError("relayer status unsupported");
      }
      const s = await kit.getRelayerTransactionStatus({ chain, taskId });
      return {
        status: s.status,
        statusCode: s.statusCode,
        transactionHash: s.transactionHash,
      };
    },
  };
}
