/**
 * Calibration harness for `afk whatif --verify` verdict statistics.
 *
 * Measures how often `scorePrediction()` produces confirmed / refuted / unclear
 * over a grid of (true_delta × episodes × samples) under the current
 * production code on main.
 *
 * Known bugs #2404 and #2405 cause certain cells to violate ideal calibration
 * properties. Those cells are marked `it.fails` so this suite passes on main
 * but flips to plain `it` once the fixes land. Every other assertion must be
 * green on main.
 *
 * ## Reproducibility
 *
 * All simulations use a seeded PRNG (seed=42). Re-running with identical code
 * will always produce the same numbers.
 *
 * ## How to regenerate the results table
 *
 *   pnpm exec tsx scripts/generate-whatif-calibration.ts
 *
 * That writes docs/whatif-calibration.md.
 *
 * @module whatif/__test-utils__/calibration-harness.test
 */

import { describe, expect, it } from 'vitest';
import { scorePrediction, traceKey, type JudgeResults } from '../run.verify.scoring.js';
import type { Episode, EpisodeTrace, Prediction } from '../types.js';
import {
  findCell,
  runGrid,
  type GridCell,
} from './calibration-harness.js';

// ---------------------------------------------------------------------------
// One shared grid run for all Monte Carlo tests (seed=42, 400 reps)
// ---------------------------------------------------------------------------

// 400 reps: Monte Carlo SE ≈ sqrt(p(1-p)/400) ≈ ±2.5pp.  Each assertion
// leaves ≥5pp headroom over the true value (stable across seeds 42–12345).
const REPS = 400;
const SEED = 42;

const cells = runGrid({ reps: REPS, seed: SEED });

function cell(trueDelta: 0 | 0.1 | 0.3, episodes: 3 | 6 | 12, samples: 1 | 3 | 5): GridCell {
  const c = findCell(cells, trueDelta, episodes, samples);
  if (!c) throw new Error(`Cell (${trueDelta}, ${episodes}, ${samples}) not found`);
  return c;
}

// ---------------------------------------------------------------------------
// Helpers for the deterministic #2404 mechanism test
// ---------------------------------------------------------------------------

function makePred(): Prediction {
  return {
    id: 'p',
    behavior: 'calibration behavior',
    direction: 'added',
    confidence: 'medium',
    reason: 'harness',
    testQuestion: 'Does the output show the behavior?',
    probes: [],
  };
}

/** Build synthetic episodes+traces with all scores = 0 (null scenario). */
function buildNullScenario(numEpisodes: number, numSamples: number): {
  episodes: Episode[];
  traces: EpisodeTrace[];
  judgeResults: JudgeResults;
} {
  const pred = makePred();
  const episodes: Episode[] = [];
  const traces: EpisodeTrace[] = [];
  const judgeResults: JudgeResults = new Map();

  for (let e = 0; e < numEpisodes; e++) {
    const epId = `ep_${e}`;
    episodes.push({ id: epId, source: 'synthetic', prompt: `probe ${e}`, targets: pred.id });

    for (let s = 0; s < numSamples; s++) {
      for (const env of ['baseline', 'candidate'] as const) {
        const tr: EpisodeTrace = {
          episodeId: epId,
          env,
          sample: s,
          text: '',
          tools: [],
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 0,
        };
        traces.push(tr);
        judgeResults.set(traceKey(tr), { [pred.id]: 0 });
      }
    }
  }
  return { episodes, traces, judgeResults };
}

// ---------------------------------------------------------------------------
// §1  Bug #2404: n inflation — deterministic mechanism test
//
// `collect()` in run.verify.scoring.ts appends every (episode, sample)
// observation to `scores`, so n = episodes × samples flows into
// `compareRates()`.  Each sample is a correlated draw from the same latent
// per-episode rate, NOT an independent observation.
//
// Observable consequence: adding more samples of the same episodes
// artificially shrinks the Newcombe CI.  When the CI falls below the
// verdictFor half-width threshold (0.15), a null result (delta ≈ 0) is
// falsely scored 'refuted'.  This is deterministic for all-zero scores
// with 6 episodes × 5 samples (n_inflated = 30 → half-width ≈ 0.11).
// ---------------------------------------------------------------------------

