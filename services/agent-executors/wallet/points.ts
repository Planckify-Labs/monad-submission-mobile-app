/**
 * Points & Redemption mobile tool executors (protocol v1.1 §11–§14).
 *
 * Implements the 12 `category: "points"` tools that need to run on the
 * mobile (the 13th — `request_authentication` — lives in `simulate.ts`,
 * owned by task 17). All of these are `executor: "mobile"` per the
 * v1.1 protocol re-architecture: the agent server never touches the
 * user's JWT, refresh token, or any other credential. Authenticated
 * tools route through the existing `api` ky instance (which loads the
 * Bearer token from secure storage); public tools route through
 * `publicApi`. The agent does not know — or need to know — which client
 * is used.
 *
 * Tools implemented in this file:
 *
 *   Reads (public — no JWT required):
 *     - get_redemption_catalog
 *     - search_redemption_catalog
 *     - get_product_details
 *     - get_product_input_fields
 *     - get_points_price
 *
 *   Reads (auth required):
 *     - get_redemption_categories
 *     - get_points_balance
 *     - get_points_history
 *     - get_redemption_status
 *     - get_redemption_history
 *
 *   Writes (auth required + approval-sheet gated):
 *     - deposit_points        — on-chain ERC20 deposit + API registration
 *     - execute_redemption    — irreversible points spend, API + voucher poll
 *
 * The dispatcher (`services/agentSession/dispatcher.ts`) is responsible
 * for showing the approval sheet (UX treatment `confirm`) before the
 * write executors here are invoked — by the time we run, the user has
 * already approved. We don't redundantly request approval inside the
 * executor.
 *
 * Error handling: every API failure is funneled through
 * `classifyPointsError()` so the agent sees a stable
 * `PointsApiErrorCode` rather than a raw HTTP body. Until task 18 lands
 * its real implementation we ship a small inline stub — see the
 * `// TODO: task 18` markers below. Sanitization of API response bodies
 * also has a passthrough stub for the same reason.
 */

import { erc20Abi, parseUnits } from "viem";
import { pointsApi } from "@/api/endpoints/points";
import { productApi } from "@/api/endpoints/products";
import { redeemApi } from "@/api/endpoints/redeem";
import { smartContractApi } from "@/api/endpoints/smart-contracts";
import type { TProductInputField } from "@/api/types/product";
import AbiTakumiPay from "@/contracts/abis/AbiTakumiPay";
import { toCatalogDisplayProducts } from "@/services/catalog/catalogDisplay";
import { requireWalletClient, resolveChainClients } from "../chainRouter";
import { checkPointsAuth } from "../pointsAuth";
import {
  ExecutorError,
  ExecutorErrorCode,
  type MobileToolExecutor,
  optionalString,
  requireString,
  resolveChainId,
  safeExecute,
  type ToolInput,
} from "../types";
import { classifyPointsError, sanitizeApiResponse } from "../utils";
import { loadCachedTokens } from "./reads";

/**
 * Pre-flight auth guard for points executors that require a JWT.
 *
 * Without this, the ky `beforeRequest` hook in `constants/configs/ky.ts`
 * throws before the HTTP call goes out when no token is stored for the
 * active wallet — and the 401 handler for stale tokens also force-
 * navigates to `/auth`. Both flows would rip the user away from the
 * agent mid-turn with no chance for the agent to explain.
 *
 * By short-circuiting locally with a clean `authentication_required`
 * result, the agent gets a stable signal it can narrate ("sign in to
 * check your points") and the user stays on the chat screen — they
 * decide when to sign in, not us.
 */
async function requireAuthed(
  context: Parameters<MobileToolExecutor>[1],
): Promise<{ status: "failed"; error: "authentication_required" } | null> {
  const addr = context.wallet?.address;
  if (!addr) {
    return { status: "failed", error: "authentication_required" };
  }
  const authed = await checkPointsAuth(addr);
  if (!authed) {
    return { status: "failed", error: "authentication_required" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap an async API call so any rejection produces a `ToolResult` with a
 * classified `PointsApiErrorCode`. Used by every points executor — keeps
 * the per-tool body to a single try/catch and centralises the
 * sanitization invariant.
 */
async function runApi<T>(
  fn: () => Promise<T>,
  shape: (raw: T) => unknown | { data: unknown; display?: unknown },
): Promise<
  | { status: "success"; data: unknown; display?: unknown }
  | { status: "failed"; error: string }
> {
  try {
    const raw = await fn();
    const shaped = shape(raw);
    // Detect the split-payload shape. Opt-in marker is the `display`
    // key: if present, treat `shaped` as `{ data, display }`. Legacy
    // transformers return the data blob directly and stay unchanged.
    if (
      shaped !== null &&
      typeof shaped === "object" &&
      "display" in (shaped as object) &&
      "data" in (shaped as object)
    ) {
      const split = shaped as { data: unknown; display: unknown };
      return {
        status: "success",
        data: sanitizeApiResponse(split.data),
        display: sanitizeApiResponse(split.display),
      };
    }
    return { status: "success", data: sanitizeApiResponse(shaped) };
  } catch (err) {
    const error = classifyPointsError(err);
    // Raw error stays in dev logs only (CLAUDE.md user-facing-error
    // rule); the executor surfaces a curated code to the agent.
    if (__DEV__) {
      console.warn(
        `[agent-executors/points] runApi failed (${error}):`,
        err instanceof Error ? err.message : err,
      );
    }
    return { status: "failed", error };
  }
}

/**
 * Optional integer reader — returns undefined if missing, throws on
 * non-integer values.
 */
function optionalInt(input: ToolInput, key: string): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ExecutorError(ExecutorErrorCode.InvalidInput, `invalid_${key}`);
  }
  return value;
}

/**
 * Optional boolean reader — returns undefined if missing, tolerates the
 * string forms ("true"/"false") the LLM sometimes emits, throws on
 * anything else.
 */
function optionalBool(input: ToolInput, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ExecutorError(ExecutorErrorCode.InvalidInput, `invalid_${key}`);
}

/**
 * Optional non-negative number reader — used for the points-range filters
 * (`min_points` / `max_points`). Tolerates the numeric-string form the LLM
 * sometimes emits ("2300"), returns undefined when absent, throws on
 * negative or non-numeric values.
 */
function optionalNonNegativeNumber(
  input: ToolInput,
  key: string,
): number | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new ExecutorError(ExecutorErrorCode.InvalidInput, `invalid_${key}`);
  }
  return n;
}

