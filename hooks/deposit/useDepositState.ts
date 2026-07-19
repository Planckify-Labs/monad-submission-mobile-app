import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo } from "react";
import { erc20Abi, formatUnits, maxUint256, parseUnits } from "viem";
import { authApi } from "@/api/endpoints/auth";
import type { TToken } from "@/api/types/token";
import { useTakumiWalletContract } from "@/contracts/hooks/useTakumiWalletContract";
import { useIsAuthenticated } from "@/hooks/queries/useAuth";
import { useBlockchains } from "@/hooks/queries/useBlockchains";
import { usePaymentContract } from "@/hooks/queries/usePaymentContract";
import {
  usePointPrice,
  useSubmitPointDeposit,
} from "@/hooks/queries/usePoints";
import { useSmartContractByChain } from "@/hooks/queries/useSmartContracts";
import { useTokens } from "@/hooks/queries/useTokens";
import useRQGlobalState from "@/hooks/useRQGlobalState";
import { useWallet } from "@/hooks/useWallet";
import { toChainTag } from "@/services/analytics/chainTag";
import { track } from "@/services/analytics/posthog";
import { executePointDepositStellar } from "@/services/nanopay/pathPointDepositStellar";

const DEPOSIT_STATE_KEY = ["deposit", "state"] as const;
const DEFAULT_CURRENCY = "IDR";

interface DepositState {
  selectedToken?: TToken;
  amount: string;
  isLoading: boolean;
  transactionStatus: string;
  error?: string;
  // App-level record of which (wallet, chain, spender, token) tuples the user
  // has explicitly chosen to trust via the "Trust this contract" checkbox.
  // On-chain allowance alone can't express consent — a wallet with residual
  // allowance from a prior flow should still see the modal until it opts in.
  trustedSpenders?: Record<string, true>;
}

const initialDepositState: DepositState = {
  selectedToken: undefined,
  amount: "",
  isLoading: false,
  transactionStatus: "",
  trustedSpenders: {},
};

function buildTrustKey(
  walletAddress: string,
  chainId: number,
  spender: string,
  tokenAddress: string,
): string {
  return `${walletAddress.toLowerCase()}:${chainId}:${spender.toLowerCase()}:${tokenAddress.toLowerCase()}`;
}

