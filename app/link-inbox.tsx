/**
 * `/link-inbox` — the deep-link interstitial (spec §6.5, §11).
 *
 * One screen for every held intent. It exists to show provenance the
 * user did not choose and to gate the network calls the user has not
 * consented to: nothing is fetched, built or signed until Continue.
 * Renders beneath `LockScreen` (it is a plain route in the Stack), so a
 * cold-start link waits behind the PIN.
 *
 * Chain-agnostic: everything chain-shaped comes from the held intent's
 * summary or from the kit registry (`displayName`, `buildPaymentRequest`).
 */

import { useIsFocused } from "@react-navigation/native";
import { router, useLocalSearchParams } from "expo-router";
import {
  ArrowLeft,
  Check,
  Link2,
  Wallet as WalletIcon,
} from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ProvenanceBanner } from "@/components/deeplinks/ProvenanceBanner";
import type { TWallet } from "@/constants/types/walletTypes";
import { useAddWalletPrompt } from "@/hooks/useAddWalletPrompt";
import { useWallet } from "@/hooks/useWallet";
import { readActiveBlockchainRows } from "@/services/blockchains/cache";
import { bindWallet, type WalletBinding } from "@/services/deeplinks/binding";
import {
  INTERSTITIAL_COPY,
  rejectCopy,
  UNSIGNED_REQUEST_COPY,
} from "@/services/deeplinks/copy";
import {
  chainLabelForNamespace,
  type ExecuteOutcome,
  executeHeldIntent,
} from "@/services/deeplinks/execute";
import { type InboxItem, linkInbox } from "@/services/deeplinks/inbox";
import { markConsumed } from "@/services/deeplinks/ledger";
import { sep7KeyPins } from "@/services/deeplinks/sep7KeyPins";
import type {
  DeepLinkIntent,
  SigningSummary,
} from "@/services/deeplinks/types";
import { chainBadgeLabel } from "@/services/walletKit/chainInfo";
import { authenticateUser } from "@/utils/authUtils";
import { truncateAddress } from "@/utils/walletUtils";

type Phase =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "outcome"; outcome: ExecuteOutcome };

function summaryOf(intent: DeepLinkIntent): SigningSummary | null {
  if (intent.kind === "payment" || intent.kind === "signing")
    return intent.summary;
  if (intent.kind === "pair") {
    return {
      title: "Connection request",
      chainLabel: "WalletConnect",
      lines: [],
    };
  }
  if (intent.kind === "associate") {
    return { title: "Connection request", chainLabel: "Solana", lines: [] };
  }
  if (intent.kind === "encrypted-link") {
    const isConnect = intent.method === "connect";
    return {
      title: isConnect ? "Connection request" : "Signing request",
      chainLabel: chainLabelForNamespace("solana"),
      lines: [],
    };
  }
  return null;
}

function namespaceOf(intent: DeepLinkIntent): TWallet["namespace"] | null {
  if ("namespace" in intent) return intent.namespace;
  return null;
}

function leave(): void {
  if (router.canGoBack()) router.back();
  else router.replace("/" as never);
}

