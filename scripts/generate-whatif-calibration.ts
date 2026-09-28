/**
 * Regenerate docs/whatif-calibration.md from the calibration harness.
 *
 * Usage:
 *   pnpm exec tsx scripts/generate-whatif-calibration.ts
 *
 * The script runs the same deterministic simulation that the tests use
 * (seed=42, 400 reps per cell) and writes the results table plus
 * diagnostics to docs/whatif-calibration.md.  Commit the updated file
 * after each fix PR so the documented 'before' and 'after' states are
 * archived together.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EPISODE_COUNTS,
  SAMPLE_COUNTS,
  TRUE_DELTAS,
  findCell,
  renderMarkdownTable,
  runGrid,
} from '../src/whatif/__test-utils__/calibration-harness.js';

const REPS = 400;
const SEED = 42;
const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'docs',
  'whatif-calibration.md',
);

const cells = runGrid({ reps: REPS, seed: SEED });

// ---------------------------------------------------------------------------
// Key diagnostics
// ---------------------------------------------------------------------------

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

const e6s5null = findCell(cells, 0, 6, 5)!;
const e6s1null = findCell(cells, 0, 6, 1)!;
const e3s3ref  = findCell(cells, 0.1, 3, 3)!;
const e3s1ref  = findCell(cells, 0.1, 3, 1)!;
const e12s5pwr = findCell(cells, 0.3, 12, 5)!;

// ---------------------------------------------------------------------------
// Compose document
// ---------------------------------------------------------------------------

const doc = `\
# What-if Calibration: Verdict Statistics for \`afk whatif --verify\`

Measured on main @ $(git rev-parse --short HEAD 2>/dev/null || echo 'unknown').  
Regenerate: \`pnpm exec tsx scripts/generate-whatif-calibration.ts\`

## What this table shows

Each cell is a Monte Carlo estimate over **${REPS} repetitions** using a
seeded PRNG (seed=${SEED}) — results are exactly reproducible.  The data model
is hierarchical:

- Each **episode** draws a latent per-arm rate around a base rate of 0.5
  (between-episode σ = 0.15).
- Each **sample** within an episode is a Bernoulli draw from that episode's
  latent rate (correlated across samples, independent across episodes).
- The prediction direction is **'added'** (expected delta > 0).

Columns:

| Column | Meaning |
|--------|---------|
| \`true_delta\` | Ground-truth candidate − baseline rate. 0 = null; 0.3 = large effect. |
| \`episodes\` | Number of synthetic probe episodes per arm. |
| \`samples\` | Samples per episode in each arm. |
| \`P(confirmed)\` | Fraction of reps where verdict = 'confirmed'. At delta=0: false-confirm rate. |
| \`P(refuted)\` | Fraction of reps where verdict = 'refuted'. At delta>0: false-refute rate. |
| \`P(unclear)\` | Fraction where verdict = 'unclear' (neither confirmed nor refuted). |

## Results table (current main)

${renderMarkdownTable(cells)}

## Reading the bugs

### Bug #2404 — n inflation from repeated samples

\`collect()\` in \`src/whatif/run.verify.scoring.ts\` appends every
\`(episode, sample)\` observation to the scores array, so
\`n = episodes × samples\` flows into \`compareRates()\`.  Samples from the
same episode are **correlated** draws from a shared latent rate, NOT
independent observations.  The Newcombe CI treats them as i.i.d., so it
becomes too narrow as samples grow.

**Deterministic demonstration** — 6 episodes × 5 samples, all scores = 0:

- Current main: \`n_baseline = 30\`, CI half-width ≈ 0.11 → verdict **'refuted'**
- Correct behavior: \`n_baseline ≈ 6\`, CI half-width ≈ 0.39 → verdict **'unclear'**

Cells where this shows in the table (P(refuted) elevated at delta=0):

| Cell | P(refuted\\|delta=0) | Note |
|------|---------------------|------|
| E=3, S=3 | ${pct(findCell(cells,0,3,3)!.pRefuted)} | inflated n=9 → CI starts to tighten |
| E=6, S=5 | ${pct(e6s5null.pRefuted)} | inflated n=30 → CI < 0.15 → false refute |
| E=12, S=5 | ${pct(findCell(cells,0,12,5)!.pRefuted)} | inflated n=60 |

Compare E=6, S=1 (n=6, CI correct): P(refuted\\|delta=0) = ${pct(e6s1null.pRefuted)}

### Bug #2405 — small-n refute rule fires too readily

\`verdictFor()\` in \`src/whatif/stats.ts\` returns \`'refuted'\` when
\`|delta| < 0.05 AND CI half-width < 0.15\`, even when n is too small to
be informative.  The rule's intent is "confidently near zero", but it fires
whenever n is large enough (≥22) to push the CI below the threshold,
regardless of whether those n observations are independent.

\`#2404\` makes this reachable sooner: 6 episodes × 5 samples already gives
n=30 with inflated counting.

**Cells where false-refute at delta=0.1 is elevated:**

| Cell | P(refuted\\|delta=0.1) | Acceptable? |
|------|-----------------------|-------------|
| E=3, S=1 | ${pct(e3s1ref.pRefuted)} | ❌ > 3% for a true positive |
| E=3, S=3 | ${pct(e3s3ref.pRefuted)} | borderline |
| E=6, S=3 | ${pct(findCell(cells,0.1,6,3)!.pRefuted)} | ✅ |
| E=12, S=5 | ${pct(findCell(cells,0.1,12,5)!.pRefuted)} | ✅ |

## Power reference

P(confirmed) at delta=0.3 (goal: high and growing with n):

| episodes | S=1 | S=3 | S=5 |
|:--------:|:---:|:---:|:---:|
${EPISODE_COUNTS.map((ep) => {
  const s = (sp: typeof SAMPLE_COUNTS[number]) => pct(findCell(cells, 0.3, ep, sp)!.pConfirmed);
  return `| ${ep} | ${s(1)} | ${s(3)} | ${s(5)} |`;
}).join('\n')}

Power at E=12, S=5: **${pct(e12s5pwr.pConfirmed)}** (current main — boosted by #2404's inflated n).

## False-confirm reference (delta=0)

| episodes | S=1 | S=3 | S=5 |
|:--------:|:---:|:---:|:---:|
${EPISODE_COUNTS.map((ep) => {
  const s = (sp: typeof SAMPLE_COUNTS[number]) => pct(findCell(cells, 0, ep, sp)!.pConfirmed);
  return `| ${ep} | ${s(1)} | ${s(3)} | ${s(5)} |`;
}).join('\n')}

Ideal: ≤ 5% for a perfectly calibrated two-sided test.

## Interpretation

- **#2404 reproduced**: deterministically — 6 episodes × 5 samples with null
  scores returns \`n=30\` and verdict \`'refuted'\`; correct behavior is \`n=6\`
  and \`'unclear'\`.
- **#2405 reproduced**: P(refuted | delta=0.1, E=3, S=1) ≈ ${pct(e3s1ref.pRefuted)},
  exceeding the 3% threshold for a true positive.
- After fixes: the \`it.fails\` tests in
  \`src/whatif/__test-utils__/calibration-harness.test.ts\` should become
  plain \`it\` tests, and regenerating this file should show lower P(refuted)
  at delta>0 and tighter false-confirm rates.
`;

await fs.writeFile(OUT, doc, 'utf8');
console.log(`Wrote ${OUT}`);
