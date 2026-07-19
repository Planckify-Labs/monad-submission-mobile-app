/**
 * Byte-exact cross-check of the mobile `MerchantQuote` encoder against the
 * backend's proven encoder.
 *
 * The FIXTURE below was produced by running the API's own
 * `signMerchantQuote` `quoteEntries` + `scvSortedMap` logic
 * (`api/src/blockchain-verification/stellar-verification.service.ts`, whose
 * encoding is proven on-chain — testnet tx `d36b93cd…`) against the exact
 * `SAMPLE_QUOTE` below, then `quoteScVal.toXDR("base64")`. Both repos pin
 * `@stellar/stellar-base@15.0.0`, so a faithful port is byte-identical.
 *
 * If this test fails, the wallet's encoding diverged from the backend's and a
 * real `process_merchant_payment` submission would TRAP on-chain — do not
 * "fix" it by regenerating the fixture without re-deriving it from the API.
 */

import { describe, expect, it } from "vitest";

import { encodeMerchantQuoteScVal } from "./encoding.ts";
import type { MerchantQuoteFields } from "./types.ts";

const SAMPLE_QUOTE: MerchantQuoteFields = {
  refId: "01JQZ8ZK9N4T7V2M3B5C6D7E8F",
  merchantId: "merchant_test_001",
  token: "CAEVSB5RGLRR3MVXUNMG67JRA4AAMZH4GR5WNCODSITO6YQI2W7XWD32",
  amount: 1_000_000n,
  platformFeeAmount: 25_000n,
  fiatAmountMinor: 150_000n,
  fiatCurrency: "IDR",
  exchangeRateId: 42n,
  expiresAt: 1_752_300_000n,
};

// Generated from the API's signMerchantQuote encoder (see file header).
const EXPECTED_QUOTE_XDR_BASE64 =
  "AAAAEQAAAAEAAAAJAAAADwAAAAZhbW91bnQAAAAAAAoAAAAAAAAAAAAAAAAAD0JAAAAADwAAABBleGNoYW5nZV9yYXRlX2lkAAAABQAAAAAAAAAqAAAADwAAAApleHBpcmVzX2F0AAAAAAAFAAAAAGhx+eAAAAAPAAAAEWZpYXRfYW1vdW50X21pbm9yAAAAAAAABQAAAAAAAknwAAAADwAAAA1maWF0X2N1cnJlbmN5AAAAAAAADQAAAANJRFIAAAAADwAAAAttZXJjaGFudF9pZAAAAAAOAAAAEW1lcmNoYW50X3Rlc3RfMDAxAAAAAAAADwAAABNwbGF0Zm9ybV9mZWVfYW1vdW50AAAAAAoAAAAAAAAAAAAAAAAAAGGoAAAADwAAAAZyZWZfaWQAAAAAAA4AAAAaMDFKUVo4Wks5TjRUN1YyTTNCNUM2RDdFOEYAAAAAAA8AAAAFdG9rZW4AAAAAAAASAAAAAQlZB7Ey4x2yt6NYb30xBwAGZPw0e2aJw5Im72II1b97";

describe("encodeMerchantQuoteScVal", () => {
  it("matches the backend's byte-exact MerchantQuote XDR", () => {
    const scVal = encodeMerchantQuoteScVal(SAMPLE_QUOTE);
    expect(scVal.toXDR("base64")).toBe(EXPECTED_QUOTE_XDR_BASE64);
  });

  it("sorts map entries alphabetically by field name regardless of input", () => {
    const scVal = encodeMerchantQuoteScVal(SAMPLE_QUOTE);
    const keys = scVal.map()!.map((e) => e.key().sym().toString());
    expect(keys).toEqual([...keys].sort());
    expect(keys).toEqual([
      "amount",
      "exchange_rate_id",
      "expires_at",
      "fiat_amount_minor",
      "fiat_currency",
      "merchant_id",
      "platform_fee_amount",
      "ref_id",
      "token",
    ]);
  });
});