/**
 * Catalog / search pagination guardrail.
 *
 * The LLM can hallucinate a huge `take` (e.g. "show me what I can
 * redeem with 200,000 points" → `take: 200000`) which trips the
 * backend's request validator and surfaces as a generic 4xx that
 * `classifyPointsError` can only label `unknown_error`. Clamp here so
 * the LLM never reaches the backend with a value the catalog can't
 * serve. This MUST match the backend's `SEARCH_MAX_TAKE` (products
 * service) — the backend is the real authority, this is just a fast
 * fail-safe so the agent never sends an absurd page size.
 */
const MAX_CATALOG_TAKE = 24;

function clampTake(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value <= 0) return undefined;
  return Math.min(value, MAX_CATALOG_TAKE);
}

// ---------------------------------------------------------------------------
// Read executors — public (no JWT)
// ---------------------------------------------------------------------------

/**
 * `get_redemption_catalog` — grouped product catalog for the agent to
 * show "what can I redeem with my points?". Public endpoint.
 */
export const getRedemptionCatalog: MobileToolExecutor = (input, _context) =>
  safeExecute(async () => {
    const take = clampTake(optionalInt(input, "take"));
    // `data` is the compact agent-facing slice: category names + product
    // ids so the agent can say "pick a product id and I'll pull details"
    // without re-narrating the full list. Rich UI data (images,
    // descriptions) goes in `display` and is stripped before the LLM
    // sees it — see `protocol.ts::ToolResult`.
    return runApi(
      () => productApi.getProductsByCategories(take),
      (raw) => {
        const displayGroups = raw.map((g) => ({
          category: { id: g.category.id, name: g.category.name },
          products: g.products.map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description,
            image_url: p.imageUrl ?? null,
            code: p.code,
            input_type: p.inputType ?? null,
          })),
        }));
        return {
          data: {
            groups: displayGroups.map((g) => ({
              category: g.category,
              product_ids: g.products.map((p) => p.id),
              product_count: g.products.length,
            })),
          },
          display: { groups: displayGroups },
        };
      },
    );
  });

/**
 * `search_redemption_catalog` — flexible product search. Public endpoint.
 *
 * Accepts any combination of:
 *   - `query`     — free-text across name / code / vendor / category, the
 *                   primary lever for natural requests ("gaming",
 *                   "telkomsel", "mobile legends").
 *   - `name`      — exact product-name substring.
 *   - `category`  — category name ("gaming", "pulsa", "voucher"). Resolved
 *                   server-side, so the agent never needs the category UUID.
 *   - `category_id` — category UUID (when the agent already has one).
 *   - `is_voucher`  — voucher vs top-up filter.
 *   - `min_points` / `max_points` — points-cost range. A product matches if
 *                   any active variant is priced in range. Use `max_points`
 *                   for "under N points" / "what can I redeem with my
 *                   balance", `min_points` for "over N points".
 *
 * The `data` slice carries a compact `{id, name, category, starting_points}`
 * list (not just ids) so the agent can confirm matches, report costs, and
 * pick the right `product_id` for follow-ups; the rich tiles (images,
 * descriptions) stay in `display` and are stripped before the LLM sees them.
 */
export const searchRedemptionCatalog: MobileToolExecutor = (input, _context) =>
  safeExecute(async () => {
    const params = {
      query: optionalString(input, "query"),
      name: optionalString(input, "name"),
      categoryId: optionalString(input, "category_id"),
      categoryName: optionalString(input, "category"),
      isVoucher: optionalBool(input, "is_voucher"),
      minPoints: optionalNonNegativeNumber(input, "min_points"),
      maxPoints: optionalNonNegativeNumber(input, "max_points"),
      take: clampTake(optionalInt(input, "take")),
      cursor: optionalString(input, "cursor"),
    };
    return runApi(
      () => productApi.searchProducts(params),
      (raw) => {
        // Same mapper the card uses for its own paged fetches, so page 0
        // (here) and later pages render identically.
        const displayProducts = toCatalogDisplayProducts(raw);
        return {
          data: {
            product_count: displayProducts.length,
            // Lightweight name + category + cost list so the agent can talk
            // about what it found, confirm the points range, and
            // disambiguate before get_product_details.
            products: displayProducts.map((p) => ({
              id: p.id,
              name: p.name,
              category: p.category?.name ?? null,
              starting_points: p.starting_points,
            })),
          },
          display: { products: displayProducts },
        };
      },
    );
  });

