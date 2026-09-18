/**
 * The "paying" state of the merchant flow, rendered OUTSIDE the quote card
 * so it can be the thing the user looks at.
 *
 * Shape: the merchant's store icon at the top with soft pulse rings
 * radiating from it (the payment is "reaching" them), then a vertical
 * timeline of the three real stages — the same order-tracking pattern
 * ride-hailing and delivery apps use, which every Indonesian user already
 * reads fluently. Stages are advanced by the caller only when they truly
 * complete (wallet signed/broadcast → mined → server verified); nothing
 * here runs on a timer except the reassurance copy.
 *
 * The rows tell the user's story, not ours. Internally there are three
 * stages (prepare = signing/broadcast, send = hash handed to the server,
 * verify = server waits for the chain and checks the record) and then the
 * outcome; to the user that is:
 *
 *   1. Preparing your payment        ← prepare
 *   2. Confirming your payment       ← send + verify (the user may leave
 *                                       once the server has the hash)
 *   3. Paid to {merchant}            ← done (outcome, never "in progress")
 *
 * "Sending to the merchant" and THEN "confirming your payment" read
 * backwards to a normal person — once it's sent, what's left to confirm?
 * So the merchant only appears on the last row, as the result.
 */

import { Check, ChevronDown, Store } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Image, Text, TouchableOpacity, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
  ZoomIn,
} from "react-native-reanimated";

export type PayStep = "prepare" | "send" | "verify" | "done";

const ROWS: readonly {
  key: "prepare" | "confirm" | "paid";
  title: (merchant: string) => string;
  detail: string;
}[] = [
  {
    key: "prepare",
    title: () => "Preparing your payment",
    detail: "Getting it ready from your wallet",
  },
  {
    key: "confirm",
    title: () => "Confirming your payment",
    detail: "Waiting for the network to confirm it",
  },
  {
    key: "paid",
    title: (m) => `Paid to ${m}`,
    detail: "",
  },
];

/** Which row is in progress for a stage; `ROWS.length` = everything done. */
function activeRowFor(step: PayStep): number {
  switch (step) {
    case "prepare":
      return 0;
    case "send":
    case "verify":
      return 1;
    case "done":
      return ROWS.length;
  }
}

/** After this long on one stage, say so; the money is safe either way. */
const SLOW_STEP_MS = 8_000;

const BRAND = "#c71c4b";
const BRAND_SOFT = "rgba(199, 28, 75, 0.12)";
// emerald-700 / emerald-50: the app's "done / connected" cue, same as the
// dApp browser's wallet-connection trigger.
const GREEN = "#047857";
const GREY_LINE = "rgba(32, 34, 44, 0.12)";

const NODE = 28;
const ROW_GAP = 22;

