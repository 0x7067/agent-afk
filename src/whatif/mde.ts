/**
 * Minimum-detectable-effect (MDE) helpers for the what-if verify phase.
 *
 * ## Statistical assumptions
 *
 * - Two-proportion z-test, two-sided alpha = 0.05 (z_α/2 = 1.96).
 * - 80% power (z_β = 0.8416).
 * - Worst-case variance: p = 0.5 on both arms → variance = p(1-p) = 0.25.
 * - Episodes are treated as independent units (not graded outputs), so `n`
 *   is the episode count per arm, not the sample × episode product.
 *
 * Formula:
 *   mde(n) = (z_α/2 + z_β) × √(2 × 0.25 / n)
 *          = 2.8016 × √(0.5 / n)
 *
 * Inverse (episodes needed to detect a given MDE):
 *   nFor(mde) = ⌈2 × (z_α/2 + z_β)² × 0.25 / mde²⌉
 *             = ⌈2 × 7.849 × 0.25 / mde²⌉
 *
 * At n=20 → MDE ≈ 44pp; at n=200 → MDE ≈ 14pp.
 * 10pp requires ≈ 393 episodes per arm.
 *
 * @module whatif/mde
 */

import type { VerifyResult } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const Z_ALPHA = 1.96;   // two-sided 5%
const Z_BETA  = 0.8416; // 80% power
const Z_SUM   = Z_ALPHA + Z_BETA; // 2.8016

/** MDE threshold above which a limit bullet is emitted (10 percentage points). */
export const MDE_REPORT_THRESHOLD = 0.10;

// ---------------------------------------------------------------------------
// mdeForN — minimum detectable effect given n episodes per arm
// ---------------------------------------------------------------------------

/**
 * Returns the minimum detectable absolute rate difference (in [0, 1]) for a
 * given per-arm episode count, assuming 80% power and α = 0.05 two-sided.
 *
 * Uses worst-case variance (p = 0.5 on both arms).
 *
 * @param n  Episodes per arm. n ≤ 0 returns 1 (100 pp — nothing detectable).
 */
export function mdeForN(n: number): number {
  if (n <= 0) return 1;
  const raw = Z_SUM * Math.sqrt(2 * 0.25 / n);
  return Math.min(1, raw);
}

// ---------------------------------------------------------------------------
// nForMde — inverse: episodes per arm needed to detect a given MDE
// ---------------------------------------------------------------------------

/**
 * Returns the minimum per-arm episode count needed to detect an absolute rate
 * difference of `mde` (e.g. 0.10 for 10 pp), with 80% power and α = 0.05.
 *
 * @param mde  Absolute rate difference in (0, 1].
 */
export function nForMde(mde: number): number {
  if (mde <= 0) return Infinity;
  return Math.ceil(2 * Z_SUM * Z_SUM * 0.25 / (mde * mde));
}

// ---------------------------------------------------------------------------
// preflightMdeMessage — one-liner for the progress callback
// ---------------------------------------------------------------------------

/**
 * Returns the preflight MDE message for a given per-arm episode count.
 *
 * Example: "20 episodes/arm can detect ~44pp shifts or larger (80% power,
 * α=0.05); to detect 10pp shifts you need ~393 episodes/arm."
 */
export function preflightMdeMessage(episodesPerArm: number): string {
  const mdePp = Math.round(mdeForN(episodesPerArm) * 100);
  const nFor10 = nForMde(0.10);
  return (
    `${episodesPerArm} episodes/arm can detect ~${mdePp}pp shifts or larger ` +
    `(80% power, α=0.05); to detect 10pp shifts you need ~${nFor10} episodes/arm.`
  );
}

// ---------------------------------------------------------------------------
// mdeLimits — per-prediction report bullets when MDE > threshold
// ---------------------------------------------------------------------------

/**
 * Computes the per-arm episode count for one verified prediction.
 *
 * Prefers `scope.episodes.{baseline,candidate}` lengths (episode-level count,
 * as recommended by the issue), falling back to `min(rates.n)` divided by the
 * number of samples only when scope is absent (pre-#2403 results).
 */
function predEpisodesPerArm(
  vp: import('./types.js').VerifiedPrediction,
): number {
  if (vp.scope) {
    const nb = vp.scope.episodes.baseline.length;
    const nc = vp.scope.episodes.candidate.length;
    return Math.min(nb, nc);
  }
  // Fallback: rates.n is graded-output count (episodes × samples); use the
  // smaller arm and treat it as an episode count (conservative).
  return Math.min(vp.rates.n.baseline, vp.rates.n.candidate);
}

/**
 * Returns limit bullets for predictions whose per-arm MDE exceeds
 * {@link MDE_REPORT_THRESHOLD}.
 *
 * One bullet per prediction (or a combined bullet when many predictions share
 * the same n, to keep the report readable).
 */
export function mdeLimits(v: VerifyResult): string[] {
  const bullets: string[] = [];
  for (const vp of v.predictions) {
    const n = predEpisodesPerArm(vp);
    const mde = mdeForN(n);
    if (mde > MDE_REPORT_THRESHOLD) {
      const mdePp = Math.round(mde * 100);
      bullets.push(
        `Prediction ${vp.prediction.id} was scored on ${n} episode${n === 1 ? '' : 's'} per arm; ` +
        `it could only detect shifts of about ${mdePp}pp or more (80% power, α=0.05).`,
      );
    }
  }
  return bullets;
}