export function useDepositState() {
  const { data: state, setNewData: setState } = useRQGlobalState<DepositState>({
    queryKey: DEPOSIT_STATE_KEY,
    initialData: initialDepositState,
  });

  const {
    activeWallet,
    activeChain: rawActiveChain,
    getClientForActiveWallet,
    getPublicClientForActiveChain,
    getKitForWallet,
  } = useWallet();

  // Deposit flow supports the EVM smart-contract path and the Stellar
  // Soroban `deposit_points` path. `isEvm` drives the viem approve+deposit
  // flow; `isStellar` drives the Soroban path (no approval — the SAC transfer
  // is authorized inline by the tx envelope). Any other namespace has no
  // deposit path, so downstream queries stay disabled and DepositContent shows
  // `DepositUnsupportedChainModal`.
  //
  // `activeChainId` is the EVM numeric chainId (0 for non-EVM), which
  // short-circuits the EVM-only queries (useSmartContractByChain, viem
  // balances) via React Query's `enabled` flag.
  const isEvm = rawActiveChain.namespace === "eip155";
  const isStellar = rawActiveChain.namespace === "stellar";
  const activeChainId = isEvm ? rawActiveChain.chain.id : 0;

  const { isAuthenticated } = useIsAuthenticated();
  const { data: blockchains } = useBlockchains();

  const activeBackendChain = useMemo(() => {
    if (!blockchains) return null;
    if (isEvm) {
      return blockchains.find((b) => b.chainId === activeChainId) || null;
    }
    if (isStellar) {
      // Non-EVM rows have no numeric chainId; match the active Stellar network
      // to its backend row by chainSlug (`stellar-testnet` / `stellar-mainnet`)
      // + testnet flag.
      const wantTestnet = rawActiveChain.network !== "mainnet";
      return (
        blockchains.find(
          (b) =>
            !b.isEVM &&
            (b.chainSlug?.toLowerCase().startsWith("stellar") ?? false) &&
            b.isTestnet === wantTestnet,
        ) || null
      );
    }
    return null;
  }, [blockchains, activeChainId, isEvm, isStellar, rawActiveChain]);

  const { data: rawStablecoinTokens } = useTokens({
    isStablecoin: true,
    isActive: true,
    // Point deposits settle onchain the same way merchant payments do
    // (Phase 1 onchain-settlement rail) — only offer tokens ops has
    // explicitly enabled for that rail, mirroring `usePaymentTokens`
    // (the same gate `pay-merchant.tsx` uses).
    isPaymentEnabled: true,
    blockchainId: activeBackendChain?.id,
  });

  // Only offer tokens that
  //   1. live on the currently active backend chain — without this,
  //      an unknown-to-backend chain (e.g. Solana) would fall through
  //      `useTokens`' filter and surface every EVM stablecoin in the
  //      catalog, which is misleading.
  //   2. have a `peggedCurrency` configured on the server — tokens
  //      without it will return a 400 if used for deposits.
  const stablecoinTokens = useMemo(() => {
    if (!activeBackendChain) return [];
    return (
      rawStablecoinTokens?.filter(
        (t) => t.blockchainId === activeBackendChain.id && !!t.peggedCurrency,
      ) ?? []
    );
  }, [rawStablecoinTokens, activeBackendChain]);

  const selectedToken = state?.selectedToken;
  const amount = state?.amount ?? "";
  const isLoading = state?.isLoading ?? false;
  const transactionStatus = state?.transactionStatus ?? "";

  const { data: pointPrice } = usePointPrice({
    tokenId: selectedToken?.id ?? "",
    currency: DEFAULT_CURRENCY,
  });

  const { data: smartContract, isFetching: isEvmContractFetching } =
    useSmartContractByChain(activeChainId);
  const contractAddress = smartContract?.address as `0x${string}` | undefined;

  // Stellar resolves its `takumi_pay` contract by backend blockchainId (no
  // numeric chainId). `usePaymentContract` is the same resolver the merchant
  // -payment screen uses.
  const { data: stellarContract, isFetching: isStellarContractFetching } =
    usePaymentContract({
      blockchainId: isStellar ? activeBackendChain?.id : undefined,
    });
  const stellarContractAddress = isStellar
    ? (stellarContract?.address as string | undefined)
    : undefined;

  // Unified deposit target: EVM `0x…` or Stellar `C…`. Drives `hasContract`,
  // input validation, and the Stellar deposit path. The EVM viem calls keep
  // using the narrowly-typed `contractAddress` directly.
  const depositContractAddress: string | undefined = isStellar
    ? stellarContractAddress
    : contractAddress;
  const isContractFetching = isStellar
    ? isStellarContractFetching
    : isEvmContractFetching;

  const { depositPoints, waitForTransaction } = useTakumiWalletContract({
    contractAddress: contractAddress ?? "0x0",
  });

  const submitDeposit = useSubmitPointDeposit();

  useEffect(() => {
    if (stablecoinTokens && stablecoinTokens.length > 0) {
      if (
        !selectedToken ||
        !stablecoinTokens.some((t) => t.id === selectedToken?.id)
      ) {
        setState({
          ...initialDepositState,
          ...state,
          selectedToken: stablecoinTokens[0],
        });
      }
    } else if (selectedToken) {
      setState({ ...initialDepositState, ...state, selectedToken: undefined });
    }
  }, [stablecoinTokens, selectedToken, setState, state]);

  const updateState = useCallback(
    (partial: Partial<DepositState>) => {
      setState({ ...initialDepositState, ...state, ...partial });
    },
    [state, setState],
  );

  const setSelectedToken = useCallback(
    (token: TToken) => updateState({ selectedToken: token, error: undefined }),
    [updateState],
  );

  const setAmount = useCallback(
    (value: string) => updateState({ amount: value, error: undefined }),
    [updateState],
  );

  const setQuickAmount = useCallback(
    (value: string) => updateState({ amount: value, error: undefined }),
    [updateState],
  );

  // Clear errors when the user switches chains (contract availability changes)
  useEffect(() => {
    if (state?.error) {
      updateState({ error: undefined });
    }
  }, [state?.error, updateState]);

  // Calculate how many tokens needed for the requested points
  const tokenAmountNeeded = useMemo(() => {
    if (!pointPrice || !amount || !selectedToken) return null;
    const points = parseInt(amount, 10);
    if (isNaN(points) || points <= 0) return null;

    const tokenPerPoint = parseFloat(pointPrice.tokenPerPoint);
    const humanTokenAmount = points * tokenPerPoint;
    const rawAmount = parseUnits(
      humanTokenAmount.toFixed(selectedToken.decimals),
      selectedToken.decimals,
    );
    return { human: humanTokenAmount, raw: rawAmount };
  }, [pointPrice, amount, selectedToken]);

  // --- Wallet Balances ---
  const {
    data: nativeBalance = BigInt(0),
    isFetching: isFetchingNativeBalance,
  } = useQuery({
    queryKey: [
      "nativeBalance",
      activeWallet.address,
      activeChainId,
      rawActiveChain.namespace,
    ],
    queryFn: async () => {
      if (!activeWallet.address) return BigInt(0);
      // Non-EVM chains read balances through the kit adapter, not viem.
      if (isStellar) {
        const kit = getKitForWallet(activeWallet);
        return (
          (await kit.getNativeBalance?.(
            activeWallet.address,
            rawActiveChain,
          )) ?? BigInt(0)
        );
      }
      const publicClient = getPublicClientForActiveChain();
      if (!publicClient) return BigInt(0);
      return publicClient.getBalance({
        address: activeWallet.address as `0x${string}`,
      });
    },
    enabled: !!activeWallet.address,
    refetchInterval: 30_000,
  });

  const { data: tokenBalance = BigInt(0), isFetching: isFetchingTokenBalance } =
    useQuery({
      queryKey: [
        "stablecoinBalance",
        activeWallet.address,
        selectedToken?.contractAddress,
        activeChainId,
        rawActiveChain.namespace,
      ],
      queryFn: async () => {
        if (!activeWallet.address || !selectedToken) return BigInt(0);
        if (isStellar) {
          if (!selectedToken.contractAddress) return BigInt(0);
          const kit = getKitForWallet(activeWallet);
          return (
            (await kit.getTokenBalance?.(
              activeWallet.address,
              rawActiveChain,
              selectedToken.contractAddress,
            )) ?? BigInt(0)
          );
        }
        const publicClient = getPublicClientForActiveChain();
        if (!publicClient) return BigInt(0);
        return publicClient.readContract({
          address: selectedToken.contractAddress as `0x${string}`,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [activeWallet.address as `0x${string}`],
        }) as Promise<bigint>;
      },
      enabled: !!activeWallet.address && !!selectedToken,
      refetchInterval: 30_000,
    });

  // Native decimals: EVM = 18, Stellar (XLM) = 7 stroops (spec §3.8).
  const nativeBalanceFormatted = useMemo(
    () => parseFloat(formatUnits(nativeBalance, isStellar ? 7 : 18)).toFixed(6),
    [nativeBalance, isStellar],
  );

  const tokenBalanceFormatted = useMemo(() => {
    if (!selectedToken) return "0";
    return parseFloat(
      formatUnits(tokenBalance, selectedToken.decimals),
    ).toFixed(4);
  }, [tokenBalance, selectedToken]);

  const hasInsufficientNative = nativeBalance === BigInt(0);
  const hasInsufficientToken = useMemo(() => {
    if (tokenBalance === BigInt(0)) return true;
    if (tokenAmountNeeded && tokenBalance < tokenAmountNeeded.raw) return true;
    return false;
  }, [tokenBalance, tokenAmountNeeded]);

  const validateInputs = useCallback(() => {
    const minimumPoints = pointPrice?.minimumPoints ?? 15000;
    const points = parseInt(amount, 10);
    if (isNaN(points) || points < minimumPoints) {
      updateState({
        error: `Minimum is ${minimumPoints.toLocaleString()} points`,
      });
      return false;
    }
    if (!selectedToken) {
      updateState({ error: "Please select a token" });
      return false;
    }
    if (!depositContractAddress) {
      updateState({ error: "No contract found for this chain" });
      return false;
    }
    if (!tokenAmountNeeded) {
      updateState({ error: "Unable to calculate token amount" });
      return false;
    }
    return true;
  }, [
    amount,
    selectedToken,
    depositContractAddress,
    tokenAmountNeeded,
    pointPrice,
    updateState,
  ]);

  const checkApprovalNeeded = useCallback(async (): Promise<{
    ok: boolean;
    needsApproval: boolean;
  }> => {
    if (!validateInputs()) return { ok: false, needsApproval: false };
    // Stellar: no ERC-20-style allowance. The Soroban SAC transfer is
    // authorized inline by the deposit tx envelope, so go straight to confirm.
    if (isStellar) return { ok: true, needsApproval: false };
    if (!selectedToken || !tokenAmountNeeded || !contractAddress) {
      return { ok: false, needsApproval: false };
    }
    if (!activeWallet.address) {
      updateState({ error: "Wallet not connected" });
      return { ok: false, needsApproval: false };
    }
    const trustKey = buildTrustKey(
      activeWallet.address,
      activeChainId,
      contractAddress,
      selectedToken.contractAddress!,
    );
    const isTrusted = !!state?.trustedSpenders?.[trustKey];
    // Until the user explicitly trusts this spender for this wallet, always
    // prompt — on-chain allowance alone is not consent and residual allowance
    // from prior flows must not silently skip the modal.
    if (!isTrusted) {
      return { ok: true, needsApproval: true };
    }
    const publicClient = getPublicClientForActiveChain();
    if (!publicClient) {
      updateState({ error: "Wallet not connected" });
      return { ok: false, needsApproval: false };
    }
    try {
      const currentAllowance = (await publicClient.readContract({
        address: selectedToken.contractAddress as `0x${string}`,
        abi: erc20Abi,
        functionName: "allowance",
        args: [activeWallet.address as `0x${string}`, contractAddress],
      })) as bigint;
      return {
        ok: true,
        needsApproval: currentAllowance < tokenAmountNeeded.raw,
      };
    } catch (err) {
      updateState({ error: "Could not read token allowance." });
      return { ok: false, needsApproval: false };
    }
  }, [
    validateInputs,
    isStellar,
    selectedToken,
    tokenAmountNeeded,
    contractAddress,
    getPublicClientForActiveChain,
    activeWallet.address,
    activeChainId,
    state?.trustedSpenders,
    updateState,
  ]);

  const handleDeposit = useCallback(
    async (options?: { approvalMode?: "exact" | "unlimited" }) => {
      // Redirect to auth if not signed in
      if (!isAuthenticated) {
        router.push("/auth");
        return;
      }

      // Warn if no contract found for this chain
      if (!depositContractAddress) {
        updateState({
          error:
            "Point deposits are not available on this network. Please switch to a supported chain.",
        });
        return;
      }

      if (!validateInputs()) return;
      if (!selectedToken || !tokenAmountNeeded || !activeBackendChain) return;

      // ── Stellar path: Soroban `deposit_points` (no ERC-20 approval) ──
      // The SAC transfer is authorized inline by the deposit tx envelope, so
      // there is no allowance/approve step. The orchestrator builds, signs,
      // submits, and confirms the invocation via the kit.
      if (isStellar) {
        const refId = `pt_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
        try {
          // Register the depositing G-address against the account so the
          // backend's ownership check accepts it as the payer (idempotent).
          updateState({
            isLoading: true,
            transactionStatus: "Preparing wallet...",
            error: undefined,
          });
          await authApi.linkWalletAddress(activeWallet.address);

          updateState({
            isLoading: true,
            transactionStatus: "Depositing to contract...",
          });
          const kit = getKitForWallet(activeWallet);
          const { txHash } = await executePointDepositStellar({
            wallet: activeWallet,
            walletKit: kit,
            chain: rawActiveChain,
            contractId: depositContractAddress,
            token: selectedToken.contractAddress!,
            refId,
            amount: tokenAmountNeeded.raw,
          });

          updateState({
            isLoading: true,
            transactionStatus: "Submitting for verification...",
          });
          await submitDeposit.mutateAsync({
            refId,
            txHash,
            tokenId: selectedToken.id,
            blockchainId: activeBackendChain.id,
            contractAddress: depositContractAddress,
            walletAddress: activeWallet.address,
            tokenAmount: tokenAmountNeeded.raw.toString(),
            expectedPoints: amount,
            currency: DEFAULT_CURRENCY,
          });

          track("deposit_completed", {
            chain: toChainTag(rawActiveChain.namespace),
            amount: Number(amount),
          });

          updateState({
            isLoading: true,
            transactionStatus: "Points are being credited...",
          });
          await new Promise((resolve) => setTimeout(resolve, 1000));
          router.back();
        } catch (error: any) {
          console.error("Stellar deposit error:", error);
          let errorMessage = "Deposit failed. Please try again.";
          try {
            const body = await error?.response?.json?.();
            const msg: string = body?.message ?? "";
            if (msg.toLowerCase().includes("no pegged currency")) {
              errorMessage = `${selectedToken?.symbol ?? "This token"} is not supported for point deposits. Please select a different token.`;
            }
          } catch {
            // swallow — generic message already set
          }
          updateState({
            isLoading: false,
            transactionStatus: "",
            error: errorMessage,
          });
        } finally {
          updateState({ isLoading: false, transactionStatus: "" });
        }
        return;
      }

      const walletClient = getClientForActiveWallet();
      const publicClient = getPublicClientForActiveChain();
      // Both accessors now return `null` on non-EVM chains (§7.5).
      // The EVM viem approve+deposit flow below requires the `0x…`
      // `contractAddress`; the Stellar path returned above.
      if (
        !walletClient ||
        !walletClient.account ||
        !publicClient ||
        !contractAddress
      ) {
        updateState({ error: "Wallet not connected" });
        return;
      }

      const refId = `pt_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;

      try {
        // Step 1: Check ERC20 allowance
        updateState({
          isLoading: true,
          transactionStatus: "Checking allowance...",
          error: undefined,
        });

        const currentAllowance = await publicClient.readContract({
          address: selectedToken.contractAddress as `0x${string}`,
          abi: erc20Abi,
          functionName: "allowance",
          args: [walletClient.account.address, contractAddress],
        });

        // Persist the user's trust choice so future deposits from this wallet
        // can skip the modal when on-chain allowance is still sufficient.
        if (options?.approvalMode === "unlimited") {
          const trustKey = buildTrustKey(
            activeWallet.address,
            activeChainId,
            contractAddress,
            selectedToken.contractAddress!,
          );
          updateState({
            trustedSpenders: {
              ...(state?.trustedSpenders ?? {}),
              [trustKey]: true,
            },
          });
        }

        // Step 2: Decide the approve target.
        //
        // ERC-20 `approve(spender, value)` overwrites the current allowance
        // (EIP-20), so when the user explicitly picks a mode we always write
        // that exact value — "exact" can therefore reduce a residual
        // unlimited allowance down to just the amount this deposit needs.
        // Without an explicit mode (trusted + allowance sufficient path), we
        // only top up when the current allowance falls short.
        let approvalAmount: bigint | null = null;
        if (options?.approvalMode === "unlimited") {
          approvalAmount = currentAllowance === maxUint256 ? null : maxUint256;
        } else if (options?.approvalMode === "exact") {
          approvalAmount =
            currentAllowance === tokenAmountNeeded.raw
              ? null
              : tokenAmountNeeded.raw;
        } else if (currentAllowance < tokenAmountNeeded.raw) {
          approvalAmount = tokenAmountNeeded.raw;
        }

        if (approvalAmount !== null) {
          updateState({
            isLoading: true,
            transactionStatus: "Approving token spend...",
          });

          const approveHash = await walletClient.writeContract({
            address: selectedToken.contractAddress as `0x${string}`,
            abi: erc20Abi,
            functionName: "approve",
            args: [contractAddress, approvalAmount],
            chain: walletClient.chain,
            account: walletClient.account,
          });

          await publicClient.waitForTransactionReceipt({ hash: approveHash });
        }

        // Step 3: Call depositPoints on smart contract
        updateState({
          isLoading: true,
          transactionStatus: "Depositing to contract...",
        });

        const txHash = await depositPoints.mutateAsync({
          tokenAddress: selectedToken.contractAddress as `0x${string}`,
          refId,
          amount: tokenAmountNeeded.raw.toString(),
          tokenDecimals: selectedToken.decimals,
        });

        // Step 4: Wait for transaction receipt
        updateState({
          isLoading: true,
          transactionStatus: "Waiting for confirmation...",
        });
        await waitForTransaction(txHash);

        // Step 5: Submit to API for verification
        updateState({
          isLoading: true,
          transactionStatus: "Submitting for verification...",
        });

        await submitDeposit.mutateAsync({
          refId,
          txHash,
          tokenId: selectedToken.id,
          blockchainId: activeBackendChain.id,
          contractAddress,
          walletAddress: activeWallet.address,
          tokenAmount: tokenAmountNeeded.raw.toString(),
          expectedPoints: amount,
          currency: DEFAULT_CURRENCY,
        });

        track("deposit_completed", {
          chain: toChainTag(rawActiveChain.namespace),
          amount: Number(amount),
        });

        // Step 6: Done -- navigate back
        updateState({
          isLoading: true,
          transactionStatus: "Points are being credited...",
        });

        await new Promise((resolve) => setTimeout(resolve, 1000));
        router.back();
      } catch (error: any) {
        console.error("Deposit error:", error);

        // Default to a generic message. We only surface curated copy for
        // server states we explicitly recognise — raw `body.message` or
        // `error.message` can be JSON blobs, RPC traces, or API config
        // errors (e.g. "STT_AI_API_KEY is not set on the server") which
        // must never reach the end user.
        let errorMessage = "Deposit failed. Please try again.";
        try {
          const body = await error?.response?.json?.();
          const msg: string = body?.message ?? "";
          if (msg.toLowerCase().includes("no pegged currency")) {
            errorMessage = `${selectedToken?.symbol ?? "This token"} is not supported for point deposits. Please select a different token.`;
          }
        } catch {
          // swallow — generic message already set
        }

        updateState({
          isLoading: false,
          transactionStatus: "",
          error: errorMessage,
        });
      } finally {
        updateState({ isLoading: false, transactionStatus: "" });
      }
    },
    [
      validateInputs,
      isStellar,
      selectedToken,
      contractAddress,
      depositContractAddress,
      tokenAmountNeeded,
      activeBackendChain,
      activeWallet,
      activeChainId,
      depositPoints,
      submitDeposit,
      waitForTransaction,
      getClientForActiveWallet,
      getPublicClientForActiveChain,
      getKitForWallet,
      amount,
      updateState,
      isAuthenticated,
      state?.trustedSpenders,
      rawActiveChain,
    ],
  );

  const resetState = useCallback(() => {
    setState(initialDepositState);
  }, [setState]);

  return {
    selectedToken,
    amount,
    isLoading,
    transactionStatus,
    error: state?.error,
    stablecoinTokens: stablecoinTokens ?? [],
    activeChain: rawActiveChain,
    pointPrice,
    tokenAmountNeeded,
    isAuthenticated,
    hasContract: !!depositContractAddress,
    isContractFetching,
    contractAddress: depositContractAddress,
    smartContract,
    // Balances
    nativeBalance,
    nativeBalanceFormatted,
    tokenBalance,
    tokenBalanceFormatted,
    hasInsufficientNative,
    hasInsufficientToken,
    isFetchingBalances: isFetchingNativeBalance || isFetchingTokenBalance,
    setSelectedToken,
    setAmount,
    setQuickAmount,
    handleDeposit,
    checkApprovalNeeded,
    resetState,
  };
}
