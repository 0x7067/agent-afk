/**
 * Compositor-level regression for issue #2369 — tall-overlay gap fix
 * (`overlayTallEnoughToStrand` in commit-mode.ts).
 *
 * MUTATION-INSENSITIVITY FINDING (from the investigation for #2369):
 *
 * Forcing `overlayTallEnoughToStrand` to `false` fails exactly TWO
 * pure-function tests in commit-mode.test.ts (as the issue documents) but
 * DOES NOT change the compositor's observable output for any reachable
 * scenario. This is because `overlayTallEnoughToStrand` is effectively
 * redundant with the pre-existing `runExceedsCurrentRoom` guard added in
 * commit 4898a2c3 (#539, A2 — unified retained model).
 *
 * Why the two guards are equivalent in all reachable cases:
 *
 *   `overlayTallEnoughToStrand` fires when:
 *     fitsAboveFrame=true && room < maxBandModel
 *     (implies the overlay is taller than the collapsed-frame minimum)
 *
 *   `runExceedsCurrentRoom` fires when:
 *     overflowRun.length > room
 *
 *   For `overlayTallEnoughToStrand` to be the SOLE reason for band-hold
 *   (i.e., `runExceedsCurrentRoom=false`), we need:
 *     overflowRun.length <= room
 *
 *   When `overflowPriorContiguous=true` (requires `anchorRow <= 1`, which
 *   is the same gate `overlayTallEnoughToStrand` requires):
 *     overflowRun.length = committedBand.length + lineCount
 *     Phase-1 bandOverflow = max(0, committedBand.length + lineCount - room)
 *     bandOverflow > 0  iff  overflowRun.length > room  iff  runExceedsCurrentRoom
 *   So bandOverflow=0 whenever runExceedsCurrentRoom=false —
 *   Phase 1 scrolls NOTHING to scrollback in that case, making the
 *   fits-path and band-hold paths produce identical screen output.
 *
 *   When `overflowPriorContiguous=false` (requires `anchorRow > 1`):
 *     `overlayTallEnoughToStrand` requires `anchorRow <= 1` → it is false.
 *     The case is unreachable.
 *
 *   When `fitsAboveFrame=false` (BLOCKER-1 — first commit, overlay up):
 *     `overlayTallEnoughToStrand` requires `fitsAboveFrame=true` → it is false.
 *     The `!fitsAboveFrame && maxBandModel > 0` guard covers these commits.
 *
 *   Conclusion: `overlayTallEnoughToStrand` is defence-in-depth that
 *   documents intent but has no testable effect on compositor output
 *   given the current codebase. It was added (commit d30622fe) on the
 *   same day as the present branch, seemingly unaware that `runExceedsCurrentRoom`
 *   (added in commit 4898a2c3, ~10 weeks earlier) already covered the case.
 *
 * DELIVERABLE:
 *
 * Per the fallback clause of issue #2369 ("if no such scenario can be
 * constructed after a genuine attempt, document why the check is still
 * needed, or show it is dead and propose removal"), the present test file:
 *
 *   (I) Provides a compositor-level regression guard that verifies the
 *       core tall-overlay invariants (no stranding void, no lost rows)
 *       hold in both bottom-pin and content-hug-after-hugSlack-0 modes.
 *       These tests PASS both with the check on AND with it forced off —
 *       that is the correct outcome given the above analysis.
 *
 *   (II) Documents the mutation-insensitivity finding and proposes that
 *        `overlayTallEnoughToStrand` may be a candidate for removal in a
 *        future cleanup pass (the check carries no observable production
 *        benefit and adds cognitive load). Removal is NOT done here per
 *        the issue's explicit instruction ("do not remove the check
 *        yourself"). A tracking comment is added to commit-mode.ts.
 *
 * Uses VirtualScreen (repo-native synchronous ANSI interpreter) rather
 * than @xterm/headless because vi.useFakeTimers() stalls headless terminal
 * parse callbacks (resize-stale-width.repro.test.ts:243-244).
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { TerminalCompositor } from './terminal-compositor.js';
import { VirtualScreen } from './_lib/testing/virtual-screen.js';

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
};

// §
// Geometry constants — 24×80 terminal, anchorRow=1, extraRows=0:
//   absoluteBottom = 23, maxBandModel = 22.
//   OVERLAY_ROWS=12 overlay + spinner(1) + input(1) = 14-row tall frame:
//     frameTop ≈ 10, room ≈ 9.
//   room=9 < maxBandModel=22 → overlayTallEnoughToStrand condition.
//   runExceedsCurrentRoom fires at overflowRun.length > 9 (commit 10+).
//
//   KEY: for commits 2–9 (run fits in room), both fits-path and band-hold
//   produce identical screen output (bandOverflow=0 → Phase 1 emits no LFs;
//   Phase 3-band and Phase 3-hold both CUP-paint the same rows).
//   See MUTATION-INSENSITIVITY FINDING in the file header.
// §
const COLS = 80;
const ROWS = 24;
const OVERLAY_ROWS = 12;

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

/** Attach a VirtualScreen to stdout and return it. */
function attachScreen(stdout: MockStdout): VirtualScreen {
  const vs = new VirtualScreen(COLS, ROWS);
  stdout.on('data', (chunk: unknown) => {
    if (Buffer.isBuffer(chunk)) vs.write(chunk as Buffer);
    else if (typeof chunk === 'string') vs.write(Buffer.from(chunk, 'utf-8'));
  });
  return vs;
}

