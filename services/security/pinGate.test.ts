/**
 * `pinGate` store invariants: the promise parked by `requestPinConfirmation`
 * settles only through `resolvePinGate`, subscribers see both edges, and a
 * second request while one is up is refused rather than queued.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types \
 *     --import ./services/walletKit/evm/_test-resolver.mjs \
 *     services/security/pinGate.test.ts
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  __resetPinGateForTest,
  getPinGateRequest,
  requestPinConfirmation,
  resolvePinGate,
  subscribePinGate,
} from "./pinGate.ts";

describe("pinGate", () => {
  beforeEach(() => __resetPinGateForTest());

  it("exposes the pending request and settles true on confirm", async () => {
    const edges: Array<string | null> = [];
    subscribePinGate(() => edges.push(getPinGateRequest()?.title ?? null));

    const p = requestPinConfirmation("Approve connect to example.com");
    assert.equal(getPinGateRequest()?.title, "Approve connect to example.com");

    resolvePinGate(true);
    assert.equal(await p, true);
    assert.equal(getPinGateRequest(), null);
    assert.deepEqual(edges, ["Approve connect to example.com", null]);
  });

  it("settles false on dismiss", async () => {
    const p = requestPinConfirmation("x");
    resolvePinGate(false);
    assert.equal(await p, false);
  });

  it("refuses a second request while one is pending", async () => {
    const first = requestPinConfirmation("first");
    const second = await requestPinConfirmation("second");
    assert.equal(second, false);
    // The first request is untouched by the refused second one.
    assert.equal(getPinGateRequest()?.title, "first");
    resolvePinGate(true);
    assert.equal(await first, true);
  });

  it("clears the request before settling so a re-entrant request is accepted", async () => {
    const first = requestPinConfirmation("first");
    let reentrant: Promise<boolean> | null = null;
    // A caller that chains a new request off the first one's settlement
    // must find the gate free, not still holding the settled request.
    const chained = first.then(() => {
      reentrant = requestPinConfirmation("second");
      return getPinGateRequest()?.title;
    });
    resolvePinGate(true);
    assert.equal(await chained, "second");
    resolvePinGate(true);
    assert.equal(await reentrant, true);
  });

  it("resolvePinGate with nothing pending is a no-op", () => {
    assert.doesNotThrow(() => resolvePinGate(true));
    assert.equal(getPinGateRequest(), null);
  });

  it("hands out fresh ids so the host can remount per request", async () => {
    const a = requestPinConfirmation("a");
    const idA = getPinGateRequest()?.id;
    resolvePinGate(false);
    await a;
    const b = requestPinConfirmation("b");
    const idB = getPinGateRequest()?.id;
    resolvePinGate(false);
    await b;
    assert.notEqual(idA, idB);
  });
});
