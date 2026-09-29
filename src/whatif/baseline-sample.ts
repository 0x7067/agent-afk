/**
 * Baseline-sample preflight for the what-if prediction engine (#2511).
 *
 * Before the full episode run, this module runs the BASELINE arm only on up
 * to K=3 probe episodes (1 sample each) per prediction, grades each
 * prediction's testQuestion on those probes, and computes the measured
 * headroom. The measured headroom replaces the analyst-estimate headroom check
 * for each prediction when sampling is enabled.
 *
 * Conservative gate: use the most optimistic sampled probe result.
 *   - added/strengthened: headroom = 1 − min(P(yes))  (most room to increase)
 *   - removed/weakened:   headroom = max(P(yes))       (most room to decrease)
 *
 * The gate trips when that headroom < MDE and uses the same WhatifMdeError /
 * --force semantics as the analyst-estimate check.
 *
 * NOTE: sample episodes are NOT reused in the final statistics (§4 of the
 * design). Keeping the arms paired and balanced requires that the final
 * verifyRun uses the full episode set untouched by the sample run.
 *
 * @module whatif/baseline-sample
 */

import { mdeForN, headroomForPrediction, headroomPreflightLine } from './mde.js';
import { renderTrace } from './trace-render.js';
import { estimateVerifyCost } from './cost.js';
import { WhatifMdeError } from './run.js';
import type {
  AgentRunner,
  Episode,
  EpisodeTrace,
  Judge,
  JudgeInput,
  Prediction,
  RunnerOptions,
  Environment,
  WhatifProgress,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of probe episodes to sample per prediction. */
export const BASELINE_SAMPLE_K = 3;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Per-prediction result from the baseline-sample preflight.
 * Recorded in results.json under verify.baselineSample.
 */
export interface PredictionBaselineSample {
  /** Prediction id. */
  predictionId: string;
  /** P(yes) scores from the sampled baseline probes. */
  probeRates: number[];
  /** Mean P(yes) across sampled probes. */
  mean: number;
  /**
   * Most optimistic headroom:
   *   added/strengthened: 1 − min(probeRates)
   *   removed/weakened:   max(probeRates)
   */
  optimisticHeadroom: number;
  /** Achieved MDE at K probes per prediction per arm. */
  mde: number;
  /** Whether the headroom gate tripped for this prediction. */
  tripped: boolean;
}

/** Aggregate result returned from runBaselineSample. */
export interface BaselineSampleResult {
  perPrediction: PredictionBaselineSample[];
  /** True if any prediction tripped the headroom gate. */
  anyTripped: boolean;
}

// ---------------------------------------------------------------------------
// Cost helper
// ---------------------------------------------------------------------------

/**
 * Estimate the additional USD cost for one baseline-sample run.
 *
 * K samples × predictions.length probe episodes, baseline arm only, 1 sample
 * each.  Judge calls: K × predictions.length × 1 env × 1 sample.
 * Uses the full estimateVerifyCost function with the baseline system tokens.
 */
export function estimateBaselineSampleCost(input: {
  predictions: Prediction[];
  agentModel: string;
  analystModel: string;
  systemTokensBaseline: number;
  judgeExternal: boolean;
}): number {
  // We run K probes per prediction baseline-only with 1 sample.
  // Reuse estimateVerifyCost with episodes = K * nPredictions, samples = 1,
  // but half the cost (baseline only, no candidate arm).
  const totalProbes = input.predictions.length * BASELINE_SAMPLE_K;
  const fullCost = estimateVerifyCost({
    episodes: totalProbes,
    samples: 1,
    agentModel: input.agentModel,
    analystModel: input.analystModel,
    systemTokens: {
      baseline: input.systemTokensBaseline,
      candidate: input.systemTokensBaseline, // estimate uses symmetric value
    },
    judgeExternal: input.judgeExternal,
  });
  // Baseline-only: agent cost is ~½ (only baseline arm runs); judge cost is
  // still per output (1 baseline output per probe).
  return fullCost.usd / 2 + (fullCost.breakdown['judge'] ?? 0) / 2;
}

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

/**
 * Run the baseline-sample preflight for all predictions.
 *
 * For each prediction, runs up to K=3 of its probe episodes against the
 * baseline arm only (1 sample each), grades with the judge, and computes
 * the per-prediction headroom. Prints one info line per prediction, and a
 * warning line when the gate trips.
 *
 * Throws WhatifMdeError when any prediction trips and force=false.
 * When force=true, prints the warning but continues.
 */
export async function runBaselineSample(input: {
  predictions: Prediction[];
  episodes: Episode[];
  baseline: Environment;
  runner: AgentRunner;
  judge: Judge;
  runnerOpts: RunnerOptions;
  force: boolean;
  signal?: AbortSignal;
  onProgress?: (p: WhatifProgress) => void;
}): Promise<BaselineSampleResult> {
  const { predictions, episodes, baseline, runner, judge, runnerOpts, force, signal, onProgress } = input;

  const mde = mdeForN(BASELINE_SAMPLE_K);
  const perPrediction: PredictionBaselineSample[] = [];
  let anyTripped = false;

  for (const pred of predictions) {
    if (signal?.aborted) break;

    // Select up to K probe episodes targeting this prediction.
    const probeEps = episodes
      .filter((e) => e.targets === pred.id && e.source === 'synthetic')
      .slice(0, BASELINE_SAMPLE_K);

    if (probeEps.length === 0) {
      // No targeted probes — skip this prediction silently.
      continue;
    }

    // Run baseline arm only, 1 sample, for each probe.
    const probeRates: number[] = [];
    for (const ep of probeEps) {
      if (signal?.aborted) break;
      let trace: EpisodeTrace;
      try {
        trace = await runner.run(baseline, ep, 0 /* sample=0 */, runnerOpts);
      } catch {
        // Non-fatal: skip this probe.
        continue;
      }
      if (trace.error) continue;

      // Grade the prediction's testQuestion on this trace.
      const judgeInput: JudgeInput = {
        prompt: ep.prompt,
        output: renderTrace(trace),
        questions: [{ id: pred.id, question: pred.testQuestion }],
      };
      let score: number | undefined;
      try {
        const result = await judge.grade(judgeInput, signal);
        score = result[pred.id];
      } catch {
        // Non-fatal: skip.
      }
      if (score !== undefined) probeRates.push(score);
    }

    if (probeRates.length === 0) continue;

    const mean = probeRates.reduce((a, b) => a + b, 0) / probeRates.length;

    // Conservative gate: most optimistic headroom.
    const optimisticBaselineRate =
      pred.direction === 'added' || pred.direction === 'strengthened'
        ? Math.min(...probeRates)  // lowest baseline → most room to increase
        : Math.max(...probeRates); // highest baseline → most room to decrease

    const optimisticHeadroom = headroomForPrediction(optimisticBaselineRate, pred.direction) ?? 0;
    const tripped = optimisticHeadroom < mde;

    // Print info line: sampled baseline mean over n probes.
    const meanPct = Math.round(mean * 100);
    const n = probeRates.length;
    onProgress?.({
      stage: 'preflight',
      message:
        `Prediction ${pred.id} baseline sample (${n} probe${n === 1 ? '' : 's'}): ` +
        `mean P(yes)=${meanPct}%`,
    });

    if (tripped) {
      anyTripped = true;
      const headroomPp = Math.round(optimisticHeadroom * 100);
      const mdePp = Math.round(mde * 100);
      onProgress?.({
        stage: 'preflight',
        message:
          `Prediction ${pred.id} (${pred.direction}): measured baseline mean ${meanPct}%, ` +
          `optimistic headroom ${headroomPp}pp < MDE ${mdePp}pp — underpowered.`,
      });
      if (!force) {
        const narrowed = { ...pred, baselineEstimate: optimisticBaselineRate };
        const line = headroomPreflightLine(narrowed, BASELINE_SAMPLE_K);
        throw new WhatifMdeError(
          BASELINE_SAMPLE_K,
          `${line} More probes will not fix this; choose probes where the baseline leaves room, or use --force.`,
          { kind: 'headroom', predictionId: pred.id },
        );
      }
    }

    perPrediction.push({
      predictionId: pred.id,
      probeRates,
      mean,
      optimisticHeadroom,
      mde,
      tripped,
    });
  }

  return { perPrediction, anyTripped };
}
