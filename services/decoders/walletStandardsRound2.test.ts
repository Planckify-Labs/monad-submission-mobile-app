/**
 * Regression coverage for `docs/wallet-standards-hardening-spec.md` §17
 * (phases L–R).
 *
 * Round 1 was written from our own code. Round 2 came from running the
 * bridge against `MetaMask/test-dapp`, whose `ppom/` and `malformed-*`
 * suites are an adversarial corpus, so several findings are **bypasses
 * of controls round 1 shipped**. Each case below is phrased as the
 * behaviour that was wrong before, with the test-dapp case that produced
 * it named in the comment, so a future reader can reproduce it rather
 * than take this file's word for it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EvmCalldataDecoderInspector } from "@/services/bridge/inspectors/EvmCalldataDecoderInspector";
import { pendingIntentsStore } from "@/services/bridge/pendingIntents";
import { PROVIDER_ERRORS } from "@/services/chains/evm/errors";
import {
  normalizeSendCalls,
  normalizeTx,
} from "@/services/chains/evm/normalizeRequest";
import {
  parseRpcData,
  parseRpcQuantity,
  parseTxType,
} from "@/services/chains/evm/rpcEncoding";
import {
  firstUnsupportedCapability,
  supportedCapabilityKeys,
} from "@/services/chains/evm/walletCapabilities";
import { ensDisplaySafety } from "@/services/ens/displaySafety";
import {
  __clearWatchedAssets,
  addWatchedAsset,
  isWatchedAsset,
  listWatchedAssets,
  removeWatchedAsset,
} from "@/services/tokens/watchedAssets";
import { BlurOrderTypedDataDecoder } from "./blurOrder";
import { calldataRiskSeverity, decodeCalldata } from "./calldata";
import {
  deployedContractLabel,
  describeDeployedContract,
  guessDeployedContractKind,
} from "./deployedContractKind";
import { isKnownSpender } from "./knownSpenders";
import { SeaportTypedDataDecoder } from "./seaport";
import { coerceChainId, validateTypedData } from "./typedDataValidate";
import { ZeroExOrderTypedDataDecoder } from "./zeroExOrder";

const REPO_ROOT = join(__dirname, "..", "..");
const SPENDER = "0x1111111111111111111111111111111111111111";
const OPERATOR = "0x4444444444444444444444444444444444444444";
const TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const MAX_UINT = (1n << 256n) - 1n;

function word(hex: string): string {
  return hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

/** `approve(address,uint256)` */
function approveCalldata(spender: string, value: bigint): `0x${string}` {
  return `0x095ea7b3${word(spender)}${word(value.toString(16))}` as `0x${string}`;
}

/** `setApprovalForAll(address,bool)` */
function setApprovalForAllCalldata(
  operator: string,
  approved: boolean,
): `0x${string}` {
  return `0xa22cb465${word(operator)}${word(approved ? "1" : "0")}` as `0x${string}`;
}

/** `transfer(address,uint256)` — the benign filler in a mixed batch. */
function transferCalldata(to: string, amount: bigint): `0x${string}` {
  return `0xa9059cbb${word(to)}${word(amount.toString(16))}` as `0x${string}`;
}

