/**
 * Doc-sourced protocol coordinates — single source of truth for the
 * mobile DeFi adapters.
 *
 * The spec (§22 / Appendix B) lists these as either npm-packaged
 * (`@bgd-labs/aave-address-book`) or hardcoded. We mirror the
 * authoritative values here so each adapter does NOT have to resolve
 * them through `chain.smartContracts` (which is fragile if a seed row
 * is missing) but CAN fall back to it when present (lets ops swap
 * addresses on staging without a code change).
 *
 * Citation per address lives next to the constant. When a vendor SDK
 * is later added (e.g. `@bgd-labs/aave-address-book@latest`) the
 * adapter switches its import without changing other call sites.
 */

import type { Hex } from "viem";

// ─────────────────────────────── Aave V3 ──────────────────────────────
// Sources:
//  - https://aave.com/docs/aave-v3/smart-contracts/pool
//  - https://www.npmjs.com/package/@bgd-labs/aave-address-book
//  - Etherscan / Basescan / Arbiscan (verified contracts).
export const AAVE_V3 = {
  ethereum: {
    chainId: 1,
    pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2" as Hex,
    poolDataProvider: "0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3" as Hex,
    rewardsController: "0x8164Cc65827dcFe994AB23944CBC90e0aa80bFcb" as Hex,
  },
  base: {
    chainId: 8453,
    // Verified on-chain 2026-08-15: Aave's own PoolAddressesProvider on Base
    // (0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D) reports this as `getPool()`.
    // The previous value here (0xA238Dd80C259a72e81d7e4674A983a59f1ad673e) had
    // NO CODE on Base at all — a `supply()` to it would have returned success
    // while moving nothing, so the app reported a deposit the user never got.
    // Caught by services/defi/addressBookParity.test.ts.
    pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as Hex,
    // NOTE: the provider now reports 0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A
    // as the pool data provider. The address below still has code (the earlier
    // deployment), so it is stale rather than broken — left as-is because
    // rotating a read path is a separate, reviewable change.
    poolDataProvider: "0xd82a47fdebB5bf5329b09441C3DaB4b5df2153Ad" as Hex,
    rewardsController: "0xf9cc4F0D883F1a1eb2c253bdb46c254Ca51E1F44" as Hex,
  },
  arbitrum: {
    chainId: 42161,
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" as Hex,
    poolDataProvider: "0x7F23D86Ee20D869112572136221e173428DD740B" as Hex,
    rewardsController: "0x929EC64c34a17401F460460D4B9390518E5B473e" as Hex,
  },
  // Testnets — for the testnet QA flow (§23.3). aTokens / underlyings come
  // from Aave's faucet which `aavefaucet.com` mints; we just need the Pool.
  ethereumSepolia: {
    chainId: 11155111,
    pool: "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951" as Hex,
    poolDataProvider: "0x927F584d4321C1dCcBf5e2902368124b02419a1E" as Hex,
    rewardsController: "0x4DA5c4da71C5a167171cC839487536d86e083483" as Hex,
  },
  baseSepolia: {
    chainId: 84532,
    pool: "0x07eA79F68B2B3df564D0A34F8e19D9B1e339814b" as Hex,
    poolDataProvider: "0xdec597A4ba89C0AFcA690bB1cFF94c10E3ed3145" as Hex,
    rewardsController: "0xBA0F66c5429F4caDD89BE74Da2eaB67D7e4F4E59" as Hex,
    // Aave V3 Base Sepolia currently has 2 listed reserves (verified
    // via Pool.getReservesList()): Circle's official USDC + WETH.
    underlyings: {
      USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Hex,
      WETH: "0x4200000000000000000000000000000000000006" as Hex,
    },
  },
  arbitrumSepolia: {
    chainId: 421614,
    pool: "0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff" as Hex,
    poolDataProvider: "0x6A0fE2dD4d8b5a4736bA517F18b04E0E5b21CC52" as Hex,
    rewardsController: "0x3A203B14CF8749a1e3b7314c6c49004B77Ee667A" as Hex,
  },
} as const;

// ─────────────────────────────── Lido ─────────────────────────────────
// Source: https://docs.lido.fi/contracts/lido-locator
export const LIDO = {
  mainnet: {
    chainId: 1,
    steth: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84" as Hex,
    wsteth: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" as Hex,
    withdrawalQueue: "0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1" as Hex,
  },
  holesky: {
    chainId: 17000,
    steth: "0x3F1c547b21f65e10480dE3ad8E19fAAC46C95034" as Hex,
    wsteth: "0x8d09a4502Cc8Cf1547aD300E066060D043f6982D" as Hex,
    withdrawalQueue: "0xc7cc160b58F8Bb0baC94b80847E2CF2800565C50" as Hex,
  },
} as const;

// ─────────────────────────────── Curve 3pool ──────────────────────────
// Source: https://etherscan.io/address/0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7
// and https://etherscan.io/token/0x6c3f90f043a72fa612cbac8115ee7e52bde6e490
export const CURVE_3POOL = {
  mainnet: {
    chainId: 1,
    pool: "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7" as Hex,
    lpToken: "0x6c3F90f043a72FA612cbac8115EE7e52BDe6E490" as Hex,
    coins: {
      // index 0 = DAI, 1 = USDC, 2 = USDT
      DAI: {
        contract: "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Hex,
        index: 0,
        decimals: 18,
      },
      USDC: {
        contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Hex,
        index: 1,
        decimals: 6,
      },
      USDT: {
        contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Hex,
        index: 2,
        decimals: 6,
      },
    },
  },
} as const;

