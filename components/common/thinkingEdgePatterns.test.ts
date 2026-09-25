import { describe, expect, it } from "vitest";
import {
  CONFIRM_SEGMENT,
  CONFIRM_TICK_S,
  edgePattern,
} from "./thinkingEdgePatterns";

const HEIGHT = 280;
const DOCK_STATES = [
  "breathing",
  "searching",
  "shaping",
  "connecting",
  "composing",
  "working",
] as const;

// Row positions a strip actually draws (every 5dp from 2.5dp).
const rows = Array.from(
  { length: Math.floor(HEIGHT / 5) },
  (_, k) => 2.5 + k * 5,
);

describe("edgePattern", () => {
  it("stays within 0..1 for every state the dock uses", () => {
    for (const state of DOCK_STATES) {
      const pattern = edgePattern(state);
      for (const t of [0, 0.37, 1.9, 7.3, 123.4]) {
        for (const fb of rows) {
          for (const col of [0, 1, 2]) {
            for (const phase of [0, Math.PI]) {
              const v = pattern(fb, col, phase, t, HEIGHT);
              expect(v).toBeGreaterThanOrEqual(0);
              expect(v).toBeLessThanOrEqual(1);
            }
          }
        }
      }
    }
  });

  it("gives unmapped states the plain flow", () => {
    expect(edgePattern("weaving")).toBe(edgePattern("working"));
    expect(edgePattern("solving")).toBe(edgePattern("working"));
    expect(edgePattern("searching")).not.toBe(edgePattern("working"));
  });

  it("Reading scans: one bright band that moves", () => {
    const pattern = edgePattern("searching");
    const brightestRow = (t: number) =>
      rows.reduce((best, fb) =>
        pattern(fb, 0, 0, t, HEIGHT) > pattern(best, 0, 0, t, HEIGHT)
          ? fb
          : best,
      );
    const a = brightestRow(0.4);
    const b = brightestRow(1.2);
    expect(Math.abs(a - b)).toBeGreaterThan(30);
    expect(pattern(a, 0, 0, 0.4, HEIGHT)).toBeGreaterThan(0.95);
  });

  it("Transaction climbs from the bottom, one segment per tick, both edges together", () => {
    const pattern = edgePattern("shaping");
    const at = (segment: number, tick: number, phase = 0) =>
      pattern(
        segment * CONFIRM_SEGMENT + 2.5,
        0,
        phase,
        tick * CONFIRM_TICK_S + 0.01,
        HEIGHT,
      );
    // Nothing lit at the start of the ladder.
    expect(at(0, 0)).toBeCloseTo(0.08);
    // Tick 3: segments 0-1 confirmed, 2 is the newest, 3 not yet.
    expect(at(0, 3)).toBeCloseTo(0.5);
    expect(at(1, 3)).toBeCloseTo(0.5);
    expect(at(2, 3)).toBe(1);
    expect(at(3, 3)).toBeCloseTo(0.08);
    expect(at(2, 3, Math.PI)).toBe(1);
  });

  it("Reconnecting stays sparse: mostly dim, with a few dots cutting in", () => {
    const pattern = edgePattern("connecting");
    let bright = 0;
    let total = 0;
    for (const t of [0.1, 0.5, 0.9, 1.3]) {
      for (const fb of rows) {
        for (const col of [0, 1, 2]) {
          total++;
          if (pattern(fb, col, 0, t, HEIGHT) > 0.5) bright++;
        }
      }
    }
    const share = bright / total;
    expect(share).toBeGreaterThan(0.1);
    expect(share).toBeLessThan(0.4);
  });
});
