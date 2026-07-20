/**
 * Unit test for `EvmCalldataDecoderInspector` — task 65 (TWV-2026-066)
 * Phase A wiring. Asserts the inspector wraps the existing
 * `services/decoders/calldata.ts#decodeCalldata` (it patches that
 * decoder's output shape, roundtrip flag included — no reimplementation)
 * for both the `sendTransaction` and `sendCalls` intents.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types --import ./services/walletKit/evm/_test-resolver.mjs services/bridge/inspectors/EvmCalldataDecoderInspector.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData, parseAbiItem } from "viem";

import type {
  EvmBatchCallsPayload,
  EvmSendTxPayload,
} from "../../chains/evm/payloads.ts";
import type { DecodedCalldata } from "../../decoders/calldata.ts";
import type { ApprovalIntent } from "../approval.ts";
import { EvmCalldataDecoderInspector } from "./EvmCalldataDecoderInspector.ts";

const FROM = "0x1111111111111111111111111111111111111111" as const;
const TO = "0x2222222222222222222222222222222222222222" as const;

function transferData(): `0x${string}` {
  return encodeFunctionData({
    abi: [parseAbiItem("function transfer(address to, uint256 amount)")],
    args: [TO, 1_000_000n],
  });
}

function mkIntent<P>(
  kind: "sendTransaction" | "sendCalls",
  payload: P,
): ApprovalIntent<P> {
  return {
    id: "id",
    namespace: "eip155",
    kind,
    origin: { url: "https://example.dapp" },
    wallet: null,
    payload,
    annotations: [],
    createdAt: 0,
  };
}

describe("EvmCalldataDecoderInspector", () => {
  it("patches decoded (roundtrip-verified) onto a sendTransaction payload", async () => {
    const payload: EvmSendTxPayload = {
      type: 2,
      to: TO,
      from: FROM,
      data: transferData(),
      chainId: 8453,
    };
    const res = await EvmCalldataDecoderInspector.inspect(
      mkIntent("sendTransaction", payload),
      [],
      new AbortController().signal,
    );
    assert.equal(res.verdict, "allow");
    const decoded = (res.patch as { decoded?: DecodedCalldata }).decoded;
    assert.ok(decoded);
    assert.equal(decoded.functionName, "transfer");
    assert.equal(decoded.roundtripVerified, true);
    assert.equal(decoded.selector, "0xa9059cbb");
  });

  it("no patch when the tx carries no calldata", async () => {
    const payload: EvmSendTxPayload = {
      type: 2,
      to: TO,
      from: FROM,
      chainId: 8453,
    };
    const res = await EvmCalldataDecoderInspector.inspect(
      mkIntent("sendTransaction", payload),
      [],
      new AbortController().signal,
    );
    assert.equal(res.patch, undefined);
  });

  it("patches index-aligned decodedCalls onto a sendCalls payload", async () => {
    const payload: EvmBatchCallsPayload = {
      version: "1.0",
      chainId: 8453,
      from: FROM,
      calls: [
        { to: TO, data: transferData() },
        { to: TO }, // bare value transfer — stays null
      ],
    };
    const res = await EvmCalldataDecoderInspector.inspect(
      mkIntent("sendCalls", payload),
      [],
      new AbortController().signal,
    );
    const decodedCalls = (
      res.patch as { decodedCalls?: Array<DecodedCalldata | null> }
    ).decodedCalls;
    assert.ok(decodedCalls);
    assert.equal(decodedCalls.length, 2);
    assert.equal(decodedCalls[0]?.functionName, "transfer");
    assert.equal(decodedCalls[1], null);
  });

  it("ignores non-transaction intents", async () => {
    const res = await EvmCalldataDecoderInspector.inspect(
      mkIntent("sendTransaction", {
        type: 2,
        to: TO,
        from: FROM,
        chainId: 1,
      }) as unknown as ApprovalIntent,
      [],
      new AbortController().signal,
    );
    assert.equal(res.verdict, "allow");
  });
});
