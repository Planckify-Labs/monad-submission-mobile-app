/**
 * `services/nanopay/useIntentStatus.ts` — TanStack Query bindings for
 * Circle Nanopayments Path B (spec §6.2, §6.3).
 *
 * Three hooks:
 *   - `useCreateIntent()` — mutation wrapping `POST /pay/intents`.
 *   - `useSubmitNanopay()` — mutation wrapping `submitNanopayAuthorization`.
 *   - `useIntentStatus(intentId)` — query polling `GET /pay/intents/:id`.
 *     `refetchInterval` returns `false` once `status` reaches a terminal
 *     value (`paid | paid_out | failed | expired`), so the component
 *     re-renders one more time and polling halts without the screen
 *     having to unmount the hook. See `isTerminalIntentStatus` in
 *     `./types.ts` for the canonical list.
 *
 * Conventions match `hooks/queries/*` (shared QueryClient from
 * `app/_layout.tsx`, shared `api` ky instance, `queryKey` as a tuple
 * literal the consumer can predict). We deliberately do NOT fork a
 * second query client — one cache, one dev-tools graph.
 */

import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { randomUUID } from "react-native-quick-crypto";
import { api, createApiForWallet } from "@/constants/configs/ky";
import type { OnchainSubmitResponse } from "./pathOnchainSettlement";
import {
  type SubmitNanopayAuthorizationArgs,
  type SubmitResult,
  submitNanopayAuthorization,
} from "./submit";
import {
  type CreateIntentRequest,
  isTerminalIntentStatus,
  type PaymentIntentResponse,
} from "./types";

/** Shared query-key tuple for a single intent — callers can invalidate off the same key. */
export const intentQueryKey = (
  intentId: string | undefined,
  walletAddress?: string,
) => ["pay-intent", intentId, walletAddress ?? null] as const;

async function fetchIntent(
  intentId: string,
  walletAddress?: string,
): Promise<PaymentIntentResponse> {
  const kyInstance = walletAddress ? createApiForWallet(walletAddress) : api;
  return kyInstance
    .get(`pay/intents/${encodeURIComponent(intentId)}`)
    .json<PaymentIntentResponse>();
}

async function createIntent(
  body: CreateIntentRequest,
  walletAddress?: string,
): Promise<PaymentIntentResponse> {
  const kyInstance = walletAddress ? createApiForWallet(walletAddress) : api;
  return kyInstance
    .post("pay/intents", {
      json: body,
      headers: { "Idempotency-Key": randomUUID() },
    })
    .json<PaymentIntentResponse>();
}

/**
 * Polls the backend for intent status. Stops polling once the status is
 * terminal (`paid | paid_out | failed | expired`). While in-flight
 * statuses (`pending | submitting | settling`), re-fetches every 3 s —
 * matches spec §6.3 ("Nanopay attestation is sub-second; one poll after
 * POST is usually enough").
 */
export function useIntentStatus(
  intentId: string | undefined,
  walletAddress?: string,
): UseQueryResult<PaymentIntentResponse> {
  return useQuery<PaymentIntentResponse>({
    queryKey: intentQueryKey(intentId, walletAddress),
    queryFn: () => {
      if (!intentId) {
        // The `enabled` gate prevents this path, but keep the runtime
        // invariant narrow so TS treats `intentId` as `string` below.
        throw new Error("useIntentStatus: intentId is required");
      }
      return fetchIntent(intentId, walletAddress);
    },
    enabled: !!intentId,
    staleTime: 5_000,
    refetchInterval: (query) => {
      const data = query.state.data as PaymentIntentResponse | undefined;
      if (isTerminalIntentStatus(data?.status)) return false;
      return 3_000;
    },
    // Keep polling paused when the screen backgrounds; iOS suspends the
    // query engine anyway, but being explicit beats a mysterious "why
    // isn't my poll firing" in the debugger.
    refetchIntervalInBackground: false,
  });
}

/** `POST /pay/intents` — returns the server-signed payment intent. */
export function useCreateIntent() {
  const queryClient = useQueryClient();
  return useMutation<
    PaymentIntentResponse,
    Error,
    CreateIntentRequest & { walletAddress?: string }
  >({
    mutationFn: ({ walletAddress, ...body }) =>
      createIntent(body, walletAddress),
    onSuccess: (intent, variables) => {
      queryClient.setQueryData(
        intentQueryKey(intent.id, variables.walletAddress),
        intent,
      );
    },
  });
}

/** POST /pay/intents/:id/nanopay — wraps `submitNanopayAuthorization`. */
export function useSubmitNanopay() {
  const queryClient = useQueryClient();
  return useMutation<SubmitResult, Error, SubmitNanopayAuthorizationArgs>({
    mutationFn: (args) => submitNanopayAuthorization(args),
    onSuccess: ({ intentId }) => {
      // Signal the polling query that something changed upstream so the
      // next status read happens immediately (instead of waiting for
      // the 3 s interval).
      // Two-element prefix so this matches both the wallet-less and
      // wallet-scoped variants of `intentQueryKey`. Building the full
      // tuple via `intentQueryKey(intentId)` pins walletAddress to
      // `null` and silently misses wallet-scoped observers.
      queryClient.invalidateQueries({ queryKey: ["pay-intent", intentId] });
    },
  });
}

/**
 * POST /pay/intents/:id/onchain — notifies the backend that the
 * user settled via the onchain settlement rail (TakumiPay contract).
 * The backend reconciles via on-chain events; this POST is a latency hint.
 */
export function useSubmitOnchain() {
  const queryClient = useQueryClient();
  return useMutation<
    OnchainSubmitResponse,
    Error,
    { intentId: string; txHash: `0x${string}`; chainId: number }
  >({
    mutationFn: async ({ intentId, txHash, chainId }) => {
      return api
        .post(`pay/intents/${encodeURIComponent(intentId)}/onchain`, {
          json: { txHash, chainId },
        })
        .json<OnchainSubmitResponse>();
    },
    onSuccess: (_, { intentId }) => {
      // Two-element prefix so this matches both the wallet-less and
      // wallet-scoped variants of `intentQueryKey`. Building the full
      // tuple via `intentQueryKey(intentId)` pins walletAddress to
      // `null` and silently misses wallet-scoped observers.
      queryClient.invalidateQueries({ queryKey: ["pay-intent", intentId] });
    },
  });
}
