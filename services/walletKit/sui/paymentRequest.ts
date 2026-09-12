/**
 * `SuiWalletKit.buildPaymentRequest` — Mysten Payment Kit PTB builder
 * (deep-link spec §6.3). Verified against
 * `contracts/payment_kit/payment_kit.ts` + `calls.ts` + `utils.ts`:
 *
 *   process_ephemeral_payment<CoinType>(nonce: String, payment_amount: u64,
 *       coin: Coin<CoinType>, receiver: address, clock: &Clock)
 *   process_registry_payment<CoinType>(registry: &mut Registry, nonce: String,
 *       payment_amount: u64, coin: Coin<CoinType>, receiver: Option<address>,
 *       clock: &Clock)
 *
 * The coin comes from `coinWithBalance({ type, balance })`, the Clock is
 * `0x6`, a registry name resolves through `deriveObjectID`. The PTB is
 * built with the wallet as sender (no signing here) and handed to the
 * existing `SuiTransactionSheet` as `sign-and-execute`, so the PTB
 * decoder and the simulation inspector run on the exact bytes.
 */

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { coinWithBalance, Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID, toBase64 } from "@mysten/sui/utils";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import {
  suiPaymentKitConfigFor,
  suiPaymentKitRegistryIdFromName,
} from "@/constants/configs/suiPaymentKit";
import type { TWallet } from "@/constants/types/walletTypes";
import type { SuiSignTxPayload } from "@/services/chains/sui/payloads";
import {
  DeepLinkBuildError,
  type ExternalApprovalDraft,
  type Provenance,
} from "@/services/deeplinks/types";
import type { PaymentIntent } from "@/services/paymentIntent/types";

export async function buildSuiPaymentRequest(args: {
  wallet: TWallet;
  chain: ChainConfig;
  payment: PaymentIntent;
  provenance: Provenance;
}): Promise<ExternalApprovalDraft> {
  const { wallet, chain, payment, provenance } = args;
  if (chain.namespace !== "sui")
    throw new DeepLinkBuildError("unsupported_chain");
  const channel = payment.channel;
  if (channel.kind !== "wallet" || channel.amount === undefined) {
    throw new DeepLinkBuildError("malformed");
  }
  const proto = (channel.protocol?.params ?? {}) as {
    coinType?: string;
    nonce?: string;
    registryId?: string;
    registryName?: string;
    label?: string;
  };
  const coinType = proto.coinType ?? channel.token;
  const nonce = proto.nonce;
  if (!coinType || !nonce) throw new DeepLinkBuildError("malformed");

  const pkg = suiPaymentKitConfigFor(chain.network);
  if (!pkg) throw new DeepLinkBuildError("unsupported_chain");

  const tx = new Transaction();
  tx.setSender(wallet.address);
  const coin = coinWithBalance({ type: coinType, balance: channel.amount });

  if (proto.registryId || proto.registryName) {
    const registryId =
      proto.registryId ??
      suiPaymentKitRegistryIdFromName(
        proto.registryName as string,
        pkg.namespaceId,
      );
    tx.moveCall({
      target: `${pkg.packageId}::payment_kit::process_registry_payment`,
      typeArguments: [coinType],
      arguments: [
        tx.object(registryId),
        tx.pure.string(nonce),
        tx.pure.u64(channel.amount),
        coin,
        tx.pure.option("address", channel.address),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
  } else {
    tx.moveCall({
      target: `${pkg.packageId}::payment_kit::process_ephemeral_payment`,
      typeArguments: [coinType],
      arguments: [
        tx.pure.string(nonce),
        tx.pure.u64(channel.amount),
        coin,
        tx.pure.address(channel.address),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
  }

  // `coinWithBalance` resolves the sender's coins at build time, which
  // needs a client on the bound chain.
  const client = new SuiJsonRpcClient({
    url: chain.rpcUrl,
    network: chain.network,
  });
  let bytes: Uint8Array;
  try {
    bytes = await tx.build({ client });
  } catch (e) {
    if (__DEV__) console.warn("[suiPay] PTB build failed", e);
    // The most common cause is "not enough of this coin".
    throw new DeepLinkBuildError("insufficient_asset");
  }

  const payload: SuiSignTxPayload = {
    mode: "sign-and-execute",
    address: wallet.address,
    network: chain.network,
    transaction: toBase64(bytes),
  };
  return {
    namespace: "sui",
    kind: "signTransaction",
    origin: {
      url: "link://sui-pay",
      title: proto.label ? `${proto.label} (from the link)` : undefined,
      via: "deeplink",
    },
    wallet,
    payload,
    provenance,
    returnChannel: { kind: "broadcast" },
  };
}
