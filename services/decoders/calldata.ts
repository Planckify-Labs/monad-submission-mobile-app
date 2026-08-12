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

  // delegate.xyz — spec phase F item b. Grants another address standing
  // rights over the signer's NFTs. Heavily used legitimately (a cold
  // vault delegating to a hot wallet for claims and airdrops), which is
  // exactly why it is abused, and critically it does NOT look like an
  // approval: no `approve`, no `setApprovalForAll`, so nothing in
  // `classifyRisk` caught it. Both the v1 (`delegateFor*`) and v2
  // (`delegate*`) registries are covered.
  "0x685ee3e8": ["function delegateForAll(address delegate, bool value)"],
  "0x49c95d29": [
    "function delegateForContract(address delegate, address contract_, bool value)",
  ],
  "0x537a5c3d": [
    "function delegateForToken(address delegate, address contract_, uint256 tokenId, bool value)",
  ],
  "0x30ff3140": [
    "function delegateAll(address to, bytes32 rights, bool enable)",
  ],
  "0xd90e73ab": [
    "function delegateContract(address to, address contract_, bytes32 rights, bool enable)",
  ],
  "0xb18e2bbb": [
    "function delegateERC721(address to, address contract_, uint256 tokenId, bytes32 rights, bool enable)",
  ],
  "0x003c2ba6": [
    "function delegateERC20(address to, address contract_, bytes32 rights, uint256 amount)",
  ],
  "0xab764683": [
    "function delegateERC1155(address to, address contract_, uint256 tokenId, bytes32 rights, uint256 amount)",
  ],

  // Spec §17.12 — the dapp's "mint ERC-20" case rendered as an unknown
  // selector. No risk classification: minting to yourself is ordinary,
  // and the `to` argument is visible in the decoded fields, which is
  // what a user needs to spot a mint that pays somebody else.
  "0x40c10f19": ["function mint(address to, uint256 amount)"],

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
        /** Confirmed ERC-20 allowance. Only emitted once the target is known. */
        kind: "approve";
        spender: `0x${string}`;
        amount: bigint;
        isUnlimited: boolean;
        /**
         * Phase N — *why* we called it unlimited, which decides how
         * confidently the UI may phrase it.
         *
         * `"supply"` means the allowance is at or above the token's
         * entire total supply, which is a fact and reads as one.
         * `"threshold"` means only the offline `2²⁵⁵` heuristic fired,
         * so the copy hedges. Absent when the allowance is bounded.
         */
        unlimitedBasis?: "supply" | "threshold";
        /**
         * Token decimals when the probe resolved them, so the UI can
         * render "18,446,744,073,710 USDC" rather than a 20-digit
         * integer. Absent means show the raw value.
         */
        decimals?: number;
      }
    | {
        /** Confirmed ERC-721 single-token approval — never "unlimited". */
        kind: "approveNft";
        operator: `0x${string}`;
        tokenId: bigint;
      }
    | {
        /**
         * `approve` whose target could not be typed. The second argument
         * is reported verbatim without claiming it is an amount or a
         * token id, and `isUnlimited` is deliberately not computed.
         *
         * This is the only safe default. Falling back to the ERC-20
         * reading is what produced the wrong copy; falling back to
         * ERC-721 would suppress a real unlimited-allowance warning.
         */
        kind: "approveUnknownAsset";
        spender: `0x${string}`;
        value: bigint;
        /**
         * The second argument is at or above the unlimited-allowance
         * threshold. We cannot say it IS an unlimited allowance without
         * knowing the contract is an ERC-20 — but staying silent is
         * worse. Before phase D a failed RPC probe still produced the
         * unlimited warning; treating "unresolved" as "no warning" would
         * have quietly removed the highest-frequency drain warning in
         * the wallet on exactly the flaky-network path where it matters.
         *
         * The UI must phrase this conditionally ("if this is a token").
         */
        looksUnlimited: boolean;
      }
    | {
        /**
         * delegate.xyz. Same weight as `setApprovalForAll`: it hands a
         * third party standing authority over assets without ever using
         * the word approve.
         */
        kind: "delegate";
        delegate: `0x${string}`;
        /** Scope of the grant, as the registry expresses it. */
        scope: "all" | "contract" | "token";
        /** Present for contract- and token-scoped grants. */
        contract?: `0x${string}`;
        tokenId?: bigint;
        /** False when the call is revoking rather than granting. */
        enabled: boolean;
      };
}

/**
 * How loudly a decoded call must be presented — spec phase L.
 *
 * This exists so a *batch* can be scored without re-deriving the rules
 * the single-transaction sheet uses. `wallet_sendCalls` shipped a sheet
 * that rendered function names and never read `risk` at all, so the same
 * `approve(spender, MAX)` was a red banner through `eth_sendTransaction`
 * and a bare parameter list through the batch method. A batch is exactly
 * as dangerous as its most dangerous entry, and expressing that needs one
 * shared ranking rather than two sheets agreeing by coincidence.
 *
 * The mapping mirrors `CalldataRiskSection` exactly: `none` means that
 * component renders nothing, so a batch-level banner never promises a
 * per-call banner the user then cannot find.
 */
export type CalldataRiskSeverity = "high" | "medium" | "none";

export function calldataRiskSeverity(
  decoded: DecodedCalldata | null | undefined,
): CalldataRiskSeverity {
  const risk = decoded?.risk;
  if (!risk) return "none";
  switch (risk.kind) {
    case "setApprovalForAll":
      return risk.approved ? "high" : "none";
    case "delegate":
      return risk.enabled ? "high" : "none";
    case "approve":
      return risk.isUnlimited ? "high" : "none";
    case "approveUnknownAsset":
      // Amber either way: we could not type the contract, so we cannot
      // say whether the second argument is an allowance or a token id.
      return risk.looksUnlimited ? "high" : "medium";
    case "approveNft":
      return "medium";
    default:
      return "none";
  }
}

