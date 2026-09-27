/**
 * Reveal timeline for `SmokeReveal`: a continuous playhead that assigns each
 * recorded character its birth time as the playhead crosses it.
 *
 * Invariant (continuous motion): the playhead is a float position `pos`
 * (characters born so far) with a velocity `vel`. The target velocity
 * follows `backlog / TARGET_LAG_MS`, clamped to [`MIN_CPS`, the run's max],
 * and `vel` relaxes toward it with time constant `TAU_MS = TARGET_LAG_MS / 4`.
 * Together that is a critically damped second-order tracker of the arrival
 * count: bursts speed the front up gradually, and a stall (backlog -> 0)
 * decelerates it to rest over several frames with no overshoot, instead of
 * the old per-burst schedule's hard jumps between constant speeds.
 *
 * Invariant (never ahead, bounded behind): `pos <= total` always, so the
 * reveal never passes the recorded text. Every run carries a deadline
 * (`arrival + cap`); a deadline velocity floor sweeps an overdue run in
 * linearly before its deadline, and a hard guard at each substep makes the
 * cap exact. The caps are the historical `MAX_LAG_MS` / `ACCENT_MAX_LAG_MS`.
 *
 * Invariant (deterministic integration): the playhead integrates on a fixed
 * grid of `SUBSTEP_MS` absolute multiples. `record()` and `apply()` only
 * advance to the last grid point at or before "now", so the birth times are
 * a pure function of the arrival times and never of how often, or when, the
 * owner happens to paint. Births inside a substep are linearly interpolated
 * and clamped to be monotonic and never before the character arrived.
 *
 * @module cli/smoke-reveal.playhead
 */

import type { RevealStyle } from './smoke-reveal.cells.js';

/** Steady-state reveal lag: the playhead trails a steady stream by about this much. */
export const TARGET_LAG_MS = 170;
/** Velocity relaxation time. `TARGET_LAG_MS / 4` is the critical-damping point. */
export const TAU_MS = TARGET_LAG_MS / 4;
/** Slowest the front crawls while any character is waiting (keeps the last letter prompt). */
export const MIN_CPS = 30;
/** Fastest comfortable prose reveal. Faster arrival grows the backlog until the lag cap takes over. */
export const MAX_CPS = 240;
/** Fastest heading reveal: an 18 ms heading cadence, so smoke has room to roll. */
export const HEADING_MAX_CPS = 1000 / 18;
/** Fixed integration step. Births are interpolated inside it. */
export const SUBSTEP_MS = 1;

export interface RunSpec {
  count: number;
  style: RevealStyle;
  /** Lag cap: every character of the run is born by `arrival + capMs`. */
  capMs: number;
  /** Speed ceiling while the front is inside this run. `Infinity` = instant. */
  maxCps: number;
}

interface Run {
  /** Absolute index one past the run's last character. */
  end: number;
  deadline: number;
  maxPerMs: number;
}

export class RevealTimeline {
  /** Characters recorded over the timeline's life (absolute index of the next one). */
  private total = 0;
  /** Characters pruned from the front (absolute index of births[0] / styles[0]). */
  private base = 0;
  private pos = 0;
  /** Velocity in characters per millisecond. */
  private vel = 0;
  /** Last integrated grid time; null before the first event. */
  private clock: number | null = null;
  /** Runs that still hold unborn characters, oldest first. */
  private runs: Run[] = [];
  /** Birth time of every born, unpruned character. */
  private births: number[] = [];
  /** Style of every unpruned character (born or not). */
  private styles: RevealStyle[] = [];
  /** Arrival time per run end, for the monotonic "not before arrival" clamp. */
  private arrivals: { end: number; at: number }[] = [];

  /** Absolute index one past the newest recorded character. */
  get recorded(): number { return this.total; }
  /** Absolute index of the oldest character still tracked. */
  get first(): number { return this.base; }
  /** Characters born so far (absolute). */
  get bornCount(): number { return this.base + this.births.length; }
  /** Current front velocity in characters per second (for tests and probes). */
  get cps(): number { return this.vel * 1000; }
  /** Float playhead position (for tests and probes). */
  get position(): number { return this.pos; }

  /** Append a run of characters that arrived at `t`. */
  record(t: number, spec: RunSpec): void {
    if (spec.count <= 0) return;
    this.advance(t);
    const caughtUp = this.bornCount >= this.total;
    this.total += spec.count;
    for (let i = 0; i < spec.count; i++) this.styles.push(spec.style);
    this.runs.push({ end: this.total, deadline: t + spec.capMs, maxPerMs: spec.maxCps / 1000 });
    this.arrivals.push({ end: this.total, at: t });
    // First text after the front came to rest is born the instant it arrives
    // (zero first-token latency); the rest of the run then accelerates in.
    if (caughtUp) this.bornThrough(this.bornCount + 1, t);
    if (spec.maxCps === Infinity) this.bornThrough(this.total, t);
  }

  /** Integrate the playhead up to the last grid point at or before `t`. */
  advance(t: number): void {
    const grid = Math.floor(t / SUBSTEP_MS) * SUBSTEP_MS;
    if (this.clock === null || this.atRest()) {
      this.clock = Math.max(this.clock ?? grid, grid);
      return;
    }
    while (this.clock + SUBSTEP_MS <= grid) {
      this.step(this.clock);
      this.clock += SUBSTEP_MS;
      if (this.atRest()) {
        this.clock = grid;
        return;
      }
    }
  }

