import * as SecureStore from "expo-secure-store";

const STORAGE_KEY = "dapp_bridge.bundle_status";

export type BundleCallStatus =
  | { status: "PENDING" }
  | {
      status: "CONFIRMED";
      receipt: {
        transactionHash: `0x${string}`;
        blockNumber?: string;
        status: "0x1" | "0x0";
      };
    }
  | { status: "FAILED"; error: string };

/**
 * Terminal states map onto EIP-5792 `wallet_getCallsStatus` codes at the
 * RPC boundary (`EvmAdapter`):
 *
 *   PENDING        → 100
 *   CONFIRMED      → 200
 *   FAILED         → 500  (reverted completely — nothing landed)
 *   FAILED_PARTIAL → 600  (reverted partially — some calls landed)
 *
 * The 500/600 split only arises on the sequential EOA path, where an
 * early call can be mined before a later one throws. Reporting that as
 * 500 would tell the dApp no state changed, which is exactly wrong.
 */
export interface BundleStatusRecord {
  bundleId: string;
  chainId: number;
  from: `0x${string}`;
  atomic: boolean;
  calls: Array<{
    /** Absent for a contract-creation call. */
    to?: `0x${string}`;
    value?: string;
    data?: `0x${string}`;
  }>;
  receipts: Array<BundleCallStatus>;
  status: "PENDING" | "CONFIRMED" | "FAILED" | "FAILED_PARTIAL";
  userOpHash?: `0x${string}`;
  createdAt: number;
  updatedAt: number;
}

let state: Record<string, BundleStatusRecord> = {};
let hydrated = false;

async function hydrate(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    if (raw) state = JSON.parse(raw) as Record<string, BundleStatusRecord>;
  } catch {
    state = {};
  }
}

async function persist(): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // best effort
  }
}

export const BundleStatusStore = {
  hydrate,
  async create(record: BundleStatusRecord): Promise<void> {
    await hydrate();
    state[record.bundleId] = record;
    await persist();
  },
  async update(
    bundleId: string,
    patch: Partial<BundleStatusRecord>,
  ): Promise<void> {
    await hydrate();
    if (!state[bundleId]) return;
    state[bundleId] = {
      ...state[bundleId],
      ...patch,
      updatedAt: Date.now(),
    };
    await persist();
  },
  get(bundleId: string): BundleStatusRecord | null {
    return state[bundleId] ?? null;
  },
  list(): BundleStatusRecord[] {
    return Object.values(state);
  },
};
