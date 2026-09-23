import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── module doubles ──────────────────────────────────────────────────────────
// The outbox imports its RN-flavoured collaborators statically (see the note
// at the top of the module: `import()` is a Metro split point); `vi.mock` is
// hoisted above those imports, so these doubles are what they resolve to.

// `vi.hoisted` so the doubles exist when the (equally hoisted) factories run.
const h = vi.hoisted(() => ({
  session: {
    active: "0xSENDER" as string | null,
    authed: true,
  },
  createTransaction: vi.fn(),
  searchTokens: vi.fn(),
  invalidateQueries: vi.fn(),
}));
const { session, createTransaction, searchTokens, invalidateQueries } = h;

vi.mock("@/services/auth/activeWalletSession", () => ({
  getActiveWalletAddress: async () => h.session.active,
  isAuthenticatedForWallet: async (addr: string) =>
    h.session.authed && addr.toLowerCase() === h.session.active?.toLowerCase(),
}));
vi.mock("@/api/endpoints/transactions", () => ({
  transactionApi: { createTransaction: h.createTransaction },
}));
vi.mock("@/api/endpoints/tokens", () => ({
  tokenApi: { searchTokens: h.searchTokens },
}));
vi.mock("@/app/_layout", () => ({
  queryClient: { invalidateQueries: h.invalidateQueries },
}));
vi.mock("@/constants/queryKeys/transactionsQueryKeys", () => ({
  transactionsQueryKeys: { all: ["transactions"] },
}));

import { storage } from "@/lib/storage/mmkv";
import {
  flushTransferRecordOutbox,
  pendingTransferRecordCount,
  readOutbox,
  recordTransfer,
} from "./transferRecordOutbox";

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

const transfer = (
  overrides: Partial<Parameters<typeof recordTransfer>[0]> = {},
) => ({
  fromAddress: "0xSENDER",
  toAddress: "0xRECIPIENT",
  amount: "5000000",
  txHash: "0xHASH1",
  token: { tokenId: "tk_usdc" },
  ...overrides,
});

beforeEach(() => {
  storage.clearAll();
  session.active = "0xSENDER";
  session.authed = true;
  createTransaction.mockReset();
  createTransaction.mockResolvedValue({ id: "tx_backend_1" });
  searchTokens.mockReset();
  invalidateQueries.mockReset();
});

describe("recordTransfer — the happy path is still one immediate POST", () => {
  it("posts right away, returns the backend id, clears the outbox and refreshes Activity", async () => {
    const id = await recordTransfer(transfer());

    expect(id).toBe("tx_backend_1");
    expect(createTransaction).toHaveBeenCalledWith({
      tokenId: "tk_usdc",
      type: "TRANSFER",
      amount: "5000000",
      txHash: "0xHASH1",
      fromAddress: "0xSENDER",
      toAddress: "0xRECIPIENT",
    });
    expect(pendingTransferRecordCount()).toBe(0);
    await flushMicrotasks();
    expect(invalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["transactions"] }),
    );
  });

  it("resolves a non-native token from the public catalog at post time and carries PAYMENT through", async () => {
    searchTokens.mockResolvedValue([{ id: "tk_ausd" }]);

    await recordTransfer(
      transfer({
        token: { contractAddress: "0xAUSD", blockchainId: "bc_monad" },
        type: "PAYMENT",
      }),
    );

    expect(searchTokens).toHaveBeenCalledWith({
      contractAddress: "0xAUSD",
      blockchainId: "bc_monad",
    });
    expect(createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: "tk_ausd", type: "PAYMENT" }),
    );
  });
});

