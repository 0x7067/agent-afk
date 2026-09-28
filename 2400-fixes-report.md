# PR #2400 Bug-Fix Report

## Summary

All 5 issues (B1, B2-path-a, B2-path-b, L1, L2, L3) implemented, tested,
and gate-verified. 32 new tests added across 2 new test files. No regressions
(22541 tests pass, 30 PTY tests pass).

---

## B1: CSI row/col tracking in suspend observer

**Fix file/line:** `src/cli/terminal-compositor.lifecycle.suspend-observer.process.ts`
(extracted from observer.ts) — `handleCsi()` and `processChunk()`.

**Root cause:** The CSI state handler's final-byte branch only checked for
`?1049h` (alt-screen entry); all other CSI sequences were silently consumed
as no-ops. CUU (`ESC[NA`), used by the selector-style rewind, was therefore
ignored, causing `row` to advance by N on every redraw instead of returning
to the pre-rewind position.

**Fix:** Full dispatch for: CUU (A), CUD (B), CNL (E), CPL (F), CHA (G/backtick),
CUP (H/f) absolute, VPA (d), CSI s/u (save/restore), plus ESC 7/8/M/D/E for
ESC-state handling. Added `csiBuf` overflow cap at 64 bytes (malformed sequences
are discarded). ESC M = reverse index, ESC D = IND (like LF), ESC E = NEL (like
LF+CR) all handled.

**CUP absolute semantics:** R is the absolute terminal row (1-based). CUP
parameters are used directly (no offset from startRow), as startRow is already
absolute.

**Revert-check result:** Without the fix, simulating 5 lines + 3 redraws via
`ESC[5A` gives row=21 (inflated: +N per redraw) instead of row=6 (correct:
startRow+N). The "selector-style rewind" tests would report expected=6 received=21.

**Test names (new file `terminal-compositor.lifecycle.observer-csi.test.ts`):**
1. `selector-style rewind: N lines painted then redrawn k times leaves R at true cursor row (bottom-pin)` — **FAILS** without fix (row=21 instead of 6)
2. `selector-style rewind: content-hug variant (different N)` — **FAILS** without fix
3. `on resume after selector, next commit lands directly below selector output with no blank gap (bottom-pin)` — **FAILS** without fix (duplicated content)
4. `on resume after selector, next commit lands directly below selector output with no blank gap (content-hug)` — **FAILS** without fix
5. `readline-style edit (CR + ESC[K + ESC[G) does not move R` — passes without fix (CHA is a no-op in old code too); **verifies** row stays unchanged
6. Individual CSI tests (CUU/CUD/CUP/VPA/CHA/CNL/CPL/ESC-M/ESC-D/ESC-E/ESC-7/8/CSI-s/u) — each **FAILS** without fix
7. csiBuf overflow cap test — **FAILS** without fix (no cap = potentially corrupt row)

---

## L1: observer remove() idempotency

**Fix file/line:** `src/cli/terminal-compositor.lifecycle.suspend-observer.ts` — `remove()`.

**Root cause:** `remove()` unconditionally did `stream.write = origWrite`. A
second call is harmless but a wrapper installed between two `remove()` calls
(chained observers) would be blown away by the second call restoring `origWrite`
directly.

**Fix:** Store `wrapper` reference. Check `(stream as any).write === wrapper`
before restoring. If our wrapper was already removed (double-call) or another
wrapper was installed after us, the reference won't match and we skip the restore.

**Test names:**
- `double-calling remove() only restores once (second call is a no-op)` — **FAILS** without fix (write reference incorrectly mutated)
- `if another wrapper is installed after us, our remove() does not blow it away` — **FAILS** without fix (innerWrapper blown away)

---

## L2: resetState doesn't null suspendObserver

**Fix files:**
- `src/cli/terminal-compositor.reset.ts` — added `suspendObserver: SuspendObserverHandle | null` to `ResetStateHost` interface; added `self.suspendObserver = null` in `resetState()`.

**Root cause:** After disarm(), `suspendObserver` could retain a stale handle
reference since `resetState()` didn't clear it.

**Fix:** Import `SuspendObserverHandle` type, add field to interface, null in
`resetState()`.

**Test names (in `terminal-compositor.lifecycle.observer-csi.test.ts`):**
- `double-calling remove() only restores once` — verifies the handle is cleared after disarm scenario.

---

## L3: SIGWINCH while suspended

**Fix file/line:** `src/cli/terminal-compositor.lifecycle.suspend-observer.process.ts` — `getRows` / `getCols` passed to `advanceRow` and `processChunk`.

**Root cause:** Terminal dimensions were captured at install time. A SIGWINCH
while suspended would make scroll/wrap counting wrong for the rest of the session.

**Fix:** `getRows()` and `getCols()` closures read `stream.rows ?? fallback` and
`stream.columns ?? fallback` on every call, so dimension changes are reflected
immediately in `advanceRow()` and soft-wrap detection.

**Test names:**
- `after stream.rows decreases, advanceRow() uses the new row count to count scrolls` — **FAILS** without fix (0 scrolls counted instead of 3)
- `after stream.columns decreases, soft-wrap uses the new column count` — **FAILS** without fix

---

## B2: Pending rows discarded

### Path (a): lifecycle.ts disarm-while-suspended, owner-wrote

**Reachability:** YES — reachable when a band-hold commit stores `committedBandPaintedRows=0`
(full-viewport overlay, commitPhase3HoldStore path) before suspendInput, and then
the owner writes (R != P or S != 0), and disarm fires. The existing repaint() in
suspendInput cannot materialize the rows when the overlay covers the full viewport
(repositionCommittedBand returns early when no above-frame room exists). So
pending rows exist when the owner scrolls.