function batchIntent(
  calls: Array<{ to?: `0x${string}`; data?: `0x${string}` }>,
  approveTargets?: Array<
    | { kind: "erc20" | "erc721" | "erc1155" | "unknown"; totalSupply?: bigint }
    | undefined
  >,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  return {
    id: "test",
    namespace: "eip155",
    kind: "sendCalls",
    origin: { url: "https://dapp.test" },
    wallet: null,
    payload: {
      version: "2.0.0",
      chainId: 1,
      from: SPENDER,
      atomicRequired: true,
      calls,
      approveTargets,
    },
    annotations: [],
    createdAt: Date.now(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function runInspector(intent: any) {
  return EvmCalldataDecoderInspector.inspect(
    intent,
    [],
    new AbortController().signal,
  );
}

describe("phase L — wallet_sendCalls no longer bypasses the risk engine", () => {
  it("classifies a one-call batch of approve(spender, MAX) exactly as eth_sendTransaction does", async () => {
    // THE test for this phase. Before it, identical bytes produced a red
    // "unlimited allowance" banner through `eth_sendTransaction` and a
    // bare `approve(spender, amount)` parameter list through
    // `wallet_sendCalls` — no banner, no simulation, no risk read at all.
    const data = approveCalldata(SPENDER, MAX_UINT);

    const single = decodeCalldata(data, { approveTargetKind: "erc20" });

    const result = await runInspector(
      batchIntent([{ to: TOKEN, data }], [{ kind: "erc20" }]),
    );
    const batched = (result.patch as { decodedCalls?: unknown[] })
      ?.decodedCalls?.[0] as ReturnType<typeof decodeCalldata>;

    expect(batched?.risk).toEqual(single?.risk);
    expect(batched?.risk?.kind).toBe("approve");
    if (batched?.risk?.kind !== "approve") throw new Error("narrow");
    expect(batched.risk.isUnlimited).toBe(true);
    expect(calldataRiskSeverity(batched)).toBe(calldataRiskSeverity(single));
    expect(calldataRiskSeverity(batched)).toBe("high");
  });

  it("raises a batch-level annotation naming the risky call among benign ones", async () => {
    // `ppom/eip5792.js` line 145 does `calls.push(...DEFAULT_CALLS)` —
    // one malicious call hidden among benign ones, which is the harder
    // rendering problem because the flagged entry is below the fold.
    const calls = [
      ...Array.from({ length: 9 }, () => ({
        to: TOKEN as `0x${string}`,
        data: transferCalldata(SPENDER, 1n),
      })),
      {
        to: TOKEN as `0x${string}`,
        data: setApprovalForAllCalldata(OPERATOR, true),
      },
    ];
    const result = await runInspector(batchIntent(calls));

    expect(result.verdict).toBe("require-extra-confirmation");
    expect(result.annotations).toHaveLength(1);
    const [annotation] = result.annotations;
    expect(annotation.severity).toBe("danger");
    // The position matters: a warning that does not say *which* call
    // sends the user scrolling through ten identical-looking rows.
    expect(annotation.title).toContain("10");
  });

  it("leaves an all-benign batch alone", async () => {
    const result = await runInspector(
      batchIntent([
        { to: TOKEN, data: transferCalldata(SPENDER, 1n) },
        { to: TOKEN, data: transferCalldata(OPERATOR, 2n) },
      ]),
    );
    expect(result.verdict).toBe("allow");
    expect(result.annotations).toEqual([]);
  });

  it("does not flag a revocation", async () => {
    // `setApprovalForAll(op, false)` and a zero-value approve are the
    // *fix* for the thing being warned about. Warning on them trains
    // users to dismiss the banner.
    const result = await runInspector(
      batchIntent([
        { to: TOKEN, data: setApprovalForAllCalldata(OPERATOR, false) },
      ]),
    );
    expect(result.verdict).toBe("allow");
    expect(result.annotations).toEqual([]);
  });

  it("severity ranking matches what CalldataRiskSection actually renders", () => {
    // `none` must mean no *risk banner*, or the batch-level banner
    // promises a per-call warning the user cannot then find. (A neutral
    // amount card may still render at `none`; that is not a warning.)
    expect(
      calldataRiskSeverity(
        decodeCalldata(setApprovalForAllCalldata(OPERATOR, true)),
      ),
    ).toBe("high");
    expect(
      calldataRiskSeverity(
        decodeCalldata(setApprovalForAllCalldata(OPERATOR, false)),
      ),
    ).toBe("none");
    expect(
      calldataRiskSeverity(
        decodeCalldata(approveCalldata(SPENDER, 5n), {
          approveTargetKind: "erc721",
        }),
      ),
    ).toBe("medium");
    expect(
      calldataRiskSeverity(
        decodeCalldata(approveCalldata(SPENDER, 5n), {
          approveTargetKind: "erc20",
        }),
      ),
    ).toBe("none");
    expect(calldataRiskSeverity(null)).toBe("none");
  });

  it("keeps both EVM sheets rendering risk through the one component", () => {
    // The acceptance criterion that outlives this phase: a sixth risk
    // kind must not be able to land in one sheet and miss the other.
    // Asserted structurally because the failure mode is a *copy* of the
    // banner block, and a copy passes every behavioural test.
    const sheets = [
      "components/dapps-browser/approvals/EvmTransactionSheet.tsx",
      "components/dapps-browser/approvals/EvmBatchCallsSheet.tsx",
    ];
    for (const rel of sheets) {
      const src = readFileSync(join(REPO_ROOT, rel), "utf8");
      expect(src, `${rel} must import the shared risk section`).toContain(
        'from "./CalldataRiskSection"',
      );
      // No sheet may re-derive a risk branch inline.
      expect(
        /risk\?\.kind === "(setApprovalForAll|delegate|approveNft|approveUnknownAsset)"/.test(
          src,
        ),
        `${rel} must not branch on risk kinds inline`,
      ).toBe(false);
    }
  });
});

describe("phase M — JSON-RPC encoding is validated, not cast", () => {
  const FROM = "0x5555555555555555555555555555555555555555" as const;
  const TO = TOKEN as `0x${string}`;

  function tx(raw: Record<string, unknown>) {
    return normalizeTx({ to: TO, from: FROM, ...raw }, 1, FROM);
  }

  it("rejects the odd-length approve instead of decoding it as something else", () => {
    // `maliciousApproveERC20WithOddHexData`. This is the whole phase in
    // one case: strip a leading zero from a legitimate approve and the
    // 4-byte selector slice lands on `0x95ea7b30`, misses SELECTOR_DB,
    // and the unlimited-allowance warning vanishes. The chain still
    // executes an approve.
    const wellFormed = approveCalldata(SPENDER, MAX_UINT);
    const oddLength = `0x${wellFormed.slice(3)}` as `0x${string}`;
    expect(oddLength.length % 2).toBe(1);

    // What the decoder does with it, and why rejecting at the boundary
    // is the fix rather than teaching the decoder to re-align.
    expect(decodeCalldata(wellFormed)?.risk).toBeDefined();
    expect(decodeCalldata(oddLength)?.signature).toBeNull();

    const result = tx({ data: oddLength });
    expect("error" in result).toBe(true);
  });

  it("accepts well-formed calldata", () => {
    const result = tx({ data: approveCalldata(SPENDER, MAX_UINT) });
    expect("payload" in result).toBe(true);
  });

  it.each([
    ["not hex", "0xzzzz"],
    ["odd length", "0x123"],
    ["odd length without a prefix", "123"],
  ])("rejects calldata that is %s", (_label, data) => {
    expect("error" in tx({ data })).toBe(true);
  });

  it("tolerates calldata with no 0x prefix and normalises it", () => {
    // DATA is always hex, so a missing prefix is punctuation rather
    // than ambiguity. The even-length rule — the part that actually
    // stops the odd-hex approve bypass — applies either way.
    const wellFormed = approveCalldata(SPENDER, MAX_UINT);
    const r = tx({ data: wellFormed.slice(2) });
    expect("error" in r).toBe(false);
    if ("error" in r) throw new Error("narrow");
    expect(r.payload.data).toBe(wellFormed.toLowerCase());
    // ...and the bypass is still refused unprefixed.
    expect("error" in tx({ data: wellFormed.slice(3) })).toBe(true);
  });

  it("reads a bare 0x quantity as zero", () => {
    const r = tx({ value: "0x", data: "0x" });
    expect("error" in r).toBe(false);
    if ("error" in r) throw new Error("narrow");
    expect(r.payload.value).toBe(0n);
  });

  it("accepts a decimal QUANTITY, and reads it as decimal", () => {
    // CORRECTION to the original phase-M rule, which required `0x` and
    // rejected everything else. tower.exchange sends a token approval
    // as `{ gas: "100000", maxFeePerGas: "0x9a997bf00", nonce: "0x20" }`
    // — decimal for one field, hex for the others — and we killed the
    // whole swap with `invalidParams: gas`.
    //
    // Decimal is both the intended reading (it is what `String(bigint)`
    // produces) and the conservative one: interpreting a decimal value
    // as hex inflates it.
    const r = tx({ value: "100", gas: "100000" });
    expect("error" in r).toBe(false);
    if ("error" in r) throw new Error("narrow");
    expect(r.payload.value).toBe(100n);
    expect(r.payload.gas).toBe(100000n);
    expect("error" in tx({ value: "0x100" })).toBe(false);
  });

  it("still refuses bare hex digits with no prefix", () => {
    // `bypasses.js`. Not a decimal integer, so there is no reading we
    // can defend, and guessing hex is the dangerous direction.
    expect("error" in tx({ value: "ffffffffffffff" })).toBe(true);
    expect("error" in tx({ gas: "1e3" })).toBe(true);
    expect("error" in tx({ value: "-1" })).toBe(true);
  });

  it("reproduces the exact tower.exchange approval that used to fail", () => {
    const r = normalizeTx(
      {
        data: `0x095ea7b3${"0".repeat(24)}2de8906a641d65d490bc60a4179d961d59742bcb${"0".repeat(64)}`,
        from: FROM,
        gas: "100000",
        maxFeePerGas: "0x9a997bf00",
        maxPriorityFeePerGas: "0x59682f00",
        nonce: "0x20",
        to: "0x3600000000000000000000000000000000000000",
        value: "0x0",
      },
      1,
      FROM,
    );
    expect("error" in r).toBe(false);
    if ("error" in r) throw new Error("narrow");
    expect(r.payload.gas).toBe(100000n);
    expect(r.payload.nonce).toBe(32);
    expect(r.payload.type).toBe(2);
  });

  it.each([
    ["0x3", "EIP-4844 blob"],
    ["0x4", "EIP-7702 authorization list"],
    ["0x5", "the test-dapp's invalid type"],
    ["0x76", "Tempo, which carries a feeToken"],
  ])("rejects transaction type %s (%s) rather than coercing it", (type) => {
    // Coercing to type 2 is not a lenient default. It signs a plain
    // dynamic-fee transaction while dropping the exact fields that make
    // the requested type what it is, so the wallet executes different
    // semantics than the dApp asked for.
    const result = tx({ type, data: "0x" });
    expect("error" in result).toBe(true);
  });

  it.each([0, 1, 2])("still accepts type %i", (n) => {
    const result = tx({ type: `0x${n}`, data: "0x" });
    expect("error" in result).toBe(false);
  });

  it("accepts leading zeros in a quantity", () => {
    // Not compact, per the spec's wording, but unambiguous and common in
    // the wild. Rejecting it would break working dApps to enforce
    // tidiness rather than safety.
    const result = tx({ value: "0x0064" });
    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("narrow");
    expect(result.payload.value).toBe(100n);
  });

  it("applies the same rules inside wallet_sendCalls", () => {
    // Validating only the single-transaction path would leave the
    // odd-hex bypass fully intact behind the batch method, which is the
    // same shape of hole phase L exists to close.
    const wellFormed = approveCalldata(SPENDER, MAX_UINT);
    const bad = normalizeSendCalls(
      {
        version: "2.0.0",
        chainId: "0x1",
        from: FROM,
        calls: [{ to: TO, data: `0x${wellFormed.slice(3)}` }],
      },
      1,
      FROM,
    );
    expect("error" in bad).toBe(true);

    const good = normalizeSendCalls(
      {
        version: "2.0.0",
        chainId: "0x1",
        from: FROM,
        calls: [{ to: TO, data: wellFormed }],
      },
      1,
      FROM,
    );
    expect("error" in good).toBe(false);
  });

  it("rejects a batch entry whose recipient is not an address", () => {
    const result = normalizeSendCalls(
      {
        version: "2.0.0",
        chainId: "0x1",
        from: FROM,
        calls: [{ to: "not-an-address", data: "0x" }],
      },
      1,
      FROM,
    );
    expect("error" in result).toBe(true);
  });

  it("parses the primitives the way the JSON-RPC spec describes them", () => {
    expect(parseRpcData(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseRpcData("0xAABB")).toEqual({ ok: true, value: "0xaabb" });
    expect(parseRpcData("0xABC").ok).toBe(false);
    expect(parseRpcData("aabb")).toEqual({ ok: true, value: "0xaabb" });
    expect(parseRpcQuantity("0x0").ok).toBe(true);
    expect(parseRpcQuantity("0x")).toEqual({ ok: true, value: 0n });
    expect(parseRpcQuantity("100000")).toEqual({ ok: true, value: 100000n });
    expect(parseRpcQuantity("deadbeef").ok).toBe(false);
    expect(parseRpcQuantity(-1).ok).toBe(false);
    expect(parseRpcQuantity(Number.MAX_SAFE_INTEGER + 2).ok).toBe(false);
    expect(parseTxType(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseTxType(2)).toEqual({ ok: true, value: 2 });
    expect(parseTxType("0x76").ok).toBe(false);
  });
});

describe("phase N — the unlimited threshold is no longer decimals-blind", () => {
  // The test-dapp's malicious approval. Sixty-four bits of ones: a
  // rounding error on an 18-decimal token, more USDC than will ever
  // exist on a 6-decimal one, and identical bytes either way.
  const MALICIOUS = 0xffffffffffffffffn;
  // Real USDC supply is on the order of 6e16 base units (6 decimals).
  const USDC_SUPPLY = 60_000_000_000n * 10n ** 6n;
  // A large 18-decimal token: 1e9 tokens.
  const BIG_SUPPLY = 1_000_000_000n * 10n ** 18n;

  it("was silent on the malicious value before, because it is below 2^255", () => {
    // The gap the payload was built to sit in. Kept as a test so the
    // reason for the supply probe stays legible.
    expect(MALICIOUS < (1n << 256n) / 2n).toBe(true);
    const decoded = decodeCalldata(approveCalldata(SPENDER, MALICIOUS), {
      approveTargetKind: "erc20",
    });
    if (decoded?.risk?.kind !== "approve") throw new Error("narrow");
    expect(decoded.risk.isUnlimited).toBe(false);
  });

  it("flags it as unlimited once total supply is known", () => {
    const decoded = decodeCalldata(approveCalldata(SPENDER, MALICIOUS), {
      approveTargetKind: "erc20",
      totalSupply: USDC_SUPPLY,
      decimals: 6,
    });
    if (decoded?.risk?.kind !== "approve") throw new Error("narrow");
    expect(decoded.risk.isUnlimited).toBe(true);
    expect(decoded.risk.unlimitedBasis).toBe("supply");
    expect(calldataRiskSeverity(decoded)).toBe("high");
  });

  it("leaves the same value unflagged on a large 18-decimal token", () => {
    // 18.45 tokens. Flagging this would be the mirror-image failure:
    // a warning on an ordinary approval, which is how users learn to
    // dismiss them.
    const decoded = decodeCalldata(approveCalldata(SPENDER, MALICIOUS), {
      approveTargetKind: "erc20",
      totalSupply: BIG_SUPPLY,
      decimals: 18,
    });
    if (decoded?.risk?.kind !== "approve") throw new Error("narrow");
    expect(decoded.risk.isUnlimited).toBe(false);
    expect(decoded.risk.decimals).toBe(18);
  });

  it("still fires the offline fallback when the probe returns nothing", () => {
    // Phase D's rule: a failed probe must never *remove* a warning.
    const decoded = decodeCalldata(approveCalldata(SPENDER, MAX_UINT), {
      approveTargetKind: "erc20",
    });
    if (decoded?.risk?.kind !== "approve") throw new Error("narrow");
    expect(decoded.risk.isUnlimited).toBe(true);
    expect(decoded.risk.unlimitedBasis).toBe("threshold");
  });

  it("cannot be talked out of a warning by a hostile totalSupply", () => {
    // The reason supply and threshold are OR-ed rather than layered. A
    // token that reports `type(uint256).max` as its supply would clear
    // an allowance of `max - 1` under a supply-only rule.
    const decoded = decodeCalldata(approveCalldata(SPENDER, MAX_UINT - 1n), {
      approveTargetKind: "erc20",
      totalSupply: MAX_UINT,
    });
    if (decoded?.risk?.kind !== "approve") throw new Error("narrow");
    expect(decoded.risk.isUnlimited).toBe(true);
    expect(decoded.risk.unlimitedBasis).toBe("threshold");
  });

  it("does not apply the supply rule to an NFT approval", () => {
    // The second argument is a token id there, and comparing an id to a
    // supply is a category error that phase D exists to prevent.
    const decoded = decodeCalldata(approveCalldata(SPENDER, MALICIOUS), {
      approveTargetKind: "erc721",
      totalSupply: 100n,
    });
    expect(decoded?.risk?.kind).toBe("approveNft");
  });
});

describe("phase O — EIP-712 payloads are validated, not cast", () => {
  const PERMIT_TYPES = {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  function permit(overrides: Record<string, unknown> = {}) {
    return {
      types: PERMIT_TYPES,
      primaryType: "Permit",
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 1,
        verifyingContract: TOKEN,
      },
      message: {
        owner: SPENDER,
        spender: OPERATOR,
        value: "3000000000000000000",
        nonce: 0,
        deadline: 50000000000,
      },
      ...overrides,
    };
  }

  it("accepts a well-formed permit", () => {
    expect(validateTypedData(permit()).ok).toBe(true);
  });

  it.each([
    ["an empty domain", { domain: undefined }],
    ["a primaryType absent from types", { primaryType: "Non-Existent" }],
    ["no primaryType at all", { primaryType: undefined }],
    ["a missing message", { message: undefined }],
    ["no types", { types: undefined }],
  ])("rejects %s", (_label, override) => {
    // `malformed-signatures.js`. None of these are fund-loss bugs —
    // viem throws at sign time — but every one of them is
    // approve-then-fail, and a user who is taught that rejection is
    // routine stops reading the sheet.
    const result = validateTypedData(permit(override));
    expect(result.ok).toBe(false);
  });

  it("rejects an unparseable type reference", () => {
    // `'ConsiderationItem[+'` — a real case from the dapp.
    const result = validateTypedData(
      permit({
        types: {
          ...PERMIT_TYPES,
          Permit: [{ name: "items", type: "ConsiderationItem[+" }],
        },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a type reference that resolves to nothing", () => {
    const result = validateTypedData(
      permit({
        types: {
          ...PERMIT_TYPES,
          Permit: [{ name: "items", type: "ConsiderationItem[]" }],
        },
        message: { items: [] },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("resolves maliciousPermitIntAddress back to the real USDC address", () => {
    // The payload sends verifyingContract as a decimal integer string.
    // Every address-keyed lookup we have missed it, so the user saw a
    // 48-digit number where a token name belongs. Coercing is safe here
    // in a way that repairing calldata is not: the type system states
    // the field IS an address, so there is nothing to guess.
    const decimal = BigInt(TOKEN).toString(10);
    expect(decimal).toBe("917551056842671309452305380979543736893630245704");
    const result = validateTypedData(
      permit({ domain: { ...permit().domain, verifyingContract: decimal } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("narrow");
    expect(String(result.value.domain.verifyingContract).toLowerCase()).toBe(
      TOKEN,
    );
  });

  it("coerces a decimal address inside the message too", () => {
    const result = validateTypedData(
      permit({
        message: { ...permit().message, spender: BigInt(TOKEN).toString(10) },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("narrow");
    expect(String(result.value.message.spender).toLowerCase()).toBe(TOKEN);
  });

  it("parses a 64-digit hex-padded chainId", () => {
    const padded = `0x${(1).toString(16).padStart(64, "0")}`;
    const result = validateTypedData(
      permit({ domain: { ...permit().domain, chainId: padded } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("narrow");
    expect(result.value.domain.chainId).toBe(1);
  });

  it("rejects the chainId shapes Number() would silently accept", () => {
    // `Number("1e3")` is 1000 and `Number(" 1 ")` is 1. Neither is a
    // chainId anybody typed on purpose, and a parser that agrees with
    // both is not a parser.
    expect(coerceChainId("1e3")).toBeNull();
    expect(coerceChainId("")).toBeNull();
    expect(coerceChainId({})).toBeNull();
    expect(coerceChainId("0x1")).toBe(1);
    expect(coerceChainId(1)).toBe(1);
  });

  it("reports undeclared message keys and keeps them out of the payload", () => {
    // `signExtraDataNotTyped`. The key is not in the signed hash, so
    // rendering it would show the user a term the signature does not
    // cover. Strip, and say we stripped it.
    const result = validateTypedData(
      permit({ message: { ...permit().message, extraData: "surprise" } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("narrow");
    expect(result.undeclaredKeys).toEqual(["extraData"]);
    expect("extraData" in result.value.message).toBe(false);
  });

  it("rejects a declared field with no value rather than defaulting it", () => {
    const { deadline: _dropped, ...rest } = permit().message as Record<
      string,
      unknown
    >;
    expect(validateTypedData(permit({ message: rest })).ok).toBe(false);
  });

  it("refuses eth_signTypedData v1 deliberately rather than by accident", () => {
    // Absent from MetaMask's own openrpc.yaml, carries no domain
    // separator (which conflicts with phase H), and its params are
    // reversed so it already failed as "invalid address" — a refusal
    // that read like a bug in us rather than a decision.
    const src = readFileSync(
      join(REPO_ROOT, "services/chains/evm/EvmAdapter.ts"),
      "utf8",
    );
    expect(src).toContain(
      'case "eth_signTypedData_v1":\n          return err(PROVIDER_ERRORS.unsupportedMethod(req.method));',
    );
  });
});

describe("phase P — marketplace order decoders, round 2", () => {
  const SIGNER = "0x5a6f5477bdeb7801ba137a9f0dc39c0599bac994";
  const ATTACKER = "0xdfdc0b1cf8e9950d6a860af6501c4fecf7825cc1";
  const COLLECTION = "0x8a90cab2b38dba80c64b7734e58ee1db38b8992e";
  const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

  // Verbatim from `ppom/transactions.js#maliciousTradeOrder`.
  function tradeOrder(overrides: Record<string, unknown> = {}) {
    return {
      types: {
        ERC721Order: [
          { type: "uint8", name: "direction" },
          { type: "address", name: "maker" },
          { type: "address", name: "taker" },
          { type: "uint256", name: "expiry" },
          { type: "uint256", name: "nonce" },
          { type: "address", name: "erc20Token" },
          { type: "uint256", name: "erc20TokenAmount" },
          { type: "Fee[]", name: "fees" },
          { type: "address", name: "erc721Token" },
          { type: "uint256", name: "erc721TokenId" },
          { type: "Property[]", name: "erc721TokenProperties" },
        ],
      },
      domain: {
        name: "ZeroEx",
        version: "1.0.0",
        chainId: "1",
        verifyingContract: "0xdef1c0ded9bec7f1a1670819833240f027b25eff",
      },
      primaryType: "ERC721Order",
      message: {
        direction: "0",
        maker: SIGNER,
        taker: ATTACKER,
        expiry: "2524604400",
        nonce:
          "100131415900000000000000000000000000000083840314483690155566137712510085002484",
        erc20Token: WETH,
        erc20TokenAmount: "42000000000000",
        fees: [],
        erc721Token: COLLECTION,
        erc721TokenId: "2516",
        erc721TokenProperties: [],
        ...((overrides.message as object) ?? {}),
      },
      ...overrides,
    } as never;
  }

  it("renders the NFT, the price and the taker on maliciousTradeOrder", () => {
    const d = ZeroExOrderTypedDataDecoder.decode(tradeOrder(), {
      signer: SIGNER,
    });
    expect(d).not.toBeNull();
    const values = d?.fields.map((f) => f.value).join(" | ") ?? "";
    expect(values).toContain("2516");
    expect(values).toContain("42000000000000");
    expect(values).toContain(ATTACKER);
  });

  it("warns when the 0x maker is not the signer", () => {
    const d = ZeroExOrderTypedDataDecoder.decode(tradeOrder(), {
      signer: ATTACKER,
    });
    expect(d?.warnings?.some((w) => /not in your name/i.test(w.title))).toBe(
      true,
    );
  });

  it("ignores a payload from another marketplace", () => {
    const other = tradeOrder() as unknown as { domain: { name: string } };
    other.domain = { ...other.domain, name: "Seaport" };
    expect(
      ZeroExOrderTypedDataDecoder.decode(other as never, { signer: SIGNER }),
    ).toBeNull();
  });

  // Verbatim from the dapp's `src/signatures/utils.js`.
  function blurOrder(trader: string) {
    return {
      primaryType: "Order",
      types: {
        MakerFee: [
          { name: "recipient", type: "address" },
          { name: "rate", type: "uint256" },
        ],
        Order: [
          { name: "assetType", type: "uint8" },
          { name: "collection", type: "address" },
          { name: "expirationTime", type: "uint256" },
          { name: "listingsRoot", type: "bytes32" },
          { name: "makerFee", type: "MakerFee" },
          { name: "nonce", type: "uint256" },
          { name: "numberOfListings", type: "uint256" },
          { name: "orderType", type: "uint8" },
          { name: "salt", type: "uint256" },
          { name: "trader", type: "address" },
        ],
      },
      domain: {
        name: "Blur Exchange",
        version: "1.0",
        chainId: 1,
        verifyingContract: "0xb2ecfe4e4d61f8790bbb9de2d1259b9e2410cea5",
      },
      message: {
        assetType: "0",
        collection: COLLECTION,
        expirationTime: "1739484503",
        listingsRoot:
          "0xf5126e36e0cf3f8ccdf8e3d76c1501c706c15a029fb8139bca7b536776e9eafe",
        makerFee: { recipient: SPENDER, rate: "0" },
        nonce: "0",
        numberOfListings: "1",
        orderType: "1",
        salt: "106171581059276559763059578085820161781",
        trader,
      },
    } as never;
  }

  it("renders collection, listing count and expiry for a Blur order", () => {
    const d = BlurOrderTypedDataDecoder.decode(blurOrder(SIGNER), {
      signer: SIGNER,
    });
    expect(d).not.toBeNull();
    const byLabel = Object.fromEntries(
      (d?.fields ?? []).map((f) => [f.label, f.value]),
    );
    expect(byLabel.Collection).toBe(COLLECTION);
    expect(byLabel["Listings covered"]).toBe("1");
    expect(byLabel.Expires).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it("never claims to know which items a Blur order covers", () => {
    // `listingsRoot` is a Merkle root and the leaves are not in the
    // payload. A confident item list we did not verify would be worse
    // than the raw hex this replaces.
    const d = BlurOrderTypedDataDecoder.decode(blurOrder(SIGNER), {
      signer: SIGNER,
    });
    expect(
      d?.warnings?.some((w) => /items are not listed here/i.test(w.title)),
    ).toBe(true);
    const serialized = JSON.stringify(d);
    expect(serialized).not.toContain("listingsRoot");
  });

  it("decodes Blur without adding it to the known-spender table", () => {
    // §16.3 pulled Blur from `knownSpenders` for want of a verifiable
    // address. A decoder gates on `domain.name` (self-describing, no
    // trust); the address table asserts "this address IS Blur", which is
    // the claim that needed a source. The two must not be conflated.
    const src = readFileSync(
      join(REPO_ROOT, "services/decoders/knownSpenders.ts"),
      "utf8",
    );
    expect(src.toLowerCase()).not.toContain(
      "0xb2ecfe4e4d61f8790bbb9de2d1259b9e2410cea5",
    );
  });

  it("recognises Seaport 1.1, which maliciousSeaport signs against", () => {
    // Verified against ProjectOpenSea/seaport's deployment table, the
    // same primary source the 1.5 and 1.6 entries came from.
    const known = isKnownSpender(
      "0x00000000006c3852cbef3e08e8df289169ede581",
      1,
    );
    expect(known?.name).toBe("Seaport 1.1");
  });

  it("measures the Seaport payoff against the signer, not the offerer", () => {
    // The defect: an attacker sets `offerer` to an address they control
    // AND lists it as a consideration recipient. The old check compared
    // recipients to `offerer`, so it was satisfied, and the warning
    // disappeared while the person signing received nothing.
    const order = {
      domain: { name: "Seaport", version: "1.1", chainId: 1 },
      primaryType: "OrderComponents",
      message: {
        offerer: ATTACKER,
        offer: [
          {
            itemType: "2",
            token: COLLECTION,
            identifierOrCriteria: "26464",
            startAmount: "1",
          },
        ],
        consideration: [
          {
            itemType: "1",
            token: WETH,
            startAmount: "1000",
            recipient: ATTACKER,
          },
        ],
        startTime: "1681810415",
        endTime: "1681983215",
      },
    } as never;

    const withSigner = SeaportTypedDataDecoder.decode(order, {
      signer: SIGNER,
    });
    expect(
      withSigner?.warnings?.some((w) =>
        /nothing comes back to you/i.test(w.title),
      ),
    ).toBe(true);
    expect(
      withSigner?.warnings?.some((w) => /not in your name/i.test(w.title)),
    ).toBe(true);

    // And the pre-fix behaviour, kept as the contrast: comparing against
    // the payload's own `offerer` finds the order perfectly agreeable.
    const withoutSigner = SeaportTypedDataDecoder.decode(order, {});
    expect(
      withoutSigner?.warnings?.some((w) =>
        /nothing comes back to you/i.test(w.title),
      ) ?? false,
    ).toBe(false);
  });

  it("still says nothing when a genuine sale pays the signer", () => {
    const order = {
      domain: { name: "Seaport", version: "1.1", chainId: 1 },
      primaryType: "OrderComponents",
      message: {
        offerer: SIGNER,
        offer: [
          {
            itemType: "2",
            token: COLLECTION,
            identifierOrCriteria: "1",
            startAmount: "1",
          },
        ],
        consideration: [
          {
            itemType: "1",
            token: WETH,
            startAmount: "1000000",
            recipient: SIGNER,
          },
        ],
        startTime: "1681810415",
        endTime: "1681983215",
      },
    } as never;
    const d = SeaportTypedDataDecoder.decode(order, { signer: SIGNER });
    expect(d?.warnings).toBeUndefined();
  });
});

describe("phase Q — the approval queue is capped and disclosed", () => {
  function intent(id: string, origin: string) {
    return {
      id,
      namespace: "eip155",
      kind: "sendTransaction",
      origin: { url: origin },
      wallet: null,
      payload: {},
      annotations: [],
      createdAt: Date.now(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  beforeEach(() => {
    pendingIntentsStore.__resetForTest();
  });

  it("caps how many approvals one origin can queue", () => {
    // Note the premise correction recorded in the spec: DappBridge's
    // `pendingByOrigin` guard already refuses a second concurrent
    // request from the same origin with -32002, so `batching.js`'s ten
    // in a loop never reach this store ten deep. This cap covers the
    // paths that guard does not: several origins, the on-demand
    // inspector re-push, and a restored queue.
    expect(pendingIntentsStore.push(intent("a", "https://one.test"))).toBe(
      true,
    );
    expect(pendingIntentsStore.push(intent("b", "https://one.test"))).toBe(
      true,
    );
    expect(pendingIntentsStore.push(intent("c", "https://one.test"))).toBe(
      false,
    );
    // A different origin is unaffected by another's noise.
    expect(pendingIntentsStore.push(intent("d", "https://two.test"))).toBe(
      true,
    );
  });

  it("caps the queue overall", () => {
    let accepted = 0;
    for (let i = 0; i < 40; i++) {
      if (pendingIntentsStore.push(intent(`i${i}`, `https://d${i}.test`))) {
        accepted++;
      }
    }
    expect(accepted).toBe(8);
    expect(pendingIntentsStore.snapshot).toHaveLength(8);
  });

  it("treats a sheet presented right after a decision as draining", () => {
    // The lock exists for the mis-tap, not the crash: the reject button
    // of sheet n sits under the finger about to approve sheet n+1.
    expect(pendingIntentsStore.isDraining()).toBe(false);
    pendingIntentsStore.push(intent("a", "https://one.test"));
    pendingIntentsStore.resolve("a", { id: "a", outcome: "reject" });
    expect(pendingIntentsStore.isDraining()).toBe(true);
  });

  it("keys each sheet by intent id so a new request is a new mount", () => {
    // Without the key, two consecutive requests of the same kind render
    // the same element type in the same position, React reuses the
    // instance, and the new sheet inherits the old one's state — the
    // previous transaction's simulated asset movement among it. It is
    // also what re-arms the input lock.
    const src = readFileSync(
      join(REPO_ROOT, "services/bridge/ApprovalHost.tsx"),
      "utf8",
    );
    expect(src).toContain("key={intent.id}");
  });

  it("puts the input lock in the shared action bar, not in each sheet", () => {
    // A control every sheet must opt into is a control some sheet
    // eventually will not.
    const src = readFileSync(
      join(REPO_ROOT, "components/dapps-browser/approvals/SheetModal.tsx"),
      "utf8",
    );
    expect(src).toContain("useQueueInputLock");
    // Reject must never be the slower option, or the lock becomes an
    // obstacle to the safe choice.
    expect(src).not.toMatch(/onPress=\{onReject\}[\s\S]{0,200}approveBlocked/);
  });
});

describe("phase R — ENS names on approval surfaces", () => {
  it("renders an ordinary ASCII name", () => {
    const d = ensDisplaySafety("vitalik.eth");
    expect(d.render).toBe(true);
    if (!d.render) throw new Error("narrow");
    expect(d.display).toBe("vitalik.eth");
  });

  it("refuses an all-Cyrillic name that normalizes cleanly", () => {
    // ENSIP-15 forbids *mixing* scripts inside a label, so a label that
    // is entirely Cyrillic is valid and normalizes without complaint.
    // Normalization decides validity, not similarity, which is exactly
    // the gap this gate exists to cover.
    const d = ensDisplaySafety("виталик.eth");
    expect(d.render).toBe(false);
    if (d.render) throw new Error("narrow");
    expect(d.reason).toBe("non-latin-script");
  });

  it.each(["日本.eth", "🚀.eth"])("refuses %s", (name) => {
    expect(ensDisplaySafety(name).render).toBe(false);
  });

  it("keeps accented Latin names, which ENSIP-15 has already curated", () => {
    // The Latin group is accepted rather than cut to ASCII because
    // ENSIP-15 already disallows the worst Latin-block homoglyphs
    // (U+01C0 `ǀ`, U+0131 `ı`), so cutting it would cost users with
    // accented names their labels and buy very little.
    expect(ensDisplaySafety("josé.eth").render).toBe(true);
    expect(ensDisplaySafety("müller.eth").render).toBe(true);
    expect(ensDisplaySafety("ǀitalik.eth").render).toBe(false);
    expect(ensDisplaySafety("ıvan.eth").render).toBe(false);
  });

  it("survives junk without throwing", () => {
    expect(ensDisplaySafety(null).render).toBe(false);
    expect(ensDisplaySafety("").render).toBe(false);
    expect(ensDisplaySafety("   ").render).toBe(false);
  });

  it("does not stop a same-script lookalike, which is on purpose", () => {
    // `vitaIik.eth` normalizes to `vitaiik.eth` — capital I maps to
    // lowercase i — a distinct, valid name that reads as `vitalik.eth`
    // at sheet size. Catching this needs a visual-similarity model whose
    // false positives land on legitimate names. The mitigation is
    // structural instead: the label never replaces the address, so there
    // is always something exact on screen to check against. Asserted so
    // nobody later mistakes this for an oversight.
    const d = ensDisplaySafety("vitaIik.eth");
    expect(d.render).toBe(true);
    if (!d.render) throw new Error("narrow");
    expect(d.display).toBe("vitaiik.eth");
  });

  it("keeps the address on screen and never takes a dApp-supplied name", () => {
    const src = readFileSync(
      join(
        REPO_ROOT,
        "components/dapps-browser/approvals/CounterpartyLabel.tsx",
      ),
      "utf8",
    );
    // Reverse only: the component's sole input is an address.
    expect(src).toContain("useENSName(address)");
    expect(src).not.toMatch(/name\s*[?:]\s*string/);
    // Additive: the address renders unconditionally, outside any
    // name-dependent branch.
    expect(src).toContain("{address}");
  });

  it("carries no trust vocabulary anywhere near the label", () => {
    // The constraint most likely to be softened later by someone
    // treating the label as a feature rather than a legibility aid. An
    // ENS name means somebody paid a registration fee and nothing more.
    const src = readFileSync(
      join(
        REPO_ROOT,
        "components/dapps-browser/approvals/CounterpartyLabel.tsx",
      ),
      "utf8",
    );
    const rendered = src.slice(src.indexOf("export function"));
    for (const banned of [
      "verified",
      "Verified",
      "trusted",
      "Trusted",
      "ShieldCheck",
      "BadgeCheck",
      "CheckCircle",
      "text-green",
      "✓",
    ]) {
      expect(rendered, `must not contain "${banned}"`).not.toContain(banned);
    }
  });

  it("is wired into both EVM sheets", () => {
    for (const rel of [
      "components/dapps-browser/approvals/EvmTransactionSheet.tsx",
      "components/dapps-browser/approvals/EvmBatchCallsSheet.tsx",
    ]) {
      const src = readFileSync(join(REPO_ROOT, rel), "utf8");
      expect(src, rel).toContain("<CounterpartyLabel");
    }
  });
});

// ---------------------------------------------------------------------
// Conformance follow-up, 2026-08-12: contract deployment, EIP-5792 error
// codes, and EIP-747. Driven by testing against the live MetaMask
// test-dapp rather than by reading its source, so the shapes below are
// the ones the dapp actually puts on the wire.
// ---------------------------------------------------------------------

describe("contract deployment (ERC-20 / ERC-721 / ERC-1155 / multisig)", () => {
  const FROM = "0x5555555555555555555555555555555555555555" as const;
  // Stand-in init-code: what matters is that it is non-empty and even.
  const BYTECODE = `0x60806040${"ab".repeat(600)}` as `0x${string}`;

  it("accepts the shape ethers ContractFactory.deploy() puts on the wire", () => {
    // Every deploy button in the dapp — ERC-20 `createToken`,
    // `deployNFTsButton`, `deployERC1155Button`, `deployMultisigButton` —
    // goes through ethers v5 `factory.deploy()`, which emits
    // `{from, data, gas}` with **no `to` key at all**.
    const r = normalizeTx(
      { from: FROM, data: BYTECODE, gas: "0x1e8480" },
      1,
      FROM,
    );
    expect("payload" in r).toBe(true);
    if (!("payload" in r)) throw new Error("narrow");
    expect(r.payload.to).toBeUndefined();
    expect(r.payload.data).toBe(BYTECODE.toLowerCase());
  });

  it("accepts an explicit null recipient", () => {
    const r = normalizeTx({ from: FROM, to: null, data: BYTECODE }, 1, FROM);
    expect("payload" in r).toBe(true);
  });

  it("still refuses a missing recipient with no init-code", () => {
    // The rule that keeps a dApp's missing-`to` bug from becoming a
    // value-burning send. A deploy is defined by having init-code.
    expect("error" in normalizeTx({ from: FROM, value: "0x1" }, 1, FROM)).toBe(
      true,
    );
    expect(
      "error" in normalizeTx({ from: FROM, data: "0x", value: "0x1" }, 1, FROM),
    ).toBe(true);
  });

  it("does not try to decode init-code as a function call", () => {
    // Constructor init-code is not ABI-encoded, so running the 4-byte
    // table over it would mis-hit some unrelated signature and render a
    // confident lie on the approval sheet.
    const asIfCall = decodeCalldata(BYTECODE);
    expect(asIfCall?.signature).toBeNull();
  });

  it("reads gasLimit as an alias for gas", () => {
    // The dapp's "Send ETH to Multisig Address" sends a raw
    // `eth_sendTransaction` with `gasLimit: '0x5208'`. Reading only
    // `gas` dropped it, and we then signed a transaction with a
    // different gas limit than the request specified.
    const r = normalizeTx(
      {
        from: FROM,
        to: TOKEN,
        value: "0x16345785D8A0",
        gasLimit: "0x5208",
        maxFeePerGas: "0x2540be400",
        maxPriorityFeePerGas: "0x3b9aca00",
      },
      1,
      FROM,
    );
    expect("payload" in r).toBe(true);
    if (!("payload" in r)) throw new Error("narrow");
    expect(r.payload.gas).toBe(21000n);
    expect(r.payload.value).toBe(24414062500000n);
    expect(r.payload.type).toBe(2);
  });

  it("prefers gas over gasLimit when a request carries both", () => {
    const r = normalizeTx(
      { from: FROM, to: TOKEN, gas: "0x2", gasLimit: "0x1" },
      1,
      FROM,
    );
    if (!("payload" in r)) throw new Error("narrow");
    expect(r.payload.gas).toBe(2n);
  });

  it("keeps the phase-M rules on a deployment payload", () => {
    // Odd-length init-code is still a rejection: "it is a deploy" is not
    // a reason to stop checking the encoding.
    expect(
      "error" in normalizeTx({ from: FROM, data: `${BYTECODE}a` }, 1, FROM),
    ).toBe(true);
  });
});

describe("EIP-5792 error codes", () => {
  const FROM = "0x5555555555555555555555555555555555555555" as const;

  function sendCalls(raw: Record<string, unknown>) {
    return normalizeSendCalls(
      { version: "2.0.0", from: FROM, ...raw },
      1,
      FROM,
    );
  }

  it("reports an unsupported chain as 5710, not 4901", () => {
    // The dApp's recovery is "switch chain and retry". A generic "chain
    // not connected" reads as a connection fault it cannot act on.
    const r = sendCalls({ chainId: "0x89", calls: [] });
    expect("error" in r).toBe(true);
    if (!("error" in r)) throw new Error("narrow");
    expect(r.error.code).toBe(5710);
  });

  it("carries per-call capabilities through so a requirement is visible", () => {
    const r = sendCalls({
      chainId: "0x1",
      calls: [{ to: TOKEN, data: "0x", capabilities: { flowControl: {} } }],
    });
    if (!("payload" in r)) throw new Error("narrow");
    expect(r.payload.calls[0].capabilities).toEqual({ flowControl: {} });
  });

  it("flags a non-optional capability we do not implement", () => {
    // EIP-5792 is explicit: reject unless the capability is marked
    // optional. Ignoring one runs the batch under terms nobody agreed to.
    expect(firstUnsupportedCapability({ nonsenseCapability: {} })).toBe(
      "nonsenseCapability",
    );
    expect(
      firstUnsupportedCapability({ nonsenseCapability: { optional: true } }),
    ).toBeNull();
    // Absent `optional` means required, per the EIP's default.
    expect(firstUnsupportedCapability({ nonsenseCapability: {} })).toBe(
      "nonsenseCapability",
    );
  });

  it("finds a requirement declared on a single call, not just the batch", () => {
    expect(
      firstUnsupportedCapability(undefined, [
        undefined,
        { somethingWeLack: {} },
      ]),
    ).toBe("somethingWeLack");
  });

  it("accepts the capabilities it actually advertises", () => {
    // The enforced set and the advertised set come from one registry, so
    // they cannot drift into rejecting something we announce support for.
    for (const key of supportedCapabilityKeys()) {
      expect(firstUnsupportedCapability({ [key]: {} })).toBeNull();
    }
    expect(supportedCapabilityKeys()).toContain("atomic");
  });

  it("gives each EIP-5792 failure its own code", () => {
    // Verified against eips.ethereum.org/EIPS/eip-5792 directly.
    expect(PROVIDER_ERRORS.unsupportedCapability("x").code).toBe(5700);
    expect(PROVIDER_ERRORS.unsupportedChainId(1).code).toBe(5710);
    expect(PROVIDER_ERRORS.duplicateBundleId("x").code).toBe(5720);
    expect(PROVIDER_ERRORS.unknownBundleId("x").code).toBe(5730);
    expect(PROVIDER_ERRORS.bundleTooLarge().code).toBe(5740);
    expect(PROVIDER_ERRORS.atomicityNotSupported().code).toBe(5760);
  });
});

describe("EIP-747 wallet_watchAsset", () => {
  beforeEach(() => {
    __clearWatchedAssets();
  });

  it("actually records the token instead of claiming it did", () => {
    // The whole point. `execWatchAsset` used to return a hardcoded
    // `true` after calling a hook nothing wired, so the dApp was told
    // the token was added and the user went looking for it.
    const ok = addWatchedAsset(
      {
        standard: "ERC20",
        address: TOKEN as `0x${string}`,
        symbol: "USDC",
        decimals: 6,
        chainId: 1,
      },
      "https://dapp.test",
    );
    expect(ok).toBe(true);
    expect(isWatchedAsset(1, TOKEN)).toBe(true);
    const [asset] = listWatchedAssets(1);
    expect(asset.symbol).toBe("USDC");
    expect(asset.decimals).toBe(6);
    expect(asset.addedBy).toBe("https://dapp.test");
  });

  it("scopes identity to chain and address, not to the site's label", () => {
    addWatchedAsset(
      {
        standard: "ERC20",
        address: TOKEN as `0x${string}`,
        symbol: "USDC",
        decimals: 6,
        chainId: 1,
      },
      "https://one.test",
    );
    addWatchedAsset(
      {
        standard: "ERC20",
        address: TOKEN as `0x${string}`,
        symbol: "NOT-USDC",
        decimals: 18,
        chainId: 1,
      },
      "https://evil.test",
    );
    // One entry, relabelled — and crucially the ORIGINAL requester is
    // kept, because "who introduced this token" is the question that
    // matters when it turns out to be hostile.
    expect(listWatchedAssets(1)).toHaveLength(1);
    expect(listWatchedAssets(1)[0].symbol).toBe("NOT-USDC");
    expect(listWatchedAssets(1)[0].addedBy).toBe("https://one.test");
    // Same address on another chain is a different asset.
    addWatchedAsset(
      {
        standard: "ERC20",
        address: TOKEN as `0x${string}`,
        symbol: "USDC",
        decimals: 6,
        chainId: 137,
      },
      "https://one.test",
    );
    expect(listWatchedAssets()).toHaveLength(2);
    expect(listWatchedAssets(137)).toHaveLength(1);
  });

  it("keeps NFT and token fields apart", () => {
    addWatchedAsset(
      {
        standard: "ERC721",
        address: TOKEN as `0x${string}`,
        tokenId: "2516",
        symbol: "NFT",
        chainId: 1,
      },
      "https://dapp.test",
    );
    const [asset] = listWatchedAssets(1);
    expect(asset.tokenId).toBe("2516");
    // An NFT has no decimals; carrying one would let a site claim a
    // token-shaped balance for something that has none.
    expect(asset.decimals).toBeUndefined();
  });

  it("lets the user remove what a dApp added", () => {
    // EIP-747 has no un-watch, so removal is the user's alone.
    addWatchedAsset(
      {
        standard: "ERC20",
        address: TOKEN as `0x${string}`,
        symbol: "X",
        decimals: 18,
        chainId: 1,
      },
      "https://dapp.test",
    );
    expect(removeWatchedAsset(1, TOKEN)).toBe(true);
    expect(isWatchedAsset(1, TOKEN)).toBe(false);
    expect(removeWatchedAsset(1, TOKEN)).toBe(false);
  });
});

describe("deployment: what is actually being deployed", () => {
  // Selector lists are self-checking: an ERC-165 interface id IS the XOR
  // of its members' selectors, so if the lists below reproduce the
  // published ids, no selector in them is a typo.
  function xorSelectors(sels: string[]): string {
    let x = 0n;
    for (const s of sels) x ^= BigInt(`0x${s}`);
    return `0x${x.toString(16).padStart(8, "0")}`;
  }
  const ERC721 = [
    "70a08231",
    "6352211e",
    "b88d4fde",
    "42842e0e",
    "23b872dd",
    "095ea7b3",
    "a22cb465",
    "081812fc",
    "e985e9c5",
  ];
  const ERC1155 = [
    "f242432a",
    "2eb2c2d6",
    "00fdd58e",
    "4e1273f4",
    "a22cb465",
    "e985e9c5",
  ];
  const ERC20 = [
    "18160ddd",
    "70a08231",
    "a9059cbb",
    "23b872dd",
    "095ea7b3",
    "dd62ed3e",
  ];

  /** Synthesise init-code containing a selector table. */
  function code(sels: string[], extra = ""): `0x${string}` {
    return `0x60806040${sels.map((s) => `63${s}14`).join("")}${extra}${"00".repeat(64)}` as `0x${string}`;
  }

  it("the selector lists XOR to the published ERC-165 interface ids", () => {
    expect(xorSelectors(ERC721)).toBe("0x80ac58cd");
    expect(xorSelectors(ERC1155)).toBe("0xd9b67a26");
    // ERC-20 predates ERC-165 and has no published id, so selectors are
    // the only signal there.
    expect(xorSelectors(ERC20)).toBe("0x36372b07");
  });

  it("recognises an ERC-721 deployment from its dispatcher", () => {
    const g = guessDeployedContractKind(code(ERC721));
    expect(g.kind).toBe("erc721");
    expect(g.evidence).toContain("selectors");
    expect(describeDeployedContract(g)).toMatch(/NFT collection \(ERC-721\)/);
    expect(deployedContractLabel(g.kind)).toBe("NFT collection (ERC-721)");
  });

  it("recognises ERC-721 from the ERC-165 id alone", () => {
    const g = guessDeployedContractKind(
      `0x6080604052${"80ac58cd"}${"00".repeat(64)}`,
    );
    expect(g.kind).toBe("erc721");
    expect(g.evidence).toEqual(["interfaceId"]);
  });

  it("recognises ERC-1155 and prefers it over ERC-721", () => {
    // A contract carrying both mandatory sets is a multi-standard token;
    // the 1155 reading is the more specific one.
    const g = guessDeployedContractKind(code([...ERC1155, ...ERC721]));
    expect(g.kind).toBe("erc1155");
    expect(describeDeployedContract(g)).toMatch(/ERC-1155/);
  });

  it("recognises ERC-20 without mistaking an NFT for one", () => {
    expect(guessDeployedContractKind(code(ERC20)).kind).toBe("erc20");
    // ERC-721 shares balanceOf / approve / transferFrom with ERC-20 but
    // has no transfer() or allowance(), so it must not fall through.
    expect(guessDeployedContractKind(code(ERC721)).kind).toBe("erc721");
  });

  it("surfaces a mint entry point, which is the question users ask", () => {
    const g = guessDeployedContractKind(code([...ERC721, "1249c58b"]));
    expect(g.traits).toContain("mint");
    expect(describeDeployedContract(g)).toMatch(/mint new items/);
  });

  it("says nothing rather than guessing on unrecognised code", () => {
    const g = guessDeployedContractKind(`0x60806040${"ab".repeat(200)}`);
    expect(g.kind).toBe("unknown");
    expect(describeDeployedContract(g)).toBeNull();
    // The generic label is still the honest fallback.
    expect(deployedContractLabel(g.kind)).toBe("Contract deployment");
  });

  it("never throws on junk", () => {
    expect(guessDeployedContractKind(undefined).kind).toBe("unknown");
    expect(guessDeployedContractKind("0x").kind).toBe("unknown");
    expect(guessDeployedContractKind("not hex").kind).toBe("unknown");
  });

  it("only ever hedges, never claims verification", () => {
    // Byte matching proves the selectors are present, not that the code
    // behaves. Nothing stops a contract embedding an interface id while
    // doing something else, so the copy must stay a resemblance.
    for (const sels of [ERC721, ERC1155, ERC20]) {
      const copy = describeDeployedContract(
        guessDeployedContractKind(code(sels)),
      );
      expect(copy).toMatch(/^This looks like/);
      expect(copy).not.toMatch(/verified|confirmed|safe|trusted/i);
    }
  });
});
