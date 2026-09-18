/**
 * `__DEV__`-only passkey diagnostics. Never imported by production paths.
 *
 * Runs silent (`preferImmediatelyAvailableCredentials`) assertions with
 * and without the PRF extension so a device where Google Password Manager
 * lists passkeys for a plain WebAuthn `get` but not for a PRF-carrying one
 * shows up as two different answers in the Metro log. Nothing here derives
 * a key or touches the wallet store; a successful probe's assertion is
 * discarded. The result codes are printed, not shown to the user.
 */

import { Passkey } from "react-native-passkey";
import { PASSKEY_RP_ID } from "./derive";
import { passkeyErrorCodes } from "./errors";

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomB64url(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

type ProbeName = "plain" | "prf" | "plain-uv-preferred";

async function probe(name: ProbeName): Promise<string> {
  const request = {
    challenge: randomB64url(32),
    rpId: PASSKEY_RP_ID,
    userVerification: (name === "plain-uv-preferred"
      ? "preferred"
      : "required") as "preferred" | "required",
    ...(name === "prf"
      ? { extensions: { prf: { eval: { first: randomB64url(32) } } } }
      : {}),
  };
  try {
    const res = await Passkey.getImmediate(request);
    return `OK credentialId=${String(res.id).slice(0, 12)}… prf=${JSON.stringify(
      (res as { clientExtensionResults?: unknown }).clientExtensionResults ??
        null,
    )}`;
  } catch (err) {
    return `FAIL ${passkeyErrorCodes(err).join(" <- ") || "no code"} ${
      (err as { message?: string })?.message ?? ""
    }`;
  }
}

export async function runPasskeyDiagnostics(): Promise<void> {
  if (!__DEV__) return;
  console.info(`[passkey:diag] rpId=${PASSKEY_RP_ID}`);
  for (const name of ["plain", "plain-uv-preferred", "prf"] as ProbeName[]) {
    console.info(`[passkey:diag] ${name} …`);
    const out = await probe(name);
    console.info(`[passkey:diag] ${name}: ${out}`);
  }
}
