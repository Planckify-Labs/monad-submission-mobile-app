/**
 * Bootstrap the indexer registry with available providers.
 * Import this once from app/_layout.tsx to register providers at startup.
 */

import { DirectRPCProvider } from "./DirectRPCProvider";
import { indexerRegistry } from "./registry";
import { ZerionNftProvider } from "./ZerionNftProvider";

// NFTs first: it is the only provider that can enumerate what a wallet owns,
// and it declines everything else so the baseline still serves balances.
indexerRegistry.register(new ZerionNftProvider());

// Register the baseline fallback provider
indexerRegistry.register(new DirectRPCProvider());
