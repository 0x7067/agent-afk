/**
 * TextPacer: releases streamed markdown into the renderer at a steady,
 * self-catching-up rate, so text flows in like writing instead of arriving
 * in whatever lumps the network produced (nothing for 200ms, then half a
 * paragraph at once).
 *
 * Rate: `max(floor, backlog / tau)`. When the model is slower than the floor
 * the queue stays empty and the pacer only smooths each chunk across its
 * frame. When the model is faster, the backlog/tau term takes over, so the
 * reveal never trails the model by more than about `tau`. A sudden large
 * chunk therefore drains fast and decelerates as it empties: a whoosh that
 * settles, never a wall of text and never a growing delay.
 *
 * Accent lines: a markdown heading line (outside code fences) is released at
 * a slower cadence and tagged `smoke`, so the mask can condense it out of
 * rolling smoke. Everything else is tagged `ink`.
 *
 * Invariant (paragraph hold): the renderer commits a block to scrollback the
 * moment the buffer holds `\n\n`, and committed text is written once, fully
 * styled, with no fade. Releasing that second newline immediately would
 * snap the paragraph's last letters solid mid-fade. So the pacer holds the
 * newline that completes a paragraph break until the last released letter
 * has (nearly) settled. The pause reads as a carriage return, and it is
 * bounded: the hold never exceeds one lifetime, and `drain()`/`finish()`
 * skip it.
 *
 * Invariant (drain before any other commit): queued text is logically
 * "already said". Every renderer path that commits or inspects the buffer
 * (`commitPending`, `stripPendingFrom`, `getPendingBuffer`) calls `drain()`
 * FIRST, so a tool row or notice can never be committed above prose the
 * model produced before it.
 *
 * Timers are deliberately NOT unref'd: `finish()` awaits the queue emptying,
 * and a one-shot process must not exit with text still queued. Both timers
 * stop the moment the queue is empty, and `dispose()` clears them.
 *
 * @module cli/text-pacer
 */

import { INK_MS, SMOKE_MS, type RevealStyle } from './smoke-reveal.cells.js';

/** Floor rate for prose, characters per second. */
export const PROSE_CPS = 150;
/** Prose catch-up time constant: the reveal trails the model by about this much at most. */
export const PROSE_TAU_MS = 250;
/** Floor rate for accent (heading) lines: slower, so the smoke has room to roll. */
export const ACCENT_CPS = 80;
/** Accent catch-up constant. Headings are short; this only matters for a fast model. */
export const ACCENT_TAU_MS = 450;
/** Catch-up constant once `finish()` has been requested. */
export const FINISH_TAU_MS = 50;
/** Release cadence, matching the renderer's repaint throttle. */
export const TICK_MS = 33;
/** How long to wait for enough of a line to tell whether it is a heading or fence. */
export const LOOKAHEAD_WAIT_MS = 90;
/** Longest `flush()` waits for the queue to flow out before draining the rest at once. */
export const FINISH_MAX_MS = 400;
/** Longest `flush()` then waits for the last letters to finish fading before committing them. */
export const FLUSH_SETTLE_MAX_MS = 240;
/** Share of the ink fade a paragraph break waits for before releasing. */
export const INK_HOLD_SHARE = 0.7;
/** Share of a smoke letter's life a paragraph break waits for (eased: ~97% condensed by then). */
export const SMOKE_HOLD_SHARE = 0.75;

export type ReleaseFn = (text: string, style: RevealStyle, staggerMs: number) => void;

export interface TextPacerOptions {
  /** Called with each released slice, in order. */
  onRelease: ReleaseFn;
  /**
   * Called once at the end of every timed tick, AFTER that tick's releases,
   * with whether anything was released. While text is queued the pacer is
   * the frame clock: the owner paints here when nothing was released (a
   * release already requested its own paint), so fades keep moving through
   * a paragraph hold without a second, racing timer.
   */
  onFrame?: (released: boolean) => void;
  /** Tag heading lines `smoke` (AFK_SMOKE_TEXT). When false every line is `ink`. */
  accent: boolean;
  now?: () => number;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^ {0,3}#{1,6}(\s|$)/;
/** A line start that could still become a heading or fence once more text arrives. */
const AMBIGUOUS_RE = /^ {0,3}(#{1,6}|`{1,2}|~{1,2})?$/;
const WS_RE = /^\s+$/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function firstGrapheme(s: string): string {
  for (const { segment } of graphemes.segment(s)) return segment;
  return '';
}

export class TextPacer {
  private queue = '';
  private timer: NodeJS.Timeout | null = null;
  private finishTimer: NodeJS.Timeout | null = null;
  private lastTick: number | null = null;
  /** Fractional release allowance carried between ticks. */
  private budget = 0;
  private prev = '';
  private inFence = false;
  /** Style of the current line; null = at a line start, not yet classified. */
  private lineStyle: RevealStyle | null = null;
  private lineWaitStart: number | null = null;
  private lastVisibleAt = -Infinity;
  private lastVisibleStyle: RevealStyle = 'ink';
  private finishing = false;
  private waiters: Array<() => void> = [];
  private readonly now: () => number;

  constructor(private readonly opts: TextPacerOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Queue raw markdown. The first slice is released immediately when idle. */
  enqueue(text: string): void {
    if (!text) return;
    this.queue += text;
    if (!this.timer) this.tick();
  }

  /** True while any text is still waiting to be released. */
  hasQueued(): boolean {
    return this.queue.length > 0;
  }

  /** Release everything now, synchronously, with no holds. */
  drain(): void {
    if (!this.queue) return;
    this.step(this.now(), Infinity, true);
    this.idleIfEmpty();
  }

  /**
   * Speed up and resolve once the queue is empty, or after `maxMs` (then
   * drain the remainder). Used at end of stream so the tail flows out
   * quickly instead of popping.
   */
  finish(maxMs: number): Promise<void> {
    if (!this.queue) return Promise.resolve();
    this.finishing = true;
    const done = new Promise<void>((resolve) => this.waiters.push(resolve));
    if (!this.finishTimer) {
      this.finishTimer = setTimeout(() => {
        this.finishTimer = null;
        this.drain();
      }, maxMs);
    }
    if (!this.timer) this.tick();
    return done;
  }

  /** Drop queued text and line state (the pending buffer was discarded or stripped). */
  discard(): void {
    this.queue = '';
    this.prev = '';
    this.inFence = false;
    this.lineStyle = null;
    this.lineWaitStart = null;
    this.idleIfEmpty();
  }

  dispose(): void {
    this.discard();
  }

  private tick(): void {
    const t = this.now();
    const dt = this.lastTick === null ? TICK_MS : Math.min(t - this.lastTick, 3 * TICK_MS);
    this.lastTick = t;
    // Invariant (frame order): release, THEN paint, inside one tick. A paint
    // timer racing the release timer would sometimes paint the previous
    // frame's text and push the new slice a whole frame late (a stutter).
    const released = this.step(t, dt, false);
    this.opts.onFrame?.(released);
    if (this.queue) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.tick();
      }, TICK_MS);
    } else this.idleIfEmpty();
  }

