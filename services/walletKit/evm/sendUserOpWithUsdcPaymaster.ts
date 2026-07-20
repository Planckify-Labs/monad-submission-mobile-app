/**
 * `sendUserOpWithUsdcPaymaster` — pure ERC-4337 UserOperation builder +
 * submitter for the Circle Paymaster gasless-deposit path (spec §5.4
 * gasless table, §5.5 adapter surface, §12 Q6 EIP-7702 gating,
 * milestone M4).
 *
 * Why this exists. Onboarding UMKM merchants cannot be assumed to hold
 * ETH on Base / Arbitrum when they make their first Gateway deposit.
 * Circle Paymaster plus EIP-7702 lets the built-in EOA pay gas in USDC
 * without migrating to a smart-account wallet. This module is the
 * crypto primitive the onboarding flow (task 36) calls.
 *
 * Chain-gating is the **caller's** job, not this module's. Circle
 * Paymaster supports Base and Arbitrum at time of writing; the
 * adapter method does NOT validate `chainId` against Circle's
 * allowlist. Passing an unsupported chain results in a bundler 4xx at
 * submit time — which is the correct failure surface so chain-allowlist
 * drift is visible in server logs rather than silently bypassed in
 * client code.
 *
 * Rules (non-negotiable — enforced by spec + review):
 *   - EVM-only. Solana kit leaves the method `undefined`; consumers
 *     presence-check rather than branching on namespace.
 *   - No `react` / `react-native` / `expo` imports. Runs under the
 *     Node `--experimental-strip-types` test harness.
 *   - Approve the paymaster for a bounded USDC amount — never
 *     `type(uint256).max`. The approve lives inside the UserOp so it
 *     atomically reverts with the target call if the op fails.
 *   - Adapter submits via the caller-provided `bundlerUrl`. The mobile
 *     client never holds bundler keys; the URL points at the server
 *     proxy (task 37) which forwards to Pimlico / Alchemy with the
 *     bundler API key server-side.
 *   - EIP-7702 `authorization` is ONLY attached when the wallet is a
 *     plain EOA (no on-chain delegation yet). The viem
 *     `toSimple7702SmartAccount` helper handles this by default —
 *     `prepareUserOperation` auto-sets `authorization` when needed.
 *   - No `type(uint256).max` approvals; bounded via
 *     `paymasterApproveAmount`.
 */

import {
  type Account,
  type Address,
  type Chain,
  createPublicClient,
  encodeFunctionData,
  type Hex,
  http,
  type PublicClient,
  type Transport,
} from "viem";
import {
  type BundlerClient,
  createBundlerClient,
  sendUserOperation,
  toSimple7702SmartAccount,
} from "viem/account-abstraction";
import type {
  SendUserOpResult,
  SendUserOpWithUsdcPaymasterArgs,
} from "../types.ts";
import { calldataDigest } from "./clearSigning.ts";

/**
 * Minimal ERC-20 ABI fragment — only `approve`, which is the one call
 * the paymaster preamble needs. Kept inline so the pure module does
 * not reach into any shared ABI barrel.
 */
const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * UserOp call shape passed into `sendUserOperation`'s `calls` array.
 * Exported for the test so the round-trip can assert the ordered pair
 * (approve, target) without reaching into viem internals.
 */
export interface UserOpCall {
  to: Address;
  value: bigint;
  data: Hex;
}

/**
 * Builds the two-call batch for the Paymaster-sponsored UserOp:
 *
 *   calls[0] = USDC.approve(paymaster, paymasterApproveAmount)
 *   calls[1] = target(callData, value)
 *
 * Pure — no network I/O. Exported so the test can assert the exact
 * order and calldata shape the bundler will receive.
 */
export function buildPaymasterCalls(
  args: Pick<
    SendUserOpWithUsdcPaymasterArgs,
    | "target"
    | "callData"
    | "value"
    | "paymasterAddress"
    | "usdcTokenAddress"
    | "paymasterApproveAmount"
  >,
): readonly [UserOpCall, UserOpCall] {
  const approveData = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [args.paymasterAddress, args.paymasterApproveAmount],
  });
  return [
    {
      to: args.usdcTokenAddress,
      value: 0n,
      data: approveData,
    },
    {
      to: args.target,
      value: args.value,
      data: args.callData,
    },
  ] as const;
}

