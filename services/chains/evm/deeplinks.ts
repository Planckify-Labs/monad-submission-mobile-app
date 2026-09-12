/**
 * EVM deep-link handler — ERC-681 / ERC-831 `ethereum:` (spec §6.1).
 *
 * Delegates parsing to the single ERC-681 parser in
 * `services/paymentIntent/detectors/walletUri.ts` (F8) after the
 * pre-normalisation the QR path never needed:
 *   - `ethereum:pay-0x…` (ERC-831 prefix) → strip `pay-`; any other
 *     `<prefix>-` → `unsupported_operation`.
 *   - `value=2.014e18` (scientific notation, "strongly encouraged" by the
 *     ERC) → expanded to integer wei; a non-integer result → `malformed`.
 *   - ENS `target_address` → `unsupported_operation` (D-6).
 *   - any `function_name` other than `transfer` → `unsupported_operation`.
 *   - `@chainId` not offered by the backend feed → `unsupported_chain`.
 *   - `gas` / `gasLimit` / `gasPrice` → ignored (suggestions per the ERC).
 *
 * EVM leaves `buildPaymentRequest` undefined on its kit, so the kernel
 * routes the result to the existing send screen with `source: "deeplink"`.
 */

import { isChainOffered } from "@/services/deeplinks/chainResolve";
import type { DeepLinkSchemeHandler } from "@/services/deeplinks/schemeRegistry";
import type {
  DeepLinkIntent,
  Provenance,
  SigningSummary,
} from "@/services/deeplinks/types";
import { parseEthereum } from "@/services/paymentIntent/detectors/walletUri";
import type { PaymentIntent } from "@/services/paymentIntent/types";

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const NUMBER_RE = /^[+-]?\d*(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * Expand an ERC-681 `number` (`2.014e18`, `1e18`, `5`) to an integer
 * decimal string. Returns `null` when the value is not an integer after
 * expansion (fractional wei does not exist) or is negative.
 */
export function expandScientific(raw: string): string | null {
  const s = raw.trim();
  if (!NUMBER_RE.test(s) || s === "" || s === "+" || s === "-") return null;
  if (s.startsWith("-")) return null;
  const unsigned = s.replace(/^\+/, "");
  const m = /^(\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(unsigned);
  if (!m) return null;
  const intPart = m[1] ?? "";
  const fracPart = m[2] ?? "";
  const exp = m[3] ? Number.parseInt(m[3], 10) : 0;
  if (intPart === "" && fracPart === "") return null;
  const digits = (intPart + fracPart).replace(/^0+(?=\d)/, "");
  const shift = exp - fracPart.length;
  if (shift >= 0) {
    return `${digits === "" ? "0" : digits}${"0".repeat(shift)}`.replace(
      /^0+(?=\d)/,
      "",
    );
  }
  // Negative shift: the trailing digits must all be zero.
  const cut = digits.length + shift;
  if (cut < 0) return digits.replace(/^0+$/, "") === "" ? "0" : null;
  const head = digits.slice(0, cut);
  const tail = digits.slice(cut);
  if (/[1-9]/.test(tail)) return null;
  return head === "" ? "0" : head.replace(/^0+(?=\d)/, "");
}

/**
 * Pre-normalise the URI into the subset `parseEthereum` accepts, or
 * return a reject code. Pure.
 */
export function normalizeErc681(
  raw: string,
): { uri: string } | { reject: "malformed" | "unsupported_operation" } {
  if (!raw.startsWith("ethereum:")) return { reject: "malformed" };
  let body = raw.slice("ethereum:".length);
  // ERC-831 prefix.
  const prefix = /^([a-z][a-z0-9]*)-/i.exec(body);
  if (prefix) {
    if (prefix[1].toLowerCase() !== "pay")
      return { reject: "unsupported_operation" };
    body = body.slice(prefix[0].length);
  }
  const qIdx = body.indexOf("?");
  const head = qIdx === -1 ? body : body.slice(0, qIdx);
  const queryStr = qIdx === -1 ? "" : body.slice(qIdx + 1);

  const target = head.split(/[@/]/)[0] ?? "";
  if (!EVM_ADDRESS_RE.test(target)) {
    // ENS or garbage. ENS is a name (letters + dot); anything else is
    // malformed.
    return {
      reject: /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(target)
        ? "unsupported_operation"
        : "malformed",
    };
  }
  const slash = head.indexOf("/");
  if (slash !== -1) {
    const fn = head.slice(slash + 1);
    if (fn !== "transfer") return { reject: "unsupported_operation" };
  }

  // Rebuild the query with numeric params expanded and gas hints dropped.
  const params = new URLSearchParams(queryStr);
  const out = new URLSearchParams();
  for (const [k, v] of params.entries()) {
    if (k === "gas" || k === "gasLimit" || k === "gasPrice") continue;
    if (k === "value" || k === "uint256") {
      if (/^0x[0-9a-fA-F]+$/.test(v)) {
        out.append(k, v);
        continue;
      }
      const expanded = expandScientific(v);
      if (expanded === null) return { reject: "malformed" };
      out.append(k, expanded);
      continue;
    }
    out.append(k, v);
  }
  const rebuilt = out.toString();
  return { uri: `ethereum:${head}${rebuilt ? `?${rebuilt}` : ""}` };
}

function summaryFor(channel: PaymentIntent["channel"]): SigningSummary {
  const lines: SigningSummary["lines"] = [];
  if (channel.kind === "wallet") {
    lines.push({ label: "To", value: channel.address });
    if (channel.amount !== undefined) {
      lines.push({
        label: channel.token ? "Token amount (base units)" : "Amount (wei)",
        value: channel.amount.toString(),
      });
    }
    if (channel.token) lines.push({ label: "Token", value: channel.token });
    if (channel.target && "chainId" in channel.target) {
      lines.push({ label: "Chain id", value: String(channel.target.chainId) });
    }
  }
  return { title: "Payment request", chainLabel: "Ethereum", lines };
}

export const eip681Handler: DeepLinkSchemeHandler = {
  id: "eip681",
  namespace: "eip155",
  schemes: ["ethereum"],
  priority: 10,
  parse(_split, envelope, ctx): DeepLinkIntent {
    const normalized = normalizeErc681(envelope.raw);
    if ("reject" in normalized)
      return { kind: "reject", code: normalized.reject };
    const channel = parseEthereum(normalized.uri);
    if (!channel || channel.kind !== "wallet")
      return { kind: "reject", code: "malformed" };
    if (channel.target && "chainId" in channel.target) {
      const offered = isChainOffered(
        { namespace: "eip155", ref: String(channel.target.chainId) },
        ctx.chainRows(),
      );
      if (offered === false)
        return { kind: "reject", code: "unsupported_chain" };
    }
    const provenance: Provenance = {
      verification: { kind: "none" },
      firstSeen: false,
      transport: "os-link",
      source: envelope.source,
    };
    const intent: PaymentIntent = {
      source: "deeplink",
      channel,
      rawScan: envelope.raw,
    };
    return {
      kind: "payment",
      namespace: "eip155",
      intent,
      provenance,
      summary: summaryFor(channel),
    };
  },
};

export const evmDeepLinkHandlers: readonly DeepLinkSchemeHandler[] = [
  eip681Handler,
];
