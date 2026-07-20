import { decodeFunctionData, encodeFunctionData, parseAbiItem } from "viem";

/**
 * Review gate — TWV-2026-053 (Uniswap v4 hook address + allowlist display).
 *
 * When v4 calldata support lands here, the signer UI MUST surface the hook
 * identity the same way it surfaces `to` and `value`. Do not merge a v4
 * decoder that hides the hook behind "Uniswap v4 PoolManager" trust.
 *
 * Pre-implementation checklist for v4 decoding (blocks merge):
 *   1. Extract `PoolKey` (currency0, currency1, fee, tickSpacing, hooks)
 *      from calldata to `PoolManager.swap` / `modifyLiquidity` / `unlock`
 *      paths. The `hooks` address field is the value that must be routed
 *      to the signer UI.
 *   2. Resolve the hook via `constants/uniswap-v4-hooks.ts` (to be created).
 *      Shape: `{ address: `0x${string}`; chainId: number; name: string;
 *      audited: boolean; source: string; addedAt: string; }[]`. Ship
 *      in-bundle with a dated source comment; no runtime fetches.
 *      Unknown hooks render as "Custom hook — pool logic provided by a
 *      third party" with the address shown in full (never abbreviated
 *      away). Known-Uniswap-Labs hooks render with the audit status.
 *   3. Signer copy distinguishes "Uniswap v4 pool with a hook" from
 *      "Uniswap v4 pool without a hook" (hook address == zero address).
 *   4. Simulation (TWV-2026-011, task 17) is required for v4 signs; the
 *      simulator must cover `beforeSwap` / `afterSwap` hook effects and
 *      display the full asset delta. Unexpected transfers to addresses
 *      not in the pool route trigger the label-vs-delta mismatch warning
 *      (TWV-2026-038, task 27). If the simulator is unavailable for the
 *      target chain, the UI warns "cannot simulate — proceed only if you
 *      trust this pool."
 *   5. Hook address is always displayed — it is never elided, shortened
 *      away, or replaced by "Uniswap v4" branding in any signer-UI
 *      copy path.
 *
 * Reviewers: block PRs that add `PoolManager` selectors to `SELECTOR_DB`
 * without a companion hook-display path in the signer UI. Cross-link the
 * PR to this review gate and task 27.
 */

/**
 * Minimal local selector → signature map for the most common ERC-20 / NFT
 * / router functions. Intentionally small — ~20 entries covers the long tail
 * of volume. The asset can grow via a build step later.
 */
