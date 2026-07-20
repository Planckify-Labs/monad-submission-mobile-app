/**
 * Unit tests for task 65 (TWV-2026-066) Phase E — agent-executor
 * clear-signing coverage: `submitTx.ts#buildClearSigningPreview` runs
 * the same Phase B descriptor + ERC-8213 digest pipeline over an
 * agent-constructed call that a dApp-initiated one gets.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types --import ./services/walletKit/evm/_test-resolver.mjs services/agent-executors/defi/clearSigningPreview.test.ts
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { encodeFunctionData, parseAbiItem } from "viem";

import { resolveEvmClearSigningDescriptor } from "../../walletKit/evm/clearSigning.ts";
import { walletKitRegistry } from "../../walletKit/registry.ts";
import type { WalletKitAdapter } from "../../walletKit/types.ts";
import { buildClearSigningPreview } from "./submitTx.ts";

const RECIPIENT = "0x1234567890123456789012345678901234567890" as const;

describe("buildClearSigningPreview", () => {
  afterEach(() => {
    walletKitRegistry.clear();
  });

  it("resolves the descriptor and the clearsig-matching calldata digest", async () => {
    walletKitRegistry.register({
      namespace: "eip155",
      resolveClearSigningDescriptor: resolveEvmClearSigningDescriptor,
    } as unknown as WalletKitAdapter);

    const data = encodeFunctionData({
      abi: [parseAbiItem("function transfer(address to, uint256 amount)")],
      args: [RECIPIENT, 1_000_000n],
    });
    const preview = await buildClearSigningPreview(
      { to: RECIPIENT, data },
      8453,
    );
    assert.equal(preview.descriptor?.intent, "Transfer");
    assert.equal(preview.descriptor?.source, "erc7730");
    // clearsig calldata-digest for the same bytes (2026-07-20):
    assert.equal(
      preview.calldataDigest,
      "0xf056db9322308a73735c1232c2ab11aaa6b0b10290407e37ac70f9af2b46e9f0",
    );
  });

  it("unknown calldata → null descriptor, digest still computed (orthogonal by rule)", async () => {
    const preview = await buildClearSigningPreview(
      { to: RECIPIENT, data: `0xdeadbeef${"00".repeat(64)}` as `0x${string}` },
      1,
    );
    assert.equal(preview.descriptor, null);
    assert.match(preview.calldataDigest, /^0x[0-9a-f]{64}$/);
  });
});
