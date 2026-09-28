# Verified Outcome M0 — Distribution Report

Generated: 2026-09-28T01:49:27.689Z  
Sessions processed: 1001 / 1001 available  

## Label distribution

| Label | Count | % |
|---|---|---|
| succeeded | 259 | 26% |
| failed | 5 | 0% |
| interrupted | 0 | 0% |
| blocked | 8 | 1% |
| unknown | 729 | 73% |

### By session kind

| Kind | Total | succeeded | failed | interrupted | blocked | unknown |
|---|---|---|---|---|---|---|
| mutating | 588 | 228 | 5 | 0 | 6 | 349 |
| text | 413 | 31 | 0 | 0 | 2 | 380 |

## Artifact recovery

- Sessions with recovered commits: **416** (42%)
- Sessions with recovered PR URLs: **206** (21%)

## Per-LF coverage

Coverage = share of sessions where LF voted non-zero.  

| LF | Non-zero | +1 | -1 | Abstain | Coverage |
|---|---|---|---|---|---|
| closure | 0 | 0 | 0 | 0 | 0% |
| budget_cap | 0 | 0 | 0 | 0 | 0% |
| error_tail | 0 | 0 | 0 | 0 | 0% |
| verification | 30 | 30 | 0 | 0 | 3% |
| in_session_correction | 32 | 0 | 32 | 0 | 3% |
| self_report | 0 | 0 | 0 | 1001 | 0% |
| pr_fate | 267 | 259 | 8 | 0 | 27% |
| commit_survival | 94 | 94 | 0 | 0 | 9% |

## Labels resting on each strong LF

(Non-unknown labels where LF cast a strong vote)

| LF | Sessions |
|---|---|
| pr_fate | 256 |
| commit_survival | 94 |
| verification | 30 |

## M0 exit criterion

Required: at least 300 non-unknown labels.

**FAIL** — 272 non-unknown labels.

## Caveats

- **Closure LF (0% coverage)**: joining the closure LF requires scanning
  17k+ trace directories for `session_id_assigned` events — skipped in M0.
  Will be populated at session teardown in M2.
- **Subagent tool events (UNVERIFIED hypothesis)**: session JSON may only contain the parent session's
  turns. Worktree-isolated children's tool events (including commits) appear
  in separate session files, invisible to parent artifact recovery. Not yet checked.
- **fix_of_fix LF**: skipped (weak -1, cannot flip succeeded). M2 daemon job.
- **dir-based sessions**: 16k+ directory-based sessions (events.jsonl format)
  not processed; only 1001 JSON-sidecar sessions have toolEvents data.
