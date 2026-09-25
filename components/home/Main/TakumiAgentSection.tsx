import { type AudioRecorder, useAudioRecorderState } from "expo-audio";
import {
  ArrowRight,
  ArrowUp,
  Clock,
  Coins,
  Gift,
  HelpCircle,
  LineChart,
  type LucideIcon,
  Mic,
  PieChart,
  Repeat,
  Send,
  Sparkles,
  TrendingUp,
  Wallet,
} from "lucide-react-native";
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { HalftoneVoiceWave } from "@/components/common/HalftoneVoiceWave";
import { FEATURE_PASSKEY_ONLY_ONBOARDING } from "@/constants/configs/featureFlags";
import { useAgentPrefill } from "@/hooks/useAgentPrefill";
import { useVoiceTranscription } from "@/hooks/useVoiceTranscription";
import ActivitySection, { type ActivitySectionRef } from "./ActivitySection";

export interface TakumiAgentSectionRef {
  refetch: () => void;
}

export interface TakumiAgentSectionProps {
  /** Fired when the user taps the "Ask Takumi anything…" bar. */
  onAsk?: () => void;
  /**
   * Opens the Takumi Agent chat page. Called after a voice transcript is
   * ready (the transcript is handed off separately via `useAgentPrefill`),
   * when a capability / spotlight / quick-prompt card hands off a prompt,
   * and when the user taps the ask bar to type. `trigger` identifies which
   * of those entry points fired, for analytics breakdown.
   */
  onOpenAgentChat?: (trigger: string) => void;
  /**
   * Asks the parent scroll container to bring this section into focus.
   * Fired on mic press-in so the wave bar has room to breathe.
   */
  onVoiceFocus?: () => void;
}

// expo-audio reports metering in dB. Silence sits near the noise floor
// (~ -50/-60 dB); conversational speech peaks around -25..-5 dB. Once a
// tick crosses this threshold we treat the user as "speaking" and reveal
// the waveform for the rest of the recording (latched, so brief pauses
// between words don't flicker the hint back in).
const SPEAKING_DB = -40;

/**
 * Recording-state content for the ask bar. Mirrors agent mode's
 * `ChatInput` recording UX: shows a "hold to speak" hint until the user
 * actually starts talking, then swaps in the shared `HalftoneVoiceWave`
 * (halftone dots, falling back to bars without Skia).
 */
function VoiceRecordingBar({ recorder }: { recorder: AudioRecorder }) {
  const state = useAudioRecorderState(recorder, 100);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (
      !started &&
      state.metering !== undefined &&
      state.metering > SPEAKING_DB
    ) {
      setStarted(true);
    }
  }, [state.metering, started]);

  return (
    <View className="flex-1 justify-center" style={{ height: 22 }}>
      {started ? (
        <HalftoneVoiceWave recorder={recorder} />
      ) : (
        <Text
          className="text-light-matte-black/40 text-[13px]"
          numberOfLines={1}
        >
          Hold the mic button to speak
        </Text>
      )}
    </View>
  );
}

type CardVariant = "red" | "dark" | "light";

interface Capability {
  id: string;
  label: string;
  sample: string;
  prompt: string;
  icon: LucideIcon;
  variant: CardVariant;
}

/**
 * The Monad Metropolis build (same switch as the passkey-only login; see
 * `docs/monad-metropolis-2026-spec.md` §5) talks AUSD on Monad and only
 * offers what the agent can actually do there: `send_token` AUSD, balances,
 * points. No swap venue and no AUSD yield exist on Monad in this build, so
 * those cards would be promises the agent can't keep — and none of the
 * copy may mention USDC/USDT/Sui.
 */
const HACKATHON_BUILD = FEATURE_PASSKEY_ONLY_ONBOARDING;

const HACKATHON_CAPABILITIES: Capability[] = [
  {
    id: "pay",
    label: "Pay & Send",
    sample: "Send 50 AUSD",
    prompt: "Send 50 AUSD to my mom",
    icon: Send,
    variant: "red",
  },
  {
    id: "balance",
    label: "Balance",
    sample: "how much AUSD?",
    prompt: "How much AUSD do I have?",
    icon: Wallet,
    variant: "dark",
  },
  {
    id: "redeem",
    label: "Redeem",
    sample: "use my points",
    prompt: "What can I redeem with my points?",
    icon: Gift,
    variant: "light",
  },
];

