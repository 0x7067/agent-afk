/**
 * outcomes-backfill.ts — M0 offline pass over existing session history.
 *
 * Reads all persisted session JSON sidecars, runs the immediate LFs and a
 * one-off delayed pass (gh + git), and writes a distribution report.
 *
 * Processing helpers: outcomes-backfill.session.ts
 * Report helpers:     outcomes-backfill.report.ts
 *
 * Usage:
 *   npx tsx scripts/outcomes-backfill.ts [--limit N] [--no-gh] [--no-git]
 *     [--out <path>] [--json <path>]
 *
 * Flags:
 *   --limit N     process only the first N sessions (default: all)
 *   --no-gh       skip gh pr view calls
 *   --no-git      skip git ancestry calls
 *   --out <path>  markdown report (default: docs/proposals/verified-outcome-m0-report.md)
 *   --json <path> per-session JSON dir (default: os.tmpdir()/afk-outcomes-m0-<pid>)
 *                 NOT committed — contains session IDs
 *
 * Exit codes: 0 success, 1 error.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

import { getSessionsDir, getFacetCacheDir } from '../src/paths.js';
import { recoverArtifacts } from '../src/agent/outcomes/index.js';
import type { VerifiedOutcome } from '../src/agent/outcomes/index.js';
import {
  processSession,
  loadSessionTurns,
  makeCachedGhFetch,
} from './outcomes-backfill.session.js';
import {
  emptyStats,
  accumulate,
  generateReport,
} from './outcomes-backfill.report.js';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

interface Args {
  limit: number;
  noGh: boolean;
  noGit: boolean;
  out: string;
  jsonDir: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let limit = Infinity;
  let noGh = false;
  let noGit = false;
  let out = 'docs/proposals/verified-outcome-m0-report.md';
  let jsonDir = join(tmpdir(), `afk-outcomes-m0-${process.pid}`);

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--no-gh') { noGh = true; continue; }
    if (a === '--no-git') { noGit = true; continue; }
    if (a === '--limit' && args[i + 1] !== undefined) {
      limit = parseInt(args[++i] ?? '0', 10);
      continue;
    }
    if (a === '--out' && args[i + 1] !== undefined) {
      out = args[++i] ?? out;
      continue;
    }
    if (a === '--json' && args[i + 1] !== undefined) {
      jsonDir = args[++i] ?? jsonDir;
      continue;
    }
  }
  return { limit, noGh, noGit, out, jsonDir };
}

// ---------------------------------------------------------------------------
// Bounded concurrency
// ---------------------------------------------------------------------------

async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < items.length) {
      const current = items[idx++];
      if (current === undefined) break;
      await fn(current);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { limit, noGh, noGit, out, jsonDir } = parseArgs();

  const sessionsDir = getSessionsDir();
  const facetCacheDir = getFacetCacheDir();
  const now = new Date().toISOString();

  const allIds: string[] = existsSync(sessionsDir)
    ? readdirSync(sessionsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => basename(f, '.json'))
    : [];

  const sessionIds = Number.isFinite(limit) ? allIds.slice(0, limit) : allIds;
  const totalAvailable = allIds.length;

  console.log(`Found ${totalAvailable} JSON-sidecar sessions; processing ${sessionIds.length}`);
  console.log(`gh: ${noGh ? 'disabled' : 'enabled'}  git: ${noGit ? 'disabled' : 'enabled'}`);

  mkdirSync(jsonDir, { recursive: true });

  const fetchPr = makeCachedGhFetch(!noGh);
  const stats = emptyStats();
  let processed = 0;

  const concurrency = noGh && noGit ? 20 : 5;

  await runConcurrent(sessionIds, concurrency, async (sessionId) => {
    const result = await processSession(sessionId, {
      sessionsDir,
      facetCacheDir,
      noGh,
      noGit,
      fetchPr,
      now,
    });
    if (result === null) return;

    accumulate(stats, result);
    processed++;

    if (processed % 100 === 0) {
      process.stdout.write(`\r  ${processed}/${sessionIds.length} sessions processed…`);
    }

    // Write per-session record to temp dir (private — contains session IDs)
    const turns = loadSessionTurns(sessionId, sessionsDir);
    const artifacts = turns !== null ? recoverArtifacts(turns) : { commits: [], prs: [], repo: null };
    const record: VerifiedOutcome = {
      schema_version: 1,
      session_id: result.sessionId,
      label: result.label,
      confidence: result.confidence,
      state: 'provisional',
      settles_after: null,
      session_kind: result.sessionKind,
      self_report: result.selfReport,
      artifacts,
      votes: result.votes,
      history: [{ at: now, label: result.label, reason: 'M0 backfill' }],
    };
    writeFileSync(join(jsonDir, `${sessionId}.json`), JSON.stringify(record, null, 2), 'utf8');
  });

  console.log(`\n  Done: ${processed} sessions processed.`);

  const report = generateReport(stats, {
    noGh,
    noGit,
    processedCount: processed,
    totalAvailable,
  });

  writeFileSync(out, report, 'utf8');
  console.log(`  Report: ${out}`);
  console.log(`  Per-session JSON: ${jsonDir} (not committed)`);

  console.log('');
  console.log('  Label distribution:');
  for (const [label, count] of Object.entries(stats.byLabel)) {
    const share = stats.total > 0 ? Math.round((count / stats.total) * 100) : 0;
    console.log(`    ${label}: ${count} (${share}%)`);
  }
  const exitOk = stats.nonUnknown >= 300;
  console.log(`\n  M0 exit: ${exitOk ? 'PASS' : 'FAIL'} (${stats.nonUnknown} non-unknown)`);
}

main().catch((err: unknown) => {
  console.error('backfill failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
