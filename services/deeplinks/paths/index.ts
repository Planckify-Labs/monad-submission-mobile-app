/**
 * Universal-link path handlers — spec §4.4 table "Universal-link paths".
 *
 * `https://takumipay.xyz/<path>` and the custom-scheme mirror
 * `takumiwallet://<path>` share these. They are namespace-agnostic: a
 * chain URI inside `/pay?uri=` is handed back to the scheme registry,
 * and the transport paths (`/wc`, `/ul`, `/mobilewalletadapter`) emit
 * transport-level intents. Anything not listed here is
 * `route_not_allowed` — including every file route the router would
 * otherwise auto-resolve (F2 / S-2).
 */

import type {
  DeepLinkEnvelope,
  DeepLinkIntent,
  DeepLinkParseContext,
  Provenance,
} from "../types";
import { parseDappPath } from "./dapp";
import { parseMwaPath } from "./mwa";
import { parseNavigatePath } from "./navigate";
import { parsePayPath } from "./pay";
import { parseUlPath } from "./ul";
import { parseWcPath } from "./wc";

export interface PathHandler {
  /** First path segment(s) this handler claims, lower-case, no slashes. */
  prefix: string;
  parse(args: PathParseArgs): DeepLinkIntent | null;
}

export interface PathParseArgs {
  /** Path segments after the prefix (already split, percent-encoded). */
  rest: string[];
  query: URLSearchParams;
  envelope: DeepLinkEnvelope;
  ctx: DeepLinkParseContext;
  provenance: Provenance;
}

const HANDLERS: readonly PathHandler[] = [
  { prefix: "pay", parse: parsePayPath },
  { prefix: "wc", parse: parseWcPath },
  { prefix: "ul", parse: parseUlPath },
  { prefix: "mobilewalletadapter", parse: parseMwaPath },
  { prefix: "dapp", parse: parseDappPath },
  { prefix: "link", parse: parseNavigatePath },
];

export function listPathPrefixes(): string[] {
  return HANDLERS.map((h) => h.prefix);
}

/**
 * Returns `null` when the path is not one of ours (the caller decides
 * between `route_not_allowed` and a legacy fallback).
 */
export function parseHostPath(
  pathname: string,
  query: URLSearchParams,
  envelope: DeepLinkEnvelope,
  ctx: DeepLinkParseContext,
  provenance: Provenance,
): DeepLinkIntent | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const head = segments[0].toLowerCase();
  const handler = HANDLERS.find((h) => h.prefix === head);
  if (!handler) return null;
  return handler.parse({
    rest: segments.slice(1),
    query,
    envelope,
    ctx,
    provenance,
  });
}