/** A tall slash-autocomplete-style overlay (realistic content). */
const TALL_OVERLAY = Array.from(
  { length: OVERLAY_ROWS },
  (_, i) => `  /some-command-option-${String(i).padStart(2, '0')}`,
).join('\n');

// ---------------------------------------------------------------------------
// Core assertion helper — shared by both scenarios
// ---------------------------------------------------------------------------

function assertNoVoid(
  vs: VirtualScreen,
  labels: string[],
  tag: string,
): void {
  const visible = vs.visibleLines();
  const allLines = [...vs.scrollbackLines(), ...visible];
  const dump = [
    ...vs.scrollbackLines().map((l, i) => `[sb-${String(i).padStart(3)}] ${JSON.stringify(l)}`),
    ...visible.map((l, i) => `[vp-${String(i + 1).padStart(3)}] ${JSON.stringify(l)}`),
  ].join('\n');

  const FRAME_RE = /\u23af/;
  const frameVpIdx = visible.findIndex((l) => FRAME_RE.test(l));
  expect(frameVpIdx, `[${tag}] frame (⎯) not found in viewport:\n${dump}`).toBeGreaterThanOrEqual(0);

  // (a) No large blank void at the top of the above-frame region.
  //
  // NOTE ON MUTATION INSENSITIVITY: this assertion uses ≤2 (not ≤1) because
  // the compositor's bottom-aligned band placement naturally leaves blank rows
  // above a short band. Both with overlayTallEnoughToStrand ON and with it
  // forced OFF the output is identical — see the MUTATION-INSENSITIVITY FINDING
  // in the file header. The real stranding void (which overlayTallEnoughToStrand
  // targets conceptually) would only appear if Phase-1 archived band rows to
  // native scrollback while the overlay was tall, but runExceedsCurrentRoom
  // already prevents that. For small commit counts (run ≤ room=9) Phase-1
  // bandOverflow=0 regardless of the check, making both paths equivalent.
  //
  // With MANY commits (> room rows), runExceedsCurrentRoom fires and the
  // band grows well past the room=9 capacity, eventually filling most of
  // maxBandModel=22. The band is bottom-aligned, so the visible above-frame
  // region has blank rows at the top proportional to (maxBandModel - bandLen).
  // With 16 commits: 22 - 16 = 6 blank rows at top. This is EXPECTED
  // behavior and does NOT represent a stranding void.
  //
  // The stranding void (which overlayTallEnoughToStrand targets conceptually)
  // would manifest as a MUCH larger blank run: if the fits-path archived rows
  // to scrollback at room=9 capacity and on collapse only 9 rows repinned,
  // the gap would be 22-9=13 blank rows at top. But runExceedsCurrentRoom
  // already prevents that scenario — and overlayTallEnoughToStrand is
  // equivalently covered for the remaining early-commit range (see finding).
  //
  // Assertion: the top-blank-run is bounded by maxBandModel - committedLabels.
  // 16 labels → expectedBlanks = 22 - 16 = 6. Tolerate ≤ 7 (one extra row
  // of rhythm-separator slack).
  const aboveFrame = visible.slice(0, frameVpIdx);
  let leadingBlanks = 0;
  for (const l of aboveFrame) {
    if (l.trim() === '') leadingBlanks++;
    else break;
  }
  const expectedMaxBlanks = Math.max(0, 22 - labels.length) + 1; // +1 rhythm slack
  expect(
    leadingBlanks,
    `[${tag}] leading blank rows (${leadingBlanks}) exceed expected max (${expectedMaxBlanks} = maxBandModel - ${labels.length} labels + 1): ` +
      `this indicates rows were stranded in scrollback and the band is thinner than expected:\n${dump}`,
  ).toBeLessThanOrEqual(expectedMaxBlanks);

  // (b) Every strand commit label appears exactly once across scrollback + viewport.
  for (const label of labels) {
    const hits = allLines.filter((l) => l.includes(label)).length;
    expect(hits, `[${tag}] "${label}" must appear exactly once (found ${hits}):\n${dump}`).toBe(1);
  }

  // (c) No duplicate labels (belt-and-suspenders — caught by (b), shown separately).
  const dupLabels = labels.filter(
    (label) => allLines.filter((l) => l.includes(label)).length > 1,
  );
  expect(
    dupLabels.length,
    `[${tag}] duplicate labels found: ${dupLabels.join(', ')}:\n${dump}`,
  ).toBe(0);
}

