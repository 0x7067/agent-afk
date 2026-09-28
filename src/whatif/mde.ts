/**
 * Minimum Detectable Effect (MDE) helpers for the what-if verify phase.
 *
 * ## Statistical assumptions
 *
 * Two-proportion z-test, worst-case baseline rate p = 0.5, α = 0.05
 * two-sided (z_α/2 = 1.96), power = 0.80 (z_β = 0.8416).
 *
 * The MDE formula is derived from the standard sample-size formula by solving
 * for the effect size d instead of n:
 *
 *   n = (z_α/2 + z_β)² · 2·p·(1-p) / d²
 *   ⟹ d = (z_α/2 + z_β) · sqrt(2·p·(1-p) / n)
 *        = (1.96 + 0.8416) · sqrt(0.5 / n)     [at p=0.5]
 *
 * This yields d ≈ 0.443 at n=20 and d ≈ 0.140 at n=200.
 *
 * For nForMde, solving for n:
 *   n = ceil((z_α/2 + z_β)² · 0.5 / d²)
 *     = ceil(0.5 · (1.96 + 0.8416)² / d²)
 *
 * These are optimistic lower-bounds when each observation is a *sample*
 * (episode × samples-per-episode) rather than an independent episode, since
 * pseudo-replication inflates the effective n without adding true information.
 * Callers that use sample counts should note this in user-facing text.
 *
 * @module whatif/mde
 */

const Z_ALPHA_HALF = 1.96; // 95% two-sided
const Z_BETA = 0.8416; // 80% power
const Z_SUM = Z_ALPHA_HALF + Z_BETA; // ≈ 2.8016

/**
 * Minimum detectable effect size (proportion-difference, in [0,1]) for a
 * given per-arm sample count n.
 *
 * @param n  Number of observations per arm.  Must be > 0; returns 1 for n ≤ 0.
 */
export function mdeForN(n: number): number {
  if (n <= 0) return 1;
  return Z_SUM * Math.sqrt(0.5 / n);
}

/**
 * Minimum per-arm sample count needed to detect a rate difference of at least
 * `d` (in [0,1]).
 *
 * @param d  Target effect size.  Returns Infinity for d ≤ 0.
 */
export function nForMde(d: number): number {
  if (d <= 0) return Infinity;
  return Math.ceil((0.5 * Z_SUM * Z_SUM) / (d * d));
}

/**
 * Format the preflight MDE line shown next to the cost estimate.
 *
 * Example:
 *   "20 episodes/arm can detect ~44pp shifts; to detect 10pp you need ~393 episodes/arm."
 *
 * @param episodes  Number of episodes planned per arm.
 */
export function formatPreflightMde(episodes: number): string {
  const mde = mdeForN(episodes);
  const mdePp = Math.round(mde * 100);
  const neededFor10pp = nForMde(0.10);
  return (
    `${episodes} episodes/arm can detect ~${mdePp}pp shifts; ` +
    `to detect 10pp you need ~${neededFor10pp} episodes/arm.`
  );
}

/**
 * Format the per-prediction MDE limit line shown in the report when n is
 * small enough that the MDE exceeds 10pp.
 *
 * When `optimistic` is true (n is a sample count, not independent episodes)
 * the text notes this is an optimistic floor.
 *
 * @param id         Prediction id, e.g. "p1".
 * @param n          Effective observation count per arm for this prediction.
 * @param optimistic When true, n counts samples rather than independent episodes.
 */
export function formatPredictionMdeLimit(id: string, n: number, optimistic: boolean): string {
  const mde = mdeForN(n);
  const mdePp = Math.round(mde * 100);
  const suffix = optimistic
    ? ` (optimistic floor — n counts samples, not independent episodes)`
    : '';
  return `${id}: with n=${n} this run can detect ~${mdePp}pp shifts or larger${suffix}.`;
}
