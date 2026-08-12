/**
 * Tier-1 decoders for programs beyond the core System/SPL set.
 *
 * Covers tasks 26 (Stake), 27 (ATA + hijack detection), 28 (ALT),
 * 29 (Metaplex). Each decoder registers against `programDecoder.ts`
 * at module-load time so the inspector picks them up automatically.
 */

import type { SolanaDecodedInstruction } from "./payloads";
import { registerProgramDecoder } from "./programDecoder";

const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const ALT_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
const METAPLEX_METADATA = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const METAPLEX_CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
const BUBBLEGUM = "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY";

function u8(d: Uint8Array, o: number): number {
  return d[o] ?? 0;
}

// ---- Stake (Task 26) ----
registerProgramDecoder({
  programId: STAKE_PROGRAM,
  programName: "Stake",
  decode(ins) {
    if (typeof ins.data === "string" || ins.data.length < 4) return null;
    const tag =
      (ins.data[0] ?? 0) |
      ((ins.data[1] ?? 0) << 8) |
      ((ins.data[2] ?? 0) << 16) |
      ((ins.data[3] ?? 0) << 24);
    const kinds: Record<number, string> = {
      0: "Initialize",
      1: "Authorize",
      2: "DelegateStake",
      3: "Split",
      4: "Withdraw",
      5: "Deactivate",
      7: "Merge",
    };
    const kind = kinds[tag];
    if (!kind) return null;
    return {
      program: STAKE_PROGRAM,
      kind,
      programName: "stake",
    } as SolanaDecodedInstruction;
  },
});

// ---- Associated Token Account (Task 27) ----
registerProgramDecoder({
  programId: ATA_PROGRAM,
  programName: "AssociatedTokenAccount",
  decode(ins) {
    if (typeof ins.data === "string") return null;
    const tag = u8(ins.data, 0);
    if (tag === 0 || ins.data.length === 0) {
      return {
        program: ATA_PROGRAM,
        kind: "Create",
        programName: "ata",
      } as SolanaDecodedInstruction;
    }
    if (tag === 1) {
      return {
        program: ATA_PROGRAM,
        kind: "CreateIdempotent",
        programName: "ata",
      } as SolanaDecodedInstruction;
    }
    if (tag === 2) {
      // RecoverNested — the hijack case per §10.4 inv 7. Decoder marks
      // it for the inspector to surface as `warn`.
      return {
        program: ATA_PROGRAM,
        kind: "RecoverNested",
        programName: "ata",
      } as SolanaDecodedInstruction;
    }
    return null;
  },
});

// ---- Address Lookup Table (Task 28) ----
registerProgramDecoder({
  programId: ALT_PROGRAM,
  programName: "AddressLookupTable",
  decode(ins) {
    if (typeof ins.data === "string" || ins.data.length < 4) return null;
    const tag =
      (ins.data[0] ?? 0) |
      ((ins.data[1] ?? 0) << 8) |
      ((ins.data[2] ?? 0) << 16) |
      ((ins.data[3] ?? 0) << 24);
    const kinds: Record<number, string> = {
      0: "CreateLookupTable",
      1: "FreezeLookupTable",
      2: "ExtendLookupTable",
      3: "DeactivateLookupTable",
      4: "CloseLookupTable",
    };
    const kind = kinds[tag];
    if (!kind) return null;
    return {
      program: ALT_PROGRAM,
      kind,
      programName: "alt",
    } as SolanaDecodedInstruction;
  },
});

// ---- BPF Loader Upgradeable (spec phase B §2.5) ----
//
// Full deploy-from-browser is not a goal: Loader-v3 chunks a program
// across hundreds of `Write` transactions, which is not a sane approval
// flow and no dApp drives it that way. The value here is that when one
// of these instructions *does* appear it is named rather than blind
// signed — `Upgrade` replaces live program code and `SetAuthority`
// moves the right to do so, which are the two most consequential
// instructions on the chain.
const LOADER_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";

