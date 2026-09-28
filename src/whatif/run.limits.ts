/**
 * Plain-English caveats for a verify run that did not measure everything it
 * set out to: failed episodes, ungraded outputs, a budget stop, and per-
 * prediction minimum-detectable-effect limits when the MDE exceeds 10pp.
 *
 * @module whatif/run.limits
 */

import type { VerifyResult } from './types.js';
import { formatPredictionMdeLimit, mdeForN } from './mde.js';

/** Threshold above which we surface an MDE limit (10 percentage points). */
const MDE_WARN_THRESHOLD = 0.10;

export function verifyShortfallLimits(v: VerifyResult): string[] {
  const out: string[] = [];
  if (v.failedEpisodes > 0) {
    out.push(`${v.failedEpisodes} episode run(s) failed and were left out of every measurement.`);
  }
  if ((v.judgeFailures ?? 0) > 0) {
    out.push(`${v.judgeFailures} output(s) could not be graded by the ${v.judge.name} judge and were left out.`);
  }
  if (v.truncatedByBudget) {
    out.push('The run stopped early at the spending cap, so fewer episodes were measured than planned.');
  }

  // Per-prediction MDE limits — only when MDE > 10pp.
  // n counts samples (episodes × samples/episode), not independent episodes,
  // so this is an optimistic floor. We note that in the limit text.
  for (const vp of v.predictions) {
    const n = Math.min(vp.rates.n.baseline, vp.rates.n.candidate);
    if (mdeForN(n) > MDE_WARN_THRESHOLD) {
      out.push(formatPredictionMdeLimit(vp.prediction.id, n, /* optimistic= */ true));
    }
  }

  return out;
}