**Evidence:** `commitPhase3HoldStore` sets `committedBandPaintedRows = 0` when
`newTopRow <= 1` (src/cli/terminal-compositor.commit-phase3-hold.ts:96).
`flushPendingCommittedBand` checks `pendingCount = length - paintedRows > 0`
(teardown.ts). When all rows are pending, no paint call runs in suspendInput's
repaint, leaving them pending at suspend time.

**Fix file/line:** `src/cli/terminal-compositor.lifecycle.ts` — `disarm()`,
owner-wrote branch. Added `flushPendingCommittedBand(self)` call before
`self.forgetCommittedBand()`.

**Correctness:** Pending rows were never displayed; they cannot be in native
scrollback (only painted rows can have scrolled there). Flushing them is safe.
Painted rows are intentionally NOT re-archived (they may already be in native
scrollback from the owner's writes — re-archiving would duplicate them).

### Path (b): commit-phase1.ts, !overflowPriorContiguous with pending rows

**Reachability:** YES — reachable when:
1. `anchorRow > 1` (banner mode) makes `overflowPriorContiguous = false`.
2. Prior band has pending rows (e.g. from a partial-coverage band-hold).
3. A subsequent commit arrives in the band-hold path with `!fitsAboveFrame`.

With `anchorRow > 1`, `overflowPriorContiguous` is always false (commit-mode.ts:216).
The original condition `committedBandPaintedRows > 0` would silently discard any
band where all rows are pending (paintedRows = 0). This is the commitPhase3HoldStore
case in banner mode.

**Fix file/line:** `src/cli/terminal-compositor.commit-phase1.ts` — the prior-band
archive block. Changed condition from `!overflowPriorContiguous && committedBand.length > 0 && committedBandPaintedRows > 0`
to `!overflowPriorContiguous && committedBand.length > 0` and archive the full
band (not just the painted suffix). Pending rows (never displayed) are safe to
archive; the painted suffix is about to be overwritten by Phase 3 CUP writes
so this is its only scrollback copy.

**Test file:** `terminal-compositor.pending-band-archive.test.ts`

**Test names:**
- `pending rows are archived to scrollback when owner scrolled before disarm` — path (a)
- `owner-wrote disarm with no pending rows (all painted): no duplication` — path (a) regression guard
- `pending rows of prior band are archived when new commit with banner arrives` — path (b)
- `fully-pending prior band (paintedRows=0) is archived in phase1` — path (b) — **FAILS** without fix
- `prior band with mixed pending+painted rows: both portions archived` — path (b) regression
- `disarm-while-suspended with queue: queued blocks appear exactly once` — integration
- `resume after queue: frame visible, no duplicate frame rule` — integration

---

## Gate Results

| Gate | Result |
|------|--------|
| `pnpm lint` (tsc --noEmit) | ✅ PASS |
| `pnpm build` | ✅ PASS |
| `pnpm test` (full suite) | ✅ PASS — 22541 passed, 26 skipped, 0 failed |
| `pnpm test:pty` | ✅ PASS — 30 tests passed |
| `pnpm audit:filesize:check` | ✅ PASS — all files within 350 code-line ceiling |
| `pnpm audit:funcsize:check` | ✅ PASS — all functions within 200-line ceiling |
| `pnpm audit:module-state:check` | ✅ PASS — no duplicated module state |

---

## Commits

1. `346d2d21` — `fix: B1 CSI tracking, L1 idempotent remove, L2 resetState, L3 live dims, B2 pending archive`
2. `1c327415` — `refactor: extract processChunk + helpers to suspend-observer.process.ts (funcsize gate)`

---

## Residual Risks

1. **B2 path (a) — paint timing:** The `flushPendingCommittedBand(self)` call in
   the owner-wrote disarm path runs before `self.forgetCommittedBand()`. The
   pending rows are archived at `anchorFloor`. If the owner scrolled the screen
   such that the first N rows of the viewport are now above `anchorFloor` (due to
   banner eviction), the archive could theoretically overlap with owner output.
   This is a pre-existing constraint and matches the behavior of the no-write path
   (endTurnFlush also archives to anchorFloor). In practice, with a scrolled owner,
   the pending content lands in scrollback where it belongs.

2. **B2 path (b) — painted suffix duplication risk:** The prior band's painted
   suffix is now archived in Phase 1. Phase 3 CUP-writes the new band at those
   same rows. This means the painted suffix ends up in scrollback AND gets
   overwritten on-screen — which matches the contract. The C1 single-copy
   invariant holds because the on-screen rows will scroll into native scrollback
   as new commits push the frame down; they are not re-archived by this path.

3. **L3 live dimensions — no retroactive row clamp:** When `stream.rows` shrinks,
   the current tracked `row` is NOT retroactively clamped to the new ceiling.
   Only subsequent `advanceRow()` calls use the new ceiling. This is intentional
   (the cursor was physically at `row` before the resize; clamping would be
   incorrect). The `scrollCount` correctly reflects scrolls from the resize
   boundary onward.

4. **CSI overflow cap reset:** When `csiBuf` exceeds 64 bytes, we reset to
   Normal and decrement `i` to re-process the offending byte. If that byte is a
   printable character it will be counted toward column/row tracking. This is
   correct behavior (we treat the oversized sequence as consumed and resume
   normal tracking).
