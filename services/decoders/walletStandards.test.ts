/**
 * Regression coverage for `docs/wallet-standards-hardening-spec.md`.
 *
 * Every case here is a defect the spec was written to fix, phrased as
 * the behaviour that was wrong before. Where a phase's acceptance
 * criterion names a specific failure (a token id false-flagging as an
 * unlimited allowance, a decoder claiming another decoder's payload),
 * that failure is asserted against directly rather than only asserting
 * the happy path.
 */

import { describe, expect, it } from "vitest";
import { readMoveModuleName } from "@/services/chains/sui/moveBytecode";
import { KioskSemanticPass } from "@/services/chains/sui/semantics/kioskPass";
import { PackageSemanticPass } from "@/services/chains/sui/semantics/packagePass";
import { decodeCalldata } from "./calldata";
import { Erc4494TypedDataDecoder } from "./erc4494";
import { isKnownSpender } from "./knownSpenders";
import { SeaportTypedDataDecoder } from "./seaport";

const SPENDER = "0x1111111111111111111111111111111111111111";
const OFFERER = "0x2222222222222222222222222222222222222222";
const ATTACKER = "0x3333333333333333333333333333333333333333";

/** `approve(address,uint256)` calldata with an arbitrary second word. */
function approveCalldata(spender: string, value: bigint): `0x${string}` {
  const addr = spender.slice(2).toLowerCase().padStart(64, "0");
  const amount = value.toString(16).padStart(64, "0");
  return `0x095ea7b3${addr}${amount}` as `0x${string}`;
}

describe("phase D — ERC-721 approve disambiguation", () => {
  // The whole point of the phase: identical bytes, three different
  // readings depending on what the contract turns out to be.
  const MAX_UINT = (1n << 256n) - 1n;

  it("reads a confirmed ERC-20 target as an allowance", () => {
    const decoded = decodeCalldata(approveCalldata(SPENDER, MAX_UINT), {
      approveTargetKind: "erc20",
    });
    expect(decoded?.risk?.kind).toBe("approve");
    if (decoded?.risk?.kind !== "approve") throw new Error("narrow");
    expect(decoded.risk.isUnlimited).toBe(true);
  });

  it("reads a confirmed ERC-721 target as one token, never unlimited", () => {
    // A token id at or above 2^255 used to trip the unlimited-allowance
    // threshold, painting a routine NFT approval as a wallet drain.
    const tokenId = 1n << 255n;
    const decoded = decodeCalldata(approveCalldata(SPENDER, tokenId), {
      approveTargetKind: "erc721",
    });
    expect(decoded?.risk?.kind).toBe("approveNft");
    if (decoded?.risk?.kind !== "approveNft") throw new Error("narrow");
    expect(decoded.risk.tokenId).toBe(tokenId);
    expect(decoded.risk).not.toHaveProperty("isUnlimited");
  });

  it("stays indeterminate when the target could not be typed", () => {
    // Defaulting either way is a bug: ERC-20 gives wrong copy, ERC-721
    // suppresses a real unlimited-allowance warning.
    const decoded = decodeCalldata(approveCalldata(SPENDER, MAX_UINT));
    expect(decoded?.risk?.kind).toBe("approveUnknownAsset");
  });
});

describe("phase F — delegate.xyz risk classification", () => {
  it("flags delegateForAll, which contains no approve-shaped call", () => {
    // v1 `delegateForAll(address,bool)`.
    const data =
      `0x685ee3e8${ATTACKER.slice(2).padStart(64, "0")}${"1".padStart(64, "0")}` as `0x${string}`;
    const decoded = decodeCalldata(data);
    expect(decoded?.risk?.kind).toBe("delegate");
    if (decoded?.risk?.kind !== "delegate") throw new Error("narrow");
    expect(decoded.risk.scope).toBe("all");
    expect(decoded.risk.enabled).toBe(true);
    expect(decoded.risk.delegate.toLowerCase()).toBe(ATTACKER.toLowerCase());
  });

  it("distinguishes a revocation from a grant", () => {
    const data =
      `0x685ee3e8${ATTACKER.slice(2).padStart(64, "0")}${"0".padStart(64, "0")}` as `0x${string}`;
    const decoded = decodeCalldata(data);
    if (decoded?.risk?.kind !== "delegate") throw new Error("narrow");
    expect(decoded.risk.enabled).toBe(false);
  });
});