/**
 * What the `approve` target is, when the caller could resolve it.
 * Supplied by the adapter (registry lookup, then ERC-165 probe); the
 * decoder itself is pure and never reaches the network.
 */
export type ApproveTargetKind = "erc20" | "erc721" | "erc1155" | "unknown";

export interface DecodeCalldataOptions {
  /** Defaults to `"unknown"`, which yields `approveUnknownAsset`. */
  approveTargetKind?: ApproveTargetKind;
  /**
   * Phase N — the `approve` target's `totalSupply()`, when the adapter
   * resolved it. An allowance at or above everything that exists is
   * unbounded in practice, which is a fact rather than a threshold.
   */
  totalSupply?: bigint;
  /** The `approve` target's `decimals()`, for rendering the amount. */
  decimals?: number;
}

// TWV-2026-009 — "unlimited" threshold for ERC-20 `approve`. Any value
// at or above `type(uint256).max / 2` is treated as unbounded because
// no legitimate workflow needs to grant more than half of supply — the
// pattern appears only in "max approve" templates that ice-phish drainers
// exploit.
const UINT256_MAX = (1n << 256n) - 1n;
const UNLIMITED_APPROVE_THRESHOLD = UINT256_MAX / 2n;

/** delegate.xyz function name → grant scope. */
const DELEGATE_SCOPES: Record<string, "all" | "contract" | "token"> = {
  delegateForAll: "all",
  delegateAll: "all",
  delegateForContract: "contract",
  delegateContract: "contract",
  delegateERC20: "contract",
  delegateForToken: "token",
  delegateERC721: "token",
  delegateERC1155: "token",
};

function classifyDelegate(
  decoded: DecodedCalldata,
): DecodedCalldata["risk"] | undefined {
  const scope = decoded.functionName
    ? DELEGATE_SCOPES[decoded.functionName]
    : undefined;
  if (!scope || !decoded.args) return undefined;
  const delegate = decoded.args[0]?.value;
  if (typeof delegate !== "string") return undefined;

  // Both registry generations put the delegate first, but differ after
  // that, so read by argument *name* rather than by position.
  const byName = (n: string): unknown =>
    decoded.args?.find((a) => a.name === n)?.value;
  const contract = byName("contract_");
  const tokenId = byName("tokenId");
  // v1 signals revocation with `value: false`, v2 with `enable: false`.
  // ERC-20/1155 grants carry an `amount` instead, where zero is the
  // revocation. Absent all three, treat it as a grant: under-warning on
  // a revoke is harmless, under-warning on a grant is not.
  const enableFlag = byName("enable") ?? byName("value");
  const amount = byName("amount");
  const enabled =
    typeof enableFlag === "boolean"
      ? enableFlag
      : typeof amount === "bigint"
        ? amount > 0n
        : true;

  return {
    kind: "delegate",
    delegate: delegate as `0x${string}`,
    scope,
    contract:
      typeof contract === "string" ? (contract as `0x${string}`) : undefined,
    tokenId: typeof tokenId === "bigint" ? tokenId : undefined,
    enabled,
  };
}

function classifyRisk(
  decoded: DecodedCalldata,
  opts?: DecodeCalldataOptions,
): DecodedCalldata["risk"] {
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
  const delegate = classifyDelegate(decoded);
  if (delegate) return delegate;
  if (decoded.functionName === "approve" && decoded.args) {
    const spender = decoded.args[0]?.value;
    const amount = decoded.args[1]?.value;
    if (typeof spender === "string" && typeof amount === "bigint") {
      // Selector 0x095ea7b3 is shared by ERC-20 `approve(spender, amount)`
      // and ERC-721 `approve(to, tokenId)` with byte-identical encoding,
      // so the calldata cannot disambiguate them and the roundtrip gate
      // passes for both. Only the caller's contract-type resolution can.
      const kind = opts?.approveTargetKind ?? "unknown";
      if (kind === "erc721" || kind === "erc1155") {
        return {
          kind: "approveNft",
          operator: spender as `0x${string}`,
          tokenId: amount,
        };
      }
      if (kind !== "erc20") {
        return {
          kind: "approveUnknownAsset",
          spender: spender as `0x${string}`,
          value: amount,
          looksUnlimited: amount >= UNLIMITED_APPROVE_THRESHOLD,
        };
      }
      // Phase N — supply first, threshold as the floor.
      //
      // The two rules are OR-ed rather than layered, and that ordering
      // is deliberate. A hostile token can report whatever
      // `totalSupply()` it likes: report `type(uint256).max` and a
      // supply-only rule would clear an allowance of `max - 1`. Keeping
      // the offline threshold underneath means the probe can only ever
      // *add* a warning, which is the same phase-D rule that says a
      // failed probe must never remove one.
      const overSupply =
        opts?.totalSupply !== undefined &&
        opts.totalSupply > 0n &&
        amount >= opts.totalSupply;
      const overThreshold = amount >= UNLIMITED_APPROVE_THRESHOLD;
      return {
        kind: "approve",
        spender: spender as `0x${string}`,
        amount,
        isUnlimited: overSupply || overThreshold,
        unlimitedBasis: overSupply
          ? "supply"
          : overThreshold
            ? "threshold"
            : undefined,
        decimals: opts?.decimals,
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
  opts?: DecodeCalldataOptions,
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
      out.risk = classifyRisk(out, opts);
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
  opts?: DecodeCalldataOptions,
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
  return decodeCalldataAgainst(data, candidates, opts);
}
