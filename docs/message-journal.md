# Message journal

The message journal is the durable, provider-neutral record of a session's
**full conversation**: every user and assistant message, every `tool_use` with
its full input, and every `tool_result` with its **full content**. One file is
both the audit record ("what did that tool actually return?") and the source
for `--resume` and `/fork`, the same shape Claude Code uses
(`~/.claude/projects/<slug>/<sessionId>.jsonl` plus a `tool-results/` spill dir).

## Why

Before the journal, no store kept full tool results:

| Store | What it kept of a tool result |
|---|---|
| `sessions/<id>/events.jsonl` (ledger) | ~80-char "first line…+N lines" preview (`stream-consumer.preview.ts`), clipped to 400 |
| `witness/<label>/trace.jsonl` | `resultBytes`, `isError`, `durationMs`, 200-char `errorHead` |
| `sessions/<id>.json` sidecar `turns[]` | `tool_result` blocks built from the **same preview**, replayed to the model on `--resume` |

The last row was a correctness bug: a resumed session replayed previews to the
model as if they were the real results. The journal replaces that path.

## Layout

```
$AFK_STATE_DIR/sessions/<sessionId>/
  events.jsonl                  ledger (unchanged; small records for live tailers)
  journal.jsonl                 top-level conversation journal
  subagents/<subagentId>.jsonl  one journal per forked child
  blobs/<sha256>.<ext>          spilled payloads, content-addressed
```

Paths: `src/paths.journal.ts` (re-exported from `src/paths.ts`).

## Record format

JSONL, one record per line, `v: 1`. Types: `src/agent/journal/types.ts`.

| kind | fields | effect on the folded array |
|---|---|---|
| `meta` | `sessionId`, `writerId`, `subagentId?`, `provider?`, `model?`, `cwd?`, `forkedFrom?` | none (written once per writer open) |
| `append` | `index`, `message` | `array[index] = message` (`index === length`) |
| `truncate` | `length`, `reason?` | `array.length = length` |
| `mark` | `label`, `detail?` | none (annotation: compact, rewind, clear, resume, fork, model_switch) |

**Invariant:** folding records in file order reproduces the provider's
in-memory message array. Records are never rewritten; a truncate leaves the
dropped messages in the file, so compaction and rewind lose nothing for audit
while the fold gives exactly what the model would see next.

Messages are **provider-neutral** (`JournalMessage` / `JournalBlock`): text,
thinking (with optional signature), redacted_thinking, tool_use, tool_result
(with typed parts), image, document. Each provider owns one `JournalAdapter`
that maps its native type both ways, so a session written by one provider can
be resumed by another.

### Spill policy

Applied by the writer before a record is serialized:

- A text block or tool_result text part larger than **32 KiB** is written to
  `blobs/<sha256>.txt` and replaced by `text_ref { ref, preview }` (preview =
  first 2 KiB).
- Every base64 image/document is decoded to `blobs/<sha256>.<ext>` and
  replaced by `{ kind: 'ref', ref }`.
- `BlobRef.path` is relative to the sessions root, so forks can reference a
  parent's blobs without copying bytes. Content addressing dedups repeat reads
  of the same file within a session.
- The blob is written before the record that references it.

## Write path: `JournalSync`

Providers do not hook each mutation site (the Anthropic provider mutates its
array at ~10 sites and more keep appearing). Instead each provider wraps
`config.messageJournal` in a `JournalSync<T>` with its adapter and calls
`sync(messages)` at **commit points**:

1. immediately before each model request (after orphan repair, compaction,
   image degradation: the journal records what was actually sent);
2. after the assistant message is appended, before tool dispatch (so a child
   killed mid-tool still leaves its tool calls on disk);
3. at turn end (captures the final assistant message).

`sync` diffs by object reference against the last snapshot and emits
`truncate(k)` + `append`s for everything after the first divergence. Pushes
become appends; compaction, rewind, orphan repair, `/clear`, and provider
switches become truncate + re-append. `seed(messages)` declares the starting
array (`[]` fresh, the seeded messages on resume); if it does not match the
journal's folded length, the journal is resynced.

**Known gap:** an in-place edit of an already-synced message object is not
detected (today: the wind-down note appended into the last user message). The
next divergence or resync corrects it; audit loses only that harness note.

## Sessions, subagents, lifecycle

- The session layer builds the journal (`createMessageJournal`) with a lazy
  session-id accessor and puts it on `AgentConfig.messageJournal`. Records
  buffer in memory until the id resolves.
- Subagent forks resume the parent's session id, so they must NOT write the
  parent's journal. The fork config gets `parent.forSubagent(subagentId)`,
  writing `subagents/<subagentId>.jsonl`. This covers every dispatch path
  (agent fg/bg, worktree, compose, skill forks) because they all build child
  config in `fork-child-config.ts`.
- `/clear` rebuilds the provider runtime: its fresh `JournalSync` seeds `[]`,
  which truncates the journal to 0 (plus a `mark('clear')`).
- Journal `length` is read from the on-disk fold on first access after the id
  resolves, so a resumed process appends at the right index.

## Resume and fork

- `resumeConfigFor` loads `loadJournalMessages(sessionId)` (fold + hydrate) and
  sets `config.resumeMessages`. Providers seed from it with their adapter and
  ignore `resumeHistory`. Sidecars without a journal (older sessions, journal
  disabled) keep the legacy `resumeHistory` path unchanged.
- The resumed context equals the last live context (compaction is part of the
  fold), which fit the window when it was live.
- New sidecar turns stop writing `userContentBlocks` / `assistantContentBlocks`
  (they held previews). Old sidecars that have them still replay as before when
  no journal exists.
- `/fork` calls `forkJournal(parent, newId)`, which writes the folded
  conversation into the new session's journal with `forkedFrom`.
- The OpenAI-compatible provider previously resumed text-only; with a journal
  it resumes tool calls and results too.

## Retention

`sessions/<id>/` directories (ledger, journal, blobs, subagents) are swept by
the session sidecar sweep using the same age knob as sidecars, judged by the
newest mtime of their contents, with the active session and a grace window
excluded (same rules as the witness sweep).

## Concurrency

One writer per process per journal, O_APPEND, no locks, like the ledger. Each
writer stamps a `writerId` on its `meta` record. Two processes resuming the same
session at once interleave appends; the fold tolerates index gaps (reported as
anomalies) rather than failing.

## Disable

`AFK_MESSAGE_JOURNAL_DISABLED=1` turns the journal off; resume falls back to the
sidecar path. No redaction is applied (same as Claude Code); files are 0600 in
0700 directories.

## Readers

| API | Use |
|---|---|
| `loadJournalMessages(id)` | resume |
| `findToolResult(id, toolUseId)` | web UI full tool output, `afk trace show --results` |
| `readJournalRecords` + `foldJournal` | audit, analysis |
| `forkJournal(src, dst)` | `/fork` |

Import everything from `src/agent/journal/index.ts`.

## Follow-ups (not in the first PR)

- `AFK_CAPTURE_SUBAGENT_OUTPUT` / `AFK_CAPTURE_SUBAGENT_PROMPTS` are subsumed by
  subagent journals and can be retired.
- The provider router's text-only `shadowHistory` on a cross-provider `/model`
  switch could seed the new provider from the journal instead.
- Facets / harvest could read the journal instead of sidecar `toolEvents`.
