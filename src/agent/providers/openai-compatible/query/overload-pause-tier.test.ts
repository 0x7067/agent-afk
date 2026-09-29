/**
 * Tests for the openai-compatible overload-pause tier (#2419).
 *
 * Mirrors the anthropic-direct counterpart
 * (`anthropic-direct/query/overload-pause-tier.test.ts`) but uses the
 * openai-compatible signal shape: an `{ type:'error' }` event with status 529
 * or 503 (exhausted stream retries on this wire) rather than an
 * `OVERLOAD_EXHAUSTED` sentinel on `turn.completed`.
 *
 * Invariants under test:
 *  - Interactive surfaces (cli/repl/telegram/web) pause and re-probe.
 *  - Daemon/cron fail fast (ceilingMs === 0).
 *  - Abort always wins over a pause.
 *  - Close during a pause forwards the error event so the turn seals.
 *  - Ceiling exhaustion forwards the error (no silent hang).
 *  - `stream.retry` is emitted before each replay to clear stale paint.
 *  - `overload_pause` / `overload_resume` trace phases match the
 *    anthropic-direct tier's contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProviderEvent } from '../../../provider.js';
import {
  runIterationWithOverloadPause,
  isOverloadErrorEvent,
  type OverloadPauseTierContext,
} from './overload-pause-tier.js';
import type { IterationResult } from './stream-drive.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal IterationResult for a clean (non-tool) completion. */
const cleanResult: IterationResult = {
  state: {
    assistantText: 'hello',
    reasoningText: '',
    finishReason: 'stop',
    toolCallsByIndex: new Map(),
  },
  events: [],
  text: 'hello',
  needsToolDispatch: false,
};

/** Build an error event with the given HTTP status code. */
function overloadError(status: 529 | 503): ProviderEvent {
  const err = new Error(`http ${status}`) as Error & { status: number };
  err.status = status;
  return { type: 'error', error: err };
}

const err529 = overloadError(529);
const err503 = overloadError(503);

/** A normal error (400) that is NOT an overload error. */
function clientError(): ProviderEvent {
  const err = new Error('bad request') as Error & { status: number };
  err.status = 400;
  return { type: 'error', error: err };
}

/**
 * Build a factory for `makeIteration` that returns a fresh generator on each
 * call. Scripted: the i-th call returns the i-th events array (cycling on the
 * last one). Captures the return value of each generator for the return slot.
 */
function scriptIterations(
  ...attempts: { events: ProviderEvent[]; result: IterationResult | null }[]
): {
  makeIteration: () => AsyncGenerator<ProviderEvent, IterationResult | null>;
  callCount: () => number;
} {
  let i = 0;
  let count = 0;
  return {
    makeIteration() {
      const attempt = attempts[Math.min(i, attempts.length - 1)] ?? { events: [], result: null };
      i++;
      count++;
      return (async function* (): AsyncGenerator<ProviderEvent, IterationResult | null> {
        for (const e of attempt.events) yield e;
        return attempt.result;
      })();
    },
    callCount: () => count,
  };
}

/**
 * Drain the tier generator to completion, collecting yielded events and the
 * typed return value.
 */
async function drain(
  gen: AsyncGenerator<ProviderEvent, IterationResult | null>,
): Promise<{ events: ProviderEvent[]; result: IterationResult | null }> {
  const events: ProviderEvent[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, result: step.value };
    events.push(step.value);
  }
}

function makeCtx(surface: string | undefined, ac = new AbortController()): OverloadPauseTierContext {
  return {
    surface,
    traceWriter: undefined,
    signal: ac.signal,
    isClosed: () => false,
    sessionId: 'sess-test',
  };
}

// ---------------------------------------------------------------------------
// isOverloadErrorEvent
// ---------------------------------------------------------------------------

