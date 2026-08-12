/**
 * `installStellarSigner` — wires the dApp-bridge's `StellarAdapter` to
 * the already-shipped `getStellarSignerForWallet` dwell site
 * (`services/walletService.ts:613`) so in-WebView Stellar dApps
 * (Freighter-protocol) can `signTransaction`/`signMessage` through the
 * same key path the mobile UI's send flow uses.
 *
 * Spec reference: `docs/stellar-dapp-bridge-spec.md` §10, §11; mirrors
 * `services/chains/sui/signer.ts#installSuiSigner`.
 *
 * Security gate (TWV-2026-ZZZ):
 *   - The signer reaches the keypair through `getStellarSignerForWallet`
 *     — the dwell site introduced by `stellar-chain-support-spec.md`
 *     (TWV-2026-090), which already re-verifies the resolved keypair
 *     derives to the requested address. No second check needed here
 *     (unlike `installSuiSigner`'s `resolveCheckedSigner`, which
 *     re-verifies because `getSuiSignerForWallet` doesn't).
 *   - Base64 encode of the signed envelope MUST go through
 *     `transactionToBase64Xdr` (`./horizonClient.ts`), never
 *     `tx.toXDR()` directly — the latter reintroduces
 *     `[[feedback_hermes_ambient_buffer_base64_bug]]`, a bug that
 *     already shipped once and was only caught by live on-device
 *     reproduction.
 *   - No private material logged. On error, only a bounded `__DEV__`
 *     breadcrumb is emitted.
 *
 * Any PR that adds a sign code path bypassing `getStellarSignerForWallet`
 * MUST cite TWV-2026-ZZZ in the PR description.
 */

import type { Transaction } from "@stellar/stellar-base";
import { TransactionBuilder } from "@stellar/stellar-base";

import type { StellarChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import { walletKitRegistry } from "@/services/walletKit/registry";
import { getStellarSignerForWallet } from "@/services/walletService";
import { signAuthEntry as signSorobanAuthEntry } from "./authEntry";
import type { StellarHorizonClient } from "./horizonClient";
import { transactionToBase64Xdr } from "./horizonClient";
import { registerStellarSigner, type StellarSignerFns } from "./StellarAdapter";

export interface InstallStellarSignerDeps {
  /**
   * Resolve the `TWallet` row for an address the dApp passed in. The
   * adapter does this lookup so the signer can stay address-agnostic.
   */
  getWalletByAddress: (addr: string) => TWallet | undefined;
  /**
   * Build a Horizon client bound to `chain`. Only reached down the
   * `submit === true` branch (§1.8) — the default sign-only path never
   * resolves a client at all. Reuses `getHorizonClient`
   * (`./horizonClient.ts`), already shipped by
   * `stellar-chain-support-spec.md` — no new RPC plumbing.
   */
  getHorizonClient: (chain: StellarChainConfig) => StellarHorizonClient;
}

/**
 * Install the kit-backed Stellar signer into `StellarAdapter`. Idempotent
 * at the registration seam (`registerStellarSigner` overwrites), but the
 * intent is to call this exactly once after `createStellarAdapter()` in
 * `services/bridge/boot.ts`.
 */
export function installStellarSigner(deps?: InstallStellarSignerDeps): void {
  if (!deps) return;
  if (!walletKitRegistry.has("stellar")) return;

  async function resolveSigner(
    address: string,
  ): Promise<
    NonNullable<Awaited<ReturnType<typeof getStellarSignerForWallet>>>
  > {
    const wallet = deps!.getWalletByAddress(address);
    if (!wallet) throw new Error("Unknown wallet");
    const keypair = await getStellarSignerForWallet(wallet);
    if (!keypair) throw new Error("No Stellar signer");
    // getStellarSignerForWallet already re-verifies
    // keypair.publicKey() === wallet.address internally (TWV-2026-090)
    // — no second check needed here.
    return keypair;
  }

  const handlers: StellarSignerFns = {
    signTransaction: async (address, xdr, networkPassphrase, opts) => {
      try {
        const keypair = await resolveSigner(address);
        // Phase K — fee-bump envelopes are accepted now. `fromXDR`
        // returns `Transaction | FeeBumpTransaction`; both expose
        // `sign`, and the sheet renders the inner/outer split so the
        // user can see they are signing as fee source rather than as
        // the author of the operations.
        const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
        tx.sign(keypair);
        // NEVER tx.toXDR() directly — Hermes ambient-Buffer base64 bug.
        // Reuse the already-shipped, already-tested helper.
        const signedTxXdr = transactionToBase64Xdr(tx);
        if (!opts.submit) return { signedTxXdr, signerAddress: address };
        // §1.8 — submitUrl is intentionally never consulted; always our
        // own configured Horizon for the connected wallet's chain.
        const horizon = deps!.getHorizonClient(opts.chain);
        const { hash } = await horizon.submitTransaction(tx);
        return { signedTxXdr, signerAddress: address, hash };
      } catch (err) {
        if (typeof __DEV__ !== "undefined" && __DEV__) {
          console.error("[Stellar bridge signer] signTransaction failed");
        }
        throw err;
      }
    },

    signMessage: async (address, message) => {
      try {
        const keypair = await resolveSigner(address);
        // Confirmed on-device (spec §10.1): unlike `.toString("base64")`
        // (the bug `transactionToBase64Xdr` works around), `.toString("hex")`
        // on this app's Hermes runtime is NOT affected — no custom
        // helper needed here.
        const raw = keypair.sign(Buffer.from(message, "utf8"));
        const signedMessage = raw.toString("hex");
        return { signedMessage, signerAddress: address };
      } catch (err) {
        if (typeof __DEV__ !== "undefined" && __DEV__) {
          console.error("[Stellar bridge signer] signMessage failed");
        }
        throw err;
      }
    },

    // SEP-43 `signAuthEntry` — spec phase I. The preimage construction
    // and the Hermes-safe base64 both live in `authEntry.ts`; this stays
    // a thin wrapper so the keypair never leaves this module's dwell
    // site (TWV-2026-090).
    signAuthEntry: async (address, authEntryXdr, networkPassphrase) => {
      try {
        const keypair = await resolveSigner(address);
        const signedAuthEntry = await signSorobanAuthEntry(
          authEntryXdr,
          networkPassphrase,
          keypair,
        );
        return { signedAuthEntry, signerAddress: address };
      } catch (err) {
        if (typeof __DEV__ !== "undefined" && __DEV__) {
          console.error("[Stellar bridge signer] signAuthEntry failed");
        }
        throw err;
      }
    },
  };

  registerStellarSigner(handlers);
}
