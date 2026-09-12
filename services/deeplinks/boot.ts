/**
 * Deep-link kernel boot — registers every scheme handler (spec §4.4).
 *
 * Same shape as `services/paymentIntent/detectors/index.ts`: each
 * per-namespace / per-transport module calls `registerSchemeHandler()`
 * at load, and this barrel is imported once for its side effects (from
 * `app/_layout.tsx` and `app/+native-intent.tsx`). The array below
 * defeats Metro's `inlineRequires` lift so the registrations run even
 * when nothing reads a named export — see the paymentIntent barrel for
 * the incident that made this necessary.
 *
 * Adding a chain family = one `services/chains/<ns>/deeplinks.ts` + one
 * line here. Nothing else in the kernel changes.
 */

import { evmDeepLinkHandlers } from "@/services/chains/evm/deeplinks";
import { solanaDeepLinkHandlers } from "@/services/chains/solana/deeplinks";
import { stellarDeepLinkHandlers } from "@/services/chains/stellar/deeplinks";
import { suiDeepLinkHandlers } from "@/services/chains/sui/deeplinks";
import { walletConnectDeepLinkHandlers } from "@/services/transports/walletconnect/deeplinks";
import { registerSchemeHandler } from "./schemeRegistry";

const _bootHandlers = [
  ...evmDeepLinkHandlers,
  ...solanaDeepLinkHandlers,
  ...suiDeepLinkHandlers,
  ...stellarDeepLinkHandlers,
  ...walletConnectDeepLinkHandlers,
];
if (_bootHandlers.some((h) => h == null)) {
  throw new Error("deeplinks: handler module failed to load");
}
for (const h of _bootHandlers) registerSchemeHandler(h);

export const DEEPLINK_KERNEL_BOOTED = true;
