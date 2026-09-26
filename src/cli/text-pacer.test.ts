import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TextPacer,
  PROSE_CPS,
  PROSE_TAU_MS,
  ACCENT_CPS,
  TICK_MS,
  LOOKAHEAD_WAIT_MS,
  INK_HOLD_SHARE,
} from './text-pacer.js';
import { INK_MS, SMOKE_MS, type RevealStyle } from './smoke-reveal.cells.js';

interface Release { text: string; style: RevealStyle; at: number }

function makePacer(accent = false): { p: TextPacer; out: Release[]; text: () => string } {
  const out: Release[] = [];
  const p = new TextPacer({
    accent,
    onRelease: (text, style) => { out.push({ text, style, at: Date.now() }); },
  });
  return { p, out, text: () => out.map((r) => r.text).join('') };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('TextPacer', () => {
  it('releases the first slice immediately, then flows at the prose floor rate', async () => {
    const { p, out, text } = makePacer();
    const src = 'abcdefghij'.repeat(3); // 30 visible chars, below the catch-up threshold
    p.enqueue(src);
    expect(out.length, 'leading-edge release, no wait').toBeGreaterThan(0);
    const first = text().length;
    expect(first).toBeLessThan(src.length);
    await vi.advanceTimersByTimeAsync(100);
    const after = text().length;
    // ~100ms at >= PROSE_CPS; never all 30 characters in 100ms from 30 queued at this rate.
    expect(after).toBeGreaterThanOrEqual(first + Math.floor((PROSE_CPS * 100) / 1000) - 2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(text()).toBe(src);
    expect(p.hasQueued()).toBe(false);
  });

  it('catches up on a large burst: never trails by much more than tau', async () => {
    const { p, text } = makePacer();
    const src = 'word '.repeat(200); // 1000 chars, far above the floor rate
    p.enqueue(src);
    await vi.advanceTimersByTimeAsync(PROSE_TAU_MS * 6);
    expect(text().length / src.length).toBeGreaterThan(0.97);
    await vi.advanceTimersByTimeAsync(500);
    expect(text()).toBe(src);
  });

  it('decelerates as a burst drains (a whoosh that settles, not a constant wall)', async () => {
    const { p, text } = makePacer();
    p.enqueue('x'.repeat(600));
    const sizes: number[] = [];
    let last = text().length;
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(TICK_MS);
      const now = text().length;
      sizes.push(now - last);
      last = now;
    }
    expect(sizes[0]).toBeGreaterThan(sizes[5] ?? 0);
  });

  it('tags heading lines smoke (slower) only when accent is on, and never inside a fence', async () => {
    const { p, out } = makePacer(true);
    p.enqueue('## Title here\nbody text\n```\n# not a heading\n```\n');
    await vi.advanceTimersByTimeAsync(3_000);
    const smoke = out.filter((r) => r.style === 'smoke').map((r) => r.text).join('');
    expect(smoke).toContain('Title here');
    expect(smoke).not.toContain('body');
    expect(smoke).not.toContain('not a heading');

    const plain = makePacer(false);
    plain.p.enqueue('## Title here\nbody');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(plain.out.every((r) => r.style === 'ink')).toBe(true);
  });

  it('releases an accent line at the slower accent cadence', async () => {
    const { p, out } = makePacer(true);
    p.enqueue('## ' + 'h'.repeat(40));
    await vi.advanceTimersByTimeAsync(250);
    const released = out.filter((r) => r.style === 'smoke').map((r) => r.text).join('').replace(/[#\s]/g, '').length;
    // Well under what prose would have released in the same time.
    expect(released).toBeLessThan((PROSE_CPS * 250) / 1000);
    expect(released).toBeGreaterThanOrEqual(Math.floor((ACCENT_CPS * 250) / 1000) - 2);
  });

  it('waits briefly for enough of a line start to classify it, then gives up', async () => {
    const { p, out } = makePacer(true);
    p.enqueue('#');
    expect(out).toHaveLength(0);
    p.enqueue('# Heading');
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(out.map((r) => r.style)).toContain('smoke');

    const lone = makePacer(true);
    lone.p.enqueue('#');
    await vi.advanceTimersByTimeAsync(LOOKAHEAD_WAIT_MS + TICK_MS * 2);
    expect(lone.out.map((r) => r.text).join('')).toBe('#');
  });

  it('holds the newline that completes a paragraph break until the last letter settles', async () => {
    const { p, out, text } = makePacer();
    p.enqueue('Done.\n\nNext');
    const heldAt = Date.now();
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(text()).toBe('Done.\n');
    await vi.advanceTimersByTimeAsync(INK_MS * INK_HOLD_SHARE + TICK_MS * 2);
    expect(text()).toContain('Done.\n\n');
    const breakRelease = out.find((r) => r.text.startsWith('\n') && r.at > heldAt);
    expect((breakRelease?.at ?? 0) - heldAt).toBeGreaterThanOrEqual(INK_MS * INK_HOLD_SHARE - TICK_MS);
    await vi.advanceTimersByTimeAsync(500);
    expect(text()).toBe('Done.\n\nNext');
  });

  it('holds longer after a smoke heading: the heading fully condenses first', async () => {
    const { p, text } = makePacer(true);
    p.enqueue('# Hi\n\nbody');
    await vi.advanceTimersByTimeAsync(INK_MS);
    expect(text()).not.toContain('body');
    await vi.advanceTimersByTimeAsync(SMOKE_MS + 200);
    expect(text()).toBe('# Hi\n\nbody');
  });

  it('drain() releases everything synchronously with no hold', () => {
    const { p, text } = makePacer(true);
    p.enqueue('# A\n\nlong body '.repeat(10));
    p.drain();
    expect(text()).toBe('# A\n\nlong body '.repeat(10));
    expect(p.hasQueued()).toBe(false);
  });

  it('finish() speeds up and resolves once empty; its deadline drains the rest', async () => {
    const { p, text } = makePacer();
    p.enqueue('z'.repeat(400));
    let done = false;
    void p.finish(400).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(300);
    expect(done).toBe(true);
    expect(text()).toBe('z'.repeat(400));

    const slow = makePacer();
    slow.p.enqueue('q'.repeat(5_000));
    let slowDone = false;
    void slow.p.finish(50).then(() => { slowDone = true; });
    await vi.advanceTimersByTimeAsync(60);
    expect(slowDone).toBe(true);
    expect(slow.text()).toBe('q'.repeat(5_000));
  });

  it('discard() drops queued text and stops releasing', async () => {
    const { p, text } = makePacer();
    p.enqueue('keep? '.repeat(40));
    const before = text();
    p.discard();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(text()).toBe(before);
    expect(p.hasQueued()).toBe(false);
  });

  it('never splits a grapheme cluster across slices', async () => {
    const { p, out } = makePacer();
    const family = '\u{1F469}\u200D\u{1F4BB}';
    p.enqueue((family + ' ').repeat(30));
    await vi.advanceTimersByTimeAsync(2_000);
    for (const r of out) {
      expect(r.text.startsWith('\u200D')).toBe(false);
      expect(r.text.endsWith('\u200D')).toBe(false);
    }
  });
});