/**
 * `get_product_details` — full product detail including variants and
 * prices. The agent uses this to surface variant choices (`50K`,
 * `100 Minutes`, …) so the user can pick one before redemption.
 *
 * Per spec §12, `sellPrice` on `TProductPrice` is the points cost.
 * We expose it as `sell_price` in the canonical shape so the agent
 * doesn't have to know about camelCase vs snake_case at all.
 */
export const getProductDetails: MobileToolExecutor = (input, _context) =>
  safeExecute(async () => {
    const productId = requireString(input, "product_id");
    return runApi(
      () => productApi.getProductById(productId),
      (raw) => ({
        id: raw.id,
        name: raw.name,
        description: raw.description,
        image_url: raw.imageUrl ?? null,
        code: raw.code,
        // `inputType` is the column the backend uses to flag products
        // that require dynamic form fields (phone number, account id,
        // …). When non-null, the agent must call
        // `get_product_input_fields` next.
        input_type: raw.inputType ?? null,
        category: raw.category
          ? { id: raw.category.id, name: raw.category.name }
          : null,
        variants: (raw.variants ?? []).map((v) => ({
          id: v.id,
          name: v.name,
          description: v.description,
          is_voucher: v.isVoucher,
          prices: (v.ProductPrice ?? []).map((p) => ({
            id: p.id,
            sell_price: p.sellPrice,
            // The backend doesn't carry an explicit currency field on
            // ProductPrice — sellPrice is always denominated in points.
            // Hard-code `"POINTS"` so the agent knows the unit; this
            // matches the spec table in §12.
            currency: "POINTS",
            is_active: p.isActive,
          })),
        })),
      }),
    );
  });

/**
 * `get_product_input_fields` — dynamic form fields the agent must
 * collect from the user before calling `execute_redemption`. The
 * backend names the field labels `alias`; we re-key to `label` so the
 * shape matches the spec.
 */
export const getProductInputFields: MobileToolExecutor = (input, _context) =>
  safeExecute(async () => {
    const productId = requireString(input, "product_id");
    return runApi(
      () => productApi.getProductInputFields(productId),
      (raw) => ({
        product_id: raw.productId,
        product_name: raw.productName,
        fields: (raw.forms ?? []).map((f: TProductInputField) => ({
          key: f.key,
          type: f.type,
          // Backend column is `alias` — spec calls this `label`. Same
          // string, friendlier name for the LLM.
          label: f.alias,
          ...(f.options ? { options: f.options } : {}),
        })),
      }),
    );
  });

/**
 * `get_points_price` — public conversion-rate endpoint. Used by the
 * agent before `deposit_points` to tell the user how many points they
 * will receive for their token amount.
 */
export const getPointsPrice: MobileToolExecutor = (input, _context) =>
  safeExecute(async () => {
    const tokenId = requireString(input, "token_id");
    const currency = requireString(input, "currency");
    return runApi(
      () => pointsApi.getPointPrice({ tokenId, currency }),
      (raw) => ({
        point_price: raw.pointPrice,
        currency: raw.currency,
        token: {
          id: raw.token.id,
          symbol: raw.token.symbol,
          decimals: raw.token.decimals,
          price_in_currency: raw.token.priceInCurrency,
        },
        points_per_token: raw.pointsPerToken,
        token_per_point: raw.tokenPerPoint,
        minimum_points: raw.minimumPoints,
        minimum_token_amount: raw.minimumTokenAmount,
        updated_at: raw.updatedAt,
      }),
    );
  });

// ---------------------------------------------------------------------------
// Read executors — auth required (JWT loaded from secure storage by `api`)
// ---------------------------------------------------------------------------

/**
 * `get_redemption_categories` — list of product categories. Note: this
 * endpoint requires auth on the backend (see §12 auth boundary table)
 * even though categories themselves aren't private — it's an API quirk.
 */
export const getRedemptionCategories: MobileToolExecutor = (_input, context) =>
  safeExecute(async () => {
    const unauth = await requireAuthed(context);
    if (unauth) return unauth;
    return runApi(
      () => productApi.getAllCategories(),
      (raw) => ({
        categories: raw.map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description ?? null,
          image_url: c.imageUrl ?? null,
        })),
      }),
    );
  });

/**
 * `get_points_balance` — current balance, decimal string. Auth required.
 */
export const getPointsBalance: MobileToolExecutor = (_input, context) =>
  safeExecute(async () => {
    const unauth = await requireAuthed(context);
    if (unauth) return unauth;
    return runApi(
      () => pointsApi.getBalance(),
      (raw) => ({ balance: raw.balance }),
    );
  });