describe("phase F — Seaport order decoding", () => {
  function order(consideration: Array<Record<string, unknown>>) {
    return {
      domain: {
        name: "Seaport",
        version: "1.6",
        chainId: 1,
        verifyingContract: "0x0000000000000068F116a894984e2DB1123eB395",
      },
      primaryType: "OrderComponents",
      types: {},
      message: {
        offerer: OFFERER,
        offer: [
          {
            itemType: 2,
            token: "0x4444444444444444444444444444444444444444",
            identifierOrCriteria: "7",
            startAmount: "1",
            endAmount: "1",
          },
        ],
        consideration,
        startTime: "1700000000",
        endTime: "1700086400",
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it("flags an order whose consideration never returns to the signer", () => {
    // The drain shape: the NFT leaves, the payment goes elsewhere.
    const decoded = SeaportTypedDataDecoder.decode(
      order([
        {
          itemType: 0,
          token: "0x0000000000000000000000000000000000000000",
          startAmount: "1000000000000000000",
          recipient: ATTACKER,
        },
      ]),
    );
    expect(decoded).not.toBeNull();
    expect(decoded?.warnings?.[0]?.title).toBe("Nothing comes back to you");
  });

  it("flags a zero-payment order even when the signer is the recipient", () => {
    const decoded = SeaportTypedDataDecoder.decode(
      order([
        {
          itemType: 0,
          token: "0x0000000000000000000000000000000000000000",
          startAmount: "0",
          recipient: OFFERER,
        },
      ]),
    );
    expect(decoded?.warnings?.[0]?.title).toBe("You are being paid nothing");
  });

  it("does not flag a normal sale", () => {
    const decoded = SeaportTypedDataDecoder.decode(
      order([
        {
          itemType: 0,
          token: "0x0000000000000000000000000000000000000000",
          startAmount: "1000000000000000000",
          recipient: OFFERER,
        },
      ]),
    );
    expect(decoded?.warnings).toBeUndefined();
  });

  it("names the marketplace instead of showing a bare address", () => {
    const decoded = SeaportTypedDataDecoder.decode(
      order([
        {
          itemType: 0,
          startAmount: "1",
          recipient: OFFERER,
        },
      ]),
    );
    expect(decoded?.fields[0]).toEqual({
      label: "Marketplace",
      value: "Seaport 1.6",
    });
  });
});

describe("phase F — knownSpenders marketplace entries", () => {
  it("names the OpenSea conduit, the address setApprovalForAll targets", () => {
    // Before this, approving OpenSea looked identical to approving a
    // drainer: both rendered as bare hex.
    expect(
      isKnownSpender("0x1E0049783F008A0085193E00003D00cd54003c71", 1)?.name,
    ).toBe("OpenSea Conduit");
  });

  it("is case-insensitive", () => {
    expect(
      isKnownSpender("0x1e0049783f008a0085193e00003d00cd54003c71", 1)?.name,
    ).toBe("OpenSea Conduit");
  });

  it("does not name an unknown address", () => {
    expect(isKnownSpender(ATTACKER, 1)).toBeNull();
  });
});

describe("phase F — ERC-4494 vs ERC-2612 disjointness", () => {
  const base = {
    domain: { name: "Cool Cats", verifyingContract: SPENDER },
    primaryType: "Permit",
    message: {
      spender: SPENDER,
      tokenId: "42",
      nonce: "0",
      deadline: "1700000000",
    },
  };

  it("claims an ERC-4494 permit", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const decoded = Erc4494TypedDataDecoder.decode({
      ...base,
      types: {
        Permit: [
          { name: "spender" },
          { name: "tokenId" },
          { name: "nonce" },
          { name: "deadline" },
        ],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(decoded?.functionName).toBe("Permit (ERC-4494)");
    expect(decoded?.fields.find((f) => f.label === "Item")?.value).toBe("#42");
  });

  it("refuses an ERC-2612 permit, which carries `value`", () => {
    // Both use primaryType "Permit". If this decoder claimed an ERC-20
    // permit it would render an allowance as a token id.
    const decoded = Erc4494TypedDataDecoder.decode({
      ...base,
      types: {
        Permit: [
          { name: "owner" },
          { name: "spender" },
          { name: "value" },
          { name: "nonce" },
          { name: "deadline" },
        ],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(decoded).toBeNull();
  });
});

describe("phase B — Move module-name extraction", () => {
  it("returns null rather than a guess for non-Move bytes", () => {
    // A wrong module name on a publish sheet is worse than no name, so
    // every parse failure must be silent, not approximate.
    expect(readMoveModuleName(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull();
    expect(readMoveModuleName(new Uint8Array(0))).toBeNull();
    // Correct magic, truncated body.
    expect(
      readMoveModuleName(new Uint8Array([0xa1, 0x1c, 0xeb, 0x0b, 0, 0, 0, 6])),
    ).toBeNull();
  });
});

describe("phase C — Sui kiosk semantics", () => {
  const ITEM = "0xabc::cat::Cat";

  function purchasePtb(withConfirm: boolean) {
    return {
      inputs: [
        // 0: price, u64 = 1_000_000_000 MIST (1 SUI), little-endian.
        { kind: "pure" as const, bytes: "AMqaOwAAAAA=" },
      ],
      commands: [
        {
          kind: "SplitCoins" as const,
          sourceArgIndex: -1,
          amountCount: 1,
          amountArgs: [{ kind: "input" as const, index: 0 }],
        },
        {
          kind: "MoveCall" as const,
          package: "0x2",
          module: "kiosk",
          function: "purchase",
          argumentCount: 3,
          typeArgumentCount: 1,
          typeArguments: [ITEM],
          arguments: [
            { kind: "unknown" as const },
            { kind: "unknown" as const },
            { kind: "result" as const, command: 0 },
          ],
        },
        ...(withConfirm
          ? [
              {
                kind: "MoveCall" as const,
                package: "0x2",
                module: "transfer_policy",
                function: "confirm_request",
                argumentCount: 2,
                typeArgumentCount: 1,
              },
            ]
          : []),
      ],
    };
  }

  it("resolves item and price by following PTB data flow", () => {
    const rows = KioskSemanticPass.run(purchasePtb(true));
    const purchase = rows?.find((r) => r.code === "kiosk.purchase");
    expect(purchase?.fields).toContainEqual({ label: "Item", value: ITEM });
    expect(purchase?.fields).toContainEqual({ label: "Price", value: "1 SUI" });
  });

  it("normalises the fully-padded framework address", () => {
    const ptb = purchasePtb(true);
    ptb.commands[1].package =
      "0x0000000000000000000000000000000000000000000000000000000000000002";
    expect(KioskSemanticPass.run(ptb)?.length).toBeGreaterThan(0);
  });

  it("warns when a purchase has no matching confirm_request", () => {
    const rows = KioskSemanticPass.run(purchasePtb(false));
    expect(rows?.some((r) => r.code === "kiosk.unconfirmed-request")).toBe(
      true,
    );
  });

  it("ignores PTBs that are not kiosk business", () => {
    expect(
      KioskSemanticPass.run({
        inputs: [],
        commands: [
          {
            kind: "MoveCall",
            package: "0x9",
            module: "amm",
            function: "swap",
            argumentCount: 0,
            typeArgumentCount: 0,
          },
        ],
      }),
    ).toBeNull();
  });
});

describe("phase B — Sui package upgrade semantics", () => {
  it("names the package being replaced and the cap being spent", () => {
    // A count of modules does not convey that live code is being
    // replaced or that an UpgradeCap is being consumed.
    const rows = PackageSemanticPass.run({
      inputs: [{ kind: "object", objectId: "0xcap" }],
      commands: [
        {
          kind: "MoveCall",
          package: "0x2",
          module: "package",
          function: "authorize_upgrade",
          argumentCount: 3,
          typeArgumentCount: 0,
          arguments: [{ kind: "input", index: 0 }],
        },
        {
          kind: "Upgrade",
          modules: 2,
          dependencies: 1,
          packageId: "0xdeadbeef",
        },
      ],
    });
    const upgrade = rows?.find((r) => r.code === "package.upgrade");
    expect(upgrade?.severity).toBe("warn");
    expect(upgrade?.fields).toContainEqual({
      label: "Replaces package",
      value: "0xdeadbeef",
    });
    expect(upgrade?.fields).toContainEqual({
      label: "Upgrade authority",
      value: "0xcap",
    });
  });

  it("falls back to a count when module names did not parse", () => {
    const rows = PackageSemanticPass.run({
      inputs: [],
      commands: [{ kind: "Publish", modules: 3, dependencies: 0 }],
    });
    expect(rows?.[0]?.fields).toContainEqual({
      label: "Modules",
      value: "3",
    });
  });
});
