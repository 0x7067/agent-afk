/**
 * StreamingMarkdownRenderer + text reveal integration (AFK_INK_TEXT default,
 * AFK_SMOKE_TEXT heading accent).
 *
 * Pins the contracts the reveal must honor inside the renderer:
 *  1. Pacing: pushed text flows in at a steady rate, then the overlay settles
 *     to exactly the reveal-off render with NO further pushes.
 *  2. Prose uses the calm ink fade. Smoke particles only ever appear on
 *     heading lines, and only with AFK_SMOKE_TEXT=1.
 *  3. Committed blocks are never masked, and a paragraph break is held until
 *     the paragraph's last letters have settled (no mid-fade snap).
 *  4. Every path that commits or inspects the buffer sees ALL pushed text
 *     (drain-before-commit), so ordering against tool rows is preserved.
 *  5. With the reveal off, text appears the instant it is pushed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import chalk from 'chalk';
import { PassThrough } from 'node:stream';
import { StreamingMarkdownRenderer } from './markdown-stream.js';
import { SMOKE_GLYPHS } from './smoke-reveal.js';
import { resetSmokeToneCache } from './smoke-reveal.tones.js';

const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
const hasSmoke = (s: string): boolean => SMOKE_GLYPHS.some((g) => stripAnsi(s).includes(g));
/** A letter mid-ink-fade carries an RGB blend or the faint attribute. */
const hasInk = (s: string): boolean => /\u001b\[0(?:;\d+)*;(?:2|38;[\d;]+)m[^\s\u001b]/.test(s);
/** Long enough for any paced text in these tests to release and settle. */
const SETTLE_MS = 3_000;

function makeRenderer(opts: { reducedMotion?: boolean } = {}): { r: StreamingMarkdownRenderer; overlays: string[]; commits: string[] } {
  const overlays: string[] = [];
  const commits: string[] = [];
  const stub = {
    setOverlay: (t: string) => { overlays.push(t); },
    commitAbove: (t: string) => { commits.push(t); },
    arm: async () => {},
    disarm: () => {},
    getBuffer: () => ({ text: '', queued: false }),
    isArmed: () => true,
  };
  const out = new PassThrough();
  (out as unknown as { isTTY: boolean }).isTTY = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = new StreamingMarkdownRenderer({ out: out as any, compositor: stub as any, ...opts });
  return { r, overlays, commits };
}

/** flush() waits on the pacer's timers, so drive the fake clock while it runs. */
async function flushNow(r: StreamingMarkdownRenderer): Promise<void> {
  const done = r.flush();
  await vi.advanceTimersByTimeAsync(SETTLE_MS);
  await done;
}

/** The last overlay painted with the reveal fully off, for byte comparison. */
async function baselineFor(text: string): Promise<string | undefined> {
  vi.stubEnv('AFK_INK_TEXT', '0');
  vi.stubEnv('AFK_SMOKE_TEXT', '');
  const base = makeRenderer();
  base.r.push(text);
  await vi.advanceTimersByTimeAsync(100);
  const last = base.overlays.at(-1);
  base.r.dispose();
  vi.stubEnv('AFK_INK_TEXT', '');
  return last;
}

let savedLevel: typeof chalk.level;
beforeEach(() => {
  vi.useFakeTimers();
  savedLevel = chalk.level;
  chalk.level = 3;
  resetSmokeToneCache();
  vi.stubEnv('AFK_PLAIN_OUTPUT', '');
  // A developer's own AFK_REDUCED_MOTION=1 must not turn these tests off.
  vi.stubEnv('AFK_REDUCED_MOTION', '');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  chalk.level = savedLevel;
});

const TEXT = 'The quick **brown** fox jumps over the lazy dog and keeps running past the old stone barn';

describe('StreamingMarkdownRenderer text reveal: ink (default)', () => {
  it('paces a burst in, fades fresh letters, then settles to the reveal-off render on its own', async () => {
    const baseline = await baselineFor(TEXT);
    const { r, overlays } = makeRenderer();
    r.push(TEXT);
    await vi.advanceTimersByTimeAsync(0);
    const first = stripAnsi(overlays.at(-1) ?? '');
    expect(first, 'the first frame shows the start of the burst').toContain('The');
    expect(first, 'but not the whole burst at once').not.toContain('barn');

    await vi.advanceTimersByTimeAsync(100);
    expect(hasInk(overlays.at(-1) ?? ''), 'fresh letters are mid-fade').toBe(true);
    expect(overlays.some(hasSmoke), 'prose never draws smoke particles').toBe(false);

    const before = overlays.length;
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(overlays.length, 'the settle driver repaints on its own').toBeGreaterThan(before);
    expect(overlays.at(-1)).toBe(baseline);

    const settledCount = overlays.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(overlays.length, 'idle once settled').toBe(settledCount);
    await flushNow(r);
  });

  it('keeps prose ink-only even when AFK_SMOKE_TEXT=1', async () => {
    vi.stubEnv('AFK_SMOKE_TEXT', '1');
    const { r, overlays } = makeRenderer();
    r.push(TEXT);
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(33);
    expect(overlays.some(hasSmoke)).toBe(false);
    expect(overlays.some(hasInk)).toBe(true);
    await flushNow(r);
  });

  // Regression (PR #2232 review): record() counts RAW text, so syntax the
  // formatter consumes must not push the reveal window onto settled text.
  it.each([
    ['bold', ' then **bold** words'],
    ['inline code', ' then `code` words'],
    ['link', ' then [docs](https://example.com/x) words'],
  ])('never re-reveals settled text when new text carries %s syntax', async (_label, tail) => {
    const { r, overlays } = makeRenderer();
    const settled = 'alpha bravo charlie delta echo foxtrot';
    r.push(settled);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(stripAnsi(overlays.at(-1) ?? '')).toContain(settled);

    r.push(tail);
    await vi.advanceTimersByTimeAsync(40);
    const raw = overlays.at(-1) ?? '';
    expect(hasInk(raw), 'fresh tail should be mid-fade').toBe(true);
    const settledEnd = raw.indexOf('foxtrot') + 'foxtrot'.length;
    expect(settledEnd, 'settled prefix is painted verbatim, unstyled').toBeGreaterThan(7);
    expect(raw.slice(0, settledEnd)).not.toContain('\u001b');
    await flushNow(r);
  });

  it('holds a paragraph break until the paragraph has settled, then commits it unmasked', async () => {
    const { r, overlays, commits } = makeRenderer();
    r.push('First paragraph lands whole.\n\nSecond');
    await vi.advanceTimersByTimeAsync(0);
    expect(commits, 'not committed while its letters are still fading').toHaveLength(0);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(commits).toHaveLength(1);
    expect(stripAnsi(commits[0] ?? '')).toContain('First paragraph lands whole.');
    expect(commits[0]).not.toMatch(/\u001b\[0(?:;\d+)*;2m/);
    expect(stripAnsi(overlays.at(-1) ?? '')).toContain('Second');
    await flushNow(r);
    expect(commits).toHaveLength(2);
    expect(stripAnsi(commits[1] ?? '')).toContain('Second');
  });

  it('still reveals a fresh paragraph that arrives with a block commit', async () => {
    const { r, overlays } = makeRenderer();
    r.push('alpha bravo charlie delta echo foxtrot golf hotel');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    r.push('.\n\nSecond paragraph');
    // Past the paragraph hold, into the fresh paragraph's own fade.
    let saw = false;
    for (let i = 0; i < 20 && !saw; i++) {
      await vi.advanceTimersByTimeAsync(33);
      const o = overlays.at(-1) ?? '';
      saw = stripAnsi(o).includes('Sec') && hasInk(o);
    }
    expect(saw, 'post-commit text should be mid-fade').toBe(true);
    await flushNow(r);
  });

  it('commitPending() commits every pushed character, queued or not (drain before commit)', async () => {
    const { r, commits } = makeRenderer();
    r.push(TEXT);
    await vi.advanceTimersByTimeAsync(0);
    r.commitPending();
    expect(commits).toHaveLength(1);
    expect(stripAnsi(commits[0] ?? '')).toContain('barn');
    await flushNow(r);
  });

  it('getPendingBuffer() and hasEmitted() see queued text', async () => {
    const { r } = makeRenderer();
    r.push(TEXT);
    expect(r.hasEmitted()).toBe(true);
    expect(r.getPendingBuffer()).toBe(TEXT);
    await flushNow(r);
  });

  it('resets reveal history when the pending tail is stripped', async () => {
    const { r, overlays } = makeRenderer();
    const keep = 'alpha bravo charlie delta echo foxtrot';
    r.push(keep);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    r.push(' TAILSTRIP golf hotel india');
    await vi.advanceTimersByTimeAsync(5);
    const off = r.getPendingBuffer().indexOf(' TAILSTRIP');
    expect(r.stripPendingFrom(off)).toBe(true);
    r.push(' ');
    await vi.advanceTimersByTimeAsync(40);
    const frame = overlays.at(-1) ?? '';
    expect(stripAnsi(frame)).toContain(keep);
    expect(stripAnsi(frame)).not.toContain('TAILSTRIP');
    expect(hasInk(frame)).toBe(false);
    await flushNow(r);
  });

  it('discardPending() drops queued text too: it never paints after the discard', async () => {
    const { r, overlays } = makeRenderer();
    r.push('DISCARDME ' + 'lorem ipsum dolor sit amet '.repeat(6));
    await vi.advanceTimersByTimeAsync(0);
    r.discardPending();
    expect(overlays.at(-1)).toBe('');
    const n = overlays.length;
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(overlays.slice(n).some((o) => stripAnsi(o).includes('lorem'))).toBe(false);
    r.push('Brand new text after discard');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(stripAnsi(overlays.at(-1) ?? '')).toContain('Brand new text after discard');
    await flushNow(r);
  });

  it('flush() lets the tail flow out and commits all of it', async () => {
    const { r, commits } = makeRenderer();
    r.push(TEXT);
    await flushNow(r);
    expect(commits).toHaveLength(1);
    expect(stripAnsi(commits[0] ?? '')).toContain('barn');
  });

  it('flush() and dispose() stop the settle driver', async () => {
    const { r, overlays } = makeRenderer();
    r.push(TEXT);
    await vi.advanceTimersByTimeAsync(10);
    await flushNow(r);
    const n = overlays.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(overlays.slice(n).every((o) => !hasInk(o))).toBe(true);
    r.dispose();
  });

  it('shows text the instant it arrives with AFK_INK_TEXT=0', async () => {
    vi.stubEnv('AFK_INK_TEXT', '0');
    const { r, overlays } = makeRenderer();
    r.push(TEXT);
    await vi.advanceTimersByTimeAsync(5);
    expect(overlays.length).toBeGreaterThan(0);
    expect(overlays.every((o) => !hasInk(o) && !hasSmoke(o))).toBe(true);
    expect(stripAnsi(overlays.at(-1) ?? '')).toContain('barn');
    await r.flush();
  });

  it('skips code fences (they keep their dimmed live preview)', async () => {
    const { r, overlays } = makeRenderer();
    r.push('```ts\nconst answer = 42;\n');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(stripAnsi(overlays.at(-1) ?? '')).toContain('const answer = 42;');
    await flushNow(r);
  });

  it('skips the mask on a height-truncated render (its end is not the newest text)', async () => {
    const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    Object.defineProperty(process.stdout, 'rows', { value: 6, configurable: true });
    try {
      const long = Array.from({ length: 12 }, (_, i) => `line ${i} of a long paragraph`).join('\n');
      const baseline = await baselineFor(long);
      const { r, overlays } = makeRenderer();
      r.push(long);
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
      expect((baseline ?? '').split('\n').length, 'render must actually be truncated').toBe(4);
      expect(overlays.at(-1), 'truncated render must be unmasked').toBe(baseline);
      await flushNow(r);
    } finally {
      if (rowsDesc) Object.defineProperty(process.stdout, 'rows', rowsDesc);
      else delete (process.stdout as { rows?: number }).rows;
    }
  });

  it('stays off under AFK_REDUCED_MOTION=1', async () => {
    vi.stubEnv('AFK_SMOKE_TEXT', '1');
    vi.stubEnv('AFK_REDUCED_MOTION', '1');
    const { r, overlays } = makeRenderer();
    r.push(TEXT);
    await vi.advanceTimersByTimeAsync(5);
    expect(overlays.every((o) => !hasInk(o) && !hasSmoke(o))).toBe(true);
    expect(stripAnsi(overlays.at(-1) ?? '')).toContain('barn');
    await r.flush();
  });

  it('lets an explicit reducedMotion option override the environment either way', async () => {
    vi.stubEnv('AFK_REDUCED_MOTION', '1');
    const moving = makeRenderer({ reducedMotion: false });
    moving.r.push(TEXT);
    await vi.advanceTimersByTimeAsync(40);
    expect(moving.overlays.some(hasInk)).toBe(true);
    await flushNow(moving.r);

    vi.stubEnv('AFK_REDUCED_MOTION', '');
    const still = makeRenderer({ reducedMotion: true });
    still.r.push(TEXT);
    await vi.advanceTimersByTimeAsync(40);
    expect(still.overlays.every((o) => !hasInk(o))).toBe(true);
    await still.r.flush();
  });
});

describe('StreamingMarkdownRenderer text reveal: smoke accent (AFK_SMOKE_TEXT=1)', () => {
  it('condenses a heading out of smoke, then the body arrives as ink', async () => {
    vi.stubEnv('AFK_SMOKE_TEXT', '1');
    const { r, overlays } = makeRenderer();
    r.push('## The Lighthouse Keeper\nFor forty years the light kept burning.');
    const frames: string[] = [];
    for (let i = 0; i < 40; i++) {
      await vi.advanceTimersByTimeAsync(33);
      frames.push(overlays.at(-1) ?? '');
    }
    const headingSmoke = frames.some((f) => hasSmoke(f) && !stripAnsi(f).includes('forty'));
    expect(headingSmoke, 'the heading smokes before the body arrives').toBe(true);
    // Once body text is on screen, any smoke left is on the heading row only.
    for (const f of frames) {
      for (const line of stripAnsi(f).split('\n')) {
        if (line.includes('forty') || line.includes('burning')) expect(hasSmoke(line)).toBe(false);
      }
    }
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    const settled = stripAnsi(overlays.at(-1) ?? '');
    expect(hasSmoke(settled)).toBe(false);
    expect(settled).toContain('The Lighthouse Keeper');
    expect(settled).toContain('For forty years the light kept burning.');
    await flushNow(r);
  });

  it('does not smoke headings without AFK_SMOKE_TEXT', async () => {
    const { r, overlays } = makeRenderer();
    r.push('## Plain heading\nbody');
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(33);
    expect(overlays.some(hasSmoke)).toBe(false);
    await flushNow(r);
  });
});
