/**
 * Text reveal mask: streamed characters arrive softly instead of popping in.
 *
 * Two styles share one mask (see smoke-reveal.cells.ts for the look):
 *  - `ink` (the default for prose): a letter rises from just above the
 *    background into its OWN color, like ink drying, and never passes
 *    through a brighter tone than it settles on. `AFK_INK_TEXT=0` disables it.
 *  - `smoke` (the accent, opt-in via `AFK_SMOKE_TEXT=1`): heading lines
 *    condense out of braille particles, with a thin wisp drifting ahead of
 *    the front. Body prose stays ink, so smoke remains a moment.
 *
 * How it works:
 *  - `record(chunk)` runs when raw markdown enters the pipeline. It splits
 *    the chunk into heading / other runs and schedules a birth time for each
 *    character: at a steady floor cadence, compressed so the whole backlog is
 *    revealed within `MAX_LAG_MS` (headings: a slower cadence and a longer
 *    cap). A network lump therefore sweeps in quickly instead of landing as
 *    a block, and the reveal never trails the model by more than the cap.
 *  - `apply(formatted)` runs on the formatted pending overlay just before it
 *    is painted. It walks the visible characters, tracking the active SGR
 *    style, and restyles the youngest ones by age. Characters not yet born
 *    are drawn as blank cells of the same width.
 *
 * Invariant (pace the REVEAL, never the TEXT): every character is in the
 * buffer, laid out and committed exactly as it would be with the reveal off.
 * Only its styling (and blank-until-born) changes. An earlier version paced
 * text INTO the buffer instead; that grew the overlay one row at a time
 * (each growth at the bottom of the screen is a full compositor repaint, a
 * visible flicker) and held every paragraph in the overlay until its commit
 * (a shrink repaint per paragraph). Reserved blank cells keep the layout
 * identical to reveal-off, so the reveal cannot cause either.
 *
 * Invariant (age mapping by distance-from-end): ages are keyed by how far a
 * character sits from the END of the text, counting non-whitespace grapheme
 * clusters only. New text always lands at the end, and a block commit only
 * removes text from the FRONT, so distance-from-end survives commits,
 * re-wrapping, indentation, and centering margins unchanged. Births are
 * monotonic, so the characters not yet born are exactly the newest few.
 *
 * Invariant (raw vs formatted counts): `record()` sees RAW markdown, but
 * `apply()` indexes the FORMATTED overlay, and the formatter consumes syntax
 * (`**`, backticks, `## `). Each `apply()` compares how much the formatted
 * text grew since the previous apply against how much raw text was recorded
 * and trims the excess from the newest bursts. `noteCommit()` drops the
 * baseline whenever text leaves the FRONT of the overlay; the first frame
 * after a commit is left unreconciled, which is harmless.
 *
 * Invariant (settle driver): pending-overlay repaints are content-driven.
 * While any character is still settling, `apply()` arms ONE timer that calls
 * the owner's throttled `scheduleRepaint()`. There is no second paint path,
 * and the timer stops as soon as everything has settled.
 *
 * Contract: this module never delays a block commit. Committed blocks render
 * through `formatBlockForCommit`, untouched by the mask, so a paragraph's
 * last few letters may snap solid a moment early. That is deliberate:
 * holding a tall overlay across `commitAbove()` can drop the block (see
 * `syncPendingOverlay` in markdown-stream.ts).
 *
 * @module cli/smoke-reveal
 */

import chalk from 'chalk';
import stringWidth from 'string-width';
import { env, isPlainOutputRequested } from '../config/env.js';
import { isExplicitlyDisabled, isExplicitlyEnabled } from '../config/env-helpers.js';
import { countVisible, segmentAnsi } from './smoke-reveal.ansi.js';
import { SMOKE_GLYPH_LEVELS } from './smoke-reveal.frame.js';
import { LineClassifier } from './smoke-reveal.lines.js';
import { applySgr, EMPTY_SGR, isSgr, serializeSgr, type SgrState } from './smoke-reveal.sgr.js';
import {
  INK_MS,
  MAX_LIFETIME_MS,
  SMOKE_GLYPH_PHASE,
  SMOKE_MS,
  WISP_CELLS,
  inkCell,
  lifetimeOf,
  smokeCell,
  wispCell,
  wispCells,
  type RevealStyle,
} from './smoke-reveal.cells.js';

