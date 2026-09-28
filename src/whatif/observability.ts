/**
 * Observability helpers for the what-if prediction engine.
 *
 * An intercepted action (episode-gate verdict 'recorded') means the agent
 * CHOSE to do that action; the experiment stopped it before it executed.
 * When a prediction's would-be verdict is `refuted` AND the prediction's
 * episodes show intercepted calls in BOTH arms (baseline and candidate),
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
 * Return a reason string if a `refuted` verdict should be downgraded to
 * `unobservable`, or `undefined` if the verdict stands.
 *
 * Downgrade conditions (ALL must hold):
 *   1. The would-be verdict is `refuted`.
 *   2. At least one trace in the baseline arm for the prediction's episodes
 *      contains an intercepted tool call (`verdict === 'recorded'`).
 *   3. At least one trace in the candidate arm for the prediction's episodes
 *      contains an intercepted tool call.
 *
 * When both arms show intercepted calls the behavior lies past the episode
 * boundary; neither arm got to complete the action so the judge scored intent
 * absence as a numeric low probability, which rounded to `refuted` even though
 * both agents would have done the thing.
 *
 * @param wouldBeVerdict  Verdict produced by `verdictFor`.
 * @param episodeIds      Episode ids this prediction targeted (from `ep.targets`).
 * @param traces          The full trace list for the prediction's episodes.
 */
export function unobservableReason(
  wouldBeVerdict: Verdict,
  episodeIds: ReadonlyArray<string>,
  traces: ReadonlyArray<EpisodeTrace>,
): string | undefined {
  if (wouldBeVerdict !== 'refuted') return undefined;

  // Filter to only the traces that belong to this prediction's episodes.
  const relevant = episodeIds.length > 0
    ? traces.filter((t) => episodeIds.includes(t.episodeId))
    : traces;

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
 * behavior lies past the episode gate in both arms.
 *
 * Returns `{ verdict, unobservableReason }` — unchanged when no downgrade
 * applies (the `reason` field is always `undefined` for non-unobservable
 * verdicts).
 */
export function applyObservability(
  wouldBeVerdict: Verdict,
  episodeIds: ReadonlyArray<string>,
  traces: ReadonlyArray<EpisodeTrace>,
): { verdict: Verdict; unobservableReason?: string } {
  const reason = unobservableReason(wouldBeVerdict, episodeIds, traces);
  if (reason !== undefined) {
    return { verdict: 'unobservable', unobservableReason: reason };
  }
  return { verdict: wouldBeVerdict };
}