const SELECTOR_DB: Record<string, string[]> = {
  "0xa9059cbb": ["function transfer(address to, uint256 amount)"],
  "0x23b872dd": [
    "function transferFrom(address from, address to, uint256 amount)",
  ],
  "0x095ea7b3": ["function approve(address spender, uint256 amount)"],
  "0x42842e0e": [
    "function safeTransferFrom(address from, address to, uint256 tokenId)",
  ],
  "0xb88d4fde": [
    "function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)",
  ],
  "0xf242432a": [
    "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
  ],
  "0x2eb2c2d6": [
    "function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)",
  ],
  "0xa22cb465": ["function setApprovalForAll(address operator, bool approved)"],
  "0xac9650d8": ["function multicall(bytes[] data)"],
  "0x5ae401dc": ["function multicall(uint256 deadline, bytes[] data)"],
  "0x38ed1739": [
    "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  ],
  "0x18cbafe5": [
    "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  ],
  "0x7ff36ab5": [
    "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  ],
  "0x3593564c": [
    "function execute(bytes commands, bytes[] inputs, uint256 deadline)",
  ],
  "0xd0e30db0": ["function deposit()"],
  "0x2e1a7d4d": ["function withdraw(uint256 amount)"],
  "0x3a871cdd": [
    "function handleOps(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, uint256 callGasLimit, uint256 verificationGasLimit, uint256 preVerificationGas, uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)",
  ],
};

export interface DecodedArg {
  name: string;
  type: string;
  value: unknown;
}

export interface DecodedCalldata {
  selector: `0x${string}`;
  signature: string | null;
  functionName?: string;
  args?: DecodedArg[];
  ambiguous?: boolean;
  raw: `0x${string}`;
  /**
   * Task 65 (TWV-2026-066) Phase A — decode-fidelity roundtrip gate.
   * `true` iff `encode(decode(bytes)) === bytes` held for the returned
   * candidate. A 4-byte selector collision can decode without throwing
   * against the wrong signature; only a roundtrip-verified decode may be
   * shown as trusted or fed into Stage-2 descriptors / the AI summary.
   */
  roundtripVerified?: boolean;
  /**
   * TWV-2026-009 — high-risk variants the signer UI MUST branch on, not
   * render as generic "Contract Interaction". Kept as a discriminated
   * tag so the decoder output remains a single value rather than a
   * parallel predicate query.
   */
  risk?:
    | {
        kind: "setApprovalForAll";
        operator: `0x${string}`;
        approved: boolean;
      }
    | {
        kind: "approve";
        spender: `0x${string}`;
        amount: bigint;
        isUnlimited: boolean;
      };
}

// TWV-2026-009 — "unlimited" threshold for ERC-20 `approve`. Any value
// at or above `type(uint256).max / 2` is treated as unbounded because
// no legitimate workflow needs to grant more than half of supply — the
// pattern appears only in "max approve" templates that ice-phish drainers
// exploit.
const UINT256_MAX = (1n << 256n) - 1n;
const UNLIMITED_APPROVE_THRESHOLD = UINT256_MAX / 2n;

function classifyRisk(decoded: DecodedCalldata): DecodedCalldata["risk"] {
  if (decoded.functionName === "setApprovalForAll" && decoded.args) {
    const operator = decoded.args[0]?.value;
    const approved = decoded.args[1]?.value;
    if (typeof operator === "string" && typeof approved === "boolean") {
      return {
        kind: "setApprovalForAll",
        operator: operator as `0x${string}`,
        approved,
      };
    }
  }
  if (decoded.functionName === "approve" && decoded.args) {
    const spender = decoded.args[0]?.value;
    const amount = decoded.args[1]?.value;
    if (typeof spender === "string" && typeof amount === "bigint") {
      return {
        kind: "approve",
        spender: spender as `0x${string}`,
        amount,
        isUnlimited: amount >= UNLIMITED_APPROVE_THRESHOLD,
      };
    }
  }
  return undefined;
}

/**
 * Decode `data` against `candidates`, trusting only a candidate whose
 * re-encoding reproduces the original calldata byte-for-byte (Phase A
 * roundtrip gate). "Didn't throw" is NOT "decoded the intended
 * function": two differently-typed signatures behind one 4-byte
 * selector can both decode without error while only one is correct.
 *
 * Exported for the synthetic-collision unit tests; product code goes
 * through `decodeCalldata`, which supplies `SELECTOR_DB` candidates.
 */
export function decodeCalldataAgainst(
  data: `0x${string}`,
  candidates: readonly string[],
): DecodedCalldata | null {
  // Normalize hex case exactly once, at the boundary. viem's decoder
  // matches selectors case-sensitively, and the roundtrip comparison
  // below must be byte equality, not "looks about right" — so every
  // step downstream operates on the lowercased form.
  const normalized = data.toLowerCase() as `0x${string}`;
  const selector = normalized.slice(0, 10) as `0x${string}`;
  let sawDecodableCandidate = false;
  for (const sig of candidates) {
    try {
      const abi = [parseAbiItem(sig)] as any[];
      const decoded = decodeFunctionData({ abi, data: normalized });
      sawDecodableCandidate = true;
      // Roundtrip fidelity: re-encode with the same candidate and
      // compare byte-for-byte.
      const reencoded = encodeFunctionData({
        abi,
        functionName: decoded.functionName,
        args: decoded.args as unknown[],
      });
      if (reencoded.toLowerCase() !== normalized) {
        continue; // decoded, but not the true function — try next
      }
      const abiFn = abi[0];
      const inputs = abiFn.inputs ?? [];
      // `decoded.args` is undefined for zero-arg functions (deposit()).
      const args: DecodedArg[] = ((decoded.args ?? []) as unknown[]).map(
        (value, i) => ({
          name: inputs[i]?.name ?? `arg${i}`,
          type: inputs[i]?.type ?? "unknown",
          value,
        }),
      );
      const out: DecodedCalldata = {
        selector,
        signature: sig,
        functionName: decoded.functionName,
        args,
        // The roundtrip resolved which candidate is real — a verified
        // decode is not ambiguous even when the selector had several.
        ambiguous: false,
        roundtripVerified: true,
        raw: data,
      };
      out.risk = classifyRisk(out);
      return out;
    } catch {
      // try next candidate
    }
  }
  // No candidate round-tripped. If one decoded anyway, surface it as
  // ambiguous/unresolved rather than silently keeping the first guess.
  return {
    selector,
    signature: null,
    ambiguous: sawDecodableCandidate ? true : undefined,
    raw: data,
  };
}

export function decodeCalldata(
  data: `0x${string}` | undefined | null,
): DecodedCalldata | null {
  if (!data || data === "0x") return null;
  if (data.length < 10) {
    return {
      selector: data.slice(0, 10) as `0x${string}`,
      signature: null,
      raw: data,
    };
  }
  const selector = data.slice(0, 10).toLowerCase() as `0x${string}`;
  const candidates = SELECTOR_DB[selector];
  if (!candidates || candidates.length === 0) {
    return { selector, signature: null, raw: data };
  }
  return decodeCalldataAgainst(data, candidates);
}