const DEFAULT_CAPABILITIES: Capability[] = [
  {
    id: "pay",
    label: "Pay & Send",
    sample: "Send 50 USDT",
    prompt: "Send 50 USDT to a friend",
    icon: Send,
    variant: "red",
  },
  {
    id: "swap",
    label: "Swap",
    sample: "SUI → USDC",
    prompt: "Swap 4 SUI for USDC",
    icon: Repeat,
    variant: "dark",
  },
  {
    id: "earn",
    label: "Earn yield",
    sample: "earn on USDC",
    prompt: "Earn yield on my idle USDC/USDT",
    icon: TrendingUp,
    variant: "light",
  },
  {
    id: "redeem",
    label: "Redeem",
    sample: "use my points",
    prompt: "What can I redeem with my points?",
    icon: Gift,
    variant: "light",
  },
];

const CAPABILITIES: Capability[] = HACKATHON_BUILD
  ? HACKATHON_CAPABILITIES
  : DEFAULT_CAPABILITIES;

// Quick chips complement the capability rail rather than duplicate it: the
// cards launch transactional intents (Pay / Swap / Earn / Redeem) while
// these are one-tap *informational* asks the cards don't cover.
const QUICK_PROMPTS: {
  id: string;
  label: string;
  prompt: string;
  icon: LucideIcon;
}[] = [
  {
    id: "points",
    label: "Points",
    prompt: "How to use my points?",
    icon: Coins,
  },
  {
    id: "prices",
    label: "Prices",
    prompt: "What are current token prices?",
    icon: LineChart,
  },
  {
    id: "portfolio",
    label: "Portfolio",
    prompt: "What do I own?",
    icon: PieChart,
  },
  {
    id: "help",
    label: "Help",
    prompt: "What can you help me with?",
    icon: HelpCircle,
  },
];

// Prompt fired by the spotlight "Show me" CTA — matches the card's pitch.
// Hackathon build: the spec §5 demo script ("send $50 to my mom") in AUSD.
// Default: the auto-earn-yield pitch ("Grow your idle USDC, hands-free").
const SPOTLIGHT_PROMPT = HACKATHON_BUILD
  ? "Send 50 AUSD to my mom"
  : "Earn yield on my idle USDC";

const SPOTLIGHT = HACKATHON_BUILD
  ? {
      badge: "Settles in seconds",
      headline: "Send AUSD home,\nin one sentence",
      tagline: "Say who and how much. I handle the rest.",
      Icon: Send,
    }
  : {
      badge: "~0.1 - 7% APY",
      headline: "Grow your idle\nUSDC, hands-free",
      tagline: "Auto-earn yield · I cover the gas.",
      Icon: TrendingUp,
    };

const RAIL_GAP = 12;
const CARD_HEIGHT = 176;

const VARIANT_STYLES: Record<
  CardVariant,
  {
    card: string;
    iconWrap: string;
    iconColor: string;
    title: string;
    sample: string;
  }
> = {
  red: {
    card: "bg-light-primary-red",
    iconWrap: "bg-white/20",
    iconColor: "#ffffff",
    title: "text-white",
    sample: "text-white/70",
  },
  dark: {
    card: "bg-light-matte-black",
    iconWrap: "bg-white/15",
    iconColor: "#ffffff",
    title: "text-white",
    sample: "text-white/60",
  },
  light: {
    card: "bg-light-primary-red/10 border border-light-primary-red/20",
    iconWrap: "bg-light",
    iconColor: "#c71c4b",
    title: "text-light-matte-black",
    sample: "text-light-matte-black/45",
  },
};

