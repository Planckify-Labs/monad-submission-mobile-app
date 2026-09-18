/**
 * `components/PaymentError.tsx` — single presentational surface for every
 * payer-facing error on the scan → sign → submit → settle path.
 *
 * Spec: `docs/umkm-usdc-payout-spec.md` §9.1 (Error-States Matrix).
 *
 * What it does:
 *   - Switches on `code: PaymentErrorCode` and renders the copy row
 *     from `services/errors/paymentErrors.ts` (`title`, `body`, `cta`).
 *   - Resolves the `cta.action` semantic verb to one of the caller's
 *     handler props (`onRetry` / `onBack` / `onRescan` / `onTopUp`).
 *   - Fires a fire-and-forget `logPaymentError` on mount so every
 *     rendered error lands in telemetry (§9.1 `payment_error_shown`).
 *
 * Rules:
 *   - Three-role separation — this component is pure layout + a single
 *     best-effort telemetry call. It never fetches, mutates, signs, or
 *     reads wallet state.
 *   - Copy-audience rule — no user-facing string is inlined here. All
 *     copy lives in `paymentErrorCopy`.
 *   - No sensitive logging — `devMessage` (if any) is surfaced in
 *     `__DEV__` only and is the caller's responsibility to sanitize.
 */

import { AlertCircle, XCircle } from "lucide-react-native";
import { useEffect } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import {
  type PaymentErrorCode,
  type PaymentErrorContext,
  type PaymentErrorCtaAction,
  resolvePaymentErrorCopy,
} from "@/services/errors/paymentErrors";
import { logPaymentError } from "@/services/errors/telemetry";

export interface PaymentErrorProps {
  code: PaymentErrorCode;
  /** Optional dev-only context string. Rendered in `__DEV__` only; never sent to telemetry. */
  devMessage?: string;
  /** Opaque server intent id, forwarded to telemetry for funnel analysis. */
  intentId?: string;
  /** Opaque server merchant id, forwarded to telemetry. */
  merchantId?: string;
  /**
   * What this payment was in (token, fee coin, network) so the balance
   * codes can name it instead of assuming a currency.
   */
  context?: PaymentErrorContext;
  onRetry?: () => void;
  onBack?: () => void;
  onRescan?: () => void;
  onTopUp?: () => void;
}

const CTA_ICONS: Partial<Record<PaymentErrorCode, typeof AlertCircle>> = {
  quote_expired: AlertCircle,
  deposit_required: AlertCircle,
  rate_limited: AlertCircle,
};

export function PaymentError({
  code,
  devMessage,
  intentId,
  merchantId,
  context,
  onRetry,
  onBack,
  onRescan,
  onTopUp,
}: PaymentErrorProps) {
  useEffect(() => {
    logPaymentError({ code, intentId, merchantId });
  }, [code, intentId, merchantId]);

  const copy = resolvePaymentErrorCopy(code, context);
  const Icon = CTA_ICONS[code] ?? XCircle;

  const handler = resolveHandler(copy.cta?.action, {
    onRetry,
    onBack,
    onRescan,
    onTopUp,
  });

  return (
    <View className="bg-light rounded-3xl p-6 shadow-md-">
      <View className="items-center mb-4">
        <View className="w-14 h-14 bg-light-primary-red/10 rounded-full items-center justify-center mb-2">
          <Icon color="#c71c4b" size={32} />
        </View>
        <Text className="text-light-matte-black font-bold text-xl">
          {copy.title}
        </Text>
        <Text className="text-light-matte-black/60 text-sm text-center mt-1">
          {copy.body}
        </Text>
      </View>

      {__DEV__ && devMessage ? (
        <View className="bg-light-main-container rounded-xl p-3 mt-2">
          <Text className="text-light-matte-black/50 text-xs mb-1">Dev</Text>
          <Text className="text-light-matte-black font-mono text-xs" selectable>
            {devMessage}
          </Text>
        </View>
      ) : null}

      {copy.cta && handler ? (
        <TouchableOpacity
          activeOpacity={0.7}
          className="bg-light-primary-red py-4 px-5 rounded-xl items-center mt-6"
          onPress={handler}
        >
          <Text className="text-light font-semibold">{copy.cta.label}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

/**
 * Resolves the copy row's semantic `cta.action` to the caller-provided
 * handler. If the caller didn't wire a handler for that action, the CTA
 * button is hidden — the presentation stays correct even when the
 * embedding screen only cares about a subset of recovery flows.
 */
function resolveHandler(
  action: PaymentErrorCtaAction | undefined,
  handlers: {
    onRetry?: () => void;
    onBack?: () => void;
    onRescan?: () => void;
    onTopUp?: () => void;
  },
): (() => void) | undefined {
  switch (action) {
    case "retry":
      return handlers.onRetry;
    case "back":
      return handlers.onBack;
    case "rescan":
      return handlers.onRescan;
    case "topup":
      return handlers.onTopUp;
    default:
      return undefined;
  }
}
