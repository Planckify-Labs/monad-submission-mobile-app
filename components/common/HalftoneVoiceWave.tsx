// The live mic level while recording, as a rolling halftone wave in the
// orb's dot language. The renderer is `./HalftoneVoiceWaveSkia`; this
// wrapper applies the brand tint and the Skia guard (`./skiaAvailable`).
// The level is real feedback that the mic hears the user, so without
// Skia it falls back to the plain bars rather than showing nothing.

import type { AudioRecorder } from "expo-audio";
import type { ComponentType } from "react";
import { AudioWaveBars } from "@/components/home/TakumiAgent/AudioWaveBars";
import type { HalftoneVoiceWaveProps } from "./HalftoneVoiceWaveSkia";
import { isSkiaAvailable } from "./skiaAvailable";
import { ORB_BRAND_COLOR } from "./ThinkingOrb";

// `undefined` = not loaded yet, `null` = Skia absent from this binary.
let skiaWave: ComponentType<HalftoneVoiceWaveProps> | null | undefined;

function loadSkiaWave(): ComponentType<HalftoneVoiceWaveProps> | null {
  if (skiaWave !== undefined) return skiaWave;
  if (!isSkiaAvailable()) {
    skiaWave = null;
  } else {
    const renderer =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("./HalftoneVoiceWaveSkia") as typeof import("./HalftoneVoiceWaveSkia");
    skiaWave = renderer.SkiaHalftoneVoiceWave;
  }
  return skiaWave;
}

export function HalftoneVoiceWave({ recorder }: { recorder: AudioRecorder }) {
  const SkiaWave = loadSkiaWave();
  if (!SkiaWave) return <AudioWaveBars recorder={recorder} />;
  return <SkiaWave recorder={recorder} color={ORB_BRAND_COLOR} />;
}