function SpotlightCard({
  width,
  onPress,
}: {
  width: number;
  onPress?: () => void;
}) {
  return (
    <View
      style={{ width, height: CARD_HEIGHT }}
      className="rounded-2xl bg-light-primary-red p-4 overflow-hidden justify-between"
    >
      {/* decorative layers */}
      <View
        pointerEvents="none"
        className="absolute -right-8 -bottom-8 w-36 h-36 rounded-full bg-white/5"
      />
      <View
        pointerEvents="none"
        className="absolute right-3 bottom-1 opacity-100"
      >
        <SPOTLIGHT.Icon size={84} color="rgba(255,255,255,0.12)" />
      </View>

      {/* top row */}
      <View className="flex-row items-center justify-between">
        <Text className="text-white/70 text-[10px] font-extrabold tracking-widest">
          ✦ TAKUMI PICK
        </Text>
        <View className="flex-row items-center gap-1 bg-white/20 rounded-full px-2.5 py-1">
          {HACKATHON_BUILD ? null : (
            <ArrowUp size={11} color="#ffffff" strokeWidth={3} />
          )}
          <Text className="text-white text-[10px] font-bold">
            {SPOTLIGHT.badge}
          </Text>
        </View>
      </View>

      {/* headline */}
      <View>
        <Text className="text-white font-extrabold text-[18px] leading-[22px]">
          {SPOTLIGHT.headline}
        </Text>
        <Text className="text-white/75 text-[11px] mt-1">
          {SPOTLIGHT.tagline}
        </Text>
      </View>

      {/* cta */}
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={onPress}
        className="self-start flex-row items-center gap-1 bg-light rounded-full px-4 py-2"
      >
        <Text className="text-light-primary-red font-extrabold text-[12px]">
          Show me
        </Text>
        <ArrowRight size={14} color="#c71c4b" strokeWidth={2.5} />
      </TouchableOpacity>
    </View>
  );
}

function CapabilityCard({
  item,
  width,
  onPress,
}: {
  item: Capability;
  width: number;
  onPress?: () => void;
}) {
  const styles = VARIANT_STYLES[item.variant];
  const Icon = item.icon;
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      style={{ width, height: CARD_HEIGHT }}
      className={`rounded-2xl p-3.5 justify-between ${styles.card}`}
    >
      <View
        className={`w-9 h-9 rounded-full items-center justify-center ${styles.iconWrap}`}
      >
        <Icon size={18} color={styles.iconColor} strokeWidth={2.2} />
      </View>
      <View>
        <Text className={`font-extrabold text-[13px] ${styles.title}`}>
          {item.label}
        </Text>
        <Text className={`text-[10px] mt-0.5 ${styles.sample}`}>
          “{item.sample}”
        </Text>
      </View>
    </TouchableOpacity>
  );
}

const TakumiAgentSection = forwardRef<
  TakumiAgentSectionRef,
  TakumiAgentSectionProps
