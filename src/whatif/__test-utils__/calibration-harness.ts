/**
 * Model-free calibration harness for `afk whatif --verify` verdict statistics.
 *
 * Drives `scorePrediction()` (src/whatif/run.verify.scoring.ts) with
 * synthetic `Episode[]`, `EpisodeTrace[]`, and `JudgeResults` using a
 * seeded PRNG so results are exactly reproducible without any model calls.
 *
 * ## Data model (hierarchical, as required)
 *
 * For each episode `e` in a grid cell:
 *   - Draw a per-episode baseline rate: `p_b_e ~ clip(Normal(baseRate, between))`.
 *   - Candidate rate: `p_c_e = clip(p_b_e + trueDelta, [0, 1])`.
 *   - Each sample `s` draws a Bernoulli(p_arm_e) score (the judge result).
 *
 * This hierarchy makes #2404 visible: samples from the same episode are
 * correlated through their shared `p_e`. Feeding independent arrays into
 * `compareRates` directly would hide the intra-cluster correlation.
 *
 * ## Intra-class correlation (ICC)
 *
 * The between-episode variability is controlled by `betweenEpisodeSd` (σ_b).
 * The resulting ICC is:
 *
 *   ICC ≈ σ_b² / (σ_b² + σ_w²)
 *
 * where σ_w² ≈ p(1-p) ≈ 0.25 is the within-episode (Bernoulli) variance at
 * baseRate=0.5.  Two ICC settings are pre-defined:
 *
 *   - LOW_ICC_SD  = 0.15 → ICC ≈ 0.083   (nearly independent episodes)
 *   - HIGH_ICC_SD = 0.40 → ICC ≈ 0.390   (strongly correlated replays)
 *
 * The high-ICC setting is required to expose #2404: when episodes are
 * strongly correlated, n-inflation from repeated samples artificially narrows
 * the CI and produces false refutes on null data.  At low ICC the between-
 * episode variance is too small to make the inflation consequential in
 * Monte Carlo, though the deterministic mechanism (n=30 vs n=6) is still
 * observable regardless of ICC.
 *
 * The realized ICC for each setting is reported in docs/whatif-calibration.md.
 *
 * ## Usage
 *
 * ```ts
 * import { runGrid, HIGH_ICC_SD, type GridCell } from
 *   '../__test-utils__/calibration-harness.js';
 *
 * const cells = runGrid({ reps: 200, seed: 42, betweenEpisodeSd: HIGH_ICC_SD });
 * ```
 *
 * @module whatif/__test-utils__/calibration-harness
 */

import { scorePrediction, traceKey, type JudgeResults } from '../run.verify.scoring.js';
import type { Episode, EpisodeTrace, Prediction, Verdict } from '../types.js';

// ---------------------------------------------------------------------------
// Seeded PRNG — Mulberry32 (fast, good statistical properties, small state)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

