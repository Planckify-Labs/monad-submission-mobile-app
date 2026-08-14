export interface TVCGamerPLNVoucher {
  tokenCode: string;
  name: string;
  tarifOrPower: string;
  kwhCapacity: string;
}

// PLN voucher format (slash-delimited, order may vary):
//   2174-8986-6628-2450-0152/NURMULIANI-MTMN/R1/450VA/43.9KWH
// vcGamer data is inconsistent: unit suffixes are sometimes dropped, the
// kWh decimal separator can be "." or ",", casing/spacing on "VA"/"KWH"
// varies, and the comma decimal shows up whether or not the suffix is
// present, e.g.:
//   0591-0184-8779-9496-4877/NURMULIANIMTMN/R1/450/109,6
//   2174-8986-6628-2450-0152/NURMULIANI-MTMN/r1/450 VA/109,6KWH
// (positions 4 and 5 are always power and kWh, suffix or not)
//
// Each segment is identified by its pattern:
//   Token code  — five groups of 4 digits joined by dashes
//   kWh         — digits (dot or comma decimal) optionally followed by KWH
//   VA / power  — digits optionally followed by VA
//   Tarif       — R + digits (e.g. R1, R2)
//   Name        — anything else
const PLN_TOKEN_CODE = /^\d{4}-\d{4}-\d{4}-\d{4}-\d{4}$/;
const PLN_KWH = /^([\d.,]+)\s*KWH$/i;
const PLN_VA = /^(\d+)\s*VA$/i;
const PLN_TARIF = /^R\d+$/i;
// Bare fallbacks for when vcGamer omits the unit suffix: a plain integer is
// treated as the VA rating, a decimal (dot or comma) as the kWh capacity.
const PLN_BARE_INTEGER = /^\d+$/;
const PLN_BARE_DECIMAL = /^\d+[.,]\d+$/;

export const isPLNVoucher = (voucherCode: string): boolean =>
  voucherCode.split("/").some((part) => PLN_TOKEN_CODE.test(part.trim()));

const extractPLNVoucher = (voucherCode: string): TVCGamerPLNVoucher => {
  const parts = voucherCode.split("/").map((part) => part.trim());

  let tokenCode = "";
  let name = "";
  let tarif = "";
  let power = "";
  let kwhCapacity = "";

  for (const part of parts) {
    if (PLN_TOKEN_CODE.test(part)) {
      tokenCode = part;
    } else if (PLN_KWH.test(part)) {
      const match = part.match(PLN_KWH);
      kwhCapacity = match ? `${match[1].replace(",", ".")}KWH` : part;
    } else if (PLN_VA.test(part)) {
      const match = part.match(PLN_VA);
      power = match ? `${match[1]}VA` : part.toUpperCase();
    } else if (PLN_TARIF.test(part)) {
      tarif = part.toUpperCase();
    } else if (!kwhCapacity && PLN_BARE_DECIMAL.test(part)) {
      kwhCapacity = `${part.replace(",", ".")}KWH`;
    } else if (!power && PLN_BARE_INTEGER.test(part)) {
      power = `${part}VA`;
    } else {
      name = part;
    }
  }

  return {
    tokenCode,
    name,
    tarifOrPower: tarif && power ? `${tarif}/${power}` : tarif || power,
    kwhCapacity,
  };
};

type TVoucherType = "PLN";

export const extractVoucher = (
  voucherType: TVoucherType,
  voucherCode: string,
) => {
  switch (voucherType) {
    case "PLN":
      return extractPLNVoucher(voucherCode);

    default:
      break;
  }
};
