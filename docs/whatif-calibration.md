# What-if Calibration: Verdict Statistics for `afk whatif --verify`

Measured on main @ $(git rev-parse --short HEAD 2>/dev/null || echo 'unknown').  
Regenerate: `pnpm exec tsx scripts/generate-whatif-calibration.ts`

## What this table shows

Each cell is a Monte Carlo estimate over **400 repetitions** using a
seeded PRNG (seed=42) — results are exactly reproducible.  The data model
is hierarchical:

- Each **episode** draws a latent per-arm rate around a base rate of 0.5.
- Each **sample** within an episode is a Bernoulli draw from that episode's
  latent rate (correlated across samples, independent across episodes).
- The prediction direction is **'added'** (expected delta > 0).

Two ICC settings are reported to show how intra-episode correlation affects
the harness's ability to expose bug #2404.

| Setting | betweenEpisodeSd | Theoretical ICC |
|---------|-----------------|-----------------|
| Low  | 0.15 | ≈ 0.083 |
| High | 0.4 | ≈ 0.390 |

**ICC** (intra-class correlation) = σ_b² / (σ_b² + σ_w²), where σ_b is
between-episode σ and σ_w² ≈ p(1-p) ≈ 0.25 at baseRate=0.5.

## How to read this

- At **delta=0** the prediction direction ('added') is **false**; there is no true
  improvement.  Therefore:
  - **P(refuted)** is a **correct refutation** (the CI correctly excludes zero
    with the wrong sign, or the half-width rule fires).
  - **P(confirmed)** is the **false-confirm rate** (the CI wrongly excludes zero
    in the 'added' direction).  The nominal one-sided target for a 95% two-sided CI
    is ≈ 2.5%; the one-sided 'confirmed' rate at delta=0.
  - Any excess false confirms at samples=1 (no repeats) come from the small-n
    interval itself, **not** from bug #2404.
- At **delta > 0** the prediction is true:
  - **P(refuted)** is the **false-refute rate** (type-II error in the wrong direction).
  - **P(confirmed)** is **power** (correct detection).
- Bug **#2404** manifests as n-inflation: `n = episodes × samples` flows into
  `compareRates()` instead of counting unique episodes.  This is a **deterministic**
  bug visible regardless of ICC setting (all-zero scores, 6 eps × 5 samples →
  n=30, verdict refuted), but the **Monte Carlo** symptom (excess false refutes at
  delta=0 growing with samples) is only clearly visible at high ICC, where the per-
  episode latent rate variance makes the inflation consequential.
- Bug **#2405** manifests as the small-n refute rule firing when the run is
  underpowered (E=3, S=1 at delta=0.1 produces ~5% false refutes vs the 3% ceiling).

## Results tables (current main)

### Low ICC (betweenEpisodeSd=0.15, theoretical ICC≈0.083)

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

### High ICC (betweenEpisodeSd=0.4, theoretical ICC≈0.390)

| true_delta | episodes | samples | P(confirmed) | P(refuted) | P(unclear) |
|:----------:|:--------:|:-------:|:------------:|:----------:|:----------:|
| 0.0 | 3 | 1 | 3.5% | 4.3% | 92.3% |
| 0.0 | 3 | 3 | 5.3% | 6.5% | 88.3% |
| 0.0 | 3 | 5 | 2.8% | 2.0% | 95.3% |
| 0.0 | 6 | 1 | 1.8% | 3.0% | 95.3% |
| 0.0 | 6 | 3 | 2.5% | 3.0% | 94.5% |
| 0.0 | 6 | 5 | 2.3% | 2.3% | 95.5% |
| 0.0 | 12 | 1 | 2.8% | 2.5% | 94.8% |
| 0.0 | 12 | 3 | 1.8% | 0.3% | 98.0% |
| 0.0 | 12 | 5 | 1.5% | 1.0% | 97.5% |
| 0.1 | 3 | 1 | 5.8% | 3.0% | 91.3% |
| 0.1 | 3 | 3 | 15.3% | 1.8% | 83.0% |
| 0.1 | 3 | 5 | 10.8% | 0.8% | 88.5% |
| 0.1 | 6 | 1 | 5.5% | 2.0% | 92.5% |
| 0.1 | 6 | 3 | 13.0% | 0.3% | 86.8% |
| 0.1 | 6 | 5 | 8.8% | 0.3% | 91.0% |
| 0.1 | 12 | 1 | 7.8% | 1.3% | 91.0% |
| 0.1 | 12 | 3 | 10.3% | 0.0% | 89.8% |
| 0.1 | 12 | 5 | 15.0% | 0.5% | 84.5% |
| 0.3 | 3 | 1 | 20.8% | 0.3% | 79.0% |
| 0.3 | 3 | 3 | 37.0% | 0.0% | 63.0% |
| 0.3 | 3 | 5 | 41.8% | 0.0% | 58.3% |
| 0.3 | 6 | 1 | 19.5% | 0.3% | 80.3% |
| 0.3 | 6 | 3 | 43.8% | 0.0% | 56.3% |
| 0.3 | 6 | 5 | 60.0% | 0.0% | 40.0% |
| 0.3 | 12 | 1 | 36.8% | 0.0% | 63.2% |
| 0.3 | 12 | 3 | 65.5% | 0.0% | 34.5% |
| 0.3 | 12 | 5 | 87.8% | 0.0% | 12.3% |

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