/**
 * `get_points_history` — paginated transaction history. Auth required.
 * Backend returns the array under `data`; spec calls it `transactions`
 * — we re-key here so the agent sees the canonical shape from §12.
 */
export const getPointsHistory: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    const unauth = await requireAuthed(context);
    if (unauth) return unauth;
    const params = {
      type: optionalString(input, "type") as
        | "DEPOSIT"
        | "SPEND"
        | "REFUND"
        | "BONUS"
        | undefined,
      status: optionalString(input, "status") as
        | "PENDING"
        | "CONFIRMED"
        | "COMPLETED"
        | "FAILED"
        | undefined,
      cursor: optionalString(input, "cursor"),
      limit: optionalInt(input, "limit"),
    };
    return runApi(
      () => pointsApi.getHistory(params),
      (raw) => ({
        transactions: raw.data.map((t) => ({
          id: t.id,
          type: t.type,
          amount: t.amount,
          balance_before: t.balanceBefore,
          balance_after: t.balanceAfter,
          status: t.status,
          ...(t.tokenAmount !== undefined
            ? { token_amount: t.tokenAmount }
            : {}),
          ...(t.tokenSymbol !== undefined
            ? { token_symbol: t.tokenSymbol }
            : {}),
          ...(t.txHash !== undefined ? { tx_hash: t.txHash } : {}),
          created_at: t.createdAt,
        })),
        next_cursor: raw.nextCursor,
        has_more: raw.hasMore,
      }),
    );
  });

/**
 * `get_redemption_status` — single redemption lookup. Used to poll a
 * redemption that returned `PROCESSING`. Auth required.
 *
 * The agent MUST NOT call this in a loop within a single turn (§12 +
 * §14 Guard C). MAX_ITERATIONS applies on the server side, but we
 * don't enforce it here — that's the agent's job.
 */
export const getRedemptionStatus: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    const unauth = await requireAuthed(context);
    if (unauth) return unauth;
    const redemptionId = requireString(input, "redemption_id");
    return runApi(
      () => redeemApi.getStatus(redemptionId),
      (raw) => ({
        redemption_id: raw.id,
        status: raw.status,
        points_spent: raw.pointsSpent,
        vendor_ref_id: raw.vendorRefId,
        created_at: raw.createdAt,
      }),
    );
  });

/**
 * `get_redemption_history` — paginated history. Auth required.
 *
 * The backend returns `data: TRedemptionHistoryItem[]` with `nextCursor`
 * + `hasMore`. We re-shape into the spec's `redemptions[]` and project
 * the inline product / variant / price for the agent so it doesn't have
 * to make a follow-up `get_product_details` per row.
 */
export const getRedemptionHistory: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    const unauth = await requireAuthed(context);
    if (unauth) return unauth;
    const params = {
      status: optionalString(input, "status") as
        | "PENDING"
        | "PROCESSING"
        | "COMPLETED"
        | "FAILED"
        | "REFUNDED"
        | undefined,
      cursor: optionalString(input, "cursor"),
      limit: optionalInt(input, "limit"),
    };
    return runApi(
      () => redeemApi.getHistory(params),
      (raw) => ({
        redemptions: raw.data.map((r) => ({
          id: r.id,
          status: r.status,
          points_spent: r.pointsSpent,
          created_at: r.createdAt,
          product: {
            id: r.product.id,
            name: r.product.name,
            is_voucher: r.product.isVoucher,
            variant: {
              id: r.product.variant.id,
              name: r.product.variant.name,
            },
            price: {
              amount: r.product.price.amount,
              currency: r.product.price.currency,
            },
          },
        })),
        next_cursor: raw.nextCursor,
        has_more: raw.hasMore,
      }),
    );
  });

// ---------------------------------------------------------------------------
// Write executors — auth required + approval-sheet gated by dispatcher
// ---------------------------------------------------------------------------

/**
 * Polling helpers used by `deposit_points` and `execute_redemption`.
 * Both follow the same pattern: bounded retry, fixed interval, return
 * the latest state if we run out of budget. We keep them inline rather
 * than in a separate file because they're tied to the points API
 * specifically and don't generalise to other tools.
 */
const DEPOSIT_POLL_INTERVAL_MS = 3000;
const DEPOSIT_POLL_MAX_ATTEMPTS = 20; // up to ~60s before we give up
const REDEMPTION_POLL_INTERVAL_MS = 3000;
const REDEMPTION_POLL_MAX_ATTEMPTS = 4; // matches existing useRedeem logic

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Poll `pointsApi.getDepositStatus` until the deposit reaches a terminal
 * state or we run out of attempts. Returns the latest status either way
 * — the executor decides how to surface a still-pending deposit to the
 * agent.
 */
async function pollDepositStatus(depositId: string) {
  let last = await pointsApi.getDepositStatus(depositId);
  for (let attempt = 1; attempt < DEPOSIT_POLL_MAX_ATTEMPTS; attempt++) {
    if (last.status === "COMPLETED" || last.status === "FAILED") return last;
    await sleep(DEPOSIT_POLL_INTERVAL_MS);
    last = await pointsApi.getDepositStatus(depositId);
  }
  return last;
}