export function PaymentProgressHero({
  step,
  startedAt,
  merchantName,
  onLeave,
}: {
  step: PayStep;
  startedAt: number;
  merchantName: string;
  /** Offered once the hash is with the server: nothing else needs this screen. */
  onLeave?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (step === "done") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [step]);

  const done = step === "done";
  const activeIndex = activeRowFor(step);
  const slow = !done && step !== "prepare" && now - startedAt > SLOW_STEP_MS;

  let note: string;
  if (done) {
    note = "Paid. Opening your receipt…";
  } else if (step === "verify") {
    note = slow
      ? "Still confirming. Your money is safe and you won't be charged twice. You can leave, we'll let you know when it's done."
      : "You can leave this screen. We'll let you know as soon as it's confirmed, and you can check it anytime in Activity.";
  } else if (slow) {
    note =
      "Taking a little longer than usual. Your money is safe and you won't be charged twice. Please keep this screen open.";
  } else {
    note = "Please keep this screen open. This usually takes a few seconds.";
  }

  return (
    <View className="px-6 pt-8 pb-6">
      <View className="items-center mb-8">
        <MerchantPulse done={done} />
        {done ? (
          <Animated.Text
            entering={FadeIn.duration(250)}
            className="text-emerald-700 font-bold text-2xl mt-4"
          >
            Paid
          </Animated.Text>
        ) : null}
      </View>

      <View>
        {ROWS.map((s, i) => {
          const state =
            i < activeIndex ? "done" : i === activeIndex ? "active" : "pending";
          return (
            <StepRow
              key={s.key}
              title={s.title(merchantName)}
              detail={s.detail}
              state={state}
              isLast={i === ROWS.length - 1}
              connectorFilled={i < activeIndex}
            />
          );
        })}
      </View>

      <Animated.Text
        key={note}
        entering={FadeIn.duration(250)}
        className="text-light-matte-black/60 text-sm leading-5 mt-6"
      >
        {note}
      </Animated.Text>

      {step === "verify" && onLeave ? (
        <TouchableOpacity
          activeOpacity={0.7}
          className="mt-6 py-3 rounded-xl items-center border border-light-matte-black/15"
          onPress={onLeave}
        >
          <Text className="text-light-matte-black font-semibold text-sm">
            Done
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

/**
 * The merchant's store icon with two soft rings expanding out of it while
 * the payment is in flight — "reaching the merchant". When it lands, the
 * TakumiPay mark takes its place with an emerald check badge on the
 * corner (the avatar-plus-status shape): paid, by us. 64px: a focal
 * point, not a spinner.
 */
function MerchantPulse({ done }: { done: boolean }) {
  const size = 64;
  if (done) {
    const badge = 26;
    return (
      <Animated.View
        entering={ZoomIn.springify().damping(12).stiffness(160)}
        style={{ width: size, height: size }}
      >
        <View
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: BRAND_SOFT,
          }}
          className="items-center justify-center"
        >
          <Image
            source={require("@/assets/images/takumipay-no-bg.png")}
            style={{ width: 34, height: 34 }}
            resizeMode="contain"
            accessibilityIgnoresInvertColors
          />
        </View>
        <Animated.View
          entering={ZoomIn.delay(180).springify().damping(10).stiffness(200)}
          style={{
            position: "absolute",
            right: -4,
            bottom: -4,
            width: badge,
            height: badge,
            borderRadius: badge / 2,
            backgroundColor: GREEN,
            borderWidth: 3,
            borderColor: "#ffffff",
          }}
          className="items-center justify-center"
        >
          <Check color="#ffffff" size={14} strokeWidth={3.5} />
        </Animated.View>
      </Animated.View>
    );
  }
  return (
    <View
      style={{ width: size * 2, height: size * 2 }}
      className="items-center justify-center"
    >
      <PulseRing size={size} delayMs={0} />
      <PulseRing size={size} delayMs={900} />
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: BRAND_SOFT,
        }}
        className="items-center justify-center"
      >
        <Store color={BRAND} size={30} />
      </View>
    </View>
  );
}

function PulseRing({ size, delayMs }: { size: number; delayMs: number }) {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withDelay(
      delayMs,
      withRepeat(
        withTiming(1, { duration: 1800, easing: Easing.out(Easing.quad) }),
        -1,
        false,
      ),
    );
  }, [progress, delayMs]);
  const style = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + progress.value * 0.9 }],
    opacity: 0.45 * (1 - progress.value),
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: BRAND,
        },
        style,
      ]}
    />
  );
}

/**
 * One timeline row: a node on the left (check when done, pulsing dot when
 * active, hollow when pending), a connector down to the next row that
 * fills as the step completes, and the stage in large type.
 */
function StepRow({
  title,
  detail,
  state,
  isLast,
  connectorFilled,
}: {
  title: string;
  detail: string;
  state: "done" | "active" | "pending";
  isLast: boolean;
  connectorFilled: boolean;
}) {
  return (
    <View className="flex-row" style={{ minHeight: NODE + ROW_GAP }}>
      <View className="items-center" style={{ width: NODE }}>
        <StepNode state={state} />
        {isLast ? null : (
          <Connector filled={connectorFilled} active={state === "active"} />
        )}
      </View>
      <View
        className="flex-1 ml-4"
        style={{ paddingBottom: isLast ? 0 : ROW_GAP }}
      >
        <Text
          className={`text-lg ${
            state === "active"
              ? "text-light-matte-black font-bold"
              : state === "done"
                ? "text-light-matte-black/70 font-semibold"
                : "text-light-matte-black/35 font-semibold"
          }`}
          style={{ lineHeight: NODE }}
          numberOfLines={2}
        >
          {title}
        </Text>
        {state === "active" && detail ? (
          <Animated.Text
            entering={FadeIn.duration(250)}
            className="text-light-matte-black/55 text-sm mt-0.5"
          >
            {detail}
          </Animated.Text>
        ) : null}
      </View>
    </View>
  );
}

