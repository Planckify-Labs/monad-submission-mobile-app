import * as Clipboard from "expo-clipboard";
import { router, useLocalSearchParams } from "expo-router";
import {
  AlertTriangle,
  ArrowLeft,
  BookUser,
  ChevronDown,
  ClipboardCopy,
  Info,
  Loader,
  Send,
} from "lucide-react-native";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  ScrollView,
  StatusBar,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { parseUnits } from "viem";
import type { TToken } from "@/api/types/token";
import ChainSelector from "@/components/common/ChainSelector";
import LoadinngSpinnerPopup from "@/components/common/LoadinngSpinnerPopup";
import OptimizedImage from "@/components/common/OptimizedImage";
import PinConfirmationModal from "@/components/common/PinConfirmationModal";
import RecipientPickerModal from "@/components/send/RecipientPickerModal";
import TokenSelectorModal from "@/components/wallet/TokenSelectorModal";
import WalletSelectorModal from "@/components/wallet/WalletSelectorModal";
import { useIsAuthenticated } from "@/hooks/queries/useAuth";
import { useBlockchains } from "@/hooks/queries/useBlockchains";
import { useTokens } from "@/hooks/queries/useTokens";
import { useCreateTransaction } from "@/hooks/queries/useTransactions";
import { useAddressBook } from "@/hooks/useAddressBook";
import { usePreferredGasToken } from "@/hooks/usePreferredGasToken";
import { useWallet } from "@/hooks/useWallet";
import { buildChainConfigFromBlockchain } from "@/hooks/useWallet.helpers";
import { toChainTag } from "@/services/analytics/chainTag";
import { track } from "@/services/analytics/posthog";
import { pollRelayerTaskHash } from "@/services/gasAbstraction/pollTaskStatus";
import { resolveGasPayment } from "@/services/gasAbstraction/resolveGasPayment";
import { classifySuiRecipient } from "@/utils/walletUtils";

/**
 * Splits a `kit.formatNativeAmount` output into `[amount, symbol]`.
 *
 * `WalletKitAdapter.formatNativeAmount` returns `"<amount> <symbol>"`
 * (e.g. `"0.1234 ETH"` / `"0.1234 SOL"`) across every namespace — see
 * spec §7.6 / §7.7. Splitting here keeps the screen free of namespace
 * branches and makes the "amount only" and "symbol only" views
 * symbol-agnostic.
 */
function splitFormattedNative(formatted: string): {
  amount: string;
  symbol: string;
} {
  const trimmed = formatted.trim();
  const lastSpace = trimmed.lastIndexOf(" ");
  if (lastSpace === -1) {
    return { amount: trimmed, symbol: "" };
  }
  return {
    amount: trimmed.slice(0, lastSpace),
    symbol: trimmed.slice(lastSpace + 1),
  };
}

/**
 * Formats a raw token amount (smallest units) into a trimmed decimal
 * string — used to show the abstracted (USDC) gas fee on the success
 * screen. Mirrors the manual token-balance formatting below; kept here so
 * the screen stays namespace-agnostic (no viem `formatUnits` import path
 * difference between native and token).
 */
function formatTokenAtoms(raw: bigint, decimals: number): string {
  if (decimals <= 0) return raw.toString();
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  const fracStr = frac.toString().padStart(decimals, "0");
  return `${whole.toString()}.${fracStr}`.replace(/\.?0+$/, "") || "0";
}

