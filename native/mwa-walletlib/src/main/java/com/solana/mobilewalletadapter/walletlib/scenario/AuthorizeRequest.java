/*
 * Copyright (c) 2022 Solana Mobile Inc.
 */

package com.solana.mobilewalletadapter.walletlib.scenario;

import android.net.Uri;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.Size;

import com.solana.mobilewalletadapter.common.ProtocolContract;
import com.solana.mobilewalletadapter.common.signin.SignInWithSolana;
import com.solana.mobilewalletadapter.common.util.Identifier;
import com.solana.mobilewalletadapter.common.util.NotifyingCompletableFuture;
import com.solana.mobilewalletadapter.walletlib.protocol.MobileWalletAdapterServer;

public class AuthorizeRequest
        extends BaseScenarioRequest<NotifyingCompletableFuture<AuthorizeRequest.Result>> {
    private static final String TAG = AuthorizeRequest.class.getSimpleName();

    @Nullable
    protected final String mIdentityName;

    @Nullable
    protected final Uri mIdentityUri;

    @Nullable
    protected final Uri mIconUri;

    @NonNull
    protected final String mChain;

    @Nullable
    protected final String[] mFeatures;

    @Nullable
    protected final String[] mAddresses;

    @Nullable
    protected final SignInWithSolana.Payload mSignInPayload;

    /** TakumiPay fork: the server request, for origin attestation (token + challenge binding). */
    @NonNull
    protected final MobileWalletAdapterServer.AuthorizeRequest mServerRequest;

    /*package*/ AuthorizeRequest(@NonNull NotifyingCompletableFuture<Result> request,
                                 @NonNull MobileWalletAdapterServer.AuthorizeRequest serverRequest,
                                 @Nullable String identityName,
                                 @Nullable Uri identityUri,
                                 @Nullable Uri iconUri,
                                 @NonNull String chain,
                                 @Nullable String[] features,
                                 @Nullable String[] addresses,
                                 @Nullable SignInWithSolana.Payload signInPayload) {
        super(request);
        mServerRequest = serverRequest;
        mIdentityName = identityName;
        mIdentityUri = identityUri;
        mIconUri = iconUri;
        mFeatures = features;
        mAddresses = addresses;
        mSignInPayload = signInPayload;

        if (Identifier.isValidIdentifier(chain)) {
            mChain = chain;
        } else {
            throw new IllegalArgumentException("Provided chain must be a valid chain identifier");
        }
    }

    @Nullable
    public String getIdentityName() {
        return mIdentityName;
    }

    @Nullable
    public Uri getIdentityUri() {
        return mIdentityUri;
    }

    @Nullable
    public Uri getIconRelativeUri() {
        return mIconUri;
    }

    @NonNull @Deprecated
    public String getCluster() {
        switch (mChain) {
            case ProtocolContract.CHAIN_SOLANA_MAINNET:
                return ProtocolContract.CLUSTER_MAINNET_BETA;
            case ProtocolContract.CHAIN_SOLANA_TESTNET:
                return ProtocolContract.CLUSTER_TESTNET;
            case ProtocolContract.CHAIN_SOLANA_DEVNET:
                return ProtocolContract.CLUSTER_DEVNET;
            default:
                return mChain;
        }
    }

    @NonNull
    public String getChain() {
        return mChain;
    }

    @Nullable
    public String[] getFeatures() { return  mFeatures; }

    @Nullable
    public String[] getAddresses() { return  mAddresses; }

    @Nullable
    public SignInWithSolana.Payload getSignInPayload() { return  mSignInPayload; }

    @Deprecated
    public void completeWithAuthorize(@NonNull byte[] publicKey,
                                      @Nullable String accountLabel,
                                      @Nullable Uri walletUriBase,
                                      @Nullable byte[] scope) {
        AuthorizedAccount[] accounts = new AuthorizedAccount[] {
                new AuthorizedAccount(publicKey, accountLabel, null, null, null)};
        mRequest.complete(new Result(accounts, walletUriBase, scope, null));
    }

    public void completeWithAuthorize(@NonNull AuthorizedAccount account, // TODO(#44): support multiple addresses
                                      @Nullable Uri walletUriBase,
                                      @Nullable byte[] scope,
                                      @Nullable SignInResult signInResult) {
        mRequest.complete(new Result(new AuthorizedAccount[] { account }, walletUriBase, scope, signInResult));
    }

    public void completeWithDecline() {
        mRequest.complete(null);
    }

    // ── TakumiPay fork: origin attestation ──────────────────────────────

    /** The {@code attest_origin} token the dapp endpoint retried with, or {@code null}. */
    @Nullable
    public String getAttestOrigin() {
        return mServerRequest.attestOrigin;
    }

    /**
     * The expected {@code h} for {@code challenge}
     * ({@code base64(SHA256("attest-origin" || challenge || session_secret))}),
     * or {@code null} when no encrypted session secret is available.
     */
    @Nullable
    public String computeAttestOriginBinding(@NonNull byte[] challenge) {
        return mServerRequest.computeAttestOriginBinding(challenge);
    }

    /**
     * Answer with {@code ERROR_ATTEST_ORIGIN_ANDROID}: the dapp endpoint must load
     * {@code attestOriginUri}, obtain an attestation for {@code challenge} under
     * {@code context}, and retry {@code authorize} with {@code attest_origin}.
     */
    public void completeWithAttestOriginRequired(@NonNull String context,
                                                 @NonNull byte[] challenge,
                                                 @NonNull Uri attestOriginUri) {
        mRequest.completeExceptionally(new MobileWalletAdapterServer.AttestOriginRequiredException(
                context, challenge, attestOriginUri));
    }

    public void completeWithClusterNotSupported() {
        mRequest.completeExceptionally(new MobileWalletAdapterServer.ClusterNotSupportedException(
                "Unsupported or invalid cluster specified"));
    }

    /*package*/ static class Result {
        @NonNull @Size(min = 1)
        /*package*/ final AuthorizedAccount[] accounts;
        @Nullable
        /*package*/ final Uri walletUriBase;
        @Nullable
        /*package*/ final byte[] scope;
        @Nullable
        /*package*/ final SignInResult signInResult;

        private Result(@NonNull @Size(min = 1) AuthorizedAccount[] accounts,
                       @Nullable Uri walletUriBase,
                       @Nullable byte[] scope,
                       @Nullable SignInResult signInResult) {
            this.accounts = accounts;
            this.walletUriBase = walletUriBase;
            this.scope = scope;
            this.signInResult = signInResult;
        }
    }
}
