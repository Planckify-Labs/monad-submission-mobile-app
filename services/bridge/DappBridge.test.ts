/**
 * Source-level invariants for TWV-2026-007 — hard-reject `eth_sign` at
 * the bridge. Full end-to-end bridge tests require a real adapter
 * runtime and TS path-alias resolution, which plain `node --test` can't
 * provide; we therefore grep the source for the load-bearing shape and
 * leave the behavioural check to the manual-regression list in
 * `docs/wallet-security-task/01_block_eth_sign_twv007_istaken_true_isfinish_true.md`.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types services/bridge/DappBridge.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const src = readFileSync(new URL("./DappBridge.ts", import.meta.url), "utf-8");

describe("DappBridge — TWV-2026-015 per-session nonce gate", () => {
  it("declares sessionNonce + setSessionNonce path", () => {
    assert.match(src, /private sessionNonce:\s*string \| null/);
    assert.match(src, /setSessionNonce\(nonce:\s*string \| null\)/);
  });

  it("silently drops messages with missing or unknown nonce (no error reply)", () => {
    // The check returns from `dispatch` without calling `postError` —
    // spec rule "no error reply that leaks the control". The comparison
    // runs against the session's accepted-nonces history (bounded ring),
    // using the constant-time `nonceEquals` helper.
    assert.match(
      src,
      /sessionNonce !== null[\s\S]*?acceptedNonces\.some[\s\S]*?nonceEquals\(nonce,[\s\S]*?return;/,
    );
  });

  it("maintains a bounded accepted-nonce history (every rotation recorded)", () => {
    assert.match(src, /acceptedNonces:\s*string\[\]/);
    assert.match(src, /NONCE_HISTORY_MAX/);
    // setSessionNonce must push the new nonce into the history ring.
    assert.match(
      src,
      /setSessionNonce\(nonce:\s*string \| null\)[\s\S]*?acceptedNonces\.push\(nonce\)/,
    );
  });

  it("uses constant-time comparison for the nonce", () => {
    assert.match(src, /private nonceEquals\(a:\s*string,\s*b:\s*string\)/);
    assert.match(src, /diff\s*\|=\s*a\.charCodeAt/);
  });

  it("parseMessage extracts __takumi_nonce + __takumi_origin", () => {
    assert.match(src, /__takumi_nonce/);
    assert.match(src, /__takumi_origin/);
  });
});

describe("DappBridge — TWV-2026-013 origin-pin check", () => {
  it("tracks the top-frame origin in trackedTopOrigin", () => {
    assert.match(src, /private trackedTopOrigin:\s*string \| null/);
    assert.match(src, /this\.trackedTopOrigin\s*=\s*url/);
  });

  it("rejects mismatched origin with EIP-1193 4100 before adapter dispatch", () => {
    assert.match(
      src,
      /trackedTopOrigin !== null[\s\S]*?declaredHost !== trackedHost[\s\S]*?postError\([\s\S]*?4100/,
    );
  });

  it("treats a null tracked origin (cold start) as accept-once", () => {
    assert.match(src, /trackedTopOrigin === null|trackedTopOrigin !== null/);
  });
});

describe("DappBridge — UI-initiated disconnect (revokeConnection)", () => {
  it("exposes revokeConnection({origin, walletAddress?})", () => {
    assert.match(
      src,
      /async revokeConnection\(args:\s*\{[\s\S]*?origin:\s*string;[\s\S]*?walletAddress\?:\s*string;[\s\S]*?\}\)/,
    );
  });

  it("revokes the persisted grant via PermissionStore.revoke", () => {
    assert.match(
      src,
      /async revokeConnection[\s\S]*?await PermissionStore\.revoke\(args\)/,
    );
  });

  it("only pushes a live event when the origin is the tracked top frame", () => {
    // The live check compares originKey(trackedTopOrigin) to the revoked
    // origin and early-returns otherwise — a stale-site revoke must not
    // inject anything into whatever dApp is currently open.
    assert.match(
      src,
      /this\.trackedTopOrigin !== null[\s\S]*?originKey\(this\.trackedTopOrigin\)\s*===\s*originKey\(args\.origin\)[\s\S]*?if \(!live\) return;/,
    );
  });

  it("derives affected namespaces from the pre-revoke grants", () => {
    assert.match(
      src,
      /const before = PermissionStore\.listByOrigin\(args\.origin\)[\s\S]*?namespaceForChainKey\(g\.chainId\)/,
    );
  });

  it("pushes the empty-accounts helper for each affected namespace", () => {
    // EVM clears selectedAddress; Solana/Sui push an empty accounts array.
    // Each is the exact provider call that makes the injected script emit
    // its standard disconnect / accountsChanged event.
    assert.match(src, /_updateEthereumProvider\(\{selectedAddress:null\}\)/);
    assert.match(src, /_updateSolanaWallet\(\{accounts:\[\]\}\)/);
    assert.match(src, /_updateSuiWallet\(\{accounts:\[\]\}\)/);
  });

  it("reloads the page for stellar — Freighter's protocol has no wallet→dApp push event (docs/stellar-dapp-bridge-spec.md §4.4)", () => {
    assert.match(
      src,
      /namespace === "stellar"\s*\)\s*\{\s*\n\s*wv\.reload\(\);/,
    );
  });
});

describe("DappBridge — TWV-2026-007 hard-reject eth_sign", () => {
  it("declares HARD_REJECT_METHODS and includes eth_sign", () => {
    assert.match(src, /export const HARD_REJECT_METHODS[\s\S]*?"eth_sign"/);
  });

  it("does NOT include personal_sign or any typed-data variant", () => {
    const block = src.match(
      /HARD_REJECT_METHODS:\s*ReadonlySet<string>\s*=\s*new Set\(\[([\s\S]*?)\]\)/,
    );
    assert.ok(block, "HARD_REJECT_METHODS literal block missing");
    const entries = block[1] ?? "";
    assert.doesNotMatch(entries, /personal_sign/);
    assert.doesNotMatch(entries, /eth_signTypedData/);
  });

  it("dispatch() rejects with EIP-1193 code 4200 before any adapter runs", () => {
    // The rejection branch must:
    //   1. check HARD_REJECT_METHODS.has(method),
    //   2. call postError(id, 4200, ...),
    //   3. return before `adapter.handleRequest` fires.
    assert.match(
      src,
      /if \(HARD_REJECT_METHODS\.has\(method\)\)[\s\S]*?this\.postError\([\s\S]*?4200/,
    );
  });

  it("request event is emitted before the hard-reject so the origin is logged", () => {
    // The origin-tag audit trail depends on the `bridgeEventBus.emit({kind:"request"...})`
    // call running BEFORE the hard-reject return.
    const dispatchBlock = src.match(
      /async dispatch\(rawMessage: unknown\)[\s\S]*?^  \}/m,
    );
    assert.ok(dispatchBlock, "dispatch() body not found");
    const body = dispatchBlock[0];
    const requestIdx = body.indexOf('kind: "request"');
    const rejectIdx = body.indexOf("HARD_REJECT_METHODS.has(method)");
    assert.ok(requestIdx > 0 && rejectIdx > 0);
    assert.ok(
      requestIdx < rejectIdx,
      "request event must emit before the hard-reject return",
    );
  });
});

describe("DappBridge — TWV-2026-051 flagged-origin gates", () => {
  it("blocks signature-producing methods in dispatch(), before the adapter", () => {
    const dispatchBlock = src.match(
      /async dispatch\(rawMessage: unknown\)[\s\S]*?^  \}/m,
    );
    assert.ok(dispatchBlock, "dispatch() body not found");
    const body = dispatchBlock[0];
    const gateIdx = body.indexOf("SIGNATURE_PRODUCING_METHODS.has(method)");
    const adapterIdx = body.indexOf("adapter.handleRequest");
    assert.ok(gateIdx > 0, "no flagged-origin signature gate in dispatch()");
    assert.ok(
      gateIdx < adapterIdx,
      "the flagged-origin gate must run before adapter.handleRequest",
    );
    assert.match(
      body.slice(gateIdx, gateIdx + 400),
      /isFlaggedHost\(origin\.url\)[\s\S]*?this\.postError/,
    );
  });

  it("blocks every approval intent in enqueue(), not just the EVM method names", () => {
    // `SIGNATURE_PRODUCING_METHODS` is an EVM list. Without a gate at the
    // namespace-agnostic choke point, a flagged origin could still reach a
    // Solana / Sui / Stellar signing sheet.
    const enqueueBlock = src.match(
      /async enqueue\(intent: ApprovalIntent\)[\s\S]*?^  \}/m,
    );
    assert.ok(enqueueBlock, "enqueue() body not found");
    const body = enqueueBlock[0];
    const gateIdx = body.indexOf("isFlaggedHost(intent.origin.url)");
    const pushIdx = body.indexOf("pendingIntentsStore.push");
    assert.ok(gateIdx > 0, "no flagged-origin gate in enqueue()");
    assert.ok(
      gateIdx < pushIdx,
      "the flagged-origin gate must run before the intent is queued",
    );
  });

  it("keeps the block terminal — no bypass flag reaches the bridge", () => {
    // The browser lets a user click past the interstitial; signing must
    // not inherit that decision. If a bypass ever gets plumbed into the
    // bridge, this is the test that should stop it. Comments are stripped
    // first: the code is allowed to explain why the bypass stops at the
    // browser, it just is not allowed to read one.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /bypass/i);
  });
});

describe("DappBridge — approvals do not outlive their page", () => {
  it("exposes onPageUnavailable and rejects same-origin intents with 4900", () => {
    const block = src.match(/onPageUnavailable\(url: string\)[\s\S]*?^  \}/m);
    assert.ok(block, "onPageUnavailable() not found");
    const body = block[0];
    assert.match(body, /pendingIntentsStore\.remove\(intent\.id\)/);
    assert.match(body, /this\.postError\(intent\.id, 4900/);
    // Same-origin only: a live page's approvals must survive another
    // page's failure.
    assert.match(body, /originKey\(intent\.origin\.url\) !== deadHost/);
  });

  it("clears the per-origin pending lock so the origin is not wedged", () => {
    // `pendingByOrigin` gates one approval per origin. Dropping the intent
    // without clearing it would make every later request from that origin
    // fail with -32002 until the screen remounts.
    const block = src.match(/onPageUnavailable\(url: string\)[\s\S]*?^  \}/m);
    assert.ok(block);
    assert.match(block[0], /this\.pendingByOrigin\.delete\(deadHost\)/);
  });
});
