/**
 * SEP-0007 origin verification — the network half of `sep7.ts` (spec
 * §6.4 step 1). Runs only after the interstitial's Continue (S-6).
 *
 *   1. fetch `https://<origin_domain>/.well-known/stellar.toml` (no
 *      cache, 10 s, same host, ≤ 64 KB),
 *   2. extract `URI_REQUEST_SIGNING_KEY`,
 *   3. compare with the per-domain pin (a changed key blocks),
 *   4. verify the Ed25519 signature over the SEP payload,
 *   5. pin the key and report first contact.
 */

import { safeFetch } from "@/services/deeplinks/safeFetch";
import { sep7KeyPins } from "@/services/deeplinks/sep7KeyPins";
import {
  type BuildContext,
  DeepLinkBuildError,
  type Provenance,
} from "@/services/deeplinks/types";
import { parseUriRequestSigningKey, verifySep7Signature } from "./sep7";

export async function verifySep7Origin(args: {
  raw: string;
  originDomain: string;
  signature: string;
  ctx: BuildContext;
}): Promise<
  Provenance["verification"] & { kind: "sep7-signature" } & {
    firstSeen: boolean;
  }
> {
  const { raw, originDomain, signature, ctx } = args;
  const domain = originDomain.toLowerCase();

  let tomlText: string;
  try {
    const res = await safeFetch(`https://${domain}/.well-known/stellar.toml`, {
      method: "GET",
      headers: { Accept: "text/plain, application/toml, */*" },
      sameHost: true,
      fetchImpl: ctx.fetch,
    });
    if (!res.ok) throw new Error("toml status");
    tomlText = res.text;
  } catch (e) {
    if (e instanceof DeepLinkBuildError) throw e;
    if (__DEV__) console.warn("[sep7] stellar.toml fetch failed", e);
    // Rule 4: no toml → not a valid request.
    throw new DeepLinkBuildError("signature_invalid", { domain });
  }

  const key = parseUriRequestSigningKey(tomlText);
  // Rule 5: no key → not a valid request.
  if (!key) throw new DeepLinkBuildError("signature_invalid", { domain });

  const pinState = sep7KeyPins.check(domain, key);
  if (pinState === "changed") {
    throw new DeepLinkBuildError("signing_key_changed", {
      domain,
      data: { domain, newKey: key },
    });
  }

  const verdict = verifySep7Signature(raw, signature, key);
  if (verdict !== "ok")
    throw new DeepLinkBuildError("signature_invalid", { domain });

  const firstSeen = sep7KeyPins.pin(domain, key);
  return { kind: "sep7-signature", domain, keyPinned: true, firstSeen };
}
