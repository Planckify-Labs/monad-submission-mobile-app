/**
 * `/link/<route>` — read-only screens a link may open directly (Class D).
 * The allowlist is the whole contract: `wallet`, `activities`,
 * `notification`, `dapp-permissions`, `about`. Nothing with a form.
 */

import type { AllowlistedHref, DeepLinkIntent } from "../types";
import type { PathParseArgs } from "./index";

const ROUTES: Record<string, AllowlistedHref> = {
  wallet: "/wallet",
  activities: "/activities",
  notification: "/notification",
  "dapp-permissions": "/dapp-permissions",
  about: "/about",
};

export function parseNavigatePath({ rest }: PathParseArgs): DeepLinkIntent {
  const route = (rest[0] ?? "").toLowerCase();
  const href = ROUTES[route];
  if (!href || rest.length !== 1)
    return { kind: "reject", code: "route_not_allowed" };
  return { kind: "navigate", href };
}
