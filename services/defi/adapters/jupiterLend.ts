/**
 * Jupiter Lend Earn adapter — ONE `DefiProtocolAdapter` covering every
 * single-asset Earn vault (USDC, WSOL, USDT, EURC, USDS, USDG, JupUSD — 7
 * live 2026-08-23), routed by `DepositTarget.kind === "jupiter-lend-vault"`
 * and parameterized by `target.asset` (the underlying mint), mirroring
 * `Erc4626Adapter`'s "one kind-routed adapter for the whole family" shape.
 *
 * Uses the OFFICIAL `@jup-ag/lend` SDK (`getDepositIxs`/`getWithdrawIxs`/
 * `getUserLendingPositionByAsset`) rather than hand-rolled instructions —
 * unlike the Solana LST family, the protocol's own program source is NOT
 * public (only the IDL + reference CPI snippets are), so the PDA seeds for
 * `lending`/`lending_admin`/`f_token_mint`/`vault`/`rate_model`/etc. cannot
 * be independently derived without guessing. The SDK is the only
 * non-guessing path.
 *
 * Cross-checked before adopting: the SDK's bundled `PROGRAM_IDS.lending.main`
 * constant (`jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9`) matches the
 * program address published in the repo's own `target/idl/lending.json`
 * exactly, and the account list + discriminators in that IDL match the
 * repo's `references/earn/{deposit,withdraw}.rs` byte-for-byte.
 *
 * Dependency note (2026-08-23): `@jup-ag/lend` pulls `@coral-xyz/anchor` and
 * `bn.js`. `bn.js` is one of the three packages that has already force-
 * closed this app via the frozen-`Object.prototype` bug (`pollyfills.ts`).
 * Verified before shipping: `pnpm why bn.js` shows the SAME already-warmed
 * copy (no duplicate instance), and `pnpm check:protofreeze` passes clean
 * (no new `Object.prototype`-shadowing export introduced). Still needs an
 * EAS build + on-device `adb shell am force-stop` retest before this ships
 * to production — the automated checks are strong signals, not a runtime
 * guarantee (Fast Refresh hides exactly this class of bug).
 *
 * Withdraw is asset-denominated on-chain (`withdraw(assets: u64)`, per the
 * IDL and reference source — NOT shares), which matches `amount_raw`'s
 * documented contract ("the position asset's smallest unit") with ZERO
 * off-chain rate math needed — unlike the LST family, there is no
 * SOL→receipt-token conversion step here to get wrong.
 *
 * `market` (Jupiter Lend segments some assets under a separate "ethena"
 * program deployment — confirmed via the SDK's own bundled `PROGRAM_IDS`
 * constants) is always "main": all 7 live Earn assets resolve there per
 * `lite-api.jup.ag/lend/v1/earn/tokens`, and "main" is the SDK's own
 * default. An asset that turned out to need "ethena" would fail loudly at
 * build/execution time (an on-chain account-not-found), never silently
 * misroute funds.
 */

import {
  getDepositIxs,
  getUserLendingPositionByAsset,
  getWithdrawIxs,
} from "@jup-ag/lend/earn";
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { DefiError } from "../errors/defiErrors";
import type {
  BuildDepositArgs,
  BuildWithdrawArgs,
  DefiPosition,
  DefiProtocolAdapter,
  DepositTarget,
  PositionReadContext,
  UnsignedCall,
} from "../types";

const SLUG = "jupiter-lend";
const CLUSTER = "mainnet-beta" as const;

function devWarn(scope: string, err: unknown): void {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn(`[jupiterLend] ${scope}:`, err);
  }
}

function makeConnection(rpcUrl: string | undefined): Connection {
  return new Connection(
    rpcUrl || "https://api.mainnet-beta.solana.com",
    "confirmed",
  );
}

function requireJupiterLendTarget(
  target: DepositTarget | undefined,
): Extract<DepositTarget, { kind: "jupiter-lend-vault" }> {
  if (!target || target.kind !== "jupiter-lend-vault") {
    throw new DefiError(
      "protocol_not_found",
      "jupiter-lend: a resolved { kind: 'jupiter-lend-vault' } target is required",
    );
  }
  return target;
}

export const JupiterLendAdapter: DefiProtocolAdapter = {
  slug: SLUG,
  namespace: "solana",
  kind: "yield_vault",
  chainId: CLUSTER,
  displayName: "Jupiter Lend",
  externalSlugs: [SLUG],
  targetKinds: ["jupiter-lend-vault"],

  async buildDeposit({
    wallet,
    chain,
    amount,
    target,
  }: BuildDepositArgs): Promise<UnsignedCall> {
    if (chain.namespace !== "solana") {
      throw new DefiError(
        "unsupported_chain",
        "jupiter-lend: requires solana namespace",
      );
    }
    const t = requireJupiterLendTarget(target);
    const connection = makeConnection(chain.rpcUrl);
    const { ixs } = await getDepositIxs({
      amount: new BN(amount.toString()),
      asset: new PublicKey(t.asset),
      signer: new PublicKey(wallet.address),
      connection,
    });
    return { kind: "solana-ix", instructions: ixs };
  },

  async buildWithdraw({
    wallet,
    chain,
    amount,
    target,
  }: BuildWithdrawArgs): Promise<UnsignedCall> {
    if (chain.namespace !== "solana") {
      throw new DefiError(
        "unsupported_chain",
        "jupiter-lend: requires solana namespace",
      );
    }
    const t = requireJupiterLendTarget(target);
    const connection = makeConnection(chain.rpcUrl);
    const asset = new PublicKey(t.asset);
    const signer = new PublicKey(wallet.address);

    let assets: bigint;
    if (amount === "MAX") {
      const position = await getUserLendingPositionByAsset({
        user: signer,
        asset,
        connection,
        market: "main",
      });
      assets = BigInt(position.underlyingAssets.toString());
      if (assets <= 0n) {
        throw new DefiError("position_not_found", "jupiter-lend: no position");
      }
    } else {
      assets = amount;
    }

    const { ixs } = await getWithdrawIxs({
      amount: new BN(assets.toString()),
      asset,
      signer,
      connection,
    });
    return { kind: "solana-ix", instructions: ixs };
  },

  async readPosition(
    walletAddress: string,
    ctx?: PositionReadContext,
  ): Promise<DefiPosition | null> {
    if (ctx?.target?.kind !== "jupiter-lend-vault") return null;
    try {
      const connection = makeConnection(undefined);
      const position = await getUserLendingPositionByAsset({
        user: new PublicKey(walletAddress),
        asset: new PublicKey(ctx.target.asset),
        connection,
        market: "main",
      });
      const currentAmount = BigInt(position.underlyingAssets.toString());
      if (currentAmount <= 0n) return null;

      return {
        protocolSlug: SLUG,
        namespace: "solana",
        chainId: CLUSTER,
        assetSymbol: ctx.assetSymbol ?? "",
        amountAtDeposit: 0n,
        amountAtDepositUsd: 0,
        currentAmount,
        currentAmountUsd: 0,
        pnlUsd: 0,
      };
    } catch (err) {
      devWarn("readPosition", err);
      return null;
    }
  },
};