export type { RevealStyle } from './smoke-reveal.cells.js';
export { INK_MS } from './smoke-reveal.cells.js';

/** Smoke-accent lifetime: first speck to fully settled letter. */
export const LIFETIME_MS = SMOKE_MS;
/** Fraction of the smoke lifetime spent as a particle before the letter shows. */
export const GLYPH_PHASE = SMOKE_GLYPH_PHASE;
/** Floor spacing between revealed characters (about 150 characters per second). */
export const STAGGER_MS = 6;
/** Upper bound on how far a reveal may trail the character's arrival. */
export const MAX_LAG_MS = 250;
/** Floor spacing for heading lines: slower, so the smoke has room to roll. */
export const ACCENT_STAGGER_MS = 12;
/** Reveal-lag cap for heading lines. */
export const ACCENT_MAX_LAG_MS = 600;
/** Share of a smoke letter's life a held heading waits for before it may commit (eased: nearly solid). */
export const SMOKE_HOLD_SHARE = 0.75;
/** Settle-driver cadence, which matches the renderer's default throttle. */
export const FRAME_MS = 33;
/**
 * Every smoke glyph the reveal can draw, faintest density level first (see
 * `SMOKE_GLYPH_LEVELS` in smoke-reveal.frame.ts for the narrow-width
 * invariant). The ahead-of-front wisp draws from the same set.
 */
export const SMOKE_GLYPHS: readonly string[] = SMOKE_GLYPH_LEVELS.flat();

const RESET = '\u001b[0m';

interface Burst {
  start: number;
  end: number;
  count: number;
  style: RevealStyle;
}

export interface RecordOptions {
  /** Force one style for the whole chunk (skips heading detection). */
  style?: RevealStyle;
  /** Floor spacing between this chunk's characters. Default `STAGGER_MS`. */
  staggerMs?: number;
}

export interface RevealStyles {
  /** Style for body text. Default `smoke` (the historical behavior). */
  prose?: RevealStyle;
  /** Style for markdown heading lines. Default: same as `prose`. */
  headings?: RevealStyle;
}

export interface ApplyOptions {
  /**
   * Column budget of one overlay line. When given, a smoke front may draw its
   * wisp in the empty cells after it, but only if the whole line still fits.
   * Omitted: no wisp, and the output is column-for-column the input.
   */
  maxWidth?: number;
}

/** Terminal can show the reveal at all: not plain-output, and 256+ colors (so not NO_COLOR/CI/non-TTY). */
function canReveal(): boolean {
  return !isPlainOutputRequested() && chalk.level >= 2;
}

/** Smoke accent: `AFK_SMOKE_TEXT` is explicitly enabled on a capable terminal. */
export function isSmokeTextEnabled(): boolean {
  const raw = env.AFK_SMOKE_TEXT;
  if (!raw || !isExplicitlyEnabled(raw)) return false;
  return canReveal();
}

/** Ink reveal (default for prose): on unless `AFK_INK_TEXT` is explicitly disabled, on a capable terminal. */
export function isInkTextEnabled(): boolean {
  const raw = env.AFK_INK_TEXT;
  if (raw && isExplicitlyDisabled(raw)) return false;
  return canReveal();
}

interface Front {
  birth: number;
  style: RevealStyle;
  /** Style active after the newest character (restored after an inserted wisp). */
  state: SgrState;
  /** Index into the output parts just after the newest character. */
  at: number;
  /** Width of the newest character's line, filled in when the line ends. */
  lineWidth: number | null;
}

export class SmokeReveal {
  private bursts: Burst[] = [];
  private nextBirth = 0;
  private timer: NodeJS.Timeout | null = null;
  /**
   * Reconciled characters recorded over this instance's life. The character
   * `d` positions from the end has the stable identity `serial - 1 - d`: new
   * text raises both `serial` and `d` by the same amount, and a commit
   * removes text from the front without changing either.
   */
  private serial = 0;
  /** Visible count at the last walked apply(); null = no valid baseline. */
  private lastVisible: number | null = null;
  /** Raw visible characters recorded since the last walked apply(). */
  private sinceApply = 0;

  private readonly lines = new LineClassifier();
  private readonly prose: RevealStyle;
  private readonly headings: RevealStyle;

  constructor(
    private readonly requestRepaint: () => void,
    private readonly now: () => number = Date.now,
    styles: RevealStyles = {},
  ) {
    this.prose = styles.prose ?? 'smoke';
    this.headings = styles.headings ?? this.prose;
  }

