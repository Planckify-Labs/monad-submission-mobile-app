import { describe, expect, it } from "vitest";
import { createVoiceGate, voiceLevel } from "./voiceLevel";

/** Feed `db` for `seconds` at the recorder's 50ms poll; return the last level. */
function feed(
  gate: ReturnType<typeof createVoiceGate>,
  db: number,
  seconds: number,
  start: number,
): { level: number; end: number } {
  let t = start;
  let level = 0;
  for (let i = 0; i < Math.round(seconds / 0.05); i++) {
    t += 0.05;
    level = voiceLevel(gate, db, t);
  }
  return { level, end: t };
}

describe("voiceLevel", () => {
  it("reads room noise as silence, whatever the room's level", () => {
    for (const noise of [-60, -48, -40]) {
      const gate = createVoiceGate();
      expect(feed(gate, noise, 2, 0).level).toBe(0);
    }
  });

  it("puts normal speech mid-range and keeps the top for shouting", () => {
    const speaking = createVoiceGate();
    const room = feed(speaking, -48, 1, 0);
    const normal = feed(speaking, -24, 0.3, room.end).level;
    expect(normal).toBeGreaterThan(0.3);
    expect(normal).toBeLessThan(0.7);

    const yelling = createVoiceGate();
    const room2 = feed(yelling, -48, 1, 0);
    expect(feed(yelling, -6, 0.3, room2.end).level).toBeGreaterThan(0.85);
  });

  it("goes back to exactly zero when the user stops talking", () => {
    const gate = createVoiceGate();
    let s = feed(gate, -48, 1, 0);
    s = feed(gate, -20, 3, s.end); // a few seconds of talking
    expect(feed(gate, -48, 0.3, s.end).level).toBe(0);
  });

  it("still hears speech that starts the instant recording does", () => {
    const gate = createVoiceGate();
    let s = feed(gate, -20, 1, 0); // floor starts at speech level...
    s = feed(gate, -50, 0.5, s.end); // ...falls fast in the first pause
    expect(feed(gate, -20, 0.2, s.end).level).toBeGreaterThan(0.4);
  });

  it("starts flat: the first moments only learn the room", () => {
    const gate = createVoiceGate();
    // Even a loud click right as recording starts reads as silence.
    expect(feed(gate, -15, 0.3, 0).level).toBe(0);
  });

  it("isn't fooled by the recorder's startup placeholder readings", () => {
    const gate = createVoiceGate();
    // expo-audio reports about -160 dB before real audio arrives.
    const startup = feed(gate, -160, 0.3, 0);
    expect(startup.level).toBe(0);
    // Real room noise afterwards must still read as silence, not voice.
    expect(feed(gate, -45, 2, startup.end).level).toBe(0);
  });

  it("ignores missing metering", () => {
    expect(voiceLevel(createVoiceGate(), undefined, 0)).toBe(0);
    expect(voiceLevel(createVoiceGate(), Number.NaN, 0)).toBe(0);
  });
});
