import React, { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { hexToString, isHex } from "viem";
import type {
  ApprovalDecision,
  ApprovalIntent,
} from "@/services/bridge/approval";
import type {
  EvmSignMessagePayload,
  EvmSignTypedDataPayload,
} from "@/services/chains/evm/payloads";
import {
  isKnownSpender,
  tryDecodeErc2612,
  tryDecodePermit2,
  tryParseSiwe,
} from "@/services/decoders";
import { originHost } from "@/services/permissions/caip";
import { useScreenshotGuard } from "@/services/security/screenshotGuard";
import type { ComputeSigningDigestArgs } from "@/services/walletKit/types";
import { ApprovalShell } from "./ApprovalShell";
import { ClearSigningSection } from "./ClearSigningSection";
import { PrimaryActions, SheetModal } from "./SheetModal";
import { useBiometricApproval } from "./useBiometricApproval";

type MessageIntent = ApprovalIntent<
  EvmSignMessagePayload | EvmSignTypedDataPayload
>;

interface Props {
  intent: MessageIntent;
  onDecision: (d: ApprovalDecision) => void;
}

export function EvmSignMessageSheet({
  intent,
  onDecision,
}: Props): React.ReactElement {
  useScreenshotGuard();
  const isTyped = intent.kind === "signTypedData";
  const holdRequired = intent.annotations.some(
    (a) =>
      a.code === "approval.unlimited" ||
      a.code === "siwe.domain-mismatch" ||
      a.code === "sign.eth_sign_legacy",
  );
  const [holdProgress, setHoldProgress] = useState(0);

  // Device-owner check before the wallet signs, matching the Solana / Sui /
  // Stellar message sheets. A signature here can be an ERC-2612 / Permit2
  // token approval, so "it's only a message" is not a reason to skip it.
  // The hold-to-sign delay for high-risk messages stays in front of this.
  const approve = useCallback(
    () => onDecision({ id: intent.id, outcome: "approve" }),
    [intent.id, onDecision],
  );
  const {
    gatedApprove,
    pending,
    error: biometricError,
  } = useBiometricApproval(
    `Sign message for ${originHost(intent.origin.url)}`,
    approve,
  );

  const decoded = useMemo(() => {
    if (isTyped) {
      const p = intent.payload as EvmSignTypedDataPayload;
      return (
        tryDecodeErc2612(p.typedData) ?? tryDecodePermit2(p.typedData) ?? null
      );
    }
    return null;
  }, [intent.payload, isTyped]);

  const siwe = useMemo(() => {
    if (isTyped) return null;
    const p = intent.payload as EvmSignMessagePayload;
    const text =
      p.display === "hex" && isHex(p.message)
        ? tryHexToUtf8(p.message)
        : p.message;
    return text ? tryParseSiwe(text) : null;
  }, [intent.payload, isTyped]);

  // Task 65 — ERC-8213 Flow A digest for typed data. A personal_sign
  // message has no domain/types/message struct and isn't calldata, so
  // ERC-8213 defines nothing for it: the kit returns null and the
  // digest block stays hidden (a real, documented gap).
  const digestArgs = useMemo<ComputeSigningDigestArgs | null>(() => {
    if (!isTyped) return null;
    const p = intent.payload as EvmSignTypedDataPayload;
    return {
      kind: "typedData",
      typedData: p.typedData as Extract<
        ComputeSigningDigestArgs,
        { kind: "typedData" }
      >["typedData"],
    };
  }, [intent.payload, isTyped]);

  // Stage-2 descriptor probe only when the sheet's own cards (SIWE /
  // permit) found nothing — no duplicate cards for the same payload.
  const clearSigningCall = useMemo(() => {
    if (!isTyped || siwe || decoded) return undefined;
    const p = intent.payload as EvmSignTypedDataPayload;
    return { typedData: p.typedData };
  }, [intent.payload, isTyped, siwe, decoded]);

  // TWV-2026-012 — the signing domain. A typed-data signature is only as
  // trustworthy as its domain: the domain binds the signature to one
  // chain and one contract, so a decoder that renders an order perfectly
  // while the domain goes unchecked is worse than no decoder at all. It
  // implies a verification that did not happen.
  const domain = useMemo<SigningDomain | null>(() => {
    if (!isTyped) return null;
    const p = intent.payload as EvmSignTypedDataPayload;
    const d = (p.typedData as { domain?: Record<string, unknown> }).domain;
    if (!d || typeof d !== "object") return null;
    const rawChainId = d.chainId;
    const chainId =
      typeof rawChainId === "bigint"
        ? Number(rawChainId)
        : typeof rawChainId === "string"
          ? Number(rawChainId)
          : typeof rawChainId === "number"
            ? rawChainId
            : undefined;
    return {
      name: typeof d.name === "string" ? d.name : undefined,
      version: typeof d.version === "string" ? d.version : undefined,
      chainId: Number.isFinite(chainId) ? chainId : undefined,
      verifyingContract:
        typeof d.verifyingContract === "string"
          ? d.verifyingContract
          : undefined,
      activeChainId: p.activeChainId,
      activeChainName: p.activeChainName,
    };
  }, [intent.payload, isTyped]);

  // Phase O — fields the dApp put in `message` that its own `types` do
  // not declare. They are stripped before this sheet sees the payload
  // (they are not in the signed hash), so the risk is not what gets
  // signed but what the user is shown: rendering them would display a
  // field the signature does not cover.
  const undeclaredKeys = useMemo(() => {
    if (!isTyped) return null;
    const p = intent.payload as EvmSignTypedDataPayload;
    return p.undeclaredMessageKeys?.length ? p.undeclaredMessageKeys : null;
  }, [intent.payload, isTyped]);

  // Refusal, not a warning. A domain chainId that does not match the
  // chain this origin is on has no legitimate reading — it is the shape
  // of a signature harvested on one chain to be replayed on another. The
  // existing hold-to-sign affordance is not enough, so there is no
  // approve path at all in this state.
  const chainMismatch =
    domain?.chainId !== undefined &&
    domain.activeChainId !== undefined &&
    domain.chainId !== domain.activeChainId;

  return (
    <SheetModal
      onDismiss={() => onDecision({ id: intent.id, outcome: "reject" })}
    >
      <ApprovalShell
        intent={intent}
        title={isTyped ? "Sign typed data" : "Sign message"}
      >
        <ScrollView
          className="flex-1"
          contentContainerClassName="pb-4"
          showsVerticalScrollIndicator
        >
          {/* TWV-2026-012 §2.1 — unconditional, above every decoded
              card, including the permit cards which historically buried
              the domain in the raw-JSON fallback below the fold. */}
          {domain && <SigningDomainCard domain={domain} />}
          {chainMismatch && <ChainMismatchCard domain={domain} />}
          {undeclaredKeys && <UndeclaredFieldsCard keys={undeclaredKeys} />}
          {siwe && <SiweCard siwe={siwe} />}
          {decoded && <DecodedPermitCard decoded={decoded} />}
          {/* Task 65 — descriptor (only when SIWE/permit didn't match),
              AI summary, and the ERC-8213 typed-data digest block. The
              digest renders regardless of descriptor resolution. */}
          <ClearSigningSection
            intent={intent}
            call={clearSigningCall}
            digestArgs={digestArgs}
          />
          {!siwe && !decoded && (
            <RawMessageCard intent={intent} isTyped={isTyped} />
          )}
        </ScrollView>
      </ApprovalShell>
      {biometricError && (
        <Text
          className="text-xs text-red-600 px-4 mt-2"
          accessibilityLabel="biometric-error"
        >
          {biometricError}
        </Text>
      )}
      <PrimaryActions
        approveLabel={
          chainMismatch
            ? "Can't sign"
            : pending
              ? "Authenticating…"
              : holdRequired
                ? "Hold to sign"
                : "Sign"
        }
        disabled={chainMismatch}
        onApprove={() => {
          // Hard stop. Not a confirmation, not a hold — there is no
          // input that produces a signature from this state.
          if (chainMismatch) return;
          if (holdRequired && holdProgress < 1) {
            // Simulate a 1.5s hold with a timer; simple UX placeholder.
            const start = Date.now();
            const int = setInterval(() => {
              const p = Math.min(1, (Date.now() - start) / 1500);
              setHoldProgress(p);
              if (p >= 1) {
                clearInterval(int);
                void gatedApprove();
              }
            }, 50);
            return;
          }
          void gatedApprove();
        }}
        onReject={() => onDecision({ id: intent.id, outcome: "reject" })}
        loading={pending}
      />
    </SheetModal>
  );
}

interface SigningDomain {
  name?: string;
  version?: string;
  chainId?: number;
  verifyingContract?: string;
  activeChainId?: number;
  activeChainName?: string;
}

/**
 * TWV-2026-012 §2.1 — the four `EIP712Domain` fields, unconditionally
 * and without a disclosure toggle. A missing field is rendered as
 * missing rather than omitted: a domain with no `verifyingContract` is
 * a fact the user should see, and silently dropping the row would make
 * it indistinguishable from a domain that has one.
 */
function SigningDomainCard({
  domain,
}: {
  domain: SigningDomain;
}): React.ReactElement {
  const known = domain.verifyingContract
    ? isKnownSpender(domain.verifyingContract, domain.chainId)
    : null;
  return (
    <View className="bg-gray-50 border border-gray-200 rounded-xl p-3 mb-3">
      <Text className="text-xs text-gray-500 font-semibold mb-1 uppercase">
        Signing domain
      </Text>
      <Row k="Name" v={domain.name ?? "Not set"} />
      <Row k="Version" v={domain.version ?? "Not set"} />
      <Row
        k="Chain"
        v={
          domain.chainId === undefined
            ? "Not set"
            : domain.chainId === domain.activeChainId && domain.activeChainName
              ? `${domain.chainId} · ${domain.activeChainName}`
              : String(domain.chainId)
        }
      />
      <Row k="Contract" v={domain.verifyingContract ?? "Not set"} />
      {known && (
        <View className="bg-green-100 border border-green-300 rounded-lg p-2 mt-2">
          <Text className="text-xs text-green-800">
            Known contract: {known.name}
          </Text>
        </View>
      )}
    </View>
  );
}

/**
 * TWV-2026-012 §2.2 — refusal card. Deliberately explains *why* rather
 * than only blocking: a silent rejection reaches the dApp as a generic
 * "user rejected", which teaches the user nothing and reads to them as
 * the wallet being broken.
 */
function ChainMismatchCard({
  domain,
}: {
  domain: SigningDomain | null;
}): React.ReactElement | null {
  if (!domain) return null;
  const target = String(domain.chainId);
  const active = domain.activeChainName
    ? `${domain.activeChainId} (${domain.activeChainName})`
    : String(domain.activeChainId);
  return (
    <View className="bg-red-50 border border-red-300 rounded-xl p-3 mb-3">
      <Text className="text-xs font-bold text-red-800 uppercase">
        Takumi won&apos;t sign this
      </Text>
      <Text className="text-sm text-red-900 mt-1">
        This signature is built for chain {target}, but this site is connected
        to chain {active}. A signature meant for another chain can be reused
        there without your knowledge, so it cannot be signed here.
      </Text>
    </View>
  );
}

/**
 * Phase O — `signExtraDataNotTyped`.
 *
 * A payload whose `message` carries keys its own `types` never declare
 * is not a formatting slip. Those keys are invisible to the hash, so a
 * wallet that renders `message` directly can be made to display terms
 * the signature does not cover: agree to one thing on screen, sign
 * another. We strip them and say that we did, because silently dropping
 * a field the dApp sent is its own kind of surprise.
 */
function UndeclaredFieldsCard({
  keys,
}: {
  keys: string[];
}): React.ReactElement {
  return (
    <View className="bg-amber-50 border border-amber-300 rounded-xl p-3 mb-3">
      <Text className="text-xs font-bold text-amber-900 uppercase">
        This request carried fields it does not sign
      </Text>
      <Text className="text-sm text-amber-900 mt-1">
        The site sent {keys.length === 1 ? "a field" : "fields"} that
        {keys.length === 1 ? " is" : " are"} not part of what you would be
        signing, so {keys.length === 1 ? "it is" : "they are"} not shown below.
        Only continue if you trust this site.
      </Text>
      <Text className="text-xs text-amber-800 mt-2" selectable>
        {keys.join(", ")}
      </Text>
    </View>
  );
}

function RawMessageCard({
  intent,
  isTyped,
}: {
  intent: MessageIntent;
  isTyped: boolean;
}): React.ReactElement {
  const text = useMemo(() => {
    if (isTyped) {
      const p = intent.payload as EvmSignTypedDataPayload;
      return JSON.stringify(p.typedData, null, 2);
    }
    const p = intent.payload as EvmSignMessagePayload;
    if (p.display === "hex" && isHex(p.message)) {
      return tryHexToUtf8(p.message) ?? p.message;
    }
    return p.message;
  }, [intent.payload, isTyped]);
  return (
    <View className="bg-gray-50 rounded-xl p-3">
      <Text className="text-xs text-gray-500 mb-1">Message</Text>
      <Text className="text-sm text-gray-800" selectable>
        {text}
      </Text>
    </View>
  );
}

function SiweCard({
  siwe,
}: {
  siwe: ReturnType<typeof tryParseSiwe>;
}): React.ReactElement | null {
  if (!siwe) return null;
  return (
    <View className="bg-blue-50 rounded-xl p-3 mb-3">
      <Text className="text-xs text-blue-600 font-semibold mb-1">
        Sign in with Ethereum
      </Text>
      <Row k="Domain" v={siwe.domain} />
      <Row k="Address" v={siwe.address} />
      <Row k="URI" v={siwe.uri} />
      <Row k="Chain" v={String(siwe.chainId)} />
      <Row k="Nonce" v={siwe.nonce} />
      <Row k="Issued At" v={siwe.issuedAt} />
      {siwe.expirationTime && <Row k="Expires" v={siwe.expirationTime} />}
      {siwe.notBefore && <Row k="Not Before" v={siwe.notBefore} />}
      {siwe.requestId && <Row k="Request ID" v={siwe.requestId} />}
      {siwe.statement && (
        <View className="mt-2">
          <Text className="text-xs text-blue-700">{siwe.statement}</Text>
        </View>
      )}
      {siwe.resources.length > 0 && (
        <View className="mt-2">
          <Text className="text-xs text-blue-700">Resources:</Text>
          {siwe.resources.map((r) => (
            <Text key={r} className="text-xs text-blue-700">
              · {r}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

function DecodedPermitCard({
  decoded,
}: {
  decoded:
    | ReturnType<typeof tryDecodeErc2612>
    | ReturnType<typeof tryDecodePermit2>;
}): React.ReactElement | null {
  if (!decoded) return null;
  const isPermit2 = decoded.standard === "Permit2";
  const knownSpender = isKnownSpender(decoded.spender);
  return (
    <View className="bg-amber-50 rounded-xl p-3 mb-3">
      <Text className="text-xs text-amber-700 font-semibold mb-1">
        {isPermit2 ? "Permit2 approval" : "ERC-20 permit"}
      </Text>
      {!knownSpender && (
        <View className="bg-red-100 border border-red-300 rounded-lg p-2 mb-2">
          <Text className="text-xs text-red-800 font-semibold">
            Unknown spender
          </Text>
          <Text className="text-xs text-red-700 mt-0.5">
            This contract is not on our known-safe list. Scam drainers abuse
            permits via unfamiliar spenders. Verify the address on the
            dApp&apos;s official docs before signing.
          </Text>
        </View>
      )}
      {knownSpender && (
        <View className="bg-green-100 border border-green-300 rounded-lg p-2 mb-2">
          <Text className="text-xs text-green-800">
            Verified spender: {knownSpender.name}
          </Text>
        </View>
      )}
      <Row k="Spender" v={decoded.spender} />
      {!isPermit2 && (
        <>
          <Row k="Token" v={(decoded as any).token} />
          <Row
            k="Amount"
            v={
              decoded.isUnlimited
                ? "Unlimited ⚠️"
                : (decoded as any).amount.toString()
            }
          />
          <Row k="Deadline" v={(decoded as any).deadline.toString()} />
        </>
      )}
      {isPermit2 &&
        (decoded as any).tokens.map(
          (
            t: { address: string; amount: bigint; expiration: bigint },
            i: number,
          ) => (
            <View key={`${t.address}-${i}`} className="mt-2">
              <Row k="Token" v={t.address} />
              <Row
                k="Amount"
                v={
                  t.amount.toString().length >= 77
                    ? "Unlimited ⚠️"
                    : t.amount.toString()
                }
              />
              <Row k="Expires" v={t.expiration.toString()} />
            </View>
          ),
        )}
    </View>
  );
}

function Row({ k, v }: { k: string; v: string }): React.ReactElement {
  return (
    <View className="flex-row mt-1">
      <Text className="text-xs text-gray-500 w-20">{k}</Text>
      <Text className="text-xs text-gray-900 flex-1" selectable>
        {v}
      </Text>
    </View>
  );
}

function tryHexToUtf8(hex: `0x${string}`): string | null {
  try {
    return hexToString(hex);
  } catch {
    return null;
  }
}
