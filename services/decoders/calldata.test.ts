/**
 * Unit tests for the local 4-byte calldata decoder.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types services/decoders/calldata.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData, parseAbiItem } from "viem";

import { decodeCalldata, decodeCalldataAgainst } from "./calldata.ts";

function encode(sig: string, args: readonly unknown[]): `0x${string}` {
  const abi = [parseAbiItem(sig)] as any[];
  return encodeFunctionData({ abi, args: args as any });
}

describe("decodeCalldata — known selectors", () => {
  it("decodes ERC-20 transfer(address,uint256)", () => {
    const data = encode("function transfer(address to, uint256 amount)", [
      "0x1234567890123456789012345678901234567890",
      1_000_000n,
    ]);
    const d = decodeCalldata(data);
    assert.ok(d);
    assert.equal(d.selector, "0xa9059cbb");
    assert.equal(d.functionName, "transfer");
    assert.equal(d.args?.length, 2);
    assert.equal(d.args?.[0]?.name, "to");
    assert.equal(
      d.args?.[0]?.value,
      "0x1234567890123456789012345678901234567890",
    );
    assert.equal(d.args?.[1]?.value, 1_000_000n);
  });

  it("decodes ERC-20 approve(address,uint256)", () => {
    const data = encode("function approve(address spender, uint256 amount)", [
      "0x1111111111111111111111111111111111111111",
      500n,
    ]);
    const d = decodeCalldata(data);
    assert.ok(d);
    assert.equal(d.functionName, "approve");
    assert.equal(d.args?.[0]?.name, "spender");
  });

  it("decodes ERC-20 transferFrom(address,address,uint256)", () => {
    const data = encode(
      "function transferFrom(address from, address to, uint256 amount)",
      [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
        1n,
      ],
    );
    const d = decodeCalldata(data);
    assert.ok(d);
    assert.equal(d.functionName, "transferFrom");
  });
});

describe("decodeCalldata — edge cases", () => {
  it("returns null for null/undefined input", () => {
    assert.equal(decodeCalldata(null), null);
    assert.equal(decodeCalldata(undefined), null);
  });

  it("handles empty data ('0x') as null", () => {
    assert.equal(decodeCalldata("0x"), null);
  });

  it("returns partial info for an unknown selector", () => {
    // Random 4-byte selector + arg bytes.
    const d = decodeCalldata(`0xdeadbeef${"00".repeat(64)}` as `0x${string}`);
    assert.ok(d);
    assert.equal(d.selector, "0xdeadbeef");
    assert.equal(d.signature, null);
    assert.equal(d.args, undefined);
  });

  it("truncated-selector data (< 10 chars) still returns selector-only shape", () => {
    const d = decodeCalldata("0xa9");
    assert.ok(d);
    assert.equal(d.signature, null);
  });

  it("falls back gracefully when decode throws (malformed args)", () => {
    // Valid selector but missing args payload. `decodeFunctionData` should
    // throw; we should catch and return selector-only.
    const d = decodeCalldata("0xa9059cbb" as `0x${string}`);
    assert.ok(d);
    assert.equal(d.selector, "0xa9059cbb");
    // signature may be null (decode failed) or populated (viem tolerates
    // some shortness). Either way — must not throw.
  });
});

describe("decodeCalldata — TWV-2026-009 risk classification", () => {
  const OPERATOR = "0x1234567890123456789012345678901234567890" as const;
  const SPENDER = "0xabcdef0123456789abcdef0123456789abcdef01" as const;
  const UINT256_MAX = (1n << 256n) - 1n;

  it("flags setApprovalForAll(operator, true) as a distinct risk variant", () => {
    const data = encode(
      "function setApprovalForAll(address operator, bool approved)",
      [OPERATOR, true],
    );
    const d = decodeCalldata(data);
    assert.ok(d);
    assert.equal(d.risk?.kind, "setApprovalForAll");
    if (d.risk?.kind === "setApprovalForAll") {
      assert.equal(d.risk.operator.toLowerCase(), OPERATOR);
      assert.equal(d.risk.approved, true);
    }
  });

  it("flags setApprovalForAll(operator, false) as a distinct revoke variant", () => {
    const data = encode(
      "function setApprovalForAll(address operator, bool approved)",
      [OPERATOR, false],
    );
    const d = decodeCalldata(data);
    assert.ok(d);
    assert.equal(d.risk?.kind, "setApprovalForAll");
    if (d.risk?.kind === "setApprovalForAll") {
      assert.equal(d.risk.approved, false);
    }
  });

  it("flags approve(spender, uint256.max) as unlimited", () => {
    const data = encode("function approve(address spender, uint256 amount)", [
      SPENDER,
      UINT256_MAX,
    ]);
    const d = decodeCalldata(data);
    assert.ok(d);
    assert.equal(d.risk?.kind, "approve");
    if (d.risk?.kind === "approve") {
      assert.equal(d.risk.isUnlimited, true);
      assert.equal(d.risk.spender.toLowerCase(), SPENDER);
    }
  });

  it("flags approve(spender, half-of-max) as unlimited (>= threshold)", () => {
    const half = UINT256_MAX / 2n;
    const data = encode("function approve(address spender, uint256 amount)", [
      SPENDER,
      half,
    ]);
    const d = decodeCalldata(data);
    assert.ok(d);
    if (d.risk?.kind === "approve") {
      assert.equal(d.risk.isUnlimited, true);
    } else {
      assert.fail("expected approve risk");
    }
  });

  it("does NOT flag approve(spender, small) as unlimited", () => {
    const data = encode("function approve(address spender, uint256 amount)", [
      SPENDER,
      1_000_000n,
    ]);
    const d = decodeCalldata(data);
    assert.ok(d);
    assert.equal(d.risk?.kind, "approve");
    if (d.risk?.kind === "approve") {
      assert.equal(d.risk.isUnlimited, false);
    }
  });

  it("does NOT attach risk metadata to plain transfer calldata", () => {
    const data = encode("function transfer(address to, uint256 amount)", [
      OPERATOR,
      1n,
    ]);
    const d = decodeCalldata(data);
    assert.ok(d);
    assert.equal(d.risk, undefined);
  });
});

describe("decodeCalldata — task 65 Phase A roundtrip fidelity gate", () => {
  const RECIPIENT = "0x1234567890123456789012345678901234567890" as const;

  it("marks a clean single-candidate decode as roundtripVerified", () => {
    const data = encode("function transfer(address to, uint256 amount)", [
      RECIPIENT,
      1_000_000n,
    ]);
    const d = decodeCalldata(data);
    assert.ok(d);
    assert.equal(d.roundtripVerified, true);
    assert.equal(d.ambiguous, false);
  });

  // Real 4-byte collision: keccak("transfer(address,uint256)")[:4] ===
  // keccak("many_msg_babbage(bytes1)")[:4] === 0xa9059cbb. The decoy
  // decodes transfer calldata without throwing (bytes1 reads the first,
  // zero, byte of the padded address word) but its re-encoding is one
  // word, not two — so it cannot round-trip.
  const trueSig = "function transfer(address to, uint256 amount)";
  const decoySig = "function many_msg_babbage(bytes1 data)";

  it("selector collision: only the round-tripping candidate is trusted", () => {
    // The decoy is listed FIRST to prove ordering no longer wins.
    const data = encode(trueSig, [RECIPIENT, 1_000_000n]);
    const d = decodeCalldataAgainst(data, [decoySig, trueSig]);
    assert.ok(d);
    assert.equal(d.functionName, "transfer");
    assert.equal(d.signature, trueSig);
    assert.equal(d.roundtripVerified, true);
    // The roundtrip resolved the collision — not ambiguous.
    assert.equal(d.ambiguous, false);
  });

  it("no candidate round-trips → unresolved + ambiguous, never a silent first guess", () => {
    // Only the decoy is offered. It decodes fine but re-encodes to
    // different bytes — must NOT be returned as a trusted decode.
    const data = encode(trueSig, [RECIPIENT, 1_000_000n]);
    const d = decodeCalldataAgainst(data, [decoySig]);
    assert.ok(d);
    assert.equal(d.signature, null);
    assert.equal(d.functionName, undefined);
    assert.equal(d.ambiguous, true);
    assert.equal(d.roundtripVerified, undefined);
  });

  it("hex case never breaks the byte-equality check", () => {
    const data = encode("function transfer(address to, uint256 amount)", [
      RECIPIENT,
      42n,
    ]);
    const upper = `0x${data.slice(2).toUpperCase()}` as `0x${string}`;
    const d = decodeCalldata(upper);
    assert.ok(d);
    assert.equal(d.roundtripVerified, true);
  });
});
