/*
 * Copyright (c) 2022 Solana Mobile Inc.
 */

package com.solana.mobilewalletadapter.common.crypto;

import androidx.annotation.NonNull;

import java.security.InvalidKeyException;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public class HKDF {
    @NonNull
    public static byte[] hkdfSHA256L16(@NonNull byte[] ikm, @NonNull byte[] salt) {
        try {
            // Step 1: extract
            final Mac hmacSHA256 = Mac.getInstance("HmacSHA256");
            hmacSHA256.init(new SecretKeySpec(salt, "HmacSHA256"));
            final byte[] prk = hmacSHA256.doFinal(ikm);

            // Step 2: expand
            // Note: N = ceil(L/N) = ceil(16/32) = 1, so only one iteration is required
            hmacSHA256.init(new SecretKeySpec(prk, "HmacSHA256"));
            return Arrays.copyOf(hmacSHA256.doFinal(new byte[] { 0x01 }), 16); // first iteration has a 0-byte T input
        } catch (NoSuchAlgorithmException | InvalidKeyException e) {
            throw new UnsupportedOperationException("Error deriving key material", e);
        }
    }

    /**
     * TakumiPay fork: general HKDF-SHA256 (RFC 5869) with an {@code info}
     * string and {@code L <= 255 * 32} output bytes. Used to derive the
     * origin-attestation binding secret alongside the AES session key.
     */
    @NonNull
    public static byte[] hkdfSHA256(@NonNull byte[] ikm,
                                    @NonNull byte[] salt,
                                    @NonNull byte[] info,
                                    int length) {
        if (length <= 0 || length > 255 * 32) {
            throw new IllegalArgumentException("Invalid HKDF output length");
        }
        try {
            final Mac hmacSHA256 = Mac.getInstance("HmacSHA256");
            hmacSHA256.init(new SecretKeySpec(salt, "HmacSHA256"));
            final byte[] prk = hmacSHA256.doFinal(ikm);

            hmacSHA256.init(new SecretKeySpec(prk, "HmacSHA256"));
            final byte[] okm = new byte[length];
            byte[] t = new byte[0];
            int offset = 0;
            for (int i = 1; offset < length; i++) {
                hmacSHA256.update(t);
                hmacSHA256.update(info);
                hmacSHA256.update((byte) i);
                t = hmacSHA256.doFinal();
                final int n = Math.min(t.length, length - offset);
                System.arraycopy(t, 0, okm, offset, n);
                offset += n;
            }
            return okm;
        } catch (NoSuchAlgorithmException | InvalidKeyException e) {
            throw new UnsupportedOperationException("Error deriving key material", e);
        }
    }

    private HKDF() {}
}
