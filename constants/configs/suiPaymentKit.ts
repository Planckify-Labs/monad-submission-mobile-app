/**
 * Mysten Payment Kit — pinned package ids (deep-link spec §6.3, D-3).
 *
 * Copied verbatim from `MystenLabs/ts-sdks`
 * `packages/payment-kit/src/constants.ts` (fetched 2026-09-11). The app
 * hand-rolls the `sui:pay` parser and the two Move calls instead of
 * taking `@mysten/payment-kit` (peer-requires `@mysten/sui ^2.30`; the
 * repo is on `^2.16`). `suiPaymentKit.test.ts` re-derives the default
 * registry id from `namespaceId` so drift in the derivation is caught.
 */

import { bcs } from "@mysten/sui/bcs";
import { deriveObjectID } from "@mysten/sui/utils";

export interface SuiPaymentKitPackageConfig {
  packageId: string;
  namespaceId: string;
}

export const SUI_PAYMENT_KIT_TESTNET: SuiPaymentKitPackageConfig = {
  packageId:
    "0x7e069abe383e80d32f2aec17b3793da82aabc8c2edf84abbf68dd7b719e71497",
  namespaceId:
    "0xa5016862fdccba7cc576b56cc5a391eda6775200aaa03a6b3c97d512312878db",
};

export const SUI_PAYMENT_KIT_MAINNET: SuiPaymentKitPackageConfig = {
  packageId:
    "0xbc126f1535fba7d641cb9150ad9eae93b104972586ba20f3c60bfe0e53b69bc6",
  namespaceId:
    "0xccd3e4c7802921991cd9ce488c4ca0b51334ba75483702744242284ccf3ae7c2",
};

export const SUI_PAYMENT_KIT_DEFAULT_REGISTRY_NAME = "default-payment-registry";

export function suiPaymentKitConfigFor(
  network: "mainnet" | "testnet" | "devnet",
): SuiPaymentKitPackageConfig | null {
  if (network === "mainnet") return SUI_PAYMENT_KIT_MAINNET;
  if (network === "testnet") return SUI_PAYMENT_KIT_TESTNET;
  // No devnet deployment is published by Mysten.
  return null;
}

/** Mirror of `getRegistryIdFromName` in Mysten `utils.ts`. */
export function suiPaymentKitRegistryIdFromName(
  registryName: string,
  namespaceId: string,
): string {
  return deriveObjectID(
    namespaceId,
    "0x1::ascii::String",
    bcs.String.serialize(registryName).toBytes(),
  );
}
