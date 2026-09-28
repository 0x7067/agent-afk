/**
 * Level-1 prediction: given a structural impact summary, produce up to 8
 * predicted behavior changes.
 *
 * One model call. Output is validated against the Prediction schema; invalid
 * entries are dropped. Each prediction is tagged `observable: 'decision' |
 * 'downstream'` here, before any episode runs (#2409); a missing or invalid
 * tag defaults to `'decision'`. The model is instructed to return an empty list when
 * the change has no plausible behavioral effect (no filler).
 *
 * @module whatif/predict
 */

import { z } from 'zod';
import { extractJsonAs } from './json-extract.js';
import type { CompleteFn, Prediction, StructuralImpact } from './types.js';
import type { RepoManifest } from './repo-manifest.js';
import { formatRepoManifest } from './repo-manifest.js';

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const PredictionSchema = z.object({
  id: z.string(),
  behavior: z.string(),
  direction: z.enum(['added', 'removed', 'strengthened', 'weakened']),
  confidence: z.enum(['high', 'medium', 'low']),
  reason: z.string(),
  testQuestion: z.string(),
  probes: z.array(z.string()).min(1).max(2),
  // Lenient (#2409): a missing or invalid tag never drops the prediction; it
  // is normalized to 'decision' by `withObservability`.
  observable: z.unknown().optional(),
  observabilityReason: z.unknown().optional(),
});

/**
 * Normalize the predict-time observability tag. Anything but `'downstream'`
 * becomes `'decision'` (backward compatible); a reason is kept only for a
 * downstream prediction and only when it is a non-empty string.
 */
function withObservability(
  entry: z.infer<typeof PredictionSchema>,
  id: string,
): Prediction {
  const { observable, observabilityReason, ...rest } = entry;
  if (observable !== 'downstream') return { ...rest, id, observable: 'decision' };
  const reason = typeof observabilityReason === 'string' ? observabilityReason.trim() : '';
  return { ...rest, id, observable: 'downstream', ...(reason ? { observabilityReason: reason } : {}) };
}

const RawPredictionsArraySchema = z.array(z.unknown());

// ---------------------------------------------------------------------------
// System prompt helpers
// ---------------------------------------------------------------------------

/** Truncate a string to maxChars keeping head and tail when over limit. */
function headTail(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const half = Math.floor(maxChars / 2);
  return `${s.slice(0, half)}\n…[truncated]…\n${s.slice(s.length - half)}`;
}

const SYSTEM = `You are a behavioral prediction assistant for agent-afk's what-if engine.

Your job: given a description of a change to an AI agent's environment, predict
how the agent's behavior will change. Return a JSON array of Prediction objects.

## Rules

- Return at most 8 predictions.
- Return an empty array [] when the change has no plausible behavioral effect.
- Never pad with filler predictions to reach a count. An empty list is correct output.
- Each prediction must have a POSITIVELY framed testQuestion answerable from a
  single agent output. Phrase as "Does the response …?" — never "Is it too …?".
- probes: 1-2 realistic user requests that would exercise the predicted behavior.
  When a ## Repo context section is present below, probes MUST reference only paths
  listed there, or no specific file paths at all. Never invent file names.
- confidence must be honest: high only when the causal link is clear from the diff.
- Ids must be p1, p2, … pN (sequential, no gaps).
- observable: REQUIRED. Tag every prediction "decision" or "downstream" (see below).

## Observability (decide before any data exists)

Verification runs each probe as a single decision-only turn. Read-only tools
run normally. The FIRST side-effecting request (write/edit a file, mutating
shell command, spawning a subagent or skill, network write, git push) is
recorded as the agent's decision and NOT executed; the turn stops there. The
grader sees the request itself, e.g. "[tool requested: agent (not executed)]",
and counts it as the agent doing that thing.

- "decision": the behavior is visible in what the agent chooses, says,
  requests, or proposes in its turn, up to and including that first
  side-effecting request. Examples: asks a clarifying question before acting;
  spawns a subagent when asked to; edits the file directly instead of
  explaining; runs the tests before editing; refuses; answers without tools;
  response tone or length.
- "downstream": the behavior only shows once an intercepted action COMPLETES,
  or in its results. Examples: the tests pass after the fix; the written file
  content is correct; the subagent finds the bug; total task cost or turn
  count; how the agent behaves after verifying its change.

When unsure, prefer rephrasing the testQuestion to ask about the decision
(e.g. "Does the response request a subagent?" rather than "Does the subagent
find the bug?"). Tag "downstream" only when no decision-level question
captures the behavior. For "downstream", add observabilityReason: one short
line naming the action that would have to complete. Downstream predictions are
reported as unobservable and never count as confirmed or refuted.

## Output format

Respond with ONLY a JSON array (no prose, no fences):
[{"id":"p1","behavior":"…","direction":"added"|"removed"|"strengthened"|"weakened",
  "confidence":"high"|"medium"|"low","reason":"…","testQuestion":"Does the response …?",
  "probes":["…","…"],"observable":"decision"|"downstream",
  "observabilityReason":"… (downstream only)"}, …]`;

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export interface PredictInput {
  spec: { title: string; changes: unknown[] };
  changeDescriptions: string[];
  structural: StructuralImpact;
  trackRecord?: string;
  /** Optional repo manifest used to ground probes in real paths. */
  repoManifest?: RepoManifest;
}

