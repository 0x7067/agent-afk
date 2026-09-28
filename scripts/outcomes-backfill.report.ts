/**
 * Stats accumulation and report generation for the outcomes backfill.
 * Split from outcomes-backfill.ts to stay within the 350-line ceiling.
 */

import type { OutcomeLabel, Vote } from '../src/agent/outcomes/index.js';
import type { SessionResult } from './outcomes-backfill.session.js';

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface LfEntry {
  nonzero: number;
  pos: number;
  neg: number;
  abstain: number;
}

export interface Stats {
  total: number;
  byLabel: Record<OutcomeLabel, number>;
  byKind: { mutating: number; text: number };
  labelByKind: Record<'mutating' | 'text', Record<OutcomeLabel, number>>;
  lfCoverage: Map<string, LfEntry>;
  withPr: number;
  withCommit: number;
  strongLfCounts: Record<string, number>;
  nonUnknown: number;
}

export function emptyStats(): Stats {
  const labels: OutcomeLabel[] = ['succeeded', 'failed', 'interrupted', 'blocked', 'unknown'];
  const byLabel = Object.fromEntries(labels.map((l) => [l, 0])) as Record<OutcomeLabel, number>;
  return {
    total: 0,
    byLabel,
    byKind: { mutating: 0, text: 0 },
    labelByKind: { mutating: { ...byLabel }, text: { ...byLabel } },
    lfCoverage: new Map(),
    withPr: 0,
    withCommit: 0,
    strongLfCounts: {},
    nonUnknown: 0,
  };
}

export function accumulate(stats: Stats, result: SessionResult): void {
  stats.total++;
  stats.byLabel[result.label]++;
  stats.byKind[result.sessionKind]++;
  stats.labelByKind[result.sessionKind][result.label]++;
  if (result.label !== 'unknown') stats.nonUnknown++;
  if (result.hasPr) stats.withPr++;
  if (result.hasCommit) stats.withCommit++;

  updateLfCoverage(stats, result.votes);
  updateStrongLf(stats, result.label, result.votes);
}

function updateLfCoverage(stats: Stats, votes: Vote[]): void {
  for (const v of votes) {
    if (!stats.lfCoverage.has(v.lf)) {
      stats.lfCoverage.set(v.lf, { nonzero: 0, pos: 0, neg: 0, abstain: 0 });
    }
    const entry = stats.lfCoverage.get(v.lf);
    if (entry === undefined) continue;
    if (v.vote === 1) { entry.nonzero++; entry.pos++; }
    else if (v.vote === -1) { entry.nonzero++; entry.neg++; }
    else { entry.abstain++; }
  }
}

