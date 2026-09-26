import { ShoppingBag, Sparkles, Wallet } from "lucide-react-native";

export const ONBOARDING_SLIDE_DATA = [
  {
    icon: Sparkles,
    iconColor: "#c71c4b",
    iconBgColor: "#fef2f2",
    accentColor: "#c71c4b",
    title: "Meet Your AI Wallet Agent",
    description:
      "Your personal assistant for managing AUSD and payments on Monad through natural conversations.",
    features: [
      "Natural language transaction execution on Monad",
      "Optional wallet access, you decide what the agent can do",
      "Built for Monad, powered by AUSD",
    ],
  },
  {
    icon: Wallet,
    iconColor: "#059669",
    iconBgColor: "#ecfdf5",
    accentColor: "#059669",
    title: "On-Chain Actions",
    description: "Send AUSD, check balances, and monitor gas fees on Monad.",
    features: [
      "Native token: MON",
      "Stablecoin: AUSD",
      "Instant AUSD transfers on Monad",
      "Real-time gas estimates",
    ],
  },
  {
    icon: ShoppingBag,
    iconColor: "#7c3aed",
    iconBgColor: "#faf5ff",
    accentColor: "#7c3aed",
    title: "Redeem via Chat",
    description:
      "Explore services and redeem your points directly in your conversation.",
    features: [
      "Full product catalog access",
      "Filter by category & price",
      "One-command redemption",
    ],
  },
];
