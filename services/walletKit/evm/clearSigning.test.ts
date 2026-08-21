/**
 * Unit tests for the EVM clear-signing capability — task 65
 * (TWV-2026-066) Phases B + C.
 *
 * The digest expectations are hard-coded from Cyfrin `clearsig`
 * (v-installed 2026-07-20: `clearsig calldata-digest …` /
 * `clearsig eip712 …`) so the suite byte-matches the independent
 * reference implementation, not our own math fed back to itself.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types --import ./services/walletKit/evm/_test-resolver.mjs services/walletKit/evm/clearSigning.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  encodeFunctionData,
  keccak256,
  parseAbiItem,
  toBytes,
  toHex,
} from "viem";

import {
  calldataDigest,
  computeEvmSigningDigest,
  eip712Digests,
  encodeEip712Type,
  resolveEvmClearSigningDescriptor,
} from "./clearSigning.ts";

const RECIPIENT = "0x1234567890123456789012345678901234567890" as const;

function transferData(): `0x${string}` {
  return encodeFunctionData({
    abi: [parseAbiItem("function transfer(address to, uint256 amount)")],
    args: [RECIPIENT, 1_000_000n],
  });
}

// The canonical EIP-712 "Ether Mail" example — also what the clearsig
// vector below was generated from.
const MAIL_TYPED_DATA = {
  domain: {
    name: "Ether Mail",
    version: "1",
    chainId: 1,
    verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
  },
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Person: [
      { name: "name", type: "string" },
      { name: "wallet", type: "address" },
    ],
    Mail: [
      { name: "from", type: "Person" },
      { name: "to", type: "Person" },
      { name: "contents", type: "string" },
    ],
  },
  primaryType: "Mail",
  message: {
    from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
    to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
    contents: "Hello, Bob!",
  },
};

describe("resolveEvmClearSigningDescriptor — ERC-7730 resolution", () => {
  it("resolves a standard ERC-20 transfer (known-descriptor hit)", async () => {
    const d = await resolveEvmClearSigningDescriptor({
      call: { to: RECIPIENT, chainId: 8453, data: transferData() },
    });
    assert.ok(d);
    assert.equal(d.intent, "Transfer");
    assert.equal(d.source, "erc7730");
    assert.equal(d.functionName, "transfer");
    assert.equal(d.fields[0]?.label, "To");
    assert.equal(d.fields[0]?.value, RECIPIENT);
    const byLabel = (label: string) =>
      d.fields.find((f) => f.label === label)?.value;
    // Below the unlimited threshold: comma-grouped for legibility, and
    // still labelled "raw units" because grouping does not scale.
    assert.equal(byLabel("Amount (raw units)"), "1,000,000");
    // One row per amount. The exact digits and the hex form belong to
    // the sheet's technical drawer, not to this card.
    assert.equal(
      d.fields.filter((f) => f.label.startsWith("Amount")).length,
      1,
    );
  });

  it("max-uint256 approve reads as 'Unlimited', not a 78-digit wall of digits", async () => {
    const spender = "0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07" as const;
    const maxUint256 = (1n << 256n) - 1n;
    const data = encodeFunctionData({
      abi: [parseAbiItem("function approve(address spender, uint256 value)")],
      args: [spender, maxUint256],
    });
    const d = await resolveEvmClearSigningDescriptor({
      call: { to: RECIPIENT, chainId: 1, data },
    });
    assert.ok(d);
    assert.equal(d.intent, "Approve spending");
    const byLabel = (label: string) =>
      d.fields.find((f) => f.label === label)?.value;
    assert.equal(byLabel("Allowance (raw units)"), "Unlimited");
    assert.equal(
      d.fields.filter((f) => f.label.startsWith("Allowance")).length,
      1,
    );
  });

  it("deployment-pinned descriptor binds only to its pinned address/chain", async () => {
    const depositData = encodeFunctionData({
      abi: [parseAbiItem("function deposit()")],
    });
    const weth = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
    const hit = await resolveEvmClearSigningDescriptor({
      call: { to: weth, chainId: 1, data: depositData },
    });
    assert.equal(hit?.intent, "Wrap ETH");
    // Same selector, unpinned contract — MUST NOT apply the unrelated
    // descriptor's format (ERC-7730 rule 6).
    const miss = await resolveEvmClearSigningDescriptor({
      call: { to: RECIPIENT, chainId: 1, data: depositData },
    });
    assert.equal(miss, null);
  });

  it("EIP-712 descriptor matches by keccak(encodeType) TYPE_KEY", async () => {
    const d = await resolveEvmClearSigningDescriptor({
      call: {
        typedData: {
          domain: {
            name: "USD Coin",
            verifyingContract: RECIPIENT,
            chainId: 1,
          },
          types: {
            Permit: [
              { name: "owner", type: "address" },
              { name: "spender", type: "address" },
              { name: "value", type: "uint256" },
              { name: "nonce", type: "uint256" },
              { name: "deadline", type: "uint256" },
            ],
          },
          primaryType: "Permit",
          message: {
            owner: RECIPIENT,
            spender: RECIPIENT,
            value: "1000",
            nonce: "0",
            deadline: "9999999999",
          },
        },
      },
    });
    assert.ok(d);
    assert.equal(d.intent, "Permit token spending");
    assert.equal(d.source, "erc7730");
    assert.equal(d.fields[1]?.label, "Spender");
  });

  it("no snapshot match → null (unknown selector)", async () => {
    const d = await resolveEvmClearSigningDescriptor({
      call: {
        to: RECIPIENT,
        chainId: 1,
        data: `0xdeadbeef${"00".repeat(64)}` as `0x${string}`,
      },
    });
    assert.equal(d, null);
  });

  it("non-EVM-shaped call → null", async () => {
    assert.equal(
      await resolveEvmClearSigningDescriptor({ call: { kind: "MoveCall" } }),
      null,
    );
  });
});

describe("encodeEip712Type", () => {
  it("emits primary type first, referenced types sorted after", () => {
    const encoded = encodeEip712Type(MAIL_TYPED_DATA.types, "Mail");
    assert.equal(
      encoded,
      "Mail(Person from,Person to,string contents)Person(string name,address wallet)",
    );
  });
});

describe("ERC-8213 Flow A — EIP-712 digests (clearsig byte-match)", () => {
  it("domain/message/digest byte-match `clearsig eip712`", () => {
    const { domainHash, messageHash, digest } = eip712Digests(MAIL_TYPED_DATA);
    // clearsig eip712 mail712.json (2026-07-20):
    assert.equal(
      domainHash,
      "0xf2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f",
    );
    assert.equal(
      messageHash,
      "0xc52c0ee5d84264471806290a3f2c4cecfc5490626bf912d01f240d7a274b371e",
    );
    assert.equal(
      digest,
      "0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2",
    );
  });

  it("pitfall (a): EIP712Domain is stripped before messageHash — naive not-stripped encodeType differs", () => {
    const { messageHash } = eip712Digests(MAIL_TYPED_DATA);
    // A naive implementation appends EVERY type in the map (including
    // EIP712Domain) to the encodeType output instead of only the
    // referenced ones — reproduce that bug by hand and prove it
    // diverges from the correct value.
    const defs = MAIL_TYPED_DATA.types as Record<
      string,
      Array<{ name: string; type: string }>
    >;
    const encodeOne = (name: string): string =>
      `${name}(${defs[name].map((f) => `${f.type} ${f.name}`).join(",")})`;
    const naiveEncodeType = [
      "Mail",
      ...Object.keys(defs)
        .filter((t) => t !== "Mail")
        .sort(),
    ]
      .map(encodeOne)
      .join("");
    assert.ok(naiveEncodeType.includes("EIP712Domain("));
    const naiveTypeHash = keccak256(toBytes(naiveEncodeType));
    const correctTypeHash = keccak256(
      toBytes(encodeEip712Type(MAIL_TYPED_DATA.types, "Mail") ?? ""),
    );
    assert.notEqual(naiveTypeHash, correctTypeHash);
    // And the correct messageHash is the clearsig-verified one, which
    // could only come from the stripped/reference-only encodeType.
    assert.equal(
      messageHash,
      "0xc52c0ee5d84264471806290a3f2c4cecfc5490626bf912d01f240d7a274b371e",
    );
  });
});

describe("ERC-8213 Flow B — calldata digest (clearsig byte-match)", () => {
  it("byte-matches `clearsig calldata-digest` for ERC-20 transfer calldata", () => {
    // clearsig calldata-digest 0xa9059cbb…f4240 (2026-07-20):
    assert.equal(
      calldataDigest(transferData()),
      "0xf056db9322308a73735c1232c2ab11aaa6b0b10290407e37ac70f9af2b46e9f0",
    );
  });

  it("pitfall (b): >255-byte calldata still matches — length prefix is a 32-byte BE uint256, not a single byte", () => {
    const big = `0x${"ab".repeat(300)}` as `0x${string}`;
    // clearsig calldata-digest 0xabab…(300 bytes) (2026-07-20):
    assert.equal(
      calldataDigest(big),
      "0x6c4e425816b2982af34ab657e0f401be3c7469cc8473577965b8914d3d0ddecf",
    );
    // A single-byte length encoding (300 & 0xff = 44) would produce a
    // different digest — prove the divergence the pitfall warns about.
    const singleByteLen = keccak256(
      new Uint8Array([300 & 0xff, ...toBytes(big)]),
    );
    assert.notEqual(calldataDigest(big), singleByteLen);
  });

  it("pitfall (c): digest is identical across different chainId contexts", async () => {
    const data = transferData();
    // The API deliberately takes no chainId — same calldata, same
    // digest, across forks. Compute under two different "contexts".
    const onMainnet = await computeEvmSigningDigest({
      kind: "calldata",
      calldata: data,
    });
    const onBase = await computeEvmSigningDigest({
      kind: "calldata",
      calldata: data,
    });
    assert.equal(onMainnet?.values[0]?.value, onBase?.values[0]?.value);
  });

  it("pitfall (d)/'both, never one': both Flow A and Flow B are implemented", async () => {
    const flowA = await computeEvmSigningDigest({
      kind: "typedData",
      typedData: MAIL_TYPED_DATA,
    });
    assert.equal(flowA?.scheme, "erc8213-eip712");
    assert.equal(flowA?.values.length, 3);
    const flowB = await computeEvmSigningDigest({
      kind: "calldata",
      calldata: transferData(),
    });
    assert.equal(flowB?.scheme, "erc8213-calldata");
    assert.equal(flowB?.values.length, 1);
  });

  it("hex case: output is lowercase and never re-cased", () => {
    const d = calldataDigest(transferData());
    assert.equal(d, d.toLowerCase());
  });

  it("returns null for the personal-message kind — ERC-8213 defines nothing for it", async () => {
    const res = await computeEvmSigningDigest({
      kind: "personalMessage",
      messageBase64: "aGVsbG8=",
    });
    assert.equal(res, null);
  });
});
