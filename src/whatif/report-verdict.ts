/**
 * Verdict rendering helpers for the what-if report.
 *
 * Extracted from `report.ts` to keep that file within the 350-line limit and
 * to allow reuse across Markdown and terminal renderers.
 *
 * @module whatif/report-verdict
 */

import type { Verdict, VerifiedPrediction } from './types.js';

/**
 * Emoji for a verdict.
 *
 * - ✅ confirmed
 * - ❌ refuted
 * - 🔭 unobservable
 * - ⚪ unclear
 */
export function verdictEmoji(v: Verdict): string {
  if (v === 'confirmed') return '✅';
  if (v === 'refuted') return '❌';
  if (v === 'unobservable') return '🔭';
  return '⚪';
}

/**
 * Verdict text for a row: the bare verdict, or for `unobservable` the verdict
 * plus its one-line reason so the reader sees why it could not be scored.
 */
export function verdictLabel(vp: Pick<VerifiedPrediction, 'verdict' | 'unobservableReason'>): string {
  return vp.verdict === 'unobservable' && vp.unobservableReason
    ? `unobservable — ${vp.unobservableReason}`
    : vp.verdict;
}
