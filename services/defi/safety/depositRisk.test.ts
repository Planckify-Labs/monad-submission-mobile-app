/**
 * Deposit-risk (impermanent-loss) disclosure copy, mirroring the
 * "exit-terms copy" block in `exitTerms.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { depositRiskNotice } from "./depositRiskCopy";

describe("deposit-risk copy", () => {
  it("warns when the pool carries IL exposure and stays silent otherwise", () => {
    expect(depositRiskNotice(true)).toContain("impermanent loss");
    expect(depositRiskNotice(false)).toBeNull();
  });

  it("stays silent while exposure is unknown rather than claim no risk", () => {
    expect(depositRiskNotice(undefined)).toBeNull();
  });

  it("never uses an em-dash in user-facing copy", () => {
    expect(depositRiskNotice(true) ?? "").not.toContain("—");
  });
});
