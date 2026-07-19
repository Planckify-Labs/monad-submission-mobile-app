/**
 * Namespace-less fallback for folding a wallet address into a stable storage
 * key when the caller genuinely has no `Namespace` to hand (e.g. a local
 * SQLite key on a bare address string).
 *
 * Prefer `chainInfo#canonicalizeAddress(namespace, address)` /
 * `#addressesEqual` whenever a namespace is available — that dispatches the
 * per-chain rule through the wallet kit (the space-docking seam). This helper
 * only exists for leaf callers without one; it detects the case rule from the
 * address SHAPE rather than the chain:
 *   - `0x`-hex (EVM / Sui): case-insignificant → lowercase.
 *   - everything else (Solana base58, Stellar base32): case-SIGNIFICANT →
 *     verbatim. Lowercasing these yields a different, invalid address.
 */
export function foldAddressForKey(address: string): string {
  return /^0x[0-9a-fA-F]+$/.test(address) ? address.toLowerCase() : address;
}