/**
 * Poll `redeemApi.getById` for a voucher code. Mirrors the existing
 * `useRedemptionById` retry logic in `hooks/queries/useRedeem.ts`:
 * 4 retries, 3s interval, only retry while the voucher is still
 * pending (Guard C in §14).
 */
async function pollRedemptionForVoucher(redemptionId: string) {
  let last = await redeemApi.getById(redemptionId);
  for (let attempt = 1; attempt < REDEMPTION_POLL_MAX_ATTEMPTS; attempt++) {
    // Stop if we already have a terminal state with everything we need.
    const hasVoucher =
      last.status === "COMPLETED" &&
      (!last.product.isVoucher || last.voucherCode !== null);
    const isFailed = last.status === "FAILED" || last.status === "REFUNDED";
    if (hasVoucher || isFailed) return last;
    await sleep(REDEMPTION_POLL_INTERVAL_MS);
    last = await redeemApi.getById(redemptionId);
  }
  return last;
}

/**
 * `deposit_points` — buy points by sending stablecoin tokens to the
 * TakumiPay deposit contract.
 *
 * Flow (per §12 + §14 Guard E):
 *
 *   1. Look up the token in the live blockchain registry by symbol.
 *   2. Re-fetch the live conversion rate (do NOT trust
 *      `input.expected_points` — that's a display hint only).
 *   3. Look up the deposit contract for this chain.
 *   4. Check ERC20 allowance and approve if needed.
 *   5. Call `depositPoints(token, refId, amount)` on the deposit contract.
 *   6. Submit the deposit registration to `pointsApi.submitDeposit`.
 *   7. Poll `pointsApi.getDepositStatus` until terminal state.
 *   8. Return the final `{ deposit_id, status, points_received, tx_hash }`.
 *
 * Error handling: any blockchain failure surfaces as a viem error which
 * `safeExecute` maps to `insufficient_funds` / `network_error` /
 * `unknown_error`. Any API failure goes through `classifyPointsError`.
 *
 * Approval: the dispatcher (§3) shows the approval sheet BEFORE this
 * runs. By the time we're called, the user has already seen the
 * `human_summary` and tapped Confirm. We don't request approval again.
 */
