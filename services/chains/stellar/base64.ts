/**
 * Base64 encoding for raw bytes — deliberately NOT `Buffer.prototype
 * .toString("base64")`.
 *
 * Root cause this works around: `@stellar/js-xdr`'s `XdrWriter`
 * allocates via the AMBIENT GLOBAL `Buffer` (not an explicit
 * `import { Buffer } from "buffer"`), and `@stellar/stellar-base`'s
 * `Keypair.sign()` / `Transaction.toXDR()` both call
 * `.toString("base64")` on the result. Whatever `Buffer` resolves to
 * under this app's Hermes runtime does not correctly implement
 * `.toString("base64")` — confirmed empirically: it silently produced
 * a comma-joined decimal byte list (`Array.prototype.toString`'s
 * fallback, which ignores its argument) instead of a base64 string,
 * which broke both transaction submission (Horizon rejected it as
 * `transaction_malformed`) and would have broken SIWS-Stellar auth
 * signatures the same way.
 *
 * `btoa` is a genuine RN/Hermes global (unlike `Buffer`, which this
 * app never polyfills) — same fallback shape already proven for Sui's
 * `bytesToBase64` in `services/chains/sui/SuiAdapter.ts`. Every
 * Stellar call site that needs to base64-encode raw bytes MUST go
 * through this helper instead of `Buffer.prototype.toString("base64")`.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
}

/**
 * Inverse of {@link bytesToBase64} — `atob` on RN/Hermes, `Buffer` under
 * Node. Throws on malformed input (callers map that to their own typed
 * "malformed" outcome).
 */
export function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}
