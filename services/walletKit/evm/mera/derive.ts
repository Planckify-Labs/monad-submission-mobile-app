/**
 * Mera passkey → EVM key derivation (docs/monad-metropolis-2026-spec.md §3.2).
 *
 * Pure and Node-testable: no React Native, no WebAuthn. The passkey
 * ceremony lives in `./passkeyWallet.ts`; this file only turns the
 * 32-byte PRF output Mera hands back into a `TWallet`.
 *
 * Derivation follows Mera's own documented recipe (PRF bytes → BIP-39
 * mnemonic → BIP-32/44 secp256k1 key) rather than using the PRF bytes
 * as a raw scalar, for two reasons:
 *   - the standard `m/44'/60'/0'/0/0` path means the account is
 *     recoverable by any BIP-39 wallet if the user ever exports it, and
 *   - `entropyToMnemonic` is the same primitive the rest of this repo
 *     already trusts for seed handling (`walletService.ts`).
 *
 * The resulting row is `type: "Passkey"`, carries ONLY `privateKey`
 * (never `seedPhrase`), and is `eip155`-only. Deliberate: a
 * `seedPhrase` on the row would make `useWallet`'s missing-namespace
 * backfill auto-mint Solana / Sui / Stellar siblings, and the spec
 * scopes Mera to an additive, EVM-only onboarding path (§0 non-goals).
 *
 * Determinism: same passkey + same rpId + Mera's fixed PRF salt ⇒ same
 * PRF output ⇒ same address on every device. That property is what
 * makes "no seed phrase" an honest claim.
 */

import { entropyToMnemonic } from "@scure/bip39";
import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english";
import { bytesToHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import type { TPasskeyFields, TWallet } from "@/constants/types/walletTypes";

export const PASSKEY_RP_ID = "takumipay.xyz";
export const PASSKEY_RP_NAME = "TakumiPay";
export const DEFAULT_PASSKEY_WALLET_NAME = "Passkey Wallet";

export type DerivePasskeyWalletParams = {
  /** 32-byte WebAuthn PRF output from Mera. */
  prfOutput: Uint8Array;
  /** Non-secret credential metadata to persist on the row. */
  passkey: TPasskeyFields;
  name?: string;
};

/**
 * Builds the `Passkey` wallet row for a PRF output. Throws on a PRF
 * output that is not exactly 32 bytes (Mera guarantees 32, so a
 * mismatch means a caller bypassed it).
 */
export function derivePasskeyWallet({
  prfOutput,
  passkey,
  name,
}: DerivePasskeyWalletParams): TWallet {
  if (prfOutput.length !== 32) {
    throw new Error("derivePasskeyWallet: PRF output must be 32 bytes");
  }

  const mnemonic = entropyToMnemonic(prfOutput, englishWordlist);
  const hd = mnemonicToAccount(mnemonic);
  const privateKeyBytes = hd.getHdKey().privateKey;
  if (!privateKeyBytes) {
    throw new Error("derivePasskeyWallet: HD key has no private key");
  }
  const privateKey = bytesToHex(privateKeyBytes);

  return {
    // `account` is stripped on persist (`walletService.stripAccount`);
    // keep the same non-secret shape every other EVM row carries.
    account: { address: hd.address },
    address: hd.address,
    privateKey,
    name: name || DEFAULT_PASSKEY_WALLET_NAME,
    balance: "0",
    source: "Created",
    type: "Passkey",
    namespace: "eip155",
    passkey,
  };
}