export const depositPoints: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    const unauth = await requireAuthed(context);
    if (unauth) return unauth;
    const chainId = resolveChainId(input, context);
    const tokenSymbol = requireString(input, "token_symbol");
    const tokenAmountHuman = requireString(input, "token_amount");
    // `expected_points` is a display hint only (Guard E). We log it on
    // the trace but the value we send to the backend is computed from
    // the live rate below.
    const _expectedPointsHint = optionalString(input, "expected_points");

    // 1. Look up the live blockchain row + token.
    const blockchain = context.blockchains.find(
      (b) => b.chainId === chainId && b.isEVM,
    );
    if (!blockchain) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        `chain_id ${chainId} is not supported by this wallet`,
      );
    }
    // blockchain.tokens only contains the native currency (eagerly
    // loaded from /blockchains). ERC20 tokens like stablecoins live in
    // the MMKV-cached token list — same cache the wallet's Send and
    // Deposit screens use via useTokens.
    let token = blockchain.tokens?.find(
      (t) => t.symbol.toLowerCase() === tokenSymbol.toLowerCase(),
    );
    if (!token || !token.contractAddress) {
      // Fall back to the full cached token list (same source
      // get_wallet_tokens uses) to find ERC20 stablecoins.
      try {
        const allTokens = await loadCachedTokens();
        token = allTokens.find(
          (t) =>
            t.blockchainId === blockchain.id &&
            t.isActive !== false &&
            t.symbol.toLowerCase() === tokenSymbol.toLowerCase() &&
            !!t.contractAddress,
        );
      } catch {
        // Cache unavailable — fall through to the error below.
      }
    }
    if (!token || !token.contractAddress) {
      return { status: "failed", error: "product_unavailable" };
    }
    if (!context.wallet.address) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "no connected wallet",
      );
    }

    // 2. Guard E — re-fetch the live rate. We deliberately do this
    // BEFORE prompting the on-chain transfer so a stale rate from the
    // agent doesn't cause us to send the wrong number of tokens.
    let priceInfo;
    try {
      priceInfo = await pointsApi.getPointPrice({
        tokenId: token.id,
        currency: "IDR",
      });
    } catch (err) {
      return { status: "failed", error: classifyPointsError(err) };
    }

    // Compute expected points from the live rate. The backend is the
    // ultimate authority on what's actually credited; this is just the
    // value we attach to `submitDeposit`.
    const tokenAmountFloat = parseFloat(tokenAmountHuman);
    if (!Number.isFinite(tokenAmountFloat) || tokenAmountFloat <= 0) {
      throw new ExecutorError(
        ExecutorErrorCode.InvalidInput,
        "invalid_token_amount",
      );
    }
    const pointsPerToken = parseFloat(priceInfo.pointsPerToken);
    if (!Number.isFinite(pointsPerToken) || pointsPerToken <= 0) {
      return { status: "failed", error: "service_unavailable" };
    }
    const computedExpectedPoints = Math.floor(
      tokenAmountFloat * pointsPerToken,
    ).toString();

    // 3. Look up the deposit contract for this chain. The mobile gets
    // this from a public REST endpoint — same source the deposit screen
    // uses (`useSmartContractByChain`).
    let smartContract;
    try {
      smartContract = await smartContractApi.getSmartContractsByChain(chainId);
    } catch (err) {
      return { status: "failed", error: classifyPointsError(err) };
    }
    if (!smartContract || !smartContract.address) {
      return { status: "failed", error: "service_unavailable" };
    }
    const contractAddress = smartContract.address as `0x${string}`;

    // 4. ERC20 allowance check + approval.
    const walletClient = requireWalletClient(chainId, context);
    const account = walletClient.account;
    if (!account) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "wallet client has no account",
      );
    }
    const { publicClient } = resolveChainClients(chainId, context);

    const tokenAddress = token.contractAddress as `0x${string}`;
    const amountWei = parseUnits(tokenAmountHuman, token.decimals);

    const currentAllowance = (await publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, contractAddress],
    })) as bigint;

    if (currentAllowance < amountWei) {
      const approveHash = await walletClient.writeContract({
        account,
        chain: walletClient.chain,
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "approve",
        args: [contractAddress, amountWei],
      });
      // Wait for the approval to be mined before calling deposit —
      // otherwise the deposit tx will revert with "insufficient
      // allowance".
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
    }

    // 5. Call depositPoints on the contract.
    const refId = `agent_${Date.now()}_${Math.random()
      .toString(36)
      .substring(2, 10)}`;

    const txHash = await walletClient.writeContract({
      account,
      chain: walletClient.chain,
      address: contractAddress,
      abi: AbiTakumiPay,
      functionName: "depositPoints",
      args: [tokenAddress, refId, amountWei],
    });

    // Wait for the on-chain confirmation before registering with the
    // backend — the API verifies the tx hash, so racing it produces a
    // 400 ("tx not found").
    try {
      await publicClient.waitForTransactionReceipt({ hash: txHash });
    } catch (err) {
      // CLAUDE.md user-facing-error rule: never put raw err text on the
      // `error` field — it ends up in LLM context on the next turn.
      // Curated code only; raw detail to dev log.
      if (__DEV__) {
        console.warn(
          "[deposit_points] waitForTransactionReceipt failed:",
          err instanceof Error ? err.message : err,
        );
      }
      return {
        status: "failed",
        tx_hash: txHash,
        error: "network_error",
      };
    }

    // 6. Register the deposit with the backend API.
    let depositResp;
    try {
      depositResp = await pointsApi.submitDeposit({
        refId,
        txHash,
        tokenId: token.id,
        blockchainId: blockchain.id,
        contractAddress,
        walletAddress: context.wallet.address,
        tokenAmount: amountWei.toString(),
        expectedPoints: computedExpectedPoints,
        currency: "IDR",
      });
    } catch (err) {
      // The on-chain tx already succeeded — return the hash so the
      // agent can tell the user "your funds moved but the deposit
      // didn't register, contact support with this hash".
      return {
        status: "failed",
        tx_hash: txHash,
        error: classifyPointsError(err),
      };
    }

    // 7. Poll until terminal state. Note that `submitDeposit` returns
    // a `TPointDepositResponse` (id + status + refId + message) while
    // `pollDepositStatus` returns a `TPointDepositStatusResponse`
    // (id + status + amount + refId + createdAt). Both share id +
    // status, which is all we need below.
    let finalStatus: {
      id: string;
      status: "PENDING" | "CONFIRMED" | "COMPLETED" | "FAILED";
      amount?: string;
    } = depositResp;
    try {
      finalStatus = await pollDepositStatus(depositResp.id);
    } catch (err) {
      // Polling failed but the deposit was accepted — return what we
      // have so the agent can tell the user the deposit is in flight.
      return {
        status: "success",
        tx_hash: txHash,
        data: sanitizeApiResponse({
          deposit_id: depositResp.id,
          status: depositResp.status,
          points_received: "0",
          tx_hash: txHash,
          poll_error: classifyPointsError(err),
        }),
      };
    }

    // 8. Final result.
    const isTerminal =
      finalStatus.status === "COMPLETED" || finalStatus.status === "FAILED";
    return {
      status:
        isTerminal && finalStatus.status === "FAILED" ? "failed" : "success",
      tx_hash: txHash,
      tx_confirmed: true,
      data: sanitizeApiResponse({
        deposit_id: finalStatus.id,
        status: finalStatus.status,
        points_received: finalStatus.amount ?? computedExpectedPoints,
        tx_hash: txHash,
      }),
      ...(isTerminal && finalStatus.status === "FAILED"
        ? { error: "deposit_failed" }
        : {}),
    };
  });

/**
 * Read `customer_info` off the tool input, tolerating BOTH canonical
 * shapes the backend accepts (see `api/src/redeem/dto/execute-redeem.dto.ts`):
 *
 *   - `Record<string, string>`               — object map
 *   - `Array<{ key: string; value: string }>` — UI-native shape
 *
 * Normalizes into a flat `Record<string, string>` for downstream key
 * validation + value cleaning. Returns `{}` if the field is absent —
 * some redemption products have no input fields at all.
 */