export default function SendScreen() {
  const {
    wallets,
    activeWallet,
    activeWalletIndex,
    setActiveWallet,
    activeChain,
    changeActiveChainToConfig,
    getActiveWalletKit,
  } = useWallet();

  // Resolve the active kit once (§7.7). All native-path reads, parses,
  // formats, validations, and transfers dispatch through this single
  // seam — no namespace branches inside the screen.
  const kit = getActiveWalletKit();

  // The kit assumes `activeChain.namespace === activeWallet.namespace`
  // (e.g. `SolanaWalletKit.formatNativeAmount` asserts a solana chain).
  // During a wallet/chain switch there's a render pass where the two
  // disagree before `useWallet`'s sync effect commits. Gate the screen
  // on this invariant — the render below short-circuits to a spinner
  // until the mismatch resolves.
  const kitMatchesChain = kit.namespace === activeChain.namespace;

  const { isAuthenticated } = useIsAuthenticated();
  const { preferredGasToken } = usePreferredGasToken();
  const { mutateAsync: createTransaction } = useCreateTransaction();
  const { data: blockchains } = useBlockchains();
  const activeBackendChain = React.useMemo(() => {
    if (!blockchains) return null;
    // EVM rows match by numeric chainId. Solana rows are flagged via
    // `isEVM: false`; match on the cluster in the backend row's name
    // (falls back to the first Solana row if the names disagree).
    // Token list filtering depends on `blockchainId`, so surfacing the
    // right backend row here also scopes the token picker to the
    // active network — same UX as pre-Solana builds.
    if (activeChain.namespace === "eip155") {
      return (
        blockchains.find((b) => b.chainId === activeChain.chain.id) || null
      );
    }
    if (activeChain.namespace === "solana") {
      // Disambiguate Solana rows from Sui (both `isEVM:false`) by
      // `chainSlug` prefix; fall back to a name heuristic for backends
      // that haven't shipped `chainSlug` yet.
      const wantsDevnet = activeChain.cluster === "devnet";
      const solanaRows = blockchains.filter(
        (b: (typeof blockchains)[number] & { chainSlug?: string | null }) => {
          if (b.isEVM !== false) return false;
          if (typeof b.chainSlug === "string")
            return b.chainSlug.startsWith("solana-");
          const name = (b.name ?? "").toLowerCase();
          return !name.startsWith("sui");
        },
      );
      const match =
        solanaRows.find((b) =>
          wantsDevnet
            ? b.name.toLowerCase().includes("devnet")
            : !b.name.toLowerCase().includes("devnet"),
        ) ?? solanaRows[0];
      return match ?? null;
    }
    if (activeChain.namespace === "sui") {
      // Mirror Solana's matcher: filter the non-EVM rows down to Sui
      // by `chainSlug` (preferred) or name heuristic, then pick the
      // testnet/mainnet row matching `activeChain.network`.
      const wantsTestnet = activeChain.network !== "mainnet";
      const suiRows = blockchains.filter(
        (b: (typeof blockchains)[number] & { chainSlug?: string | null }) => {
          if (b.isEVM !== false) return false;
          if (typeof b.chainSlug === "string")
            return b.chainSlug.startsWith("sui-");
          const name = (b.name ?? "").toLowerCase();
          const rpc = (b.rpcUrl ?? "").toLowerCase();
          return name.startsWith("sui") || rpc.includes("sui.io");
        },
      );
      const match =
        suiRows.find((b) => (wantsTestnet ? b.isTestnet : !b.isTestnet)) ??
        suiRows[0];
      return match ?? null;
    }
    if (activeChain.namespace === "stellar") {
      // Mirror the Sui matcher: filter the non-EVM rows down to Stellar
      // by `chainSlug` (preferred) or name heuristic, then pick the
      // testnet/mainnet row matching `activeChain.network`. This branch
      // was missing entirely, which is why the token picker showed "No
      // tokens available" for any Stellar chain (activeBackendChain
      // fell through to the final `return null`, so `tokenList` always
      // resolved to `[]`) — and, downstream, why the native XLM row's
      // logoUrl was never found, showing the letter-avatar fallback.
      const wantsTestnet = activeChain.network !== "mainnet";
      const stellarRows = blockchains.filter(
        (b: (typeof blockchains)[number] & { chainSlug?: string | null }) => {
          if (b.isEVM !== false) return false;
          if (typeof b.chainSlug === "string")
            return b.chainSlug.startsWith("stellar-");
          const name = (b.name ?? "").toLowerCase();
          const rpc = (b.rpcUrl ?? "").toLowerCase();
          return name.startsWith("stellar") || rpc.includes("stellar.org");
        },
      );
      const match =
        stellarRows.find((b) => (wantsTestnet ? b.isTestnet : !b.isTestnet)) ??
        stellarRows[0];
      return match ?? null;
    }
    return null;
  }, [blockchains, activeChain]);
  const { data: rawTokenList } = useTokens({
    blockchainId: activeBackendChain?.id,
  });
  // `useTokens` skips the `blockchainId` filter when the field is
  // undefined (e.g. active chain isn't present in the backend feed),
  // which would surface EVERY token in the catalog. Narrow explicitly
  // to the active backend chain so the picker never shows tokens the
  // user can't actually transfer on this network.
  const tokenList = useMemo(() => {
    if (!activeBackendChain) return [];
    return (
      rawTokenList?.filter((t) => t.blockchainId === activeBackendChain.id) ??
      []
    );
  }, [rawTokenList, activeBackendChain]);

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [balance, setBalance] = useState<bigint>(BigInt(0));
  const [walletModalVisible, setWalletModalVisible] = useState(false);
  const [isPinModalVisible, setIsPinModalVisible] = useState(false);
  const [isLoadingBalance, setIsLoadingBalance] = useState(true);
  const [isLoadingTokenBalance, setIsLoadingTokenBalance] = useState(false);
  const [tokenBalance, setTokenBalance] = useState<string>("0");
  const [transactionStatus, setTransactionStatus] = useState(
    "Preparing transaction...",
  );
  const [selectedToken, setSelectedToken] = useState<TToken | undefined>(
    undefined,
  );
  const [tokenModalVisible, setTokenModalVisible] = useState(false);
  const [recipientPickerVisible, setRecipientPickerVisible] = useState(false);
  // Pre-flight "can this address receive this asset" warning (spec
  // §4.1/§8.2 — Stellar trustlines). `kit.checkAssetReceivable` is an
  // optional capability; chains without a receiver-side opt-in step
  // (EVM/Solana/Sui) never populate this, so the banner below never
  // renders for them.
  const [assetReceivableWarning, setAssetReceivableWarning] = useState<
    string | null
  >(null);

  const { contacts: addressBookContacts } = useAddressBook();

  const { recipientAddress, namespace: scannedNamespaceParam } =
    useLocalSearchParams();
  const scannedNamespace =
    typeof scannedNamespaceParam === "string"
      ? scannedNamespaceParam
      : undefined;

  // Align the active chain with the scanned target's namespace. The
  // wallet itself is left alone — `changeActiveChainToConfig` runs
  // `pickWalletForChain` internally and atomically swaps the wallet
  // only when the namespace actually crosses (see `useWallet.ts`
  // `pickWalletForChain` / `changeActiveChainToConfig`). So same-
  // namespace scans keep the user's current wallet untouched.
  //
  // Policy:
  //   - EVM scan + already on EVM → no-op (preserve current chain).
  //   - EVM scan + on Solana → flip to first EVM backend row, which
  //     also flips the wallet to the first matching EVM wallet.
  //   - Solana scan → pin to Solana mainnet-beta (never devnet, even
  //     if devnet appears first in the feed). Wallet flips only if
  //     the user wasn't already on a Solana wallet.
  //
  // Ref guard prevents re-firing if the user navigates within /send.
  const didApplyScannedNamespaceRef = useRef(false);
  useEffect(() => {
    if (didApplyScannedNamespaceRef.current) return;
    if (!scannedNamespace) return;
    if (!blockchains) return;

    if (activeChain.namespace === "eip155" && scannedNamespace === "eip155") {
      didApplyScannedNamespaceRef.current = true;
      return;
    }
    if (
      activeChain.namespace === "solana" &&
      scannedNamespace === "solana" &&
      activeChain.cluster === "mainnet-beta"
    ) {
      didApplyScannedNamespaceRef.current = true;
      return;
    }
    if (
      activeChain.namespace === "sui" &&
      scannedNamespace === "sui" &&
      activeChain.network === "mainnet"
    ) {
      didApplyScannedNamespaceRef.current = true;
      return;
    }
    if (
      activeChain.namespace === "stellar" &&
      scannedNamespace === "stellar" &&
      activeChain.network === "mainnet"
    ) {
      didApplyScannedNamespaceRef.current = true;
      return;
    }

    const matchesNs = (
      b: (typeof blockchains)[number] & { chainSlug?: string | null },
      ns: "solana" | "sui" | "stellar",
    ): boolean => {
      if (b.isEVM !== false) return false;
      if (typeof b.chainSlug === "string")
        return b.chainSlug.startsWith(`${ns}-`);
      const name = (b.name ?? "").toLowerCase();
      const rpc = (b.rpcUrl ?? "").toLowerCase();
      if (ns === "stellar")
        return name.startsWith("stellar") || rpc.includes("stellar.org");
      const looksSui = name.startsWith("sui") || rpc.includes("sui.io");
      return ns === "sui" ? looksSui : !looksSui;
    };

    const targetRow =
      scannedNamespace === "sui"
        ? blockchains.find((b) => matchesNs(b, "sui") && !b.isTestnet)
        : scannedNamespace === "solana"
          ? blockchains.find((b) => matchesNs(b, "solana") && !b.isTestnet)
          : scannedNamespace === "stellar"
            ? blockchains.find((b) => matchesNs(b, "stellar") && !b.isTestnet)
            : blockchains.find((b) => b.isEVM !== false);

    if (!targetRow) {
      didApplyScannedNamespaceRef.current = true;
      return;
    }

    didApplyScannedNamespaceRef.current = true;
    void changeActiveChainToConfig(buildChainConfigFromBlockchain(targetRow));
  }, [scannedNamespace, blockchains, activeChain, changeActiveChainToConfig]);

  // Presentation-only derived values — both come from the kit so EVM
  // and Solana display paths converge. Guard against the brief window
  // where kit and chain namespaces disagree (see `kitMatchesChain`
  // above) so the format call doesn't throw.
  const balanceDisplay = useMemo(
    () =>
      kitMatchesChain ? kit.formatNativeAmount(balance, activeChain) : "—",
    [kitMatchesChain, kit, balance, activeChain],
  );
  const { amount: balanceAmountText, symbol: nativeSymbol } = useMemo(
    () => splitFormattedNative(balanceDisplay),
    [balanceDisplay],
  );

  const spinValue = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    if (isLoading) {
      Animated.loop(
        Animated.timing(spinValue, {
          toValue: 1,
          duration: 1000,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      ).start();
    } else {
      spinValue.setValue(0);
    }
  }, [isLoading, spinValue]);

  const spin = spinValue.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  const fetchBalance = useCallback(async () => {
    if (!activeWallet?.address) return;
    // Skip the fetch while kit / chain namespaces are out of sync —
    // useWallet's sync effect will align them and a follow-up render
    // will retry.
    if (!kitMatchesChain) return;

    try {
      setIsLoadingBalance(true);
      const walletBalance = await kit.getNativeBalance(
        activeWallet.address,
        activeChain,
      );
      setBalance(walletBalance);
    } catch (error) {
      console.error("Error fetching balance:", error);
    } finally {
      setIsLoadingBalance(false);
    }
  }, [kit, kitMatchesChain, activeWallet?.address, activeChain]);

  useEffect(() => {
    fetchBalance();

    if (recipientAddress) {
      setRecipient(recipientAddress as string);
    }
    if (!selectedToken && tokenList && tokenList.length > 0) {
      setSelectedToken(tokenList[0]);
    }
  }, [fetchBalance, recipientAddress, tokenList, selectedToken]);

  useEffect(() => {
    const backendId = activeBackendChain?.id;
    if (!backendId) return;

    if (!selectedToken) {
      if (tokenList && tokenList.length > 0) {
        setSelectedToken(tokenList[0]);
      }
      return;
    }

    if (selectedToken.blockchainId !== backendId) {
      if (tokenList && tokenList.length > 0) {
        setSelectedToken(tokenList[0]);
      } else {
        setSelectedToken(undefined);
      }
    }
  }, [
    activeBackendChain?.id,
    selectedToken?.blockchainId,
    tokenList,
    selectedToken,
  ]);

  useEffect(() => {
    const fetchTokenBal = async () => {
      if (!activeWallet?.address || !selectedToken) {
        setTokenBalance("0");
        return;
      }

      if (
        selectedToken.isNativeCurrency !== false ||
        !selectedToken.contractAddress
      ) {
        // Native token balance mirrors the kit-formatted amount so the
        // display stays consistent with the balance pill.
        setTokenBalance(balanceAmountText);
        return;
      }

      try {
        setIsLoadingTokenBalance(true);
        const raw = await kit.getTokenBalance(
          activeWallet.address,
          activeChain,
          selectedToken.contractAddress,
        );
        const decimals = selectedToken.decimals ?? 18;
        const divisor = 10n ** BigInt(decimals);
        const whole = raw / divisor;
        const frac = raw % divisor;
        const fracStr = frac.toString().padStart(decimals, "0");
        setTokenBalance(
          `${whole.toString()}.${fracStr}`.replace(/\.?0+$/, "") || "0",
        );
      } catch (e) {
        console.error("Error fetching token balance:", e);
        setTokenBalance("0");
      } finally {
        setIsLoadingTokenBalance(false);
      }
    };

    fetchTokenBal();
  }, [
    activeWallet?.address,
    selectedToken,
    kit,
    activeChain,
    balanceAmountText,
  ]);

  // Pre-flight receivability check — only runs when the kit exposes
  // `checkAssetReceivable` (Stellar today) and the recipient + a
  // non-native token are both set. Presence-checked, no namespace
  // branch: chains without a receiver-side opt-in step simply never
  // populate `assetReceivableWarning`.
  useEffect(() => {
    if (!kit.checkAssetReceivable) {
      setAssetReceivableWarning(null);
      return;
    }
    if (
      !selectedToken ||
      selectedToken.isNativeCurrency !== false ||
      !selectedToken.contractAddress
    ) {
      setAssetReceivableWarning(null);
      return;
    }
    if (!recipient || !kit.validateAddress(recipient)) {
      setAssetReceivableWarning(null);
      return;
    }

    let cancelled = false;
    kit
      .checkAssetReceivable({
        chain: activeChain,
        to: recipient,
        contractAddress: selectedToken.contractAddress,
      })
      .then((result) => {
        if (cancelled) return;
        setAssetReceivableWarning(result.ok ? null : (result.reason ?? null));
      })
      .catch(() => {
        // Best-effort — never block the send flow on a check failure
        // (e.g. a transient Horizon blip). The actual send still
        // surfaces a typed error if the precondition truly isn't met.
        if (!cancelled) setAssetReceivableWarning(null);
      });

    return () => {
      cancelled = true;
    };
  }, [kit, activeChain, recipient, selectedToken]);

  const handlePasteAddress = async () => {
    const text = await Clipboard.getStringAsync();
    if (text) setRecipient(text);
  };

  const handleMaxAmount = useCallback(async () => {
    if (!activeWallet?.address) return;
    if (!selectedToken?.isNativeCurrency) return;

    try {
      const max = await kit.estimateMaxTransferable({
        balance,
        chain: activeChain,
        from: activeWallet.address,
        to: recipient || undefined,
      });
      // Strip the symbol so only the numeric portion lands in the
      // amount input — matches the spec snippet in §7.7.
      const { amount: maxAmountText } = splitFormattedNative(
        kit.formatNativeAmount(max, activeChain),
      );
      setAmount(maxAmountText);
    } catch (error) {
      console.error("Error estimating max:", error);
    }
  }, [
    kit,
    activeWallet?.address,
    balance,
    activeChain,
    recipient,
    selectedToken?.isNativeCurrency,
  ]);

  const validateInputs = useCallback(() => {
    if (!recipient) {
      console.error("Error: Please enter a recipient address");
      return false;
    }

    if (!kit.validateAddress(recipient)) {
      // Sui §3.5: when the kit rejects, see if it's the pre-mainnet
      // 20-byte form so we can surface a migration-pointer message
      // instead of a generic "invalid address". Detection-only — we
      // never auto-convert (the legacy → canonical mapping is not 1:1
      // and silent conversion would lose funds).
      if (activeChain.namespace === "sui") {
        const verdict = classifySuiRecipient(recipient);
        if (!verdict.ok && verdict.kind === "legacy20") {
          if (__DEV__) console.error(`Error: ${verdict.message}`);
          return false;
        }
      }
      console.error("Error: Invalid recipient address for the active chain");
      return false;
    }

    if (!amount || parseFloat(amount) <= 0) {
      console.error("Error: Please enter a valid amount");
      return false;
    }

    if (selectedToken?.isNativeCurrency !== false) {
      const raw = kit.parseNativeAmount(amount, activeChain);
      if (raw <= 0n || raw > balance) {
        console.error(
          "Insufficient Balance:",
          `You don't have enough ${nativeSymbol || "funds"} to complete this transaction.`,
        );
        return false;
      }
    }

    if (assetReceivableWarning) {
      Alert.alert("Can't send yet", assetReceivableWarning);
      return false;
    }

    return true;
  }, [
    kit,
    amount,
    balance,
    recipient,
    activeChain,
    selectedToken?.isNativeCurrency,
    nativeSymbol,
    assetReceivableWarning,
  ]);

  const handleSend = useCallback(async () => {
    if (!validateInputs()) return;

    setIsPinModalVisible(true);
  }, [validateInputs]);

  const handlePinConfirm = async (pin: string) => {
    console.log("Transaction confirmed with PIN:", pin);

    setIsPinModalVisible(false);
    setIsLoading(true);
    setTransactionStatus("Preparing transaction...");

    await new Promise((resolve) => setTimeout(resolve, 100));

    try {
      setTransactionStatus("Initializing wallet...");

      let hash: string;
      // What the user paid network gas in — surfaced on the success
      // screen. Symbol is always known; the amount is exact only on the
      // abstracted (USDC) path, where the relayer locks the fee.
      let gasFeeSymbol = nativeSymbol;
      let gasFeeAmount = "";
      if (selectedToken && selectedToken.isNativeCurrency === false) {
        setTransactionStatus("Building transaction...");
        const decimals = selectedToken.decimals ?? 18;
        const tokenAmount = parseUnits(amount, decimals);
        const contractAddress = selectedToken.contractAddress!;

        // Decide how gas is paid (USDC abstraction vs native) via the
        // single gas-payment policy — the same seam the agent uses. No
        // chain/provider branching here.
        const intent = {
          to: recipient,
          tokenAddress: contractAddress,
          amount: tokenAmount,
          decimals,
          memo: "takumipay-send",
        };
        const plan = await resolveGasPayment({
          wallet: activeWallet,
          chain: activeChain,
          intent,
          preferredGasToken,
        });

        if (plan.mode === "blocked") {
          // Prefer USDC, else block — never silently spend native gas.
          setIsLoading(false);
          Alert.alert(
            "Not enough USDC",
            "You don't have enough USDC to cover this transfer plus the network fee. Add USDC, or switch your gas token to native in Gas Settings.",
          );
          return;
        }

        if (plan.mode === "abstracted") {
          try {
            setTransactionStatus("Paying gas in USDC…");
            const execResult = await plan.provider.execute({
              wallet: activeWallet,
              chain: activeChain,
              intent,
            });
            // Show the exact, price-locked gas fee in its token (USDC).
            const feeTokenInfo = execResult.feeToken ?? plan.quote.feeToken;
            gasFeeSymbol = feeTokenInfo.symbol;
            const feeAtoms = execResult.feeAmount ?? plan.quote.feeAmount;
            gasFeeAmount = formatTokenAtoms(feeAtoms, feeTokenInfo.decimals);
            setTransactionStatus("Relaying transaction…");
            hash = await pollRelayerTaskHash(
              plan.provider,
              activeChain,
              execResult.taskId,
            );
          } catch (relayErr) {
            if (__DEV__) console.warn("Abstracted transfer failed:", relayErr);
            setIsLoading(false);
            Alert.alert(
              "Transfer failed",
              "We couldn't complete your gasless transfer. Please try again.",
            );
            return;
          }
        } else {
          // Native gas path — unchanged.
          setTransactionStatus(
            `Sending ${amount} ${selectedToken.symbol} to the network...`,
          );
          hash = await kit.sendTokenTransfer({
            wallet: activeWallet,
            to: recipient,
            amount: tokenAmount,
            chain: activeChain,
            contractAddress,
            decimals,
          });
        }
      } else {
        // Native transfer — single path for every namespace.
        setTransactionStatus("Building transaction...");
        const lamports = kit.parseNativeAmount(amount, activeChain);
        setTransactionStatus(
          `Sending ${amount} ${nativeSymbol} to the network...`,
        );
        hash = await kit.sendNativeTransfer({
          wallet: activeWallet,
          to: recipient,
          amount: lamports,
          chain: activeChain,
        });
      }

      console.log("Transaction sent with hash:", hash);
      setTransactionStatus("Transaction complete!");

      try {
        if (isAuthenticated && activeWallet?.address) {
          if (
            selectedToken &&
            selectedToken.isNativeCurrency === false &&
            selectedToken.contractAddress
          ) {
            const rawAmount = parseUnits(
              amount,
              selectedToken.decimals,
            ).toString();
            await createTransaction({
              contractAddress: selectedToken.contractAddress,
              blockchainId: selectedToken.blockchainId,
              type: "TRANSFER",
              amount: rawAmount,
              txHash: hash,
              fromAddress: activeWallet.address,
              toAddress: recipient,
            } as any);
          } else {
            const nativeTokenId =
              selectedToken?.id ??
              tokenList?.find((t) => t.isNativeCurrency)?.id;
            if (nativeTokenId) {
              const rawAmount = kit
                .parseNativeAmount(amount, activeChain)
                .toString();
              await createTransaction({
                tokenId: nativeTokenId,
                type: "TRANSFER",
                amount: rawAmount,
                txHash: hash,
                fromAddress: activeWallet.address,
                toAddress: recipient,
              });
            }
          }
        }
      } catch (historyErr) {
        console.warn("Failed to create transfer history:", historyErr);
      }

      console.log(
        "Transaction Sent:",
        `Transaction has been submitted. Hash: ${hash}`,
      );

      // Hand off to the dedicated success screen. `replace` so Done /
      // back from the success view pops to whatever was before /send,
      // not back to a stale form.
      const symbol =
        selectedToken && selectedToken.isNativeCurrency === false
          ? (selectedToken.symbol ?? "")
          : nativeSymbol;
      track("payment_sent", {
        chain: toChainTag(activeChain.namespace),
        token: symbol,
        amount: Number(amount),
      });
      router.replace({
        pathname: "/send-success",
        params: {
          amount,
          symbol,
          chainLabel: kit.formatChainLabel?.(activeChain) ?? "",
          recipientAddress: recipient,
          txHash: hash,
          explorerUrl: kit.buildTxExplorerUrl?.(hash, activeChain) ?? "",
          chainBackendName: activeBackendChain?.name ?? "",
          gasFeeSymbol,
          gasFeeAmount,
        },
      });
    } catch (error: any) {
      console.error("Send transaction error:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectWallet = (index: number) => {
    setActiveWallet(index);
    setWalletModalVisible(false);
  };

  // Transient-state guard: during a wallet ↔ chain switch there's a
  // render where `activeWallet.namespace !== activeChain.namespace`.
  // `useWallet` auto-aligns them in the next tick; render a spinner
  // here so kit methods (which assert the invariant) don't throw.
  if (!kitMatchesChain) {
    return (
      <>
        <StatusBar barStyle="dark-content" />
        <SafeAreaView
          className="flex-1 bg-light-main-container items-center justify-center"
          edges={["top"]}
        >
          <ActivityIndicator size="large" color="#c71c4b" />
          <Text className="text-light-matte-black/70 mt-3 text-sm">
            Switching network…
          </Text>
        </SafeAreaView>
      </>
    );
  }

  return (
    <>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView className="flex-1 bg-light-main-container" edges={["top"]}>
        <View className="flex-1 p-6">
          <View className="flex-row items-center mb-6">
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => router.back()}
              className="mr-4"
            >
              <ArrowLeft color="#c71c4b" size={24} />
            </TouchableOpacity>
            <Text className="text-light-matte-black text-xl font-bold">
              Send
            </Text>
          </View>

          <ScrollView showsVerticalScrollIndicator={false}>
            <View className="bg-light rounded-xl p-5 mb-6 shadow-sm">
              <View className="mb-6">
                <Text className="text-light-matte-black/70 mb-2">From</Text>
                <TouchableOpacity
                  activeOpacity={0.7}
                  className="bg-light-main-container p-4 rounded-xl flex-row items-center justify-between"
                  onPress={() => setWalletModalVisible(true)}
                >
                  <View>
                    <Text className="text-light-matte-black font-medium">
                      {activeWallet.name || "My Wallet"}
                    </Text>
                    <Text className="text-light-matte-black/60 text-xs">
                      {activeWallet?.address?.substring(0, 6)}...
                      {activeWallet?.address?.substring(
                        activeWallet.address.length - 4,
                      )}
                    </Text>
                  </View>
                  <View className="items-end">
                    {isLoadingBalance ? (
                      <ActivityIndicator size="small" color="#c71c4b" />
                    ) : (
                      <>
                        <Text className="text-light-matte-black">
                          {balanceDisplay}
                        </Text>
                        {selectedToken &&
                          selectedToken.isNativeCurrency === false && (
                            <Text className="text-light-matte-black/70 text-xs">
                              {isLoadingTokenBalance
                                ? "Loading token..."
                                : `${parseFloat(tokenBalance).toFixed(4)} ${selectedToken.symbol}`}
                            </Text>
                          )}
                      </>
                    )}
                    <ChevronDown size={16} color="#c71c4b" />
                  </View>
                </TouchableOpacity>
              </View>

              <View className="flex-row items-center justify-between mb-4">
                <Text className="text-light-matte-black font-medium">
                  Network
                </Text>
                <ChainSelector />
              </View>

              <View className="mb-6">
                <Text className="text-light-matte-black/70 mb-2">To</Text>
                <View className="flex-row items-center mb-2">
                  <TextInput
                    className="bg-light-main-container p-4 rounded-xl text-light-matte-black flex-1 mr-2"
                    value={recipient}
                    onChangeText={setRecipient}
                    placeholder="Enter wallet address"
                    placeholderTextColor="#20222c80"
                  />
                  <TouchableOpacity
                    activeOpacity={0.7}
                    className="bg-light-primary-red/10 p-3 rounded-xl"
                    onPress={handlePasteAddress}
                  >
                    <ClipboardCopy size={20} color="#c71c4b" />
                  </TouchableOpacity>
                </View>

                <TouchableOpacity
                  activeOpacity={0.7}
                  className="bg-light-primary-red/10 py-2 px-4 rounded-full flex-row items-center gap-1.5 self-start"
                  onPress={() => setRecipientPickerVisible(true)}
                >
                  <BookUser size={12} color="#c71c4b" />
                  <Text className="text-light-primary-red text-xs font-medium">
                    Choose recipient
                  </Text>
                </TouchableOpacity>
              </View>

              <View className="mb-6">
                <View className="flex-row items-center justify-between mb-2">
                  <Text className="text-light-matte-black/70">Amount</Text>
                  <TouchableOpacity
                    activeOpacity={0.7}
                    onPress={handleMaxAmount}
                  >
                    <Text className="text-light-primary-red text-xs font-medium">
                      MAX
                    </Text>
                  </TouchableOpacity>
                </View>
                <View className="flex-row items-center">
                  <TextInput
                    className="bg-light-main-container p-4 rounded-xl text-light-matte-black flex-1"
                    value={amount}
                    onChangeText={setAmount}
                    placeholder="0.0"
                    placeholderTextColor="#20222c80"
                    keyboardType="decimal-pad"
                  />
                  <TouchableOpacity
                    activeOpacity={0.7}
                    className="absolute right-2 px-2 py-1 rounded-lg bg-light-primary-red/10 flex-row items-center"
                    onPress={() => setTokenModalVisible(true)}
                  >
                    <View className="w-5 h-5 rounded-full mr-2 items-center justify-center overflow-hidden bg-light-primary-red/10">
                      {selectedToken?.logoUrl ? (
                        <OptimizedImage
                          source={{ uri: selectedToken.logoUrl }}
                          style={{ width: 20, height: 20 }}
                          contentFit="contain"
                        />
                      ) : (
                        <Text className="text-light-primary-red text-[10px] font-bold">
                          {(selectedToken?.symbol || nativeSymbol).charAt(0)}
                        </Text>
                      )}
                    </View>
                    <Text className="text-light-matte-black/70 font-medium">
                      {selectedToken?.symbol || nativeSymbol}
                    </Text>
                  </TouchableOpacity>
                </View>

                {selectedToken && selectedToken.isNativeCurrency === false && (
                  <View className="flex-row justify-end mt-1">
                    <Text className="text-light-matte-black/60 text-xs">
                      Balance:{" "}
                      {isLoadingTokenBalance
                        ? "Loading..."
                        : `${parseFloat(tokenBalance).toFixed(4)} ${selectedToken.symbol}`}
                    </Text>
                  </View>
                )}
              </View>

              {assetReceivableWarning && (
                <View className="bg-light-primary-red/10 p-4 rounded-xl mb-4">
                  <View className="flex-row items-start">
                    <AlertTriangle
                      size={18}
                      color="#c71c4b"
                      className="mr-2 mt-0.5"
                    />
                    <Text className="text-light-matte-black/80 text-sm flex-1">
                      {assetReceivableWarning}
                    </Text>
                  </View>
                </View>
              )}

              <View className="bg-light-primary-red/10 p-4 rounded-xl mb-6">
                <View className="flex-row items-start">
                  <Info size={18} color="#c71c4b" className="mr-2 mt-0.5" />
                  <Text className="text-light-matte-black/80 text-sm flex-1">
                    Double-check the recipient address before sending.
                    Transactions cannot be reversed.
                  </Text>
                </View>
              </View>
            </View>

            <TouchableOpacity
              activeOpacity={0.7}
              className={`bg-light-primary-red py-4 rounded-full items-center ${isLoading ? "opacity-70" : ""}`}
              onPress={handleSend}
              disabled={isLoading}
            >
              {isLoading ? (
                <View className="flex-row items-center">
                  <Animated.View
                    style={{ transform: [{ rotate: spin }], marginRight: 8 }}
                  >
                    <Loader size={20} color="#ffffff" />
                  </Animated.View>
                  <Text className="text-light font-bold">Processing...</Text>
                </View>
              ) : (
                <View className="flex-row items-center">
                  <Send size={20} color="#ffffff" className="mr-2" />
                  <Text className="text-light font-bold text-lg">Send</Text>
                </View>
              )}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </SafeAreaView>

      <LoadinngSpinnerPopup
        visible={isLoading}
        title="Processing Transaction"
        message={transactionStatus}
      />

      <WalletSelectorModal
        visible={walletModalVisible}
        onClose={() => setWalletModalVisible(false)}
        wallets={wallets}
        activeWalletIndex={activeWalletIndex}
        onSelectWallet={handleSelectWallet}
        title="Select Wallet"
      />

      <RecipientPickerModal
        visible={recipientPickerVisible}
        wallets={wallets}
        activeWalletIndex={activeWalletIndex}
        activeNamespace={activeChain.namespace}
        contacts={addressBookContacts}
        onClose={() => setRecipientPickerVisible(false)}
        onSelect={(address) => setRecipient(address)}
      />

      <PinConfirmationModal
        visible={isPinModalVisible}
        onClose={() => setIsPinModalVisible(false)}
        onConfirm={handlePinConfirm}
        title="Confirm Transaction"
      />

      {tokenList && (
        <TokenSelectorModal
          visible={tokenModalVisible}
          tokens={tokenList}
          onClose={() => setTokenModalVisible(false)}
          selectedToken={selectedToken}
          onSelectToken={(t) => setSelectedToken(t)}
          title="Select Token"
        />
      )}
    </>
  );
}