registerProgramDecoder({
  programId: LOADER_UPGRADEABLE,
  programName: "BPFLoaderUpgradeable",
  decode(ins) {
    if (typeof ins.data === "string" || ins.data.length < 4) return null;
    const tag =
      (ins.data[0] ?? 0) |
      ((ins.data[1] ?? 0) << 8) |
      ((ins.data[2] ?? 0) << 16) |
      ((ins.data[3] ?? 0) << 24);

    const base = {
      program: LOADER_UPGRADEABLE,
      programName: "loader",
    };

    switch (tag) {
      case 0:
        return {
          ...base,
          kind: "InitializeBuffer",
        } as SolanaDecodedInstruction;
      case 1:
        return { ...base, kind: "Write" } as SolanaDecodedInstruction;
      case 2:
        return {
          ...base,
          kind: "DeployWithMaxDataLen",
        } as SolanaDecodedInstruction;
      case 3:
        // Accounts: [programData, program, buffer, spill, rent, clock, authority]
        return {
          ...base,
          kind: "Upgrade",
          fields: ins.accounts[1]
            ? [{ label: "Program", value: ins.accounts[1] }]
            : undefined,
          risk: {
            severity: "warn",
            title: "Replaces live program code",
            detail:
              "This replaces the code of a program that is already deployed. Everyone using that program will run the new code.",
          },
        } as SolanaDecodedInstruction;
      case 4:
      case 7:
        // Accounts: [programData or buffer, current authority, new authority]
        return {
          ...base,
          kind: tag === 4 ? "SetAuthority" : "SetAuthorityChecked",
          fields: ins.accounts[2]
            ? [{ label: "New authority", value: ins.accounts[2] }]
            : undefined,
          risk: {
            severity: "warn",
            title: "Transfers upgrade authority",
            detail:
              "This hands someone else the right to replace this program's code in the future.",
          },
        } as SolanaDecodedInstruction;
      case 5:
        return { ...base, kind: "Close" } as SolanaDecodedInstruction;
      case 6:
        return { ...base, kind: "ExtendProgram" } as SolanaDecodedInstruction;
      default:
        return null;
    }
  },
});

// ---- Metaplex Token Metadata + Core + Bubblegum (Task 29; spec phase G) ----
//
// Discriminators below were read from each program's source rather than
// recalled — see the enum ordinals in mpl-core's `MplAssetInstruction`,
// mpl-token-metadata's `MetadataInstruction`, and Anchor's
// `sha256("global:<name>")[..8]` for Bubblegum. Mislabelling a burn as a
// transfer on a signing sheet is worse than not decoding at all, so
// anything outside these tables keeps the old presence row.

const AUTHORITY_RISK = {
  severity: "warn",
  title: "Grants control of this asset",
  detail:
    "This gives another account standing authority over the asset, which lets it act without asking you again. Revoke once the site is done.",
} as const;

const BURN_RISK = {
  severity: "warn",
  title: "Destroys this asset",
  detail: "This permanently destroys the asset. It cannot be undone.",
} as const;

/** mpl-core: single-byte discriminator, ordinal of `MplAssetInstruction`. */
const CORE_INSTRUCTIONS: Record<
  number,
  { kind: string; risk?: typeof AUTHORITY_RISK | typeof BURN_RISK }
> = {
  2: { kind: "AddPlugin" },
  4: { kind: "RemovePlugin" },
  6: { kind: "UpdatePlugin" },
  // Core enforces freeze and transfer delegation through plugins, so
  // approving a plugin authority is this chain's structural equivalent
  // of `setApprovalForAll` and carries the same weight.
  8: { kind: "ApprovePluginAuthority", risk: AUTHORITY_RISK },
  9: { kind: "ApproveCollectionPluginAuthority", risk: AUTHORITY_RISK },
  10: { kind: "RevokePluginAuthority" },
  12: { kind: "BurnV1", risk: BURN_RISK },
  13: { kind: "BurnCollectionV1", risk: BURN_RISK },
  14: { kind: "TransferV1" },
  15: { kind: "UpdateV1" },
  22: { kind: "AddExternalPluginAdapter", risk: AUTHORITY_RISK },
  30: { kind: "UpdateV2" },
};

/** mpl-token-metadata: single-byte discriminator. */
const TOKEN_METADATA_INSTRUCTIONS: Record<
  number,
  { kind: string; risk?: typeof AUTHORITY_RISK | typeof BURN_RISK }
> = {
  20: { kind: "ApproveUseAuthority", risk: AUTHORITY_RISK },
  23: { kind: "ApproveCollectionAuthority", risk: AUTHORITY_RISK },
  29: { kind: "BurnNft", risk: BURN_RISK },
  41: { kind: "Burn", risk: BURN_RISK },
  44: { kind: "Delegate", risk: AUTHORITY_RISK },
  45: { kind: "Revoke" },
  46: { kind: "Lock" },
  47: { kind: "Unlock" },
  49: { kind: "Transfer" },
  50: { kind: "Update" },
};

