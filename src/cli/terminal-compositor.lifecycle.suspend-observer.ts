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

// Invariant (csiBuf cap): malformed or very long CSI sequences (e.g. DCS
// passthrough incorrectly categorised as CSI) must not grow the buffer
// unboundedly. Any sequence whose parameter/intermediate section exceeds this
// limit is dropped (state reset to Normal without acting on the byte). 64 bytes
// is well above any real cursor-movement parameter (max ~3 decimal digits per
// coordinate) and well below any realistic DCS/passthrough payload.
const CSI_BUF_MAX = 64;

/**
 * Install a write observer on `stream`. The observer intercepts every
 * `stream.write(chunk, …)` call to track cursor-row movement.
 *
 * @param stream  The WriteStream to observe (compositor's stdout).
 * @param startRow The 1-based cursor row immediately after the frame was
 *                  cleared (P = lastMeasuredFrameTop). Tracking begins here.
 * @param terminalRows  Number of terminal rows (stdout.rows); used as fallback
 *                  when the stream's live rows are unavailable.
 * @param terminalCols  Number of terminal columns (stdout.columns); used as
 *                  fallback when the stream's live columns are unavailable.
 */
export function installObserver(
  stream: NodeJS.WriteStream,
  startRow: number,
  terminalRows: number,
  terminalCols: number,
): SuspendObserverHandle {
  // L3: read live dimensions from the stream so a SIGWINCH while suspended
  // is reflected in advanceRow() and soft-wrap detection. Fall back to the
  // snapshot values when the stream does not expose them (e.g. PassThrough
  // mocks that intentionally test fixed-dimension behavior).
  const getRows = (): number => Math.max(1, stream.rows ?? terminalRows);
  const getCols = (): number => Math.max(1, stream.columns ?? terminalCols);

  let row = Math.max(1, Math.min(startRow, getRows()));
  let col = 0; // 0-based visual column
  let scrolls = 0;
  let state: EscState = EscState.Normal;
  // Buffer to accumulate CSI parameter / intermediate bytes for pattern matching.
  let csiBuf = '';
  // Saved cursor for ESC 7/CSI s and ESC 8/CSI u.
  let savedRow = row;
  let savedCol = col;

  /** Advance cursor row by 1. If row exceeds the terminal bottom, scroll. */
  const advanceRow = (): void => {
    const rows = getRows();
    if (row < rows) {
      row++;
    } else {
      scrolls++;
      // row stays at rows (screen scrolled, cursor stays at floor)
    }
  };

  /**
   * Parse a decimal integer from the CSI parameter buffer starting at `start`.
   * Returns [value, nextIndex]. Returns [def, start] when nothing was parsed.
   */
  const parseParam = (buf: string, start: number, def: number): [number, number] => {
    let i = start;
    let n = 0;
    let any = false;
    while (i < buf.length && buf[i]! >= '0' && buf[i]! <= '9') {
      n = n * 10 + (buf.charCodeAt(i) - 48);
      i++;
      any = true;
    }
    return any ? [n, i] : [def, start];
  };

  /**
   * Handle the completed CSI sequence (csiBuf already set, final byte = ch).
   * Mutates `row`, `col`, `scrolls`, `savedRow`, `savedCol` as appropriate.
   */
  // Contract: returns true when the sequence triggers alt-screen ENTRY (so
  // the caller — which is inside a `state === EscState.Csi` branch that the
  // TypeScript const-enum narrower sees as always-Csi — can set state to
  // AltScreen without triggering a "no overlap" comparison error).
  const handleCsi = (final: string): boolean => {
    const cp = final.charCodeAt(0)!;
    const buf = csiBuf;

    // Alt-screen enter/exit (handled before cursor movement).
    if (buf === '?1049' && final === 'h') {
      return true; // caller sets state = EscState.AltScreen
    }

    const rows = getRows();
    const cols = getCols();

    // CUU — cursor up N (A = 0x41)
    if (cp === 0x41) {
      const [n] = parseParam(buf, 0, 1);
      row = Math.max(1, row - n);
      return false;
    }
    // CUD — cursor down N (B = 0x42)
    if (cp === 0x42) {
      const [n] = parseParam(buf, 0, 1);
      row = Math.min(rows, row + n);
      return false;
    }
    // CNL — cursor next line (E = 0x45): down N, col=0
    if (cp === 0x45) {
      const [n] = parseParam(buf, 0, 1);
      row = Math.min(rows, row + n);
      col = 0;
      return false;
    }
    // CPL — cursor preceding line (F = 0x46): up N, col=0
    if (cp === 0x46) {
      const [n] = parseParam(buf, 0, 1);
      row = Math.max(1, row - n);
      col = 0;
      return false;
    }
    // CHA — cursor horizontal absolute (G = 0x47); also ` (0x60)
    if (cp === 0x47 || cp === 0x60) {
      const [n] = parseParam(buf, 0, 1);
      col = Math.max(0, Math.min(n - 1, cols - 1));
      return false;
    }
    // CUP — cursor position (H = 0x48); also HVP (f = 0x66)
    // Parameters: row;col (1-based absolute, default 1).
    // Contract (absolute semantics): R is the absolute terminal row (1-based).
    // CUP uses absolute terminal rows directly; no offset from startRow needed.
    if (cp === 0x48 || cp === 0x66) {
      let r1 = 1, c1 = 1;
      const [rv, ri] = parseParam(buf, 0, 1);
      r1 = rv;
      if (ri < buf.length && buf[ri] === ';') {
        const [cv] = parseParam(buf, ri + 1, 1);
        c1 = cv;
      }
      row = Math.max(1, Math.min(r1, rows));
      col = Math.max(0, Math.min(c1 - 1, cols - 1));
      return false;
    }
    // VPA — vertical position absolute (d = 0x64)
    if (cp === 0x64) {
      const [n] = parseParam(buf, 0, 1);
      row = Math.max(1, Math.min(n, rows));
      return false;
    }
    // CSI s — save cursor (same as ESC 7)
    if (cp === 0x73 && buf === '') {
      savedRow = row;
      savedCol = col;
      return false;
    }
    // CSI u — restore cursor (same as ESC 8)
    if (cp === 0x75 && buf === '') {
      row = savedRow;
      col = savedCol;
      return false;
    }
    // All other CSI sequences: no-op (just consumed by the state machine).
    return false;
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
        } else if (ch === '7') {
          // ESC 7 — save cursor position
          savedRow = row;
          savedCol = col;
          state = EscState.Normal;
        } else if (ch === '8') {
          // ESC 8 — restore cursor position
          row = savedRow;
          col = savedCol;
          state = EscState.Normal;
        } else if (ch === 'M') {
          // ESC M — reverse index (RI): cursor up 1 row, no scroll at top
          row = Math.max(1, row - 1);
          state = EscState.Normal;
        } else if (ch === 'D') {
          // ESC D — index (IND): like LF — advance row
          advanceRow();
          state = EscState.Normal;
        } else if (ch === 'E') {
          // ESC E — next line (NEL): like LF + CR
          advanceRow();
          col = 0;
          state = EscState.Normal;
        } else {
          // Non-CSI ESC sequence; skip this byte.
          state = EscState.Normal;
        }
        continue;
      }

      if (state === EscState.Csi) {
        // Invariant (csiBuf cap): reject malformed sequences that exceed
        // CSI_BUF_MAX bytes in their parameter/intermediate section.
        if (csiBuf.length >= CSI_BUF_MAX) {
          // Overflow: discard and reset — the final byte (if we ever see it)
          // would be acted on with a corrupt buffer, so it is safer to drop.
          csiBuf = '';
          state = EscState.Normal;
          // Re-process this byte as Normal.
          i--;
          continue;
        }
        // Accumulate until we see a final byte (0x40–0x7E, i.e. '@' through '~').
        if (cp >= 0x40 && cp <= 0x7e) {
          // Final byte reached — dispatch the completed sequence.
          const enteredAltScreen = handleCsi(ch);
          // handleCsi returns true when the sequence caused alt-screen entry.
          // Using the return value avoids a TS2367 "no overlap" error that arises
          // when comparing a const-enum narrowed to EscState.Csi against AltScreen.
          state = enteredAltScreen ? EscState.AltScreen : EscState.Normal;
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
      const cols = getCols();
      if (cols > 0 && col >= cols) {
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
  // Store the wrapper reference so remove() can verify our layer is still
  // installed before restoring origWrite (L1: reference equality check).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapper = (chunk: unknown, ...rest: unknown[]): boolean => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (origWrite as any)(chunk, ...rest) as boolean;
    processChunk(chunk);
    return result;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (stream as any).write = wrapper;

  return {
    remove(): SuspendObserverState {
      // L1: only restore origWrite if our wrapper is still installed. If
      // someone installed another observer after us, leave their wrapper in
      // place — we must not remove a layer we did not install. If remove()
      // was already called (double-call), stream.write is already origWrite
      // and we must not re-assign (harmless in this particular case but
      // semantically wrong — restoring the original is a one-time act).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((stream as any).write === wrapper) {
        stream.write = origWrite;
      }
      return { cursorRow: row, scrollCount: scrolls };
    },
  };
}
