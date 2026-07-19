/**
 * Barrel re-export for payment-intent detectors.
 *
 * Importing this file is the boot step that registers every detector
 * with the shared registry (each detector module calls `register(...)`
 * as a module-load side effect — see `walletAddress.ts`). The router
 * in task 07 imports this barrel once, then calls `classify()`.
 *
 * Subsequent detector tasks append their exports here (wallet URI,
 * EMVCo QRIS, TakumiPay JWS, x402) — never branch on namespace in a
 * shared file (memory `feedback_chain_extension_discipline.md`).
 *
 * Metro `inlineRequires` interaction (root cause of the preview-build
 * "Couldn't understand this QR" regression):
 *   - Babel merges `import "./qris.ts"` + `export { qrisDetector } from
 *     "./qris.ts"` into one `var _qris = require("./qris.ts")`.
 *   - Metro's `inline-requires-plugin` then strips the declaration and
 *     moves `require("./qris.ts").qrisDetector` INTO each export
 *     getter body. The require becomes lazy.
 *   - `scan-to-pay.tsx` imports this barrel for side-effects only
 *     (`import "@/services/paymentIntent/detectors"`), never reading a
 *     named export — so the getters never fire, the detector modules
 *     never evaluate, `register(...)` never runs, and `classify()`
 *     returns `null` for every QR.
 *   - Dev builds skip `inlineRequires`, which is why the bug only
 *     showed up in preview / production binaries.
 *
 * Defeat the lazy lift by reading each imported detector at the
 * top level of this module. Metro only inlines `var X = require(...)`
 * declarations; an array literal that contains the imports is
 * evaluated eagerly when the barrel loads, which forces each
 * detector module to evaluate and run its `register(...)`.
 */

import { qrisDetector } from "./qris.ts";
import { takumipayJwsDetector } from "./takumipayJws.ts";
import { walletAddressStellarDetector } from "./walletAddress.stellar.ts";
import { walletAddressSuiDetector } from "./walletAddress.sui.ts";
import { walletAddressDetector } from "./walletAddress.ts";
import { walletUriDetector } from "./walletUri.ts";
import { x402Detector } from "./x402.ts";

// Top-level reference defeats Metro's `inlineRequires` lift — see the
// module docstring above. The `if` guard keeps the array from being
// dead-code-eliminated and doubles as a boot-time self-check: if any
// detector module fails to load, this throws loudly at import instead
// of silently returning null from `classify()`.
const _bootDetectors = [
  qrisDetector,
  takumipayJwsDetector,
  walletAddressDetector,
  walletAddressStellarDetector,
  walletAddressSuiDetector,
  walletUriDetector,
  x402Detector,
];
if (_bootDetectors.some((d) => d == null)) {
  throw new Error(
    "paymentIntent: detector module failed to load — registry is incomplete",
  );
}

export {
  qrisDetector,
  takumipayJwsDetector,
  walletAddressDetector,
  walletAddressStellarDetector,
  walletAddressSuiDetector,
  walletUriDetector,
  x402Detector,
};
