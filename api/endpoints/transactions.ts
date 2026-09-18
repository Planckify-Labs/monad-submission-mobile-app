import { api } from "@/constants/configs/ky";
import { isAuthenticatedForActiveWallet } from "@/services/auth/activeWalletSession";
import type {
  TCreateTransactionRequest,
  TPaymentTransactionDetail,
  TTransaction,
  TTransactionListResponse,
  TTransactionType,
} from "../types/transaction";
import { createItem, fetchById, searchItems } from "../utils/api-helpers";

export const transactionApi = {
  getMyHistory: async (
    params: { type?: TTransactionType; take?: number } = {},
  ) => {
    const isAuthed = await isAuthenticatedForActiveWallet();
    if (!isAuthed) {
      return [] as TTransactionListResponse;
    }

    const searchParams = { take: 10, ...params };

    return searchItems<TTransactionListResponse>(
      api,
      "transactions/my-history",
      searchParams,
      "Failed to fetch transaction history",
    );
  },

  getTransactionById: async (id: string) => {
    const isAuthed = await isAuthenticatedForActiveWallet();
    if (!isAuthed) {
      return {} as TTransaction;
    }

    return fetchById<TTransaction>(
      api,
      "transactions",
      id,
      "Failed to fetch transaction",
    );
  },

  getPaymentDetail: async (id: string) => {
    const isAuthed = await isAuthenticatedForActiveWallet();
    if (!isAuthed) {
      return {} as TPaymentTransactionDetail;
    }

    return fetchById<TPaymentTransactionDetail>(
      api,
      "transactions/payment",
      id,
      "Failed to fetch payment detail",
    );
  },

  createTransaction: async (payload: TCreateTransactionRequest) => {
    const isAuthed = await isAuthenticatedForActiveWallet();
    if (!isAuthed) {
      return {} as TTransaction;
    }

    return createItem<TCreateTransactionRequest, TTransaction>(
      api,
      "transactions",
      payload,
      "Failed to create transaction",
    );
  },
};
