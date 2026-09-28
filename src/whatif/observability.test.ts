/**
 * Tests for `src/whatif/observability.ts`.
 *
 * Pure function tests — no I/O, no model calls.
 */

import { describe, expect, it } from 'vitest';
import { applyObservability, INTERCEPTED_INTENT_RULE, unobservableReason } from './observability.js';
import type { EpisodeTrace } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTrace(
  episodeId: string,
  env: 'baseline' | 'candidate',
  intercepted: string[],
): EpisodeTrace {
  return {
    episodeId,
    env,
    sample: 0,
    text: 'response text',
    tools: [
      ...intercepted.map((tool) => ({ tool, input: {}, verdict: 'recorded' as const })),
    ],
    costUsd: 0.001,
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 500,
  };
}

function makeCleanTrace(
  episodeId: string,
  env: 'baseline' | 'candidate',
): EpisodeTrace {
  return {
    episodeId,
    env,
    sample: 0,
    text: 'response text',
    tools: [{ tool: 'bash', input: {}, verdict: 'executed' }],
    costUsd: 0.001,
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 500,
  };
}

// ---------------------------------------------------------------------------
// INTERCEPTED_INTENT_RULE
// ---------------------------------------------------------------------------

describe('INTERCEPTED_INTENT_RULE', () => {
  it('is a non-empty string', () => {
    expect(typeof INTERCEPTED_INTENT_RULE).toBe('string');
    expect(INTERCEPTED_INTENT_RULE.length).toBeGreaterThan(20);
  });

  it('mentions the intercepted format marker', () => {
    expect(INTERCEPTED_INTENT_RULE).toContain('[tool requested:');
  });

  it('mentions "not executed"', () => {
    expect(INTERCEPTED_INTENT_RULE).toContain('not executed');
  });

  it('instructs grading intent not completion', () => {
    expect(INTERCEPTED_INTENT_RULE.toLowerCase()).toContain('intent');
  });
});

// ---------------------------------------------------------------------------
// unobservableReason
// ---------------------------------------------------------------------------

describe('unobservableReason', () => {
  it('returns a reason when verdict is refuted and both arms have intercepted calls', () => {
    const traces = [
      makeTrace('ep1', 'baseline', ['agent']),
      makeTrace('ep1', 'candidate', ['agent']),
    ];
    const reason = unobservableReason('refuted', ['ep1'], traces);
    expect(reason).toBeDefined();
    expect(reason).toContain('agent');
    expect(reason).toContain('both arms');
  });

  it('returns undefined when verdict is confirmed (no downgrade needed)', () => {
    const traces = [
      makeTrace('ep1', 'baseline', ['agent']),
      makeTrace('ep1', 'candidate', ['agent']),
    ];
    const reason = unobservableReason('confirmed', ['ep1'], traces);
    expect(reason).toBeUndefined();
  });

  it('returns undefined when verdict is unclear (no downgrade needed)', () => {
    const traces = [
      makeTrace('ep1', 'baseline', ['agent']),
      makeTrace('ep1', 'candidate', ['agent']),
    ];
    const reason = unobservableReason('unclear', ['ep1'], traces);
    expect(reason).toBeUndefined();
  });

  it('returns undefined when only baseline arm has intercepted calls', () => {
    const traces = [
      makeTrace('ep1', 'baseline', ['agent']),
      makeCleanTrace('ep1', 'candidate'),
    ];
    const reason = unobservableReason('refuted', ['ep1'], traces);
    expect(reason).toBeUndefined();
  });

  it('returns undefined when only candidate arm has intercepted calls', () => {
    const traces = [
      makeCleanTrace('ep1', 'baseline'),
      makeTrace('ep1', 'candidate', ['agent']),
    ];
    const reason = unobservableReason('refuted', ['ep1'], traces);
    expect(reason).toBeUndefined();
  });

  it('returns undefined when neither arm has intercepted calls', () => {
    const traces = [
      makeCleanTrace('ep1', 'baseline'),
      makeCleanTrace('ep1', 'candidate'),
    ];
    const reason = unobservableReason('refuted', ['ep1'], traces);
    expect(reason).toBeUndefined();
  });

  it('includes all distinct intercepted tool names in the reason', () => {
    const traces = [
      makeTrace('ep1', 'baseline', ['agent', 'write_file']),
      makeTrace('ep1', 'candidate', ['agent']),
    ];
    const reason = unobservableReason('refuted', ['ep1'], traces);
    expect(reason).toContain('agent');
    expect(reason).toContain('write_file');
  });

  it('uses all traces when episodeIds is empty (covers the whole run)', () => {
    const traces = [
      makeTrace('ep1', 'baseline', ['agent']),
      makeTrace('ep2', 'candidate', ['agent']),
    ];
    const reason = unobservableReason('refuted', [], traces);
    expect(reason).toBeDefined();
  });

  it('filters to only matching episodes when episodeIds is provided', () => {
    const traces = [
      // ep1 has no intercepted calls
      makeCleanTrace('ep1', 'baseline'),
      makeCleanTrace('ep1', 'candidate'),
      // ep2 has intercepted calls but we only look at ep1
      makeTrace('ep2', 'baseline', ['agent']),
      makeTrace('ep2', 'candidate', ['agent']),
    ];
    const reason = unobservableReason('refuted', ['ep1'], traces);
    expect(reason).toBeUndefined();
  });

  it('the reason mentions "episode boundary"', () => {
    const traces = [
      makeTrace('ep1', 'baseline', ['agent']),
      makeTrace('ep1', 'candidate', ['agent']),
    ];
    const reason = unobservableReason('refuted', ['ep1'], traces);
    expect(reason).toContain('episode boundary');
  });
});

