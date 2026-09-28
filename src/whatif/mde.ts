/**
 * Minimum-detectable-effect (MDE) helper for the what-if prediction engine.
 *
 * ## Statistical basis
 *
 * The upstream PR (#2473) uses the Newcombe hybrid-score CI over per-episode
 * mean scores.  For the MDE approximation we adopt the standard Wilson-score
 * half-width at p = 0.5 (worst-case variance), which is consistent with that
 * interval's derivation and gives a conservative bound.
 *
 * For a balanced two-arm comparison at z = 1.96 (95% coverage):
 *
 *   se(p̂) ≈ sqrt(p(1-p)/n)  → worst case at p = 0.5: sqrt(0.25/n)
 *
 * The Newcombe CI half-width for the difference is approximately:
 *
 *   hw ≈ z × sqrt(se_baseline² + se_candidate²)
 *       = 1.96 × sqrt(0.25/n + 0.25/n)
 *       = 1.96 × sqrt(0.5/n)
 *
 * MDE (the smallest detectable shift) ≈ 2 × hw (so both tails clear zero):
 *
 *   MDE ≈ 2 × 1.96 × sqrt(0.5/n)  ≈ 2.77 / sqrt(n)
 *
 * Inverting: n ≥ ceil((2 × 1.96)² × 0.5 / MDE²) = ceil(7.6832 / MDE²)
 *
 * All rates are in [0,1]; pp values use 0.10 = 10 percentage points.
 *
 * @module whatif/mde
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * MDE threshold above which the preflight hard gate fires (default 20 pp).
 * Expressed as a proportion in [0,1].
 */
export const MDE_GATE_THRESHOLD = 0.20;

/** Minimum episode count below which a gate warning is printed regardless. */
const MIN_DISPLAY_N = 1;

// z-score for 95% coverage.
const Z = 1.96;

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Compute the approximate MDE (proportion, not pp) for a given episode count
 * per arm, assuming worst-case variance (p = 0.5) and a balanced design.
 *
 * Returns a value in [0, 1].  For n = 0 returns 1 (no information).
 * Clamped to 1 for very small n (where the formula would exceed 100%).
 *
 * Formula: MDE ≈ 2 × z × sqrt(0.5 / n)
 */
export function mdeForN(n: number): number {
  if (n <= 0) return 1;
  return Math.min(1, 2 * Z * Math.sqrt(0.5 / n));
}

/**
 * Compute the minimum episode count per arm needed to detect `mde` (a
 * proportion in [0, 1]) with 95% coverage.
 *
 * Formula: n ≥ ceil((2z)² × 0.5 / mde²)
 */
export function nForMde(mde: number): number {
  if (mde <= 0) return Infinity;
  if (mde >= 1) return 1;
  return Math.ceil((4 * Z * Z * 0.5) / (mde * mde));
}

// ---------------------------------------------------------------------------
// Human-readable helpers
// ---------------------------------------------------------------------------

function pp(proportion: number): string {
  return `${Math.round(proportion * 100)}pp`;
}

/**
 * One-line preflight summary: what the planned episode count can detect and
 * how many episodes would be needed to detect a given target.
 *
 * @param episodesPerArm  Number of episodes per arm in the planned run.
 * @param targetMde       Target MDE for the "you need N episodes" clause
 *                        (default 0.10 = 10 pp).
 */
export function mdePreflightLine(episodesPerArm: number, targetMde = 0.10): string {
  const achieved = mdeForN(episodesPerArm);
  const achievedPp = pp(achieved);
  const needed = nForMde(targetMde);
  const targetPp = pp(targetMde);
  if (episodesPerArm < MIN_DISPLAY_N) {
    return `No episodes planned; cannot estimate MDE.`;
  }
  return (
    `${episodesPerArm} episode${episodesPerArm === 1 ? '' : 's'}/arm can detect ` +
    `about ${achievedPp} shifts; to detect ${targetPp} you need about ${needed} episodes/arm.`
  );
}

/**
 * One-line report limit: the achieved MDE for a prediction that actually ran.
 * Returns undefined when the MDE is ≤ 10 pp (no warning needed).
 *
 * @param n      Episode count for one arm (min of baseline/candidate is used
 *               by convention since both arms must have data).
 * @param label  Short label for the prediction, e.g. "p1".
 */
export function mdeLimitLine(n: number, label: string): string | undefined {
  const achieved = mdeForN(n);
  if (achieved <= 0.10) return undefined;
  return (
    `Prediction ${label}: with n=${n} episodes/arm the run can detect shifts ` +
    `≥${pp(achieved)} (95% CI); smaller effects are undetectable at this size.`
  );
}

/**
 * True when the planned run's MDE exceeds the named gate threshold.
 * This is the condition that triggers the hard gate in the verify flow.
 */
export function isUnderpowered(episodesPerArm: number): boolean {
  return mdeForN(episodesPerArm) > MDE_GATE_THRESHOLD;
}

/**
 * Message to show when a `--verify` run is blocked by the MDE gate.
 */
export function mdeGateRefusedMessage(episodesPerArm: number): string {
  const achieved = pp(mdeForN(episodesPerArm));
  const needed = nForMde(MDE_GATE_THRESHOLD);
  return (
    `whatif: run is underpowered — ` +
    `${episodesPerArm} episode${episodesPerArm === 1 ? '' : 's'}/arm can only detect ` +
    `≥${achieved} shifts (threshold: ${pp(MDE_GATE_THRESHOLD)}). ` +
    `To proceed, use --force or collect at least ${needed} episodes/arm ` +
    `(increase --turns or add suites).`
  );
}
