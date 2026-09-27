/**
 * Issue #2382 — a `commitAbove()` that lands while the compositor is
 * suspended (`suspendInput()`: elicitation `rl.question`, the /rewind
 * selector, editor spawn, transcript) must be shown exactly once after
 * `resumeInput()`, and the prior committed band must survive.
 *
 * Invariant under test: `suspendInput()` erases the live frame
 * (`logUpdate.clear()` + `done()`) and `repaint()` no-ops while suspended, so
 * during suspension the frame top is UNKNOWN. A commit in that window must
 * take the safe band-hold deferral (hold the block in the model) and
 * `resumeInput()`'s repaint must paint it, without tripping the geometry
 * guard (terminal-compositor.geometry-assert.ts, which throws under VITEST).
 *
 * Matrix: bottom-pin and content-hug (with slack below the frame, and after
 * hugSlack has reached 0), each with and without a pre-arm banner
 * (anchorRow > 1). Every case asserts, over scrollback + viewport:
 *   - every committed block appears exactly once, in commit order;
 *   - the committed run has no blank rows inside it and hugs the frame;
 *   - when committed content has reached scrollback, viewport row 1 is not
 *     blank (no void opened at the top of the viewport).
 *
 * Harness: VirtualScreen (synchronous ANSI interpreter), same as
 * terminal-compositor.tall-overlay-strand.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { TerminalCompositor } from './terminal-compositor.js';
import { VirtualScreen } from './_lib/testing/virtual-screen.js';

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
};

const COLS = 80;
const ROWS = 24;
const BANNER_ROWS = 6;
const FRAME_RE = /\u23af/;

function makeStdout(): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = true;
  s.columns = COLS;
  s.rows = ROWS;
  return s;
}

function makeStdin(): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = true;
  s.isRaw = false;
  s.setRawMode = vi.fn((raw: boolean) => {
    s.isRaw = raw;
    return s;
  });
  return s;
}

function attachScreen(stdout: MockStdout): VirtualScreen {
  const vs = new VirtualScreen(COLS, ROWS);
  stdout.on('data', (chunk: unknown) => {
    if (Buffer.isBuffer(chunk)) vs.write(chunk as Buffer);
    else if (typeof chunk === 'string') vs.write(Buffer.from(chunk, 'utf-8'));
  });
  return vs;
}

interface Scenario {
  name: string;
  contentHug: boolean;
  banner: boolean;
  /** One-line commits landed before the suspend scenario (drives hugSlack to 0). */
  fill: number;
}

const SCENARIOS: Scenario[] = [
  { name: 'bottom-pin, no banner', contentHug: false, banner: false, fill: 0 },
  { name: 'bottom-pin, banner', contentHug: false, banner: true, fill: 0 },
  { name: 'content-hug with slack, no banner', contentHug: true, banner: false, fill: 0 },
  { name: 'content-hug with slack, banner', contentHug: true, banner: true, fill: 0 },
  { name: 'content-hug hugSlack==0, no banner', contentHug: true, banner: false, fill: ROWS },
  { name: 'content-hug hugSlack==0, banner', contentHug: true, banner: true, fill: ROWS },
];

interface Rig {
  c: TerminalCompositor;
  vs: VirtualScreen;
  internals: { repaint(): void; hugSlackProbe(): number; frameTop(): number };
}

async function makeRig(s: Scenario): Promise<Rig> {
  const stdout = makeStdout();
  const vs = attachScreen(stdout);
  // A banner printed BEFORE arming, exactly like the interactive surface: the
  // compositor protects rows 1..anchorRow-1.
  if (s.banner) {
    for (let i = 0; i < BANNER_ROWS; i++) stdout.write(`BANNER_LINE_${i}\n`);
  }
  const c = new TerminalCompositor({
    stdout,
    stdin: makeStdin(),
    onCancel: vi.fn(),
    anchorRow: s.banner ? BANNER_ROWS + 1 : 1,
    ...(s.contentHug ? { contentHug: true } : {}),
  });
  await c.arm();
  const raw = c as unknown as {
    repaint(): void;
    lastMeasuredFrameTop: number;
    lastMeasuredFrameBottom: number;
    placementMode: string;
  };
  return {
    c,
    vs,
    internals: {
      repaint: () => raw.repaint(),
      // rows the hugging frame sits above the floor (absoluteBottom = ROWS-1).
      // 1-based viewport row of the live frame's top (spinner row included).
      frameTop: () => raw.lastMeasuredFrameTop,
      hugSlackProbe: () =>
        raw.placementMode === 'content-hug' ? Math.max(0, ROWS - 1 - raw.lastMeasuredFrameBottom) : 0,
    },
  };
}

function dumpScreen(vs: VirtualScreen): string {
  return [
    ...vs.scrollbackLines().map((l, i) => `[sb-${String(i).padStart(3)}] ${JSON.stringify(l)}`),
    ...vs.visibleLines().map((l, i) => `[vp-${String(i + 1).padStart(3)}] ${JSON.stringify(l)}`),
  ].join('\n');
}