export default function LinkInbox(): React.ReactElement {
  const { error: errorParam } = useLocalSearchParams<{ error?: string }>();
  const isFocused = useIsFocused();
  const { wallets, activeWallet } = useWallet();
  const { promptFor, sheet: addWalletSheet } = useAddWalletPrompt();

  const [items, setItems] = useState<InboxItem[]>(() => linkInbox.snapshot());
  useEffect(() => linkInbox.subscribe(setItems), []);
  const item = items[0] ?? null;

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [unsignedAck, setUnsignedAck] = useState(false);
  const [pickedAddress, setPickedAddress] = useState<string | null>(null);

  // Reset per item: a fresh link must never inherit the previous one's
  // acknowledgement or wallet pick.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `item?.id` is the reset trigger, not a value the body reads.
  useEffect(() => {
    setPhase({ kind: "idle" });
    setUnsignedAck(false);
    setPickedAddress(null);
  }, [item?.id]);

  const intent = item?.intent ?? null;
  const namespace = intent ? namespaceOf(intent) : null;
  const summary = intent ? summaryOf(intent) : null;
  const provenance =
    intent && "provenance" in intent ? intent.provenance : null;

  const binding: WalletBinding | null = useMemo(() => {
    if (!intent || !namespace) return null;
    if (intent.kind !== "payment" && intent.kind !== "signing") return null;
    return bindWallet({
      namespace,
      wallets,
      pinnedAccount:
        intent.kind === "signing" ? intent.pinnedAccount : undefined,
      // "Most recently used for that namespace" — the account of whatever
      // the user has on screen is the best available proxy; the wallet
      // itself is still chosen from the namespace's own list.
      preferredAccountId: activeWallet?.address,
    });
  }, [intent, namespace, wallets, activeWallet?.address]);

  const boundWallet: TWallet | null = useMemo(() => {
    if (!binding) return null;
    if (binding.kind === "bound") return binding.wallet;
    if (binding.kind === "pick") {
      return (
        binding.candidates.find((w) => w.address === pickedAddress) ??
        binding.defaultWallet
      );
    }
    return null;
  }, [binding, pickedAddress]);

  const dismiss = useCallback(() => {
    if (item) {
      markConsumed(item.envelope.raw);
      linkInbox.consume(item.id);
    }
    if (linkInbox.peek()) return; // next item renders in place
    leave();
  }, [item]);

  const proceed = useCallback(async () => {
    if (!item || !isFocused) return;
    setPhase({ kind: "working" });
    const outcome = await executeHeldIntent({
      item,
      wallet: boundWallet,
      deps: { chainRows: readActiveBlockchainRows },
    });
    linkInbox.consume(item.id);
    if (outcome.kind === "navigate") {
      router.replace({
        pathname: outcome.href as never,
        params: outcome.params,
      } as never);
      return;
    }
    if (outcome.kind === "handed-off" || outcome.kind === "user-rejected") {
      leave();
      return;
    }
    setPhase({ kind: "outcome", outcome });
  }, [item, isFocused, boundWallet]);

  // Class D never reaches the inbox, but if it does, honour it silently.
  // A Link Mode envelope (Phase 2b) is likewise invisible: the request it
  // carries surfaces as an approval sheet through the root host.
  useEffect(() => {
    if (!item || !isFocused) return;
    if (
      item.intent.kind === "navigate" ||
      item.intent.kind === "open-dapp" ||
      (item.intent.kind === "pair" && item.intent.linkMode === true)
    ) {
      void proceed();
    }
  }, [item, isFocused, proceed]);

  const rejectedView = (
    code: Parameters<typeof rejectCopy>[0],
    vars?: { domain?: string; chain?: string; asset?: string },
    data?: Record<string, unknown>,
  ) => {
    const copy = rejectCopy(code, vars);
    const onCta = () => {
      if (copy.cta === "Add wallet" && namespace) {
        promptFor(namespace);
        return;
      }
      if (copy.cta === "Open settings") {
        router.replace("/wallet" as never);
        return;
      }
      if (copy.cta === "Trust the new key") {
        // SEP-0007 rule 5: a changed signing key blocks until the user
        // explicitly accepts it, behind biometrics, then the request is
        // re-run from the start (fresh toml fetch, fresh verification).
        const domain = typeof data?.domain === "string" ? data.domain : null;
        const newKey = typeof data?.newKey === "string" ? data.newKey : null;
        if (!domain || !newKey) {
          dismiss();
          return;
        }
        void (async () => {
          const ok = await authenticateUser(
            `Trust the new signing key for ${domain}`,
          );
          if (!ok) return;
          sep7KeyPins.pin(domain, newKey);
          setPhase({ kind: "idle" });
        })();
        return;
      }
      dismiss();
    };
    return (
      <View className="bg-white rounded-2xl p-5">
        <Text className="text-lg font-bold text-light-matte-black">
          {copy.title}
        </Text>
        <Text className="text-sm text-light-matte-black/70 mt-2">
          {copy.body}
        </Text>
        <TouchableOpacity
          onPress={onCta}
          className="mt-5 py-3 rounded-2xl bg-light-primary-red items-center"
          accessibilityLabel="deeplink-reject-cta"
        >
          <Text className="text-white font-bold">{copy.cta}</Text>
        </TouchableOpacity>
        {copy.cta !== "Close" ? (
          <TouchableOpacity
            onPress={dismiss}
            className="mt-2 py-3 items-center"
          >
            <Text className="text-light-matte-black/70 font-semibold">
              Close
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  };

  let body: React.ReactNode;

  if (!item) {
    body = (
      <View className="bg-white rounded-2xl p-5">
        <Text className="text-lg font-bold text-light-matte-black">
          {errorParam ? "Can't open this" : "Nothing to open"}
        </Text>
        <Text className="text-sm text-light-matte-black/70 mt-2">
          {errorParam
            ? "The wallet couldn't understand this link."
            : "There's no pending request from a link."}
        </Text>
        <TouchableOpacity
          onPress={leave}
          className="mt-5 py-3 rounded-2xl bg-light-primary-red items-center"
        >
          <Text className="text-white font-bold">Close</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (phase.kind === "working") {
    body = (
      <View className="bg-white rounded-2xl p-6 items-center">
        <ActivityIndicator color="#c71c4b" />
        <Text className="text-sm text-light-matte-black/70 mt-3">
          {INTERSTITIAL_COPY.working}
        </Text>
      </View>
    );
  } else if (phase.kind === "outcome") {
    const o = phase.outcome;
    if (o.kind === "rejected") {
      body = rejectedView(
        o.code,
        { domain: o.domain, chain: o.chain, asset: o.asset },
        o.data,
      );
    } else if (o.kind === "done") {
      body = (
        <View className="bg-white rounded-2xl p-5">
          <View className="flex-row items-center">
            <View className="w-8 h-8 rounded-full bg-emerald-100 items-center justify-center">
              <Check size={18} color="#047857" />
            </View>
            <Text className="ml-3 text-lg font-bold text-light-matte-black">
              {o.title}
            </Text>
          </View>
          <Text className="text-sm text-light-matte-black/70 mt-3">
            {o.body}
          </Text>
          {o.explorerUrl ? (
            <TouchableOpacity
              onPress={() =>
                Linking.openURL(o.explorerUrl as string).catch(() => {})
              }
              className="mt-4 py-3 rounded-2xl bg-light-matte-black/5 items-center"
            >
              <Text className="text-light-matte-black font-semibold">
                View on explorer
              </Text>
            </TouchableOpacity>
          ) : null}
          {o.returnTo ? (
            <TouchableOpacity
              onPress={() =>
                Linking.openURL(o.returnTo?.url ?? "").catch(() => {})
              }
              className="mt-2 py-3 rounded-2xl bg-light-matte-black/5 items-center"
            >
              <Text className="text-light-matte-black font-semibold">
                {o.returnTo.label}
              </Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            onPress={leave}
            className="mt-2 py-3 rounded-2xl bg-light-primary-red items-center"
          >
            <Text className="text-white font-bold">Done</Text>
          </TouchableOpacity>
        </View>
      );
    } else {
      body = null;
    }
  } else if (intent?.kind === "reject") {
    body = rejectedView(intent.code, {
      domain: intent.domain,
      chain: namespace ? chainLabelForNamespace(namespace) : undefined,
    });
  } else if (binding?.kind === "reject") {
    body = rejectedView(binding.code, {
      chain: namespace ? chainLabelForNamespace(namespace) : undefined,
    });
  } else if (intent && summary) {
    const needsAck = Boolean(summary.unsigned) && !unsignedAck;
    const chainBadge = namespace ? chainBadgeLabel(namespace) : null;
    body = (
      <View className="bg-white rounded-2xl p-5">
        <View className="flex-row items-center mb-3">
          <View className="w-10 h-10 bg-light-primary-red/10 rounded-full items-center justify-center">
            <Link2 size={18} color="#c71c4b" />
          </View>
          <View className="ml-3 flex-1">
            <Text className="text-lg font-bold text-light-matte-black">
              {summary.title}
            </Text>
            <Text className="text-xs text-light-matte-black/60">
              {summary.chainLabel}
              {chainBadge ? ` · ${chainBadge}` : ""}
            </Text>
          </View>
        </View>

        {provenance ? <ProvenanceBanner provenance={provenance} /> : null}

        {summary.lines.length > 0 ? (
          <View className="bg-light-main-container rounded-xl p-3 mb-3">
            {summary.lines.map((l, i) => (
              <View
                key={`${l.label}-${i}`}
                className="flex-row justify-between py-1"
              >
                <Text className="text-xs text-light-matte-black/60">
                  {l.label}
                </Text>
                <Text
                  className="text-xs text-light-matte-black font-medium flex-1 text-right ml-3"
                  numberOfLines={2}
                >
                  {l.value}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {summary.linkText ? (
          <View className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-3">
            <Text className="text-xs text-amber-900/70 mb-1">
              From the link (not verified)
            </Text>
            <Text
              className="text-sm text-amber-900"
              style={{ fontFamily: "monospace" }}
            >
              {summary.linkText}
            </Text>
          </View>
        ) : null}

        {binding?.kind === "pick" ? (
          <View className="mb-3">
            <Text className="text-xs text-light-matte-black/60 mb-2">
              Use wallet
            </Text>
            {binding.candidates.map((w) => {
              const selected = (boundWallet?.address ?? "") === w.address;
              return (
                <Pressable
                  key={w.address}
                  onPress={() => setPickedAddress(w.address)}
                  className={`flex-row items-center p-3 rounded-xl mb-2 border ${selected ? "border-light-primary-red bg-light-primary-red/5" : "border-light-matte-black/10"}`}
                >
                  <WalletIcon
                    size={16}
                    color={selected ? "#c71c4b" : "#20222c"}
                  />
                  <View className="ml-3 flex-1">
                    <Text className="text-sm font-medium text-light-matte-black">
                      {w.name || "Wallet"}
                    </Text>
                    <Text className="text-xs text-light-matte-black/60">
                      {truncateAddress({ address: w.address })}
                    </Text>
                  </View>
                  {selected ? <Check size={16} color="#c71c4b" /> : null}
                </Pressable>
              );
            })}
          </View>
        ) : boundWallet ? (
          <View className="flex-row items-center mb-3">
            <WalletIcon size={14} color="#20222c" />
            <Text className="ml-2 text-xs text-light-matte-black/70">
              {boundWallet.name || "Wallet"} ·{" "}
              {truncateAddress({ address: boundWallet.address })}
            </Text>
          </View>
        ) : null}

        {summary.unsigned ? (
          <Pressable
            onPress={() => setUnsignedAck((v) => !v)}
            className="flex-row items-start bg-red-50 border border-red-200 rounded-xl p-3 mb-3"
            accessibilityRole="checkbox"
            accessibilityState={{ checked: unsignedAck }}
          >
            <View
              className={`w-5 h-5 rounded border mr-3 items-center justify-center ${unsignedAck ? "bg-red-700 border-red-700" : "border-red-400"}`}
            >
              {unsignedAck ? <Check size={14} color="#fff" /> : null}
            </View>
            <View className="flex-1">
              <Text className="text-sm font-semibold text-red-900">
                {UNSIGNED_REQUEST_COPY.title}
              </Text>
              <Text className="text-xs text-red-900/80 mt-1">
                {UNSIGNED_REQUEST_COPY.body}
              </Text>
            </View>
          </Pressable>
        ) : null}

        <TouchableOpacity
          onPress={() => void proceed()}
          disabled={needsAck}
          className={`py-3 rounded-2xl items-center ${needsAck ? "bg-light-primary-red/40" : "bg-light-primary-red"}`}
          accessibilityLabel="deeplink-continue"
        >
          <Text className="text-white font-bold">
            {summary.unsigned
              ? UNSIGNED_REQUEST_COPY.confirm
              : INTERSTITIAL_COPY.continueLabel}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={dismiss}
          className="mt-2 py-3 items-center"
          accessibilityLabel="deeplink-dismiss"
        >
          <Text className="text-light-matte-black/70 font-semibold">
            {INTERSTITIAL_COPY.notNow}
          </Text>
        </TouchableOpacity>
      </View>
    );
  } else {
    body = null;
  }

  return (
    <SafeAreaView className="flex-1 bg-light-main-container" edges={["top"]}>
      <View className="flex-row items-center px-6 pt-4 pb-2">
        <TouchableOpacity
          onPress={dismiss}
          className="mr-4"
          accessibilityLabel="deeplink-back"
        >
          <ArrowLeft color="#c71c4b" size={24} />
        </TouchableOpacity>
        <Text className="text-light-matte-black text-xl font-bold">
          Open from link
        </Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 24, paddingTop: 8 }}>
        {body}
      </ScrollView>
      {addWalletSheet}
    </SafeAreaView>
  );
}
