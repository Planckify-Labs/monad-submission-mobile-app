/**
 * SEP-53 message-signing framing (Stellar).
 *
 * Mirrors `api/src/auth/siws-stellar/sep53.ts` byte-for-byte — any
 * divergence means mobile auth signatures stop verifying on the server.
 *
 * Spec: https://stellar.org/protocol/sep-53
 *
 * SEP-53 domain-separates an off-chain *message* signature from a
 * *transaction* signature: the ed25519 signature is computed over
 *
 *     SHA-256( "Stellar Signed Message:\n" ‖ utf8(message) )
 *
 * never over the raw message bytes. The pre-SEP-53 path signed the raw
 * UTF-8 bytes, which left no separation between "I authorise this login"
 * and "I authorise this transaction" — a crafted message could in
 * principle collide with a transaction signing preimage. This is the one
 * Stellar-specific reason to prefer SEP-53 over a bare `keypair.sign`.
 */

import { hash } from "@stellar/stellar-base";

/** Canonical SEP-53 prefix — exact bytes, including the trailing newline. */
export const SEP53_PREFIX = "Stellar Signed Message:\n";

/**
 * The 32-byte digest an SEP-53 signature is computed over:
 * `SHA-256(prefix ‖ messageBytes)`. `@stellar/stellar-base`'s `hash` is
 * SHA-256 (the same primitive it uses for transaction hashing), so both
 * the mobile signer and the server verifier derive an identical digest.
 */
export function sep53Digest(message: string): Buffer {
  return hash(
    Buffer.concat([
      Buffer.from(SEP53_PREFIX, "utf8"),
      Buffer.from(message, "utf8"),
    ]),
  );
}
