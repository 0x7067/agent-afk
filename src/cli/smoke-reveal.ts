/**
 * Text reveal mask: streamed characters arrive softly instead of popping in.
 *
 * Two styles share one mask (see smoke-reveal.cells.ts for the look):
 *  - `ink` (the default for prose): a letter rises from just above the
 *    background into its OWN color over `INK_MS`, like ink drying. It never
 *    passes through a brighter tone than it settles on. On by default;
 *    `AFK_INK_TEXT=0` turns it off.
 *  - `smoke` (the accent, opt-in via `AFK_SMOKE_TEXT=1`): a letter condenses
 *    out of braille particles, and a thin wisp drifts ahead of the front.
 *    The renderer uses it for headings only, so it stays a moment.
 *
 * How it works:
 *  - `record(chunk, opts)` runs when raw markdown enters the pipeline. Each
 *    burst gets staggered birth times and a style. In the renderer the
 *    chunks come from `TextPacer`, which already releases text at a steady
 *    rate, so bursts are small and the stagger spreads each one across its
 *    frame. Births are monotonic and never trail arrival by more than
 *    `MAX_LAG_MS`.
 *  - `apply(formatted, opts)` runs on the formatted pending overlay string
 *    just before it is painted. It walks the visible characters, tracking the
 *    active SGR style, and restyles the youngest ones by age.
 *
 * Invariant (age mapping by distance-from-end): ages are keyed by how far a
 * character sits from the END of the text, counting non-whitespace grapheme
 * clusters only. New text always lands at the end, and a block commit only
 * removes text from the FRONT, so distance-from-end survives commits,
 * re-wrapping, indentation, and centering margins unchanged.
 *
 * Invariant (raw vs formatted counts): `record()` sees RAW markdown, but
 * `apply()` indexes the FORMATTED overlay, and the formatter consumes syntax
 * (`**`, backticks, `## `). Left unreconciled, every consumed syntax
 * character pushes the reveal window one cell onto text that has already
 * settled. So each `apply()` compares how much the formatted text actually
 * grew since the previous apply against how much raw text was recorded, and
 * trims the excess from the newest bursts. `noteCommit()` drops the baseline
 * whenever text leaves the FRONT of the overlay. The first frame after a
 * commit is left unreconciled, which is harmless: the excess lands on the
 * fresh paragraph's own young text.
 *
 * Invariant (settle driver): pending-overlay repaints are content-driven.
 * While any character is still settling, `apply()` arms ONE timer that calls
 * the owner's throttled `scheduleRepaint()`. There is no second paint path,
 * and the timer stops as soon as everything has settled.
 *
 * Contract: this module never delays a block commit. Committed blocks render
 * through `formatBlockForCommit`, untouched by the mask. (The pacer, not the
 * mask, holds a paragraph break until its last letters settle.)
 *
 * @module cli/smoke-reveal
 */

import chalk from 'chalk';
import stringWidth from 'string-width';
import { env, isPlainOutputRequested } from '../config/env.js';
import { isExplicitlyDisabled, isExplicitlyEnabled } from '../config/env-helpers.js';
import { countVisible, segmentAnsi } from './smoke-reveal.ansi.js';
import { SMOKE_GLYPH_LEVELS } from './smoke-reveal.frame.js';
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
  wispCells,
  type RevealStyle,
} from './smoke-reveal.cells.js';

export type { RevealStyle } from './smoke-reveal.cells.js';
export { INK_MS } from './smoke-reveal.cells.js';

/** Smoke-accent lifetime: first speck to fully settled letter. */
export const LIFETIME_MS = SMOKE_MS;
/** Fraction of the smoke lifetime spent as a particle before the letter shows. */
export const GLYPH_PHASE = SMOKE_GLYPH_PHASE;
/** Default spacing between characters revealed from one burst. */
export const STAGGER_MS = 6;
/** Upper bound on how far a reveal may trail the character's arrival. */
export const MAX_LAG_MS = 160;
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
  /** Reveal style for this burst. Default `smoke` (the historical behavior). */
  style?: RevealStyle;
  /** Spacing between this burst's characters. Default `STAGGER_MS`. */
  staggerMs?: number;
  /**
   * Stagger BACKWARD from now, so the newest character is born now and the
   * rest slightly earlier (never before the previous burst). For paced
   * slices: the pacer already chose the release moment, and a forward
   * stagger would paint the not-yet-born cells blank for a frame.
   */
  endAtNow?: boolean;
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
  state: SgrState;
  /** Index into the output parts just after the newest character. */
  at: number;
  /** Width of the newest character's line, filled in when the line ends. */
  lineWidth: number | null;
}

export class SmokeReveal {
  private bursts: Burst[] = [];
  private nextBirth = 0;
  private lastEnd = -Infinity;
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

  constructor(
    private readonly requestRepaint: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Register newly arrived raw text. Whitespace-only chunks are ignored. */
  record(chunk: string, opts: RecordOptions = {}): void {
    const count = countVisible(chunk);
    if (count === 0) return;
    const stagger = opts.staggerMs ?? STAGGER_MS;
    const t = this.now();
    let start: number;
    let end: number;
    if (opts.endAtNow) {
      end = Math.max(t, this.lastEnd);
      start = Math.min(end, Math.max(this.lastEnd, t - (count - 1) * stagger));
    } else {
      const cap = t + MAX_LAG_MS;
      start = Math.min(Math.max(t, this.nextBirth), cap);
      end = Math.min(start + (count - 1) * stagger, cap);
    }
    this.bursts.push({ start, end, count, style: opts.style ?? 'smoke' });
    this.lastEnd = end;
    this.nextBirth = end + stagger;
    this.sinceApply += count;
    this.prune(t);
  }

  /** Milliseconds until every live character has settled (0 when nothing is animating). */
  settleRemaining(): number {
    const t = this.now();
    let max = 0;
    for (const b of this.bursts) {
      const life = b.style === 'ink' ? INK_MS : MAX_LIFETIME_MS;
      max = Math.max(max, b.end + life - t);
    }
    return max;
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
      col += stringWidth(s.text);
      if (hit === null) {
        parts.push(s.text);
        continue;
      }
      const age = t - hit.birth;
      const seed = this.serial - 1 - d;
      // Not revealed yet: hold the cell blank so layout never shifts.
      const cell = age < 0
        ? ' '.repeat(Math.max(1, stringWidth(s.text)))
        : hit.style === 'ink' ? inkCell(s.text, age, state, d) : smokeCell(s.text, age, seed, state);
      parts.push(cell ?? s.text);
      if (cell !== null) animating = true;
      if (d === 0) front = { birth: hit.birth, style: hit.style, state, at: parts.length, lineWidth: null };
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
    this.lastEnd = -Infinity;
    this.lastVisible = null;
    this.sinceApply = 0;
    this.clearTick();
  }

  /** Stop the settle driver and clear all history. Safe to call repeatedly. */
  dispose(): void {
    this.reset();
  }

  /** Splice the drifting wisp after a smoke front, when the line has room. Returns true if drawn. */
  private insertWisp(parts: string[], front: Front | null, t: number, maxWidth: number | undefined): boolean {
    if (!front || front.style !== 'smoke' || maxWidth === undefined) return false;
    if ((front.lineWidth ?? 0) + WISP_CELLS > maxWidth) return false;
    const wisp = wispCells(t - front.birth, t, this.serial);
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
