/**
 * Token amount formatting. Two shapes, deliberately different:
 *
 * - `formatExactTokenAmount` — full precision, nothing dropped. For
 *   receipts and detail screens, where the number is the record of what
 *   was paid and every surface showing it must agree digit for digit.
 * - `formatTokenAmount` — compact (1-2 decimals, K/M/B suffixes). For
 *   lists and balances, where fitting the row is the point.
 *
 * No expo/react-native imports here on purpose: it keeps the module
 * importable from a plain vitest run (see `tokenAmount.test.ts`).
 */

/**
 * Truncate toward zero at `decimals` places.
 *
 * The obvious `Math.trunc(num * 10 ** decimals) / 10 ** decimals` loses
 * to binary float error: `0.29 * 100` is `28.999999999999996`, which
 * truncated 0.29 down to "0.28". `toString()` gives the shortest
 * round-trip decimal, so cutting that string shows the digits the value
 * actually has.
 */
function truncateToDecimals(num: number, decimals: number): number {
  const str = num.toString();
  // Exponential form has no decimal point to cut. Callers only reach
  // here with 0.001 <= |num| < 1e10, so this is defensive.
  if (str.includes("e")) return num;
  const dot = str.indexOf(".");
  if (dot === -1) return num;
  return Number(str.slice(0, decimals > 0 ? dot + 1 + decimals : dot));
}

/**
 * Render a raw base-unit amount at full precision, e.g. `"5852888"` at
 * 6 decimals to `"5.852888"`. Trailing zeros are trimmed and the
 * integer part is grouped (`"12,345.6789"`); no rounding or truncation
 * happens, and the conversion is exact string math so amounts past
 * float precision (18-decimal tokens) survive intact.
 *
 * When `decimals` is missing the raw string is returned unchanged,
 * matching what the detail screens already did in their `catch`
 * branches: an obviously odd number beats a confidently wrong one.
 */
export function formatExactTokenAmount(
  rawAmount: string | null | undefined,
  decimals: number | null | undefined,
): string {
  if (!rawAmount) return "0";

  if (
    typeof decimals !== "number" ||
    !Number.isInteger(decimals) ||
    decimals < 0
  ) {
    return rawAmount;
  }

  let units: bigint;
  try {
    units = BigInt(rawAmount.trim());
  } catch {
    return rawAmount;
  }

  const negative = units < 0n;
  const digits = (negative ? -units : units)
    .toString()
    .padStart(decimals + 1, "0");

  const intPart = digits.slice(0, digits.length - decimals);
  const frac =
    decimals > 0
      ? digits.slice(digits.length - decimals).replace(/0+$/, "")
      : "";

  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = frac ? `${grouped}.${frac}` : grouped;

  return negative ? `-${body}` : body;
}

type FormatTokenAmountOptions = {
  /** Use K/M/B suffixes for large numbers (default: true) */
  simplify?: boolean;
};

export function formatTokenAmount(
  value: string | number,
  options: FormatTokenAmountOptions = {},
): string {
  const { simplify = true } = options;
  const num = typeof value === "string" ? parseFloat(value) : value;

  if (isNaN(num) || num === 0) {
    return "0";
  }

  const absNum = Math.abs(num);
  const sign = num < 0 ? "-" : "";

  // Handle very small numbers
  if (absNum < 0.000001) {
    if (simplify) {
      const str = absNum.toFixed(12);
      const match = str.match(/0\.(0*)([1-9]\d{0,1})/);
      if (match) {
        const zeroCount = match[1].length;
        const significantDigits = match[2];
        const subscripts = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];
        const subscriptZeros = zeroCount
          .toString()
          .split("")
          .map((d) => subscripts[parseInt(d)])
          .join("");
        return `${sign}0.0${subscriptZeros}${significantDigits}`;
      }
    }
    return `${sign}<0.000001`;
  }

  // For non-simplified format, use locale string with appropriate decimals
  if (!simplify) {
    if (absNum < 1) {
      return `${sign}${absNum.toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 6,
      })}`;
    }
    if (absNum < 1000) {
      return `${sign}${absNum.toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 4,
      })}`;
    }
    return `${sign}${absNum.toLocaleString("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })}`;
  }

  // Simplified format with K/M/B suffixes
  if (absNum < 0.001) {
    const str = absNum.toFixed(12);
    const match = str.match(/0\.(0*)([1-9]\d{0,1})/);
    if (match) {
      const zeroCount = match[1].length;
      const significantDigits = match[2];
      const subscripts = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];
      const subscriptZeros = zeroCount
        .toString()
        .split("")
        .map((d) => subscripts[parseInt(d)])
        .join("");
      return `${sign}0.0${subscriptZeros}${significantDigits}`;
    }
    return `${sign}<0.001`;
  }

  if (absNum < 0.01) {
    const truncated = truncateToDecimals(absNum, 4);
    return `${sign}${truncated}`.replace(/0+$/, "").replace(/\.$/, "");
  }
  if (absNum < 1) {
    const truncated = truncateToDecimals(absNum, 2);
    return `${sign}${truncated}`.replace(/0+$/, "").replace(/\.$/, "");
  }

  if (absNum < 100) {
    const truncated = truncateToDecimals(absNum, 1);
    return `${sign}${truncated}`;
  }

  if (absNum < 1000) {
    return `${sign}${Math.trunc(absNum)}`;
  }

  if (absNum < 1_000_000) {
    const thousands = absNum / 1000;
    if (thousands >= 100) {
      return `${sign}${Math.trunc(thousands)}K`;
    }
    if (thousands >= 10) {
      return `${sign}${Math.trunc(thousands)}K`;
    }
    const truncated = truncateToDecimals(thousands, 1);
    return `${sign}${truncated}K`;
  }

  if (absNum < 1_000_000_000) {
    const millions = absNum / 1_000_000;
    if (millions >= 100) {
      return `${sign}${Math.trunc(millions)}M`;
    }
    if (millions >= 10) {
      return `${sign}${Math.trunc(millions)}M`;
    }
    if (absNum % 1_000_000 === 0) {
      return `${sign}${Math.trunc(millions)}M`;
    }
    const truncated = truncateToDecimals(millions, 1);
    return `${sign}${truncated}M`.replace(/\.0M$/, "M");
  }

  const billions = absNum / 1_000_000_000;
  if (billions >= 100) {
    return `${sign}${Math.trunc(billions)}B`;
  }
  if (billions >= 10) {
    return `${sign}${Math.trunc(billions)}B`;
  }
  if (absNum % 1_000_000_000 === 0) {
    return `${sign}${Math.trunc(billions)}B`;
  }
  const truncated = truncateToDecimals(billions, 1);
  return `${sign}${truncated}B`.replace(/\.0B$/, "B");
}
