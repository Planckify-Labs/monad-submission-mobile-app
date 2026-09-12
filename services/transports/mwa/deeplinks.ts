/**
 * MWA scheme registration lives with the Solana handlers
 * (`services/chains/solana/deeplinks.ts#mwaAssociateHandler`, Android
 * only) and the universal-link path in `services/deeplinks/paths/mwa.ts`.
 * Re-exported here so the transport directory matches the spec's file
 * map (§13.1).
 */

export { mwaAssociateHandler } from "@/services/chains/solana/deeplinks";