  /** Birth time of absolute character `i`: null if pruned (settled), Infinity if not yet born. */
  birthAt(i: number): number | null {
    if (i < this.base) return null;
    const b = this.births[i - this.base];
    return b === undefined ? Infinity : b;
  }

  styleAt(i: number): RevealStyle | undefined {
    return this.styles[i - this.base];
  }

  /** Remove the `n` newest characters (formatter-consumed syntax). */
  trimNewest(n: number): void {
    const take = Math.min(n, this.total - this.base);
    if (take <= 0) return;
    this.total -= take;
    this.styles.length = this.total - this.base;
    if (this.bornCount > this.total) this.births.length = this.total - this.base;
    this.pos = Math.min(this.pos, this.total);
    for (const list of [this.runs, this.arrivals]) {
      while (list.length > 0 && (list.at(-2)?.end ?? this.base) >= this.total) list.pop();
      const last = list.at(-1);
      if (last) last.end = Math.min(last.end, this.total);
    }
    if (this.runs.at(-1)?.end === this.bornCount && this.bornCount === this.total) this.runs = [];
  }

  /** Drop born characters from the front once `lifeOf(style)` has elapsed since their birth. */
  prune(t: number, lifeOf: (style: RevealStyle) => number): void {
    let k = 0;
    while (k < this.births.length) {
      const style = this.styles[k];
      const birth = this.births[k];
      if (style === undefined || birth === undefined || birth + lifeOf(style) > t) break;
      k++;
    }
    if (k === 0) return;
    this.births.splice(0, k);
    this.styles.splice(0, k);
    this.base += k;
    while (this.arrivals.length > 0 && (this.arrivals[0]?.end ?? 0) <= this.base) this.arrivals.shift();
  }

  /** Predicted birth of the newest character: exact if born, else a bounded estimate. */
  newestBirthEstimate(t: number): number | null {
    if (this.total === this.base) return null;
    const known = this.birthAt(this.total - 1);
    if (known !== null && known !== Infinity) return known;
    const unborn = this.total - this.pos;
    const eta = t + unborn / Math.max(this.vel, MIN_CPS / 1000);
    const deadline = this.runs.at(-1)?.deadline ?? eta;
    return Math.min(eta, deadline);
  }

  reset(): void {
    this.total = 0;
    this.base = 0;
    this.pos = 0;
    this.vel = 0;
    this.clock = null;
    this.runs = [];
    this.births = [];
    this.styles = [];
    this.arrivals = [];
  }

  private atRest(): boolean {
    return this.bornCount >= this.total && this.vel === 0;
  }

  /** One fixed substep starting at grid time `g`. */
  private step(g: number): void {
    const h = SUBSTEP_MS;
    const born = this.bornCount;
    while (this.runs.length > 0 && (this.runs[0]?.end ?? 0) <= born) this.runs.shift();
    const head = this.runs[0];
    if (!head) {
      this.pos = this.total;
      this.vel = 0;
      return;
    }
    if (head.maxPerMs === Infinity) {
      this.bornThrough(head.end, g);
      return;
    }
    const backlog = this.total - this.pos;
    const target = Math.min(Math.max(backlog / TARGET_LAG_MS, MIN_CPS / 1000), head.maxPerMs);
    this.vel += ((target - this.vel) * h) / TAU_MS;
    this.vel = Math.max(this.vel, this.deadlineFloor(g));
    const from = this.pos;
    let to = Math.min(this.total, from + this.vel * h);
    // Hard lag cap: anything overdue at the end of this step is born now.
    for (const r of this.runs) if (r.deadline <= g + h && r.end > to) to = r.end;
    if (to >= this.total) {
      to = this.total;
      this.vel = 0;
    }
    this.cross(from, to, g, h);
  }

  /** Velocity needed so every run finishes by its deadline (a linear sweep when binding). */
  private deadlineFloor(g: number): number {
    let need = 0;
    for (const r of this.runs) {
      const left = r.end - this.pos;
      if (left <= 0) continue;
      need = Math.max(need, left / Math.max(SUBSTEP_MS, r.deadline - g));
    }
    return need;
  }

  /** Move the playhead from `from` to `to` over [g, g+h], stamping interpolated births. */
  private cross(from: number, to: number, g: number, h: number): void {
    const span = to - from;
    while (this.bornCount + 1 <= to + 1e-9) {
      const k = this.bornCount + 1;
      const at = span > 0 ? g + (h * Math.max(0, k - from)) / span : g + h;
      this.stamp(Math.min(at, g + h));
    }
    this.pos = Math.max(this.pos, to);
  }

  /** Mark every character below absolute `end` born at `t` (never before its own arrival). */
  private bornThrough(end: number, t: number): void {
    while (this.bornCount < Math.min(end, this.total)) this.stamp(t);
    this.pos = Math.max(this.pos, this.bornCount);
  }

  private stamp(t: number): void {
    const i = this.bornCount;
    const prev = this.births.at(-1) ?? -Infinity;
    this.births.push(Math.max(t, prev, this.arrivalOf(i)));
  }

  private arrivalOf(i: number): number {
    for (const a of this.arrivals) if (i < a.end) return a.at;
    return -Infinity;
  }
}
