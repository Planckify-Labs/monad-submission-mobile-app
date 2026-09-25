// Turns the recorder's metering (dB) into a 0..1 voice level that is 0 in
// silence. A fixed dB floor can't do that: room and device noise sit
// anywhere from about -60 to -35 dB depending on the phone and the room,
// so a floor low enough for a quiet room reads a normal room's hum as
// speech (the wave kept moving after the user stopped talking). Instead
// this tracks the noise floor itself and only counts sound clearly above
// it.

/** Metering below this is treated as this (expo reports down to -160). */
const DB_MIN = -90;
/**
 * Readings at or below this are the recorder's "no signal yet" value
 * (about -160 dB while it starts up), not a level. Taking one as the room's
 * noise floor made ordinary room noise read as a loud voice for seconds.
 */
const NO_SIGNAL_DB = -120;
/**
 * After the first real reading, listen this long to learn the room's
 * noise before reporting any voice, so the wave starts flat (and the mic
 * button's own click doesn't register as speech).
 */
const WARMUP_S = 0.4;
/** Share of the gap the floor moves toward each reading during warm-up. */
const WARMUP_BLEND = 0.3;
/** The floor never rises above this, so a loud room can't swallow speech. */
const FLOOR_MAX = -30;
/** How far above the noise floor sound must be to count as voice, dB. */
const VOICE_MARGIN_DB = 8;
/**
 * dB above the voice threshold that reads as full level. Wide enough that
 * normal speech (~15-20 dB above room noise) lands mid-range and only
 * shouting reaches the top.
 */
const VOICE_RANGE_DB = 36;
/** Share of the gap the floor falls per sample toward quieter readings. */
const FLOOR_FALL = 0.5;
/**
 * Time constant (s) of the floor rising toward louder readings: slow, so
 * speech itself isn't absorbed into the floor during a sentence.
 */
const FLOOR_RISE_S = 6;

export type TVoiceGate = {
  floor: number | null;
  lastAt: number | null;
  /** When warm-up ends; null until the first real reading. */
  warmUntil: number | null;
};

export function createVoiceGate(): TVoiceGate {
  return { floor: null, lastAt: null, warmUntil: null };
}

/**
 * Feed one metering sample (dB) taken at `now` (seconds); returns the
 * voice level 0..1. Mutates `gate`.
 */
export function voiceLevel(
  gate: TVoiceGate,
  metering: number | undefined,
  now: number,
): number {
  if (
    metering === undefined ||
    !Number.isFinite(metering) ||
    metering <= NO_SIGNAL_DB
  ) {
    return 0;
  }
  const db = Math.max(DB_MIN, Math.min(0, metering));
  const dt = gate.lastAt === null ? 0 : Math.max(0, now - gate.lastAt);
  gate.lastAt = now;

  if (gate.floor === null || gate.warmUntil === null) {
    gate.floor = Math.min(db, FLOOR_MAX);
    gate.warmUntil = now + WARMUP_S;
    return 0;
  }
  if (now < gate.warmUntil) {
    // Still learning the room: settle toward its level, report silence.
    gate.floor = Math.min(
      FLOOR_MAX,
      gate.floor + (db - gate.floor) * WARMUP_BLEND,
    );
    return 0;
  }
  if (db < gate.floor) {
    // Quieter than the floor: this is the noise level now, follow fast.
    gate.floor += (db - gate.floor) * FLOOR_FALL;
  } else {
    gate.floor += (db - gate.floor) * (1 - Math.exp(-dt / FLOOR_RISE_S));
    gate.floor = Math.min(gate.floor, FLOOR_MAX);
  }

  const above = db - gate.floor - VOICE_MARGIN_DB;
  if (above <= 0) return 0;
  return Math.min(1, above / VOICE_RANGE_DB);
}
