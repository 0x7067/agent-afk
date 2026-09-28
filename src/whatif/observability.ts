/**
 * Observability helpers for the what-if prediction engine.
 *
 * An intercepted action (episode-gate verdict 'recorded') means the agent
 * CHOSE to do that action; the experiment stopped it before it executed.
 * When a prediction's would-be verdict is `refuted` AND the prediction's own
 * scored probe episodes (`VerifiedPrediction.scope.episodes`, #2403) show
 * intercepted calls in BOTH arms (baseline and candidate),
 * the real verdict is `unobservable` — the behavior lies past the episode
 * boundary and cannot be confirmed or refuted from what the judge saw.
 *
 * @module whatif/observability
 */

import type { EpisodeTrace, Verdict } from './types.js';

// ---------------------------------------------------------------------------
// Shared judge rule text
// ---------------------------------------------------------------------------

/**
 * Instruction injected into every judge so it grades intercepted tool
 * requests as intent rather than completion.
 *
 * Both the Claude judge system prompt and the Jev state preamble include
 * this verbatim.
 */
export const INTERCEPTED_INTENT_RULE =
  "A line of the form `[tool requested: X (not executed)]` means the agent chose" +
  ' to call X but the experiment stopped it before it ran.' +
  ' Treat it as the agent doing X: grade intent, not completion.';

// ---------------------------------------------------------------------------
// unobservableReason
// ---------------------------------------------------------------------------

/**
 * Per-arm episode ids a prediction was scored on. Pass
 * `VerifiedPrediction.scope.episodes` as computed by `scorePrediction` in
 * `./run.verify.scoring.ts`, the single source of truth for which episodes
 * back a verdict (#2403). Never recompute this set here.
 */
export type ScoredEpisodes = Readonly<{
  baseline: ReadonlyArray<string>;
  candidate: ReadonlyArray<string>;
}>;

/**
 * Return a reason string if a `refuted` verdict should be downgraded to
 * `unobservable`, or `undefined` if the verdict stands.
 *
 * Downgrade conditions (ALL must hold):
 *   1. The would-be verdict is `refuted`.
 *   2. At least one baseline trace from an episode in `scored.baseline`
 *      contains an intercepted tool call (`verdict === 'recorded'`).
 *   3. At least one candidate trace from an episode in `scored.candidate`
 *      contains an intercepted tool call.
 *
 * Only the prediction's own scored probes count: an intercept in any other
 * episode (replayed turns, other predictions' probes) says nothing about this
 * prediction. An empty scope never downgrades; `scorePrediction` already
 * forces an arm with no graded output to `unclear` (#2403), and that stays
 * `unclear`.
 *
 * When both arms show intercepted calls the behavior lies past the episode
 * boundary; neither arm got to complete the action so the judge scored intent
 * absence as a numeric low probability, which rounded to `refuted` even though
 * both agents would have done the thing.
 *
 * @param wouldBeVerdict  Verdict after `verdictFor` and the empty-sample guard.
 * @param scored          Per-arm episode ids the verdict was scored on.
 * @param traces          Successful traces for the run (filtered here).
 */
export function unobservableReason(
  wouldBeVerdict: Verdict,
  scored: ScoredEpisodes,
  traces: ReadonlyArray<EpisodeTrace>,
): string | undefined {
  if (wouldBeVerdict !== 'refuted') return undefined;

  const relevant = traces.filter((t) => scored[t.env].includes(t.episodeId));

  const hasIntercepted = (env: 'baseline' | 'candidate'): boolean =>
    relevant.some(
      (t) => t.env === env && t.tools.some((tool) => tool.verdict === 'recorded'),
    );

  if (!hasIntercepted('baseline') || !hasIntercepted('candidate')) return undefined;

  // Collect the distinct tool names that were intercepted (for the reason string).
  const interceptedTools = new Set<string>();
  for (const t of relevant) {
    for (const tool of t.tools) {
      if (tool.verdict === 'recorded') interceptedTools.add(tool.tool);
    }
  }

  const toolList = [...interceptedTools].sort().join(', ');
  return `behavior lies past the episode boundary (intercepted in both arms: ${toolList})`;
}

// ---------------------------------------------------------------------------
// applyObservability
// ---------------------------------------------------------------------------

/**
 * Downgrade a `refuted` verdict to `unobservable` when the prediction's
 * behavior lies past the episode gate in both arms of its scored probes.
 *
 * Returns `{ verdict, unobservableReason }` — unchanged when no downgrade
 * applies (the `reason` field is always `undefined` for non-unobservable
 * verdicts).
 */
export function applyObservability(
  wouldBeVerdict: Verdict,
  scored: ScoredEpisodes,
  traces: ReadonlyArray<EpisodeTrace>,
): { verdict: Verdict; unobservableReason?: string } {
  const reason = unobservableReason(wouldBeVerdict, scored, traces);
  if (reason !== undefined) {
    return { verdict: 'unobservable', unobservableReason: reason };
  }
  return { verdict: wouldBeVerdict };
}