  private idleIfEmpty(): void {
    if (this.queue) return;
    if (this.timer) clearTimeout(this.timer);
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.timer = null;
    this.finishTimer = null;
    this.lastTick = null;
    this.budget = 0;
    this.finishing = false;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  /** Characters per second for `style` given the current backlog. */
  private rate(style: RevealStyle): number {
    const backlog = this.queue.length;
    const floor = style === 'smoke' ? ACCENT_CPS : PROSE_CPS;
    const tau = this.finishing ? FINISH_TAU_MS : style === 'smoke' ? ACCENT_TAU_MS : PROSE_TAU_MS;
    const r = Math.max(floor, (backlog * 1000) / tau);
    return this.finishing ? Math.max(r, floor * 3) : r;
  }

  /** Classify the line starting at the queue head. Returns null to wait for more text. */
  private classify(t: number, force: boolean): RevealStyle | null {
    const nl = this.queue.indexOf('\n');
    const head = nl === -1 ? this.queue : this.queue.slice(0, nl);
    if (nl === -1 && !force && AMBIGUOUS_RE.test(head)) {
      this.lineWaitStart ??= t;
      if (t - this.lineWaitStart < LOOKAHEAD_WAIT_MS && !this.finishing) return null;
    }
    this.lineWaitStart = null;
    if (FENCE_RE.test(head)) {
      this.inFence = !this.inFence;
      return 'ink';
    }
    if (this.inFence) return 'ink';
    return this.opts.accent && HEADING_RE.test(head) ? 'smoke' : 'ink';
  }

  /** True when releasing `g` now would complete a paragraph break before the last letters settle. */
  private mustHold(g: string, t: number, force: boolean): boolean {
    if (force || this.finishing || g !== '\n' || this.prev !== '\n' || this.inFence) return false;
    const settle = this.lastVisibleStyle === 'smoke' ? SMOKE_MS * SMOKE_HOLD_SHARE : INK_MS * INK_HOLD_SHARE;
    return t < this.lastVisibleAt + settle;
  }

  /**
   * Release up to `dt` ms worth of text (or everything when `force`), as
   * style-homogeneous slices. Returns whether anything was released.
   */
  private step(t: number, dt: number, force: boolean): boolean {
    const startLength = this.queue.length;
    let allowance = force ? Infinity : this.budget + (this.rate(this.lineStyle ?? 'ink') * dt) / 1000;
    let slice = '';
    let sliceStyle: RevealStyle = 'ink';
    let visible = 0;
    const staggerFor = (style: RevealStyle): number =>
      force ? 1 : Math.min(30, Math.max(1, 1000 / this.rate(style)));
    const emit = (): void => {
      if (!slice) return;
      this.opts.onRelease(slice, sliceStyle, staggerFor(sliceStyle));
      slice = '';
      visible = 0;
    };
    while (this.queue) {
      if (this.lineStyle === null) {
        const style = this.classify(t, force);
        if (style === null) break;
        this.lineStyle = style;
      }
      const g = firstGrapheme(this.queue);
      if (this.mustHold(g, t, force)) break;
      const isVisible = !WS_RE.test(g);
      if (isVisible && allowance < 1) break;
      if (this.lineStyle !== sliceStyle && slice) emit();
      sliceStyle = this.lineStyle;
      this.queue = this.queue.slice(g.length);
      slice += g;
      if (isVisible) {
        allowance -= 1;
        // Birth of this letter as the mask will stagger it; the paragraph
        // hold measures settling from here, even before the slice is emitted.
        this.lastVisibleAt = t + visible * staggerFor(sliceStyle);
        this.lastVisibleStyle = sliceStyle;
        visible++;
      }
      this.prev = g.slice(-1);
      if (g.includes('\n')) this.lineStyle = null;
    }
    emit();
    this.budget = force || !this.queue ? 0 : Math.min(1, Math.max(0, allowance));
    return this.queue.length !== startLength;
  }
}