describe('Bug #2404 — n inflation from repeated samples', () => {
  // This is a direct, deterministic demonstration of the bug.
  // With 6 episodes × 1 sample, n=6: CI half-width ≈ 0.39 → 'unclear'.
  // With 6 episodes × 5 samples, n=30 (inflated): half-width ≈ 0.11 → 'refuted'.
  // A correct implementation would keep n ≈ 6 in both cases.

  it('6 episodes × 1 sample, all scores = 0 → verdict unclear (baseline)', () => {
    const { episodes, traces, judgeResults } = buildNullScenario(6, 1);
    const result = scorePrediction(makePred(), episodes, traces, judgeResults);
    expect(result.verdict).toBe('unclear');
    // n should reflect 6 episodes in each arm.
    expect(result.rates.n.baseline).toBe(6);
    expect(result.rates.n.candidate).toBe(6);
  });

  it.fails(
    // #2404: 6 episodes × 5 samples inflates n to 30 and triggers false refute.
    // After the fix: n should count unique episodes (≈6), keeping CI wide → unclear.
    '6 episodes × 5 samples, all scores = 0 → verdict unclear (#2404)',
    () => {
      const { episodes, traces, judgeResults } = buildNullScenario(6, 5);
      const result = scorePrediction(makePred(), episodes, traces, judgeResults);
      // Currently 'refuted' because n=30 shrinks CI below the 0.15 threshold.
      expect(result.verdict).toBe('unclear');
    },
  );

  it.fails(
    // #2404: n_baseline should count unique EPISODES, not (episodes × samples).
    '6 episodes × 5 samples: n reported should be 6, not 30 (#2404)',
    () => {
      const { episodes, traces, judgeResults } = buildNullScenario(6, 5);
      const result = scorePrediction(makePred(), episodes, traces, judgeResults);
      // Currently 30 (inflated by samples).
      expect(result.rates.n.baseline).toBe(6);
    },
  );
});

// ---------------------------------------------------------------------------
// §2  Bug #2405 — small-n refute rule fires too readily
//
// `verdictFor()` returns 'refuted' when |delta| < 0.05 AND CI half-width <
// 0.15, even when the run has too few independent observations to be
// informative.  The rule's intent is to detect "confidently near zero", but
// it fires whenever n is large enough to tighten the CI to that width,
// regardless of whether those observations are independent.  #2404 makes
// this reachable much sooner (n=22+ episodes×samples vs the true independent-
// episode count).
//
// Measured via Monte Carlo: P(refuted | delta=0.1, E=3, S=1) > 0.03
// is anomalous because with 3 independent episodes the CI should be too
// wide for the rule to fire.  It fires because verdictFor applies the
// rule to a measured delta near zero by chance, and at n=3 that is common.
//
// Similarly, the rule should never fire at delta=0.3 (a large true effect)
// — yet at E=3, S=1 it shows ~1% occurrence because the small sample
// occasionally reads near zero.
// ---------------------------------------------------------------------------

describe('Bug #2405 — small-n refute rule fires when run is underpowered', () => {
  // Passes on main: at moderate sample sizes the false-refute rate is acceptable.
  it('E=6, S=3: P(refuted|delta=0.1) ≤ 0.05', () => {
    expect(cell(0.1, 6, 3).pRefuted).toBeLessThanOrEqual(0.05);
  });

  it('E=12, S=5: P(refuted|delta=0.1) ≤ 0.02', () => {
    expect(cell(0.1, 12, 5).pRefuted).toBeLessThanOrEqual(0.02);
  });

  it('E=6, S=3: P(refuted|delta=0.3) ≤ 0.02', () => {
    expect(cell(0.3, 6, 3).pRefuted).toBeLessThanOrEqual(0.02);
  });

  it('E=12, S=5: P(refuted|delta=0.3) ≈ 0', () => {
    expect(cell(0.3, 12, 5).pRefuted).toBeLessThanOrEqual(0.01);
  });

  // At E=3, S=1, the small-n refute rule fires on delta=0.1 approximately
  // 5–7% of the time (observed across seeds 42, 100, 999, 777, 12345).
  // After fix, this should be ≤ 1% (the residual from a true effect observed
  // near zero by chance at n=3 should be vanishingly rare when the CI is
  // properly wide, because CI excludes zero will not fire and the half-width
  // rule should not fire either at n=3 where half-width ≈ 0.56 >> 0.15).

  it.fails(
    // #2405: small-n rule misfires; delta=0.1 should not produce >3% refutes at E=3
    'E=3, S=1: P(refuted|delta=0.1) should be ≤ 0.03 (#2405)',
    () => {
      // Observed: ~5–7% (consistently above 0.03 across seeds).
      expect(cell(0.1, 3, 1).pRefuted).toBeLessThanOrEqual(0.03);
    },
  );
});

