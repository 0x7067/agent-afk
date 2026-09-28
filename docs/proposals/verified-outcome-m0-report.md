# Verified Outcome M0 — Distribution Report

Generated: 2026-09-28T01:41:51.021Z  
Sessions processed: 1001 / 1001 available  

## Label distribution

| Label | Count | % |
|---|---|---|
| succeeded | 523 | 52% |
| failed | 5 | 0% |
| interrupted | 0 | 0% |
| blocked | 8 | 1% |
| unknown | 465 | 46% |

### By session kind

| Kind | Total | succeeded | failed | interrupted | blocked | unknown |
|---|---|---|---|---|---|---|
| mutating | 588 | 401 | 5 | 0 | 6 | 176 |
| text | 413 | 122 | 0 | 0 | 2 | 289 |

## Artifact recovery

- Sessions with recovered commits: **416** (42%)
- Sessions with recovered PR URLs: **457** (46%)

## Per-LF coverage

Coverage = share of sessions where LF voted non-zero.  

| LF | Non-zero | +1 | -1 | Abstain | Coverage |
|---|---|---|---|---|---|
| closure | 0 | 0 | 0 | 0 | 0% |
| budget_cap | 0 | 0 | 0 | 0 | 0% |
| error_tail | 0 | 0 | 0 | 0 | 0% |
| verification | 226 | 224 | 2 | 0 | 23% |
| in_session_correction | 32 | 0 | 32 | 0 | 3% |
| self_report | 0 | 0 | 0 | 1001 | 0% |
| pr_fate | 823 | 782 | 41 | 0 | 82% |
| commit_survival | 94 | 94 | 0 | 0 | 9% |

## Labels resting on each strong LF

(Non-unknown labels where LF cast a strong vote)

| LF | Sessions |
|---|---|
| pr_fate | 717 |
| verification | 217 |
| commit_survival | 93 |

## M0 exit criterion

Required: at least 300 non-unknown labels.

**PASS** — 536 non-unknown labels.

## Caveats

- **Closure LF (0% coverage)**: joining the closure LF requires scanning
  17k+ trace directories for `session_id_assigned` events — skipped in M0.
  Will be populated at session teardown in M2.
- **Subagent tool events**: session JSON only contains the parent session's
  turns. Worktree-isolated children's tool events (including commits) appear
  in separate session files — invisible to parent artifact recovery.
- **fix_of_fix LF**: skipped (weak -1, cannot flip succeeded). M2 daemon job.
- **dir-based sessions**: 16k+ directory-based sessions (events.jsonl format)
  not processed; only 1001 JSON-sidecar sessions have toolEvents data.