function readCustomerInfo(input: ToolInput): Record<string, string> {
  const raw = input.customer_info;
  if (raw === undefined || raw === null) return {};

  if (Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const entry of raw) {
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof (entry as { key?: unknown }).key !== "string" ||
        typeof (entry as { value?: unknown }).value !== "string"
      ) {
        throw new ExecutorError(
          ExecutorErrorCode.InvalidInput,
          "invalid_customer_info_entry",
        );
      }
      const { key, value } = entry as { key: string; value: string };
      out[key] = value;
    }
    return out;
  }

  if (typeof raw === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v !== "string") {
        throw new ExecutorError(
          ExecutorErrorCode.InvalidInput,
          `invalid_customer_info_value_for_${k}`,
        );
      }
      out[k] = v;
    }
    return out;
  }

  throw new ExecutorError(
    ExecutorErrorCode.InvalidInput,
    "invalid_customer_info",
  );
}

/**
 * Mirror the UI's `formatCustomerInfo` rule
 * (`components/purchase-item/ItemVariantWithInput.tsx:314-332`):
 * for PHONE / NUMBER / NUMERIC fields, strip every non-digit from the
 * value. Everything else passes through untouched. This is what the
 * vendor backend expects (e.g. `08123456789`, not `0812-3456-789`).
 */
function cleanFieldValue(rawValue: string, fieldType: string): string {
  const t = fieldType.toUpperCase();
  if (t === "PHONE" || t === "NUMBER" || t === "NUMERIC") {
    return rawValue.replace(/\D/g, "");
  }
  return rawValue;
}

/**
 * Given the agent-supplied `customer_info` (already flattened to an
 * object map) and the canonical `forms[]` from the backend, produce
 * the exact wire-format `Array<{key, value}>` the UI sends to
 * `/redeem/execute`.
 *
 * Rules, in order of precedence:
 *   1. Exact key match against `forms[*].key` — forwarded as-is (with
 *      value-cleaning per `cleanFieldValue`).
 *   2. Case-insensitive match against `forms[*].alias` (the display
 *      label) — remapped to the canonical key. Protects against the
 *      LLM using the human-readable label instead of the backend key.
 *   3. Case-insensitive match against `forms[*].key` — same.
 *
 * If a required form field is still missing after remapping, throws a
 * clear error listing the expected keys + labels. This turns "Bad
 * Request: Missing required fields: Input Nomor Hp" from the backend
 * (after a wasted round-trip) into a local, immediate, diagnosable
 * failure the agent can recover from by re-asking the user.
 */
function reconcileCustomerInfo(
  supplied: Record<string, string>,
  forms: TProductInputField[],
): Array<{ key: string; value: string }> {
  if (forms.length === 0) {
    // No required fields — forward whatever the agent passed verbatim
    // (as the array shape the UI uses).
    return Object.entries(supplied).map(([key, value]) => ({ key, value }));
  }

  const byExactKey = new Map<string, TProductInputField>();
  const byLowerKey = new Map<string, TProductInputField>();
  const byLowerAlias = new Map<string, TProductInputField>();
  for (const f of forms) {
    byExactKey.set(f.key, f);
    byLowerKey.set(f.key.toLowerCase(), f);
    if (f.alias) byLowerAlias.set(f.alias.toLowerCase(), f);
  }

  // Walk the supplied keys and map each to a canonical form field.
  const resolved = new Map<string, string>(); // canonicalKey -> cleaned value
  for (const [suppliedKey, suppliedValue] of Object.entries(supplied)) {
    const field =
      byExactKey.get(suppliedKey) ??
      byLowerKey.get(suppliedKey.toLowerCase()) ??
      byLowerAlias.get(suppliedKey.toLowerCase());
    if (!field) {
      // Unknown key — fail early with the expected set so the agent
      // can correct itself.
      const expected = forms
        .map((f) => `${f.key} (${f.alias || f.type})`)
        .join(", ");
      throw new ExecutorError(
        ExecutorErrorCode.InvalidInput,
        `unknown_customer_info_key:${suppliedKey}. expected one of: ${expected}`,
      );
    }
    resolved.set(field.key, cleanFieldValue(suppliedValue, field.type));
  }

  // Verify every required form field is covered. The backend's
  // validator treats all `forms[]` entries as required — same rule
  // (`product-input-validator.service.ts:71-74`).
  const missing = forms.filter((f) => !resolved.has(f.key));
  if (missing.length > 0) {
    const missingDesc = missing
      .map((f) => `${f.key} (${f.alias || f.type})`)
      .join(", ");
    throw new ExecutorError(
      ExecutorErrorCode.InvalidInput,
      `missing_customer_info_fields: ${missingDesc}`,
    );
  }

  // Emit in the canonical `forms[]` order so the wire shape is
  // deterministic and matches what the UI sends.
  return forms.map((f) => ({
    key: f.key,
    value: resolved.get(f.key) as string,
  }));
}

