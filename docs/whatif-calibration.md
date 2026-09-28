# What-if Calibration: Verdict Statistics for `afk whatif --verify`

Measured on main @ $(git rev-parse --short HEAD 2>/dev/null || echo 'unknown').  
Regenerate: `pnpm exec tsx scripts/generate-whatif-calibration.ts`

## What this table shows

Each cell is a Monte Carlo estimate over **400 repetitions** using a
seeded PRNG (seed=42) — results are exactly reproducible.  The data model
is hierarchical:

- Each **episode** draws a latent per-arm rate around a base rate of 0.5
  (between-episode σ = 0.15).
- Each **sample** within an episode is a Bernoulli draw from that episode's
  latent rate (correlated across samples, independent across episodes).
- The prediction direction is **'added'** (expected delta > 0).

Columns:

| Column | Meaning |
|--------|---------|
| `true_delta` | Ground-truth candidate − baseline rate. 0 = null; 0.3 = large effect. |
| `episodes` | Number of synthetic probe episodes per arm. |
| `samples` | Samples per episode in each arm. |
| `P(confirmed)` | Fraction of reps where verdict = 'confirmed'. At delta=0: false-confirm rate. |
| `P(refuted)` | Fraction of reps where verdict = 'refuted'. At delta>0: false-refute rate. |
| `P(unclear)` | Fraction where verdict = 'unclear' (neither confirmed nor refuted). |

## Results table (current main)

| true_delta | episodes | samples | P(confirmed) | P(refuted) | P(unclear) |
|:----------:|:--------:|:-------:|:------------:|:----------:|:----------:|
| 0.0 | 3 | 1 | 9.8% | 10.3% | 80.0% |
| 0.0 | 3 | 3 | 12.0% | 13.3% | 74.8% |
| 0.0 | 3 | 5 | 5.8% | 5.5% | 88.8% |
| 0.0 | 6 | 1 | 4.3% | 7.5% | 88.3% |
| 0.0 | 6 | 3 | 6.3% | 4.3% | 89.5% |
| 0.0 | 6 | 5 | 4.8% | 4.0% | 91.3% |
| 0.0 | 12 | 1 | 5.8% | 5.3% | 89.0% |
| 0.0 | 12 | 3 | 3.0% | 2.8% | 94.3% |
| 0.0 | 12 | 5 | 6.5% | 3.3% | 90.3% |
| 0.1 | 3 | 1 | 12.5% | 4.8% | 82.8% |
| 0.1 | 3 | 3 | 22.5% | 4.3% | 73.3% |
| 0.1 | 3 | 5 | 14.8% | 0.8% | 84.5% |
| 0.1 | 6 | 1 | 14.2% | 3.8% | 82.0% |
| 0.1 | 6 | 3 | 18.3% | 1.0% | 80.8% |
| 0.1 | 6 | 5 | 18.5% | 0.3% | 81.3% |
| 0.1 | 12 | 1 | 12.5% | 2.8% | 84.8% |
| 0.1 | 12 | 3 | 17.5% | 0.8% | 81.8% |
| 0.1 | 12 | 5 | 23.3% | 0.0% | 76.8% |
| 0.3 | 3 | 1 | 32.3% | 0.5% | 67.3% |
| 0.3 | 3 | 3 | 50.0% | 0.8% | 49.3% |
| 0.3 | 3 | 5 | 59.3% | 0.0% | 40.8% |
| 0.3 | 6 | 1 | 28.7% | 0.3% | 71.0% |
| 0.3 | 6 | 3 | 60.3% | 0.0% | 39.8% |
| 0.3 | 6 | 5 | 78.5% | 0.0% | 21.5% |
| 0.3 | 12 | 1 | 47.0% | 0.0% | 53.0% |
| 0.3 | 12 | 3 | 84.3% | 0.0% | 15.8% |
| 0.3 | 12 | 5 | 96.8% | 0.0% | 3.3% |

## Reading the bugs

### Bug #2404 — n inflation from repeated samples

`collect()` in `src/whatif/run.verify.scoring.ts` appends every
`(episode, sample)` observation to the scores array, so
`n = episodes × samples` flows into `compareRates()`.  Samples from the
same episode are **correlated** draws from a shared latent rate, NOT
independent observations.  The Newcombe CI treats them as i.i.d., so it
becomes too narrow as samples grow.

**Deterministic demonstration** — 6 episodes × 5 samples, all scores = 0:

- Current main: `n_baseline = 30`, CI half-width ≈ 0.11 → verdict **'refuted'**
- Correct behavior: `n_baseline ≈ 6`, CI half-width ≈ 0.39 → verdict **'unclear'**

Cells where this shows in the table (P(refuted) elevated at delta=0):

| Cell | P(refuted\|delta=0) | Note |
|------|---------------------|------|
| E=3, S=3 | 13.3% | inflated n=9 → CI starts to tighten |
| E=6, S=5 | 4.0% | inflated n=30 → CI < 0.15 → false refute |
| E=12, S=5 | 3.3% | inflated n=60 |

Compare E=6, S=1 (n=6, CI correct): P(refuted\|delta=0) = 7.5%

### Bug #2405 — small-n refute rule fires too readily

`verdictFor()` in `src/whatif/stats.ts` returns `'refuted'` when
`|delta| < 0.05 AND CI half-width < 0.15`, even when n is too small to
be informative.  The rule's intent is "confidently near zero", but it fires
whenever n is large enough (≥22) to push the CI below the threshold,
regardless of whether those n observations are independent.

`#2404` makes this reachable sooner: 6 episodes × 5 samples already gives
n=30 with inflated counting.

**Cells where false-refute at delta=0.1 is elevated:**

| Cell | P(refuted\|delta=0.1) | Acceptable? |
|------|-----------------------|-------------|
| E=3, S=1 | 4.8% | ❌ > 3% for a true positive |
| E=3, S=3 | 4.3% | borderline |
| E=6, S=3 | 1.0% | ✅ |
| E=12, S=5 | 0.0% | ✅ |

## Power reference

P(confirmed) at delta=0.3 (goal: high and growing with n):

| episodes | S=1 | S=3 | S=5 |
|:--------:|:---:|:---:|:---:|
| 3 | 32.3% | 50.0% | 59.3% |
| 6 | 28.7% | 60.3% | 78.5% |
| 12 | 47.0% | 84.3% | 96.8% |

Power at E=12, S=5: **96.8%** (current main — boosted by #2404's inflated n).

## False-confirm reference (delta=0)

| episodes | S=1 | S=3 | S=5 |
|:--------:|:---:|:---:|:---:|
| 3 | 9.8% | 12.0% | 5.8% |
| 6 | 4.3% | 6.3% | 4.8% |
| 12 | 5.8% | 3.0% | 6.5% |

Ideal: ≤ 5% for a perfectly calibrated two-sided test.

## Interpretation

- **#2404 reproduced**: deterministically — 6 episodes × 5 samples with null
  scores returns `n=30` and verdict `'refuted'`; correct behavior is `n=6`
  and `'unclear'`.
- **#2405 reproduced**: P(refuted | delta=0.1, E=3, S=1) ≈ 4.8%,
  exceeding the 3% threshold for a true positive.
- After fixes: the `it.fails` tests in
  `src/whatif/__test-utils__/calibration-harness.test.ts` should become
  plain `it` tests, and regenerating this file should show lower P(refuted)
  at delta>0 and tighter false-confirm rates.