/** mpl-bubblegum: Anchor 8-byte `sha256("global:<snake_name>")[..8]`. */
const BUBBLEGUM_INSTRUCTIONS: Array<{
  disc: number[];
  kind: string;
  risk?: typeof AUTHORITY_RISK | typeof BURN_RISK;
}> = [
  { disc: [0xa3, 0x34, 0xc8, 0xe7, 0x8c, 0x03, 0x45, 0xba], kind: "Transfer" },
  {
    disc: [0x77, 0x28, 0x06, 0xeb, 0xea, 0xdd, 0xf8, 0x31],
    kind: "TransferV2",
  },
  {
    disc: [0x74, 0x6e, 0x1d, 0x38, 0x6b, 0xdb, 0x2a, 0x5d],
    kind: "Burn",
    risk: BURN_RISK,
  },
  {
    disc: [0x73, 0xd2, 0x22, 0xf0, 0xe8, 0x8f, 0xb7, 0x10],
    kind: "BurnV2",
    risk: BURN_RISK,
  },
  {
    disc: [0x5a, 0x93, 0x4b, 0xb2, 0x55, 0x58, 0x04, 0x89],
    kind: "Delegate",
    risk: AUTHORITY_RISK,
  },
  {
    disc: [0x5f, 0x57, 0x7d, 0x8c, 0xb5, 0x83, 0x80, 0xe3],
    kind: "DelegateV2",
    risk: AUTHORITY_RISK,
  },
  {
    disc: [0x11, 0xe5, 0x23, 0xda, 0xbe, 0xf1, 0xfa, 0x7b],
    kind: "DelegateAndFreezeV2",
    risk: AUTHORITY_RISK,
  },
];

function metaplexRow(
  pid: string,
  name: string,
  kind: string,
  accounts: string[],
  risk?: typeof AUTHORITY_RISK | typeof BURN_RISK,
): SolanaDecodedInstruction {
  return {
    program: pid,
    kind,
    programName: name,
    // Asset is the first account across all three programs. Later slots
    // are optional-account positions that collapse when unused, so
    // indexing into them would misattribute; only slot 0 is safe to name
    // without a full IDL.
    fields: accounts[0] ? [{ label: "Asset", value: accounts[0] }] : undefined,
    risk,
  } as SolanaDecodedInstruction;
}

registerProgramDecoder({
  programId: METAPLEX_CORE,
  programName: "mpl-core",
  decode(ins) {
    if (typeof ins.data === "string" || ins.data.length < 1) return null;
    const entry = CORE_INSTRUCTIONS[u8(ins.data, 0)];
    if (!entry) {
      // Deliberate floor: an unrecognised Metaplex instruction keeps the
      // presence row rather than silently rendering as a benign one.
      return {
        program: METAPLEX_CORE,
        kind: "mpl-core:ix",
        programName: "mpl-core",
      } as SolanaDecodedInstruction;
    }
    return metaplexRow(
      METAPLEX_CORE,
      "mpl-core",
      entry.kind,
      ins.accounts,
      entry.risk,
    );
  },
});

registerProgramDecoder({
  programId: METAPLEX_METADATA,
  programName: "mpl-token-metadata",
  decode(ins) {
    if (typeof ins.data === "string" || ins.data.length < 1) return null;
    const entry = TOKEN_METADATA_INSTRUCTIONS[u8(ins.data, 0)];
    if (!entry) {
      return {
        program: METAPLEX_METADATA,
        kind: "mpl-token-metadata:ix",
        programName: "mpl-token-metadata",
      } as SolanaDecodedInstruction;
    }
    return metaplexRow(
      METAPLEX_METADATA,
      "mpl-token-metadata",
      entry.kind,
      ins.accounts,
      entry.risk,
    );
  },
});

registerProgramDecoder({
  programId: BUBBLEGUM,
  programName: "mpl-bubblegum",
  decode(ins) {
    if (typeof ins.data === "string" || ins.data.length < 8) {
      return {
        program: BUBBLEGUM,
        kind: "mpl-bubblegum:ix",
        programName: "mpl-bubblegum",
      } as SolanaDecodedInstruction;
    }
    const data = ins.data;
    const entry = BUBBLEGUM_INSTRUCTIONS.find((e) =>
      e.disc.every((b, i) => data[i] === b),
    );
    if (!entry) {
      return {
        program: BUBBLEGUM,
        kind: "mpl-bubblegum:ix",
        programName: "mpl-bubblegum",
      } as SolanaDecodedInstruction;
    }
    // Bubblegum operates on compressed assets held in a Merkle tree, so
    // there is no per-asset account to name; slot 0 is the tree config.
    return {
      program: BUBBLEGUM,
      kind: entry.kind,
      programName: "mpl-bubblegum",
      risk: entry.risk,
    } as SolanaDecodedInstruction;
  },
});
