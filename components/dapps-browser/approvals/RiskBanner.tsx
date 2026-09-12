import { AlertTriangle, Info, ShieldAlert } from "lucide-react-native";
import React, { useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import {
  findProvenance,
  LINK_PROVENANCE_CODE,
  ProvenanceBanner,
} from "@/components/deeplinks/ProvenanceBanner";
import type { IntentAnnotation } from "@/services/bridge/inspector";

type Severity = IntentAnnotation["severity"];

const SEVERITY_STYLE: Record<
  Severity,
  { bg: string; border: string; text: string; Icon: typeof Info }
> = {
  info: {
    bg: "bg-blue-50",
    border: "border-blue-200",
    text: "text-blue-800",
    Icon: Info,
  },
  warn: {
    bg: "bg-amber-50",
    border: "border-amber-200",
    text: "text-amber-900",
    Icon: AlertTriangle,
  },
  danger: {
    bg: "bg-red-50",
    border: "border-red-200",
    text: "text-red-900",
    Icon: ShieldAlert,
  },
};

const RANK: Record<Severity, number> = { info: 0, warn: 1, danger: 2 };

interface Props {
  annotations: IntentAnnotation[];
  /**
   * Sheets that render a second `RiskBanner` inside an `ApprovalShell`
   * (the Solana sheets) pass `false` so the provenance banner is painted
   * once, by the shell.
   */
  showProvenance?: boolean;
}

export function RiskBanner({
  annotations: all,
  showProvenance = true,
}: Props): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false);
  // Deep-link spec S-3: an externally-originated intent carries exactly
  // one `link_provenance` annotation. It gets its own banner (with the
  // "unverified is never a headline" rules) and is kept out of the
  // generic risk list so it is never buried behind a "+N" counter.
  const found = findProvenance(all);
  const provenance = showProvenance ? found : null;
  const annotations = found
    ? (all ?? []).filter((a) => a.code !== LINK_PROVENANCE_CODE)
    : all;
  if (!annotations || annotations.length === 0) {
    return provenance ? <ProvenanceBanner provenance={provenance} /> : null;
  }
  const top = [...annotations].sort(
    (a, b) => RANK[b.severity] - RANK[a.severity],
  )[0];
  const style = SEVERITY_STYLE[top.severity];
  const Icon = style.Icon;
  return (
    <>
      {provenance ? <ProvenanceBanner provenance={provenance} /> : null}
      <TouchableOpacity
        onPress={() => setExpanded((s) => !s)}
        activeOpacity={0.8}
        className={`rounded-xl border ${style.bg} ${style.border} p-3 mb-3`}
      >
        <View className="flex-row items-center">
          <Icon
            size={16}
            color={top.severity === "danger" ? "#b91c1c" : undefined}
          />
          <Text className={`ml-2 font-semibold ${style.text} flex-1`}>
            {top.title}
          </Text>
          {annotations.length > 1 && (
            <Text className={`text-xs ${style.text}`}>
              +{annotations.length - 1}
            </Text>
          )}
        </View>
        {expanded && (
          <View className="mt-2">
            {annotations.map((a, i) => {
              const s = SEVERITY_STYLE[a.severity];
              return (
                <View key={`${a.code}-${i}`} className="mt-1">
                  <Text className={`text-xs font-medium ${s.text}`}>
                    {a.title}
                  </Text>
                  {a.detail && (
                    <Text className={`text-xs ${s.text} opacity-80`}>
                      {a.detail}
                    </Text>
                  )}
                </View>
              );
            })}
          </View>
        )}
      </TouchableOpacity>
    </>
  );
}
