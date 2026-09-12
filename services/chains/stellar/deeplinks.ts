/**
 * Stellar deep-link handler — SEP-0007 `web+stellar:tx` / `pay` (spec §6.4).
 *
 * `parse()` is pure (`sep7.ts`). `build()` runs after Continue: origin
 * verification (`sep7Verify.ts`), then either the kit's payment builder
 * (`pay`) or the envelope decode / `replace` rewrite (`tx`). Both emit
 * the existing `signTransaction` intent so `StellarTransactionSheet`,
 * the XDR decoder and the preflight inspector do the display.
 */

import {
  decodeAddressToMuxedAccount,
  Networks,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-base";
import type { TWallet } from "@/constants/types/walletTypes";
import { resolveChainConfig } from "@/services/deeplinks/chainResolve";
import type { DeepLinkSchemeHandler } from "@/services/deeplinks/schemeRegistry";
import {
  type BuildContext,
  DeepLinkBuildError,
  type DeepLinkIntent,
  type ExternalApprovalDraft,
  type Provenance,
  type ReturnChannel,
  type SigningSummary,
} from "@/services/deeplinks/types";
import type { PaymentIntent } from "@/services/paymentIntent/types";
import { walletKitRegistry } from "@/services/walletKit/registry";
import { bytesToBase64 } from "./base64";
import { getHorizonClient } from "./horizonClient";
import type { StellarSignTransactionPayload } from "./payloads";
import { parseSep7, type Sep7Pay, type Sep7Tx } from "./sep7";
import { verifySep7Origin } from "./sep7Verify";

export const SEP7_PROTOCOL_ID = "sep7";

function networkOf(
  passphrase: string | undefined,
): "mainnet" | "testnet" | null {
  if (!passphrase || passphrase === Networks.PUBLIC) return "mainnet";
  if (passphrase === Networks.TESTNET) return "testnet";
  return null;
}

function passphraseOf(network: "mainnet" | "testnet"): string {
  return network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
}

function baseProvenance(
  envelope: { source: Provenance["source"] },
  originDomain?: string,
): Provenance {
  return {
    verification: { kind: "none" },
    firstSeen: false,
    transport: "os-link",
    source: envelope.source,
    claimedOrigin: originDomain,
  };
}

function returnChannelFor(callbackUrl?: string): ReturnChannel {
  return callbackUrl
    ? { kind: "http-callback", url: callbackUrl, form: "sep7-xdr" }
    : { kind: "broadcast" };
}

function payToPaymentIntent(
  p: Sep7Pay,
  network: "mainnet" | "testnet",
  raw: string,
): PaymentIntent {
  return {
    source: "deeplink",
    rawScan: raw,
    channel: {
      kind: "wallet",
      namespace: "stellar",
      address: p.destination,
      target: { namespace: "stellar", network },
      amountDecimal: p.amount,
      assetLabel: p.assetCode ?? "XLM",
      protocol: {
        id: SEP7_PROTOCOL_ID,
        params: {
          assetCode: p.assetCode,
          assetIssuer: p.assetIssuer,
          memo: p.memo,
          memoType: p.memoType,
          originDomain: p.originDomain,
          callbackUrl: p.callbackUrl,
          msg: p.msg,
        },
      },
    },
  };
}

function paySummary(
  p: Sep7Pay,
  network: "mainnet" | "testnet",
): SigningSummary {
  const lines: SigningSummary["lines"] = [
    { label: "To", value: p.destination },
    {
      label: "Amount",
      value: p.amount
        ? `${p.amount} ${p.assetCode ?? "XLM"}`
        : "You will enter the amount",
    },
  ];
  if (p.assetIssuer) lines.push({ label: "Issuer", value: p.assetIssuer });
  if (p.memo)
    lines.push({
      label: "Memo",
      value: `${p.memoType ?? "MEMO_TEXT"}: ${p.memo}`,
    });
  if (network !== "mainnet") lines.push({ label: "Network", value: network });
  if (p.callbackUrl)
    lines.push({ label: "Result goes to", value: p.callbackUrl });
  return {
    title: "Payment request",
    chainLabel: "Stellar",
    lines,
    unsigned: !p.originDomain,
    linkText: p.msg,
  };
}

function txSummary(t: Sep7Tx, network: "mainnet" | "testnet"): SigningSummary {
  const lines: SigningSummary["lines"] = [];
  if (t.pubkey) lines.push({ label: "Signing account", value: t.pubkey });
  if (t.replace) {
    lines.push({
      label: "Fills in",
      value: t.replace.fields
        .map((f) => `${f.field} (${t.replace?.hints[f.ref] ?? f.ref})`)
        .join(", "),
    });
  }
  if (network !== "mainnet") lines.push({ label: "Network", value: network });
  lines.push({
    label: "Result",
    value: t.callbackUrl ? `Sent to ${t.callbackUrl}` : "Signed and submitted",
  });
  return {
    title: "Signing request",
    chainLabel: "Stellar",
    lines,
    unsigned: !t.originDomain,
    linkText: t.msg,
  };
}

/**
 * Apply the v1 `replace` subset directly on the envelope XDR so every
 * operation type survives untouched: `sourceAccount` (+ a fresh
 * sequence number for the new source) and `operations[n].sourceAccount`.
 */
async function applyReplace(
  xdrBase64: string,
  t: Sep7Tx,
  wallet: TWallet,
  horizonNetwork: "mainnet" | "testnet",
  ctx: BuildContext,
): Promise<string> {
  if (!t.replace) return xdrBase64;
  let envelope: xdr.TransactionEnvelope;
  try {
    envelope = xdr.TransactionEnvelope.fromXDR(xdrBase64, "base64");
  } catch {
    throw new DeepLinkBuildError("malformed");
  }
  const sw = envelope.switch().name;
  if (sw === "envelopeTypeTxFeeBump")
    throw new DeepLinkBuildError("unsupported_operation");
  const tx = sw === "envelopeTypeTxV0" ? null : envelope.v1().tx();
  if (!tx) throw new DeepLinkBuildError("unsupported_operation");
  const muxed = decodeAddressToMuxedAccount(wallet.address, true);

  for (const f of t.replace.fields) {
    if (f.field === "sourceAccount") {
      const chain = resolveChainConfig(
        { namespace: "stellar", ref: horizonNetwork },
        ctx.chainRows(),
      );
      if (!chain) throw new DeepLinkBuildError("unsupported_chain");
      let account: { sequence: string };
      try {
        account = await getHorizonClient(chain).loadAccount(wallet.address);
      } catch {
        throw new DeepLinkBuildError("insufficient_asset", { asset: "XLM" });
      }
      tx.sourceAccount(muxed);
      tx.seqNum(
        xdr.Int64.fromString((BigInt(account.sequence) + 1n).toString()),
      );
      continue;
    }
    const m = /^operations\[(\d+)\]\.sourceAccount$/.exec(f.field);
    if (!m) throw new DeepLinkBuildError("unsupported_operation");
    const op = tx.operations()[Number(m[1])];
    if (!op) throw new DeepLinkBuildError("malformed");
    op.sourceAccount(muxed);
  }
  // Existing signatures no longer cover the rewritten body; drop them.
  envelope.v1().signatures([]);
  return bytesToBase64(envelope.toXDR("raw"));
}

async function verifyIfSigned(
  raw: string,
  req: Sep7Tx | Sep7Pay,
  provenance: Provenance,
  ctx: BuildContext,
): Promise<Provenance> {
  if (!req.originDomain || !req.signature) return provenance;
  const v = await verifySep7Origin({
    raw,
    originDomain: req.originDomain,
    signature: req.signature,
    ctx,
  });
  return {
    ...provenance,
    verification: {
      kind: "sep7-signature",
      domain: v.domain,
      keyPinned: v.keyPinned,
    },
    firstSeen: v.firstSeen,
    claimedOrigin: v.domain,
  };
}

async function buildTx(
  raw: string,
  t: Sep7Tx,
  network: "mainnet" | "testnet",
  wallet: TWallet,
  provenance0: Provenance,
  ctx: BuildContext,
): Promise<ExternalApprovalDraft> {
  const provenance = await verifyIfSigned(raw, t, provenance0, ctx);
  const passphrase = passphraseOf(network);
  try {
    TransactionBuilder.fromXDR(t.xdr, passphrase);
  } catch {
    throw new DeepLinkBuildError("malformed");
  }
  const finalXdr = await applyReplace(t.xdr, t, wallet, network, ctx);
  const payload: StellarSignTransactionPayload = {
    address: wallet.address,
    networkPassphrase: passphrase,
    xdr: finalXdr,
    submit: t.callbackUrl ? undefined : true,
  };
  return {
    namespace: "stellar",
    kind: "signTransaction",
    origin: {
      url: t.originDomain ? `https://${t.originDomain}` : "link://sep7",
      via: "deeplink",
    },
    wallet,
    payload,
    provenance,
    returnChannel: returnChannelFor(t.callbackUrl),
  };
}

async function buildPay(
  raw: string,
  p: Sep7Pay,
  network: "mainnet" | "testnet",
  wallet: TWallet,
  provenance0: Provenance,
  ctx: BuildContext,
): Promise<ExternalApprovalDraft> {
  const provenance = await verifyIfSigned(raw, p, provenance0, ctx);
  const kit = walletKitRegistry.get("stellar");
  if (!kit.buildPaymentRequest)
    throw new DeepLinkBuildError("unsupported_operation");
  const chain = resolveChainConfig(
    { namespace: "stellar", ref: network },
    ctx.chainRows(),
  );
  if (!chain) throw new DeepLinkBuildError("unsupported_chain");
  const draft = await kit.buildPaymentRequest({
    wallet,
    chain,
    payment: payToPaymentIntent(p, network, raw),
    provenance,
  });
  return {
    ...draft,
    provenance,
    returnChannel: returnChannelFor(p.callbackUrl),
  };
}

export const sep7Handler: DeepLinkSchemeHandler = {
  id: "sep7",
  namespace: "stellar",
  schemes: ["web+stellar"],
  priority: 10,
  parse(split, envelope, ctx): DeepLinkIntent {
    const parsed = parseSep7(split.ssp, split.query, split.rawQuery);
    if (!parsed.ok)
      return { kind: "reject", code: parsed.code, domain: parsed.domain };
    const req = parsed.request;
    const network = networkOf(req.networkPassphrase);
    if (!network) return { kind: "reject", code: "unsupported_chain" };
    if (
      ctx.chainRows() &&
      !resolveChainConfig(
        { namespace: "stellar", ref: network },
        ctx.chainRows(),
      )
    ) {
      return { kind: "reject", code: "unsupported_chain" };
    }
    const raw = envelope.raw;
    const provenance = baseProvenance(envelope, req.originDomain);

    if (req.op === "pay") {
      if (req.amount === undefined) {
        // "If not specified then the wallet should ask the user to enter
        // the amount before signing" — the send screen is that prompt.
        return {
          kind: "payment",
          namespace: "stellar",
          intent: payToPaymentIntent(req, network, raw),
          provenance,
          summary: paySummary(req, network),
        };
      }
      return {
        kind: "signing",
        namespace: "stellar",
        summary: paySummary(req, network),
        returnChannel: returnChannelFor(req.callbackUrl),
        provenance,
        build: (wallet, bctx) =>
          buildPay(raw, req, network, wallet, provenance, bctx),
      };
    }

    return {
      kind: "signing",
      namespace: "stellar",
      summary: txSummary(req, network),
      returnChannel: returnChannelFor(req.callbackUrl),
      provenance,
      pinnedAccount: req.pubkey,
      build: (wallet, bctx) =>
        buildTx(raw, req, network, wallet, provenance, bctx),
    };
  },
};

export const stellarDeepLinkHandlers: readonly DeepLinkSchemeHandler[] = [
  sep7Handler,
];