  /** Register newly arrived raw text. Whitespace-only chunks are ignored. */
  record(chunk: string, opts: RecordOptions = {}): void {
    const t = this.now();
    const runs = opts.style
      ? [{ text: chunk, heading: false, style: opts.style }]
      : this.lines.split(chunk).map((r) => ({ ...r, style: r.heading ? this.headings : this.prose }));
    for (const run of runs) {
      const count = countVisible(run.text);
      if (count === 0) continue;
      const floor = opts.staggerMs ?? (run.heading ? ACCENT_STAGGER_MS : STAGGER_MS);
      const cap = t + (run.heading ? ACCENT_MAX_LAG_MS : MAX_LAG_MS);
      const start = Math.min(Math.max(t, this.nextBirth), cap);
      const end = Math.min(start + (count - 1) * floor, cap);
      this.bursts.push({ start, end, count, style: run.style });
      this.nextBirth = end + (count > 1 ? (end - start) / (count - 1) : floor);
      this.sinceApply += count;
    }
    this.prune(t);
  }

  /**
   * Milliseconds until the newest characters, if they are smoke, have
   * condensed enough (`SMOKE_HOLD_SHARE` of their life) to be committed
   * without a visible snap. 0 when the newest burst is not smoke.
   */
  smokeHoldRemaining(): number {
    const b = this.bursts[this.bursts.length - 1];
    if (!b || b.style !== 'smoke') return 0;
    return Math.max(0, b.end + SMOKE_MS * SMOKE_HOLD_SHARE - this.now());
  }

  /**
   * Style the youngest characters of `formatted` by age. Returns `formatted`
   * unchanged (same reference) when nothing is animating.
   */
  apply(formatted: string, opts: ApplyOptions = {}): string {
    const t = this.now();
    this.prune(t);
    if (this.bursts.length === 0 || formatted === '') return formatted;

    const segs = segmentAnsi(formatted);
    let visible = 0;
    for (const s of segs) if (s.kind === 'char' && !s.ws) visible++;
    this.reconcile(visible);

    // Characters at or beyond the recorded total are settled by definition,
    // so skip the per-burst walk for them (most of a long paragraph).
    const recorded = this.recordedCount();
    // Births are monotonic, so the unborn characters are exactly the newest
    // `unborn`, and the revealed front is the character just before them.
    const unborn = Math.min(recorded, this.unbornCount(t));
    const lead = unborn < recorded ? this.birthOf(unborn) : null;
    // Stable identity of the revealed front: the wisp's texture is seeded from
    // it, so appending text (which moves `serial`) never reshuffles the wisp.
    const leadSeed = this.serial - 1 - unborn;
    const parts: string[] = [];
    let state: SgrState = EMPTY_SGR;
    let col = 0;
    let idx = 0;
    let animating = false;
    let front: Front | null = null;
    for (const s of segs) {
      if (s.kind === 'raw') {
        if (isSgr(s.text)) state = applySgr(state, s.text);
        parts.push(s.text);
        continue;
      }
      if (s.ws) {
        if (s.text.includes('\n')) {
          if (front && front.lineWidth === null) front.lineWidth = col;
          col = 0;
        } else col += stringWidth(s.text);
        parts.push(s.text);
        continue;
      }
      const d = visible - 1 - idx;
      const hit = d >= recorded ? null : this.birthOf(d);
      idx++;
      const w = stringWidth(s.text);
      col += w;
      if (hit === null) {
        parts.push(s.text);
        continue;
      }
      const age = t - hit.birth;
      const seed = this.serial - 1 - d;
      let cell: string | null;
      if (age < 0) cell = this.reservedCell(unborn - d, w, lead, t, leadSeed);
      else if (hit.style === 'ink') cell = inkCell(s.text, age, state, d - unborn);
      else cell = smokeCell(s.text, age, seed, state);
      parts.push(cell ?? s.text);
      if (cell !== null) animating = true;
      if (d === 0 && age >= 0) front = { birth: hit.birth, style: hit.style, state, at: parts.length, lineWidth: null };
    }
    if (front && front.lineWidth === null) front.lineWidth = col;
    if (this.insertWisp(parts, front, t, opts.maxWidth)) animating = true;
    if (animating) this.armTick();
    return animating ? parts.join('') + RESET : formatted;
  }