// ---------------------------------------------------------------------------
// applyObservability
// ---------------------------------------------------------------------------

describe('applyObservability', () => {
  it('downgrades refuted to unobservable when both arms intercepted', () => {
    const traces = [
      makeTrace('ep1', 'baseline', ['agent']),
      makeTrace('ep1', 'candidate', ['agent']),
    ];
    const result = applyObservability('refuted', ['ep1'], traces);
    expect(result.verdict).toBe('unobservable');
    expect(result.unobservableReason).toBeDefined();
  });

  it('preserves refuted when only one arm intercepted', () => {
    const traces = [
      makeTrace('ep1', 'baseline', ['agent']),
      makeCleanTrace('ep1', 'candidate'),
    ];
    const result = applyObservability('refuted', ['ep1'], traces);
    expect(result.verdict).toBe('refuted');
    expect(result.unobservableReason).toBeUndefined();
  });

  it('preserves confirmed even when both arms intercepted', () => {
    const traces = [
      makeTrace('ep1', 'baseline', ['agent']),
      makeTrace('ep1', 'candidate', ['agent']),
    ];
    const result = applyObservability('confirmed', ['ep1'], traces);
    expect(result.verdict).toBe('confirmed');
    expect(result.unobservableReason).toBeUndefined();
  });

  it('preserves unclear even when both arms intercepted', () => {
    const traces = [
      makeTrace('ep1', 'baseline', ['agent']),
      makeTrace('ep1', 'candidate', ['agent']),
    ];
    const result = applyObservability('unclear', ['ep1'], traces);
    expect(result.verdict).toBe('unclear');
    expect(result.unobservableReason).toBeUndefined();
  });

  it('preserves refuted with no intercepts and no reason', () => {
    const traces = [
      makeCleanTrace('ep1', 'baseline'),
      makeCleanTrace('ep1', 'candidate'),
    ];
    const result = applyObservability('refuted', ['ep1'], traces);
    expect(result.verdict).toBe('refuted');
    expect(result.unobservableReason).toBeUndefined();
  });

  it('fixture: both arms show agent intercepted for a "spawns subagent" prediction', () => {
    // Simulates the exact issue scenario: p4 "Honors explicit requests for
    // skills/subagents", probe "Spawn a subagent to read the LICENSE file"
    const traces: EpisodeTrace[] = [
      {
        episodeId: 'ep-p4-probe',
        env: 'baseline',
        sample: 0,
        text: 'I will spawn a subagent to read LICENSE.',
        tools: [{ tool: 'agent', input: { prompt: 'Read LICENSE' }, verdict: 'recorded' }],
        costUsd: 0.01,
        inputTokens: 200,
        outputTokens: 30,
        durationMs: 1000,
      },
      {
        episodeId: 'ep-p4-probe',
        env: 'candidate',
        sample: 0,
        text: 'I will spawn a subagent to read LICENSE.',
        tools: [{ tool: 'agent', input: { prompt: 'Read LICENSE' }, verdict: 'recorded' }],
        costUsd: 0.01,
        inputTokens: 200,
        outputTokens: 30,
        durationMs: 1000,
      },
    ];
    const result = applyObservability('refuted', ['ep-p4-probe'], traces);
    // Must NOT be refuted — this is the core issue
    expect(result.verdict).not.toBe('refuted');
    expect(result.verdict).toBe('unobservable');
    expect(result.unobservableReason).toContain('agent');
  });
});