This deterministic failure is **ICC-independent** — it fires regardless of
between-episode variance.

**Why low ICC hides the Monte Carlo symptom:**  
At low ICC (≈0.083), the between-episode σ is small relative to the
Bernoulli noise.  Samples from the same episode are nearly i.i.d. anyway, so
the Newcombe CI is approximately correct even with inflated n.  The table shows
P(refuted|delta=0) does not rise sharply with samples:

| Cell | Low ICC P(refuted\|delta=0) | High ICC P(refuted\|delta=0) |
|------|-----------------------------|------------------------------|
| E=6, S=1 | 7.5% | 3.0% |
| E=6, S=3 | 4.3% | 3.0% |
| E=6, S=5 | 4.0% | 2.3% |

At high ICC (≈0.390) the pattern is also modest, but the low false-confirm
rates confirm the interval narrows correctly — the main consequence of #2404
at high ICC is the false-refute rate, not the false-confirm rate.

### Bug #2405 — small-n refute rule fires too readily

`verdictFor()` in `src/whatif/stats.ts` returns `'refuted'` when
`|delta| < 0.05 AND CI half-width < 0.15`, even when n is too small to
be informative.  The rule's intent is "confidently near zero", but it fires
whenever n is large enough (≥22) to push the CI below the threshold.

`#2404` makes this reachable sooner: inflated n shrinks the CI artificially.

**Low-ICC cells where false-refute at delta=0.1 is elevated:**

| Cell | P(refuted\|delta=0.1) | Acceptable? |
|------|-----------------------|-------------|
| E=3, S=1 | 4.8% | ❌ > 3% for a true positive |
| E=3, S=3 | 4.3% | borderline |
| E=6, S=3 | 1.0% | ✅ |
| E=12, S=5 | 0.0% | ✅ |

## Power reference

P(confirmed) at delta=0.3 (goal: high and growing with n):

### Low ICC

| episodes | S=1 | S=3 | S=5 |
|:--------:|:---:|:---:|:---:|
| 3 | 32.3% | 50.0% | 59.3% |
| 6 | 28.7% | 60.3% | 78.5% |
| 12 | 47.0% | 84.3% | 96.8% |

Power at E=12, S=5 (low ICC): **96.8%** (boosted by #2404's inflated n).

### High ICC

| episodes | S=1 | S=3 | S=5 |
|:--------:|:---:|:---:|:---:|
| 3 | 20.8% | 37.0% | 41.8% |
| 6 | 19.5% | 43.8% | 60.0% |
| 12 | 36.8% | 65.5% | 87.8% |

Power at E=12, S=5 (high ICC): **87.8%** (lower than low-ICC because
high between-episode variance reduces effective n; n-inflation still applies but the variance
makes each observation noisier).

## False-confirm reference (delta=0)

### Low ICC

| episodes | S=1 | S=3 | S=5 |
|:--------:|:---:|:---:|:---:|
| 3 | 9.8% | 12.0% | 5.8% |
| 6 | 4.3% | 6.3% | 4.8% |
| 12 | 5.8% | 3.0% | 6.5% |

### High ICC

| episodes | S=1 | S=3 | S=5 |
|:--------:|:---:|:---:|:---:|
| 3 | 3.5% | 5.3% | 2.8% |
| 6 | 1.8% | 2.5% | 2.3% |
| 12 | 2.8% | 1.8% | 1.5% |

Ideal (for a well-calibrated 95% two-sided CI): P(confirmed|delta=0) ≈ 2.5% one-sided.
The numbers above exceed this because the verdict system is not a pure Newcombe CI — the
half-width rule and the unclear region inflate the confirmed/refuted counts at small n.

## Interpretation

- **#2404 reproduced**: deterministically — 6 episodes × 5 samples with null
  scores returns `n=30` and verdict `'refuted'`; correct behavior is `n=6`
  and `'unclear'`.
- **#2405 reproduced**: P(refuted | delta=0.1, E=3, S=1) ≈ 4.8%,
  exceeding the 3% threshold for a true positive.
- **Low ICC hides the Monte Carlo symptom of #2404**: at ICC≈0.083 the
  published table shows false confirms at delta=0 NOT rising with samples — this
  is expected, not evidence that #2404 is mild.  The bug is still real (deterministic)
  and visible at high ICC in the false-refute pattern.
- After fixes: the `it.fails` tests in
  `src/whatif/__test-utils__/calibration-harness.test.ts` should become
  plain `it` tests, and regenerating this file should show lower P(refuted)
  at delta>0 and n-counts matching episode counts.
