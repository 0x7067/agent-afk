/**
 * STUB (contract only). Lane A replaces the body. See docs/message-journal.md.
 *
 * @module agent/journal/fork
 */

/**
 * Create `sessions/<newSessionId>/journal.jsonl` holding the source journal's
 * current folded conversation: a `meta` record with
 * `forkedFrom: { sessionId, length }`, a `mark('fork')`, then one `append` per
 * message. Blob refs are copied as-is (they are sessions-root-relative, so they
 * keep pointing at the source's blobs; no bytes are duplicated).
 *
 * @returns true when a journal was written; false when the source has no
 *   journal (caller falls back to the sidecar-only fork) or on any I/O error.
 */
export function forkJournal(_sourceSessionId: string, _newSessionId: string): boolean {
  throw new Error('forkJournal: not implemented (lane A)');
}