// ─────────────────────────────── Morpho ───────────────────────────────
// Source: https://docs.morpho.org/build/earn/concepts/vault-mechanics/
// Curated Morpho MetaMorpho vaults (ERC-4626). One slug per (vault, chain).
export const MORPHO_VAULTS = {
  // Steakhouse USDC (Ethereum)
  "morpho-steakhouse-usdc-eth": {
    chainId: 1,
    vault: "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB" as Hex,
    asset: "USDC",
    assetContract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Hex,
    assetDecimals: 6,
  },
  // Moonwell Flagship USDC (Base) — example Base vault
  "morpho-flagship-usdc-base": {
    chainId: 8453,
    vault: "0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca" as Hex,
    asset: "USDC",
    assetContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Hex,
    assetDecimals: 6,
  },
} as const;

// ─────────────────────────────── Yearn V3 ─────────────────────────────
// Source: https://docs.yearn.fi/developers/v3/Integrating_v3
//         https://github.com/yearn/Yearn-ERC4626-Router
export const YEARN_V3 = {
  routerEthereum: "0x1112dbCF805682e828606f74AB717abf4b4FD8DE" as Hex,
  // Curated vaults — yvUSDC v3 on mainnet.
  vaults: {
    "yearn-v3-usdc-eth": {
      chainId: 1,
      vault: "0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204" as Hex,
      asset: "USDC",
      assetContract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Hex,
      assetDecimals: 6,
    },
  },
} as const;

// ─────────────────────────── EigenLayer ──────────────────────────────
// Source: https://docs.eigencloud.xyz/eigenlayer/developers/concepts/eigenlayer-contracts/deployed-contracts
export const EIGENLAYER = {
  mainnet: {
    chainId: 1,
    strategyManager: "0x858646372CC42E1A627fcE94aa7A7033e7CF075A" as Hex,
    delegationManager: "0x39053D51B77DC0d36036Fc1fCc8Cb819df8Ef37A" as Hex,
    // stETH strategy (LST restaking). Source: EigenLayer docs.
    stEthStrategy: "0x93c4b944D05dfe6df7645A86cd2206016c51564D" as Hex,
    minWithdrawalDelayBlocks: 50400, // ~7 days
  },
  holesky: {
    chainId: 17000,
    strategyManager: "0xdfB5f6CE42aAA7830E94ECFCcAd411beF4d4D5b6" as Hex,
    delegationManager: "0xA44151489861Fe9e3055d95adC98FbD462B948e7" as Hex,
    stEthStrategy: "0x7D704507b76571a51d9caE8AdDAbBFd0ba0e63d3" as Hex,
    minWithdrawalDelayBlocks: 50,
  },
} as const;

// ─────────────────────────────── Ethena ───────────────────────────────
// Source: https://docs.ethena.fi/solution-design/staking-usde
export const ETHENA = {
  mainnet: {
    chainId: 1,
    sUSDe: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497" as Hex,
    USDe: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3" as Hex,
    cooldownDurationSeconds: 7 * 24 * 60 * 60, // 7 days
  },
} as const;

// ─────────────────────────────── GMX v2 ────────────────────────────────
// Source: https://docs.gmx.io/docs/api/contracts-v2
export const GMX_V2 = {
  arbitrum: {
    chainId: 42161,
    exchangeRouter: "0xb7a9C9D9D7c0e8Db8Df0DCe9eDDFc83AC0a3f74D" as Hex,
    depositVault: "0xF89e77e8Dc11691C9e8757e84aaFbCD8A67d7A55" as Hex,
    withdrawalVault: "0x0628D46b5D145f183AdB6Ef1f2c97eD1C4701C55" as Hex,
    reader: "0x0537C767cDAC0726c76Bb89e92904fe28fd02fE1" as Hex,
    dataStore: "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8" as Hex,
    glvVault: "0x393053B58f9678C9c28c2cE941fF6cac49C3F8f9" as Hex,
  },
} as const;

// ─────────────────────────── Solana — Jito ──────────────────────────
// Source: https://www.jito.network/docs/jitosol/jitosol-liquid-staking/security/deployed-programs/
export const JITO = {
  // SPL Stake Pool Program — shared across all SPL-LSTs.
  splStakePoolProgram: "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy",
  // Jito-SOL stake pool account.
  stakePool: "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb",
  // Jito-SOL SPL mint.
  jitoSolMint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  // Stake-deposit interceptor (when depositing native stake accounts).
  stakeDepositInterceptor: "5TAiuAh3YGDbwjEruC1ZpXTJWdNDS7Ur7VeqNNiHMmGV",
} as const;

// ─────────────────────────── Solana — Maple ─────────────────────────
// syrupUSDC on Solana is operated via Maple's permissioned pool with an
// ERC-4626-like share token. The mint is the source of truth for
// position reads. Source: maple.finance / cloud.maple.finance docs.
export const MAPLE_SOLANA = {
  // syrupUSDC SPL mint. NOTE: confirm against Maple docs before
  // mainnet enablement — if address drifts, update this constant.
  syrupUsdcMint: "5y6HVwV8V2hHrBfEcWnoFEeJ7dC4u8B9CR4d44tBefnT",
  // Maple permissioned pool program (anchor-managed).
  poolProgram: "5y6HVwV8V2hHrBfEcWnoFEeJ7dC4u8B9CR4d44tBefnT",
  // Pool authority + USDC mint (standard SPL USDC on mainnet)
  usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
} as const;
