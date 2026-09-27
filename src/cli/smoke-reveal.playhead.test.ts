import { describe, it, expect } from 'vitest';
import {
  RevealTimeline,
  MAX_CPS,
  HEADING_MAX_CPS,
  MIN_CPS,
  TARGET_LAG_MS,
  type RunSpec,
} from './smoke-reveal.playhead.js';

const MAX_LAG_MS = 250;
const ACCENT_MAX_LAG_MS = 600;
const FRAME = 1000 / 60;

const prose = (count: number): RunSpec => ({ count, style: 'ink', capMs: MAX_LAG_MS, maxCps: MAX_CPS });

/** Bursty stream: 3-5 chars every 18 ms, with a 180 ms stall every 12th chunk. */
function burstyEvents(chunks = 60): [number, number][] {
  const out: [number, number][] = [];
  let t = 0;
  for (let k = 1; k <= chunks; k++) {
    t += k % 12 === 0 ? 180 : 18;
    out.push([t, 3 + (k % 3)]);
  }
  return out;
}

interface Run {
  adv: number[];
  /** Per-frame advance of the float playhead (before integer rounding). */
  fadv: number[];
  arrivalOf: number[];
  birthOf: number[];
  ahead: boolean;
}

/** Drive a timeline with `events` and sample it on a fixed frame clock. */
function drive(events: [number, number][], frame: number, spec: (n: number) => RunSpec = prose): Run {
  const tl = new RevealTimeline();
  const arrivalOf: number[] = [];
  const birthOf: number[] = [];
  const adv: number[] = [];
  const fadv: number[] = [];
  let fprev = 0;
  let ahead = false;
  let ei = 0;
  let prev = 0;
  const end = (events.at(-1)?.[0] ?? 0) + 1_000;
  for (let c = 0; c <= end; c += frame) {
    while (ei < events.length && (events[ei]?.[0] ?? Infinity) <= c) {
      const [at, n] = events[ei] ?? [0, 0];
      tl.record(at, spec(n));
      for (let i = 0; i < n; i++) arrivalOf.push(at);
      ei++;
    }
    tl.advance(c);
    if (tl.bornCount > tl.recorded) ahead = true;
    for (let i = birthOf.length; i < tl.bornCount; i++) birthOf.push(tl.birthAt(i) ?? NaN);
    adv.push(tl.bornCount - prev);
    prev = tl.bornCount;
    fadv.push(tl.position - fprev);
    fprev = tl.position;
  }
  return { adv, fadv, arrivalOf, birthOf, ahead };
}

const maxChange = (xs: number[]): number => {
  let m = 0;
  for (let i = 1; i < xs.length; i++) m = Math.max(m, Math.abs((xs[i] ?? 0) - (xs[i - 1] ?? 0)));
  return m;
};

