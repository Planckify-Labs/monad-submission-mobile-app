/**
 * `StellarWalletKit.buildPaymentRequest` — SEP-0007 `pay` (deep-link
 * spec §6.4 step 2). Builds an **unsigned** classic `payment` envelope
 * for the existing `StellarTransactionSheet` (+ `StellarXdrDecoderInspector`
 * and `StellarPreflightInspector`, which cover "destination exists /
 * trustline present" and the first-seen-address check).
 *
 * The origin-domain verification (toml + signature) happens in the
 * handler before this runs; this builder only assembles the operation.
 */

import { bytesToHex } from "@noble/hashes/utils";
import {
  Account,
  Asset,
  BASE_FEE,
  Memo,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-base";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import { parseDecimalStringAsStroops } from "@/services/chains/stellar/amount";
import { base64ToBytes } from "@/services/chains/stellar/base64";
import {
  getHorizonClient,
  transactionToBase64Xdr,
} from "@/services/chains/stellar/horizonClient";
import type { StellarSignTransactionPayload } from "@/services/chains/stellar/payloads";
import {
  DeepLinkBuildError,
  type ExternalApprovalDraft,
  type Provenance,
} from "@/services/deeplinks/types";
import { safeDecodeComponent } from "@/services/deeplinks/uri";
import type { PaymentIntent } from "@/services/paymentIntent/types";

export const SEP7_PROTOCOL_ID = "sep7";

function memoFrom(memo: string | undefined, type: string | undefined): Memo {
  if (memo === undefined) return Memo.none();
  switch (type) {
    case "MEMO_ID":
      if (!/^\d+$/.test(memo)) throw new DeepLinkBuildError("malformed");
      return Memo.id(memo);
    case "MEMO_HASH":
    case "MEMO_RETURN": {
      // "Memos of type MEMO_HASH and MEMO_RETURN should be base64 encoded
      // and then URL encoded."
      const b64 = safeDecodeComponent(memo) ?? memo;
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(b64);
      } catch {
        throw new DeepLinkBuildError("malformed");
      }
      if (bytes.length !== 32) throw new DeepLinkBuildError("malformed");
      const hex = bytesToHex(bytes);
      return type === "MEMO_HASH" ? Memo.hash(hex) : Memo.return(hex);
    }
    default: {
      const text = memo;
      if (new TextEncoder().encode(text).length > 28)
        throw new DeepLinkBuildError("malformed");
      return Memo.text(text);
    }
  }
}

export async function buildStellarPaymentRequest(args: {
  wallet: TWallet;
  chain: ChainConfig;
  payment: PaymentIntent;
  provenance: Provenance;
}): Promise<ExternalApprovalDraft> {
  const { wallet, chain, payment, provenance } = args;
  if (chain.namespace !== "stellar")
    throw new DeepLinkBuildError("unsupported_chain");
  const channel = payment.channel;
  if (channel.kind !== "wallet") throw new DeepLinkBuildError("malformed");
  const proto = (channel.protocol?.params ?? {}) as {
    assetCode?: string;
    assetIssuer?: string;
    memo?: string;
    memoType?: string;
    originDomain?: string;
    callbackUrl?: string;
  };
  const amountRaw = channel.amountDecimal;
  if (amountRaw === undefined)
    throw new DeepLinkBuildError("unsupported_operation");
  const stroops = parseDecimalStringAsStroops(amountRaw);
  if (stroops <= 0n) throw new DeepLinkBuildError("malformed");

  const horizon = getHorizonClient(chain);
  let source: Awaited<ReturnType<typeof horizon.loadAccount>>;
  try {
    source = await horizon.loadAccount(wallet.address);
  } catch (e) {
    if (__DEV__) console.warn("[sep7] source account load failed", e);
    throw new DeepLinkBuildError("insufficient_asset", { asset: "XLM" });
  }

  let asset: Asset;
  if (proto.assetCode && proto.assetIssuer) {
    asset = new Asset(proto.assetCode, proto.assetIssuer);
    // "the wallet must hold that asset (a trustline with balance ≥ amount)";
    // path payments are a non-goal.
    const line = source.balances.find(
      (b) =>
        (b.asset_type === "credit_alphanum4" ||
          b.asset_type === "credit_alphanum12") &&
        b.asset_code === proto.assetCode &&
        b.asset_issuer === proto.assetIssuer,
    );
    if (!line || parseDecimalStringAsStroops(line.balance) < stroops) {
      throw new DeepLinkBuildError("insufficient_asset", {
        asset: proto.assetCode,
      });
    }
  } else {
    asset = Asset.native();
    const native = source.balances.find((b) => b.asset_type === "native");
    if (!native || parseDecimalStringAsStroops(native.balance) < stroops) {
      throw new DeepLinkBuildError("insufficient_asset", { asset: "XLM" });
    }
  }

  const tx = new TransactionBuilder(
    new Account(source.account_id, source.sequence),
    {
      fee: BASE_FEE,
      networkPassphrase: horizon.networkPassphrase,
    },
  )
    .addOperation(
      Operation.payment({
        destination: channel.address,
        asset,
        amount: amountRaw,
      }),
    )
    .addMemo(memoFrom(proto.memo, proto.memoType))
    .setTimeout(180)
    .build();

  const payload: StellarSignTransactionPayload = {
    address: wallet.address,
    networkPassphrase: horizon.networkPassphrase,
    xdr: transactionToBase64Xdr(tx),
    // No callback → "sign the given XDR and submit it to the network".
    submit: proto.callbackUrl ? undefined : true,
  };
  return {
    namespace: "stellar",
    kind: "signTransaction",
    origin: {
      url: proto.originDomain ? `https://${proto.originDomain}` : "link://sep7",
      via: "deeplink",
    },
    wallet,
    payload,
    provenance,
    returnChannel: proto.callbackUrl
      ? { kind: "http-callback", url: proto.callbackUrl, form: "sep7-xdr" }
      : { kind: "broadcast" },
  };
}