function StepNode({ state }: { state: "done" | "active" | "pending" }) {
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (state !== "active") return;
    pulse.value = withRepeat(
      withTiming(1, { duration: 700, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [state, pulse]);
  const dot = useAnimatedStyle(() => ({
    transform: [{ scale: 0.7 + pulse.value * 0.3 }],
    opacity: 0.7 + pulse.value * 0.3,
  }));

  if (state === "done") {
    return (
      <Animated.View
        entering={ZoomIn.springify().damping(12).stiffness(180)}
        style={{
          width: NODE,
          height: NODE,
          borderRadius: NODE / 2,
          backgroundColor: GREEN,
        }}
        className="items-center justify-center"
      >
        <Check color="#fff" size={16} strokeWidth={3} />
      </Animated.View>
    );
  }
  if (state === "active") {
    return (
      <View
        style={{
          width: NODE,
          height: NODE,
          borderRadius: NODE / 2,
          borderWidth: 2.5,
          borderColor: BRAND,
        }}
        className="items-center justify-center"
      >
        <Animated.View
          style={[
            { width: 12, height: 12, borderRadius: 6, backgroundColor: BRAND },
            dot,
          ]}
        />
      </View>
    );
  }
  return (
    <View
      style={{
        width: NODE,
        height: NODE,
        borderRadius: NODE / 2,
        borderWidth: 2.5,
        borderColor: GREY_LINE,
      }}
    />
  );
}

/**
 * Vertical line under a node. Fills green from the top once that step is
 * done; while the step above is in progress, small chevrons flow down it
 * toward the next row so the motion itself says "this is where we're
 * headed".
 */
function Connector({ filled, active }: { filled: boolean; active: boolean }) {
  const fill = useSharedValue(filled ? 1 : 0);
  useEffect(() => {
    fill.value = withTiming(filled ? 1 : 0, {
      duration: 450,
      easing: Easing.out(Easing.cubic),
    });
  }, [filled, fill]);
  const fillStyle = useAnimatedStyle(() => ({
    height: `${fill.value * 100}%`,
  }));
  return (
    <View
      className="flex-1 items-center"
      style={{ width: NODE, marginVertical: 4 }}
    >
      <View
        className="flex-1 overflow-hidden"
        style={{
          width: 3,
          borderRadius: 2,
          backgroundColor: active ? BRAND_SOFT : GREY_LINE,
        }}
      >
        <Animated.View
          style={[
            { width: "100%", borderRadius: 2, backgroundColor: GREEN },
            fillStyle,
          ]}
        />
      </View>
      {active ? (
        <>
          <FlowingArrow delayMs={0} />
          <FlowingArrow delayMs={650} />
        </>
      ) : null}
    </View>
  );
}

/**
 * One chevron travelling top → bottom along the connector and fading out
 * as it arrives, on a loop. Two of them, staggered, read as a flow.
 */
function FlowingArrow({ delayMs }: { delayMs: number }) {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withDelay(
      delayMs,
      withRepeat(
        withTiming(1, { duration: 1300, easing: Easing.inOut(Easing.quad) }),
        -1,
        false,
      ),
    );
  }, [progress, delayMs]);
  const style = useAnimatedStyle(() => {
    const p = progress.value;
    // Ease in at the top, ease out at the bottom.
    const opacity = p < 0.2 ? p / 0.2 : p > 0.75 ? (1 - p) / 0.25 : 1;
    return { top: `${p * 100}%`, opacity };
  });
  return (
    <Animated.View
      pointerEvents="none"
      style={[{ position: "absolute", marginTop: -8 }, style]}
    >
      <ChevronDown color={BRAND} size={16} strokeWidth={3} />
    </Animated.View>
  );
}
