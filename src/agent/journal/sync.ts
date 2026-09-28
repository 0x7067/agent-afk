/**
 * JournalSync: turns a provider's in-memory message array into journal
 * `append` / `truncate` records by diffing against the last synced snapshot.
 *
 * Why a differ instead of hooking every mutation site: the Anthropic provider
 * alone mutates its array at ~10 sites (push, compaction splice, rewind,
 * orphan repair, abort synthesis, ...), and new sites keep appearing. Diffing
 * at a few commit points (before each model request, before tool dispatch,
 * at turn end) captures all of them, including ones that do not exist yet,
 * with no per-site wiring.
 *
 * Invariant: comparison is by object REFERENCE. Pushed messages keep their
 * identity; compaction/rewind/repair produce a divergent prefix, which is
 * emitted as `truncate(k)` + re-append of everything after the divergence.
 * An in-place mutation of an already-synced message object (e.g. the
 * wind-down note appended into the last user message's content array) is
 * NOT detected; that is an accepted, documented gap (docs/message-journal.md).
 * A caller that KNOWS it edited synced messages in place (microcompaction)
 * calls {@link JournalSync.invalidateFrom} so the next sync re-appends them.
 *
 * @module agent/journal/sync
 */

import type {
  JournalAdapter,
  JournalMessage,
  JournalTruncateReason,
  MessageJournal,
} from './types.js';

export interface SyncOptions {
  /** Advisory reason attached to a truncate, when the caller knows it. */
  reason?: JournalTruncateReason;
}

export class JournalSync<T> {
  /** Provider message refs at the last sync. */
  private committed: T[] = [];
  /** lenAfter[i] = journal length after provider messages [0..i]. */
  private lenAfter: number[] = [];
  private seeded = false;

  constructor(
    private readonly journal: MessageJournal | undefined,
    private readonly adapter: JournalAdapter<T>,
  ) {}

  /** True when a journal is wired; lets callers skip work when it is not. */
  get enabled(): boolean {
    return this.journal !== undefined;
  }

  /**
   * Declare the provider's starting array: `[]` for a fresh runtime, the
   * seeded messages on resume. When the journal's folded length does not
   * match the mapped seed, the journal is resynced (truncate(0) + re-append)
   * so the folded array equals exactly what this runtime will send.
   * Calling `sync` without `seed` seeds with `[]` first.
   */
  seed(messages: readonly T[]): void {
    const journal = this.journal;
    if (!journal) return;
    this.seeded = true;
    const mapped = this.mapAll(messages, 0);
    const count = mapped.lenAfter.length > 0 ? mapped.lenAfter[mapped.lenAfter.length - 1]! : 0;
    if (journal.length !== count) {
      if (journal.length !== 0) journal.truncate(0, 'resync');
      mapped.entries.forEach((m, i) => journal.append(i, m));
    }
    this.committed = [...messages];
    this.lenAfter = mapped.lenAfter;
  }

  /** Diff `messages` against the last snapshot and emit the delta. */
  sync(messages: readonly T[], opts: SyncOptions = {}): void {
    const journal = this.journal;
    if (!journal) return;
    if (!this.seeded) this.seed([]);

    let k = 0;
    while (k < this.committed.length && k < messages.length && messages[k] === this.committed[k]) k++;
    const baseLen = k === 0 ? 0 : this.lenAfter[k - 1]!;
    // Truncate when the prefix diverged/shrank, or when someone else moved
    // the journal (e.g. a sibling runtime after /clear) out from under us.
    if (journal.length !== baseLen) journal.truncate(baseLen, opts.reason ?? 'resync');

    const tail = this.mapAll(messages.slice(k), baseLen);
    tail.entries.forEach((m, i) => journal.append(baseLen + i, m));
    this.committed = [...messages];
    this.lenAfter = [...this.lenAfter.slice(0, k), ...tail.lenAfter];
  }

  /**
   * Forget the committed snapshot from provider index `index` on, so the next
   * {@link sync} emits `truncate` + re-append from there. For callers that
   * mutated already-synced message objects IN PLACE (microcompaction), which
   * the by-reference diff cannot see. Out-of-range indices are clamped; a
   * no-op before the first seed/sync.
   */
  invalidateFrom(index: number): void {
    const at = Math.max(0, Math.min(Number.isFinite(index) ? Math.floor(index) : 0, this.committed.length));
    this.committed.length = at;
    this.lenAfter.length = at;
  }

  /**
   * The last-synced conversation in journal form (the committed native
   * messages mapped through the adapter). Callers wanting the CURRENT array
   * `sync` first. Empty when no journal is wired or nothing was synced.
   */
  snapshot(): JournalMessage[] {
    return this.mapAll(this.committed, 0).entries;
  }

  private mapAll(messages: readonly T[], startLen: number): { entries: JournalMessage[]; lenAfter: number[] } {
    const entries: JournalMessage[] = [];
    const lenAfter: number[] = [];
    let len = startLen;
    for (const m of messages) {
      const j = this.adapter.toJournal(m);
      if (j) {
        entries.push(j);
        len++;
      }
      lenAfter.push(len);
    }
    return { entries, lenAfter };
  }
}