/** Standard Normal via Box-Muller (uses two uniform draws). */
function stdNormal(rand: () => number): number {
  const u = Math.max(1e-15, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// ---------------------------------------------------------------------------
// ICC presets
// ---------------------------------------------------------------------------

/**
 * Low ICC between-episode σ.  ICC ≈ 0.15² / (0.15² + 0.25) ≈ 0.083.
 * Episodes are nearly independent.  Use as a baseline / sanity check.
 */
export const LOW_ICC_SD = 0.15;

/**
 * High ICC between-episode σ.  ICC ≈ 0.40² / (0.40² + 0.25) ≈ 0.390.
 * Episodes share substantial latent variance, mirroring real agent replay
 * behaviour.  Required to expose the Monte Carlo consequence of #2404.
 */
export const HIGH_ICC_SD = 0.40;

/**
 * Compute the theoretical ICC for a given between-episode σ, assuming
 * baseRate=0.5 (maximises within-episode Bernoulli variance = 0.25).
 *
 * ICC = σ_b² / (σ_b² + σ_w²),  σ_w² ≈ baseRate*(1-baseRate).
 */
export function theoreticalICC(betweenEpisodeSd: number, baseRate = 0.5): number {
  const sigmaBSq = betweenEpisodeSd ** 2;
  const sigmaWSq = baseRate * (1 - baseRate);
  return sigmaBSq / (sigmaBSq + sigmaWSq);
}

// ---------------------------------------------------------------------------
// Grid axes
// ---------------------------------------------------------------------------

export const TRUE_DELTAS = [0, 0.1, 0.3] as const;
export const EPISODE_COUNTS = [3, 6, 12] as const;
export const SAMPLE_COUNTS = [1, 3, 5] as const;

export type TrueDelta = (typeof TRUE_DELTAS)[number];
export type EpisodeCount = (typeof EPISODE_COUNTS)[number];
export type SampleCount = (typeof SAMPLE_COUNTS)[number];

// ---------------------------------------------------------------------------
// Cell result
// ---------------------------------------------------------------------------

/** Verdict distribution over Monte Carlo repetitions for one grid cell. */
export interface VerdictDistribution {
  confirmed: number;
  refuted: number;
  unclear: number;
  /** Number of repetitions that produced this distribution. */
  reps: number;
}

/** One cell in the calibration grid. */
export interface GridCell {
  trueDelta: TrueDelta;
  episodes: EpisodeCount;
  samples: SampleCount;
  dist: VerdictDistribution;
  /** P(confirmed | cell). */
  pConfirmed: number;
  /** P(refuted | cell). */
  pRefuted: number;
  /** P(unclear | cell). */
  pUnclear: number;
}

// ---------------------------------------------------------------------------
// Harness options
// ---------------------------------------------------------------------------

export interface HarnessOptions {
  /**
   * Monte Carlo repetitions per grid cell.
   * @default 400
   */
  reps?: number;
  /**
   * Seed for the PRNG; same seed → same results.
   * @default 42
   */
  seed?: number;
  /**
   * Base rate for the baseline arm (population mean p_b).
   * @default 0.5
   */
  baseRate?: number;
  /**
   * Between-episode std-dev of latent rates (spread around baseRate).
   * Controls intra-cluster correlation (ICC).  Use {@link LOW_ICC_SD} (0.15,
   * ICC≈0.08) or {@link HIGH_ICC_SD} (0.40, ICC≈0.39).  Higher ICC makes the
   * #2404 n-inflation effect visible in Monte Carlo.
   * @default LOW_ICC_SD (0.15)
   */
  betweenEpisodeSd?: number;
  /**
   * Direction of the prediction under test. Only 'added' and 'removed'
   * are calibrated here (symmetric).
   * @default 'added'
   */
  direction?: 'added' | 'removed';
}

// ---------------------------------------------------------------------------
// Core simulation
// ---------------------------------------------------------------------------

/** Synthesise the objects that `scorePrediction` expects, run it, return verdict. */
function simulateOnce(
  rand: () => number,
  trueDelta: number,
  numEpisodes: number,
  numSamples: number,
  baseRate: number,
  betweenEpisodeSd: number,
  direction: 'added' | 'removed',
): Verdict {
  const predId = 'p_cal';
  const signedDelta = direction === 'added' ? trueDelta : -trueDelta;

  const prediction: Prediction = {
    id: predId,
    behavior: 'calibration behavior',
    direction,
    confidence: 'medium',
    reason: 'harness',
    testQuestion: 'Does the output show the calibration behavior?',
    probes: [],
  };

  const episodes: Episode[] = [];
  const traces: EpisodeTrace[] = [];
  const judgeResults: JudgeResults = new Map();

  for (let e = 0; e < numEpisodes; e++) {
    const epId = `ep_${e}`;
    // Mark as targeted synthetic probe so scorePrediction counts it.
    episodes.push({ id: epId, source: 'synthetic', prompt: `probe ${e}`, targets: predId });

    // Per-episode latent rates (hierarchical model).
    const latent = clamp01(baseRate + stdNormal(rand) * betweenEpisodeSd);
    const pBaseline = latent;
    const pCandidate = clamp01(latent + signedDelta);

    for (let s = 0; s < numSamples; s++) {
      // Baseline trace + judge result.
      const bTrace: EpisodeTrace = {
        episodeId: epId,
        env: 'baseline',
        sample: s,
        text: '',
        tools: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      };
      traces.push(bTrace);
      judgeResults.set(traceKey(bTrace), {
        [predId]: rand() < pBaseline ? 1 : 0,
      });

      // Candidate trace + judge result.
      const cTrace: EpisodeTrace = {
        episodeId: epId,
        env: 'candidate',
        sample: s,
        text: '',
        tools: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      };
      traces.push(cTrace);
      judgeResults.set(traceKey(cTrace), {
        [predId]: rand() < pCandidate ? 1 : 0,
      });
    }
  }

  const result = scorePrediction(prediction, episodes, traces, judgeResults);
  return result.verdict;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the full calibration grid and return one {@link GridCell} per
 * (trueDelta × episodes × samples) combination.
 */
export function runGrid(opts: HarnessOptions = {}): GridCell[] {
  const {
    reps = 400,
    seed = 42,
    baseRate = 0.5,
    betweenEpisodeSd = LOW_ICC_SD,
    direction = 'added',
  } = opts;

  const rand = mulberry32(seed);
  const cells: GridCell[] = [];

  for (const trueDelta of TRUE_DELTAS) {
    for (const episodes of EPISODE_COUNTS) {
      for (const samples of SAMPLE_COUNTS) {
        const dist: VerdictDistribution = { confirmed: 0, refuted: 0, unclear: 0, reps };

        for (let r = 0; r < reps; r++) {
          const v = simulateOnce(
            rand,
            trueDelta,
            episodes,
            samples,
            baseRate,
            betweenEpisodeSd,
            direction,
          );
          if (v === 'confirmed') dist.confirmed++;
          else if (v === 'refuted') dist.refuted++;
          else dist.unclear++;
        }

        cells.push({
          trueDelta,
          episodes,
          samples,
          dist,
          pConfirmed: dist.confirmed / reps,
          pRefuted: dist.refuted / reps,
          pUnclear: dist.unclear / reps,
        });
      }
    }
  }

  return cells;
}

/**
 * Look up a specific cell from the grid result.
 */
export function findCell(
  cells: GridCell[],
  trueDelta: TrueDelta,
  episodes: EpisodeCount,
  samples: SampleCount,
): GridCell | undefined {
  return cells.find(
    (c) => c.trueDelta === trueDelta && c.episodes === episodes && c.samples === samples,
  );
}

/**
 * Render the grid as a Markdown table.
 * Columns: trueDelta | episodes | samples | P(confirmed) | P(refuted) | P(unclear)
 */
export function renderMarkdownTable(cells: GridCell[]): string {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  const header = [
    '| true_delta | episodes | samples | P(confirmed) | P(refuted) | P(unclear) |',
    '|:----------:|:--------:|:-------:|:------------:|:----------:|:----------:|',
  ];
  const rows = cells.map(
    (c) =>
      `| ${c.trueDelta.toFixed(1)} | ${c.episodes} | ${c.samples} | ${pct(c.pConfirmed)} | ${pct(c.pRefuted)} | ${pct(c.pUnclear)} |`,
  );
  return [...header, ...rows].join('\n');
}
