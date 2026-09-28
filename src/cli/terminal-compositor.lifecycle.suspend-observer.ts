/**
 * Suspend write observer — counted handoff for suspendInput/resumeInput.
 *
 * Installs a monkey-patch on a NodeJS.WriteStream's `write` method that
 * tracks cursor-row movement while the compositor is suspended. This lets
 * resumeInput know where the owner left the cursor (row R) and how many
 * screen-scroll events occurred (scroll count S), so the compositor can
 * decide whether the pre-suspend band geometry is still valid.
 *
 * Generalises the newline-counting pattern from
 * {@link ../../cli/commands/interactive/interactive.pty-setup.ts} to also
 * track soft-wraps, carriage-returns, and alt-screen entry/exit.
 *
 * Algorithm (per-chunk):
 *  • Ignore ANSI escape sequences entirely (state-machine skip).
 *  • \r      — reset visual column to 0.
 *  • \n      — advance cursor row; if row would exceed the terminal floor,
 *               increment the scroll counter instead (the screen scrolled).
 *  • Printable character — advance visual column by 1; if it reaches the
 *               terminal width, wrap: col ← 0, advance cursor row as above.
 *  • ESC[?1049h — enter alt-screen; suspend column/row tracking (writes to
 *               the alternate buffer do not affect the main cursor).
 *  • ESC[?1049l — leave alt-screen; resume tracking.
 *
 * Design constraints:
 *  • The patch is always removed in a paired call to {@link removeObserver}.
 *    Never leaks even if resumeInput or disarm is called out of order.
 *  • Read-only cursor-position queries are lock-free (no I/O).
 *  • Not re-entrant: a single suspended session owns one observer at a time.
 *    Re-entrancy guard is the `suspended` flag on LifecycleHost.
 */

/** State captured by the observer for resumeInput to act on. */
export interface SuspendObserverState {
  /** Cursor row at resume time (1-based). Equals P when no newlines were written. */
  readonly cursorRow: number;
  /** Number of full-screen scrolls that occurred while suspended. */
  readonly scrollCount: number;
}

/**
 * Handle returned by {@link installObserver}. Call {@link remove} exactly once
 * to uninstall the patch and collect final state.
 */
export interface SuspendObserverHandle {
  remove(): SuspendObserverState;
}

// Invariant (ESC state machine): the observer must parse ESC sequences to skip
// their bytes so that, e.g., CUP moves written by the owner's readline prompt
// do not accidentally contribute printable-character column counts.
const enum EscState {
  Normal = 0,
  Esc = 1,        // saw \x1b, waiting for '[' or letter
  Csi = 2,        // inside CSI \x1b[ ... waiting for final byte
  AltScreen = 3,  // inside ESC[?1049h alt-screen; ignore until ESC[?1049l
}

/**
 * Install a write observer on `stream`. The observer intercepts every
 * `stream.write(chunk, …)` call to track cursor-row movement.
 *
 * @param stream  The WriteStream to observe (compositor's stdout).
 * @param startRow The 1-based cursor row immediately after the frame was
 *                  cleared (P = lastMeasuredFrameTop). Tracking begins here.
 * @param terminalRows  Number of terminal rows (stdout.rows); used to detect
 *                  scrolls when the cursor would advance past the last row.
 * @param terminalCols  Number of terminal columns (stdout.columns); used to
 *                  detect soft-wraps.
 */
export function installObserver(
  stream: NodeJS.WriteStream,
  startRow: number,
  terminalRows: number,
  terminalCols: number,
): SuspendObserverHandle {
  // Contract: startRow is 1-based and clamped to [1, terminalRows].
  let row = Math.max(1, Math.min(startRow, terminalRows));
  let col = 0; // 0-based visual column
  let scrolls = 0;
  let state: EscState = EscState.Normal;
  // Buffer to accumulate CSI parameter / intermediate bytes for pattern matching.
  let csiBuf = '';

  /** Advance cursor row by 1. If row exceeds the terminal bottom, scroll. */
  const advanceRow = (): void => {
    if (row < terminalRows) {
      row++;
    } else {
      scrolls++;
      // row stays at terminalRows (screen scrolled, cursor stays at floor)
    }
  };

  const processChunk = (chunk: unknown): void => {
    const s =
      typeof chunk === 'string'
        ? chunk
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk).toString('utf8')
          : String(chunk);

    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      const cp = s.charCodeAt(i);

      if (state === EscState.AltScreen) {
        // Invariant: once in alt-screen mode, we skip ALL bytes until we see
        // the ESC[?1049l leave-alt-screen sequence. This is safe to detect
        // inline because ESC[?1049l is a fixed 8-byte string.
        if (ch === '\x1b') {
          // Peek for [?1049l
          const rest = s.slice(i);
          if (rest.startsWith('\x1b[?1049l')) {
            state = EscState.Normal;
            i += '\x1b[?1049l'.length - 1; // -1 because loop adds 1
          }
        }
        continue;
      }

      if (state === EscState.Esc) {
        if (ch === '[') {
          state = EscState.Csi;
          csiBuf = '';
        } else {
          // Non-CSI ESC sequence (e.g. ESC M = reverse index); skip this byte.
          state = EscState.Normal;
        }
        continue;
      }

      if (state === EscState.Csi) {
        // Accumulate until we see a final byte (0x40–0x7E, i.e. '@' through '~').
        if (cp >= 0x40 && cp <= 0x7e) {
          // Final byte reached — classify the sequence.
          const full = csiBuf + ch; // e.g. '?1049h' for the alt-screen sequence
          if (full === '?1049h') {
            state = EscState.AltScreen;
          } else {
            state = EscState.Normal;
          }
          csiBuf = '';
        } else {
          csiBuf += ch;
        }
        continue;
      }

      // EscState.Normal
      if (ch === '\x1b') {
        state = EscState.Esc;
        continue;
      }
      if (ch === '\r') {
        col = 0;
        continue;
      }
      if (ch === '\n') {
        col = 0;
        advanceRow();
        continue;
      }
      // Other control characters (BEL, BS, TAB, etc.) — skip without counting.
      if (cp < 0x20 || cp === 0x7f) continue;

      // Printable character: advance column, soft-wrap if needed.
      col++;
      if (terminalCols > 0 && col >= terminalCols) {
        col = 0;
        advanceRow();
      }
    }
  };

  const origWrite = stream.write.bind(stream);

  // Contract (type-safe patch): stream.write has multiple overloads; we
  // satisfy them all by forwarding `...args` with explicit any cast. The
  // original write is called synchronously before our bookkeeping so the
  // VirtualScreen (in tests) sees writes in the same order the observer does.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (stream as any).write = (chunk: unknown, ...rest: unknown[]): boolean => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (origWrite as any)(chunk, ...rest) as boolean;
    processChunk(chunk);
    return result;
  };

  return {
    remove(): SuspendObserverState {
      // Restore original write (idempotent if called twice; second call is a no-op
      // because origWrite is already the original and re-assignment is harmless).
      stream.write = origWrite;
      return { cursorRow: row, scrollCount: scrolls };
    },
  };
}
