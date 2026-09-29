/**
 * Outermost iteration wrapper: bounded pause + replay after a 529/503
 * exhausts the in-flight stream retry budget.
 *
 * Mirrors {@link anthropic-direct/query/overload-pause-tier.turnWithOverloadPause}
 * but keyed on an `{ type:'error' }` event whose status is 529 or 503 (the
 * exhaustion signal on this wire) rather than on the `OVERLOAD_EXHAUSTED`
 * sentinel stamped on `turn.completed` by the Anthropic-direct loop.
 *
 * Design constraints satisfied:
 *  - Zero changes to `query.ts` class state or history: this tier sits BELOW
 *    the user-message push and INSIDE the tool-round loop, so it retries only
 *    the model call, not the entire turn.
 *  - Interactive surfaces park up to `OVERLOAD_PAUSE_CEILING_MS`; daemon/cron
 *    default to `0` (fail-fast). `AFK_OVERLOAD_PAUSE_MS` overrides both.
 *  - Abort/close always wins over a pause: an ESC fires the abort path and
 *    the original error event is forwarded so the turn seals.
 *  - On ceiling exhaustion the error is forwarded so the turn still seals (no
 *    silent hang — the same contract `turnWithOverloadPause` keeps).
 *  - The pause emits `overload_pause` and `overload_resume` trace phases,
 *    matching the anthropic-direct counterpart so observers see parity.
 *
 * Implementation note on generator return values: `for await` discards the
 * typed return value of an `AsyncGenerator<T, R>`. We use the explicit
 * generator protocol (`.next()` in a manual loop) throughout this module so
 * the `IterationResult | null` returned by `driveStream` is observable and
 * can be surfaced to the caller.
 *
 * @module agent/providers/openai-compatible/query/overload-pause-tier
 */

import type { ProviderEvent } from '../../../provider.js';
import type { TraceSink } from '../../../trace/index.js';
import { emitSessionPhase } from '../../../trace/emit.js';
import { sleepWithAbort } from '../../shared/sleep-with-abort.js';
import {
  resolveOverloadPauseCeilingMs,
  nextProbeDelayMs,
} from '../../anthropic-direct/overload-pause.js';
import { getErrorStatus } from './retry.js';
import type { IterationResult } from './stream-drive.js';

/** HTTP status codes that indicate server overload on the OpenAI-compatible wire. */
const OVERLOAD_STATUS_CODES = new Set([529, 503]);

/**
 * True when `event` is an error event whose underlying status indicates server
 * overload (529 = Anthropic overloaded, 503 = service unavailable).
 */
export function isOverloadErrorEvent(event: ProviderEvent): boolean {
  if (event.type !== 'error') return false;
  const status = getErrorStatus(event.error);
  return status !== undefined && OVERLOAD_STATUS_CODES.has(status);
}

/** Context threaded through from `OpenAICompatibleQuery` to the tier. */
export interface OverloadPauseTierContext {
  /** AgentConfig.surface — determines whether to park or fail-fast. */
  surface: string | undefined;
  /** Witness trace writer, passed to `emitSessionPhase` (fire-and-forget). */
  traceWriter: TraceSink | undefined;
  /** Per-turn abort signal; an abort always wins over a pause. */
  signal: AbortSignal;
  /** Session-level liveness check (set true on `close()`). */
  isClosed: () => boolean;
  /** Session id for `stream.retry` events. */
  sessionId: string;
}

/**
 * Wrap one `runIteration` call with an overload-aware pause + replay loop.
 *
 * @param makeIteration Factory that returns a fresh `runIteration` generator.
 *   Called once per attempt (initial + each replay). The factory MUST produce a
 *   NEW generator each time — generators are single-use; reusing one would
 *   yield nothing on subsequent attempts.
 * @param ctx Surface, trace writer, and liveness state from the owning query.
 * @returns The same `IterationResult | null` as the inner `runIteration` on a
 *   clean run or a successful pause+replay. On ceiling-reached or abort, the
 *   overload `error` event is forwarded and `null` is returned so the caller
 *   seals the turn normally.
 */