describe('isOverloadErrorEvent', () => {
  it('matches 529', () => expect(isOverloadErrorEvent(err529)).toBe(true));
  it('matches 503', () => expect(isOverloadErrorEvent(err503)).toBe(true));
  it('does not match a 400', () => expect(isOverloadErrorEvent(clientError())).toBe(false));
  it('does not match delta.text', () =>
    expect(isOverloadErrorEvent({ type: 'delta.text', text: 'hi', sessionId: 's' })).toBe(false));
  it('does not match an error with no status', () =>
    expect(isOverloadErrorEvent({ type: 'error', error: new Error('generic') })).toBe(false));
});

// ---------------------------------------------------------------------------
// Fail-fast surfaces (daemon/cron)
// ---------------------------------------------------------------------------

describe('overload pause tier — fail-fast surfaces', () => {
  beforeEach(() => { delete process.env['AFK_OVERLOAD_PAUSE_MS']; });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env['AFK_OVERLOAD_PAUSE_MS'];
  });

  it('does not park a daemon surface — forwards the error event immediately', async () => {
    const { makeIteration, callCount } = scriptIterations({
      events: [err529],
      result: null,
    });

    const { events, result } = await drain(
      runIterationWithOverloadPause(makeIteration, makeCtx('daemon')),
    );

    expect(callCount()).toBe(1);
    expect(result).toBeNull();
    // The error event must be forwarded (not swallowed) so the turn seals.
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    const e = events[0];
    if (e?.type === 'error') expect((e.error as { status?: number }).status).toBe(529);
  });

  it('does not park when surface is undefined (forked-child default)', async () => {
    const { makeIteration, callCount } = scriptIterations({ events: [err529], result: null });
    const { events } = await drain(
      runIterationWithOverloadPause(makeIteration, makeCtx(undefined)),
    );
    expect(callCount()).toBe(1);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
  });

  it('forwards a 503 error on daemon the same way as 529', async () => {
    const { makeIteration, callCount } = scriptIterations({ events: [err503], result: null });
    const { events } = await drain(
      runIterationWithOverloadPause(makeIteration, makeCtx('daemon')),
    );
    expect(callCount()).toBe(1);
    const errs = events.filter((e) => e.type === 'error');
    expect(errs).toHaveLength(1);
  });

  it('passes a clean result through with no overload handling', async () => {
    const { makeIteration, callCount } = scriptIterations({ events: [], result: cleanResult });
    const { events, result } = await drain(
      runIterationWithOverloadPause(makeIteration, makeCtx('daemon')),
    );
    expect(callCount()).toBe(1);
    expect(events).toHaveLength(0);
    expect(result).toEqual(cleanResult);
  });

  it('honors AFK_OVERLOAD_PAUSE_MS=0 on an interactive surface', async () => {
    process.env['AFK_OVERLOAD_PAUSE_MS'] = '0';
    const { makeIteration, callCount } = scriptIterations({ events: [err529], result: null });
    const { events } = await drain(
      runIterationWithOverloadPause(makeIteration, makeCtx('cli')),
    );
    expect(callCount()).toBe(1);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
  });

  it('does not intercept a non-overload error on an interactive surface', async () => {
    const { makeIteration, callCount } = scriptIterations({ events: [clientError()], result: null });
    const { events } = await drain(
      runIterationWithOverloadPause(makeIteration, makeCtx('cli')),
    );
    expect(callCount()).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// Interactive pause + replay
// ---------------------------------------------------------------------------

describe('overload pause tier — interactive pause + replay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env['AFK_OVERLOAD_PAUSE_MS'];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env['AFK_OVERLOAD_PAUSE_MS'];
  });

  it('parks a cli session, re-probes, and returns the clean result on recovery', async () => {
    const { makeIteration, callCount } = scriptIterations(
      { events: [err529], result: null },
      { events: [], result: cleanResult },
    );
    const promise = drain(runIterationWithOverloadPause(makeIteration, makeCtx('cli')));
    // Advance past the probe interval (60–120s).
    await vi.advanceTimersByTimeAsync(130_000);
    const { events, result } = await promise;

    expect(callCount()).toBe(2);
    // The overload error was swallowed — caller sees no error.
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    expect(result).toEqual(cleanResult);
  });

  it('parks a repl surface the same way as cli', async () => {
    const { makeIteration, callCount } = scriptIterations(
      { events: [err529], result: null },
      { events: [], result: cleanResult },
    );
    const promise = drain(runIterationWithOverloadPause(makeIteration, makeCtx('repl')));
    await vi.advanceTimersByTimeAsync(130_000);
    const { result } = await promise;
    expect(callCount()).toBe(2);
    expect(result).toEqual(cleanResult);
  });

  it('parks a telegram surface the same way as cli', async () => {
    const { makeIteration, callCount } = scriptIterations(
      { events: [err529], result: null },
      { events: [], result: cleanResult },
    );
    const promise = drain(runIterationWithOverloadPause(makeIteration, makeCtx('telegram')));
    await vi.advanceTimersByTimeAsync(130_000);
    const { result } = await promise;
    expect(callCount()).toBe(2);
    expect(result).toEqual(cleanResult);
  });

  it.each([
    { label: 'shortest probe draws (60s)', random: 0, expectedCalls: 4 },
    { label: 'longest probe draws (~120s)', random: 0.999999, expectedCalls: 3 },
  ])(
    'surfaces the error at the wall-clock ceiling instead of parking forever ($label)',
    async ({ random, expectedCalls }) => {
      vi.spyOn(Math, 'random').mockReturnValue(random);
      process.env['AFK_OVERLOAD_PAUSE_MS'] = '150000'; // 2.5 min
      // Never recovers.
      const { makeIteration, callCount } = scriptIterations({ events: [err529], result: null });
      const promise = drain(runIterationWithOverloadPause(makeIteration, makeCtx('cli')));
      await vi.advanceTimersByTimeAsync(600_000);
      const { events } = await promise;

      expect(callCount()).toBe(expectedCalls);
      // The forwarded error is the last event and there is exactly one.
      const errs = events.filter((e) => e.type === 'error');
      expect(errs).toHaveLength(1);
    },
  );

  it('lets an abort during the pause win immediately (no replay)', async () => {
    const { makeIteration, callCount } = scriptIterations({ events: [err529], result: null });
    const ac = new AbortController();
    const promise = drain(runIterationWithOverloadPause(makeIteration, makeCtx('cli', ac)));

    await vi.advanceTimersByTimeAsync(100); // tier enters pause
    ac.abort('interrupted');
    await vi.advanceTimersByTimeAsync(200_000);
    const { events, result } = await promise;

    expect(callCount()).toBe(1);
    expect(result).toBeNull();
    // Matches anthropic-direct tier: an abort during the sleep exits without
    // forwarding the error event (query.ts synthesizes an interrupted terminal).
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
  });

  it('forwards the error when the session closes during the pause', async () => {
    let closed = false;
    const ctx: OverloadPauseTierContext = {
      surface: 'cli',
      traceWriter: undefined,
      signal: new AbortController().signal,
      isClosed: () => closed,
      sessionId: 'sess-test',
    };
    const { makeIteration, callCount } = scriptIterations({ events: [err529], result: null });
    const promise = drain(runIterationWithOverloadPause(makeIteration, ctx));

    await vi.advanceTimersByTimeAsync(100);
    closed = true;
    await vi.advanceTimersByTimeAsync(200_000);
    const { events } = await promise;

    expect(callCount()).toBe(1);
    // Close must forward the error so the turn seals correctly (not silently).
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Trace fidelity and replay hygiene
// ---------------------------------------------------------------------------

describe('overload pause tier — trace fidelity and replay hygiene', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env['AFK_OVERLOAD_PAUSE_MS'];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env['AFK_OVERLOAD_PAUSE_MS'];
  });

  function makeCapturingCtx(surface: string): {
    ctx: OverloadPauseTierContext;
    phases: { phase: string; outcome?: unknown; ceilingMs?: unknown }[];
  } {
    const phases: { phase: string; outcome?: unknown; ceilingMs?: unknown }[] = [];
    const ctx: OverloadPauseTierContext = {
      surface,
      signal: new AbortController().signal,
      isClosed: () => false,
      sessionId: 'sess-test',
      traceWriter: {
        write: (row: { kind: string; payload: Record<string, unknown> }) => {
          if (row.kind === 'session_phase') {
            const md = (row.payload['metadata'] ?? {}) as Record<string, unknown>;
            phases.push({
              phase: String(row.payload['phase']),
              outcome: md['outcome'],
              ceilingMs: md['ceilingMs'],
            });
          }
          return Promise.resolve();
        },
      } as OverloadPauseTierContext['traceWriter'],
    };
    return { ctx, phases };
  }

  it('emits overload_pause once and overload_resume (recovered) on a successful re-probe', async () => {
    process.env['AFK_OVERLOAD_PAUSE_MS'] = '600000';
    const { makeIteration } = scriptIterations(
      { events: [err529], result: null },
      { events: [], result: cleanResult },
    );
    const { ctx, phases } = makeCapturingCtx('cli');
    const promise = drain(runIterationWithOverloadPause(makeIteration, ctx));
    await vi.advanceTimersByTimeAsync(600_000);
    await promise;

    expect(phases.filter((p) => p.phase === 'overload_pause')).toHaveLength(1);
    const resumes = phases.filter((p) => p.phase === 'overload_resume');
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.outcome).toBe('recovered');
  });

  it('marks a ceiling-reached outcome as ceiling-reached, not recovered', async () => {
    process.env['AFK_OVERLOAD_PAUSE_MS'] = '150000';
    const { makeIteration } = scriptIterations({ events: [err529], result: null });
    const { ctx, phases } = makeCapturingCtx('cli');
    const promise = drain(runIterationWithOverloadPause(makeIteration, ctx));
    await vi.advanceTimersByTimeAsync(600_000);
    await promise;

    const resumes = phases.filter((p) => p.phase === 'overload_resume');
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.outcome).toBe('ceiling-reached');
  });

  it('emits stream.retry before the replayed attempt to clear stale paint', async () => {
    process.env['AFK_OVERLOAD_PAUSE_MS'] = '600000';
    const textDelta: ProviderEvent = { type: 'delta.text', text: 'recovered', sessionId: 's' };
    const { makeIteration } = scriptIterations(
      { events: [err529], result: null },
      { events: [textDelta], result: cleanResult },
    );
    const promise = drain(runIterationWithOverloadPause(makeIteration, makeCtx('cli')));
    await vi.advanceTimersByTimeAsync(600_000);
    const { events } = await promise;

    const retryIdx = events.findIndex((e) => e.type === 'stream.retry');
    expect(retryIdx).toBeGreaterThan(-1);
    const recoveredIdx = events.findIndex((e) => e.type === 'delta.text');
    expect(recoveredIdx).toBeGreaterThan(retryIdx);
  });

  it('clamps the probe sleep to the remaining ceiling (1ms ceiling)', async () => {
    process.env['AFK_OVERLOAD_PAUSE_MS'] = '1'; // 1ms — far below one probe interval
    const { makeIteration } = scriptIterations({ events: [err529], result: null });
    const promise = drain(runIterationWithOverloadPause(makeIteration, makeCtx('cli')));
    // If unclamped, the probe sleep would park for 60+ seconds. The 1ms ceiling
    // ensures the sleep is clamped to 1ms, so the tier settles well within 1s.
    await vi.advanceTimersByTimeAsync(1_000);
    const { events } = await promise;

    // The error is forwarded after the ceiling is exhausted (no infinite park).
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
  });

  it('does not emit a spurious pause when there is no overload (clean run)', async () => {
    const { makeIteration } = scriptIterations({ events: [], result: cleanResult });
    const { ctx, phases } = makeCapturingCtx('cli');
    const promise = drain(runIterationWithOverloadPause(makeIteration, ctx));
    await promise;

    expect(phases.filter((p) => p.phase === 'overload_pause')).toHaveLength(0);
    expect(phases.filter((p) => p.phase === 'overload_resume')).toHaveLength(0);
  });
});
