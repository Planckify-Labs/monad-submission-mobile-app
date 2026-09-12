/*
 * TakumiPay fork of the Mobile Wallet Adapter walletlib (v2.0.2) — origin attestation.
 */

package com.solana.mobilewalletadapter.common.protocol;

import androidx.annotation.Nullable;

/**
 * Exposes the per-session secret both endpoints hold once the encrypted session
 * is established. The MWA spec binds origin-attestation challenges to the session
 * with {@code SHA256("attest-origin" || challenge || session_secret)} but does not
 * define {@code session_secret}; this fork defines it as
 * {@code HKDF-SHA256(ikm = ECDH shared secret, salt = X9.62 association public key,
 * info = "mwa-attest-origin", L = 32)}: derived next to the AES session key from
 * the same inputs, so both endpoints hold it after HELLO_REQ / HELLO_RSP and
 * neither has to export the AES key.
 */
public interface SessionSecretProvider {
    /** {@code null} until the encrypted session is established, or after it ends. */
    @Nullable
    byte[] getSessionSecret();
}