export async function* runIterationWithOverloadPause(
  makeIteration: () => AsyncGenerator<ProviderEvent, IterationResult | null>,
  ctx: OverloadPauseTierContext,
): AsyncGenerator<ProviderEvent, IterationResult | null> {
  const ceilingMs = resolveOverloadPauseCeilingMs(ctx.surface);
  // Measured from the first exhaustion, NOT from the turn start — a long turn
  // must not silently consume the operator's pause budget before any probe fires.
  let pauseStartedAt: number | null = null;
  let pauseEmitted = false;

  for (;;) {
    // ── Manual generator protocol: preserves the typed return value ──────────
    // `for await` discards `IterationResult | null` returned by `driveStream`.
    // We use `.next()` explicitly so the `{done:true, value}` step is visible.
    const gen = makeIteration();
    let overloadEvent: ProviderEvent | null = null;
    let returnValue: IterationResult | null = null;

    for (;;) {
      const step = await gen.next();
      if (step.done) {
        returnValue = step.value;
        break;
      }
      const event = step.value;
      if (isOverloadErrorEvent(event)) {
        // driveStream yields the error event last and then returns null.
        // Consume the final return step to close the generator cleanly.
        const terminal = await gen.next();
        returnValue = terminal.done ? terminal.value : null;
        overloadEvent = event;
        break;
      }
      yield event;
    }

    // ── Clean run (no overload error intercepted) ────────────────────────────
    if (overloadEvent === null) {
      if (pauseEmitted && pauseStartedAt !== null) {
        void emitSessionPhase(ctx.traceWriter, {
          phase: 'overload_resume',
          durationMs: Date.now() - pauseStartedAt,
          metadata: { source: 'openai-compat', outcome: 'recovered' },
        });
      }
      return returnValue;
    }

    // ── Fail-fast gates (abort / close / non-interactive surface) ───────────
    // Abort is checked FIRST so a user interrupt always wins over a pause
    // (AbortGraph precedence). isClosed() is checked alongside abort: a
    // concurrent close() sets signal.aborted too, but close() means the
    // session is ending — the error must propagate so the session seals.
    if (ctx.isClosed() || ctx.signal.aborted || ceilingMs === 0) {
      yield overloadEvent;
      return null;
    }

    // ── Ceiling guard ────────────────────────────────────────────────────────
    pauseStartedAt ??= Date.now();
    const remainingMs = ceilingMs - (Date.now() - pauseStartedAt);
    if (remainingMs <= 0) {
      if (pauseEmitted) {
        void emitSessionPhase(ctx.traceWriter, {
          phase: 'overload_resume',
          durationMs: Date.now() - pauseStartedAt,
          metadata: { source: 'openai-compat', outcome: 'ceiling-reached' },
        });
      }
      yield overloadEvent;
      return null;
    }

    // ── Emit pause trace on the first overload ───────────────────────────────
    if (!pauseEmitted) {
      void emitSessionPhase(ctx.traceWriter, {
        phase: 'overload_pause',
        metadata: {
          reason: 'overloaded',
          source: 'openai-compat',
          hasResetTimestamp: false,
          ceilingMs,
          surface: ctx.surface ?? 'unknown',
        },
      });
      pauseEmitted = true;
    }

    // ── Jittered probe interval (clamped to remaining budget) ────────────────
    // A 529/503 carries no reset timestamp; the only honest strategy is to
    // re-probe on a jittered interval. Clamped to the remaining ceiling so
    // a 1ms ceiling doesn't still park a full 60s.
    await sleepWithAbort(Math.min(nextProbeDelayMs(), remainingMs), ctx.signal);

    // Re-check abort/close after sleeping — the signal may have fired during
    // the wait. Check isClosed() FIRST: close + abort → close path (stricter).
    if (ctx.isClosed()) { yield overloadEvent; return null; }
    if (ctx.signal.aborted) return null;

    // Tell surfaces to discard the current partial paint before the replay
    // begins from scratch — mirrors `stream.retry` in `turnWithOverloadPause`.
    yield { type: 'stream.retry', sessionId: ctx.sessionId };
    // loop continues → makeIteration() called again
  }
}