/** Narrows the EVM chain and returns the viem `Chain` payload. */
function resolveEvmChain(
  chain: SendUserOpWithUsdcPaymasterArgs["chain"],
): Chain {
  if (chain.namespace !== "eip155") {
    throw new Error(
      `sendUserOpWithUsdcPaymaster: expected eip155 chain, got namespace=${chain.namespace}`,
    );
  }
  return chain.chain;
}

/**
 * Seam for tests: callers can inject a prebuilt public + bundler
 * client pair so a `custom({ request })` transport stands in for the
 * real JSON-RPC endpoints. When omitted, the function constructs both
 * clients over `http(...)` — the production path.
 *
 * The seam is additive — passing clients overrides `bundlerUrl` /
 * default chain RPC, but the public adapter surface always supplies
 * the URL, never a client.
 */
export interface SendUserOpWithUsdcPaymasterDeps {
  /** Test hook — replaces the default source-chain public client. */
  publicClient?: PublicClient<Transport, Chain>;
  /** Test hook — replaces the default bundler client. */
  bundlerClient?: BundlerClient<Transport, Chain | undefined>;
}

/**
 * Submits the UserOp to the bundler. `account` is the viem `Account`
 * produced by `walletService.getAccountForWallet(wallet)` — the kit
 * itself does the lookup before delegating here so the private key
 * never leaves `services/walletService.ts`.
 *
 * Flow:
 *   1. Narrow chain → viem `Chain`.
 *   2. Build a `createPublicClient` for the source chain (used by the
 *      Simple7702 smart account to read nonces + resolve delegation).
 *   3. Wrap the EOA as a `Simple7702SmartAccount`. When the EOA is not
 *      yet delegated, viem's `prepareUserOperation` attaches an EIP-7702
 *      `authorization` automatically; when it is delegated, the field
 *      is omitted. This is how the post-Pectra "no smart-account
 *      migration" guarantee is kept.
 *   4. Build the two-call batch (`approve` → `target`).
 *   5. Submit via `sendUserOperation` with `paymaster: paymasterAddress`
 *      so viem's bundler-client wiring sets the UserOp's paymaster
 *      field at prepare time. Returns the bundler's `userOpHash`.
 */
export async function sendUserOpWithUsdcPaymaster(
  account: Account,
  args: SendUserOpWithUsdcPaymasterArgs,
  deps: SendUserOpWithUsdcPaymasterDeps = {},
): Promise<SendUserOpResult> {
  const chain = resolveEvmChain(args.chain);

  const publicClient =
    deps.publicClient ??
    createPublicClient({
      chain,
      transport: http(),
    });

  // Simple7702 owner field expects a `PrivateKeyAccount` shape, but at
  // runtime the implementation only reaches `account.signMessage` /
  // `signTypedData`, both of which every viem `Account` provides. We
  // cast through `unknown` at the boundary (rather than `any`) so the
  // type-level mismatch is a widening convert — not a Biome lint
  // violation. See viem#2985 for the upstream ergonomic gap.
  const smartAccount = await toSimple7702SmartAccount({
    client: publicClient,
    owner: account as unknown as Parameters<
      typeof toSimple7702SmartAccount
    >[0]["owner"],
  });

  const calls = buildPaymasterCalls(args);

  // Task 65 (TWV-2026-066) Phase C — defense-in-depth: log the
  // ERC-8213 calldata digest of the target call even though this
  // first-party flow has no dedicated approval sheet. The payload is
  // app-authored; the digest is a cross-check against a compromised
  // UI layer, not blind-signing prevention.
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.log(
      "[erc8213] paymaster target calldata digest:",
      calldataDigest(args.callData),
    );
  }

  const bundlerClient =
    deps.bundlerClient ??
    createBundlerClient({
      client: publicClient,
      transport: http(args.bundlerUrl),
    });

  const userOpHash = await sendUserOperation(bundlerClient, {
    account: smartAccount,
    calls: calls as unknown as readonly UserOpCall[],
    paymaster: args.paymasterAddress,
  });

  return { userOpHash };
}
