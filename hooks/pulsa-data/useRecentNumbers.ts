import { useCallback, useEffect } from "react";
import useRQGlobalState from "@/hooks/useRQGlobalState";
import {
  getRecentNumbers,
  type RecentNumber,
  type RecordUsageInput,
  recordNumberUsage,
  removeRecentNumber,
} from "@/services/ppob/recentNumbers";

const RECENT_NUMBERS_KEY = ["pulsa-data", "recent-numbers"] as const;

/**
 * Frequently-used numbers, backed by MMKV and mirrored into RQ global
 * state so the chips stay in sync across the screen. MMKV is the source
 * of truth; this hydrates from it on mount and writes through on every
 * mutation.
 */
export function useRecentNumbers() {
  const { data, setNewData } = useRQGlobalState<RecentNumber[]>({
    queryKey: RECENT_NUMBERS_KEY,
    initialData: [],
  });

  // Hydrate from MMKV once on mount. `setNewData` is intentionally left
  // out of deps — its identity changes every render (queryKey literal),
  // and MMKV is authoritative, so a single read is all we need.
  // biome-ignore lint/correctness/useExhaustiveDependencies: hydrate-once
  useEffect(() => {
    setNewData(getRecentNumbers());
  }, []);

  const record = useCallback(
    (input: RecordUsageInput) => setNewData(recordNumberUsage(input)),
    [setNewData],
  );

  const remove = useCallback(
    (numberOrKey: string) => setNewData(removeRecentNumber(numberOrKey)),
    [setNewData],
  );

  return { recentNumbers: data ?? [], record, remove };
}