>(({ onAsk, onOpenAgentChat, onVoiceFocus }, ref) => {
  const { width } = useWindowDimensions();
  const [activeTab, setActiveTab] = useState<"takumi" | "history">("takumi");
  const [activeCard, setActiveCard] = useState(0);
  const activityRef = useRef<ActivitySectionRef>(null);

  // ── Voice input (tap = scroll, hold = record) ────────────────────
  // Two independent gestures on the mic, so an accidental touch can
  // never fire the recorder:
  //   • a quick TAP just brings the section into focus and surfaces the
  //     "hold to speak" hint — it records nothing, and works any time.
  //   • a press-and-HOLD records (same STT + waveform stack as agent
  //     mode's `ChatInput`); releasing transcribes, hands the text to
  //     the agent chat via `useAgentPrefill` (prefilled, not sent), and
  //     asks the parent to open that page.
  // Tap/hold are split by the platform long-press detector
  // (`onLongPress` + `delayLongPress`), so no prior tap is required
  // before a hold and no re-tap is needed between recordings.
  const voice = useVoiceTranscription();
  const { setPrefill } = useAgentPrefill();
  const [voiceArmed, setVoiceArmed] = useState(false);
  const holdActiveRef = useRef(false);
  // Set when a hold actually starts recording so the matching press-out
  // (and not a plain tap's press-out) is what stops + transcribes.
  const didStartRecordingRef = useRef(false);

  // Fast-hold guard: `voice.start()` is async (permission + prepare),
  // so a quick hold can flip to "recording" only AFTER the finger
  // lifted. If that happens with no active hold, cancel immediately so
  // the mic is never left open.
  useEffect(() => {
    if (voice.status === "recording" && !holdActiveRef.current) {
      void voice.cancel();
    }
  }, [voice.status, voice.cancel]);

  // Quick tap — scroll the section into focus + show the hint. Never
  // records (a tap never trips `onLongPress`).
  const handleMicTap = useCallback(() => {
    if (voice.status === "transcribing" || voice.status === "recording") {
      return;
    }
    setVoiceArmed(true);
    onVoiceFocus?.();
  }, [voice.status, onVoiceFocus]);

  // Press-and-hold crossed the long-press threshold — start recording.
  const handleMicHoldStart = useCallback(() => {
    if (voice.status === "transcribing") return;
    didStartRecordingRef.current = true;
    holdActiveRef.current = true;
    void voice.start();
  }, [voice]);

  const handleMicPressOut = useCallback(() => {
    holdActiveRef.current = false;
    // Was a tap, not a hold — nothing to stop.
    if (!didStartRecordingRef.current) return;
    didStartRecordingRef.current = false;
    // Start still in flight from an ultra-quick hold: the status effect
    // above cancels it once it spins up.
    if (voice.status !== "recording") return;
    void (async () => {
      const transcript = await voice.stopAndTranscribe();
      if (transcript) {
        setPrefill(transcript);
        onOpenAgentChat?.("mic");
      }
    })();
  }, [voice, setPrefill, onOpenAgentChat]);

  // Capability / spotlight / quick-prompt cards are one-tap actions:
  // hand the ready-made prompt to the agent chat with `autoSend` so it
  // fires straight into a new turn (unlike the mic, which prefills the
  // transcript for review), then open the chat page. `source` identifies
  // which card type fired, for analytics breakdown.
  const handleSubmitPrompt = useCallback(
    (prompt: string, source: string) => {
      setPrefill(prompt, { autoSend: true });
      onOpenAgentChat?.(source);
    },
    [setPrefill, onOpenAgentChat],
  );

  // The History tab hosts the real activity list; forward refresh to it.
  useImperativeHandle(ref, () => ({
    refetch: () => activityRef.current?.refetch(),
  }));

  // Rail card geometry. The card has horizontal padding of 18 (p-[18px]); the
  // rail bleeds to the card edges with a negative margin so the next card peeks.
  const innerWidth = width - 32 /* px-4 */ - 36 /* p-[18px] x2 */;
  const heroWidth = Math.round(innerWidth * 0.8);
  const capWidth = Math.round(innerWidth * 0.46);

  const snapOffsets = useMemo(() => {
    const widths = [heroWidth, ...CAPABILITIES.map(() => capWidth)];
    const offsets: number[] = [];
    let acc = 0;
    for (const w of widths) {
      offsets.push(acc);
      acc += w + RAIL_GAP;
    }
    return offsets;
  }, [heroWidth, capWidth]);

  const handleRailScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const x = e.nativeEvent.contentOffset.x;
      let nearest = 0;
      let best = Number.POSITIVE_INFINITY;
      snapOffsets.forEach((offset, i) => {
        const d = Math.abs(offset - x);
        if (d < best) {
          best = d;
          nearest = i;
        }
      });
      if (nearest !== activeCard) setActiveCard(nearest);
    },
    [snapOffsets, activeCard],
  );

  const railLength = CAPABILITIES.length + 1;

  return (
    <View className="px-4">
      <View className="bg-light rounded-[22px] w-full p-[18px] gap-3.5">
        {/* tab switcher */}
        <View className="flex-row bg-light-main-container rounded-full p-1">
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => setActiveTab("takumi")}
            className={`flex-1 flex-row items-center justify-center gap-1.5 py-2 rounded-full ${
              activeTab === "takumi" ? "bg-light" : ""
            }`}
            style={
              activeTab === "takumi"
                ? {
                    shadowColor: "#20222c",
                    shadowOffset: { width: 0, height: 2 },
                    shadowOpacity: 0.1,
                    shadowRadius: 4,
                    elevation: 2,
                  }
                : undefined
            }
          >
            <Sparkles
              size={14}
              color={activeTab === "takumi" ? "#c71c4b" : "#9aa0ad"}
              strokeWidth={2.4}
            />
            <Text
              className={`text-[13px] font-bold ${
                activeTab === "takumi"
                  ? "text-light-primary-red"
                  : "text-light-matte-black/40"
              }`}
            >
              TakumiAgent
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => setActiveTab("history")}
            className={`flex-1 flex-row items-center justify-center gap-1.5 py-2 rounded-full ${
              activeTab === "history" ? "bg-light" : ""
            }`}
            style={
              activeTab === "history"
                ? {
                    shadowColor: "#20222c",
                    shadowOffset: { width: 0, height: 2 },
                    shadowOpacity: 0.1,
                    shadowRadius: 4,
                    elevation: 2,
                  }
                : undefined
            }
          >
            <Clock
              size={14}
              color={activeTab === "history" ? "#c71c4b" : "#9aa0ad"}
              strokeWidth={2.4}
            />
            <Text
              className={`text-[13px] font-bold ${
                activeTab === "history"
                  ? "text-light-primary-red"
                  : "text-light-matte-black/40"
              }`}
            >
              History
            </Text>
          </TouchableOpacity>
        </View>

        {activeTab === "takumi" ? (
          <>
            {/* greeting */}
            <View className="flex-row items-center gap-2.5">
              <View className="w-9 h-9 rounded-full bg-light-primary-red items-center justify-center">
                <Sparkles size={18} color="#ffffff" strokeWidth={2.2} />
              </View>
              <View className="flex-1">
                <Text className="text-light-matte-black font-extrabold text-[15px]">
                  Hi, I&apos;m TakumiAgent 👋
                </Text>
                <Text className="text-light-matte-black/45 text-[11px]">
                  Swipe to see what I can do →
                </Text>
              </View>
            </View>

            {/* swipe rail: spotlight + capability cards */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              decelerationRate="fast"
              snapToOffsets={snapOffsets}
              onScroll={handleRailScroll}
              scrollEventThrottle={16}
              style={{ marginHorizontal: -18 }}
              contentContainerStyle={{
                gap: RAIL_GAP,
                paddingHorizontal: 18,
              }}
            >
              <SpotlightCard
                width={heroWidth}
                onPress={() =>
                  handleSubmitPrompt(SPOTLIGHT_PROMPT, "spotlight")
                }
              />
              {CAPABILITIES.map((item) => (
                <CapabilityCard
                  key={item.id}
                  item={item}
                  width={capWidth}
                  onPress={() =>
                    handleSubmitPrompt(item.prompt, "capability_card")
                  }
                />
              ))}
            </ScrollView>

            {/* rail dots */}
            <View className="flex-row items-center justify-center gap-1.5">
              {Array.from({ length: railLength }).map((_, i) => (
                <View
                  key={i}
                  className={`h-1.5 rounded-full ${
                    i === activeCard
                      ? "w-4 bg-light-primary-red"
                      : "w-1.5 bg-light-matte-black/15"
                  }`}
                />
              ))}
            </View>

            {/* quick prompt chips */}
            <View className="flex-row items-center justify-between gap-1">
              {QUICK_PROMPTS.map((chip) => {
                const Icon = chip.icon;
                return (
                  <TouchableOpacity
                    key={chip.id}
                    activeOpacity={0.8}
                    onPress={() =>
                      handleSubmitPrompt(chip.prompt, "quick_prompt_chip")
                    }
                    className="flex-row items-center gap-1.5 bg-light-main-container grow border border-light-matte-black/5 rounded-full px-3 py-2"
                  >
                    <Icon size={14} color="#c71c4b" strokeWidth={2.4} />
                    <Text className="text-light-matte-black font-bold text-[12px]">
                      {chip.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* ask bar */}
            <View className="flex-row items-center gap-2 bg-light-main-container border border-light-matte-black/5 rounded-full pl-4 pr-1.5 py-1.5">
              {voice.status === "recording" ? (
                <VoiceRecordingBar recorder={voice.recorder} />
              ) : (
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={() =>
                    onOpenAgentChat ? onOpenAgentChat("ask_bar") : onAsk?.()
                  }
                  className="flex-1"
                  disabled={voice.status === "transcribing"}
                >
                  <Text className="text-light-matte-black/40 text-[13px]">
                    {voice.status === "transcribing"
                      ? "Transcribing…"
                      : voiceArmed
                        ? "Hold the mic button to speak"
                        : "Ask TakumiAgent anything…"}
                  </Text>
                </TouchableOpacity>
              )}
              <Pressable
                onPress={handleMicTap}
                onLongPress={handleMicHoldStart}
                delayLongPress={250}
                onPressOut={handleMicPressOut}
                disabled={voice.status === "transcribing"}
                accessibilityLabel="Tap to focus, hold to speak to TakumiAgent"
                className="w-10 h-10 rounded-full bg-light-primary-red items-center justify-center active:opacity-90"
              >
                {voice.status === "transcribing" ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <Mic size={18} color="#ffffff" strokeWidth={2.2} />
                )}
              </Pressable>
            </View>
          </>
        ) : (
          <ActivitySection ref={activityRef} embedded />
        )}
      </View>
    </View>
  );
});

TakumiAgentSection.displayName = "TakumiAgentSection";

export default TakumiAgentSection;