function assertCommittedOnce(vs: VirtualScreen, frameTopRow: number, labels: string[], tag: string): void {
  const scrollback = vs.scrollbackLines();
  const visible = vs.visibleLines();
  const all = [...scrollback, ...visible];
  const dump = dumpScreen(vs);

  // The frame's top row is the measured frame top (the spinner row when the
  // spinner is live); the input rule must be at or below it.
  const frameVp = frameTopRow - 1;
  const ruleVp = visible.findIndex((l) => FRAME_RE.test(l));
  expect(ruleVp, `[${tag}] frame rule not found in viewport:\n${dump}`).toBeGreaterThanOrEqual(frameVp);
  expect(frameVp, `[${tag}] no measured frame top:\n${dump}`).toBeGreaterThanOrEqual(0);

  // (1) exactly once, in order (exact whole-line match: labels are left-aligned).
  const positions: number[] = [];
  for (const label of labels) {
    const hits = all.flatMap((l, i) => (l.trim() === label ? [i] : []));
    expect(hits.length, `[${tag}] "${label}" must appear exactly once (found ${hits.length}):\n${dump}`).toBe(1);
    positions.push(hits[0]!);
  }
  for (let i = 1; i < positions.length; i++) {
    expect(
      positions[i]! > positions[i - 1]!,
      `[${tag}] "${labels[i]}" must follow "${labels[i - 1]}":\n${dump}`,
    ).toBe(true);
  }

  // (2) the committed run is contiguous (one-line blocks, no separators) and
  // hugs the frame: the row right above the frame rule holds the last label.
  const first = positions[0]!;
  const last = positions[positions.length - 1]!;
  const gaps = all.slice(first, last + 1).filter((l) => l.trim() === '').length;
  expect(gaps, `[${tag}] ${gaps} blank rows inside the committed run:\n${dump}`).toBe(0);
  const frameAbs = scrollback.length + frameVp;
  const between = all.slice(last + 1, frameAbs).filter((l) => l.trim() !== '');
  expect(between, `[${tag}] non-committed rows between the run and the frame:\n${dump}`).toEqual([]);
  expect(frameAbs - last, `[${tag}] committed run does not hug the frame:\n${dump}`).toBeLessThanOrEqual(2);

  // (3) no void at the top of the viewport once committed content has
  // scrolled into history.
  if (first < scrollback.length) {
    expect(visible[0]!.trim(), `[${tag}] blank row 1 while content is in scrollback:\n${dump}`).not.toBe('');
  }
}

describe('commitAbove during suspendInput (issue #2382)', () => {
  for (const s of SCENARIOS) {
    it(`suspended commit is shown exactly once after resume — ${s.name}`, async () => {
      const { c, vs, internals } = await makeRig(s);
      c.setSpinner({ enabled: true });
      const labels: string[] = [];
      for (let i = 0; i < s.fill; i++) {
        const label = `FILL-${String(i).padStart(2, '0')}`;
        labels.push(label);
        c.commitAbove(`${label}\n`);
        internals.repaint();
      }
      c.commitAbove('BLOCK-A\n');
      c.commitAbove('BLOCK-B\n');
      labels.push('BLOCK-A', 'BLOCK-B');
      // Premise: the scenario really is in the mode it names.
      if (s.contentHug && s.fill === 0) expect(internals.hugSlackProbe()).toBeGreaterThan(0);
      if (s.contentHug && s.fill > 0) expect(internals.hugSlackProbe()).toBe(0);

      c.suspendInput();
      c.commitAbove('BLOCK-SUSPENDED\n');
      labels.push('BLOCK-SUSPENDED');
      c.resumeInput();
      c.commitAbove('BLOCK-C\n');
      labels.push('BLOCK-C');
      c.setSpinner({ enabled: false });
      internals.repaint();

      assertCommittedOnce(vs, internals.frameTop(), labels, s.name);
      c.disarm();
    }, 15_000);

    it(`suspended commit is visible on resume, before any later commit — ${s.name}`, async () => {
      const { c, vs, internals } = await makeRig(s);
      c.setSpinner({ enabled: true });
      const labels: string[] = [];
      for (let i = 0; i < s.fill; i++) {
        const label = `FILL-${String(i).padStart(2, '0')}`;
        labels.push(label);
        c.commitAbove(`${label}\n`);
        internals.repaint();
      }
      c.commitAbove('BLOCK-A\n');
      c.commitAbove('BLOCK-B\n');
      c.suspendInput();
      c.commitAbove('BLOCK-SUSPENDED\n');
      c.resumeInput();
      labels.push('BLOCK-A', 'BLOCK-B', 'BLOCK-SUSPENDED');

      assertCommittedOnce(vs, internals.frameTop(), labels, `${s.name} (on resume)`);
      c.disarm();
    }, 15_000);
  }
});