describe('RevealTimeline', () => {
  it('advances the front smoothly through a bursty stream with stalls (60 fps frames)', () => {
    const { adv, fadv } = drive(burstyEvents(), FRAME);
    // Bound: velocity relaxes toward its target with TAU_MS (30 ms) and the
    // target itself only moves as the backlog does, so the continuous front's
    // per-frame advance changes by well under one character between frames.
    // The one exception is the stream's very first character, born the
    // instant it arrives (zero first-token latency), so allow one character
    // plus the continuous bound. The integer front adds at most one character
    // of rounding. The legacy per-burst schedule changed by 3 chars/frame.
    expect(maxChange(fadv.slice(4))).toBeLessThan(0.6);
    expect(maxChange(fadv)).toBeLessThan(1.6);
    expect(maxChange(adv)).toBeLessThanOrEqual(2);
  });

  it('keeps the per-frame change bounded at 30 fps frames too', () => {
    const { adv, fadv } = drive(burstyEvents(), 33);
    // Twice the frame, twice the float bound. Legacy: 5 chars/frame here.
    expect(maxChange(fadv)).toBeLessThan(2);
    expect(maxChange(adv)).toBeLessThanOrEqual(3);
  });

  it('decelerates over at least 3 frames into a stall instead of stopping dead', () => {
    const tl = new RevealTimeline();
    // Steady 200 cps for 400 ms, then silence.
    for (let t = 0; t <= 400; t += 20) tl.record(t, prose(4));
    const speeds: number[] = [];
    for (let c = 400; c <= 400 + 20 * FRAME; c += FRAME) {
      tl.advance(c);
      speeds.push(tl.cps);
    }
    // The front may still be converging on its target when input stops; from
    // its peak on it only slows, and it is still moving 3 frames past the peak.
    const at = speeds.indexOf(Math.max(...speeds));
    const peak = speeds[at] ?? 0;
    expect(peak).toBeGreaterThan(100);
    for (let i = at + 1; i < speeds.length; i++) expect(speeds[i] ?? 0).toBeLessThanOrEqual((speeds[i - 1] ?? 0) + 1e-9);
    expect(speeds[at + 3] ?? 0).toBeGreaterThan(0);
    expect(speeds[at + 3] ?? 0).toBeLessThan(peak);
    // And it comes to rest with everything born.
    expect(speeds.at(-1)).toBe(0);
    expect(tl.bornCount).toBe(tl.recorded);
  });

  it('never passes the recorded text, and never births a character before it arrived', () => {
    const { ahead, arrivalOf, birthOf } = drive(burstyEvents(), FRAME);
    expect(ahead).toBe(false);
    expect(birthOf.length).toBe(arrivalOf.length);
    for (let i = 0; i < birthOf.length; i++) {
      expect(birthOf[i] ?? NaN).toBeGreaterThanOrEqual(arrivalOf[i] ?? Infinity);
      if (i > 0) expect(birthOf[i] ?? NaN).toBeGreaterThanOrEqual(birthOf[i - 1] ?? Infinity);
    }
  });

  it('bounds reveal lag by the per-run cap even for a lump far faster than MAX_CPS', () => {
    const events: [number, number][] = [[0, 5], [10, 2_000], [20, 5]];
    const { birthOf, arrivalOf } = drive(events, FRAME);
    for (let i = 0; i < birthOf.length; i++) {
      expect((birthOf[i] ?? Infinity) - (arrivalOf[i] ?? 0)).toBeLessThanOrEqual(MAX_LAG_MS + 1e-6);
    }
  });

  it('holds heading runs to the slower heading ceiling and the longer accent cap', () => {
    const heading = (n: number): RunSpec => ({ count: n, style: 'smoke', capMs: ACCENT_MAX_LAG_MS, maxCps: HEADING_MAX_CPS });
    const { birthOf, arrivalOf } = drive([[0, 30]], FRAME, heading);
    // 30 chars at <= 83 cps: at least ~350 ms from first to last, within the cap.
    const spread = (birthOf.at(-1) ?? 0) - (birthOf[0] ?? 0);
    expect(spread).toBeGreaterThan((29 / HEADING_MAX_CPS) * 1000 * 0.95);
    for (let i = 0; i < birthOf.length; i++) {
      expect((birthOf[i] ?? Infinity) - (arrivalOf[i] ?? 0)).toBeLessThanOrEqual(ACCENT_MAX_LAG_MS + 1e-6);
    }
  });

  it('births the first character after rest on arrival (zero first-token latency)', () => {
    const tl = new RevealTimeline();
    tl.record(1_000, prose(10));
    expect(tl.birthAt(0)).toBe(1_000);
    expect(tl.birthAt(1)).toBe(Infinity);
  });

  it('crawls no slower than MIN_CPS while text waits, so a small tail lands promptly', () => {
    const tl = new RevealTimeline();
    tl.record(0, prose(4));
    tl.advance(4 / MIN_CPS * 1000 + TARGET_LAG_MS);
    expect(tl.bornCount).toBe(4);
  });

  it('reveals an infinite-speed run at once', () => {
    const tl = new RevealTimeline();
    tl.record(50, { count: 12, style: 'ink', capMs: 0, maxCps: Infinity });
    expect(tl.bornCount).toBe(12);
    expect(tl.birthAt(11)).toBe(50);
  });

  it('is a pure function of arrivals, independent of how often it is sampled', () => {
    const a = drive(burstyEvents(), FRAME).birthOf;
    const b = drive(burstyEvents(), 7).birthOf;
    expect(b).toEqual(a);
  });

  it('trimNewest removes consumed syntax from the newest runs, born or not', () => {
    const tl = new RevealTimeline();
    tl.record(0, prose(5));
    tl.record(0, prose(5));
    tl.trimNewest(7);
    expect(tl.recorded).toBe(3);
    expect(tl.bornCount).toBeLessThanOrEqual(3);
    tl.advance(1_000);
    expect(tl.bornCount).toBe(3);
  });

  it('prune drops settled characters from the front and reports them as settled', () => {
    const tl = new RevealTimeline();
    tl.record(0, prose(3));
    tl.advance(500);
    tl.prune(500, () => 100);
    expect(tl.first).toBe(3);
    expect(tl.birthAt(0)).toBeNull();
  });

  it('estimates the newest birth no later than its deadline', () => {
    const tl = new RevealTimeline();
    tl.record(0, prose(500));
    expect(tl.newestBirthEstimate(0)).toBeLessThanOrEqual(MAX_LAG_MS);
    tl.advance(1_000);
    expect(tl.newestBirthEstimate(1_000)).toBe(tl.birthAt(499));
  });
});