  /** Text just left the FRONT of the overlay (a block commit). */
  noteCommit(): void {
    this.lastVisible = null;
  }

  /** Forget all history (e.g. the pending buffer was discarded). */
  reset(): void {
    this.bursts = [];
    this.nextBirth = 0;
    this.lines.reset();
    this.lastVisible = null;
    this.sinceApply = 0;
    this.clearTick();
  }

  /** Stop the settle driver and clear all history. Safe to call repeatedly. */
  dispose(): void {
    this.reset();
  }

  /**
   * A not-yet-born cell `k` positions ahead of the revealed front: blank, or
   * a wisp particle when the front is smoke. Always exactly `width` columns.
   */
  private reservedCell(k: number, width: number, lead: { birth: number; style: RevealStyle } | null, t: number, seed: number): string {
    const blank = ' '.repeat(Math.max(1, width));
    if (!lead || lead.style !== 'smoke' || width !== 1) return blank;
    const wisp = wispCell(k, t - lead.birth, t, seed);
    return wisp ? wisp + RESET : blank;
  }

  /** How many of the newest recorded characters are not yet born at `t`. */
  private unbornCount(t: number): number {
    let n = 0;
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      if (!b) continue;
      if (b.start > t) {
        n += b.count;
        continue;
      }
      if (b.end > t && b.count > 1) {
        const step = (b.end - b.start) / (b.count - 1);
        const born = Math.min(b.count, Math.floor((t - b.start) / step) + 1);
        n += b.count - born;
      }
      break;
    }
    return n;
  }

  /** Splice the drifting wisp after a smoke front at the very end of the text, when the line has room. */
  private insertWisp(parts: string[], front: Front | null, t: number, maxWidth: number | undefined): boolean {
    if (!front || front.style !== 'smoke' || maxWidth === undefined) return false;
    if ((front.lineWidth ?? 0) + WISP_CELLS > maxWidth) return false;
    const wisp = wispCells(t - front.birth, t, this.serial - 1);
    if (!wisp) return false;
    parts.splice(front.at, 0, wisp + serializeSgr(front.state));
    return true;
  }

  /**
   * Trim raw-count excess (formatter-consumed syntax) from the newest bursts
   * so their total matches how much the formatted text actually grew. See the
   * "raw vs formatted counts" invariant in the module header.
   */
  private reconcile(visible: number): void {
    const grown = this.lastVisible === null ? null : Math.max(0, visible - this.lastVisible);
    let excess = grown === null ? 0 : this.sinceApply - grown;
    this.lastVisible = visible;
    this.serial += this.sinceApply;
    this.sinceApply = 0;
    for (let i = this.bursts.length - 1; i >= 0 && excess > 0; i--) {
      const b = this.bursts[i];
      if (!b) continue;
      const take = Math.min(excess, b.count);
      b.count -= take;
      excess -= take;
      this.serial -= take;
      if (b.count === 0) this.bursts.splice(i, 1);
    }
  }

  /** Total characters across live (not yet pruned) bursts. */
  private recordedCount(): number {
    let n = 0;
    for (const b of this.bursts) n += b.count;
    return n;
  }

  /** Birth time and style of the character `d` positions from the end, or null if settled. */
  private birthOf(d: number): { birth: number; style: RevealStyle } | null {
    let rem = d;
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      if (!b) continue;
      if (rem < b.count) {
        if (b.count === 1) return { birth: b.start, style: b.style };
        const j = b.count - 1 - rem;
        return { birth: b.start + ((b.end - b.start) * j) / (b.count - 1), style: b.style };
      }
      rem -= b.count;
    }
    return null;
  }

  /**
   * Drop bursts whose every character has settled. They are oldest-first. A
   * smoke burst's wisp can outlive its letters by `WISP_MS`, but the wisp
   * only ever follows the NEWEST burst, which prune never touches while its
   * letters are live.
   */
  private prune(t: number): void {
    while (this.bursts.length > 0) {
      const b = this.bursts[0];
      if (!b) break;
      const life = b.style === 'ink' ? INK_MS : MAX_LIFETIME_MS;
      if (b.end + life > t) break;
      this.bursts.shift();
    }
  }

  private armTick(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.requestRepaint();
    }, FRAME_MS);
    this.timer.unref?.();
  }

  private clearTick(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/** Re-exported for tests that inspect a burst's settle time. */
export { lifetimeOf };
