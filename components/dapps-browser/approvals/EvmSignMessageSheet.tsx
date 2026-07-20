import React, { useMemo, useState } from "react";
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
import { useScreenshotGuard } from "@/services/security/screenshotGuard";
import type { ComputeSigningDigestArgs } from "@/services/walletKit/types";
import { ApprovalShell } from "./ApprovalShell";
import { ClearSigningSection } from "./ClearSigningSection";
import { PrimaryActions, SheetModal } from "./SheetModal";

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
      <PrimaryActions
        approveLabel={holdRequired ? "Hold to sign" : "Sign"}
        onApprove={() => {
          if (holdRequired && holdProgress < 1) {
            // Simulate a 1.5s hold with a timer; simple UX placeholder.
            const start = Date.now();
            const int = setInterval(() => {
              const p = Math.min(1, (Date.now() - start) / 1500);
              setHoldProgress(p);
              if (p >= 1) {
                clearInterval(int);
                onDecision({ id: intent.id, outcome: "approve" });
              }
            }, 50);
            return;
          }
          onDecision({ id: intent.id, outcome: "approve" });
        }}
        onReject={() => onDecision({ id: intent.id, outcome: "reject" })}
      />
    </SheetModal>
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