function updateStrongLf(
  stats: Stats,
  label: OutcomeLabel,
  votes: Vote[],
): void {
  if (label === 'unknown') return;
  const strongDriving = votes.filter((v) => v.strength === 'strong' && v.vote !== 0);
  for (const v of strongDriving) {
    stats.strongLfCounts[v.lf] = (stats.strongLfCounts[v.lf] ?? 0) + 1;
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function pct(n: number, d: number): string {
  if (d === 0) return '0%';
  return `${Math.round((n / d) * 100)}%`;
}

const LF_ORDER = [
  'closure', 'budget_cap', 'error_tail', 'verification',
  'in_session_correction', 'self_report', 'pr_fate', 'commit_survival',
];

export function generateReport(
  stats: Stats,
  opts: {
    noGh: boolean;
    noGit: boolean;
    processedCount: number;
    totalAvailable: number;
  },
): string {
  const { noGh, noGit, processedCount, totalAvailable } = opts;
  const lines: string[] = [];
  const now = new Date().toISOString();

  lines.push('# Verified Outcome M0 — Distribution Report');
  lines.push('');
  lines.push(`Generated: ${now}  `);
  lines.push(`Sessions processed: ${processedCount} / ${totalAvailable} available  `);
  if (noGh) lines.push('`--no-gh` was set: pr_fate LF skipped  ');
  if (noGit) lines.push('`--no-git` was set: commit_survival LF skipped  ');
  lines.push('');

  appendLabelDist(lines, stats);
  appendArtifacts(lines, stats);
  appendLfCoverage(lines, stats);
  appendStrongLf(lines, stats);
  appendExitCheck(lines, stats);
  appendCaveats(lines, noGh, noGit);

  return lines.join('\n');
}

function appendLabelDist(lines: string[], stats: Stats): void {
  lines.push('## Label distribution');
  lines.push('');
  lines.push('| Label | Count | % |');
  lines.push('|---|---|---|');
  for (const label of ['succeeded', 'failed', 'interrupted', 'blocked', 'unknown'] as OutcomeLabel[]) {
    lines.push(`| ${label} | ${stats.byLabel[label]} | ${pct(stats.byLabel[label], stats.total)} |`);
  }
  lines.push('');

  lines.push('### By session kind');
  lines.push('');
  lines.push('| Kind | Total | succeeded | failed | interrupted | blocked | unknown |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const kind of ['mutating', 'text'] as const) {
    const total = stats.byKind[kind];
    const b = stats.labelByKind[kind];
    lines.push(`| ${kind} | ${total} | ${b['succeeded']} | ${b['failed']} | ${b['interrupted']} | ${b['blocked']} | ${b['unknown']} |`);
  }
  lines.push('');
}

function appendArtifacts(lines: string[], stats: Stats): void {
  lines.push('## Artifact recovery');
  lines.push('');
  lines.push(`- Sessions with recovered commits: **${stats.withCommit}** (${pct(stats.withCommit, stats.total)})`);
  lines.push(`- Sessions with recovered PR URLs: **${stats.withPr}** (${pct(stats.withPr, stats.total)})`);
  lines.push('');
}

function appendLfCoverage(lines: string[], stats: Stats): void {
  lines.push('## Per-LF coverage');
  lines.push('');
  lines.push('Coverage = share of sessions where LF voted non-zero.  ');
  lines.push('');
  lines.push('| LF | Non-zero | +1 | -1 | Abstain | Coverage |');
  lines.push('|---|---|---|---|---|---|');
  for (const lf of LF_ORDER) {
    const e = stats.lfCoverage.get(lf);
    if (e === undefined) {
      lines.push(`| ${lf} | 0 | 0 | 0 | 0 | 0% |`);
    } else {
      lines.push(`| ${lf} | ${e.nonzero} | ${e.pos} | ${e.neg} | ${e.abstain} | ${pct(e.nonzero, stats.total)} |`);
    }
  }
  lines.push('');
}

function appendStrongLf(lines: string[], stats: Stats): void {
  lines.push('## Labels resting on each strong LF');
  lines.push('');
  lines.push('(Non-unknown labels where LF cast a strong vote)');
  lines.push('');
  lines.push('| LF | Sessions |');
  lines.push('|---|---|');
  for (const [lf, count] of Object.entries(stats.strongLfCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${lf} | ${count} |`);
  }
  lines.push('');
}

function appendExitCheck(lines: string[], stats: Stats): void {
  const M0_THRESHOLD = 300;
  const exitCheck = stats.nonUnknown >= M0_THRESHOLD;
  lines.push('## M0 exit criterion');
  lines.push('');
  lines.push(`Required: at least ${M0_THRESHOLD} non-unknown labels.`);
  lines.push('');
  lines.push(`**${exitCheck ? 'PASS' : 'FAIL'}** — ${stats.nonUnknown} non-unknown labels.`);
  lines.push('');
}

function appendCaveats(lines: string[], noGh: boolean, noGit: boolean): void {
  lines.push('## Caveats');
  lines.push('');
  lines.push('- **Closure LF (0% coverage)**: joining the closure LF requires scanning');
  lines.push('  17k+ trace directories for `session_id_assigned` events — skipped in M0.');
  lines.push('  Will be populated at session teardown in M2.');
  lines.push('- **Subagent tool events**: session JSON only contains the parent session\'s');
  lines.push('  turns. Worktree-isolated children\'s tool events (including commits) appear');
  lines.push('  in separate session files — invisible to parent artifact recovery.');
  lines.push('- **fix_of_fix LF**: skipped (weak -1, cannot flip succeeded). M2 daemon job.');
  lines.push('- **dir-based sessions**: 16k+ directory-based sessions (events.jsonl format)');
  lines.push('  not processed; only 1001 JSON-sidecar sessions have toolEvents data.');
  if (noGh) lines.push('- **pr_fate skipped** (`--no-gh`): PR merge status not checked.');
  if (noGit) lines.push('- **commit_survival skipped** (`--no-git`): git ancestry not checked.');
  lines.push('');
}
