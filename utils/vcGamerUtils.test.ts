import { describe, expect, it } from "vitest";
import { extractVoucher, isPLNVoucher } from "./vcGamerUtils";

// vcGamer's PLN voucher_code is inconsistent across orders: unit suffixes
// ("VA"/"KWH") are sometimes dropped entirely, the kWh decimal separator
// can be "." or ",", and casing/spacing on the suffixes varies. A real
// order-status response with the suffixes dropped
// (voucher_code: "0591-0184-8779-9496-4877/NURMULIANIMTMN/R1/450/109,6")
// made isPLNVoucher() (formerly a "kWh"/"KWH" substring check) evaluate
// false, so the PLN Token Details card silently never rendered even
// though the token code was present in the data.
describe("isPLNVoucher", () => {
  it("detects the documented format with unit suffixes", () => {
    expect(
      isPLNVoucher(
        "2174-8986-6628-2450-0152/NURMULIANI-MTMN/R1/450VA/43.9KWH",
      ),
    ).toBe(true);
  });

  it("detects vcGamer's suffix-less variant by the token-code shape", () => {
    expect(
      isPLNVoucher("0591-0184-8779-9496-4877/NURMULIANIMTMN/R1/450/109,6"),
    ).toBe(true);
  });

  it("rejects a generic (non-PLN) voucher code", () => {
    expect(isPLNVoucher("ABCD1234EFGH5678")).toBe(false);
  });
});

describe("extractVoucher('PLN', ...)", () => {
  it("parses the real suffix-less, comma-decimal payload", () => {
    // exact voucher_code from a live vcgamer /v2/public/order-status response
    expect(
      extractVoucher(
        "PLN",
        "0591-0184-8779-9496-4877/NURMULIANIMTMN/R1/450/109,6",
      ),
    ).toEqual({
      tokenCode: "0591-0184-8779-9496-4877",
      name: "NURMULIANIMTMN",
      tarifOrPower: "R1/450VA",
      kwhCapacity: "109.6KWH",
    });
  });

  it("parses the documented dot-decimal, suffixed format", () => {
    expect(
      extractVoucher(
        "PLN",
        "2174-8986-6628-2450-0152/NURMULIANI-MTMN/R1/450VA/43.9KWH",
      ),
    ).toEqual({
      tokenCode: "2174-8986-6628-2450-0152",
      name: "NURMULIANI-MTMN",
      tarifOrPower: "R1/450VA",
      kwhCapacity: "43.9KWH",
    });
  });

  it("parses suffixed segments with a comma decimal", () => {
    expect(
      extractVoucher(
        "PLN",
        "2174-8986-6628-2450-0152/NURMULIANI-MTMN/R1/450VA/109,6KWH",
      ).kwhCapacity,
    ).toBe("109.6KWH");
  });

  it("normalizes lowercase tarif and unit suffixes", () => {
    expect(
      extractVoucher(
        "PLN",
        "2174-8986-6628-2450-0152/NURMULIANI-MTMN/r1/450va/109,6kwh",
      ),
    ).toEqual({
      tokenCode: "2174-8986-6628-2450-0152",
      name: "NURMULIANI-MTMN",
      tarifOrPower: "R1/450VA",
      kwhCapacity: "109.6KWH",
    });
  });

  it("tolerates stray whitespace around segments", () => {
    expect(
      extractVoucher(
        "PLN",
        " 0591-0184-8779-9496-4877 / NURMULIANIMTMN / R1 / 450 / 109,6 ",
      ),
    ).toEqual({
      tokenCode: "0591-0184-8779-9496-4877",
      name: "NURMULIANIMTMN",
      tarifOrPower: "R1/450VA",
      kwhCapacity: "109.6KWH",
    });
  });

  it("is order-independent when units are present (power/kWh swapped)", () => {
    expect(
      extractVoucher(
        "PLN",
        "2174-8986-6628-2450-0152/NURMULIANI-MTMN/R1/43.9KWH/450VA",
      ),
    ).toEqual({
      tokenCode: "2174-8986-6628-2450-0152",
      name: "NURMULIANI-MTMN",
      tarifOrPower: "R1/450VA",
      kwhCapacity: "43.9KWH",
    });
  });
});