/**
 * `execute_redemption` — irreversibly spends points to redeem a product.
 *
 * Flow (per §12 + §14 Guards B & C), mirroring the UI's payment screen
 * (`app/payment.tsx` + `components/purchase-item/ItemVariantWithInput.tsx`):
 *
 *   1. If `product_id` is provided, fetch `getProductInputFields` and
 *      reconcile `customer_info` keys against `forms[]` — remap aliases
 *      to canonical keys, strip non-digits from PHONE/NUMBER/NUMERIC
 *      fields, fail early on missing or unknown keys. This is exactly
 *      what `formatCustomerInfo` does in the UI.
 *   2. Call `redeemApi.execute` with the array-shape `customerInfo`.
 *   3. Poll `redeemApi.getById` up to 4 times (3s interval) to wait
 *      for voucher delivery, mirroring the `useRedemptionById` hook.
 *   4. Return the final state. If still PROCESSING after retries,
 *      return as-is — the agent tells the user to check history later.
 *
 * Guard B note: the agent system prompt (§7) requires `get_points_balance`
 * to be called before this. We don't re-check here — the executor's job
 * is to execute, not to second-guess the agent's planning.
 *
 * Approval: same as deposit — the dispatcher gates on the approval sheet
 * before we run.
 */
export const executeRedemption: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    const unauth = await requireAuthed(context);
    if (unauth) return unauth;
    const productVariantId = requireString(input, "product_variant_id");
    const productPriceId = requireString(input, "product_price_id");
    const productId = optionalString(input, "product_id");
    const rawCustomerInfo = readCustomerInfo(input);
    // `product_name` and `points_cost` are display-only fields the
    // agent passes for the approval sheet's `human_summary`. We don't
    // need them past that point — the dispatcher already showed the
    // sheet — but we read them so the type-check covers the spec.
    optionalString(input, "product_name");
    optionalString(input, "points_cost");

    // 1. If we have the product_id, reconcile against the canonical
    //    forms[] from the backend. This is the step the UI does
    //    implicitly via `useProductInputFields` + react-hook-form.
    //    Without it, the agent's guess at field keys will 400 at the
    //    backend with a generic "Missing required fields" message.
    let customerInfo:
      | Record<string, string>
      | Array<{ key: string; value: string }> = rawCustomerInfo;

    if (productId) {
      try {
        const fields = await productApi.getProductInputFields(productId);
        customerInfo = reconcileCustomerInfo(
          rawCustomerInfo,
          fields?.forms ?? [],
        );
      } catch (err) {
        // Reconciliation errors (unknown key / missing field) are
        // `ExecutorError(InvalidInput)` — re-throw so the agent sees
        // the clear local message instead of a backend round-trip.
        if (err instanceof ExecutorError) throw err;
        // API errors fetching the forms — fall through and let the
        // backend do its own validation. Not fatal.
      }
    }

    // 2. Execute the redemption.
    let redemption;
    try {
      redemption = await redeemApi.execute({
        productVariantId,
        productPriceId,
        customerInfo,
      });
    } catch (err) {
      return { status: "failed", error: classifyPointsError(err) };
    }

    // 2. Poll for voucher delivery. We always start with at least one
    // detail fetch because the `execute` response only includes
    // `id`/`status`/`pointsSpent` — never the voucher code.
    let detail;
    try {
      detail = await pollRedemptionForVoucher(redemption.id);
    } catch (err) {
      // The redemption itself succeeded — points have been deducted —
      // we just couldn't fetch the detail. Return the minimal state so
      // the agent can tell the user it's in flight.
      return {
        status: "success",
        data: sanitizeApiResponse({
          redemption_id: redemption.id,
          status: "PROCESSING",
          points_spent: redemption.pointsSpent,
          voucher_code: null,
          vendor_ref_id: null,
          poll_error: classifyPointsError(err),
        }),
      };
    }

    // 3. Final shape. Guard C: if still PROCESSING after retries, return
    // it as-is so the agent can advise the user to check later.
    return {
      status: "success",
      data: sanitizeApiResponse({
        redemption_id: detail.id,
        status: detail.status,
        points_spent: detail.pointsSpent,
        voucher_code: detail.voucherCode ?? null,
        vendor_ref_id: detail.vendorRefId ?? null,
      }),
    };
  });

// ---------------------------------------------------------------------------
// Registry export
// ---------------------------------------------------------------------------

/**
 * The 12 points/redemption executors that this file owns. Merged into
 * the top-level `EXECUTORS` map by `index.ts`. The 13th points tool —
 * `request_authentication` — is registered separately by task 17 in
 * `simulate.ts`.
 */
export const POINTS_EXECUTORS: Record<string, MobileToolExecutor> = {
  // public reads
  get_redemption_catalog: getRedemptionCatalog,
  search_redemption_catalog: searchRedemptionCatalog,
  get_product_details: getProductDetails,
  get_product_input_fields: getProductInputFields,
  get_points_price: getPointsPrice,
  // auth-required reads
  get_redemption_categories: getRedemptionCategories,
  get_points_balance: getPointsBalance,
  get_points_history: getPointsHistory,
  get_redemption_status: getRedemptionStatus,
  get_redemption_history: getRedemptionHistory,
  // writes
  deposit_points: depositPoints,
  execute_redemption: executeRedemption,
};
