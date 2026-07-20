/**
 * `signTransferWithAuthorization` — pure EIP-3009 typed-data signer for
 * Circle Nanopayments (spec §5.5, milestone M2).
 *
 * This module is the load-bearing crypto primitive for Path B scan-to-
 * pay: it produces a 65-byte `TransferWithAuthorization` signature the
 * mobile `services/nanopay/submitAuthorization.ts` POSTs through the
 * server proxy (task 17). Isolated from `EvmWalletKit.ts` so the pure
 * signing path is Node-testable without pulling the kit's keystore
 * transitive imports into the test harness.
 *
 * Rules (non-negotiable — enforced by spec + review):
 *   - Domain's `verifyingContract` is the Gateway batched-wallet
 *     contract (`args.gatewayWallet`), NOT the USDC contract. USDC
 *     address is an EIP-712 *message* field via the extended
 *     `TransferWithAuthorization` struct. Signing against the USDC
 *     domain passes Circle's verify endpoint but fails settle.
 *   - `validBefore` MUST be `≥ now + 3 days` (259,200 seconds). Guard
 *     runs pre-sign and throws `AuthorizationValidityTooShortError`;
 *     the keystore is not touched on failure.
 *   - No `react` / `react-native` / `expo` imports — this module must
 *     run under the Node `--experimental-strip-types` test harness.
 *   - No broadcast, no network I/O. The adapter signs only; submission
 *     is the caller's job (task 17).
 *
 * The EIP-712 types mirror Circle's Gateway struct: canonical EIP-3009
 * (`from, to, value, validAfter, validBefore, nonce`) plus a `usdc`
 * asset-address field so the authorization is bound to the correct
 * asset. If Circle ever publishes a divergent struct shape, the change
 * lands here — every call site stays identical.
 */

import { type Account, hashTypedData } from "viem";
import {
  AuthorizationValidityTooShortError,
  GATEWAY_VALID_BEFORE_MIN_SECONDS,
  type SignTransferWithAuthorizationArgs,
} from "../types.ts";

/**
 * Primary type used by the EIP-712 typed-data message. Exported so the
 * round-trip test (and future `buildAuthorization.ts` in task 17) can
 * reuse the exact schema the signer emits.
 */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "usdc", type: "address" },
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface BuildTypedDataResult {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: `0x${string}`;
  };
  types: typeof TRANSFER_WITH_AUTHORIZATION_TYPES;
  primaryType: "TransferWithAuthorization";
  message: {
    usdc: `0x${string}`;
    from: `0x${string}`;
    to: `0x${string}`;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: `0x${string}`;
  };
}

/**
 * Narrows `ChainConfig` to its EVM variant and returns the viem
 * `chain.id`. Throws on `namespace !== "eip155"` so Solana callers fail
 * loud rather than signing with `chainId: undefined`. Kept colocated
 * with the signer so the guard is visible at the call site; no shared
 * util to avoid pulling chainConfig helpers into the Node test loader.
 */
function resolveEvmChainId(
  chain: SignTransferWithAuthorizationArgs["chain"],
): number {
  if (chain.namespace !== "eip155") {
    throw new Error(
      `signTransferWithAuthorization: expected eip155 chain, got namespace=${chain.namespace}`,
    );
  }
  return chain.chain.id;
}

/**
 * Builds the EIP-712 typed-data object for the signer. Exported pure
 * so the forthcoming `services/nanopay/buildAuthorization.ts` (task 17)
 * can reuse the exact schema the wallet will sign against.
 */
export function buildTransferWithAuthorizationTypedData(
  args: SignTransferWithAuthorizationArgs,
): BuildTypedDataResult {
  const chainId = resolveEvmChainId(args.chain);
  return {
    domain: {
      name: args.domainName,
      version: args.domainVersion,
      chainId,
      verifyingContract: args.gatewayWallet,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      usdc: args.usdc,
      from: args.from,
      to: args.to,
      value: args.valueMicros,
      validAfter: BigInt(args.validAfter),
      validBefore: BigInt(args.validBefore),
      nonce: args.nonce,
    },
  };
}

/** Enforces Circle Gateway's `validBefore ≥ now + 3 days` rule. */
export function assertValidBeforeWindow(
  validBefore: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): void {
  const minimum = nowSeconds + GATEWAY_VALID_BEFORE_MIN_SECONDS;
  if (validBefore < minimum) {
    throw new AuthorizationValidityTooShortError({
      validBefore,
      minimumValidBefore: minimum,
    });
  }
}

/**
 * Produces the digest the wallet will sign. Wraps `viem.hashTypedData`
 * so offline tooling and tests share one source of truth.
 */
export function hashTransferWithAuthorization(
  args: SignTransferWithAuthorizationArgs,
): `0x${string}` {
  const typed = buildTransferWithAuthorizationTypedData(args);
  return hashTypedData(typed);
}

/**
 * Signs the typed-data message with `account`, returning the raw
 * 65-byte (`0x`-prefixed) signature. Callers hand a viem `Account`
 * produced by `walletService.getAccountForWallet(wallet)` — the kit
 * itself does the lookup before delegating here so the private key
 * never leaves `services/walletService.ts`.
 */
export async function signTransferWithAuthorization(
  account: Account,
  args: SignTransferWithAuthorizationArgs,
): Promise<`0x${string}`> {
  assertValidBeforeWindow(args.validBefore);
  if (!account.signTypedData) {
    throw new Error(
      "signTransferWithAuthorization: account missing signTypedData capability",
    );
  }
  const typed = buildTransferWithAuthorizationTypedData(args);
  // Task 65 (TWV-2026-066) Phase C — defense-in-depth: compute and log
  // the ERC-8213 digest even though this first-party flow has no
  // dedicated approval sheet. The payload is app-authored, so this is
  // a cross-check against a compromised UI layer, not blind-signing
  // prevention.
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.log(
      "[erc8213] TransferWithAuthorization EIP-712 digest:",
      hashTypedData(typed),
    );
  }
  return account.signTypedData(typed);
}