// ---------------------------------------------------------------------------
// Scenario I — bottom-pin mode (anchorRow=1, no contentHug)
//
// §
// Setup: arm() with anchorRow=1, spinner enabled.
//   First commit → BLOCKER-1 guard (prevTopRow<=1 on cold start) →
//   band-hold. Subsequent commits see prevTopRow = committedBandBottomRow+1 ≈ 10.
//   overlayTallEnoughToStrand fires for commits 2–9 (run ≤ room=9) but is
//   equivalent to fits-path (bandOverflow=0). Commits 10+ hit
//   runExceedsCurrentRoom (run > room=9) → band-hold in either case.
//   Collapse: band (16 rows) repins bottom-aligned; all rows present.
// §
// ---------------------------------------------------------------------------

describe('tall-overlay strand gap — compositor regression (issue #2369)', () => {
  it(
    '(I) bottom-pin: 16 commits under tall overlay → full band present on collapse, no missing rows',
    async () => {
      const stdout = makeStdout();
      const vs = attachScreen(stdout);
      const c = new TerminalCompositor({
        stdout,
        stdin: makeStdin(),
        onCancel: vi.fn(),
        anchorRow: 1,
      });
      await c.arm();
      c.setSpinner({ enabled: true });
      const internals = c as unknown as { repaint(): void };

      // 16 commits under the tall overlay:
      // - commit 1: BLOCKER-1 (prevTopRow<=1) → band-hold via !fitsAboveFrame
      // - commits 2–9: overlayTallEnoughToStrand fires; equivalent to fits-path
      //                (bandOverflow=0 in both cases, see finding above)
      // - commits 10–16: runExceedsCurrentRoom fires → band-hold
      const strandLabels: string[] = [];
      for (let k = 0; k < 16; k++) {
        const label = `STRAND-BP-${String(k).padStart(2, '0')}`;
        strandLabels.push(label);
        c.setOverlay(TALL_OVERLAY);
        c.commitAbove(`${label}\n`);
        internals.repaint();
      }

      // Collapse: overlay clears, spinner stops, frame shrinks.
      c.setOverlay('');
      c.setSpinner({ enabled: false });
      internals.repaint();
      internals.repaint();

      assertNoVoid(vs, strandLabels, 'bottom-pin');
      c.disarm();
    },
    15_000,
  );

  // --------------------------------------------------------------------------
  // Scenario II — content-hug mode after hugSlack reaches 0
  //
  // §
  // Setup: arm() with anchorRow=1, contentHug=true.
  //   Phase 1: fill viewport (ROWS-3=21 commits) until hugSlack→0.
  //   Phase 2: same tall-overlay strand commits as Scenario I.
  //   The overlayTallEnoughToStrand exclusion (!hugSlack) ensures the
  //   check is SKIPPED while hugSlack>0 and fires once hugSlack=0 —
  //   but as documented above, the check is equivalent to runExceedsCurrentRoom
  //   for all reachable scenarios.
  // §
  // --------------------------------------------------------------------------

  it(
    '(II) content-hug + hugSlack==0: 16 commits under tall overlay → full band on collapse, no missing rows',
    async () => {
      const stdout = makeStdout();
      const vs = attachScreen(stdout);
      const c = new TerminalCompositor({
        stdout,
        stdin: makeStdin(),
        onCancel: vi.fn(),
        anchorRow: 1,
        contentHug: true,
      });
      await c.arm();
      c.setSpinner({ enabled: true });
      const internals = c as unknown as { repaint(): void };

      // Phase 1: fill the viewport so hugSlack reaches 0 (frame bottom-pins).
      const fillCount = ROWS - 3; // 21 commits → guaranteed bottom-pin
      for (let i = 0; i < fillCount; i++) {
        c.commitAbove(`FILL-${String(i).padStart(4, '0')}\n`);
        internals.repaint();
      }

      // Phase 2: tall overlay across 16 strand commits (hugSlack==0 by now).
      const strandLabels: string[] = [];
      for (let k = 0; k < 16; k++) {
        const label = `STRAND-HUG-${String(k).padStart(2, '0')}`;
        strandLabels.push(label);
        c.setOverlay(TALL_OVERLAY);
        c.commitAbove(`${label}\n`);
        internals.repaint();
      }

      // Collapse.
      c.setOverlay('');
      c.setSpinner({ enabled: false });
      internals.repaint();
      internals.repaint();

      assertNoVoid(vs, strandLabels, 'content-hug');
      c.disarm();
    },
    15_000,
  );
});
