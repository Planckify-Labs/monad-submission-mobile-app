// TWV-2026-002 — same rule as `app/_layout.tsx`: pollyfills first. This
// module can be evaluated by expo-router's linking config before the
// root layout, and the chain handlers it registers pull in the same
// crypto stack.
import "../pollyfills";
import "@/services/deeplinks/boot";
import { intakeFromSystem } from "@/services/deeplinks/entry";
import { INBOX_ROUTE } from "@/services/deeplinks/intake";
import { bootWalletKits } from "@/services/walletKit/boot";

// The chain handlers resolve chain rows through the kit registry
// (`chainResolve.ts`). This module can be evaluated before
// `app/_layout.tsx`, so boot the kits here too (idempotent).
bootWalletKits();

/**
 * `redirectSystemPath` — deep-link spec §4.2 (F2, S-2).
 *
 * expo-router hands **every** native URL here (cold `getInitialURL` and
 * warm `url` events) before the file-based router sees it. We rewrite
 * all of them: sensitive intent goes to the inbox (`/link-inbox`),
 * read-only navigation goes to an allowlisted href, third-party pages go
 * to the in-app browser, and the few URLs that are not ours to interpret
 * (dev client, OAuth callback, plain app open) pass through unchanged.
 * A file route such as `/send?recipientAddress=…` is therefore never
 * reachable by URL.
 *
 * Runs outside the app (no auth / lock state, no React) and must never
 * throw; the fallback is the inbox with an error flag.
 */
export function redirectSystemPath({
  path,
  initial,
}: {
  path: string;
  initial: boolean;
}): string {
  try {
    const result = intakeFromSystem({ path, initial });
    if (result.kind === "passthrough") return result.path;
    // Nothing to navigate for: expo-router skips an empty href on a warm
    // `url` event; a cold start on such a link opens the app as usual.
    if (result.kind === "ignore") return initial ? "/" : "";
    return result.href;
  } catch (e) {
    if (__DEV__) console.warn("[+native-intent] intake threw", e);
    return `${INBOX_ROUTE}?error=1`;
  }
}
