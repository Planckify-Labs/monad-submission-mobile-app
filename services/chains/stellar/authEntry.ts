/**
 * Soroban authorization-entry decoding and signing — spec phase I.
 *
 * SEP-43 defines `signAuthEntry` as part of the standard wallet
 * interface, and Soroban needs it structurally: a
 * `SorobanAuthorizedInvocation` is how a contract call proves
 * authorisation for its sub-invocations. Contract-to-contract calls,
 * multi-party authorisation, and any invocation where the signer is not
 * the transaction source all depend on it. A dApp that needs one and
 * does not find it simply cannot proceed.
 *
 * What is being signed is NOT the entry itself. It is a
 * `HashIDPreimage` of type `ENVELOPE_TYPE_SOROBAN_AUTHORIZATION`,
 * covering the network id, the credential nonce, the expiration ledger
 * and the root invocation. Signing the entry bytes directly would
 * produce a signature the network rejects, and — worse — one whose
 * scope does not match what the user was shown.
 *
 * The nonce and expiration ledger come from the entry as the dApp built
 * it. This module never rewrites them: raising an expiration or reusing
 * a nonce would change the authorisation's lifetime out from under the
 * approval the user gave.
 */

import {
  Address,
  authorizeEntry,
  type Keypair,
  xdr,
} from "@stellar/stellar-base";

export interface DecodedAuthEntry {
  /** The address whose authorisation is being requested. */
  address?: string;
  /** Contract being invoked at the root of the authorisation tree. */
  contractId?: string;
  /** Function being authorised. */
  function?: string;
  /**
   * How many nested sub-invocations this authorises. A user granting a
   * root call is also granting everything beneath it, so the depth is
   * itself worth showing.
   */
  subInvocationCount?: number;
  /** Ledger sequence after which this authorisation is dead. */
  expirationLedger?: number;
  /**
   * True when the entry uses source-account credentials rather than
   * address credentials. Those carry no signature at all — the
   * transaction's own source-account signature covers them, so there is
   * nothing here to sign.
   */
  usesSourceAccount?: boolean;
}

function invocationDetail(inv: xdr.SorobanAuthorizedInvocation): {
  contractId?: string;
  function?: string;
} {
  try {
    const fn = inv.function();
    if (fn.switch().name === "sorobanAuthorizedFunctionTypeContractFn") {
      const call = fn.contractFn();
      const contractId = Address.fromScAddress(
        call.contractAddress(),
      ).toString();
      const rawName = call.functionName();
      const functionName =
        typeof rawName === "string"
          ? rawName
          : new TextDecoder().decode(new Uint8Array(rawName));
      return { contractId, function: functionName };
    }
    // The other arm is a contract *creation* authorisation.
    return { function: "create contract" };
  } catch {
    return {};
  }
}

/**
 * Structural decode for the approval sheet. Fully defensive — a shape
 * surprise degrades to an empty description rather than throwing, and
 * the sheet then says so instead of rendering raw XDR.
 */
export function decodeAuthEntry(entryXdr: string): DecodedAuthEntry {
  try {
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64");
    const credentials = entry.credentials();
    const root = entry.rootInvocation();
    const detail = invocationDetail(root);
    const out: DecodedAuthEntry = {
      ...detail,
      subInvocationCount: root.subInvocations().length,
    };
    if (credentials.switch().name === "sorobanCredentialsAddress") {
      const addr = credentials.address();
      out.address = Address.fromScAddress(addr.address()).toString();
      out.expirationLedger = addr.signatureExpirationLedger();
    } else {
      out.usesSourceAccount = true;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Sign an authorization entry and return the updated entry as base64
 * XDR.
 *
 * Throws when the entry uses source-account credentials: there is no
 * signature slot to fill, and silently returning the entry unchanged
 * would tell the dApp it was signed when it was not.
 */
export async function signAuthEntry(
  entryXdr: string,
  networkPassphrase: string,
  keypair: Keypair,
): Promise<string> {
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64");
  const credentials = entry.credentials();
  if (credentials.switch().name !== "sorobanCredentialsAddress") {
    throw new Error("auth entry has no address credentials");
  }
  const addressCredentials = credentials.address();

  // Guard the binding the user approved: the entry names the address it
  // authorises, and signing with a different key would produce a valid
  // signature attributed to the wrong account.
  const entryAddress = Address.fromScAddress(
    addressCredentials.address(),
  ).toString();
  if (entryAddress !== keypair.publicKey()) {
    throw new Error("auth entry address does not match signer");
  }

  // Reuse stellar-base's own `authorizeEntry` rather than rebuilding the
  // `HashIDPreimage` by hand. The preimage covers the network id, nonce,
  // expiration ledger and root invocation; getting any of that subtly
  // wrong yields a signature whose scope differs from what the sheet
  // showed, which is the one failure mode worth spending a dependency to
  // avoid.
  //
  // The entry's OWN expiration ledger is passed straight back in. This
  // is the SEP-43 contract: the dApp chose the authorisation's lifetime
  // and the user approved that lifetime, so the wallet must not extend
  // (or shorten) it while signing.
  const signed = await authorizeEntry(
    entry,
    keypair,
    addressCredentials.signatureExpirationLedger(),
    networkPassphrase,
  );

  // Byte-by-byte base64 rather than `.toXDR("base64")`: this app's
  // Hermes runtime miscodes Buffer#toString("base64") into a
  // comma-joined string with no thrown error, and a silently corrupt
  // signed entry is the worst possible failure here.
  return bytesToBase64(new Uint8Array(signed.toXDR()));
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : B64[b2 & 63];
  }
  return out;
}
