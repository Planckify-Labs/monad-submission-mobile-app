/**
 * StellarAdapter — source-level dispatch invariants.
 *
 * Spec reference: `docs/stellar-dapp-bridge-spec.md` §4, §11.
 *
 * Behavioural runtime tests for the dispatch table need TS path-alias
 * resolution + RN shims (`StellarAdapter.ts` transitively imports
 * `PermissionStore`, which imports `expo-secure-store` /
 * `@react-native-async-storage/async-storage`), which plain `node --test`
 * can't provide. Following the same pattern as `SuiAdapter.test.ts` /
 * `boot.test.ts`, we lock the load-bearing shape with grep-style
 * assertions over the source so:
 *
 *   - The dispatch arms can't silently lose a Freighter wire method
 *     (e.g. someone deletes `case "SUBMIT_BLOB":` and the adapter starts
 *     answering "not supported" to a real dApp's signMessage call).
 *   - The cross-namespace-trust gate (TWV-2026-ZZZ) stays in place.
 *   - The always-decline arms (SUBMIT_AUTH_ENTRY / SUBMIT_TOKEN /
 *     REQUEST_USER_INFO, §4.1) never accidentally become intents.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types services/chains/stellar/StellarAdapter.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const src = readFileSync(
  new URL("./StellarAdapter.ts", import.meta.url),
  "utf-8",
);

describe("StellarAdapter — dispatch table (§4.1)", () => {
  for (const method of [
    "REQUEST_CONNECTION_STATUS",
    "REQUEST_PUBLIC_KEY",
    "REQUEST_ALLOWED_STATUS",
    "SET_ALLOWED_STATUS",
    "REQUEST_ACCESS",
    "REQUEST_NETWORK_DETAILS",
    "SUBMIT_TRANSACTION",
    "SUBMIT_BLOB",
    "SUBMIT_AUTH_ENTRY",
    "SUBMIT_TOKEN",
    "REQUEST_USER_INFO",
  ]) {
    it(`dispatches \`${method}\``, () => {
      assert.match(
        src,
        new RegExp(`case\\s*"${method}"`),
        `dispatch arm for ${method} is missing`,
      );
    });
  }

  it("falls through to a fixed decline on unknown method (never hangs, §1.5)", () => {
    assert.match(src, /default:[\s\S]*?UNSUPPORTED/);
  });
});

describe("StellarAdapter — always-declined arms never become intents (§0, §4.1)", () => {
  // SUBMIT_AUTH_ENTRY used to live in this group. Spec phase I turned it
  // into a real capability: SEP-43 defines `signAuthEntry`, and Soroban
  // needs it for contract-to-contract and multi-party authorisation, so
  // a fixed decline left those dApps unable to proceed at all. It now
  // raises an approval intent like any other signing request — see the
  // dedicated group below.

  it("SUBMIT_TOKEN responds with a fixed decline, not needs-approval", () => {
    assert.match(src, /case\s*"SUBMIT_TOKEN":[\s\S]{0,200}Not supported yet/);
  });

  it("REQUEST_USER_INFO responds with a fixed decline, not needs-approval", () => {
    assert.match(src, /case\s*"REQUEST_USER_INFO":[\s\S]{0,200}Not supported/);
  });
});

describe("StellarAdapter — SEP-43 signAuthEntry (spec phase I)", () => {
  it("routes SUBMIT_AUTH_ENTRY to a handler, not a fixed decline", () => {
    assert.match(
      src,
      /case\s*"SUBMIT_AUTH_ENTRY":[\s\S]{0,400}this\.handleSignAuthEntry/,
    );
  });

  it("raises an approval intent rather than signing silently", () => {
    assert.match(src, /handleSignAuthEntry[\s\S]*?status:\s*"needs-approval"/);
  });

  it("refuses an entry with source-account credentials", () => {
    // Those carry no signature slot — the transaction's own source
    // signature covers them. Raising a sheet that cannot produce
    // anything would be worse than declining.
    assert.match(src, /usesSourceAccount[\s\S]{0,200}INVALID_PARAMS/);
  });

  it("signs the original XDR, never a rebuild from the decoded view", () => {
    assert.match(
      src,
      /signAuthEntry\(\s*\n?\s*p\.address,\s*\n?\s*p\.authEntryXdr/,
    );
  });
});

describe("StellarAdapter — cross-namespace trust (§11 / TWV-2026-ZZZ)", () => {
  it('`pickStellarWalletForOrigin` filters grants by `chainId.startsWith("stellar:")`', () => {
    assert.match(src, /chainId\.startsWith\(\s*"stellar:"\s*\)/);
  });

  it("handleConnect never grants without a resolved Stellar wallet", () => {
    assert.match(
      src,
      /if\s*\(!wallet\)\s*{\s*\n\s*return rpcError\(\s*STELLAR_ERROR_CODES\.UNAUTHORIZED/,
    );
  });

  it("file cites TWV-2026-ZZZ", () => {
    assert.match(src, /TWV-2026-ZZZ/);
  });
});

describe("StellarAdapter — connect default network is `mainnet` (§4.2)", () => {
  it('`resolveGrantedNetwork` defaults to "mainnet"', () => {
    assert.match(src, /return\s+"mainnet"\s*;/);
  });
});

describe("StellarAdapter — accountToSign mismatch is declined, not silently signed (§1.4/§11)", () => {
  it("handleSignTransaction validates accountToSign against the wallet", () => {
    // Case-significant (base32) equality via the chain-agnostic seam, not a
    // corrupting `.toLowerCase()` compare.
    assert.match(
      src,
      /accountToSign[\s\S]{0,160}!addressesEqual\(\s*"stellar",\s*params\.accountToSign,\s*wallet\.address\s*\)/,
    );
  });
});

describe("StellarAdapter — executeApproval security gates", () => {
  it("rejects with USER_REJECT on user reject (§4.4)", () => {
    assert.match(
      src,
      /codedError\(\s*STELLAR_ERROR_CODES\.USER_REJECT\s*,\s*"user rejected"\s*\)/,
    );
  });

  it('throws "no Stellar signer registered" before signer install', () => {
    assert.match(src, /"no Stellar signer registered"/);
  });

  it("registerStellarSigner is the single registration seam", () => {
    assert.match(src, /export\s+function\s+registerStellarSigner/);
  });

  it("signs `payload.xdr`, never a reconstruction from `payload.decoded`", () => {
    assert.match(
      src,
      /signerImpl\.signTransaction\(\s*\n\s*p\.address,\s*\n\s*p\.xdr,/,
    );
  });
});