// ---------------------------------------------------------------------------
// §3  False-confirm rate (delta = 0)
//
// Properties that hold on current main and should also hold after fixes.
// ---------------------------------------------------------------------------

describe('false-confirm rate (delta=0)', () => {
  it('E=6, S=1: P(confirmed|delta=0) ≤ 0.11', () => {
    expect(cell(0, 6, 1).pConfirmed).toBeLessThanOrEqual(0.11);
  });

  it('E=12, S=1: P(confirmed|delta=0) ≤ 0.11', () => {
    expect(cell(0, 12, 1).pConfirmed).toBeLessThanOrEqual(0.11);
  });

  it('E=6, S=5: P(confirmed|delta=0) ≤ 0.11', () => {
    expect(cell(0, 6, 5).pConfirmed).toBeLessThanOrEqual(0.11);
  });

  it('E=12, S=5: P(confirmed|delta=0) ≤ 0.11', () => {
    expect(cell(0, 12, 5).pConfirmed).toBeLessThanOrEqual(0.11);
  });
});

// ---------------------------------------------------------------------------
// §4  Power (delta = 0.3)
// ---------------------------------------------------------------------------

describe('power at delta=0.3', () => {
  it('E=6, S=3: P(confirmed|delta=0.3) ≥ 0.45', () => {
    expect(cell(0.3, 6, 3).pConfirmed).toBeGreaterThanOrEqual(0.45);
  });

  it('E=12, S=3: P(confirmed|delta=0.3) ≥ 0.70', () => {
    expect(cell(0.3, 12, 3).pConfirmed).toBeGreaterThanOrEqual(0.70);
  });

  it('E=12, S=5: P(confirmed|delta=0.3) ≥ 0.85', () => {
    expect(cell(0.3, 12, 5).pConfirmed).toBeGreaterThanOrEqual(0.85);
  });

  it('E=6: power increases with samples (delta=0.3)', () => {
    const s1 = cell(0.3, 6, 1).pConfirmed;
    const s5 = cell(0.3, 6, 5).pConfirmed;
    expect(s5).toBeGreaterThan(s1);
  });
});

// ---------------------------------------------------------------------------
// §5  Unclear rate under null (delta = 0)
// ---------------------------------------------------------------------------

describe('unclear rate under null (delta=0)', () => {
  it('E=6, S=1: P(unclear|delta=0) ≥ 0.75', () => {
    expect(cell(0, 6, 1).pUnclear).toBeGreaterThanOrEqual(0.75);
  });

  it('E=12, S=1: P(unclear|delta=0) ≥ 0.75', () => {
    expect(cell(0, 12, 1).pUnclear).toBeGreaterThanOrEqual(0.75);
  });

  it('P(confirmed) + P(refuted) + P(unclear) = 1 for every cell', () => {
    for (const c of cells) {
      expect(c.pConfirmed + c.pRefuted + c.pUnclear).toBeCloseTo(1, 5);
    }
  });
});

// ---------------------------------------------------------------------------
// §6  Monotonicity: power grows with episodes (fixed samples, delta=0.3)
// ---------------------------------------------------------------------------

describe('power monotonicity (delta=0.3)', () => {
  it('E=3 → E=12 power at S=3 is non-decreasing', () => {
    const p3 = cell(0.3, 3, 3).pConfirmed;
    const p6 = cell(0.3, 6, 3).pConfirmed;
    const p12 = cell(0.3, 12, 3).pConfirmed;
    // Allow 5pp Monte Carlo slack.
    expect(p6).toBeGreaterThan(p3 - 0.05);
    expect(p12).toBeGreaterThan(p6 - 0.05);
  });
});