describe("recordTransfer — what used to be silently lost is now kept", () => {
  it("keeps the record when the sending wallet has no session, and never throws", async () => {
    session.authed = false;

    const id = await recordTransfer(transfer());

    expect(id).toBeUndefined();
    expect(createTransaction).not.toHaveBeenCalled();
    const [entry] = readOutbox();
    expect(entry).toMatchObject({
      key: "0xhash1",
      txHash: "0xHASH1",
      attempts: 1,
      lastError: "no session",
    });
  });

  it("keeps the record when the request fails (offline / 5xx)", async () => {
    createTransaction.mockRejectedValueOnce(
      new Error("Network request failed"),
    );

    const id = await recordTransfer(transfer());

    expect(id).toBeUndefined();
    expect(readOutbox()[0]).toMatchObject({
      attempts: 1,
      lastError: "Network request failed",
    });
  });

  it("keeps the record when createTransaction answers `{}` (its own no-session shape)", async () => {
    createTransaction.mockResolvedValueOnce({});

    await recordTransfer(transfer());

    expect(pendingTransferRecordCount()).toBe(1);
  });

  it("de-duplicates by tx hash (case-insensitively) so a retry can never double-record", async () => {
    session.authed = false;
    await recordTransfer(transfer({ txHash: "0xABC" }));
    await recordTransfer(transfer({ txHash: "0xabc" }));

    expect(pendingTransferRecordCount()).toBe(1);
  });

  it("ignores an unusable input instead of persisting junk", async () => {
    await recordTransfer(transfer({ txHash: "" }));
    expect(pendingTransferRecordCount()).toBe(0);
  });
});

describe("flushTransferRecordOutbox", () => {
  it("posts queued records once the wallet has a session again", async () => {
    session.authed = false;
    await recordTransfer(transfer({ txHash: "0xA" }));
    await recordTransfer(transfer({ txHash: "0xB" }));
    expect(pendingTransferRecordCount()).toBe(2);

    session.authed = true;
    const result = await flushTransferRecordOutbox();

    expect(result).toEqual({ posted: 2, remaining: 0, dropped: 0 });
    expect(createTransaction).toHaveBeenCalledTimes(2);
    expect(pendingTransferRecordCount()).toBe(0);
  });

  it("never files a record under a different wallet: entries wait until their sender is active", async () => {
    session.authed = false;
    await recordTransfer(transfer({ txHash: "0xA", fromAddress: "0xSENDER" }));

    // Now a different wallet is active and signed in.
    session.active = "0xOTHER";
    session.authed = true;
    const result = await flushTransferRecordOutbox();

    expect(result).toEqual({ posted: 0, remaining: 1, dropped: 0 });
    expect(createTransaction).not.toHaveBeenCalled();

    // Switch back — now it goes.
    session.active = "0xsender"; // casing must not matter
    const again = await flushTransferRecordOutbox();
    expect(again.posted).toBe(1);
  });

  it("drops a record that can never post (token not in catalog) rather than retrying forever", async () => {
    // First attempt: token resolves but the POST is offline → kept.
    searchTokens.mockResolvedValueOnce([{ id: "tk_gone" }]);
    createTransaction.mockRejectedValueOnce(new Error("offline"));
    await recordTransfer(
      transfer({ token: { contractAddress: "0xGONE", blockchainId: "bc" } }),
    );
    expect(pendingTransferRecordCount()).toBe(1);
    // Flush: the token has since vanished from the catalog → give up.
    searchTokens.mockResolvedValue([]);

    const result = await flushTransferRecordOutbox();

    expect(result).toEqual({ posted: 0, remaining: 0, dropped: 1 });
    expect(pendingTransferRecordCount()).toBe(0);
  });

  it("expires week-old records", async () => {
    session.authed = false;
    await recordTransfer(transfer({ txHash: "0xOLD" }));
    const [entry] = readOutbox();
    storage.set(
      "takumipay_transfer_record_outbox",
      JSON.stringify([
        { ...entry, createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000 },
      ]),
    );
    session.authed = true;

    const result = await flushTransferRecordOutbox();

    expect(result.dropped).toBe(1);
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("survives a corrupt outbox blob", async () => {
    storage.set("takumipay_transfer_record_outbox", "{not json");

    await expect(flushTransferRecordOutbox()).resolves.toEqual({
      posted: 0,
      remaining: 0,
      dropped: 0,
    });
    expect(await recordTransfer(transfer())).toBe("tx_backend_1");
  });
});