// ---------------------------------------------------------------------------
// Predictor
// ---------------------------------------------------------------------------

/**
 * Generate up to 8 behavioral predictions for the proposed change.
 *
 * Returns an empty array when the model determines the change has no
 * behavioral effect. Invalid prediction entries are silently dropped.
 */
export async function predictChanges(
  input: PredictInput,
  complete: CompleteFn,
  model: string,
): Promise<Prediction[]> {
  const { spec, changeDescriptions, structural, trackRecord, repoManifest } = input;

  // Build a concise summary of the structural diff.
  const systemDiffSnippet = headTail(structural.systemDiff || '(no system prompt diff)', 12000);

  const sections: string[] = [
    `## Change spec\nTitle: ${spec.title}\n${changeDescriptions.map((d, i) => `  ${i + 1}. ${d}`).join('\n')}`,
    `## System prompt diff (truncated to ~12k chars)\n${systemDiffSnippet}`,
    `## Tools\nAdded: ${structural.toolsAdded.join(', ') || 'none'}\nRemoved: ${structural.toolsRemoved.join(', ') || 'none'}\nChanged: ${structural.toolsChanged.join(', ') || 'none'}`,
    `## User message diff\n${structural.userMessageDiff || '(no diff)'}`,
    `## Model changed: ${structural.modelChanged ? 'yes' : 'no'}`,
    `## Token delta: ${structural.tokens.candidate - structural.tokens.baseline > 0 ? '+' : ''}${structural.tokens.candidate - structural.tokens.baseline} tokens`,
  ];

  if (trackRecord) {
    sections.push(`## Engine track record (calibration)\n${headTail(trackRecord, 2000)}`);
  }

  if (repoManifest) {
    const repoSection = formatRepoManifest(repoManifest);
    if (repoSection) {
      sections.push(repoSection);
    }
  }

  const user = sections.join('\n\n');

  const { text } = await complete({ system: SYSTEM, user, maxTokens: 2048, model });

  let raw: unknown[];
  try {
    raw = extractJsonAs(text, RawPredictionsArraySchema);
  } catch {
    // Model returned malformed JSON — treat as no predictions.
    return [];
  }

  // Drop invalid entries, re-assign sequential ids.
  const valid: Prediction[] = [];
  for (const entry of raw) {
    const parsed = PredictionSchema.safeParse(entry);
    if (parsed.success && valid.length < 8) {
      valid.push(withObservability(parsed.data, `p${valid.length + 1}`));
    }
  }

  return valid;
}
