Closes #2504

## Summary

Pilot 2 spent $9.49 on a prediction whose baseline was already 93%, leaving 7pp of room for an increase while the MDE at 11 probes was ~60pp. Nothing flagged it. Three-part fix.

### 1. Prompt fix — headroom-aware probe selection (`predict.ts`, `types.ts`)

`buildSystem` now explicitly requires probes on which the **current (baseline) agent leaves room to move**:
- **added/strengthened**: pick requests where the agent today usually does *not* show the behavior (baseline P(yes) well below 1.0)
- **removed/weakened**: pick requests where the agent currently *does* show the behavior (baseline P(yes) well above 0.0)

`Prediction` gains an optional `baselineEstimate: number` field (0–1). The Zod schema accepts it leniently — out-of-range or non-numeric values are clamped/dropped in `withObservability`, so existing ledger files and hand-built fixtures parse unchanged.

### 2. Pre-spend headroom check (`mde.ts`, `run.ts`)

New helpers in `mde.ts`:
- `headroomForPrediction(estimate, direction)` — headroom in the predicted direction
- `isHeadroomUnderpowered(prediction, probesPerPrediction)` — true when headroom < MDE
- `headroomPreflightLine(prediction, probesPerPrediction)` — human-readable preflight message

`runPreflightChecks` in `run.ts` now checks each prediction's `baselineEstimate`. When headroom < MDE, it emits a preflight line ("Prediction p1 (strengthened): baseline estimate 93pp, leaving 7pp of headroom for an increase; this run can only detect shifts ≥60pp — prediction is underpowered before the first episode runs.") and throws `WhatifMdeError` — **the same gate as the existing MDE check**, so `--force` bypasses it identically. Absent `baselineEstimate` means no check (backward compatible).

### 3. Post-hoc report limit (`mde.ts`, `report.ts`)

New helper `headroomLimitLine(observedBaseline, direction, n, label)` in `mde.ts`.

`standardLimits` in `report.ts` calls it alongside the existing `mdeLimitLine` for each verified prediction. When the **observed** baseline rate leaves less headroom than the MDE, a Limits bullet is added: _"Prediction p1: baseline was 93pp, leaving 7pp of room for an increase; this run can only detect shifts ≥60pp, so it could not confirm this prediction."_ Verdict logic is unchanged.

## Tests

`src/whatif/headroom.test.ts` — 28 focused unit tests:
- **(a)** Schema: `baselineEstimate` accepted, omitted, clamped (1.5→1), non-numeric dropped
- **(b)** `headroomForPrediction`: all four directions (`added`, `strengthened`, `removed`, `weakened`) + absent case
- **(c)** Preflight/gate: pilot-2 scenario (93% baseline, 11 probes → underpowered), boundary case (headroom exactly equals MDE → not fired), absent estimate → no check, direction labels (increase/decrease)
- **(d)** Post-hoc limit: appears for low-headroom predictions, absent when sufficient headroom, boundary case

## Gate results

| Gate | Result |
|------|--------|
| `pnpm lint` | ✅ pass |
| `pnpm test src/whatif` | ✅ pass — 795 tests, 40 files |
| `pnpm audit:filesize:check` | ✅ pass |
| `pnpm audit:funcsize:check` | ✅ pass |
| `pnpm audit:env:check` | ✅ pass |
| `pnpm audit:chalk:check` | ✅ pass |
| `pnpm build` | ✅ pass |
